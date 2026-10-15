// The IDE window ("Blocos" layout): title bar with the editor tabs, cards (tool windows + editor) with a
// segmented tool window switcher, the project home page with its command bar, and a slim footer.
import { Effect, EffectState, getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { h, uid } from "../util";
import { fileIcon, icon, twIcon } from "../icons";
import { TabManager } from "../tabs";
import { closeMenus, contextMenu, modal, button, popupList, toast, type MenuItem, type PopupItem } from "../ui";
import { infraActions } from "./infra";
import { host, IS_MAC, onFsChange, P, type EnvInfo } from "./host";
import { displayShortcut, keymapId } from "./keymap";
import { loadProjectSettings, projectBadge, recentProjects, saveProjectSettings, touchRecent, type ProjectSettings } from "./project";
import { LspManager, LSP_LANG_LABEL, LSP_NAME, type LspLang } from "./lsp";
import { onBgTasks, resolveInterpreter, setCurrentPython, findGo, type PyInterp } from "./sdk";
import { Editors } from "./editors";
import { ProjectView } from "./projectView";
import { Git } from "./git";
import { Runner } from "./run";
import { Debugger } from "./debug";
import { Terminals } from "./terminal";
import { Problems } from "./problems";
import { Structure } from "./structure";
import { DbTools } from "./dbtools";
import { DockerTools, dockerEnabled } from "./docker";
import { airflowEnabled, loadAirflow, type AirflowHandle } from "./airflow/plugin";
import { searchEverywhere, findInFiles, gotoLine, recentFiles, fileStructurePopup } from "./search";
import { openSettings } from "./settings";
import { openCloneDialog, openNewProjectDialog } from "./welcome";

export type Anchor = "left" | "right" | "bottom";
/** Where a tool window lives: a side card, or the bottom card (remembering its old stripe side). */
type StripeZone = "left" | "right" | "bottom-left" | "bottom-right";
/** Something the project home page found in the project root (compose file, Dockerfile, tests…). */
interface Found {
  name: string;
  path: string;
  dir: boolean;
  sub: string;
  icon: HTMLElement;
  action?: { label: string; run: () => void };
}
interface Placement {
  anchor: Anchor;
  side?: "left" | "right";
  order: number;
}
const LAYOUT_KEY = "toolLayout";

function loadToolLayout(): Record<string, Placement> {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export interface ToolWindow {
  id: string;
  title: string;
  icon: string;
  anchor: Anchor;
  group?: "top" | "bottom";
  shortcut?: string;
  body: HTMLElement;
  headerTabs?: HTMLElement;
  actions?: () => HTMLElement[];
  onShow?: () => void;
  badge?: boolean;
  /** Stripe of a bottom tool window (default left). */
  side?: "left" | "right";
  order?: number;
}

export class Workbench {
  root: string;
  name: string;
  settings: ProjectSettings = {};
  env!: EnvInfo;
  python: PyInterp | null = null;
  tabs: TabManager;
  lsp: LspManager;
  editors!: Editors;
  projectView!: ProjectView;
  git!: Git;
  runner!: Runner;
  debugger!: Debugger;
  terminals!: Terminals;
  problems!: Problems;
  structure!: Structure;
  db!: DbTools;
  docker: DockerTools | null = null;
  /** Airflow plugin, loaded on demand (its code lives in a separate chunk). */
  airflow: AirflowHandle | null = null;
  private airflowLoading: Promise<void> | null = null;

  private toolWindows = new Map<string, ToolWindow>();
  private visible: Partial<Record<Anchor, string>> = {};
  private islands: Record<Anchor, HTMLElement>;
  private splitters: Record<Anchor, HTMLElement>;
  private defaultPlacement = new Map<string, Placement>();
  /** Last tool window shown on each side, for the "toggle sidebar/panel" shortcuts. */
  private lastVisible: Partial<Record<Anchor, string>> = {};
  private editorIsland: HTMLElement;
  private toolbar = h("div.main-toolbar");
  private statusLeft = h("div.sb-crumbs");
  private statusRight = h("div.status-item");
  private statusProgress = h("div.sb-progress.hidden");
  private progressByKey = new Map<string, string>();
  readonly vcsBtn = h("button.cp-branch");
  /** Project home: the pinned first tab ("Início"), shown when no tab is active. */
  private home = h("div.home");
  private found: Found[] = [];
  /** Built once, so a re-render of the home page keeps what is being typed in it. */
  private cmdBar: HTMLElement | null = null;
  private cmdChips = h("div.cmd-chips");
  /** Title bar buttons that show or hide each card (and carry a dot when a hidden tool window has news). */
  private layoutBtns: Record<Anchor, HTMLElement> = {
    left: h("button.tb-btn.tb-layout", { title: "Painel esquerdo", "aria-label": "Painel esquerdo", onclick: () => this.toggleSide("left", "project") }, icon("panelLeft")),
    bottom: h("button.tb-btn.tb-layout", { title: "Painel inferior", "aria-label": "Painel inferior", onclick: () => this.toggleSide("bottom", "terminal") }, icon("panelBottom")),
    right: h("button.tb-btn.tb-layout", { title: "Painel direito", "aria-label": "Painel direito", onclick: () => this.toggleSide("right", "airflow") }, icon("panelRight")),
  };
  readonly runWidget = h("div.run-widget");
  private lspLog: string[] = [];

  constructor(root: string) {
    this.root = P.norm(root);
    this.name = P.base(this.root);
    window.addEventListener("rits-keymap", () => {
      if (this.editors) this.renderHome();
      this.renderChrome();
    });
    this.tabs = new TabManager(this.home, { title: "Início do projeto", icon: "nodes/homeFolder" });
    this.lsp = new LspManager(this.root, {
      openFile: async (path) => (await this.editors.openFile(path))?.view ?? null,
      progress: (lang, title) => this.setProgress("lsp-" + lang, title ? `${LSP_LANG_LABEL[lang]}: ${title}` : null),
      log: (lang, line) => {
        this.lspLog.push(`[${lang}] ${line}`);
        if (this.lspLog.length > 500) this.lspLog.shift();
      },
      missing: (lang) => this.pluginMissing(lang),
    });
    this.editorIsland = h("div.island.editor-island", null, this.tabs.content);
    this.islands = {
      left: h("div.island.side.hidden", { style: "width:300px" }),
      right: h("div.island.side.hidden", { style: "width:340px" }),
      bottom: h("div.island.bottom.hidden", { style: "height:280px" }),
    };
    this.splitters = {
      left: h("div.island-split-x.hidden"),
      right: h("div.island-split-x.hidden"),
      bottom: h("div.island-split-y.hidden"),
    };
  }

  // ---------------- boot ----------------

  async mount(app: HTMLElement) {
    this.env = await host.env();
    this.settings = await loadProjectSettings(this.root);
    const center = h("div.ws-col", { style: "flex:1;min-width:0;display:flex;flex-direction:column" }, this.editorIsland, this.splitters.bottom, this.islands.bottom);
    const row = h("div.ws-row", null, this.islands.left, this.splitters.left, center, this.splitters.right, this.islands.right);
    const workspace = h("div.workspace", null, row);
    const statusbar = h("div.statusbar", null, this.statusLeft, h("span.grow"), this.statusProgress, this.statusRight);
    app.replaceChildren(this.toolbar, h("div.ide-body", null, workspace), statusbar);
    this.initSplitters();

    this.python = await resolveInterpreter(this.root, this.settings.pythonInterpreter);
    setCurrentPython(this.python);

    this.editors = new Editors(this);
    this.projectView = new ProjectView(this);
    this.db = new DbTools(this);
    this.git = new Git(this);
    this.structure = new Structure(this);
    this.runner = new Runner(this);
    this.debugger = new Debugger(this);
    this.terminals = new Terminals(this);
    this.problems = new Problems(this);
    this.syncPlugins();
    window.addEventListener("rits-plugins", () => this.syncPlugins());
    window.addEventListener("storage", (e) => e.key?.startsWith("plugin.") && this.syncPlugins());

    this.renderToolbar();
    this.renderChrome();
    this.renderHome();
    this.detectProject();
    this.tabs.onChange = () => {
      if (!this.tabs.active) this.renderHome();
      this.renderStatus();
      this.updateTitle();
      this.persistOpenFiles();
      this.structure.refresh();
    };
    onBgTasks((list) => {
      const running = list.filter((t) => t.running);
      this.setProgress("bg", running.length ? running[0].title + (running.length > 1 ? ` (+${running.length - 1})` : "") : null);
    });

    host.watch(this.root).catch(() => {});
    onFsChange((root, paths) => {
      if (!P.same(root, this.root)) return;
      this.projectView.onFsChange(paths);
      if (paths.some((p) => P.same(P.dir(p), this.root))) this.detectProject();
      this.editors.onFsChange(paths);
      this.git.onFsChange(paths);
      this.lsp.notifyWatched(paths.filter((p) => /\.(py|go|mod|toml|cfg|json)$/i.test(p)));
    });

    // restore layout and files
    const lay = (this.settings.layout ?? {}) as Partial<Record<Anchor, string>>;
    // A tool window saved on one side may live elsewhere now (Database moved to the left card).
    const at = (a: Anchor) => (lay[a] && this.toolWindows.get(lay[a]!)?.anchor === a ? lay[a] : undefined);
    this.show(at("left") ?? "project");
    if (at("bottom")) this.show(at("bottom")!);
    if (at("right")) this.show(at("right")!);
    for (const f of this.settings.openFiles ?? []) if (await host.exists(f)) await this.editors.openFile(f, { background: true });
    // No active file = the project home ("Início") was in front.
    if (this.settings.activeFile) await this.editors.openFile(this.settings.activeFile);
    else this.tabs.showHome();

    this.installKeys();
    this.renderStatus();
    this.updateTitle();
    touchRecent(this.root, this.git.branch ?? undefined);
    window.addEventListener("beforeunload", () => this.persistOpenFiles());
  }

  /** Optional plugins (Docker) add or remove their tool windows when enabled in Settings › Plugins. */
  syncPlugins() {
    if (dockerEnabled() && !this.docker) this.docker = new DockerTools(this);
    else if (!dockerEnabled() && this.docker) {
      this.docker.dispose();
      this.docker = null;
    }
    if (airflowEnabled() && !this.airflow && !this.airflowLoading) {
      this.airflowLoading = loadAirflow(this)
        .then((a) => {
          this.airflow = a;
          // disabled while loading
          if (!airflowEnabled()) this.syncPlugins();
        })
        .catch((e) => console.error("airflow", e))
        .finally(() => (this.airflowLoading = null));
    } else if (!airflowEnabled() && this.airflow) {
      const a = this.airflow;
      this.airflow = null;
      a.dispose();
    }
  }

  saveSettings() {
    saveProjectSettings(this.root, this.settings);
  }

  private persistOpenFiles() {
    this.settings.openFiles = this.editors?.all().map((e) => e.path) ?? [];
    this.settings.activeFile = this.editors?.active()?.path ?? null;
    this.settings.layout = { ...this.visible };
    this.saveSettings();
  }

  updateTitle() {
    const ed = this.editors?.active();
    const title = ed ? `${this.name} – ${P.rel(this.root, ed.path)}` : this.name;
    document.title = title;
    getCurrentWindow().setTitle(title).catch(() => {});
  }

  // ---------------- tool windows ----------------

  register(tw: ToolWindow) {
    tw.order ??= (this.toolWindows.size + 1) * 10;
    this.defaultPlacement.set(tw.id, { anchor: tw.anchor, side: tw.side, order: tw.order });
    const saved = loadToolLayout()[tw.id];
    if (saved) Object.assign(tw, { anchor: saved.anchor, side: saved.side, order: saved.order });
    this.toolWindows.set(tw.id, tw);
    this.renderChrome();
  }

  unregister(id: string) {
    const tw = this.toolWindows.get(id);
    if (!tw) return;
    if (this.visible[tw.anchor] === id) this.hide(tw.anchor);
    this.toolWindows.delete(id);
    this.renderChrome();
  }

  private saveToolLayout() {
    const all = loadToolLayout();
    for (const tw of this.toolWindows.values()) all[tw.id] = { anchor: tw.anchor, side: tw.side, order: tw.order ?? 0 };
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }

  private zoneOf(tw: ToolWindow): StripeZone {
    return tw.anchor === "bottom" ? (tw.side === "right" ? "bottom-right" : "bottom-left") : tw.anchor;
  }

  /** Moves a tool window to a stripe zone at a position, keeping it open if it was. */
  private placeToolWindow(tw: ToolWindow, zone: StripeZone, index: number) {
    const wasVisible = this.isVisible(tw.id);
    if (wasVisible) this.hide(tw.anchor);
    tw.anchor = zone.startsWith("bottom") ? "bottom" : (zone as Anchor);
    tw.side = zone === "bottom-right" || zone === "right" ? "right" : "left";
    const members = [...this.toolWindows.values()].filter((t) => t !== tw && this.zoneOf(t) === zone).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    members.splice(Math.max(0, Math.min(index, members.length)), 0, tw);
    members.forEach((t, i) => (t.order = (i + 1) * 10));
    this.saveToolLayout();
    if (wasVisible) this.show(tw.id);
    else this.renderChrome();
  }

  isVisible(id: string) {
    const tw = this.toolWindows.get(id);
    return !!tw && this.visible[tw.anchor] === id;
  }

  show(id: string, focus = false) {
    const tw = this.toolWindows.get(id);
    if (!tw) return;
    this.visible[tw.anchor] = id;
    this.renderIsland(tw.anchor);
    this.renderChrome();
    tw.onShow?.();
    if (focus) setTimeout(() => (tw.body.querySelector<HTMLElement>("[tabindex], input, textarea, .tree") ?? tw.body).focus());
    this.persistOpenFiles();
  }

  hide(anchor: Anchor) {
    if (this.visible[anchor]) this.lastVisible[anchor] = this.visible[anchor];
    delete this.visible[anchor];
    this.renderIsland(anchor);
    this.renderChrome();
    this.persistOpenFiles();
  }

  toggle(id: string) {
    const tw = this.toolWindows.get(id);
    if (!tw) return;
    if (this.visible[tw.anchor] === id) this.hide(tw.anchor);
    else this.show(id, true);
  }

  refreshHeader(id: string) {
    const tw = this.toolWindows.get(id);
    if (tw && this.visible[tw.anchor] === id) this.renderIsland(tw.anchor, true);
  }

  setBadge(id: string, on: boolean) {
    const tw = this.toolWindows.get(id);
    if (tw && tw.badge !== on) {
      tw.badge = on;
      this.renderChrome();
    }
  }

  /** Tool windows of a card, in their order (the bottom card holds both former bottom stripes). */
  private zoneMembers(anchor: Anchor) {
    return [...this.toolWindows.values()].filter((t) => t.anchor === anchor).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /** A card: the project header (left card), a row with the segmented switcher and the tool window's
   *  actions, its own tabs (side cards: a second row) and its body. */
  private renderIsland(anchor: Anchor, headerOnly = false) {
    const island = this.islands[anchor];
    const id = this.visible[anchor];
    const tw = id ? this.toolWindows.get(id) : undefined;
    island.classList.toggle("hidden", !tw);
    this.splitters[anchor].classList.toggle("hidden", !tw);
    if (!tw) {
      island.replaceChildren();
      return;
    }
    const members = this.zoneMembers(anchor);
    // The wide bottom card names every segment; a side card names only the active one.
    const seg = h(
      "div.seg",
      { class: anchor === "bottom" ? "seg-labels" : "", role: "tablist", "aria-label": "Janelas de ferramentas" },
      ...members.map((t) =>
        h(
          "button.seg-btn",
          {
            class: t === tw ? "active" : "",
            role: "tab",
            "aria-selected": t === tw ? "true" : "false",
            title: t.title + (displayShortcut(t.shortcut) ? `  ${displayShortcut(t.shortcut)}` : ""),
            onclick: () => t !== tw && this.show(t.id, true),
          },
          twIcon(t.icon),
          h("span.seg-label", null, t.title),
          t.badge ? h("span.badge-dot") : null,
        ),
      ),
    );
    const more = h("button.icon-btn", { title: "Opções", "aria-label": "Opções", onclick: (e: MouseEvent) => this.twMenu(tw, e) }, icon("general/moreVertical"));
    const actions = tw.actions?.() ?? [];
    const head =
      anchor === "bottom"
        ? h("div.card-head", null, h("div.card-row", null, seg, tw.headerTabs ? h("span.card-sep") : null, tw.headerTabs ?? null, h("span.grow"), ...actions, more))
        : h(
            "div.card-head",
            null,
            anchor === "left" ? this.projectHead() : null,
            h("div.card-row", null, seg),
            h("div.tw-header", null, tw.headerTabs ?? null, h("span.grow"), ...actions, more),
          );
    if (headerOnly && island.firstElementChild) island.firstElementChild.replaceWith(head);
    else island.replaceChildren(head, tw.body);
  }

  /** Project identity at the top of the left card: initials, name (projects popup) and the Git branch. */
  private projectHead() {
    const name = h("button.cp-name", { title: P.win(this.root) }, h("span.cp-label", null, this.name), icon("general/chevronDown"));
    name.onclick = () => this.projectPopup(name);
    return h("div.card-project", null, projectBadge(this.name, true), h("div.cp-text", null, name, this.vcsBtn));
  }

  private twMenu(tw: ToolWindow, e: MouseEvent) {
    const move = (z: StripeZone) => () => {
      this.placeToolWindow(tw, z, Number.MAX_SAFE_INTEGER);
      this.show(tw.id);
    };
    contextMenu(e.clientX, e.clientY, [
      { label: "Mover para o painel esquerdo", icon: "panelLeft", disabled: tw.anchor === "left", action: move("left") },
      { label: "Mover para o painel inferior", icon: "panelBottom", disabled: tw.anchor === "bottom", action: move(tw.side === "right" ? "bottom-right" : "bottom-left") },
      { label: "Mover para o painel direito", icon: "panelRight", disabled: tw.anchor === "right", action: move("right") },
      { separator: true },
      { label: "Restaurar layout padrão", action: () => this.resetToolLayout() },
      { separator: true },
      { label: "Ocultar", shortcut: "Shift+Esc", action: () => this.hide(tw.anchor) },
    ]);
  }

  resetToolLayout() {
    try {
      localStorage.removeItem(LAYOUT_KEY);
    } catch {
      /* ignore */
    }
    for (const a of ["left", "right", "bottom"] as Anchor[]) if (this.visible[a]) this.hide(a);
    for (const [id, p] of this.defaultPlacement) {
      const tw = this.toolWindows.get(id);
      if (tw) Object.assign(tw, { anchor: p.anchor, side: p.side, order: p.order });
    }
    this.renderChrome();
    this.show("project");
  }

  /** Shows the last tool window of a side, or hides the side (VS Code: Cmd+B, Cmd+J, Cmd+Alt+B). */
  toggleSide(anchor: Anchor, fallback: string) {
    if (this.visible[anchor]) return this.hide(anchor);
    const id = this.lastVisible[anchor];
    const tw = id ? this.toolWindows.get(id) : undefined;
    const first = [...this.toolWindows.values()].filter((t) => t.anchor === anchor).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
    const pick = tw && tw.anchor === anchor ? tw.id : this.toolWindows.get(fallback)?.anchor === anchor ? fallback : first?.id;
    if (pick) this.show(pick, true);
  }

  /** Hides every tool window (VS Code: Cmd+K Z, JetBrains: Ctrl+Shift+F12). */
  hideAll() {
    for (const a of ["left", "right", "bottom"] as Anchor[]) if (this.visible[a]) this.hide(a);
    this.editors.active()?.focus();
  }

  /** Title bar layout toggles (state + news dot) and the headers of the visible cards. */
  private renderChrome() {
    for (const a of ["left", "bottom", "right"] as Anchor[]) {
      const b = this.layoutBtns[a];
      const members = this.zoneMembers(a);
      b.classList.toggle("on", !!this.visible[a]);
      b.classList.toggle("hidden", !members.length);
      b.setAttribute("aria-pressed", this.visible[a] ? "true" : "false");
      b.querySelector(".badge-dot")?.remove();
      if (!this.visible[a] && members.some((t) => t.badge)) b.append(h("span.badge-dot"));
      if (this.visible[a]) this.renderIsland(a, true);
    }
    this.toolbar.classList.toggle("left-hidden", !this.visible.left);
  }

  private initSplitters() {
    const drag = (handle: HTMLElement, target: HTMLElement, axis: "x" | "y", invert: boolean, min: number) => {
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const start = axis === "x" ? e.clientX : e.clientY;
        const s0 = axis === "x" ? target.offsetWidth : target.offsetHeight;
        document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
        const mv = (ev: MouseEvent) => {
          const d = (axis === "x" ? ev.clientX : ev.clientY) - start;
          const v = Math.max(min, s0 + (invert ? -d : d));
          target.style[axis === "x" ? "width" : "height"] = v + "px";
        };
        const up = () => {
          document.removeEventListener("mousemove", mv);
          document.removeEventListener("mouseup", up);
          document.body.classList.remove("resizing-x", "resizing-y");
          window.dispatchEvent(new Event("resize"));
        };
        document.addEventListener("mousemove", mv);
        document.addEventListener("mouseup", up);
      });
    };
    drag(this.splitters.left, this.islands.left, "x", false, 180);
    drag(this.splitters.right, this.islands.right, "x", true, 200);
    drag(this.splitters.bottom, this.islands.bottom, "y", true, 100);
  }

  // ---------------- main toolbar ----------------

  renderToolbar() {
    const win = getCurrentWindow();
    // The Rits mark opens the main menu (on macOS it sits right after the traffic lights).
    const logo = h("button.tb-logo", { title: "Menu principal (Alt+\\)", "aria-label": "Menu principal" }, icon("logoAccent"));
    logo.onclick = () => this.mainMenu(logo);
    // Shown only while the left card is hidden (the card carries the project and branch otherwise).
    const projBtn = h("button.tb-btn.tb-project", { title: P.win(this.root) }, projectBadge(this.name), h("span.tb-label", null, this.name), icon("general/chevronDown"));
    projBtn.onclick = () => this.projectPopup(projBtn);
    this.vcsBtn.onclick = () => this.git.branchesPopup(this.vcsBtn);
    this.renderVcsWidget();
    const newTab = h("button.tb-btn.tb-newtab", { title: "Novo…", "aria-label": "Novo" }, icon("general/add"));
    newTab.onclick = () => this.newTabMenu(newTab);
    const searchBtn = h("button.tb-btn", { title: "Buscar em tudo (Shift duplo)", "aria-label": "Buscar em tudo", onclick: () => searchEverywhere(this) }, icon("general/search"));
    const settingsBtn = h("button.tb-btn", { title: "Configurações (Ctrl+Alt+S)", "aria-label": "Configurações", onclick: () => openSettings(this) }, icon("general/settings"));
    const maxIcon = h("span");
    const updateMax = async () => maxIcon.replaceChildren(icon((await win.isMaximized().catch(() => false)) ? "restoreWin" : "maximize"));
    updateMax();
    win.onResized(() => updateMax()).catch(() => {});
    const drag = h("div.tb-drag", { "data-tauri-drag-region": true });
    drag.addEventListener("dblclick", () => win.toggleMaximize());
    this.toolbar.replaceChildren(
      logo,
      projBtn,
      this.tabs.bar,
      newTab,
      drag,
      this.runWidget,
      h("span.tb-sep"),
      this.layoutBtns.left,
      this.layoutBtns.bottom,
      this.layoutBtns.right,
      h("span.tb-sep"),
      searchBtn,
      settingsBtn,
      h(
        "div.win-controls",
        null,
        h("button.win-btn", { title: "Minimizar", "aria-label": "Minimizar", onclick: () => win.minimize() }, icon("minimize")),
        h("button.win-btn", { title: "Maximizar", "aria-label": "Maximizar", onclick: () => win.toggleMaximize() }, maxIcon),
        h("button.win-btn.close", { title: "Fechar", "aria-label": "Fechar", onclick: () => this.closeWindow() }, icon("closeWin")),
      ),
    );
    // The empty parts of the bar and of the tab strip move the window (frameless on Windows).
    this.toolbar.addEventListener("mousedown", (e) => {
      if (e.target === this.toolbar && e.button === 0) win.startDragging();
    });
    this.tabs.bar.addEventListener("mousedown", (e) => {
      if (e.target === this.tabs.bar && e.button === 0) win.startDragging();
    });
    this.tabs.bar.addEventListener("dblclick", (e) => e.target === this.tabs.bar && win.toggleMaximize());
    this.renderChrome();
  }

  /** The title bar "+": what a new tab can be. */
  private newTabMenu(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, [
      { label: "Novo arquivo…", icon: "actions/addFile", shortcut: "Alt+Insert", action: () => this.projectView.newFileAt(null) },
      { label: "Terminal", icon: "toolwindows/terminal", shortcut: "Alt+F12", action: () => this.terminals.newTab() },
      { label: "Nova conexão de banco…", icon: "database", action: () => this.db.newConnection() },
      { separator: true },
      { label: "Buscar em tudo", icon: "general/search", shortcut: "Shift Shift", action: () => searchEverywhere(this) },
      { label: "Arquivos recentes", icon: "general/history", shortcut: "Ctrl+E", action: () => recentFiles(this) },
    ]);
  }

  renderVcsWidget() {
    const b = this.git?.branch;
    this.vcsBtn.replaceChildren(icon("branch"), h("span.cp-branch-label", null, this.git?.isRepo === false ? "Controle de versão" : b ?? "…"), icon("general/chevronDown"));
    this.vcsBtn.title = this.git?.isRepo === false ? "Habilitar controle de versão" : `Branch Git: ${b ?? ""}`;
    if (this.editors && !this.tabs.active) this.renderHome();
  }

  // ---------------- project home ("Início") ----------------

  /** Looks at the project root for what the home page offers to run (compose, Dockerfile, tests, Terraform…). */
  private async detectProject() {
    const entries = await host.list(this.root).catch(() => []);
    const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
    const pick = (list: MenuItem[], prefix: string) => list.find((a) => a.label?.startsWith(prefix))?.action;
    const found: Found[] = [];
    const compose = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"].map((n) => byName.get(n)).find((e) => e && !e.isDir);
    if (compose) {
      const up = pick(infraActions(this, compose.path, "compose"), "Subir (up");
      found.push({ name: compose.name, path: compose.path, dir: false, sub: "docker compose up -d", icon: fileIcon(compose.name), action: up ? { label: "Subir serviços", run: up } : undefined });
    }
    const dockerfile = byName.get("dockerfile");
    if (dockerfile && !dockerfile.isDir) {
      const build = pick(infraActions(this, dockerfile.path, "dockerfile"), "Build da imagem");
      found.push({ name: dockerfile.name, path: dockerfile.path, dir: false, sub: "docker build", icon: fileIcon(dockerfile.name), action: build ? { label: "Gerar imagem", run: build } : undefined });
    }
    const tf = entries.find((e) => !e.isDir && e.name.toLowerCase().endsWith(".tf"));
    if (tf) {
      const plan = pick(infraActions(this, tf.path, "terraform"), "plan");
      found.push({ name: tf.name, path: tf.path, dir: false, sub: "terraform plan", icon: fileIcon(tf.name), action: plan ? { label: "Planejar", run: plan } : undefined });
    }
    const tests = byName.get("tests") ?? byName.get("test");
    const goMod = byName.get("go.mod");
    if (tests?.isDir) {
      const go = (await host.list(tests.path).catch(() => [])).some((e) => e.name.endsWith(".go"));
      found.push({ name: tests.name, path: tests.path, dir: true, sub: go ? "go test" : "pytest", icon: icon("nodes/testRoot"), action: { label: "Rodar testes", run: () => this.runner.runTestsIn(tests.path) } });
    }
    if (goMod && !goMod.isDir) found.push({ name: "go.mod", path: goMod.path, dir: false, sub: "Módulo Go", icon: fileIcon("go.mod") });
    const pyproject = byName.get("pyproject.toml");
    if (pyproject && !pyproject.isDir) found.push({ name: "pyproject.toml", path: pyproject.path, dir: false, sub: "Projeto Python", icon: fileIcon("pyproject.toml") });
    this.found = found;
    if (!this.tabs.active) this.renderHome();
  }

  /** The project home page: the project at a glance, shortcuts, what the project has, Run, and the command bar. */
  renderHome() {
    const key = (jb: string) => h("kbd.kbd", null, displayShortcut(jb) || jb);
    const row = (ic: string, label: string, jb: string, run: () => void) =>
      h("button.home-row", { onclick: run }, icon(ic), h("span.home-row-label", null, label), key(jb));
    const chip = (ic: HTMLElement, text: string, title?: string) => h("span.home-chip", { title: title ?? text }, ic, h("span", null, text));
    const branch = this.git?.isRepo === false ? "sem Git" : this.git?.branch ?? "…";
    const home = this.env?.home ? P.win(this.root).replace(P.win(this.env.home), "~") : P.win(this.root);
    const start = h(
      "section.home-block",
      null,
      h("h2.home-block-title", null, "Comece por aqui"),
      row("general/search", "Buscar em tudo", "Shift duplo", () => searchEverywhere(this)),
      row("fileTypes/text", "Ir para arquivo", "Ctrl+Shift+N", () => searchEverywhere(this, "files")),
      row("general/history", "Arquivos recentes", "Ctrl+E", () => recentFiles(this)),
      row("toolwindows/terminal", "Abrir terminal", "Alt+F12", () => this.show("terminal", true)),
    );
    const project = h(
      "section.home-block",
      null,
      h("h2.home-block-title", null, "No projeto"),
      ...(this.found.length
        ? this.found.map((f) =>
            h(
              "div.home-found",
              null,
              f.icon,
              h("button.home-found-text", { title: f.dir ? `Mostrar ${f.name} no projeto` : `Abrir ${f.name}`, onclick: () => (f.dir ? this.projectView.reveal(f.path) : this.editors.openFile(f.path)) }, h("span", null, f.name), h("span.home-found-sub", null, f.sub)),
              f.action ? h("button.btn.small", { onclick: f.action.run }, f.action.label) : null,
            ),
          )
        : [h("p.home-empty", null, "Compose, Dockerfile, Terraform e pastas de testes aparecem aqui quando estão na raiz do projeto.")]),
    );
    const cfg = this.runner?.selected();
    const run = h(
      "section.home-block.home-run",
      null,
      icon("toolwindows/run"),
      h("div.home-run-text", null, h("span.home-run-title", null, "Executar"), h("span.home-run-sub", null, cfg ? cfg.name : "Nenhuma configuração ainda. Abra um arquivo Python ou Go, ou crie uma.")),
      h("button.btn", { onclick: () => this.runner.editConfigs() }, "Configurações"),
      h("button.btn", { onclick: () => this.runner.runSelected(true) }, icon("run/debug"), "Depurar"),
      h("button.btn.primary", { onclick: () => this.runner.runSelected(false) }, "Executar", h("span.btn-key", null, displayShortcut("Shift+F10") || "Shift+F10")),
    );
    this.home.replaceChildren(
      h(
        "div.home-scroll",
        null,
        h(
          "div.home-inner",
          null,
          h(
            "header.home-head",
            null,
            h("h1.home-title", null, this.name),
            h(
              "div.home-chips",
              null,
              chip(icon("branch"), branch),
              this.python ? chip(icon("python/pythonClosed"), this.python.label) : null,
              chip(icon("nodes/folder"), home, P.win(this.root)),
            ),
          ),
          h("div.home-grid", null, start, project, run),
        ),
      ),
      (this.cmdBar ??= this.commandBar()),
    );
    const cmdChip = (ic: string, text: string) => h("span.cmd-chip", null, icon(ic), text);
    this.cmdChips.replaceChildren(cmdChip("nodes/folder", this.name), cmdChip("branch", branch), this.python ? cmdChip("python/pythonClosed", this.python.label) : "");
  }

  /** Warp-style input at the bottom of the home page: search everything, or run a command in the terminal. */
  private commandBar() {
    let mode: "search" | "command" = "search";
    const input = h("input.cmd-input", { spellcheck: false, "aria-label": "Buscar ou executar comando" }) as HTMLInputElement;
    const searchBtn = h("button.cmd-mode", { type: "button", onclick: () => setMode("search") }, "Buscar");
    const cmdBtn = h("button.cmd-mode", { type: "button", onclick: () => setMode("command") }, "Comando");
    const setMode = (m: typeof mode) => {
      mode = m;
      searchBtn.classList.toggle("on", m === "search");
      cmdBtn.classList.toggle("on", m === "command");
      searchBtn.setAttribute("aria-pressed", String(m === "search"));
      cmdBtn.setAttribute("aria-pressed", String(m === "command"));
      input.placeholder = m === "search" ? "Buscar arquivos, símbolos e ações" : `Comando no terminal, em ${this.name}`;
      input.focus();
    };
    setMode("search");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setMode(mode === "search" ? "command" : "search");
      } else if (e.key === "Enter") {
        const q = input.value.trim();
        if (mode === "search") searchEverywhere(this, "all", q);
        else if (q) this.terminals.newTab(this.root, q);
        input.value = "";
      }
    });
    return h(
      "div.cmdbar",
      null,
      this.cmdChips,
      h(
        "div.cmd-line",
        null,
        h("span.cmd-prompt", { "aria-hidden": "true" }, "›"),
        input,
        h("span.cmd-modes", { role: "group", "aria-label": "Modo (Tab alterna)" }, searchBtn, cmdBtn),
        h("kbd.kbd", null, "Enter ↵"),
      ),
    );
  }

  async projectPopup(anchor: HTMLElement) {
    const recent = await recentProjects();
    const items: PopupItem[] = recent.map((r, i) => ({
      section: i === 0 ? "Projetos recentes" : undefined,
      label: r.name,
      sub: P.win(r.path).replace(P.win(this.env.home), "~"),
      icon: projectBadge(r.name),
      right: r.branch,
      current: P.same(r.path, this.root),
      action: () => (P.same(r.path, this.root) ? undefined : this.openProject(r.path)),
    }));
    items.push(
      { label: "Novo projeto…", icon: "general/add", separatorBefore: true, action: () => openNewProjectDialog(this) },
      { label: "Abrir…", icon: "general/open", action: () => this.openFolder() },
      { label: "Clonar repositório…", icon: "vcs/fetch", action: () => openCloneDialog(this) },
      { label: "Fechar projeto", icon: "general/closeSmall", action: () => this.closeProject() },
    );
    anchor.classList.add("open", "popup-anchor-open");
    const pop = popupList(anchor, items, { width: 420, search: true, placeholder: "Buscar projetos" });
    const obs = new MutationObserver(() => {
      if (!pop.isConnected) {
        anchor.classList.remove("open", "popup-anchor-open");
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true });
  }

  async openFolder() {
    const dir = await openDialog({ directory: true, title: "Abrir projeto" });
    if (typeof dir === "string") this.openProject(dir);
  }

  /** Opens another project, asking (like JetBrains IDEs) whether to reuse this window. */
  async openProject(path: string, forceThisWindow = false) {
    let pref: string | null = null;
    try {
      pref = localStorage.getItem("openProjectIn");
    } catch {
      /* ignore */
    }
    const go = async (where: "this" | "new", remember: boolean) => {
      if (remember)
        try {
          localStorage.setItem("openProjectIn", where);
        } catch {
          /* ignore */
        }
      if (where === "new") return openProjectWindow(path);
      if (!(await this.prepareClose())) return;
      location.href = `index.html?project=${encodeURIComponent(P.norm(path))}`;
    };
    if (forceThisWindow) return go("this", false);
    if (pref === "this" || pref === "new") return go(pref, false);
    const m = modal("Abrir projeto", { width: 460 });
    const remember = h("input", { type: "checkbox" }) as HTMLInputElement;
    m.body.append(
      h("p", { style: "margin:0 0 12px" }, `Abrir "${P.base(path)}" nesta janela ou em uma nova janela?`),
      h("label.check", null, remember, "Lembrar e não perguntar novamente"),
    );
    m.footer.append(
      button("Cancelar", () => m.close()),
      button("Nova janela", () => (m.close(), go("new", remember.checked))),
      button("Esta janela", () => (m.close(), go("this", remember.checked)), "primary"),
    );
  }

  async closeProject() {
    if (!(await this.prepareClose())) return;
    location.href = "index.html?welcome=1";
  }

  async prepareClose(): Promise<boolean> {
    await this.editors.saveAll();
    this.persistOpenFiles();
    await this.runner.stopAll();
    await this.debugger.stop();
    this.terminals.closeAll();
    await this.lsp.stopAll();
    await host.unwatch(this.root).catch(() => {});
    return true;
  }

  private async closeWindow() {
    await this.prepareClose();
    getCurrentWindow().close();
  }

  private mainMenu(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    const ed = () => this.editors.active();
    const menus: MenuItem[] = [
      {
        label: "Arquivo",
        submenu: [
          { label: "Novo projeto…", icon: "general/add", action: () => openNewProjectDialog(this) },
          { label: "Novo arquivo…", icon: "actions/addFile", shortcut: "Alt+Insert", action: () => this.projectView.newFileAt(null) },
          { label: "Abrir…", icon: "general/open", action: () => this.openFolder() },
          { label: "Clonar repositório…", icon: "vcs/fetch", action: () => openCloneDialog(this) },
          { label: "Projetos recentes", submenu: [] as MenuItem[], disabled: true },
          { separator: true },
          { label: "Salvar tudo", icon: "general/save", shortcut: "Ctrl+S", action: () => this.editors.saveAll() },
          { label: "Recarregar do disco", icon: "general/refresh", action: () => ed()?.reload(true) },
          { separator: true },
          { label: "Configurações…", icon: "general/settings", shortcut: "Ctrl+Alt+S", action: () => openSettings(this) },
          { separator: true },
          { label: "Fechar projeto", action: () => this.closeProject() },
          { label: "Sair", action: () => this.closeWindow() },
        ],
      },
      {
        label: "Editar",
        submenu: [
          { label: "Desfazer", icon: "general/undo", shortcut: "Ctrl+Z", action: () => ed()?.command("undo") },
          { label: "Refazer", icon: "general/redo", shortcut: "Ctrl+Shift+Z", action: () => ed()?.command("redo") },
          { separator: true },
          { label: "Localizar…", icon: "general/search", shortcut: "Ctrl+F", action: () => ed()?.command("find") },
          { label: "Substituir…", icon: "actions/replace", shortcut: "Ctrl+R", action: () => ed()?.command("replace") },
          { label: "Localizar nos arquivos…", icon: "toolwindows/find", shortcut: "Ctrl+Shift+F", action: () => findInFiles(this) },
          { separator: true },
          { label: "Duplicar linha", shortcut: "Ctrl+D", action: () => ed()?.command("duplicate") },
          { label: "Excluir linha", shortcut: "Ctrl+Y", action: () => ed()?.command("deleteLine") },
          { label: "Comentar linha", shortcut: "Ctrl+/", action: () => ed()?.command("comment") },
        ],
      },
      {
        label: "Exibir",
        submenu: [
          {
            label: "Janelas de ferramentas",
            submenu: [...this.toolWindows.values()].map((t) => ({ label: t.title, shortcut: t.shortcut, action: () => this.show(t.id, true) })),
          },
          { label: "Estrutura do arquivo", shortcut: "Ctrl+F12", action: () => fileStructurePopup(this) },
          { label: "Arquivos recentes", shortcut: "Ctrl+E", action: () => recentFiles(this) },
          { separator: true },
          { label: document.documentElement.dataset.theme === "dark" ? "Tema Rits Claro" : "Tema Rits Escuro", action: () => (window as any).__toggleTheme?.() },
        ],
      },
      {
        label: "Navegar",
        submenu: [
          { label: "Buscar em tudo", shortcut: "Shift Shift", action: () => searchEverywhere(this) },
          { label: "Arquivo…", shortcut: "Ctrl+Shift+N", action: () => searchEverywhere(this, "files") },
          { label: "Símbolo…", shortcut: "Ctrl+Alt+Shift+N", action: () => searchEverywhere(this, "symbols") },
          { label: "Linha:coluna…", shortcut: "Ctrl+G", action: () => gotoLine(this) },
          { separator: true },
          { label: "Ir para declaração", shortcut: "Ctrl+B", action: () => ed()?.command("definition") },
          { label: "Encontrar usos", shortcut: "Alt+F7", action: () => ed()?.command("usages") },
        ],
      },
      {
        label: "Código",
        submenu: [
          { label: "Reformatar código", icon: "actions/reformatCode", shortcut: "Ctrl+Alt+L", action: () => ed()?.format() },
          { label: "Otimizar imports", shortcut: "Ctrl+Alt+O", action: () => ed()?.organizeImports() },
          { label: "Mostrar ações de contexto", icon: "actions/realIntentionBulb", shortcut: "Alt+Enter", action: () => ed()?.command("quickfix") },
          { label: "Completar código", shortcut: "Ctrl+Espaço", action: () => ed()?.command("complete") },
          { label: "Informações de parâmetros", shortcut: "Ctrl+P", action: () => ed()?.command("signature") },
          { label: "Documentação rápida", shortcut: "Ctrl+Q", action: () => ed()?.command("hover") },
          { separator: true },
          { label: "Inspecionar código…", icon: "general/inspections", action: () => this.problems.inspectProject() },
        ],
      },
      { label: "Refatorar", submenu: [{ label: "Renomear…", shortcut: "Shift+F6", action: () => ed()?.command("rename") }] },
      {
        label: "Executar",
        submenu: [
          { label: "Executar", icon: "run/run", shortcut: "Shift+F10", action: () => this.runner.runSelected(false) },
          { label: "Depurar", icon: "run/debug", shortcut: "Shift+F9", action: () => this.runner.runSelected(true) },
          { label: "Executar arquivo atual", shortcut: "Ctrl+Shift+F10", action: () => this.runner.runCurrentFile(false) },
          { label: "Parar", icon: "run/stop", shortcut: "Ctrl+F2", action: () => this.runner.stopAll() },
          { separator: true },
          { label: "Alternar breakpoint", icon: "breakpoints/breakpoint", shortcut: "Ctrl+F8", action: () => ed()?.toggleBreakpointAtCursor() },
          { label: "Editar configurações…", action: () => this.runner.editConfigs() },
        ],
      },
      {
        label: "Ferramentas",
        submenu: [
          { label: "Terminal", icon: "toolwindows/terminal", shortcut: "Alt+F12", action: () => this.show("terminal", true) },
          { label: "Database", icon: "database", action: () => this.show("database", true) },
          { label: "Backup de banco…", icon: "backup", action: () => this.db.backup() },
          { label: "Restaurar banco…", icon: "restore", action: () => this.db.restore() },
          { separator: true },
          { label: "Plugins…", icon: "plugins", action: () => openSettings(this, "plugins") },
          { label: "Interpretador Python…", icon: "python/pythonClosed", action: () => openSettings(this, "python") },
        ],
      },
      {
        label: "Git",
        submenu: [
          { label: "Commit…", icon: "vcs/commit", shortcut: "Ctrl+K", action: () => this.show("commit", true) },
          { label: "Push…", icon: "vcs/push", shortcut: "Ctrl+Shift+K", action: () => this.git.push() },
          { label: "Atualizar projeto (pull)", icon: "vcs/update", shortcut: "Ctrl+T", action: () => this.git.pull() },
          { label: "Fetch", icon: "vcs/fetch", action: () => this.git.fetch() },
          { separator: true },
          { label: "Branches…", icon: "branch", action: () => this.git.branchesPopup(this.vcsBtn) },
          { label: "Novo branch…", action: () => this.git.newBranch() },
          { label: "Log", icon: "general/history", shortcut: "Alt+9", action: () => this.show("git", true) },
          { separator: true },
          { label: "Clonar…", action: () => openCloneDialog(this) },
          { label: "Inicializar repositório", action: () => this.git.init() },
        ],
      },
      { label: "Ajuda", submenu: [{ label: "Atalhos de teclado", icon: "general/keyboard", action: () => openSettings(this, "keymap") }, { label: "Log dos servidores de linguagem", action: () => this.showLspLog() }, { label: "Sobre o Rits", action: () => openSettings(this, "about") }] },
    ];
    contextMenu(r.left, r.bottom + 2, menus);
  }

  showLspLog() {
    const m = modal("Log dos servidores de linguagem", { width: 860 });
    m.body.append(h("pre.viewer", { style: "white-space:pre-wrap;height:460px;overflow:auto;margin:0" }, this.lspLog.join("\n") || "(vazio)"));
  }

  // ---------------- status bar ----------------

  setProgress(key: string, text: string | null) {
    if (text) this.progressByKey.set(key, text);
    else this.progressByKey.delete(key);
    const first = [...this.progressByKey.values()][0];
    this.statusProgress.classList.toggle("hidden", !first);
    if (first) this.statusProgress.replaceChildren(h("span", null, first), h("span.sb-bar"));
  }

  renderStatus() {
    const ed = this.editors?.active();
    const crumbs: HTMLElement[] = [h("span.sb-crumb", { onclick: () => this.show("project", true) }, projectBadge(this.name), this.name)];
    const activePath = ed?.path ?? null;
    if (activePath) {
      const parts = P.rel(this.root, activePath).split("/");
      let acc = this.root;
      parts.forEach((part, i) => {
        acc = P.join(acc, part);
        const p = acc;
        crumbs.push(h("span.sb-chev", null, "›"));
        crumbs.push(
          h(
            "span.sb-crumb",
            { onclick: () => (i === parts.length - 1 ? fileStructurePopup(this) : this.projectView.reveal(p)) },
            i === parts.length - 1 ? icon(ed!.iconName) : icon("nodes/folder"),
            part,
          ),
        );
      });
    } else {
      const t = this.tabs.active;
      if (t) crumbs.push(h("span.sb-chev", null, "›"), h("span.sb-crumb", null, icon(t.icon), t.title));
    }
    this.statusLeft.replaceChildren(...crumbs);

    const widgets: HTMLElement[] = [];
    if (ed) {
      const pos = ed.cursorInfo();
      widgets.push(
        h("button.sb-widget", { title: "Ir para linha (Ctrl+G)", onclick: () => gotoLine(this) }, `${pos.line}:${pos.col}${pos.sel ? ` (${pos.sel} chars)` : ""}`),
        h("button.sb-widget", { title: "Separador de linha" }, ed.crlf ? "CRLF" : "LF"),
        h("button.sb-widget", { title: "Codificação" }, ed.encoding),
        h("button.sb-widget", { title: "Indentação" }, ed.lang.indent === "\t" ? "Tab" : `${ed.lang.indent.length} espaços`),
      );
      const ll = ed.lspLang;
      if (ll) {
        const st = this.lsp.status(ll);
        widgets.push(
          h(
            "button.sb-widget",
            { title: `Servidor de linguagem ${LSP_NAME[ll]}: ${st === "ready" ? "ativo" : st === "starting" ? "iniciando" : "desligado"}`, onclick: (e: MouseEvent) => this.lspMenu(ll, e) },
            icon(st === "ready" ? "status/success" : st === "starting" ? "general/refresh" : "status/warningOutline", st === "starting" ? "spin" : ""),
            LSP_NAME[ll],
          ),
        );
      }
      if (ed.lspLang === "python" || P.ext(ed.path) === "py") {
        widgets.push(h("button.sb-widget", { title: "Interpretador Python", onclick: () => openSettings(this, "python") }, icon("python/pythonClosed"), this.python?.label ?? "<sem interpretador>"));
      } else if (P.ext(ed.path) === "go" || P.base(ed.path) === "go.mod") {
        const gv = h("button.sb-widget", { title: "Go SDK", onclick: () => openSettings(this, "go") }, icon("goSdk"), "Go");
        findGo().then((g) => (gv.lastChild!.textContent = g ? `Go ${g.version}` : "<sem Go SDK>"));
        widgets.push(gv);
      }
      if (ed.readOnly) widgets.push(h("button.sb-widget", { title: "Somente leitura" }, icon("nodes/locked")));
    }
    this.statusRight.replaceChildren(...widgets);
  }

  private lspMenu(lang: LspLang, e: MouseEvent) {
    contextMenu(e.clientX, e.clientY - 120, [
      { label: "Reiniciar servidor", icon: "general/refresh", action: () => this.lsp.restart(lang).then(() => this.editors.reattachLsp(lang)) },
      { label: "Ver log", action: () => this.showLspLog() },
      { label: "Plugins…", icon: "plugins", action: () => openSettings(this, "plugins") },
    ]);
  }

  private missingShown = new Set<string>();
  private pluginMissing(lang: LspLang) {
    if (this.missingShown.has(lang)) return;
    this.missingShown.add(lang);
    const infra = lang === "terraform" || lang === "dockerfile" || lang === "yaml";
    const name = lang === "python" ? "Python (basedpyright)" : lang === "go" ? "Go (gopls)" : `Infraestrutura (${LSP_NAME[lang]})`;
    import("../ui").then(({ notify }) =>
      notify(`Plugin ${name} não instalado`, "Autocomplete, navegação e análise de código precisam do servidor de linguagem.", "info", [
        { label: "Instalar agora", run: () => openSettings(this, "plugins", infra ? "infra" : lang) },
      ], 15000),
    );
  }

  async setPython(p: PyInterp | null) {
    this.python = p;
    setCurrentPython(p);
    this.settings.pythonInterpreter = p?.path;
    this.saveSettings();
    this.renderStatus();
    await this.lsp.restart("python").catch(() => null);
    this.editors.reattachLsp("python");
  }

  // ---------------- keyboard ----------------

  private chordUntil = 0;

  /** VS Code keymap. "pass" lets the key reach the editor (its own VS Code bindings) without JetBrains handling. */
  private vscodeKey(e: KeyboardEvent, kl: string, run: (fn: () => void) => void): "handled" | "pass" | false {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const ctl = e.ctrlKey;
    const sh = e.shiftKey;
    const alt = e.altKey;
    const k = e.key;
    const ed = () => this.editors.active();
    if (["Meta", "Control", "Shift", "Alt"].includes(k)) return false;
    // second key of a Mod+K chord
    if (Date.now() < this.chordUntil) {
      this.chordUntil = 0;
      if (kl === "z") return run(() => this.hideAll()), "handled";
      if (kl === "s" && mod) return run(() => openSettings(this, "keymap")), "handled";
      if (kl === "i" && mod) return run(() => ed()?.command("hover")), "handled";
      if (kl === "w" && mod) return run(() => [...this.tabs.tabs].forEach((t) => this.tabs.close(t))), "handled";
      return run(() => {}), "handled";
    }
    if (mod && !sh && !alt && kl === "k") {
      e.preventDefault();
      e.stopPropagation();
      this.chordUntil = Date.now() + 1500;
      return "handled";
    }
    if ((mod && sh && kl === "p") || k === "F1") return run(() => searchEverywhere(this, "actions")), "handled";
    if (mod && !sh && !alt && kl === "p") return run(() => searchEverywhere(this, "files")), "handled";
    if (mod && !sh && !alt && kl === "t") return run(() => searchEverywhere(this, "symbols")), "handled";
    if (mod && sh && kl === "o") return run(() => fileStructurePopup(this)), "handled";
    if (mod && !sh && !alt && kl === "b") return run(() => this.toggleSide("left", "project")), "handled";
    if (mod && alt && !sh && kl === "b") return run(() => this.toggleSide("right", "database")), "handled";
    if (mod && !sh && !alt && kl === "j") return run(() => this.toggleSide("bottom", "terminal")), "handled";
    if (ctl && e.code === "Backquote") {
      if (sh) return run(() => (this.show("terminal"), this.terminals.newTab())), "handled";
      return run(() => this.toggle("terminal")), "handled";
    }
    if (mod && sh && kl === "e") return run(() => this.toggle("project")), "handled";
    if (mod && sh && kl === "d") return run(() => this.toggle("debug")), "handled";
    if (mod && sh && kl === "m") return run(() => this.toggle("problems")), "handled";
    if (mod && sh && kl === "u") return run(() => this.toggle("run")), "handled";
    if (mod && sh && kl === "x") return run(() => openSettings(this, "plugins")), "handled";
    if (ctl && sh && kl === "g") return run(() => this.toggle("commit")), "handled";
    if (mod && !sh && (e.code === "Comma" || k === ",")) return run(() => openSettings(this)), "handled";
    if (mod && !sh && !alt && kl === "w") return run(() => this.tabs.active && this.tabs.close(this.tabs.active)), "handled";
    if (mod && !sh && !alt && e.code === "Digit1") return run(() => ed()?.focus()), "handled";
    if (k === "F5" && !mod && !sh && !ctl) return run(() => (this.debugger.active ? this.debugger.resume() : this.runner.runSelected(true))), "handled";
    if (k === "F5" && ctl && !sh) return run(() => this.runner.runSelected(false)), "handled";
    if (k === "F5" && sh) return run(() => this.runner.stopAll()), "handled";
    if (k === "F9" && !sh && !mod) return run(() => ed()?.toggleBreakpointAtCursor()), "handled";
    if (this.debugger.active && !mod && !ctl) {
      if (k === "F10" && !sh) return run(() => this.debugger.stepOver()), "handled";
      if (k === "F11" && !sh) return run(() => this.debugger.stepInto()), "handled";
      if (k === "F11" && sh) return run(() => this.debugger.stepOut()), "handled";
    }
    // VS Code editor keys that JetBrains maps globally (push, pull, commit, duplicate...)
    if (mod && ((sh && kl === "k") || (!sh && ["d", "y"].includes(kl)))) return "pass";
    if (IS_MAC && e.metaKey && kl === "g") return "pass";
    return false;
  }

  private installKeys() {
    let lastShift = 0;
    document.addEventListener(
      "keydown",
      (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        const k = e.key;
        // Physical key: Option on macOS changes e.key ("⌥⌘S" gives "ß"), so prefer e.code for letters.
        const kl = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : k.toLowerCase();
        if (k === "Shift" && !e.repeat && !ctrl && !e.altKey) {
          const now = Date.now();
          if (now - lastShift < 350) {
            lastShift = 0;
            if (!document.querySelector(".se-popup")) searchEverywhere(this);
          } else lastShift = now;
          return;
        }
        const run = (fn: () => void) => {
          e.preventDefault();
          e.stopPropagation();
          closeMenus();
          fn();
        };
        if (keymapId() === "vscode") {
          const r = this.vscodeKey(e, kl, run);
          if (r === "handled" || r === "pass") return;
        } else if (ctrl && e.shiftKey && k === "F12") return run(() => this.hideAll());
        if (ctrl && e.shiftKey && kl === "n") run(() => searchEverywhere(this, "files"));
        else if (ctrl && e.altKey && e.shiftKey && kl === "n") run(() => searchEverywhere(this, "symbols"));
        else if (ctrl && !e.shiftKey && kl === "n" && !e.altKey) run(() => searchEverywhere(this, "symbols"));
        else if (ctrl && e.shiftKey && kl === "a") run(() => searchEverywhere(this, "actions"));
        else if (ctrl && e.shiftKey && kl === "f") run(() => findInFiles(this));
        else if (ctrl && !e.shiftKey && kl === "e") run(() => recentFiles(this));
        else if (ctrl && kl === "g" && !e.shiftKey) run(() => gotoLine(this));
        else if (ctrl && k === "F12") run(() => fileStructurePopup(this));
        else if (ctrl && k === "F4") run(() => this.tabs.active && this.tabs.close(this.tabs.active));
        else if (ctrl && k === "Tab") run(() => this.tabs.cycle(e.shiftKey ? -1 : 1));
        else if (ctrl && e.altKey && kl === "s") run(() => openSettings(this));
        else if (ctrl && !e.shiftKey && kl === "s" && !e.altKey) run(() => this.editors.saveAll());
        else if (e.altKey && k === "F12") run(() => this.toggle("terminal"));
        else if (e.altKey && !ctrl && /^Digit[0-9]$/.test(e.code)) {
          const map: Record<string, string> = { "1": "project", "2": "database", "3": "find", "4": "run", "5": "debug", "6": "problems", "7": "structure", "8": "services", "9": "git", "0": "commit" };
          const d = e.code.slice(5);
          if (map[d]) run(() => this.toggle(map[d]));
        } else if (ctrl && !e.shiftKey && kl === "k") run(() => this.show("commit", true));
        else if (ctrl && e.shiftKey && kl === "k") run(() => this.git.push());
        else if (ctrl && !e.shiftKey && kl === "t") run(() => this.git.pull());
        else if (e.shiftKey && !ctrl && k === "F10") run(() => this.runner.runSelected(false));
        else if (e.shiftKey && !ctrl && k === "F9") run(() => this.runner.runSelected(true));
        else if (ctrl && e.shiftKey && k === "F10") run(() => this.runner.runCurrentFile(false));
        else if (ctrl && e.shiftKey && k === "F9") run(() => this.runner.runCurrentFile(true));
        else if (ctrl && k === "F2") run(() => this.runner.stopAll());
        else if (k === "F8" && !ctrl && !e.shiftKey && this.debugger.active) run(() => this.debugger.stepOver());
        else if (k === "F7" && !ctrl && !e.shiftKey && !e.altKey && this.debugger.active) run(() => this.debugger.stepInto());
        else if (k === "F8" && e.shiftKey && this.debugger.active) run(() => this.debugger.stepOut());
        else if (k === "F9" && !e.shiftKey && !ctrl && this.debugger.active) run(() => this.debugger.resume());
        else if (k === "Escape" && e.shiftKey) run(() => {
          for (const a of ["bottom", "right", "left"] as Anchor[]) if (this.visible[a]) return this.hide(a);
        });
        else if (k === "Escape" && !document.querySelector(".overlay, .popup, .menu") && this.tabs.active) {
          const active = document.activeElement as HTMLElement | null;
          if (active && this.editorIsland.contains(active)) return;
          this.editors.active()?.focus();
        }
      },
      true,
    );
    document.addEventListener("contextmenu", (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest("input, textarea, .cm-editor, .xterm")) e.preventDefault();
    });
    // Drop files from Explorer to open them.
    document.addEventListener("dragover", (e) => e.preventDefault());
  }
}

export async function openProjectWindow(path: string) {
  const label = "project-" + uid().replace(/[^a-zA-Z0-9]/g, "");
  const w = new WebviewWindow(label, {
    url: `index.html?project=${encodeURIComponent(P.norm(path))}`,
    title: P.base(path),
    width: 1440,
    height: 900,
    center: true,
    // macOS keeps the native traffic lights over the app's own title bar; elsewhere the window is frameless.
    ...(IS_MAC
      ? {
          decorations: true,
          titleBarStyle: "overlay" as const,
          hiddenTitle: true,
          trafficLightPosition: new LogicalPosition(14, 20),
          transparent: true,
          windowEffects: { effects: [Effect.LiquidGlassRegular, Effect.UnderWindowBackground], state: EffectState.FollowsWindowActiveState },
        }
      : { decorations: false }),
  });
  w.once("tauri://error", (e) => toast(String(e.payload), "error"));
}
