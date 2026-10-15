// File editors: CodeMirror with LSP, breakpoints, run markers, VCS change markers, autosave.
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightActiveLine, gutter, GutterMarker, Decoration, type DecorationSet,
  ViewPlugin, type ViewUpdate, showTooltip, type Tooltip,
} from "@codemirror/view";
import { EditorState, Compartment, StateField, StateEffect, RangeSet, RangeSetBuilder, EditorSelection, type Extension, type Text } from "@codemirror/state";
import { indentOnInput, bracketMatching, foldGutter, foldKeymap, syntaxTree } from "@codemirror/language";
import { acceptCompletion, closeBrackets, closeBracketsKeymap, completionKeymap, completionStatus, startCompletion } from "@codemirror/autocomplete";
import { completionComp, completionExtension, tabAccepts } from "./completion";
import {
  defaultKeymap, history, historyKeymap, indentWithTab, toggleComment, toggleBlockComment, undo, redo, copyLineDown,
  deleteLine, moveLineUp, moveLineDown, selectParentSyntax, selectLine,
} from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, openSearchPanel, gotoLine as cmGotoLine } from "@codemirror/search";
import { jumpToDefinition, renameSymbol, showSignatureHelp, LSPPlugin, jumpToImplementation, jumpToTypeDefinition } from "@codemirror/lsp-client";
import { h } from "../util";
import { icon, fileIconName } from "../icons";
import { confirmDialog, contextMenu, popupList, toast, type MenuItem } from "../ui";
import type { Tab } from "../tabs";
import { host, IS_MAC, P, REVEAL_LABEL } from "./host";
import { keymapId } from "./keymap";
import { langFor, langExtensions, islandsTheme, type LangInfo } from "./lang";
import { lspLangFor, type LspLang } from "./lsp";
import { infraActions, infraKind, isK8s, INFRA_ICON, INFRA_LABEL } from "./infra";
import { pyTool } from "./sdk";
import type { Workbench } from "./workbench";

// ---------------- breakpoints ----------------
class BpMarker extends GutterMarker {
  constructor(readonly disabled = false) {
    super();
  }
  toDOM() {
    const d = h("div.cm-bp");
    d.append(icon(this.disabled ? "breakpoints/breakpointDisabled" : "breakpoints/breakpoint"));
    return d;
  }
}
const bpMarker = new BpMarker();
const toggleBp = StateEffect.define<{ pos: number }>({ map: (v, m) => ({ pos: m.mapPos(v.pos) }) });
const setBps = StateEffect.define<number[]>();
const bpField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(toggleBp)) {
        let has = false;
        set.between(e.value.pos, e.value.pos, () => {
          has = true;
        });
        set = has ? set.update({ filter: (from) => from !== e.value.pos }) : set.update({ add: [bpMarker.range(e.value.pos)] });
      } else if (e.is(setBps)) {
        set = RangeSet.of(e.value.map((p) => bpMarker.range(p)), true);
      }
    }
    return set;
  },
});
const bpLineDeco = Decoration.line({ class: "cm-bp-line" });
const bpLines = EditorView.decorations.compute([bpField], (state) => {
  const b = new RangeSetBuilder<Decoration>();
  state.field(bpField).between(0, state.doc.length, (from) => {
    b.add(from, from, bpLineDeco);
  });
  return b.finish();
});

// ---------------- execution point ----------------
const setExec = StateEffect.define<number | null>();
const execField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setExec)) {
        if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) deco = Decoration.none;
        else deco = Decoration.set([Decoration.line({ class: "cm-exec-line" }).range(tr.state.doc.line(e.value).from)]);
      }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------- VCS change markers ----------------
class VcsMarker extends GutterMarker {
  constructor(readonly kind: "added" | "modified" | "deleted") {
    super();
  }
  toDOM() {
    return h(`div.cm-vcs-mark.${this.kind}` as "div");
  }
}
const setVcs = StateEffect.define<RangeSet<GutterMarker>>();
const vcsField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) if (e.is(setVcs)) set = e.value;
    return set;
  },
});

/** Minimal Myers line diff: returns per-line marks for the new text. */
function lineDiff(oldLines: string[], newLines: string[]): { line: number; kind: "added" | "modified" | "deleted" }[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 25_000_000) return [];
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max]) ? v[k + 1 + max] : v[k - 1 + max] + 1;
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) x++, y++;
      v[k + max] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  // backtrack into edit script
  const ins = new Set<number>();
  const del: number[] = []; // new-line index where deletion happened
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[k - 1 + max] < vv[k + 1 + max]) ? k + 1 : k - 1;
    const px = vv[prevK + max];
    const py = px - prevK;
    while (x > px && y > py) x--, y--;
    if (x === px) ins.add(py); // insertion of new line py
    else del.push(y); // deletion before new line y
    x = px;
    y = py;
  }
  const out: { line: number; kind: "added" | "modified" | "deleted" }[] = [];
  const delAt = new Map<number, number>();
  for (const d of del) delAt.set(d, (delAt.get(d) ?? 0) + 1);
  // inserted lines adjacent to deletions are "modified"
  const sorted = [...ins].sort((a, b) => a - b);
  for (const l of sorted) {
    let start = l;
    while (ins.has(start - 1)) start--;
    out.push({ line: l, kind: delAt.has(start) ? "modified" : "added" });
  }
  for (const [l] of delAt) {
    if (ins.has(l)) continue;
    out.push({ line: Math.min(l, m - 1), kind: "deleted" });
  }
  return out;
}

// ---------------- run gutter markers ----------------
export interface RunTarget {
  kind: "python" | "pytest" | "go" | "gotest";
  path: string;
  filter?: string;
  label: string;
}
class RunMarker extends GutterMarker {
  constructor(readonly target: RunTarget) {
    super();
  }
  eq(o: RunMarker) {
    return o.target.label === this.target.label;
  }
  toDOM() {
    const d = h("div.cm-run-marker", { title: `Executar ${this.target.label}` });
    d.append(icon("gutter/run"));
    return d;
  }
}
function runTargets(path: string, doc: Text): { line: number; target: RunTarget }[] {
  const out: { line: number; target: RunTarget }[] = [];
  const ext = P.ext(path);
  const name = P.base(path);
  if (ext === "py") {
    const isTestFile = /^test_|_test\.py$/.test(name);
    let cls: string | null = null;
    for (let i = 1; i <= doc.lines; i++) {
      const t = doc.line(i).text;
      if (/^if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(t)) out.push({ line: i, target: { kind: "python", path, label: `'${name}'` } });
      let m = /^class\s+(Test\w*)/.exec(t);
      if (m) {
        cls = m[1];
        out.push({ line: i, target: { kind: "pytest", path, filter: m[1], label: `pytest para ${m[1]}` } });
        continue;
      }
      if (/^\S/.test(t) && !/^class\s/.test(t)) cls = null;
      m = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(t);
      if (m && (isTestFile || cls)) {
        const f = m[1] && cls ? `${cls}::${m[2]}` : m[2];
        out.push({ line: i, target: { kind: "pytest", path, filter: f, label: `pytest para ${f}` } });
      }
    }
  } else if (ext === "go") {
    const text = doc.toString();
    const isMain = /^package\s+main\b/m.test(text);
    for (let i = 1; i <= doc.lines; i++) {
      const t = doc.line(i).text;
      if (isMain && /^func\s+main\s*\(\s*\)/.test(t)) out.push({ line: i, target: { kind: "go", path, label: "go build " + P.base(P.dir(path)) } });
      const m = /^func\s+((?:Test|Benchmark|Example|Fuzz)\w*)\s*\(/.exec(t);
      if (m && name.endsWith("_test.go")) out.push({ line: i, target: { kind: "gotest", path, filter: m[1], label: m[1] } });
    }
  }
  return out;
}

// ---------------- the editor ----------------
export class CodeEditor {
  view!: EditorView;
  lang: LangInfo;
  lspLang: LspLang | null;
  iconName: string;
  crlf = false;
  encoding = "UTF-8";
  readOnly = false;
  savedText = "";
  tab: Tab;
  el = h("div.code-pane");
  private host_ = h("div.code-host");
  /** Quick actions for Dockerfile / Compose / Terraform / Kubernetes files. */
  private infraBar = h("div.infra-bar.hidden");
  private lspComp = new Compartment();
  private roComp = new Compartment();
  private saveTimer: number | undefined;
  private vcsTimer: number | undefined;
  private headText: string | null | undefined;
  private lastWrite = 0;
  private disposed = false;

  constructor(private wb: Workbench, readonly path: string) {
    this.lang = langFor(path);
    this.lspLang = lspLangFor(path);
    this.iconName = fileIconName(P.base(path));
    this.el.append(this.infraBar, this.host_);
    this.tab = {
      id: "file:" + path.toLowerCase(),
      title: P.base(path),
      icon: this.iconName,
      tooltip: P.win(path),
      el: this.el,
      onActivate: () => {
        this.wb.projectView?.highlight(this.path);
        setTimeout(() => this.view?.focus());
      },
      onDeactivate: () => this.flush(),
      canClose: async () => {
        await this.flush();
        return true;
      },
      onClose: () => this.dispose(),
      menu: () => [
        { label: "Revelar no Projeto", icon: "general/locate", action: () => this.wb.projectView.reveal(this.path) },
        { label: REVEAL_LABEL, action: () => host.reveal(this.path) },
        { label: "Copiar caminho", icon: "general/copy", action: () => navigator.clipboard.writeText(P.win(this.path)) },
        { separator: true },
        ...this.runMenu(),
      ],
    };
  }

  get dirty() {
    return !!this.view && this.view.state.doc.toString() !== this.savedText;
  }

  async load(): Promise<boolean> {
    const ext = P.ext(this.path);
    if (["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "svg"].includes(ext) && ext !== "svg") {
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      this.el.replaceChildren(h("div.image-preview", null, h("img", { src: convertFileSrc(P.win(this.path)) })));
      return true;
    }
    const ft = await host.read(this.path);
    if (ft.binary || ft.tooLarge) {
      this.el.replaceChildren(h("div.editor-empty", null, icon("fileTypes/binaryData"), h("div", null, ft.binary ? "Arquivo binário — não pode ser exibido no editor." : "Arquivo grande demais para abrir (> 20 MB).")));
      return true;
    }
    this.crlf = ft.crlf;
    this.encoding = ft.encoding;
    this.savedText = ft.text;
    this.create(ft.text);
    this.renderInfraBar();
    this.attachLsp();
    this.refreshVcs(true);
    return true;
  }

  private create(text: string) {
    const bps = this.wb.settings.breakpoints?.[this.path.toLowerCase()] ?? [];
    const keys = this.keymap();
    const runGutter = gutter({
      class: "cm-run-gutter",
      markers: (v) => {
        const b = new RangeSetBuilder<GutterMarker>();
        for (const r of runTargets(this.path, v.state.doc)) {
          const ln = v.state.doc.line(r.line);
          b.add(ln.from, ln.from, new RunMarker(r.target));
        }
        return b.finish();
      },
      domEventHandlers: {
        mousedown: (view, block, e) => {
          const t = runTargets(this.path, view.state.doc).find((r) => view.state.doc.line(r.line).from === block.from);
          if (!t) return false;
          const me = e as MouseEvent;
          contextMenu(me.clientX, me.clientY, [
            { label: `Executar ${t.target.label}`, icon: "run/run", shortcut: "Ctrl+Shift+F10", action: () => this.wb.runner.runTarget(t.target, false) },
            { label: `Depurar ${t.target.label}`, icon: "run/debug", action: () => this.wb.runner.runTarget(t.target, true) },
          ]);
          return true;
        },
      },
    });
    const bpGutter = gutter({
      class: "cm-breakpoint-gutter",
      markers: (v) => v.state.field(bpField),
      initialSpacer: () => bpMarker,
      domEventHandlers: {
        mousedown: (view, block) => {
          view.dispatch({ effects: toggleBp.of({ pos: block.from }) });
          this.breakpointsChanged();
          return true;
        },
      },
    });
    const vcsGutter = gutter({ class: "cm-vcs-gutter", markers: (v) => v.state.field(vcsField) });
    const self = this;
    const changeWatcher = ViewPlugin.fromClass(
      class {
        update(u: ViewUpdate) {
          if (u.docChanged) self.onEdit();
          if (u.selectionSet || u.docChanged) self.wb.renderStatus();
        }
      },
    );
    const extensions: Extension[] = [
      bpField,
      bpLines,
      execField,
      vcsField,
      lineNumbers(),
      bpGutter,
      runGutter,
      vcsGutter,
      foldGutter({ openText: "⌄", closedText: "›" }),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      completionComp.of(completionExtension()),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of(keys),
      ...langExtensions(this.lang),
      islandsTheme,
      this.lspComp.of([]),
      this.roComp.of(EditorState.readOnly.of(false)),
      changeWatcher,
      EditorView.domEventHandlers({
        mousedown: (e, view) => {
          if ((e.ctrlKey || e.metaKey) && e.button === 0) {
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos === null) return false;
            view.dispatch({ selection: { anchor: pos } });
            setTimeout(() => this.command("definition"));
            e.preventDefault();
            return true;
          }
          return false;
        },
        blur: () => {
          this.flush();
        },
        contextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, this.contextItems());
          return true;
        },
      }),
    ];
    this.view = new EditorView({ parent: this.host_, state: EditorState.create({ doc: text, extensions }) });
    if (bps.length) {
      const doc = this.view.state.doc;
      this.view.dispatch({ effects: setBps.of(bps.filter((l) => l <= doc.lines).map((l) => doc.line(l).from)) });
    }
  }

  private keymap() {
    const c = (name: string) => () => (this.command(name), true);
    // Bindings checked at key time, so switching the keymap in Settings applies to open editors.
    type Run = (v: EditorView) => boolean;
    const jb = (run: Run): Run => (v) => keymapId() === "jetbrains" && run(v);
    const vs = (run: Run): Run => (v) => keymapId() === "vscode" && run(v);
    return [
      // Tab accepts the selected completion (JetBrains), when enabled in Settings › Editor
      { key: "Tab", run: (v: EditorView) => tabAccepts() && completionStatus(v.state) === "active" && acceptCompletion(v) },
      // JetBrains
      { key: "Mod-d", run: jb(copyLineDown), preventDefault: true },
      { key: "Mod-y", run: jb(deleteLine), preventDefault: true },
      { key: "Mod-w", run: jb(selectParentSyntax), preventDefault: true },
      { key: "Alt-Shift-ArrowUp", run: jb(moveLineUp) },
      { key: "Alt-Shift-ArrowDown", run: jb(moveLineDown) },
      { key: "Mod-Shift-ArrowUp", run: jb(moveLineUp) },
      { key: "Mod-Shift-ArrowDown", run: jb(moveLineDown) },
      { key: "Mod-b", run: jb(c("definition")), preventDefault: true },
      { key: "Mod-Alt-b", run: jb(c("implementation")), preventDefault: true },
      { key: "Mod-Shift-b", run: jb(c("typeDefinition")), preventDefault: true },
      { key: "Alt-F7", run: jb(c("usages")), preventDefault: true },
      { key: "Shift-F6", run: jb(c("rename")), preventDefault: true },
      { key: "Mod-p", run: jb(c("signature")), preventDefault: true },
      { key: "Mod-q", run: jb(c("hover")), preventDefault: true },
      { key: "Alt-Enter", run: jb(c("quickfix")), preventDefault: true },
      { key: "Mod-Alt-l", run: jb(() => (this.format(), true)), preventDefault: true },
      { key: "Mod-Alt-o", run: jb(() => (this.organizeImports(), true)), preventDefault: true },
      { key: "Mod-F8", run: jb(() => (this.toggleBreakpointAtCursor(), true)), preventDefault: true },
      { key: "Mod-r", run: jb(c("replace")), preventDefault: true },
      { key: "Mod-Space", run: jb(startCompletion) },
      // VS Code (Mod-d next occurrence, Alt-↑/↓, Shift-Alt-↓ and Mod-Shift-k come from the default keymaps below)
      { key: "Mod-F12", run: vs(c("implementation")), preventDefault: true },
      { key: "Shift-F12", run: vs(c("usages")), preventDefault: true },
      { key: "F2", run: vs(c("rename")), preventDefault: true },
      { key: "Mod-.", run: vs(c("quickfix")), preventDefault: true },
      { key: "Mod-Shift-Space", run: vs(c("signature")), preventDefault: true },
      { key: "Shift-Alt-f", run: vs(() => (this.format(), true)), preventDefault: true },
      { key: "Shift-Alt-o", run: vs(() => (this.organizeImports(), true)), preventDefault: true },
      { key: IS_MAC ? "Mod-Alt-f" : "Mod-h", run: vs(c("replace")), preventDefault: true },
      { key: IS_MAC ? "Ctrl-Shift-Mod-ArrowRight" : "Shift-Alt-ArrowRight", run: vs(selectParentSyntax), preventDefault: true },
      // both
      { key: "Mod-/", run: toggleComment },
      { key: "Mod-Shift-/", run: toggleBlockComment },
      { key: "Mod-l", run: selectLine, preventDefault: true },
      { key: "F12", run: c("definition") },
      { key: "Mod-Shift-z", run: redo, preventDefault: true },
      ...closeBracketsKeymap,
      ...defaultKeymap.filter((k) => k.key !== "Mod-Enter"),
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ];
  }

  private contextItems(): MenuItem[] {
    const hasLsp = !!this.lspLang;
    return [
      { label: "Mostrar ações de contexto", icon: "actions/realIntentionBulb", shortcut: "Alt+Enter", disabled: !hasLsp, action: () => this.command("quickfix") },
      { separator: true },
      { label: "Ir para declaração", shortcut: "Ctrl+B", disabled: !hasLsp, action: () => this.command("definition") },
      { label: "Ir para implementação", shortcut: "Ctrl+Alt+B", disabled: !hasLsp, action: () => this.command("implementation") },
      { label: "Encontrar usos", shortcut: "Alt+F7", disabled: !hasLsp, action: () => this.command("usages") },
      { label: "Renomear…", shortcut: "Shift+F6", disabled: !hasLsp, action: () => this.command("rename") },
      { separator: true },
      { label: "Reformatar código", icon: "actions/reformatCode", shortcut: "Ctrl+Alt+L", action: () => this.format() },
      { label: "Otimizar imports", shortcut: "Ctrl+Alt+O", action: () => this.organizeImports() },
      { separator: true },
      { label: "Recortar", icon: "general/cut", shortcut: "Ctrl+X", action: () => document.execCommand("cut") },
      { label: "Copiar", icon: "general/copy", shortcut: "Ctrl+C", action: () => document.execCommand("copy") },
      { label: "Colar", icon: "general/paste", shortcut: "Ctrl+V", action: () => navigator.clipboard.readText().then((t) => this.view.dispatch(this.view.state.replaceSelection(t))) },
      { separator: true },
      ...this.runMenu(),
      ...(this.infraKind() ? [{ label: INFRA_LABEL[this.infraKind()!], icon: INFRA_ICON[this.infraKind()!], submenu: infraActions(this.wb, this.path, this.infraKind()!) } as MenuItem] : []),
      { label: "Alternar breakpoint", icon: "breakpoints/breakpoint", shortcut: "Ctrl+F8", action: () => this.toggleBreakpointAtCursor() },
      { separator: true },
      { label: "Abrir no terminal", icon: "toolwindows/terminal", action: () => this.wb.terminals.newTab(P.dir(this.path)) },
      { label: "Git: comparar com HEAD", icon: "vcs/diff", action: () => this.wb.git.showDiff(this.path) },
    ];
  }

  private runMenu(): MenuItem[] {
    const t = this.wb.runner?.fileTarget(this.path);
    if (!t) return [];
    return [
      { label: `Executar ${t.label}`, icon: "run/run", shortcut: "Ctrl+Shift+F10", action: () => this.wb.runner.runTarget(t, false) },
      { label: `Depurar ${t.label}`, icon: "run/debug", action: () => this.wb.runner.runTarget(t, true) },
    ];
  }

  // ---------- LSP ----------
  infraKind() {
    return infraKind(this.path, this.view?.state.doc.toString() ?? this.savedText);
  }

  private renderInfraBar() {
    const kind = this.infraKind();
    this.infraBar.classList.toggle("hidden", !kind);
    if (!kind) return this.infraBar.replaceChildren();
    const acts = infraActions(this.wb, this.path, kind);
    this.infraBar.replaceChildren(
      h("span.ib-kind", null, icon(INFRA_ICON[kind]), INFRA_LABEL[kind]),
      ...acts.filter((a) => a.primary).map((a) => h("button.ib-btn", { onclick: () => a.action?.() }, a.icon ? icon(a.icon) : "", a.label!.replace(/…$/, ""))),
      h("span.grow"),
      h("button.ib-btn", { title: "Mais ações", onclick: (e: MouseEvent) => contextMenu(e.clientX, e.clientY + 8, acts) }, icon("general/moreHorizontal")),
    );
  }

  async attachLsp() {
    if (!this.lspLang || this.disposed) return;
    const text = this.view?.state.doc.toString() ?? this.savedText;
    if (this.lspLang === "yaml" && isK8s(text)) this.wb.lsp.markKubernetes(this.path);
    // Plain YAML (CI files, configs...) uses the YAML server when installed, without nagging when it isn't.
    const quiet = this.lspLang === "yaml" && !infraKind(this.path, text);
    const client = await this.wb.lsp.ensure(this.lspLang, quiet);
    if (!client || this.disposed || !this.view) return;
    this.view.dispatch({ effects: this.lspComp.reconfigure(client.plugin(P.uri(this.path), this.lang.id)) });
    this.wb.renderStatus();
  }

  detachLsp() {
    this.view?.dispatch({ effects: this.lspComp.reconfigure([]) });
  }

  async command(name: string) {
    const v = this.view;
    if (!v) return;
    switch (name) {
      case "undo":
        return undo(v);
      case "redo":
        return redo(v);
      case "find":
        return openSearchPanel(v);
      case "replace":
        openSearchPanel(v);
        setTimeout(() => (v.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]") ?? null)?.focus(), 30);
        return;
      case "gotoLine":
        return cmGotoLine(v);
      case "duplicate":
        return copyLineDown(v);
      case "deleteLine":
        return deleteLine(v);
      case "comment":
        return toggleComment(v);
      case "complete":
        return startCompletion(v);
    }
    if (!LSPPlugin.get(v)) {
      toast("Recurso disponível com o servidor de linguagem instalado (Configurações › Plugins).", "info");
      return;
    }
    switch (name) {
      case "definition":
        return jumpToDefinition(v);
      case "implementation":
        return jumpToImplementation(v);
      case "typeDefinition":
        return jumpToTypeDefinition(v);
      case "rename":
        return renameSymbol(v);
      case "signature":
        return showSignatureHelp(v);
      case "hover":
        return this.quickDoc();
      case "usages":
        return this.findUsages();
      case "quickfix":
        return this.quickFix();
    }
  }

  private lspPos(pos = this.view.state.selection.main.head) {
    const line = this.view.state.doc.lineAt(pos);
    return { line: line.number - 1, character: pos - line.from };
  }

  private async findUsages() {
    const plugin = LSPPlugin.get(this.view)!;
    plugin.client.sync();
    const word = this.wordAtCursor();
    const res = await plugin.client
      .request<unknown, { uri: string; range: { start: { line: number; character: number } } }[]>("textDocument/references", {
        textDocument: { uri: P.uri(this.path) },
        position: this.lspPos(),
        context: { includeDeclaration: true },
      })
      .catch(() => null);
    if (!res?.length) return toast("Nenhum uso encontrado", "info");
    const { showFindResults } = await import("./search");
    showFindResults(
      this.wb,
      `Usos de '${word}'`,
      res.map((r) => ({ path: P.fromUri(r.uri), line: r.range.start.line + 1, col: r.range.start.character + 1, len: word.length, text: "" })),
    );
  }

  private wordAtCursor() {
    const r = this.view.state.wordAt(this.view.state.selection.main.head);
    return r ? this.view.state.sliceDoc(r.from, r.to) : "";
  }

  private async quickDoc() {
    const plugin = LSPPlugin.get(this.view)!;
    plugin.client.sync();
    const pos = this.view.state.selection.main.head;
    const res = await plugin.client
      .request<unknown, { contents: any } | null>("textDocument/hover", { textDocument: { uri: P.uri(this.path) }, position: this.lspPos(pos) })
      .catch(() => null);
    if (!res?.contents) return;
    const contents = Array.isArray(res.contents) ? res.contents.map((c: any) => (typeof c === "string" ? c : "```\n" + c.value + "\n```")).join("\n\n") : res.contents;
    const html = plugin.docToHTML(contents);
    const tip: Tooltip = {
      pos,
      above: true,
      create: () => {
        const dom = h("div.cm-tooltip-hover", { html });
        return { dom };
      },
    };
    const field = StateField.define<readonly Tooltip[]>({ create: () => [tip], update: (v, tr) => (tr.selection || tr.docChanged ? [] : v), provide: (f) => showTooltip.computeN([f], (s) => s.field(f)) });
    this.view.dispatch({ effects: StateEffect.appendConfig.of(field) });
  }

  private async quickFix() {
    const plugin = LSPPlugin.get(this.view)!;
    plugin.client.sync();
    const sel = this.view.state.selection.main;
    const line = this.view.state.doc.lineAt(sel.head).number;
    const diags = (this.wb.lsp.diagnostics.get(this.path) ?? []).filter((d) => d.line <= line && d.endLine >= line);
    const range = { start: this.lspPos(sel.from), end: this.lspPos(sel.to) };
    const actions = await plugin.client
      .request<unknown, any[] | null>("textDocument/codeAction", {
        textDocument: { uri: P.uri(this.path) },
        range,
        context: {
          diagnostics: diags.map((d) => ({ range: { start: { line: d.line - 1, character: d.col - 1 }, end: { line: d.endLine - 1, character: d.endCol - 1 } }, message: d.message, severity: d.severity, source: d.source, code: d.code })),
        },
      })
      .catch(() => null);
    if (!actions?.length) return toast("Nenhuma ação disponível aqui", "info", 2000);
    const coords = this.view.coordsAtPos(sel.head);
    popupList(
      coords ? { x: coords.left, y: coords.bottom } : this.view.dom,
      actions.map((a) => ({
        label: a.title,
        icon: a.kind?.startsWith("quickfix") ? "actions/realIntentionBulb" : "actions/lightning",
        action: () => this.applyCodeAction(a),
      })),
      { width: 440, search: false },
    );
  }

  private async applyCodeAction(a: any) {
    const plugin = LSPPlugin.get(this.view)!;
    let action = a;
    if (!action.edit && !action.command && plugin.client.serverCapabilities?.codeActionProvider) {
      action = (await plugin.client.request<unknown, any>("codeAction/resolve", a).catch(() => a)) ?? a;
    }
    if (action.edit) await this.applyEdit(action.edit);
    const cmd = action.command?.command ? action.command : typeof action.command === "string" ? action : null;
    if (cmd) await plugin.client.request("workspace/executeCommand", { command: cmd.command, arguments: cmd.arguments }).catch((e) => toast(String(e?.message ?? e), "error"));
  }

  private async applyEdit(edit: any) {
    const plugin = LSPPlugin.get(this.view)!;
    const byUri: Record<string, any[]> = { ...(edit.changes ?? {}) };
    for (const dc of edit.documentChanges ?? []) if (dc.textDocument) byUri[dc.textDocument.uri] = [...(byUri[dc.textDocument.uri] ?? []), ...dc.edits];
    for (const [uri, edits] of Object.entries(byUri)) {
      const file = await plugin.client.workspace.requestFile(uri);
      if (!file) continue;
      const doc = file.doc;
      const pos = (p: any) => Math.min(doc.line(Math.min(p.line + 1, doc.lines)).from + p.character, doc.length);
      plugin.client.workspace.updateFile(uri, { changes: edits.map((e: any) => ({ from: pos(e.range.start), to: pos(e.range.end), insert: e.newText })) });
    }
  }

  // ---------- formatting ----------
  async format() {
    if (!this.view || this.readOnly) return;
    const text = this.view.state.doc.toString();
    if (P.ext(this.path) === "py") {
      const ruff = await pyTool("ruff");
      if (!ruff) return toast("Instale o Ruff em Configurações › Plugins › Python para reformatar.", "info");
      const r = await host.capture(ruff, ["format", "--stdin-filename", P.win(this.path), "-"], this.wb.root, text, 30);
      if (r.code !== 0) return toast(r.stderr.trim().split("\n").slice(-3).join("\n") || "ruff falhou", "error", 7000);
      this.replaceAll(r.stdout);
      return;
    }
    const plugin = LSPPlugin.get(this.view);
    if (plugin) {
      plugin.client.sync();
      const edits = await plugin.client
        .request<unknown, any[] | null>("textDocument/formatting", { textDocument: { uri: P.uri(this.path) }, options: { tabSize: 4, insertSpaces: this.lang.indent !== "\t" } })
        .catch(() => null);
      if (edits?.length) {
        const doc = this.view.state.doc;
        const pos = (p: any) => Math.min(doc.line(Math.min(p.line + 1, doc.lines)).from + p.character, doc.length);
        this.view.dispatch({ changes: edits.map((e) => ({ from: pos(e.range.start), to: pos(e.range.end), insert: e.newText })) });
      }
      return;
    }
    if (this.lang.id === "terraform" || this.lang.id === "terraform-vars") {
      const r = await host.capture("terraform", ["fmt", "-"], P.dir(this.path), text, 30).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
      if (r.code !== 0) return toast(r.stderr.trim().split("\n").slice(-3).join("\n") || "terraform fmt falhou", "error", 7000);
      this.replaceAll(r.stdout);
      return;
    }
    if (this.lang.id === "json") {
      try {
        this.replaceAll(JSON.stringify(JSON.parse(text), null, 2) + "\n");
      } catch (e) {
        toast(String(e), "error");
      }
    }
  }

  async organizeImports() {
    if (!this.view) return;
    if (P.ext(this.path) === "py") {
      const ruff = await pyTool("ruff");
      if (!ruff) return toast("Instale o Ruff em Configurações › Plugins › Python.", "info");
      const r = await host.capture(ruff, ["check", "--select", "I,F401", "--fix", "--stdin-filename", P.win(this.path), "-"], this.wb.root, this.view.state.doc.toString(), 30);
      if (r.stdout) this.replaceAll(r.stdout);
      return;
    }
    const plugin = LSPPlugin.get(this.view);
    if (!plugin) return;
    plugin.client.sync();
    const end = this.lspPos(this.view.state.doc.length);
    const actions = await plugin.client
      .request<unknown, any[] | null>("textDocument/codeAction", {
        textDocument: { uri: P.uri(this.path) },
        range: { start: { line: 0, character: 0 }, end },
        context: { diagnostics: [], only: ["source.organizeImports"] },
      })
      .catch(() => null);
    for (const a of actions ?? []) await this.applyCodeAction(a);
  }

  private replaceAll(text: string) {
    const cur = this.view.state.doc.toString();
    if (cur === text) return;
    // keep caret line roughly in place
    const line = this.view.state.doc.lineAt(this.view.state.selection.main.head).number;
    this.view.dispatch({ changes: { from: 0, to: cur.length, insert: text } });
    const l = Math.min(line, this.view.state.doc.lines);
    this.view.dispatch({ selection: { anchor: this.view.state.doc.line(l).from } });
  }

  // ---------- saving ----------
  private onEdit() {
    this.updateTabState();
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 1500);
    clearTimeout(this.vcsTimer);
    this.vcsTimer = window.setTimeout(() => this.refreshVcs(), 500);
  }

  updateTabState() {
    const cls: string[] = [];
    if (this.dirty) cls.push("modified");
    const st = this.wb.git?.statusOf(this.path);
    if (st) cls.push("vcs-" + st);
    if ((this.wb.lsp.diagnostics.get(this.path) ?? []).some((d) => d.severity === 1)) cls.push("has-error");
    const c = cls.join(" ");
    if (c !== this.tab.cls) {
      this.tab.cls = c;
      this.wb.tabs.update(this.tab);
    }
  }

  async flush() {
    clearTimeout(this.saveTimer);
    if (this.dirty) await this.save();
  }

  async save() {
    if (!this.view || this.readOnly || this.disposed) return;
    if (P.ext(this.path) === "go" && this.wb.settings.goFmtOnSave !== false && LSPPlugin.get(this.view)) {
      await this.format().catch(() => {});
    }
    const text = this.view.state.doc.toString();
    if (text === this.savedText) return;
    try {
      this.lastWrite = Date.now();
      await host.write(this.path, text, this.crlf);
      this.savedText = text;
      this.renderInfraBar();
      this.updateTabState();
      const plugin = LSPPlugin.get(this.view);
      plugin?.client.notification("textDocument/didSave", { textDocument: { uri: P.uri(this.path) }, text });
    } catch (e) {
      toast("Não foi possível salvar: " + e, "error", 8000);
    }
  }

  /** Called when the file changed on disk. */
  async reload(force = false) {
    if (!this.view) return;
    if (!force && Date.now() - this.lastWrite < 1500) return;
    const ft = await host.read(this.path).catch(() => null);
    if (!ft || ft.binary) return;
    if (ft.text === this.view.state.doc.toString()) {
      this.savedText = ft.text;
      return;
    }
    if (this.dirty && !force) {
      const ok = await confirmDialog("Arquivo alterado no disco", `${P.base(this.path)} foi alterado fora do editor. Recarregar e descartar suas alterações?`, "Recarregar");
      if (!ok) return;
    }
    this.savedText = ft.text;
    this.replaceAll(ft.text);
    this.updateTabState();
  }

  // ---------- VCS gutter ----------
  async refreshVcs(reloadHead = false) {
    if (!this.view || !this.wb.git?.isRepo) return;
    if (reloadHead || this.headText === undefined) this.headText = await this.wb.git.headContent(this.path);
    const doc = this.view.state.doc;
    const b = new RangeSetBuilder<GutterMarker>();
    if (this.headText === null) {
      // untracked/new file: everything added
      if (this.wb.git.statusOf(this.path)) for (let i = 1; i <= doc.lines; i++) b.add(doc.line(i).from, doc.line(i).from, new VcsMarker("added"));
    } else {
      const marks = lineDiff(this.headText.split("\n"), doc.toString().split("\n"))
        .filter((x) => x.line >= 0 && x.line < doc.lines)
        .sort((a, b2) => a.line - b2.line);
      let last = -1;
      for (const mk of marks) {
        if (mk.line === last) continue;
        last = mk.line;
        const ln = doc.line(mk.line + 1);
        b.add(ln.from, ln.from, new VcsMarker(mk.kind));
      }
    }
    this.view.dispatch({ effects: setVcs.of(b.finish()) });
  }

  // ---------- breakpoints / debugging ----------
  breakpointLines(): number[] {
    if (!this.view) return this.wb.settings.breakpoints?.[this.path.toLowerCase()] ?? [];
    const out: number[] = [];
    const doc = this.view.state.doc;
    this.view.state.field(bpField).between(0, doc.length, (from) => {
      out.push(doc.lineAt(from).number);
    });
    return out;
  }

  private breakpointsChanged() {
    const lines = this.breakpointLines();
    this.wb.settings.breakpoints = { ...(this.wb.settings.breakpoints ?? {}), [this.path.toLowerCase()]: lines };
    if (!lines.length) delete this.wb.settings.breakpoints[this.path.toLowerCase()];
    this.wb.saveSettings();
    this.wb.debugger.breakpointsChanged(this.path, lines);
  }

  toggleBreakpointAtCursor() {
    if (!this.view) return;
    const line = this.view.state.doc.lineAt(this.view.state.selection.main.head);
    this.view.dispatch({ effects: toggleBp.of({ pos: line.from }) });
    this.breakpointsChanged();
  }

  setExecLine(line: number | null) {
    if (!this.view) return;
    this.view.dispatch({ effects: setExec.of(line) });
    if (line) this.reveal(line, 1, false);
  }

  reveal(line: number, col = 1, select = true, len = 0) {
    if (!this.view) return;
    const doc = this.view.state.doc;
    const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
    const from = Math.min(l.from + Math.max(0, col - 1), l.to);
    this.view.dispatch({
      selection: select ? EditorSelection.single(from, Math.min(from + len, l.to)) : undefined,
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }

  focus() {
    this.view?.focus();
  }

  cursorInfo() {
    if (!this.view) return { line: 1, col: 1, sel: 0 };
    const s = this.view.state.selection.main;
    const l = this.view.state.doc.lineAt(s.head);
    return { line: l.number, col: s.head - l.from + 1, sel: Math.abs(s.to - s.from) };
  }

  /** Name of the enclosing function/class for breadcrumbs (Python/Go). */
  enclosingSymbol(): string | null {
    if (!this.view) return null;
    let node = syntaxTree(this.view.state).resolveInner(this.view.state.selection.main.head, -1);
    const names: string[] = [];
    for (let n: typeof node | null = node; n; n = n.parent) {
      if (/FunctionDefinition|ClassDefinition|FuncDecl|MethodDecl|TypeSpec/.test(n.name)) {
        const id = n.getChild("VariableName") ?? n.getChild("DefName") ?? n.getChild("FieldName") ?? n.getChild("TypeName");
        if (id) names.unshift(this.view.state.sliceDoc(id.from, id.to));
      }
    }
    return names.length ? names.join(".") : null;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.saveTimer);
    this.view?.destroy();
  }
}

export class Editors {
  private map = new Map<string, CodeEditor>();
  constructor(private wb: Workbench) {
    // Completion settings apply to open editors right away.
    window.addEventListener("rits-completion", () => {
      for (const ed of this.map.values()) ed.view?.dispatch({ effects: completionComp.reconfigure(completionExtension()) });
    });
  }

  key(path: string) {
    return P.norm(path).toLowerCase();
  }

  get(path: string) {
    return this.map.get(this.key(path)) ?? null;
  }

  all(): CodeEditor[] {
    return this.wb.tabs.tabs.map((t) => [...this.map.values()].find((e) => e.tab === t)).filter((e): e is CodeEditor => !!e);
  }

  active(): CodeEditor | null {
    const t = this.wb.tabs.active;
    return t ? ([...this.map.values()].find((e) => e.tab === t) ?? null) : null;
  }

  async openFile(path: string, o: { line?: number; col?: number; len?: number; background?: boolean } = {}): Promise<CodeEditor | null> {
    path = P.norm(path);
    let ed = this.get(path);
    if (!ed) {
      ed = new CodeEditor(this.wb, path);
      this.map.set(this.key(path), ed);
      const ok = await ed.load().catch((e) => {
        toast(String(e), "error");
        return false;
      });
      if (!ok) {
        this.map.delete(this.key(path));
        return null;
      }
      const orig = ed.tab.onClose;
      ed.tab.onClose = () => {
        orig?.();
        this.map.delete(this.key(path));
      };
      this.wb.tabs.open(ed.tab, o.background);
      ed.updateTabState();
    } else if (!o.background) this.wb.tabs.activate(ed.tab);
    if (o.line) setTimeout(() => ed!.reveal(o.line!, o.col ?? 1, true, o.len ?? 0));
    return ed;
  }

  async saveAll() {
    await Promise.all([...this.map.values()].map((e) => e.flush()));
  }

  onFsChange(paths: string[]) {
    for (const p of paths) {
      const ed = this.get(p);
      if (ed) ed.reload();
    }
  }

  /** Re-point editors after a rename/move in the project view. */
  async renamed(oldPath: string, newPath: string) {
    for (const ed of [...this.map.values()]) {
      if (P.inside(oldPath, ed.path)) {
        const np = P.norm(newPath + ed.path.slice(P.norm(oldPath).length));
        const line = ed.cursorInfo().line;
        await ed.flush();
        await this.wb.tabs.close(ed.tab);
        await this.openFile(np, { line });
      }
    }
  }

  closeDeleted(paths: string[]) {
    for (const ed of [...this.map.values()]) if (paths.some((p) => P.inside(p, ed.path))) this.wb.tabs.close(ed.tab);
  }

  reattachLsp(lang: LspLang) {
    for (const ed of this.map.values())
      if (ed.lspLang === lang) {
        ed.detachLsp();
        ed.attachLsp();
      }
  }

  refreshTabStates() {
    for (const ed of this.map.values()) ed.updateTabState();
  }

  refreshVcs() {
    for (const ed of this.map.values()) ed.refreshVcs(true);
  }
}
