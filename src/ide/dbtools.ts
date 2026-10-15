// Database Tools inside the IDE: "Database" tool window (explorer), consoles/table editors as editor
// tabs, and the "Services" tool window (backup tasks, query history, SQL log).
import type { ConnConfig } from "../api";
import { openBackupWizard, openRestoreWizard, setTaskStartedHook, taskPanel } from "../backup";
import { openConnectionDialog, pickDbKind } from "../connDialog";
import { createConsole, type ConsoleState, type ConsoleTab } from "../console";
import { Explorer } from "../explorer";
import { icon } from "../icons";
import { store } from "../state";
import { createDdlTab, createTableView, type ObjectRef } from "../tableView";
import { createDiagramTab } from "../diagram";
import { toast } from "../ui";
import { debounce, formatDuration, h } from "../util";
import type { Workbench } from "./workbench";

export class DbTools {
  explorer: Explorer;
  private servicesTab: "tasks" | "history" | "log" = "tasks";
  private servicesTabs = h("div.tw-tabs");
  private servicesBody = h("div.tw-body");
  private historyPane = h("div.history-pane");
  private logPane = h("div.log-pane");

  constructor(private wb: Workbench) {
    this.explorer = new Explorer({
      newConnection: (anchor) => this.newConnection(anchor),
      editConnection: (c) => openConnectionDialog(c),
      openConsole: (c, db, schema, text, run) => this.openConsole(c, { db, schema, text }, run),
      openObject: (c, ref) => this.openObject(c, ref),
      backup: (c, db, schemas, tables) => openBackupWizard(c, db, schemas, tables),
      restore: (c, db) => openRestoreWizard(c, db),
      openDiagram: (c, db, schema, focus) => this.openDiagram(c, db, schema, focus),
    });
    wb.register({
      id: "database",
      title: "Database",
      icon: "databaseTw",
      anchor: "right",
      shortcut: "Alt+2",
      body: h("div.tw-body", null, this.explorer.el),
      actions: () => [
        h("button.icon-btn", { title: "Nova conexão", onclick: (e: MouseEvent) => this.newConnection(e.currentTarget as HTMLElement) }, icon("general/add")),
        h("button.icon-btn", { title: "Atualizar (F5)", onclick: () => this.explorer.refreshSelected() }, icon("general/refresh")),
        h("button.icon-btn", { title: "Abrir console (Ctrl+Shift+L)", onclick: () => this.explorer.consoleForSelected() }, icon("console")),
        h("button.icon-btn", { title: "Backup", onclick: () => this.backup() }, icon("backup")),
        h("button.icon-btn", { title: "Restaurar", onclick: () => this.restore() }, icon("restore")),
        h("button.icon-btn", { title: "Recolher tudo", onclick: () => this.explorer.collapseAll() }, icon("general/collapseAll")),
      ],
    });
    wb.register({ id: "services", title: "Services", icon: "services", anchor: "bottom", shortcut: "Alt+8", body: this.servicesBody, headerTabs: this.servicesTabs, onShow: () => this.renderServices() });
    setTaskStartedHook(() => {
      this.servicesTab = "tasks";
      wb.show("services");
    });
    store.on("log", () => this.servicesTab === "log" && wb.isVisible("services") && this.renderServices());
    store.on("history", () => this.servicesTab === "history" && wb.isVisible("services") && this.renderServices());
    store.on("tabs", () => wb.tabs.renderBar());
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        this.explorer.consoleForSelected();
      }
    });
    this.boot();
  }

  openDiagram(c: ConnConfig, db: string, schema: string, focus?: string) {
    const tab = createDiagramTab(c, db, schema, {
      focus,
      openTable: (name, kind) => this.openObject(c, { connId: c.id, db, schema, name, kind }),
    });
    const existing = this.wb.tabs.find(tab.id);
    if (existing) this.wb.tabs.close(existing);
    this.wb.tabs.open(tab);
  }

  private async boot() {
    store.setProject(this.wb.root);
    try {
      await store.load();
    } catch (e) {
      toast(String(e), "error");
    }
    for (const s of this.wb.settings.dbConsoles ?? []) {
      const c = store.conn(s.connId);
      if (c) this.wb.tabs.open(createConsole(c, s, this.persist), true);
    }
  }

  private persist = debounce(() => {
    this.wb.settings.dbConsoles = this.wb.tabs.tabs.filter((t) => (t as ConsoleTab).kind === "console").map((t) => ({ ...(t as ConsoleTab).state }));
    this.wb.saveSettings();
  }, 500);

  /** Picks the database type in a small popup (at the + button), then opens the connection dialog. */
  newConnection(anchor?: HTMLElement) {
    // Read the position first: showing the tool window re-renders its header (and the button).
    // Centered on the Database panel, below its header, so the side stripe stays visible.
    const r = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    const panel = anchor?.closest(".island")?.getBoundingClientRect();
    const at = r ? { x: panel ? panel.left + (panel.width - 210) / 2 : r.right - 210, y: r.bottom + 2 } : { x: Math.max(16, innerWidth / 2 - 105), y: 110 };
    if (!this.wb.isVisible("database")) this.wb.show("database");
    pickDbKind(at, (kind, preset) => openConnectionDialog(undefined, () => this.explorer.rebuild(), { kind, preset }));
  }

  openConsole(c: ConnConfig, init: Partial<ConsoleState>, run = false) {
    const t = createConsole(c, init, this.persist);
    this.wb.tabs.open(t);
    this.persist();
    if (run && init.text) setTimeout(() => t.insertText("", true));
  }

  private consoleWithText(c: ConnConfig, db: string, text: string) {
    const existing = this.wb.tabs.tabs.find((t) => (t as ConsoleTab).kind === "console" && (t as ConsoleTab).state.connId === c.id && (t as ConsoleTab).state.db === db) as ConsoleTab | undefined;
    if (existing) {
      this.wb.tabs.activate(existing);
      existing.insertText(text);
    } else this.openConsole(c, { db, text });
  }

  openObject(c: ConnConfig, ref: ObjectRef) {
    const rel = ref.kind === "table" || ref.kind === "view" || ref.kind === "matview";
    this.wb.tabs.open(rel ? createTableView(c, ref, (sql) => this.consoleWithText(c, ref.db, sql)) : createDdlTab(c, ref, (sql) => this.consoleWithText(c, ref.db, sql)));
  }

  private ctx(): { conn?: ConnConfig; db: string } {
    const t = this.wb.tabs.active as ConsoleTab | null;
    if (t && t.kind === "console") return { conn: store.conn(t.state.connId), db: t.state.db };
    const c = this.explorer.selectedConn();
    return { conn: c, db: c?.database ?? "" };
  }

  backup() {
    const { conn, db } = this.ctx();
    if (!conn) return this.newConnection();
    openBackupWizard(conn, db);
  }

  restore() {
    const { conn, db } = this.ctx();
    if (!conn) return this.newConnection();
    openRestoreWizard(conn, db);
  }

  private renderServices() {
    this.servicesTabs.replaceChildren(
      ...([["tasks", "Tarefas", "tasks"], ["history", "Histórico SQL", "general/history"], ["log", "Log SQL", "log"]] as const).map(([id, label, ic]) =>
        h("div.tw-tab", { class: this.servicesTab === id ? "active" : "", onclick: () => ((this.servicesTab = id), this.renderServices()) }, icon(ic), label),
      ),
    );
    this.wb.refreshHeader("services");
    if (this.servicesTab === "tasks") this.servicesBody.replaceChildren(taskPanel);
    else if (this.servicesTab === "history") {
      this.renderHistory();
      this.servicesBody.replaceChildren(this.historyPane);
    } else {
      this.renderLog();
      this.servicesBody.replaceChildren(this.logPane);
    }
  }

  private renderHistory() {
    const q = h("input.input", { placeholder: "Filtrar histórico…", spellcheck: false }) as HTMLInputElement;
    const list = h("div.hist-list");
    const draw = () => {
      const f = q.value.toLowerCase();
      const items = [...store.history].reverse().filter((x) => !f || x.sql.toLowerCase().includes(f)).slice(0, 300);
      list.replaceChildren(
        ...items.map((x) => {
          const c = store.conn(x.connId);
          return h(
            "div.hist-item",
            { title: "Duplo clique: inserir no console", ondblclick: () => c && this.consoleWithText(c, x.db, x.sql + ";") },
            h("div.hist-meta", null, icon(c?.kind ?? "database"), `${c?.name ?? "?"} · ${x.db} · ${new Date(x.time).toLocaleString()}`),
            h("pre.hist-sql", null, x.sql.length > 600 ? x.sql.slice(0, 600) + "…" : x.sql),
          );
        }),
      );
      if (!items.length) list.append(h("div.empty-note", null, "Sem histórico."));
    };
    q.oninput = draw;
    this.historyPane.replaceChildren(h("div.pane-toolbar", null, q), list);
    draw();
  }

  private renderLog() {
    const items = store.log.slice(-500);
    this.logPane.replaceChildren(
      ...items.map((e) =>
        h(
          "div.log-line",
          { class: e.ok ? "" : "err" },
          h("span.log-time", null, new Date(e.time).toLocaleTimeString()),
          h("span.log-conn", null, `[${e.connName}${e.db ? "/" + e.db : ""}]`),
          h("span.log-sql", null, e.sql.replace(/\s+/g, " ").slice(0, 400)),
          h("span.log-msg", null, `${e.message.split("\n")[0]}${e.elapsedMs ? " · " + formatDuration(e.elapsedMs) : ""}`),
        ),
      ),
    );
    if (!items.length) this.logPane.append(h("div.empty-note", null, "Nenhuma instrução executada ainda."));
    this.logPane.scrollTop = this.logPane.scrollHeight;
  }
}
