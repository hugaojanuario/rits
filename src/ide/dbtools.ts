// Database Tools inside the IDE: "Database" tool window (explorer), consoles/table editors as editor
// tabs, and the "Services" tool window (backup tasks, query history, SQL log).
import type { ConnConfig } from "../api";
import { openBackupWizard, openRestoreWizard, setTaskStartedHook, taskPanel } from "../backup";
import { openConnectionDialog, pickDbKind } from "../connDialog";
import { createConsole, type ConsoleHooks, type ConsoleState, type ConsoleTab } from "../console";
import { Explorer } from "../explorer";
import { icon } from "../icons";
import { store } from "../state";
import { createDdlTab, createTableView, type ObjectRef } from "../tableView";
import { createDiagramTab } from "../diagram";
import { promptDialog, toast } from "../ui";
import { debounce, formatDuration, h } from "../util";
import { host, P } from "./host";
import { contribute } from "./plugins";
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
      newScript: (c, db, schema) => this.newScript(this.wb.root, c, db, schema),
    });
    // .sql files open as SQL scripts (editor + connection + results); dbt models stay in the code editor
    contribute({
      id: "sql-scripts",
      open: async (path, o) => {
        if (P.ext(path) !== "sql" || (await this.isDbtFile(path))) return false;
        this.openScript(path, { background: o.background, line: o.line });
        return true;
      },
    });
    wb.register({
      id: "database",
      title: "Database",
      icon: "databaseTw",
      // Blocos layout: the database explorer shares the left card with the project tree.
      anchor: "left",
      shortcut: "Alt+2",
      body: h("div.tw-body", null, this.explorer.el),
      actions: () => [
        h("button.icon-btn", { title: "Nova conexão", onclick: (e: MouseEvent) => this.newConnection(e.currentTarget as HTMLElement) }, icon("general/add")),
        h("button.icon-btn", { title: "Atualizar (F5)", onclick: () => this.explorer.refreshSelected() }, icon("general/refresh")),
        h("button.icon-btn", { title: "Abrir console (Ctrl+Shift+L)", onclick: () => this.explorer.consoleForSelected() }, icon("console")),
        h("button.icon-btn", { title: "Novo script SQL", onclick: () => this.newScript(this.wb.root, this.explorer.selectedConn()) }, icon("fileTypes/sql")),
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
      const c = store.conn(s.connId) ?? null;
      if (s.file) {
        if (await host.exists(s.file)) this.wb.tabs.open(createConsole(c, { ...s, text: "" }, this.hooks), true);
      } else if (c) this.wb.tabs.open(createConsole(c, s, this.hooks), true);
    }
  }

  private persist = debounce(() => {
    // scripts keep their text in the file
    this.wb.settings.dbConsoles = this.consoles().map((t) => ({ ...t.state, text: t.state.file ? "" : t.state.text }));
    this.wb.saveSettings();
  }, 500);

  private hooks: ConsoleHooks = {
    onPersist: () => this.persist(),
    openTable: (c, ref) => this.openObject(c, ref),
    openScript: (path, conn, db, schema) => {
      if (conn && !this.wb.settings.sqlScripts?.[path.toLowerCase()]) this.bindScript(path, conn.id, db, schema);
      this.openScript(path);
    },
    scriptBound: (s, oldFile) => {
      if (oldFile) delete this.wb.settings.sqlScripts?.[P.norm(oldFile).toLowerCase()];
      if (s.file) this.bindScript(s.file, s.connId, s.db, s.schema);
    },
  };

  private consoles() {
    return this.wb.tabs.tabs.filter((t) => (t as ConsoleTab).kind === "console") as ConsoleTab[];
  }

  private bindScript(path: string, connId: string, db: string, schema: string) {
    (this.wb.settings.sqlScripts ??= {})[P.norm(path).toLowerCase()] = { connId, db, schema };
    this.wb.saveSettings();
  }

  /** dbt models and macros are Jinja SQL: they stay in the code editor with the dbt plugin. */
  private async isDbtFile(path: string) {
    const dir = this.wb.settings.dbt?.projectDir;
    if (dir && P.inside(dir, path)) return true;
    try {
      const f = await host.read(path);
      return /\{\{|\{%/.test(f.text);
    } catch {
      return false;
    }
  }

  /** Opens a .sql file as a SQL script tab, with the connection last used for it. */
  openScript(path: string, o: { background?: boolean; line?: number } = {}) {
    path = P.norm(path);
    let t = this.consoles().find((x) => x.state.file && P.same(x.state.file, path));
    if (!t) {
      const b = this.wb.settings.sqlScripts?.[path.toLowerCase()];
      const c = (b && store.conn(b.connId)) || null;
      t = createConsole(c, { file: path, db: c ? b!.db : undefined, schema: c ? b!.schema : undefined }, this.hooks);
      const tab = t;
      tab.menu = () => [
        { label: "Revelar no Projeto", icon: "general/locate", action: () => this.wb.projectView.reveal(path) },
        { label: "Copiar caminho", icon: "general/copy", action: () => navigator.clipboard.writeText(P.win(tab.state.file ?? path)) },
        {
          label: "Abrir como texto",
          action: async () => {
            await tab.file?.flush();
            if (await this.wb.tabs.close(tab)) this.wb.editors.openFile(tab.state.file ?? path, { text: true });
          },
        },
      ];
      this.wb.tabs.open(t, o.background);
      this.persist();
    } else if (!o.background) this.wb.tabs.activate(t);
    if (o.line) {
      const v = t.editor.view;
      const line = v.state.doc.line(Math.min(o.line, v.state.doc.lines));
      v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    }
  }

  /** Creates a .sql file (asks the name) bound to a connection, and opens it. */
  async newScript(dir: string, c?: ConnConfig | null, db?: string, schema?: string) {
    let name = (await promptDialog("Novo script SQL", "Nome do arquivo", c ? `${c.name.replace(/[^\w.-]+/g, "_")}.sql` : "consulta.sql"))?.trim();
    if (!name) return;
    if (!/\.sql$/i.test(name)) name += ".sql";
    const path = P.join(dir, name);
    if (await host.exists(path)) return toast(`${P.base(path)} já existe`, "error");
    const conn = c ?? (store.connections.length === 1 ? store.connections[0] : null);
    try {
      if (!(await host.exists(P.dir(path)))) await host.create(P.dir(path), true);
      await host.write(path, "");
    } catch (e) {
      return toast(String(e), "error");
    }
    if (conn) this.bindScript(path, conn.id, db ?? conn.database, schema ?? "");
    this.openScript(path);
    this.wb.projectView.reveal(path).catch(() => {});
    if (this.wb.git.isRepo) this.wb.git.askAdd(path);
  }

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
    const t = createConsole(c, init, this.hooks);
    this.wb.tabs.open(t);
    this.persist();
    if (run && init.text) setTimeout(() => t.insertText("", true));
  }

  private consoleWithText(c: ConnConfig, db: string, text: string) {
    const existing = this.consoles().find((t) => !t.state.file && t.state.connId === c.id && t.state.db === db);
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
    if (t && t.kind === "console" && t.state.connId) return { conn: store.conn(t.state.connId), db: t.state.db };
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
