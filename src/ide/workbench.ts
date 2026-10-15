// The IDE window: main toolbar, tool window stripes, islands (tool windows + editor), status bar.
import { Effect, EffectState, getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { h, uid } from "../util";
import { icon, twIcon } from "../icons";
import { TabManager } from "../tabs";
import { closeMenus, contextMenu, modal, button, popupList, toast, type MenuItem, type PopupItem } from "../ui";
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
import { searchEverywhere, findInFiles, gotoLine, recentFiles, fileStructurePopup } from "./search";
import { openSettings } from "./settings";
import { openCloneDialog, openNewProjectDialog } from "./welcome";

export type Anchor = "left" | "right" | "bottom";
/** A place on the stripes: top of a side stripe, or the bottom group of a side stripe (bottom anchor). */
type StripeZone = "left" | "right" | "bottom-left" | "bottom-right";
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

  private toolWindows = new Map<string, ToolWindow>();
  private visible: Partial<Record<Anchor, string>> = {};
  private islands: Record<Anchor, HTMLElement>;
  private splitters: Record<Anchor, HTMLElement>;
  private stripeLeft = h("div.stripe");
  private stripeRight = h("div.stripe");
  private stripeZones: Record<StripeZone, { tw: ToolWindow; el: HTMLElement }[]> = { left: [], right: [], "bottom-left": [], "bottom-right": [] };
  private suppressStripeClick = false;
  private defaultPlacement = new Map<string, Placement>();
  /** Last tool window shown on each side, for the "toggle sidebar/panel" shortcuts. */
  private lastVisible: Partial<Record<Anchor, string>> = {};
  private editorIsland: HTMLElement;
  private toolbar = h("div.main-toolbar");
  private statusLeft = h("div.sb-crumbs");
  private statusRight = h("div.status-item");
  private statusProgress = h("div.sb-progress.hidden");
  private progressByKey = new Map<string, string>();
  readonly vcsBtn = h("button.tb-btn.vcs");
  readonly runWidget = h("div.run-widget");
  private lspLog: string[] = [];

  constructor(root: string) {
    this.root = P.norm(root);
    this.name = P.base(this.root);
    const empty = h(
      "div.editor-empty",
      null,
      ...[
        ["Buscar em tudo", "Shift duplo"],
        ["Ir para arquivo", "Ctrl+Shift+N"],
        ["Arquivos recentes", "Ctrl+E"],
        ["Barra de navegação", "Alt+Home"],
        ["Executar", "Shift+F10"],
        ["Solte arquivos aqui para abrir", ""],
      ].map(([a, b]) => h("div.wk", null, h("span", null, a), h("kbd", { "data-jb": b }, displayShortcut(b) || b))),
    );
    window.addEventListener("rits-keymap", () => {
      empty.querySelectorAll<HTMLElement>("kbd[data-jb]").forEach((k) => (k.textContent = displayShortcut(k.dataset.jb) || k.dataset.jb!));
      this.renderStripes();
    });
    this.tabs = new TabManager(empty);
    this.lsp = new LspManager(this.root, {
      openFile: async (path) => (await this.editors.openFile(path))?.view ?? null,
      progress: (lang, title) => this.setProgress("lsp-" + lang, title ? `${LSP_LANG_LABEL[lang]}: ${title}` : null),
      log: (lang, line) => {
        this.lspLog.push(`[${lang}] ${line}`);
        if (this.lspLog.length > 500) this.lspLog.shift();
      },
      missing: (lang) => this.pluginMissing(lang),
    });
    this.editorIsland = h("div.island.editor-island", null, this.tabs.bar, this.tabs.content);
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
    const workspace = h("div.workspace", { style: "padding-bottom:0" }, row);
    const statusbar = h("div.statusbar", null, this.statusLeft, h("span.grow"), this.statusProgress, this.statusRight);
    app.replaceChildren(this.toolbar, h("div.ide-body", null, this.stripeLeft, workspace, this.stripeRight), statusbar);
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
    this.renderStripes();
    this.tabs.onChange = () => {
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
      this.editors.onFsChange(paths);
      this.git.onFsChange(paths);
      this.lsp.notifyWatched(paths.filter((p) => /\.(py|go|mod|toml|cfg|json)$/i.test(p)));
    });

    // restore layout and files
    const lay = (this.settings.layout ?? {}) as Partial<Record<Anchor, string>>;
    this.show(lay.left ?? "project");
    if (lay.bottom) this.show(lay.bottom);
    if (lay.right) this.show(lay.right);
    for (const f of this.settings.openFiles ?? []) if (await host.exists(f)) await this.editors.openFile(f, { background: true });
    if (this.settings.activeFile) await this.editors.openFile(this.settings.activeFile);
    else if (!this.tabs.tabs.length) await this.openDefaultFile();

    this.installKeys();
    this.renderStatus();
    this.updateTitle();
    touchRecent(this.root, this.git.branch ?? undefined);
    window.addEventListener("beforeunload", () => this.persistOpenFiles());
  }

  private async openDefaultFile() {
    for (const f of ["README.md", "main.py", "main.go", "app.py", "cmd/main.go"]) {
      const p = P.join(this.root, f);
      if (await host.exists(p)) {
        await this.editors.openFile(p);
        return;
      }
    }
  }

  /** Optional plugins (Docker) add or remove their tool windows when enabled in Settings › Plugins. */
  syncPlugins() {
    if (dockerEnabled() && !this.docker) this.docker = new DockerTools(this);
    else if (!dockerEnabled() && this.docker) {
      this.docker.dispose();
      this.docker = null;
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
    this.renderStripes();
  }

  unregister(id: string) {
    const tw = this.toolWindows.get(id);
    if (!tw) return;
    if (this.visible[tw.anchor] === id) this.hide(tw.anchor);
    this.toolWindows.delete(id);
    this.renderStripes();
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
    else this.renderStripes();
  }

  /** Drag a stripe button to reorder it or move it to another stripe (JetBrains-style). */
  private stripeDrag(tw: ToolWindow, btn: HTMLElement, e: PointerEvent) {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let ghost: HTMLElement | null = null;
    let drop: { zone: StripeZone; index: number } | null = null;
    const marker = h("div.stripe-drop");
    const move = (ev: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        ghost = btn.cloneNode(true) as HTMLElement;
        ghost.classList.add("stripe-ghost");
        document.body.append(ghost, marker);
        btn.classList.add("dragging");
        document.body.classList.add("stripe-dragging");
        closeMenus();
      }
      ghost.style.transform = `translate(${ev.clientX - 17}px, ${ev.clientY - 17}px)`;
      drop = this.stripeDropAt(ev.clientX, ev.clientY, tw, marker);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      if (!ghost) return;
      ghost.remove();
      marker.remove();
      btn.classList.remove("dragging");
      document.body.classList.remove("stripe-dragging");
      this.suppressStripeClick = true;
      setTimeout(() => (this.suppressStripeClick = false));
      if (drop) this.placeToolWindow(tw, drop.zone, drop.index);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  /** Finds the zone and index under the pointer and positions the insertion marker. */
  private stripeDropAt(x: number, y: number, dragged: ToolWindow, marker: HTMLElement): { zone: StripeZone; index: number } | null {
    const stripes = [
      { side: "left" as const, el: this.stripeLeft },
      { side: "right" as const, el: this.stripeRight },
    ];
    const near = stripes
      .map((s) => ({ ...s, r: s.el.getBoundingClientRect() }))
      .map((s) => ({ ...s, d: x < s.r.left ? s.r.left - x : x > s.r.right ? x - s.r.right : 0 }))
      .sort((a, b) => a.d - b.d)[0];
    if (!near || near.d > 140) {
      marker.style.display = "none";
      return null;
    }
    const spacer = near.el.querySelector<HTMLElement>(".grow")?.getBoundingClientRect();
    const bottomGroup = spacer ? y > spacer.top + spacer.height / 2 : false;
    const zone: StripeZone = bottomGroup ? (near.side === "left" ? "bottom-left" : "bottom-right") : near.side;
    const items = this.stripeZones[zone].filter((z) => z.tw !== dragged);
    let index = items.findIndex((z) => {
      const r = z.el.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    if (index < 0) index = items.length;
    let top: number;
    if (index < items.length) top = items[index].el.getBoundingClientRect().top - 3;
    else if (items.length) top = items[items.length - 1].el.getBoundingClientRect().bottom + 1;
    else if (bottomGroup && spacer) top = spacer.bottom - 6;
    else top = near.r.top + 4;
    Object.assign(marker.style, { display: "block", left: near.r.left + 7 + "px", width: near.r.width - 14 + "px", top: top + "px" });
    return { zone, index };
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
    this.renderStripes();
    tw.onShow?.();
    if (focus) setTimeout(() => (tw.body.querySelector<HTMLElement>("[tabindex], input, textarea, .tree") ?? tw.body).focus());
    this.persistOpenFiles();
  }

  hide(anchor: Anchor) {
    if (this.visible[anchor]) this.lastVisible[anchor] = this.visible[anchor];
    delete this.visible[anchor];
    this.renderIsland(anchor);
    this.renderStripes();
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
      this.renderStripes();
    }
  }

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
    const header = h(
      "div.tw-header",
      null,
      h("span.tw-title", null, tw.title),
      tw.headerTabs ?? null,
      h("span.grow"),
      ...(tw.actions?.() ?? []),
      h("button.icon-btn", { title: "Opções", onclick: (e: MouseEvent) => this.twMenu(tw, e) }, icon("general/moreVertical")),
      h("button.icon-btn", { title: "Ocultar (Shift+Esc)", onclick: () => this.hide(anchor) }, icon("general/hide")),
    );
    if (headerOnly && island.firstElementChild) island.firstElementChild.replaceWith(header);
    else island.replaceChildren(header, tw.body);
  }

  private twMenu(tw: ToolWindow, e: MouseEvent) {
    const move = (z: StripeZone) => () => {
      this.placeToolWindow(tw, z, Number.MAX_SAFE_INTEGER);
      this.show(tw.id);
    };
    const zone = this.zoneOf(tw);
    contextMenu(e.clientX, e.clientY, [
      { label: "Mover para a esquerda", disabled: zone === "left", action: move("left") },
      { label: "Mover para baixo (esquerda)", disabled: zone === "bottom-left", action: move("bottom-left") },
      { label: "Mover para baixo (direita)", disabled: zone === "bottom-right", action: move("bottom-right") },
      { label: "Mover para a direita", disabled: zone === "right", action: move("right") },
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
    this.renderStripes();
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

  private renderStripes() {
    const zones: Record<StripeZone, { tw: ToolWindow; el: HTMLElement }[]> = { left: [], right: [], "bottom-left": [], "bottom-right": [] };
    const btn = (tw: ToolWindow) => {
      const b = h(
        "button.stripe-btn",
        {
          class: this.visible[tw.anchor] === tw.id ? "active" : "",
          title: tw.title + (displayShortcut(tw.shortcut) ? `  ${displayShortcut(tw.shortcut)}` : "") + "\nArraste para mover",
          onclick: () => !this.suppressStripeClick && this.toggle(tw.id),
          onpointerdown: (e: PointerEvent) => this.stripeDrag(tw, b, e),
        },
        twIcon(tw.icon),
        tw.badge ? h("span.badge-dot") : null,
      );
      zones[this.zoneOf(tw)].push({ tw, el: b });
      return b;
    };
    const all = [...this.toolWindows.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const of = (z: StripeZone) => all.filter((t) => this.zoneOf(t) === z).map(btn);
    const left = of("left");
    const bottomLeft = of("bottom-left");
    const right = of("right");
    const bottomRight = of("bottom-right");
    this.stripeZones = zones;
    this.stripeLeft.replaceChildren(...left, left.length && bottomLeft.length ? h("span.stripe-sep") : "", h("span.grow"), ...bottomLeft);
    const bell = twIcon("notifications");
    bell.style.opacity = "0.7";
    this.stripeRight.replaceChildren(...right, h("span.grow"), ...bottomRight, bottomRight.length ? h("span.stripe-sep") : "", bell);
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
    const menuBtn = h("button.tb-btn", { title: "Menu principal (Alt+\\)" }, icon("general/menu"));
    menuBtn.onclick = () => this.mainMenu(menuBtn);
    const projBtn = h("button.tb-btn.project", { title: this.root }, projectBadge(this.name), h("span.tb-label", null, this.name), icon("general/chevronDown"));
    projBtn.onclick = () => this.projectPopup(projBtn);
    this.vcsBtn.onclick = () => this.git.branchesPopup(this.vcsBtn);
    this.renderVcsWidget();
    const searchBtn = h("button.tb-btn", { title: "Buscar em tudo (Shift duplo)", onclick: () => searchEverywhere(this) }, icon("general/search"));
    const settingsBtn = h("button.tb-btn", { title: "Configurações (Ctrl+Alt+S)", onclick: () => openSettings(this) }, icon("general/settings"));
    const maxIcon = h("span");
    const updateMax = async () => maxIcon.replaceChildren(icon((await win.isMaximized().catch(() => false)) ? "restoreWin" : "maximize"));
    updateMax();
    win.onResized(() => updateMax()).catch(() => {});
    const drag = h("div.tb-drag", { "data-tauri-drag-region": true });
    drag.addEventListener("dblclick", () => win.toggleMaximize());
    this.toolbar.replaceChildren(
      menuBtn,
      projBtn,
      this.vcsBtn,
      drag,
      this.runWidget,
      h("span", { style: "width:6px" }),
      searchBtn,
      settingsBtn,
      h(
        "div.win-controls",
        null,
        h("button.win-btn", { title: "Minimizar", onclick: () => win.minimize() }, icon("minimize")),
        h("button.win-btn", { title: "Maximizar", onclick: () => win.toggleMaximize() }, maxIcon),
        h("button.win-btn.close", { title: "Fechar", onclick: () => this.closeWindow() }, icon("closeWin")),
      ),
    );
    this.toolbar.addEventListener("mousedown", (e) => {
      if (e.target === this.toolbar && e.button === 0) win.startDragging();
    });
  }

  renderVcsWidget() {
    const b = this.git?.branch;
    this.vcsBtn.replaceChildren(icon("branch"), h("span.tb-label", null, this.git?.isRepo === false ? "Controle de versão" : b ?? "…"), icon("general/chevronDown"));
    this.vcsBtn.title = this.git?.isRepo === false ? "Habilitar controle de versão" : `Branch Git: ${b ?? ""}`;
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
          { label: document.documentElement.dataset.theme === "dark" ? "Tema Islands Light" : "Tema Islands Dark", action: () => (window as any).__toggleTheme?.() },
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
