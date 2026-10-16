// Notebook editor (.ipynb, nbformat 4): code and Markdown cells, execution through a Jupyter
// kernel (WebSocket via the backend), outputs in order with execution counters, kernel selection,
// state, interrupt and restart, save (local file or server contents API) and Jupyter's trust model.
// Cells, metadata and outputs the IDE does not understand are preserved as they are.
import { EditorView, keymap, drawSelection, highlightActiveLine, lineNumbers, type ViewUpdate } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, closeBrackets, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { h } from "../../util";
import { icon } from "../../icons";
import { button, confirmDialog, contextMenu, modal, notify, popupList, toast, type PopupItem } from "../../ui";
import type { Tab } from "../../tabs";
import { host, P } from "../host";
import { langExtensions, langFor, islandsTheme } from "../lang";
import { pyTool } from "../sdk";
import type { Workbench } from "../workbench";
import { cellId, errorText, joinSource, JupyterApi, KernelChannel, newNotebook, parseNotebook, serializeNotebook, servers, sha256, toLines, type JpServer, type KMsg, type NbCell, type NbOutput, type Notebook, type SessionModel } from "./api";
import { isTrusted, renderMarkdown, renderOutput, setTrusted } from "./render";

export type Storage = { kind: "local"; path: string } | { kind: "remote"; serverId: string; path: string };

type KState = "desconectado" | "conectando" | "idle" | "busy" | "starting" | "reiniciando" | "dead";

interface CellView {
  cell: NbCell;
  el: HTMLElement;
  editor: EditorView;
  out: HTMLElement;
  count: HTMLElement;
  md: HTMLElement | null;
  editing: boolean;
  /** pending: queued in the kernel; running: execute_input received */
  state: "idle" | "queued" | "running";
  /** outputs produced in this session (trusted) vs loaded from the file */
  fresh: boolean;
  clearOnNext: boolean;
  diags: Diagnostic[];
}

const PY = langFor("x.py");
const MD = langFor("x.md");

function storageKey(s: Storage) {
  return s.kind === "local" ? "local:" + P.norm(s.path).toLowerCase() : `remote:${s.serverId}:${s.path}`;
}

export function notebookTabId(s: Storage) {
  return "notebook:" + storageKey(s);
}

const PREF = "jupyter.nbserver:";

export class NotebookTab {
  tab: Tab;
  private el = h("div.nb");
  private bar = h("div.nb-bar");
  private list = h("div.nb-cells", { tabIndex: -1 });
  private cells: CellView[] = [];
  private nb!: Notebook;
  private savedText = "";
  private trusted = false;
  private srv: JpServer | null = null;
  private api: JupyterApi | null = null;
  private session: SessionModel | null = null;
  private sessionOurs = false;
  private channel: KernelChannel | null = null;
  private kstate: KState = "desconectado";
  private kernelName = "python3";
  private kernelLabel = "Python 3";
  private pending = new Map<string, CellView>();
  /** iopub (status idle) and shell (execute_reply) arrive in any order: a cell ends after both. */
  private halfDone = new Set<string>();
  /** Replies that arrived before their request was registered (the reply can beat invoke's return). */
  private early = new Map<string, KMsg[]>();
  private awaiting = 0;
  private replies = new Map<string, (m: KMsg) => void>();
  private displays = new Map<string, { cv: CellView; idx: number }[]>();
  private active: CellView | null = null;
  private disposed = false;
  private dirtyFlag = false;

  constructor(
    private wb: Workbench,
    readonly storage: Storage,
    private onDispose: () => void,
  ) {
    const title = P.base(storage.path);
    this.tab = {
      id: notebookTabId(storage),
      title,
      icon: "fileTypes/jupyter",
      tooltip: storage.kind === "local" ? P.win(storage.path) : `${storage.path} (servidor Jupyter)`,
      el: this.el,
      canClose: () => this.confirmClose(),
      onClose: () => this.dispose(),
      onActivate: () => setTimeout(() => (this.active ?? this.cells[0])?.editor.focus()),
      menu: () => [
        { label: "Salvar", icon: "general/save", shortcut: "Ctrl+S", action: () => this.save() },
        ...(storage.kind === "local" ? [{ label: "Abrir como texto (JSON)", icon: "fileTypes/json", action: () => this.wb.editors.openFile(storage.path, { text: true }) }] : []),
        { label: "Abrir no JupyterLab", icon: "general/openNewTab", action: () => this.openLab() },
      ],
    };
    this.el.append(this.bar, this.list);
    this.el.addEventListener("keydown", (e) => this.onKey(e), true);
  }

  // ---------------- loading / saving ----------------

  async load(): Promise<boolean> {
    let text: string;
    if (this.storage.kind === "local") {
      const ft = await host.read(this.storage.path);
      if (ft.tooLarge) throw new Error("Notebook grande demais para abrir no editor (> 20 MB). Use o JupyterLab.");
      text = ft.text;
    } else {
      const srv = (await servers.list()).find((s) => s.id === (this.storage as { serverId: string }).serverId);
      if (!srv) throw new Error("Servidor Jupyter não encontrado.");
      const m = await new JupyterApi(srv).get(this.storage.path);
      text = JSON.stringify(m.content);
      this.srv = srv;
      this.api = new JupyterApi(srv);
    }
    this.nb = text.trim() ? parseNotebook(text) : newNotebook();
    this.savedText = text.trim() ? serializeNotebook(this.nb) : "";
    this.trusted = await isTrusted(storageKey(this.storage), await sha256(text));
    const ks = this.nb.metadata.kernelspec as { name?: string; display_name?: string } | undefined;
    if (ks?.name) {
      this.kernelName = ks.name;
      this.kernelLabel = ks.display_name ?? ks.name;
    }
    if (!this.srv) await this.pickDefaultServer();
    for (const c of this.nb.cells) this.cells.push(this.makeCell(c, false));
    if (!this.cells.length) this.insert(0, "code");
    this.renderList();
    this.renderBar();
    this.markDirty();
    return true;
  }

  private async pickDefaultServer() {
    const all = await servers.list().catch(() => [] as JpServer[]);
    let want: string | null = null;
    try {
      want = localStorage.getItem(PREF + storageKey(this.storage)) ?? localStorage.getItem("jupyter.server");
    } catch {
      /* ignore */
    }
    const local = this.storage.kind === "local" ? all.find((s) => s.localRoot && P.inside(s.localRoot, this.storage.path)) : undefined;
    this.srv = all.find((s) => s.id === want) ?? local ?? all[0] ?? null;
    this.api = this.srv ? new JupyterApi(this.srv) : null;
  }

  private syncModel() {
    this.nb.cells = this.cells.map((cv) => {
      const c = cv.cell;
      c.source = toLines(cv.editor.state.doc.toString());
      return c;
    });
    this.nb.metadata.kernelspec = { ...(this.nb.metadata.kernelspec ?? {}), name: this.kernelName, display_name: this.kernelLabel };
    return serializeNotebook(this.nb);
  }

  get dirty() {
    return this.dirtyFlag;
  }

  private markDirty() {
    const text = this.syncModel();
    this.dirtyFlag = text !== this.savedText;
    this.tab.cls = this.dirtyFlag ? "modified" : "";
    this.wb.tabs.update(this.tab);
  }

  async save(): Promise<boolean> {
    const text = this.syncModel();
    try {
      if (this.storage.kind === "local") await host.write(this.storage.path, text);
      else await this.api!.saveNotebook(this.storage.path, JSON.parse(text));
    } catch (e) {
      notify("Falha ao salvar o notebook", errorText(e), "error");
      return false;
    }
    this.savedText = text;
    // like Jupyter: a notebook is trusted after saving when all of its active outputs were
    // produced here (or it was already trusted)
    if (this.trusted || this.cells.every((c) => c.fresh || !c.cell.outputs?.length)) {
      this.trusted = true;
      await setTrusted(storageKey(this.storage), await sha256(text));
    }
    this.markDirty();
    this.renderBar();
    this.lint();
    toast("Notebook salvo", "ok", 1500);
    return true;
  }

  private async confirmClose(): Promise<boolean> {
    if (!this.dirty) return true;
    return new Promise((resolve) => {
      const m = modal("Alterações não salvas", { width: 460, onClose: () => resolve(false) });
      m.body.append(h("div", null, `Salvar as alterações em ${P.base(this.storage.path)} antes de fechar?`));
      m.footer.append(
        button("Cancelar", () => m.close()),
        button("Descartar", () => {
          this.dirtyFlag = false;
          m.close();
          resolve(true);
        }, "danger"),
        button("Salvar", async () => {
          const ok = await this.save();
          m.close();
          resolve(ok);
        }, "primary"),
      );
    });
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.channel?.close();
    // kernels started by this tab are stopped with it; sessions shared with JupyterLab are kept
    if (this.session && this.sessionOurs && this.api) await this.api.deleteSession(this.session.id).catch(() => {});
    for (const c of this.cells) c.editor.destroy();
    this.onDispose();
  }

  /** Plugin disabled: drop the connection only (the kernel keeps running on the server). */
  async detach() {
    this.sessionOurs = false;
    await this.channel?.close();
    this.channel = null;
    this.setState("desconectado");
  }

  // ---------------- toolbar ----------------

  private setState(s: KState) {
    this.kstate = s;
    this.renderBar();
  }

  private renderBar() {
    const st = this.kstate;
    const dotCls = st === "idle" ? "ok" : st === "busy" || st === "starting" || st === "conectando" || st === "reiniciando" ? "busy" : st === "dead" ? "err" : "";
    const stateLabel: Record<KState, string> = { desconectado: "desconectado", conectando: "conectando…", idle: "ocioso", busy: "ocupado", starting: "iniciando…", reiniciando: "reiniciando…", dead: "encerrado" };
    const where = this.srv ? (this.srv.localEnv ? "Docker local" : /127\.0\.0\.1|localhost/.test(this.srv.url) ? "local" : "remoto") : "";
    const btn = (ic: string, title: string, fn: () => void, disabled = false) => h("button.icon-btn", { title, disabled, onclick: fn }, icon(ic));
    this.bar.replaceChildren(
      btn("general/save", "Salvar (Ctrl+S)", () => this.save()),
      h("span.nb-sep"),
      btn("general/add", "Inserir célula de código abaixo (B)", () => this.insertAfterActive("code")),
      h("button.btn.nb-mdbtn", { title: "Inserir célula Markdown abaixo", onclick: () => this.insertAfterActive("markdown") }, "+ Markdown"),
      h("span.nb-sep"),
      btn("run/run", "Executar célula (Ctrl+Enter / Shift+Enter)", () => this.active && this.runCell(this.active, true)),
      btn("run/rerun", "Executar todas", () => this.runAll()),
      h("button.btn.nb-mdbtn", { title: "Executar esta célula e as seguintes", onclick: () => this.runBelow() }, "Daqui em diante"),
      btn("run/stop", "Interromper o kernel", () => this.interrupt(), !this.session),
      btn("run/restart", "Reiniciar o kernel (perde as variáveis)", () => this.restart(), !this.session),
      btn("general/remove", "Limpar todas as saídas", () => this.clearAll()),
      h("span.grow"),
      this.trusted
        ? h("span.nb-trust.ok", { title: "Saídas ativas (HTML com scripts, JavaScript) podem ser exibidas, sempre isoladas." }, icon("status/success"), "confiável")
        : h("button.nb-trust", { title: "Saídas ativas de origem desconhecida não são executadas. Confie apenas em notebooks que você conhece.", onclick: () => this.trust() }, icon("status/warning"), "não confiável"),
      h(
        "button.nb-kernel",
        { title: "Kernel do notebook (ambiente do servidor Jupyter, não o interpretador Python da IDE)", onclick: (e: MouseEvent) => this.kernelMenu(e.currentTarget as HTMLElement) },
        h(`i.nb-dot.${dotCls}` as "i"),
        h("span", null, this.srv ? `${this.kernelLabel} · ${this.srv.name}${where ? " (" + where + ")" : ""}` : "Escolha um servidor Jupyter"),
        h("span.dim", null, stateLabel[st]),
        icon("general/chevronDown"),
      ),
      btn("general/openNewTab", "Abrir no JupyterLab", () => this.openLab(), !this.srv),
    );
  }

  private async trust() {
    if (!(await confirmDialog("Confiar no notebook", "Saídas ativas (HTML com scripts e JavaScript) deste notebook serão executadas, isoladas da IDE. Confie apenas em notebooks de origem conhecida.", "Confiar"))) return;
    this.trusted = true;
    await setTrusted(storageKey(this.storage), await sha256(this.savedText || this.syncModel()));
    for (const c of this.cells) this.renderOutputs(c);
    this.renderBar();
  }

  private async kernelMenu(anchor: HTMLElement) {
    const all = await servers.list().catch(() => [] as JpServer[]);
    const items: PopupItem[] = [];
    for (const s of all) {
      items.push({
        label: s.name,
        sub: s.url,
        icon: "jupyter",
        section: "Servidores",
        current: s.id === this.srv?.id,
        children: async () => {
          try {
            const ks = await new JupyterApi(s).kernelspecs();
            return Object.values(ks.kernelspecs).map((k) => ({ label: k.spec.display_name, sub: k.name, current: s.id === this.srv?.id && k.name === this.kernelName, action: () => this.useKernel(s, k.name, k.spec.display_name) }));
          } catch (e) {
            return [{ label: errorText(e), action: () => {} }];
          }
        },
      });
    }
    if (this.session) items.push({ label: "Reconectar e consultar o estado real", icon: "general/refresh", separatorBefore: true, action: () => this.reconnect() });
    items.push({ label: "Gerenciar servidores…", icon: "general/settings", separatorBefore: !this.session, action: () => this.wb.show("jupyter", true) });
    popupList(anchor, items, { title: "Kernel", width: 380 });
  }

  private async useKernel(s: JpServer, name: string, label: string) {
    const sameServer = s.id === this.srv?.id;
    if (this.session && !(await confirmDialog("Trocar o kernel", "As variáveis do kernel atual serão perdidas.", "Trocar"))) return;
    if (this.session && sameServer && this.api) {
      try {
        this.session = await this.api.changeKernel(this.session.id, name);
        this.kernelName = name;
        this.kernelLabel = label;
        await this.openChannel();
        this.markDirty();
        return;
      } catch (e) {
        notify("Falha ao trocar o kernel", errorText(e), "error");
      }
    }
    await this.channel?.close();
    if (this.session && this.sessionOurs && this.api) await this.api.deleteSession(this.session.id).catch(() => {});
    this.session = null;
    this.channel = null;
    this.srv = s;
    this.api = new JupyterApi(s);
    this.kernelName = name;
    this.kernelLabel = label;
    try {
      localStorage.setItem(PREF + storageKey(this.storage), s.id);
    } catch {
      /* ignore */
    }
    this.setState("desconectado");
    this.markDirty();
  }

  private async openLab() {
    if (!this.srv) return toast("Escolha um servidor Jupyter.", "info");
    const p = this.serverPath();
    let mode = "window";
    try {
      mode = localStorage.getItem("jupyter.web") ?? "window";
    } catch {
      /* ignore */
    }
    if (this.dirty) await this.save();
    servers.openLab(this.srv.id, p.inside ? p.path : null, mode === "browser").catch((e) => notify("Não foi possível abrir o JupyterLab", errorText(e), "error"));
  }

  // ---------------- kernel ----------------

  /** Path of the notebook as the server sees it (sessions set the kernel's working folder). */
  private serverPath(): { path: string; inside: boolean } {
    if (this.storage.kind === "remote") return { path: this.storage.path, inside: true };
    const s = this.srv!;
    if (s.localRoot && P.inside(s.localRoot, this.storage.path)) return { path: [s.remoteRoot, P.rel(s.localRoot, this.storage.path)].filter(Boolean).join("/"), inside: true };
    return { path: P.base(this.storage.path), inside: false };
  }

  private async ensureKernel(): Promise<boolean> {
    if (this.channel?.open) return true;
    if (!this.srv || !this.api) {
      notify("Sem servidor Jupyter", "Conecte um servidor (local, remoto ou ambiente Docker) na janela Jupyter.", "info", [{ label: "Abrir janela Jupyter", run: () => this.wb.show("jupyter", true) }]);
      return false;
    }
    this.setState("conectando");
    try {
      if (!this.session) {
        const sp = this.serverPath();
        if (!sp.inside) toast("O servidor não vê a pasta deste notebook: o kernel roda na pasta raiz do servidor (caminhos relativos podem não funcionar).", "info", 8000);
        const existing = (await this.api.sessions()).find((s) => s.path === sp.path);
        this.session = await this.api.createSession(sp.path, this.kernelName);
        this.sessionOurs = !existing;
      }
      await this.openChannel();
      return true;
    } catch (e) {
      this.setState("desconectado");
      notify("Não foi possível iniciar o kernel", errorText(e), "error");
      return false;
    }
  }

  private async openChannel() {
    await this.channel?.close();
    const ch = new KernelChannel(this.srv!.id, this.session!.kernel.id, this.session!.id, (m) => this.onMsg(m), (reason) => this.onClosed(reason));
    await ch.connect();
    this.channel = ch;
    this.setState("idle");
    ch.send("shell", "kernel_info_request", {}).catch(() => {});
  }

  private onClosed(reason: string) {
    if (this.disposed) return;
    this.channel = null;
    for (const cv of this.pending.values()) this.setCellState(cv, "idle");
    this.pending.clear();
    this.halfDone.clear();
    this.setState("desconectado");
    toast(`Conexão com o kernel encerrada (${reason}). Nada será executado de novo automaticamente.`, "info", 7000);
  }

  /** Queries the real state on the server and reconnects; never re-runs cells. */
  async reconnect() {
    if (!this.api || !this.session) return this.ensureKernel();
    try {
      const k = await this.api.kernel(this.session.kernel.id);
      await this.openChannel();
      this.setState((k.execution_state as KState) ?? "idle");
      toast(`Kernel ${k.execution_state ?? ""}: conectado de novo. As células não foram reexecutadas.`, "info");
    } catch (e) {
      this.session = null;
      this.setState("dead");
      notify("O kernel não existe mais no servidor", errorText(e) + "\nUm novo kernel será iniciado na próxima execução (as variáveis anteriores se perderam).", "info");
    }
  }

  private async interrupt() {
    if (!this.api || !this.session) return;
    await this.api.interrupt(this.session.kernel.id).catch((e) => notify("Falha ao interromper", errorText(e), "error"));
  }

  private async restart() {
    if (!this.api || !this.session) return;
    if (!(await confirmDialog("Reiniciar o kernel", "Todas as variáveis e importações do kernel serão perdidas. As saídas na tela são mantidas.", "Reiniciar", true))) return;
    this.setState("reiniciando");
    for (const cv of this.pending.values()) this.setCellState(cv, "idle");
    this.pending.clear();
    this.halfDone.clear();
    try {
      await this.api.restart(this.session.kernel.id);
      if (!this.channel?.open) await this.openChannel();
      this.setState("idle");
      toast("Kernel reiniciado", "ok", 2000);
    } catch (e) {
      this.setState("desconectado");
      notify("Falha ao reiniciar o kernel", errorText(e), "error");
    }
  }

  private onMsg(m: KMsg) {
    if (m.parentId && !this.pending.has(m.parentId) && !this.replies.has(m.parentId) && this.awaiting > 0) {
      const list = this.early.get(m.parentId) ?? [];
      list.push(m);
      this.early.set(m.parentId, list);
      if (this.early.size > 50) this.early.delete(this.early.keys().next().value!);
    }
    if (m.msgType === "status") {
      const st = m.content.execution_state as string;
      if (st === "idle" && this.pending.has(m.parentId)) this.finishPart(m.parentId);
      if (st === "idle") this.setState(this.pending.size ? "busy" : "idle");
      else if (st === "busy") this.setState("busy");
      else if (st === "restarting") this.setState("reiniciando");
      else if (st === "starting" || st === "dead") this.setState(st);
      return;
    }
    const reply = this.replies.get(m.parentId);
    if (reply && (m.msgType === "complete_reply" || m.msgType === "inspect_reply" || m.msgType === "kernel_info_reply")) {
      this.replies.delete(m.parentId);
      return reply(m);
    }
    const cv = this.pending.get(m.parentId);
    if (!cv) {
      if (m.msgType === "update_display_data") this.updateDisplay(m);
      return;
    }
    const outs = (cv.cell.outputs ??= []);
    const push = (o: NbOutput) => {
      if (cv.clearOnNext) {
        cv.cell.outputs = [];
        cv.clearOnNext = false;
      }
      const list = cv.cell.outputs!;
      // consecutive stream chunks of the same stream are merged (like Jupyter)
      const last = list[list.length - 1];
      if (o.output_type === "stream" && last?.output_type === "stream" && last.name === o.name) last.text = joinSource(last.text) + joinSource(o.text);
      else list.push(o);
      const did = o.transient?.display_id;
      if (did) {
        const arr = this.displays.get(did) ?? [];
        arr.push({ cv, idx: list.length - 1 });
        this.displays.set(did, arr);
        delete o.transient;
      }
      cv.fresh = true;
      this.renderOutputs(cv);
      this.markDirtySoon();
    };
    switch (m.msgType) {
      case "execute_input":
        this.setCellState(cv, "running");
        break;
      case "stream":
        push({ output_type: "stream", name: m.content.name, text: m.content.text });
        break;
      case "display_data":
        push({ output_type: "display_data", data: m.content.data, metadata: m.content.metadata ?? {}, transient: m.content.transient });
        break;
      case "execute_result":
        push({ output_type: "execute_result", data: m.content.data, metadata: m.content.metadata ?? {}, execution_count: m.content.execution_count });
        break;
      case "error":
        push({ output_type: "error", ename: m.content.ename, evalue: m.content.evalue, traceback: m.content.traceback });
        break;
      case "clear_output":
        if (m.content.wait) cv.clearOnNext = true;
        else {
          cv.cell.outputs = [];
          this.renderOutputs(cv);
        }
        break;
      case "update_display_data":
        this.updateDisplay(m);
        break;
      case "execute_reply":
        cv.cell.execution_count = m.content.execution_count ?? cv.cell.execution_count ?? null;
        cv.count.textContent = cv.cell.execution_count != null ? `[${cv.cell.execution_count}]` : "[ ]";
        if (m.content.status === "aborted") {
          cv.count.textContent = "[ ]";
          cv.el.classList.add("aborted");
        }
        if (m.content.status === "error") this.abortQueue(cv);
        this.markDirtySoon();
        this.finishPart(m.parentId);
        if (!this.pending.size) this.setState("idle");
        void outs;
        break;
    }
  }

  private finishPart(id: string) {
    if (!this.halfDone.delete(id)) {
      this.halfDone.add(id);
      return;
    }
    const cv = this.pending.get(id);
    this.pending.delete(id);
    if (cv) this.setCellState(cv, "idle");
  }

  private updateDisplay(m: KMsg) {
    const did = m.content.transient?.display_id;
    for (const t of this.displays.get(did) ?? []) {
      const o = t.cv.cell.outputs?.[t.idx];
      if (o) {
        o.data = m.content.data;
        o.metadata = m.content.metadata ?? {};
        this.renderOutputs(t.cv);
      }
    }
  }

  /** With stop_on_error the kernel aborts the queued cells; mark them as not run. */
  private abortQueue(failed: CellView) {
    const i = this.cells.indexOf(failed);
    for (const [id, cv] of [...this.pending]) {
      if (this.cells.indexOf(cv) > i) {
        this.setCellState(cv, "idle");
        cv.el.classList.add("aborted");
        this.pending.delete(id);
      }
    }
  }

  private markTimer: number | undefined;
  private markDirtySoon() {
    clearTimeout(this.markTimer);
    this.markTimer = window.setTimeout(() => this.markDirty(), 200);
  }

  // ---------------- execution ----------------

  async runCell(cv: CellView, advance: boolean) {
    this.active = cv;
    if (cv.cell.cell_type === "markdown") {
      this.setEditing(cv, false);
    } else if (cv.cell.cell_type === "code") {
      const code = cv.editor.state.doc.toString();
      if (!(await this.ensureKernel())) return;
      cv.cell.outputs = [];
      cv.el.classList.remove("aborted");
      cv.clearOnNext = false;
      this.renderOutputs(cv);
      this.setCellState(cv, "queued");
      try {
        this.awaiting++;
        const id = await this.channel!.execute(code).finally(() => this.awaiting--);
        this.pending.set(id, cv);
        this.setState("busy");
        const early = this.early.get(id);
        this.early.delete(id);
        for (const m of early ?? []) this.onMsg(m);
      } catch (e) {
        this.setCellState(cv, "idle");
        notify("Falha ao enviar a célula", errorText(e), "error");
      }
    }
    if (advance) {
      const i = this.cells.indexOf(cv);
      const next = this.cells[i + 1] ?? this.insert(i + 1, "code");
      this.focus(next);
    }
  }

  private async runAll() {
    for (const cv of this.cells) await this.runCell(cv, false);
  }

  private async runBelow() {
    const i = Math.max(0, this.active ? this.cells.indexOf(this.active) : 0);
    for (const cv of this.cells.slice(i)) await this.runCell(cv, false);
  }

  private clearAll() {
    for (const cv of this.cells) {
      if (cv.cell.cell_type !== "code") continue;
      cv.cell.outputs = [];
      cv.cell.execution_count = null;
      cv.count.textContent = "[ ]";
      this.renderOutputs(cv);
    }
    this.markDirty();
  }

  private setCellState(cv: CellView, s: CellView["state"]) {
    cv.state = s;
    cv.el.classList.toggle("queued", s === "queued");
    cv.el.classList.toggle("running", s === "running");
    if (s !== "idle") cv.count.textContent = "[*]";
    else if (cv.cell.cell_type === "code" && cv.count.textContent === "[*]") cv.count.textContent = cv.cell.execution_count != null ? `[${cv.cell.execution_count}]` : "[ ]";
  }

  // ---------------- completion from the kernel ----------------

  private request(fn: () => Promise<string>, ms = 4000): Promise<KMsg | null> {
    return new Promise((resolve) => {
      this.awaiting++;
      fn()
        .finally(() => this.awaiting--)
        .then((id) => {
          const t = setTimeout(() => {
            this.replies.delete(id);
            resolve(null);
          }, ms);
          this.replies.set(id, (m) => {
            clearTimeout(t);
            resolve(m);
          });
          const early = this.early.get(id);
          this.early.delete(id);
          for (const m of early ?? []) this.onMsg(m);
        })
        .catch(() => resolve(null));
    });
  }

  private completionSource = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (!this.channel?.open) return null;
    const word = ctx.matchBefore(/[\w.]*/);
    if (!ctx.explicit && (!word || word.from === word.to)) return null;
    const code = ctx.state.doc.toString();
    const m = await this.request(() => this.channel!.complete(code, ctx.pos));
    if (!m || m.content.status !== "ok") return null;
    const start = m.content.cursor_start as number;
    const meta = (m.content.metadata?._jupyter_types_experimental ?? []) as { text: string; type?: string; signature?: string }[];
    const types = new Map(meta.map((x) => [x.text, x]));
    return {
      from: start,
      to: m.content.cursor_end,
      options: (m.content.matches as string[]).map((t) => ({ label: t, type: ({ function: "function", class: "class", module: "namespace", instance: "variable", keyword: "keyword", statement: "variable", param: "variable" } as Record<string, string>)[types.get(t)?.type ?? ""] ?? "variable", detail: types.get(t)?.signature || undefined })),
      validFor: /^[\w]*$/,
    };
  };

  // ---------------- diagnostics (Ruff on the concatenated code cells) ----------------

  private ruff: string | null | undefined;
  private async lint() {
    if (this.ruff === undefined) this.ruff = await pyTool("ruff").catch(() => null);
    if (!this.ruff) return;
    // cells joined in order (definitions in earlier cells are visible later); magics are skipped
    let line = 1;
    const map: { cv: CellView; start: number; lines: number }[] = [];
    const parts: string[] = [];
    for (const cv of this.cells) {
      if (cv.cell.cell_type !== "code") continue;
      const src = cv.editor.state.doc.toString().replace(/^\s*[%!].*$/gm, "");
      const n = src.split("\n").length;
      map.push({ cv, start: line, lines: n });
      parts.push(src);
      line += n;
    }
    const r = await host.capture(this.ruff, ["check", "--output-format", "json", "--select", "E9,F63,F7,F82", "--stdin-filename", "notebook.py", "-"], this.wb.root, parts.join("\n"), 20).catch(() => null);
    if (!r) return;
    let items: { message: string; code: string; location: { row: number; column: number }; end_location: { row: number; column: number } }[] = [];
    try {
      items = JSON.parse(r.stdout || "[]");
    } catch {
      return;
    }
    for (const m of map) m.cv.diags = [];
    for (const it of items) {
      const t = map.find((m) => it.location.row >= m.start && it.location.row < m.start + m.lines);
      if (!t) continue;
      const doc = t.cv.editor.state.doc;
      const ln = doc.line(Math.min(doc.lines, it.location.row - t.start + 1));
      const from = Math.min(ln.to, ln.from + it.location.column - 1);
      t.cv.diags.push({ from, to: Math.max(from + 1, Math.min(ln.to, from + 1)), severity: "error", message: `${it.code}: ${it.message}`, source: "Ruff" });
    }
    for (const m of map) m.cv.editor.dispatch({});
  }

  // ---------------- cells ----------------

  private makeCell(cell: NbCell, fresh: boolean): CellView {
    const count = h("div.nb-count", null, cell.cell_type === "code" ? (cell.execution_count != null ? `[${cell.execution_count}]` : "[ ]") : "");
    const out = h("div.nb-outputs");
    const host_ = h("div.nb-editor");
    const el = h("div.nb-cell", { class: cell.cell_type });
    const cv: CellView = { cell, el, editor: null as unknown as EditorView, out, count, md: null, editing: cell.cell_type !== "markdown", state: "idle", fresh, clearOnNext: false, diags: [] };
    const exts: Extension[] = [
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      ...langExtensions(cell.cell_type === "markdown" ? MD : PY),
      islandsTheme,
      // cells grow with their content (the file editor reserves space below the last line)
      EditorView.theme({ "&": { height: "auto !important", maxHeight: "70vh" }, ".cm-content": { padding: "4px 0 !important" } }),
      keymap.of([
        { key: "Mod-Enter", run: () => (this.runCell(cv, false), true) },
        { key: "Shift-Enter", run: () => (this.runCell(cv, true), true) },
        { key: "Alt-Enter", run: () => (this.runCell(cv, false), this.focus(this.insert(this.cells.indexOf(cv) + 1, "code")), true) },
        { key: "Mod-s", run: () => (this.save(), true), preventDefault: true },
        { key: "Escape", run: () => (cv.el.focus(), true) },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((u: ViewUpdate) => {
        if (u.docChanged) this.markDirtySoon();
        if (u.focusChanged && u.view.hasFocus) this.setActive(cv);
      }),
    ];
    if (cell.cell_type === "code") {
      exts.push(lineNumbers(), autocompletion({ override: [this.completionSource], activateOnTyping: true }), lintGutter(), linter(() => cv.diags, { delay: 100 }));
    }
    cv.editor = new EditorView({ parent: host_, state: EditorState.create({ doc: joinSource(cell.source), extensions: exts }) });
    const tools = h(
      "div.nb-tools",
      null,
      h("button.icon-btn", { title: "Mover para cima", onclick: () => this.move(cv, -1) }, icon("general/chevronUp")),
      h("button.icon-btn", { title: "Mover para baixo", onclick: () => this.move(cv, 1) }, icon("general/chevronDown")),
      h("button.icon-btn", { title: "Mais", onclick: (e: MouseEvent) => this.cellMenu(cv, e) }, icon("general/moreHorizontal")),
      h("button.icon-btn", { title: "Excluir célula", onclick: () => this.remove(cv) }, icon("general/delete")),
    );
    const run = h("button.icon-btn.nb-run", { title: cell.cell_type === "markdown" ? "Renderizar (Shift+Enter)" : "Executar (Ctrl+Enter)", onclick: () => this.runCell(cv, false) }, icon("run/run"));
    const gutter = h("div.nb-gutter", null, cell.cell_type === "raw" ? h("span.nb-kind", null, "raw") : run, count);
    el.tabIndex = -1;
    el.append(gutter, h("div.nb-main", null, host_, out), tools);
    el.addEventListener("mousedown", () => this.setActive(cv));
    if (cell.cell_type === "markdown") {
      cv.md = h("div.nb-mdview", { ondblclick: () => this.setEditing(cv, true), title: "Clique duas vezes para editar" });
      host_.after(cv.md);
      this.setEditing(cv, !joinSource(cell.source).trim());
    }
    this.renderOutputs(cv);
    return cv;
  }

  private setEditing(cv: CellView, on: boolean) {
    if (!cv.md) return;
    cv.editing = on;
    (cv.editor.dom.parentElement as HTMLElement).style.display = on ? "" : "none";
    cv.md.style.display = on ? "none" : "";
    if (!on) cv.md.replaceChildren(renderMarkdown(cv.editor.state.doc.toString() || "*Célula Markdown vazia*", cv.cell.attachments as Record<string, unknown> | undefined));
    else setTimeout(() => cv.editor.focus());
  }

  private renderOutputs(cv: CellView) {
    const outs = cv.cell.outputs ?? [];
    cv.out.replaceChildren(...outs.map((o) => h("div.nb-output", null, o.output_type === "execute_result" && o.execution_count != null ? h("span.nb-outcount", null, `Out[${o.execution_count}]`) : "", renderOutput(o, this.trusted || cv.fresh))));
    cv.out.style.display = outs.length ? "" : "none";
  }

  private cellMenu(cv: CellView, e: MouseEvent) {
    const i = this.cells.indexOf(cv);
    contextMenu(e.clientX, e.clientY, [
      { label: "Executar", icon: "run/run", action: () => this.runCell(cv, false) },
      { label: "Executar desta em diante", action: () => ((this.active = cv), this.runBelow()) },
      { separator: true },
      { label: "Inserir código acima", action: () => this.focus(this.insert(i, "code")) },
      { label: "Inserir código abaixo", action: () => this.focus(this.insert(i + 1, "code")) },
      { label: "Inserir Markdown abaixo", action: () => this.focus(this.insert(i + 1, "markdown")) },
      { separator: true },
      { label: cv.cell.cell_type === "code" ? "Converter em Markdown" : "Converter em código", action: () => this.convert(cv) },
      { label: "Limpar saída", disabled: cv.cell.cell_type !== "code", action: () => ((cv.cell.outputs = []), this.renderOutputs(cv), this.markDirty()) },
      { separator: true },
      { label: "Excluir célula", icon: "general/delete", danger: true, action: () => this.remove(cv) },
    ]);
  }

  private convert(cv: CellView) {
    const i = this.cells.indexOf(cv);
    const src = cv.editor.state.doc.toString();
    const type = cv.cell.cell_type === "code" ? "markdown" : "code";
    const cell: NbCell = { ...cv.cell, cell_type: type, source: toLines(src) };
    if (type === "markdown") {
      delete cell.outputs;
      delete cell.execution_count;
    } else {
      cell.outputs = [];
      cell.execution_count = null;
    }
    cv.editor.destroy();
    this.cells[i] = this.makeCell(cell, true);
    this.renderList();
    this.markDirty();
  }

  private insert(at: number, type: "code" | "markdown"): CellView {
    const cell: NbCell = type === "code" ? { cell_type: "code", id: cellId(), metadata: {}, source: [], outputs: [], execution_count: null } : { cell_type: "markdown", id: cellId(), metadata: {}, source: [] };
    const cv = this.makeCell(cell, true);
    this.cells.splice(at, 0, cv);
    this.renderList();
    this.markDirtySoon();
    return cv;
  }

  private insertAfterActive(type: "code" | "markdown") {
    const i = this.active ? this.cells.indexOf(this.active) + 1 : this.cells.length;
    this.focus(this.insert(i, type));
  }

  private async remove(cv: CellView) {
    const i = this.cells.indexOf(cv);
    this.cells.splice(i, 1);
    cv.editor.destroy();
    if (!this.cells.length) this.insert(0, "code");
    this.renderList();
    this.markDirty();
    this.focus(this.cells[Math.min(i, this.cells.length - 1)]);
  }

  private move(cv: CellView, d: number) {
    const i = this.cells.indexOf(cv);
    const j = i + d;
    if (j < 0 || j >= this.cells.length) return;
    [this.cells[i], this.cells[j]] = [this.cells[j], this.cells[i]];
    this.renderList();
    this.markDirty();
    this.focus(cv);
  }

  private setActive(cv: CellView) {
    if (this.active === cv) return;
    this.active?.el.classList.remove("active");
    this.active = cv;
    cv.el.classList.add("active");
  }

  private focus(cv: CellView | undefined) {
    if (!cv) return;
    this.setActive(cv);
    if (cv.md && !cv.editing) cv.el.focus();
    else setTimeout(() => cv.editor.focus());
    cv.el.scrollIntoView({ block: "nearest" });
  }

  private renderList() {
    this.list.replaceChildren(...this.cells.map((c) => c.el), h("div.nb-add", null, h("button.btn", { onclick: () => this.focus(this.insert(this.cells.length, "code")) }, icon("general/add"), "Código"), h("button.btn", { onclick: () => this.focus(this.insert(this.cells.length, "markdown")) }, icon("general/add"), "Markdown")));
  }

  /** Command-mode keys when a cell (not its editor) has the focus. */
  private onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === "KeyS") {
      e.preventDefault();
      e.stopPropagation();
      this.save();
      return;
    }
    const target = e.target as HTMLElement;
    if (!target.classList?.contains("nb-cell") || !this.active) return;
    const cv = this.active;
    const i = this.cells.indexOf(cv);
    const key = e.key.toLowerCase();
    const handled = () => (e.preventDefault(), e.stopPropagation());
    if (e.key === "Enter" && !mod && !e.shiftKey) return handled(), cv.md && this.setEditing(cv, true), this.focus(cv);
    if (e.key === "Enter" && (mod || e.shiftKey)) return handled(), this.runCell(cv, e.shiftKey);
    if (key === "a") return handled(), this.focus(this.insert(i, "code"));
    if (key === "b") return handled(), this.focus(this.insert(i + 1, "code"));
    if (key === "m" && cv.cell.cell_type === "code") return handled(), this.convert(cv);
    if (key === "y" && cv.cell.cell_type === "markdown") return handled(), this.convert(cv);
    if (e.key === "ArrowUp") return handled(), this.focus(this.cells[Math.max(0, i - 1)]);
    if (e.key === "ArrowDown") return handled(), this.focus(this.cells[Math.min(this.cells.length - 1, i + 1)]);
  }
}
