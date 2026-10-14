// "Terminal" tool window: xterm.js on top of a real PTY (ConPTY on Windows).
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { h, uid } from "../util";
import { icon } from "../icons";
import { contextMenu } from "../ui";
import { host, on, P } from "./host";
import { scriptsDir } from "./sdk";
import type { Workbench } from "./workbench";

interface TermTab {
  id: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  off: () => void;
  alive: boolean;
}

function xtermTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  const dark = document.documentElement.dataset.theme !== "light";
  return {
    background: v("--island"),
    foreground: v("--editor-fg"),
    cursor: v("--icon"),
    selectionBackground: v("--editor-selection"),
    black: dark ? "#4C4F56" : "#000000",
    red: dark ? "#F75464" : "#C4382D",
    green: dark ? "#5FB865" : "#067D17",
    yellow: dark ? "#E5C07B" : "#9E880D",
    blue: dark ? "#548AF7" : "#0033B3",
    magenta: dark ? "#C678DD" : "#871094",
    cyan: dark ? "#2AACB8" : "#00627A",
    white: dark ? "#D1D3D9" : "#5F6269",
    brightBlack: "#73767C",
    brightRed: dark ? "#FF7B85" : "#E4656E",
    brightGreen: dark ? "#89D185" : "#4E9D6C",
    brightYellow: dark ? "#F2C55C" : "#C28013",
    brightBlue: dark ? "#6EA6FF" : "#3871E1",
    brightMagenta: dark ? "#D7A1F0" : "#A35BE8",
    brightCyan: dark ? "#56C8D3" : "#2DB3B7",
    brightWhite: dark ? "#FFFFFF" : "#191A1C",
  };
}

export class Terminals {
  private tabs: TermTab[] = [];
  private active: TermTab | null = null;
  private tabsEl = h("div.tw-tabs");
  private body = h("div.tw-body");

  constructor(private wb: Workbench) {
    wb.register({
      id: "terminal",
      title: "Terminal",
      icon: "terminal",
      anchor: "bottom",
      shortcut: "Alt+F12",
      body: this.body,
      headerTabs: this.tabsEl,
      onShow: () => {
        if (!this.tabs.length) this.newTab();
        else setTimeout(() => this.fitActive(true));
      },
      actions: () => [h("button.icon-btn", { title: "Nova aba (Ctrl+Shift+T)", onclick: () => this.newTab() }, icon("general/add"))],
    });
    new ResizeObserver(() => this.fitActive()).observe(this.body);
    window.addEventListener("rits-theme", () => this.tabs.forEach((t) => (t.term.options.theme = xtermTheme())));
  }

  async newTab(cwd = this.wb.root, command?: string) {
    const id = "pty-" + uid();
    const el = h("div.term-host");
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono"),
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: xtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const n = this.tabs.length + 1;
    const t: TermTab = { id, title: n === 1 ? "Local" : `Local (${n})`, term, fit, el, off: () => {}, alive: true };
    this.tabs.push(t);
    this.active = t;
    this.wb.show("terminal");
    this.render();
    term.open(el);
    fit.fit();
    const offData = on<{ id: string; data: string }>("pty-data", id, (e) => term.write(e.data));
    const offExit = on<{ id: string; data: string }>("pty-exit", id, () => {
      t.alive = false;
      term.write("\r\n\x1b[90m[processo encerrado]\x1b[0m\r\n");
    });
    t.off = () => (offData(), offExit());
    term.onData((d) => t.alive && host.ptyWrite(id, d));
    term.onResize(({ cols, rows }) => t.alive && host.ptyResize(id, cols, rows).catch(() => {}));
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.ctrlKey && e.key === "c" && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      if (e.ctrlKey && e.key === "v") {
        navigator.clipboard.readText().then((x) => host.ptyWrite(id, x));
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") {
        this.newTab();
        return false;
      }
      // let IDE shortcuts through
      if ((e.altKey && e.key === "F12") || (e.ctrlKey && e.key === "F4") || (e.shiftKey && e.key === "Escape")) return false;
      return true;
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: "Copiar", icon: "general/copy", disabled: !term.hasSelection(), action: () => navigator.clipboard.writeText(term.getSelection()) },
        { label: "Colar", icon: "general/paste", action: () => navigator.clipboard.readText().then((x) => host.ptyWrite(id, x)) },
        { label: "Limpar", icon: "general/delete", action: () => term.clear() },
      ]);
    });
    const env: Record<string, string> = {};
    const py = this.wb.python;
    if (py?.venv) {
      env.RITS_PATH_PREPEND = P.win(scriptsDir(py.path));
      env.VIRTUAL_ENV = P.win(P.dir(scriptsDir(py.path)));
    }
    try {
      await host.ptyOpen(id, this.wb.env.defaultShell, P.win(cwd), term.cols, term.rows, env);
      if (command) setTimeout(() => host.ptyWrite(id, command + "\r"), 400);
    } catch (e) {
      term.write(`\x1b[31mFalha ao abrir o terminal: ${e}\x1b[0m\r\n`);
      t.alive = false;
    }
    term.focus();
  }

  private fitActive(focus = false) {
    const t = this.active;
    if (!t || !t.el.isConnected || !t.el.offsetHeight) return;
    try {
      t.fit.fit();
    } catch {
      /* not visible */
    }
    if (focus) t.term.focus();
  }

  private close(t: TermTab) {
    t.off();
    host.ptyClose(t.id);
    t.term.dispose();
    this.tabs = this.tabs.filter((x) => x !== t);
    if (this.active === t) this.active = this.tabs[this.tabs.length - 1] ?? null;
    if (!this.tabs.length) this.wb.hide("bottom");
    else this.render();
  }

  closeAll() {
    for (const t of [...this.tabs]) {
      t.off();
      host.ptyClose(t.id);
    }
    this.tabs = [];
  }

  private render() {
    this.tabsEl.replaceChildren(
      ...this.tabs.map((t) =>
        h(
          "div.tw-tab",
          { class: t === this.active ? "active" : "", onclick: () => ((this.active = t), this.render(), setTimeout(() => this.fitActive(true))) },
          t.title,
          h("button.tab-x", { onclick: (e: MouseEvent) => (e.stopPropagation(), this.close(t)) }, icon("general/closeSmall")),
        ),
      ),
    );
    this.wb.refreshHeader("terminal");
    if (this.active) this.body.replaceChildren(this.active.el);
    setTimeout(() => this.fitActive());
  }
}
