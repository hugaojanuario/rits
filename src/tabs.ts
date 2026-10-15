import { h } from "./util";
import { icon } from "./icons";
import { contextMenu, type MenuItem } from "./ui";

export interface Tab {
  id: string;
  title: string;
  icon: string;
  tooltip?: string;
  color?: string;
  /** Extra CSS classes: modified, vcs-modified, has-error ... */
  cls?: string;
  el: HTMLElement;
  onActivate?: () => void;
  onDeactivate?: () => void;
  /** Return false to keep the tab open. */
  canClose?: () => Promise<boolean> | boolean;
  onClose?: () => void;
  menu?: () => MenuItem[];
}

export class TabManager {
  bar = h("div.tabbar");
  content = h("div.tab-content");
  tabs: Tab[] = [];
  active: Tab | null = null;
  private empty: HTMLElement;
  private history: Tab[] = [];
  /** A pinned first tab that shows the "empty" page (the project home); null = no such tab. */
  private home: { title: string; icon: string } | null;
  onChange?: () => void;

  constructor(empty: HTMLElement, home: { title: string; icon: string } | null = null) {
    this.empty = empty;
    this.home = home;
    this.content.append(empty);
    this.bar.addEventListener("wheel", (e) => {
      this.bar.scrollLeft += e.deltaY;
    });
  }

  find(id: string) {
    return this.tabs.find((t) => t.id === id);
  }

  open(tab: Tab, background = false) {
    const existing = this.find(tab.id);
    if (existing) {
      if (!background) this.activate(existing);
      return existing;
    }
    const at = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, tab);
    tab.el.classList.add("tab-pane");
    tab.el.style.display = "none";
    this.content.append(tab.el);
    if (background && this.active) this.renderBar();
    else this.activate(tab);
    return tab;
  }

  activate(tab: Tab) {
    if (this.active && this.active !== tab) this.active.onDeactivate?.();
    this.active = tab;
    this.history = [tab, ...this.history.filter((t) => t !== tab)];
    for (const t of this.tabs) t.el.style.display = t === tab ? "" : "none";
    this.empty.style.display = "none";
    this.renderBar();
    tab.onActivate?.();
    this.onChange?.();
  }

  /** Shows the home page (the pinned first tab) without closing any tab. */
  showHome() {
    if (!this.home) return;
    if (this.active) this.active.onDeactivate?.();
    this.active = null;
    for (const t of this.tabs) t.el.style.display = "none";
    this.empty.style.display = "";
    this.renderBar();
    this.onChange?.();
  }

  /** Most recently used first (for Ctrl+E / Ctrl+Tab). */
  recent(): Tab[] {
    return this.history.filter((t) => this.tabs.includes(t));
  }

  async close(tab: Tab) {
    if (tab.canClose && !(await tab.canClose())) return false;
    const i = this.tabs.indexOf(tab);
    if (i < 0) return true;
    this.tabs.splice(i, 1);
    this.history = this.history.filter((t) => t !== tab);
    tab.el.remove();
    tab.onClose?.();
    if (this.active === tab) {
      this.active = null;
      const next = this.recent()[0] ?? this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next);
      else {
        this.empty.style.display = "";
        this.renderBar();
        this.onChange?.();
      }
    } else this.renderBar();
    return true;
  }

  async closeOthers(keep: Tab) {
    for (const t of [...this.tabs]) if (t !== keep) await this.close(t);
  }

  async closeAll() {
    for (const t of [...this.tabs]) if (!(await this.close(t))) return false;
    return true;
  }

  cycle(dir: 1 | -1) {
    if (!this.active && this.tabs.length) return this.activate(this.recent()[0] ?? this.tabs[0]);
    if (!this.active || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length]);
  }

  update(tab: Tab) {
    if (this.tabs.includes(tab)) this.renderBar();
  }

  renderBar() {
    const home = this.home;
    const homeEl = home
      ? h("button.tab.tab-home", { class: this.active ? "" : "active", title: home.title, "aria-label": home.title, onmousedown: (e: MouseEvent) => e.button === 0 && this.showHome() }, icon(home.icon))
      : null;
    this.bar.replaceChildren(
      ...(homeEl ? [homeEl] : []),
      ...this.tabs.map((t) => {
        const el = h(
          "div.tab",
          { class: [t === this.active && "active", t.cls].filter(Boolean).join(" "), title: t.tooltip ?? t.title },
          t.color ? h("span.tab-color", { style: `background:${t.color}` }) : null,
          icon(t.icon),
          h("span.tab-title", null, t.title),
          h(
            "button.tab-close",
            {
              title: "Fechar (Ctrl+F4)",
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                this.close(t);
              },
            },
            icon("general/closeSmall"),
          ),
        );
        el.addEventListener("mousedown", (e) => {
          if (e.button === 1) {
            e.preventDefault();
            this.close(t);
          } else if (e.button === 0) this.activate(t);
        });
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: "Fechar", shortcut: "Ctrl+F4", action: () => this.close(t) },
            { label: "Fechar outras abas", action: () => this.closeOthers(t) },
            { label: "Fechar todas as abas", action: () => this.closeAll() },
            ...(t.menu ? [{ separator: true } as MenuItem, ...t.menu()] : []),
          ]);
        });
        return el;
      }),
    );
    this.bar.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}
