// Language server management: one LSP client per (project, language), transported over the
// backend's framed stdio pipes. Handles server->client requests the CodeMirror client doesn't.
import { LSPClient, Workspace, LSPPlugin, languageServerExtensions, type Transport, type WorkspaceFile } from "@codemirror/lsp-client";

type WorkspaceFileUpdate = ReturnType<Workspace["syncFiles"]>[number];
import { ChangeSet, Text, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { host, on, P, type ProcExit, type ProcOut, type RpcIn } from "./host";
import { getCurrentPython, goTool, pyTool } from "./sdk";
import { uid } from "../util";

export type LspLang = "python" | "go";

// basedpyright enables a few rules PyCharm users would not expect for plain scripts.
const PY_OVERRIDES = { reportImplicitRelativeImport: "none", reportMissingModuleSource: "warning" };

export interface Diag {
  uri: string;
  path: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  severity: number; // 1 error, 2 warning, 3 info, 4 hint
  message: string;
  source?: string;
  code?: string | number;
}

export interface LspHooks {
  /** Opens (or focuses) an editor for the file and returns its view. */
  openFile: (path: string) => Promise<EditorView | null>;
  progress: (lang: LspLang, title: string | null) => void;
  log: (lang: LspLang, line: string) => void;
  missing: (lang: LspLang) => void;
}

class IdeFile implements WorkspaceFile {
  constructor(public uri: string, public languageId: string, public version: number, public doc: Text, public view: EditorView | null) {}
  getView() {
    return this.view;
  }
}

class IdeWorkspace extends Workspace {
  files: IdeFile[] = [];
  private versions: Record<string, number> = Object.create(null);
  constructor(client: LSPClient, private hooks: LspHooks) {
    super(client);
  }
  next(uri: string) {
    return (this.versions[uri] = (this.versions[uri] ?? -1) + 1);
  }
  syncFiles(): readonly WorkspaceFileUpdate[] {
    const out: WorkspaceFileUpdate[] = [];
    for (const f of this.files) {
      if (!f.view) continue;
      const plugin = LSPPlugin.get(f.view);
      if (!plugin) continue;
      const changes = plugin.unsyncedChanges;
      if (!changes.empty) {
        out.push({ changes, file: f, prevDoc: f.doc });
        f.doc = f.view.state.doc;
        f.version = this.next(f.uri);
        plugin.clear();
      }
    }
    return out;
  }
  openFile(uri: string, languageId: string, view: EditorView) {
    const existing = this.getFile(uri) as IdeFile | null;
    if (existing) {
      existing.view = view;
      if (existing.doc.toString() !== view.state.doc.toString()) {
        // Was loaded from disk for an edit; re-sync with the editor content.
        this.client.didClose(uri);
        existing.doc = view.state.doc;
        existing.version = this.next(uri);
        this.client.didOpen(existing);
      }
      return;
    }
    const f = new IdeFile(uri, languageId, this.next(uri), view.state.doc, view);
    this.files.push(f);
    this.client.didOpen(f);
  }
  closeFile(uri: string) {
    const f = this.getFile(uri);
    if (!f) return;
    this.files = this.files.filter((x) => x !== f);
    this.client.didClose(uri);
  }
  async requestFile(uri: string): Promise<WorkspaceFile | null> {
    const open = this.getFile(uri);
    if (open) return open;
    try {
      const ft = await host.read(P.fromUri(uri));
      const f = new IdeFile(uri, "", this.next(uri), Text.of(ft.text.split("\n")), null);
      return f;
    } catch {
      return null;
    }
  }
  updateFile(uri: string, update: TransactionSpec) {
    const f = this.getFile(uri) as IdeFile | null;
    if (f?.view) {
      f.view.dispatch(update);
      return;
    }
    // Not open in an editor: apply the edit on disk.
    const path = P.fromUri(uri);
    host.read(path).then((ft) => {
      const doc = Text.of(ft.text.split("\n"));
      const changes = ChangeSet.of(update.changes as never, doc.length);
      host.write(path, changes.apply(doc).toString(), ft.crlf);
    });
  }
  async displayFile(uri: string): Promise<EditorView | null> {
    return this.hooks.openFile(P.fromUri(uri));
  }
}

interface Server {
  lang: LspLang;
  procId: string;
  client: LSPClient;
  ready: Promise<boolean>;
}

export class LspManager {
  private servers = new Map<LspLang, Server>();
  readonly diagnostics = new Map<string, Diag[]>();
  private diagListeners = new Set<() => void>();
  private progressTokens = new Map<string, string>();

  constructor(private root: string, private hooks: LspHooks) {}

  onDiagnostics(fn: () => void) {
    this.diagListeners.add(fn);
    return () => this.diagListeners.delete(fn);
  }

  status(lang: LspLang): "off" | "starting" | "ready" {
    const s = this.servers.get(lang);
    return !s ? "off" : s.client.serverCapabilities ? "ready" : "starting";
  }

  clientFor(lang: LspLang): LSPClient | null {
    return this.servers.get(lang)?.client ?? null;
  }

  private async command(lang: LspLang): Promise<{ program: string; args: string[] } | null> {
    if (lang === "python") {
      const exe = await pyTool("basedpyright-langserver");
      if (exe) return { program: exe, args: ["--stdio"] };
      const py = await pyTool("pyright-langserver");
      return py ? { program: py, args: ["--stdio"] } : null;
    }
    const gopls = await goTool("gopls");
    return gopls ? { program: gopls, args: ["serve"] } : null;
  }

  private settings(lang: LspLang, section: string | undefined): unknown {
    const py = getCurrentPython()?.path ?? "";
    const all: Record<string, unknown> = {
      python: { pythonPath: py, analysis: { autoImportCompletions: true, typeCheckingMode: "standard", diagnosticMode: "openFilesOnly", useLibraryCodeForTypes: true } },
      "python.analysis": { autoImportCompletions: true, typeCheckingMode: "standard", diagnosticMode: "openFilesOnly", useLibraryCodeForTypes: true },
      basedpyright: { analysis: { autoImportCompletions: true, typeCheckingMode: "standard", diagnosticMode: "openFilesOnly", inlayHints: { variableTypes: false }, diagnosticSeverityOverrides: PY_OVERRIDES } },
      "basedpyright.analysis": { autoImportCompletions: true, typeCheckingMode: "standard", diagnosticMode: "openFilesOnly", diagnosticSeverityOverrides: PY_OVERRIDES },
      gopls: { usePlaceholders: true, completeUnimported: true, staticcheck: false, semanticTokens: false, analyses: { unusedparams: true, unusedvariable: true }, hints: {} },
    };
    if (!section) return lang === "python" ? all.python : all.gopls;
    return all[section] ?? null;
  }

  /** Starts (once) and returns the client for a language, or null when the server isn't installed. */
  async ensure(lang: LspLang): Promise<LSPClient | null> {
    const existing = this.servers.get(lang);
    if (existing) return (await existing.ready) ? existing.client : null;
    const cmd = await this.command(lang);
    if (!cmd) {
      this.hooks.missing(lang);
      return null;
    }
    const procId = `lsp-${lang}-${uid()}`;
    const subs = new Set<(v: string) => void>();
    let alive = true;
    const send = (obj: unknown) => host.write_(procId, JSON.stringify(obj)).catch(() => {});

    const transport: Transport = {
      send: (m: string) => {
        if (!alive) throw new Error("language server stopped");
        if (m.includes('"method":"initialize"')) m = this.patchInitialize(m);
        host.write_(procId, m).catch(() => {});
      },
      subscribe: (h) => subs.add(h),
      unsubscribe: (h) => subs.delete(h),
    };

    const client: LSPClient = new LSPClient({
      rootUri: P.uri(this.root),
      timeout: 20000,
      workspace: (c) => new IdeWorkspace(c, this.hooks),
      extensions: languageServerExtensions(),
      notificationHandlers: {
        "textDocument/publishDiagnostics": (_c, params: { uri: string; diagnostics: any[] }) => {
          this.recordDiagnostics(params.uri, params.diagnostics);
          return false;
        },
        "window/logMessage": (_c, p: { message: string }) => {
          this.hooks.log(lang, p.message);
          return true;
        },
        "$/progress": (_c, p: { token: string | number; value: { kind: string; title?: string; message?: string } }) => {
          const tok = String(p.token);
          if (p.value.kind === "begin") this.progressTokens.set(tok, p.value.title ?? "Analisando");
          if (p.value.kind === "end") this.progressTokens.delete(tok);
          const cur = [...this.progressTokens.values()][0] ?? null;
          this.hooks.progress(lang, cur);
          return true;
        },
      },
    });

    // Server -> client requests the CodeMirror client doesn't implement.
    const handleServerRequest = async (msg: any) => {
      let result: unknown = null;
      switch (msg.method) {
        case "workspace/configuration":
          result = (msg.params.items as { section?: string }[]).map((it) => this.settings(lang, it.section));
          break;
        case "workspace/workspaceFolders":
          result = [{ uri: P.uri(this.root), name: P.base(this.root) }];
          break;
        case "workspace/applyEdit":
          result = { applied: await this.applyWorkspaceEdit(client, msg.params.edit) };
          break;
        case "window/showDocument":
          await this.hooks.openFile(P.fromUri(msg.params.uri));
          result = { success: true };
          break;
        default:
          result = null; // registerCapability, workDoneProgress/create, showMessageRequest, ...
      }
      send({ jsonrpc: "2.0", id: msg.id, result });
    };

    const offMsg = on<RpcIn>("rpc-in", procId, (e) => {
      let parsed: any;
      try {
        parsed = JSON.parse(e.msg);
      } catch {
        return;
      }
      if (parsed && "method" in parsed && "id" in parsed) {
        handleServerRequest(parsed);
        return;
      }
      subs.forEach((h) => h(e.msg));
    });
    const offErr = on<ProcOut>("proc-out", procId, (e) => this.hooks.log(lang, e.data));
    const offExit = on<ProcExit>("proc-exit", procId, (e) => {
      alive = false;
      offMsg();
      offErr();
      offExit();
      this.hooks.log(lang, `servidor encerrado (código ${e.code})`);
      this.hooks.progress(lang, null);
      if (this.servers.get(lang)?.procId === procId) this.servers.delete(lang);
    });

    const ready = (async () => {
      try {
        // Put the project interpreter first on PATH so tools that shell out to "python" find it.
        const py = getCurrentPython()?.path;
        const env: Record<string, string> = py && lang === "python" ? { RITS_PATH_PREPEND: [P.dir(py), P.join(P.dir(py), "Scripts")].map(P.win).join(";") } : {};
        await host.spawn({ id: procId, program: cmd.program, args: cmd.args, cwd: this.root, mode: "rpc", env });
        client.connect(transport);
        this.hooks.progress(lang, "Iniciando servidor de linguagem");
        await client.initializing;
        client.notification("workspace/didChangeConfiguration", { settings: lang === "python" ? { python: this.settings(lang, "python"), basedpyright: this.settings(lang, "basedpyright") } : { gopls: this.settings(lang, "gopls") } });
        this.hooks.progress(lang, null);
        return true;
      } catch (err) {
        this.hooks.log(lang, "falha ao iniciar: " + String((err as Error)?.message ?? err));
        this.hooks.progress(lang, null);
        this.servers.delete(lang);
        return false;
      }
    })();
    this.servers.set(lang, { lang, procId, client, ready });
    return (await ready) ? client : null;
  }

  /** Adds what the CodeMirror client leaves out: workspace folders and pull-configuration support. */
  private patchInitialize(raw: string): string {
    try {
      const msg = JSON.parse(raw);
      if (msg.method !== "initialize") return raw;
      const p = msg.params;
      p.workspaceFolders = [{ uri: P.uri(this.root), name: P.base(this.root) }];
      p.rootPath = P.win(this.root);
      p.clientInfo = { name: "Rits", version: "0.2.0" };
      p.capabilities.workspace = {
        ...(p.capabilities.workspace ?? {}),
        workspaceFolders: true,
        configuration: true,
        didChangeConfiguration: { dynamicRegistration: true },
        didChangeWatchedFiles: { dynamicRegistration: true },
        applyEdit: true,
        workspaceEdit: { documentChanges: true },
        symbol: { dynamicRegistration: false },
      };
      p.capabilities.window = { ...(p.capabilities.window ?? {}), workDoneProgress: true, showDocument: { support: true } };
      p.capabilities.textDocument = {
        ...(p.capabilities.textDocument ?? {}),
        codeAction: { dynamicRegistration: false, isPreferredSupport: true, resolveSupport: { properties: ["edit"] }, codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"] } } },
        references: { dynamicRegistration: false },
        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
        implementation: { dynamicRegistration: false },
        typeDefinition: { dynamicRegistration: false },
      };
      return JSON.stringify(msg);
    } catch {
      return raw;
    }
  }

  private recordDiagnostics(uri: string, list: any[]) {
    const path = P.fromUri(uri);
    this.diagnostics.set(
      path,
      list.map((d) => ({
        uri,
        path,
        line: d.range.start.line + 1,
        col: d.range.start.character + 1,
        endLine: d.range.end.line + 1,
        endCol: d.range.end.character + 1,
        severity: d.severity ?? 1,
        message: d.message,
        source: d.source,
        code: typeof d.code === "object" ? d.code?.value : d.code,
      })),
    );
    if (!list.length) this.diagnostics.delete(path);
    this.diagListeners.forEach((f) => f());
  }

  private async applyWorkspaceEdit(client: LSPClient, edit: any): Promise<boolean> {
    const byUri: Record<string, any[]> = { ...(edit.changes ?? {}) };
    for (const dc of edit.documentChanges ?? []) if (dc.textDocument) byUri[dc.textDocument.uri] = [...(byUri[dc.textDocument.uri] ?? []), ...dc.edits];
    for (const [uri, edits] of Object.entries(byUri)) {
      const file = await client.workspace.requestFile(uri);
      if (!file) continue;
      const doc = file.doc;
      const pos = (p: { line: number; character: number }) => Math.min(doc.line(Math.min(p.line + 1, doc.lines)).from + p.character, doc.length);
      const changes = edits.map((e: any) => ({ from: pos(e.range.start), to: pos(e.range.end), insert: e.newText }));
      client.workspace.updateFile(uri, { changes });
    }
    return true;
  }

  /** Sends a request after syncing open documents. */
  async request<R>(lang: LspLang, method: string, params: unknown): Promise<R | null> {
    const c = await this.ensure(lang);
    if (!c) return null;
    c.sync();
    return c.request<unknown, R>(method, params).catch(() => null);
  }

  /** Tells servers about files changed outside the editor (git checkout, generators...). */
  notifyWatched(paths: string[]) {
    for (const s of this.servers.values()) {
      if (!s.client.serverCapabilities) continue;
      s.client.notification("workspace/didChangeWatchedFiles", { changes: paths.map((p) => ({ uri: P.uri(p), type: 2 })) });
    }
  }

  async restart(lang: LspLang) {
    const s = this.servers.get(lang);
    if (s) {
      this.servers.delete(lang);
      s.client.disconnect();
      await host.kill(s.procId);
    }
    return this.ensure(lang);
  }

  async stopAll() {
    for (const s of this.servers.values()) {
      try {
        s.client.disconnect();
      } catch {
        /* ignore */
      }
      await host.kill(s.procId);
    }
    this.servers.clear();
  }
}

export function lspLangFor(path: string): LspLang | null {
  const e = P.ext(path);
  if (e === "py" || e === "pyi") return "python";
  if (e === "go") return "go";
  return null;
}
