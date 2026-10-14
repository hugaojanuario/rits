// Database Explorer tool window.
import { api, type ConnConfig, type DbObject } from "./api";
import { icon } from "./icons";
import { store } from "./state";
import { confirmDialog, contextMenu, promptDialog, toast, type MenuItem } from "./ui";
import { copyText, h, qualified, quoteIdent } from "./util";
import type { ObjectRef } from "./tableView";
import { exportToFile, type ExportFormat } from "./export";

export interface ExplorerActions {
  newConnection: () => void;
  editConnection: (c: ConnConfig) => void;
  openConsole: (c: ConnConfig, db?: string, schema?: string, text?: string, run?: boolean) => void;
  openObject: (c: ConnConfig, ref: ObjectRef) => void;
  backup: (c: ConnConfig, db: string, schemas?: string[], tables?: string[]) => void;
  restore: (c: ConnConfig, db: string) => void;
}

interface Node {
  key: string;
  label: string;
  icon: string;
  detail?: string;
  color?: string;
  children?: Node[];
  load?: () => Promise<Node[]>;
  expanded?: boolean;
  loading?: boolean;
  error?: string;
  menu?: () => MenuItem[];
  open?: () => void;
  parent?: Node;
  dim?: boolean;
}

const FOLDERS: [string, string][] = [
  ["table", "Tabelas"],
  ["view", "Views"],
  ["matview", "Views materializadas"],
  ["function", "Funções"],
  ["procedure", "Procedures"],
  ["sequence", "Sequências"],
  ["trigger", "Triggers"],
  ["event", "Eventos"],
];

const SYSTEM = new Set(["pg_catalog", "information_schema", "mysql", "performance_schema", "sys"]);

export class Explorer {
  el: HTMLElement;
  private treeEl: HTMLElement;
  private filterI: HTMLInputElement;
  private roots: Node[] = [];
  private selected: Node | null = null;
  private expandedKeys = new Set<string>();

  constructor(private act: ExplorerActions) {
    this.filterI = h("input.input.tree-filter", { placeholder: "Filtrar…", spellcheck: false, oninput: () => this.render() }) as HTMLInputElement;
    this.treeEl = h("div.tree", { tabIndex: 0 });
    this.treeEl.addEventListener("keydown", (e) => this.onKey(e));
    this.el = h(
      "div.explorer",
      null,
      h(
        "div.panel-head",
        null,
        h("span.panel-title", null, "Explorador"),
        h("span.grow"),
        h("button.icon-btn", { title: "Nova conexão", onclick: () => act.newConnection() }, icon("plus")),
        h("button.icon-btn", { title: "Atualizar", onclick: () => this.refreshSelected() }, icon("refresh")),
        h("button.icon-btn", { title: "Abrir console (Ctrl+Shift+L)", onclick: () => this.consoleForSelected() }, icon("console")),
        h("button.icon-btn", { title: "Recolher tudo", onclick: () => this.collapseAll() }, icon("collapse")),
      ),
      h("div.tree-filter-wrap", null, icon("search"), this.filterI),
      this.treeEl,
    );
    store.on("connections", () => this.rebuild());
    store.on("status", () => this.render());
    store.on("ddl", () => this.refreshSelected(true));
  }

  rebuild() {
    this.roots = store.connections.map((c) => this.connNode(c));
    this.render();
  }

  selectedConn(): ConnConfig | undefined {
    let n = this.selected;
    while (n?.parent) n = n.parent;
    return n ? store.conn(n.key.split("|")[1]) : store.connections[0];
  }

  private ctxOf(n: Node | null): { conn?: ConnConfig; db?: string; schema?: string } {
    if (!n) return {};
    const parts = n.key.split("|");
    return { conn: store.conn(parts[1]), db: parts[2], schema: parts[3] };
  }

  consoleForSelected() {
    const { conn, db, schema } = this.ctxOf(this.selected);
    const c = conn ?? store.connections[0];
    if (!c) return this.act.newConnection();
    this.act.openConsole(c, db, conn?.kind === "postgres" ? schema : undefined);
  }

  // ---------- node factories ----------

  private connNode(c: ConnConfig): Node {
    const key = `conn|${c.id}`;
    const n: Node = {
      key,
      label: c.name,
      icon: c.kind,
      color: c.color,
      detail: `${c.host}:${c.port}`,
      load: async () => {
        await store.connect(c.id);
        const dbs = await api.databases(c.id);
        const shown = c.kind === "postgres" && c.database ? [c.database, ...dbs.filter((d) => d !== c.database)] : dbs;
        return shown.map((d) => this.dbNode(c, d));
      },
      menu: () => this.connMenu(c, n),
      open: () => this.toggle(n),
    };
    return n;
  }

  private dbNode(c: ConnConfig, db: string): Node {
    const n: Node = {
      key: `db|${c.id}|${db}`,
      label: db,
      icon: c.kind === "postgres" ? "database" : "schema",
      dim: SYSTEM.has(db),
      load: async () => {
        if (c.kind === "mysql") return this.folderNodes(c, db, db);
        const schemas = await api.schemas(c.id, db);
        return schemas.map((s) => this.schemaNode(c, db, s));
      },
      menu: () => this.dbMenu(c, db, n),
      open: () => this.toggle(n),
    };
    return n;
  }

  private schemaNode(c: ConnConfig, db: string, schema: string): Node {
    const n: Node = {
      key: `schema|${c.id}|${db}|${schema}`,
      label: schema,
      icon: "schema",
      dim: SYSTEM.has(schema),
      load: () => this.folderNodes(c, db, schema),
      menu: () => this.schemaMenu(c, db, schema, n),
      open: () => this.toggle(n),
    };
    return n;
  }

  private async folderNodes(c: ConnConfig, db: string, schema: string): Promise<Node[]> {
    const objs = await api.objects(c.id, db, schema);
    const out: Node[] = [];
    for (const [kind, label] of FOLDERS) {
      const list = objs.filter((o) => o.kind === kind);
      if (!list.length) continue;
      const folder: Node = {
        key: `folder|${c.id}|${db}|${schema}|${kind}`,
        label,
        icon: "folder",
        detail: String(list.length),
        children: list.map((o) => this.objectNode(c, db, schema, o)),
        open: () => this.toggle(folder),
      };
      out.push(folder);
    }
    if (!out.length) out.push({ key: `empty|${c.id}|${db}|${schema}`, label: "(vazio)", icon: "info", dim: true });
    return out;
  }

  private objectNode(c: ConnConfig, db: string, schema: string, o: DbObject): Node {
    const ref: ObjectRef = { connId: c.id, db, schema, name: o.name, kind: o.kind };
    const hasCols = o.kind === "table" || o.kind === "view" || o.kind === "matview";
    const n: Node = {
      key: `obj|${c.id}|${db}|${schema}|${o.kind}|${o.name}`,
      label: o.name,
      icon: o.kind,
      detail: o.comment ?? undefined,
      load: hasCols
        ? async () => {
            const cols = await api.columns(c.id, db, schema, o.name);
            return cols.map((col) => ({
              key: `col|${c.id}|${db}|${schema}|${o.name}|${col.name}`,
              label: col.name,
              icon: col.pk ? "key" : "column",
              detail: col.dataType + (col.nullable ? "" : " NOT NULL"),
              menu: () => [{ label: "Copiar nome", icon: "copy", action: () => copyText(col.name) }],
            }));
          }
        : undefined,
      open: () => this.act.openObject(c, ref),
      menu: () => this.objectMenu(c, ref),
    };
    return n;
  }

  // ---------- menus ----------

  private connMenu(c: ConnConfig, n: Node): MenuItem[] {
    const on = store.connected.has(c.id);
    return [
      { label: "Nova console", icon: "console", shortcut: "Ctrl+Shift+L", action: () => this.act.openConsole(c) },
      on
        ? { label: "Desconectar", icon: "unplug", action: () => this.disconnect(c, n) }
        : { label: "Conectar", icon: "plug", action: () => this.expand(n) },
      { label: "Atualizar", icon: "refresh", shortcut: "F5", action: () => this.reload(n) },
      { separator: true },
      { label: "Backup…", icon: "backup", action: () => this.act.backup(c, c.database || (c.kind === "postgres" ? "postgres" : "")) },
      { label: "Restaurar…", icon: "restore", action: () => this.act.restore(c, c.database) },
      { label: "Criar database…", icon: "plus", action: () => this.createDatabase(c, n) },
      { separator: true },
      { label: "Propriedades…", icon: "edit", action: () => this.act.editConnection(c) },
      {
        label: "Duplicar",
        icon: "copy",
        action: () => store.save({ ...c, id: Date.now().toString(36), name: c.name + " (cópia)" }),
      },
      {
        label: "Excluir conexão",
        icon: "trash",
        danger: true,
        action: async () => {
          if (await confirmDialog("Excluir conexão", `Excluir a conexão "${c.name}"? Os dados do banco não são afetados.`, "Excluir", true))
            store.remove(c.id);
        },
      },
    ];
  }

  private dbMenu(c: ConnConfig, db: string, n: Node): MenuItem[] {
    return [
      { label: "Nova console", icon: "console", action: () => this.act.openConsole(c, db) },
      { label: "Atualizar", icon: "refresh", action: () => this.reload(n) },
      { separator: true },
      { label: "Backup…", icon: "backup", action: () => this.act.backup(c, db) },
      { label: "Restaurar…", icon: "restore", action: () => this.act.restore(c, db) },
      { separator: true },
      { label: "Copiar nome", icon: "copy", action: () => copyText(db) },
      ...(c.kind === "mysql"
        ? [{ label: "Criar tabela…", icon: "plus", action: () => this.createTableTemplate(c, db, db) } as MenuItem]
        : [{ label: "Criar schema…", icon: "plus", action: () => this.createSchema(c, db, n) } as MenuItem]),
      {
        label: c.kind === "mysql" ? "Excluir database (DROP)…" : "Excluir database (DROP)…",
        icon: "trash",
        danger: true,
        action: () => this.dropDatabase(c, db, n),
      },
    ];
  }

  private schemaMenu(c: ConnConfig, db: string, schema: string, n: Node): MenuItem[] {
    return [
      { label: "Nova console", icon: "console", action: () => this.act.openConsole(c, db, schema) },
      { label: "Atualizar", icon: "refresh", action: () => this.reload(n) },
      { separator: true },
      { label: "Backup do schema…", icon: "backup", action: () => this.act.backup(c, db, [schema]) },
      { label: "Criar tabela…", icon: "plus", action: () => this.createTableTemplate(c, db, schema) },
      { label: "Copiar nome", icon: "copy", action: () => copyText(schema) },
      {
        label: "Excluir schema (DROP)…",
        icon: "trash",
        danger: true,
        action: async () => {
          if (!(await confirmDialog("Excluir schema", `DROP SCHEMA ${schema} CASCADE?\nTodos os objetos do schema serão apagados.`, "Excluir", true))) return;
          await this.run(c, db, `DROP SCHEMA ${quoteIdent(c.kind, schema)} CASCADE`);
          if (n.parent) this.reload(n.parent);
        },
      },
    ];
  }

  private objectMenu(c: ConnConfig, ref: ObjectRef): MenuItem[] {
    const k = c.kind;
    const fq = qualified(k, ref.schema, ref.name);
    const isRel = ref.kind === "table" || ref.kind === "view" || ref.kind === "matview";
    const items: MenuItem[] = [];
    if (isRel) {
      items.push(
        { label: "Abrir dados", icon: "table", shortcut: "Enter", action: () => this.act.openObject(c, ref) },
        {
          label: "Gerar SQL",
          icon: "console",
          submenu: [
            { label: "SELECT", action: () => this.genSql(c, ref, "select") },
            ...(ref.kind === "table"
              ? [
                  { label: "INSERT", action: () => this.genSql(c, ref, "insert") },
                  { label: "UPDATE", action: () => this.genSql(c, ref, "update") },
                  { label: "DELETE", action: () => this.genSql(c, ref, "delete") },
                ]
              : []),
            { label: "DDL", action: () => this.genSql(c, ref, "ddl") },
          ],
        },
        {
          label: "Exportar dados",
          icon: "export",
          submenu: (["csv", "json", "sql", "md", "html"] as ExportFormat[]).map((f) => ({
            label: f.toUpperCase(),
            action: () => this.exportTable(c, ref, f),
          })),
        },
        {
          label: "Contar linhas",
          icon: "info",
          action: async () => {
            try {
              const [r] = await api.execute(c.id, ref.db, "meta-run", `SELECT COUNT(*) FROM ${fq}`);
              toast(`${ref.name}: ${Number(r.rows[0][0]).toLocaleString()} linha(s)`, "info", 5000);
            } catch (e) {
              toast(String(e), "error");
            }
          },
        },
      );
      if (ref.kind === "table")
        items.push({ label: "Backup da tabela…", icon: "backup", action: () => this.act.backup(c, ref.db, [], [k === "postgres" ? `${ref.schema}.${ref.name}` : ref.name]) });
    } else {
      items.push({ label: "Ver DDL", icon: "ddl", action: () => this.act.openObject(c, ref) });
    }
    items.push({ separator: true }, { label: "Copiar nome", icon: "copy", action: () => copyText(ref.name) }, { label: "Copiar nome qualificado", action: () => copyText(fq) });
    if (ref.kind === "table") {
      items.push({
        label: "Truncar…",
        icon: "trash",
        danger: true,
        action: async () => {
          if (await confirmDialog("Truncar tabela", `TRUNCATE ${fq}? Todos os dados serão apagados.`, "Truncar", true))
            this.run(c, ref.db, `TRUNCATE TABLE ${fq}`);
        },
      });
    }
    const dropKind: Record<string, string> = {
      table: "TABLE",
      view: "VIEW",
      matview: "MATERIALIZED VIEW",
      function: "FUNCTION",
      procedure: "PROCEDURE",
      sequence: "SEQUENCE",
      event: "EVENT",
    };
    if (dropKind[ref.kind]) {
      items.push({
        label: "Excluir (DROP)…",
        icon: "trash",
        danger: true,
        action: async () => {
          const target =
            (ref.kind === "function" || ref.kind === "procedure") && k === "postgres"
              ? `${quoteIdent(k, ref.schema)}.${quoteIdent(k, ref.name.split("(")[0])}(${ref.name.split("(").slice(1).join("(")}`
              : fq;
          if (await confirmDialog("Excluir objeto", `DROP ${dropKind[ref.kind]} ${target}?`, "Excluir", true)) {
            await this.run(c, ref.db, `DROP ${dropKind[ref.kind]} ${target}`);
            store.emit("ddl");
          }
        },
      });
    }
    return items;
  }

  private async genSql(c: ConnConfig, ref: ObjectRef, what: string) {
    const k = c.kind;
    const fq = qualified(k, ref.schema, ref.name);
    try {
      if (what === "ddl") {
        this.act.openConsole(c, ref.db, ref.schema, await api.ddl(c.id, ref.db, ref.schema, ref.name, ref.kind));
        return;
      }
      const cols = await api.columns(c.id, ref.db, ref.schema, ref.name);
      const names = cols.map((x) => quoteIdent(k, x.name));
      const pk = cols.filter((x) => x.pk);
      const where = (pk.length ? pk : cols.slice(0, 1)).map((x) => `${quoteIdent(k, x.name)} = ?`).join(" AND ");
      const sql =
        what === "select"
          ? `SELECT ${names.join(",\n       ")}\nFROM ${fq}\nLIMIT 100;`
          : what === "insert"
            ? `INSERT INTO ${fq} (${names.join(", ")})\nVALUES (${cols.map(() => "?").join(", ")});`
            : what === "update"
              ? `UPDATE ${fq}\nSET ${cols.filter((x) => !x.pk).map((x) => `${quoteIdent(k, x.name)} = ?`).join(",\n    ")}\nWHERE ${where};`
              : `DELETE FROM ${fq}\nWHERE ${where};`;
      this.act.openConsole(c, ref.db, ref.schema, sql);
    } catch (e) {
      toast(String(e), "error");
    }
  }

  private async exportTable(c: ConnConfig, ref: ObjectRef, f: ExportFormat) {
    try {
      const [r] = await api.execute(c.id, ref.db, "meta-run", `SELECT * FROM ${qualified(c.kind, ref.schema, ref.name)}`);
      if (r.truncated) toast(`Exportando somente as primeiras ${r.rows.length.toLocaleString()} linhas. Para tabelas grandes, use Backup.`, "info", 7000);
      await exportToFile(f, r.columns, r.rows, c.kind, ref.name, qualified(c.kind, ref.schema, ref.name));
    } catch (e) {
      toast(String(e), "error");
    }
  }

  private async run(c: ConnConfig, db: string, sql: string) {
    try {
      await store.connect(c.id);
      await api.execute(c.id, db, "meta-run", sql);
      store.addLog({ time: Date.now(), connName: c.name, db, sql, ok: true, message: "ok", elapsedMs: 0 });
      toast("Executado com sucesso", "ok");
      return true;
    } catch (e) {
      store.addLog({ time: Date.now(), connName: c.name, db, sql, ok: false, message: String(e), elapsedMs: 0 });
      toast(String(e), "error", 8000);
      return false;
    }
  }

  private async createDatabase(c: ConnConfig, n: Node) {
    const name = await promptDialog("Criar database", "Nome do novo database");
    if (!name) return;
    if (await this.run(c, c.kind === "postgres" ? c.database || "postgres" : "", `CREATE DATABASE ${quoteIdent(c.kind, name)}`)) this.reload(n);
  }

  private async createSchema(c: ConnConfig, db: string, n: Node) {
    const name = await promptDialog("Criar schema", "Nome do novo schema");
    if (!name) return;
    if (await this.run(c, db, `CREATE SCHEMA ${quoteIdent(c.kind, name)}`)) this.reload(n);
  }

  private createTableTemplate(c: ConnConfig, db: string, schema: string) {
    const k = c.kind;
    const t = qualified(k, schema, "nova_tabela");
    const sql =
      k === "postgres"
        ? `CREATE TABLE ${t} (\n    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n    nome       TEXT NOT NULL,\n    criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()\n);`
        : `CREATE TABLE ${t} (\n    id         BIGINT AUTO_INCREMENT PRIMARY KEY,\n    nome       VARCHAR(255) NOT NULL,\n    criado_em  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n);`;
    this.act.openConsole(c, db, schema, sql);
  }

  private async dropDatabase(c: ConnConfig, db: string, n: Node) {
    const typed = await promptDialog("Excluir database", `Esta ação apaga TODOS os dados de "${db}". Digite o nome do database para confirmar:`);
    if (typed !== db) {
      if (typed !== null) toast("Nome não confere — nada foi excluído", "error");
      return;
    }
    if (c.kind === "postgres") await api.closeChannel(c.id, db, "meta").catch(() => {});
    const admin = c.kind === "postgres" ? (db === "postgres" ? "template1" : "postgres") : "";
    if (await this.run(c, admin, `DROP DATABASE ${quoteIdent(c.kind, db)}`) && n.parent) this.reload(n.parent);
  }

  private async disconnect(c: ConnConfig, n: Node) {
    await store.disconnect(c.id);
    n.children = undefined;
    n.expanded = false;
    this.render();
  }

  // ---------- tree mechanics ----------

  private async expand(n: Node) {
    n.expanded = true;
    this.expandedKeys.add(n.key);
    if (!n.children && n.load) {
      n.loading = true;
      n.error = undefined;
      this.render();
      try {
        const kids = await n.load();
        for (const k of kids) k.parent = n;
        n.children = kids;
        // Re-expand previously expanded descendants.
        for (const k of kids) if (this.expandedKeys.has(k.key)) this.expand(k);
      } catch (e) {
        n.error = String(e);
        n.expanded = false;
        toast(String(e), "error", 8000);
      } finally {
        n.loading = false;
      }
    }
    if (n.children) for (const k of n.children) k.parent = n;
    this.render();
  }

  private collapse(n: Node) {
    n.expanded = false;
    this.expandedKeys.delete(n.key);
    this.render();
  }

  private toggle(n: Node) {
    if (n.expanded) this.collapse(n);
    else this.expand(n);
  }

  collapseAll() {
    const walk = (ns: Node[] | undefined) =>
      ns?.forEach((n) => {
        n.expanded = false;
        walk(n.children);
      });
    walk(this.roots);
    this.expandedKeys.clear();
    this.render();
  }

  async reload(n: Node) {
    if (n.key.startsWith("conn|")) store.invalidateCompletion(n.key.split("|")[1]);
    n.children = undefined;
    await this.expand(n);
  }

  refreshSelected(silent = false) {
    let n = this.selected;
    while (n && !n.load) n = n.parent ?? null;
    if (n && (n.children || !silent)) this.reload(n);
    else if (!silent) this.rebuild();
  }

  private visible(): { n: Node; depth: number }[] {
    const out: { n: Node; depth: number }[] = [];
    const q = this.filterI.value.trim().toLowerCase();
    const matches = (n: Node): boolean =>
      n.label.toLowerCase().includes(q) || (n.expanded && !!n.children?.some(matches)) || false;
    const walk = (ns: Node[], depth: number) => {
      for (const n of ns) {
        if (q && depth > 0 && !matches(n)) continue;
        out.push({ n, depth });
        if (n.expanded && n.children) walk(n.children, depth + 1);
      }
    };
    walk(this.roots, 0);
    return out;
  }

  render() {
    const rows = this.visible();
    if (!this.roots.length) {
      this.treeEl.replaceChildren(
        h(
          "div.tree-empty",
          null,
          h("p", null, "Nenhuma conexão ainda."),
          h("button.btn.primary", { onclick: () => this.act.newConnection() }, icon("plus"), "Nova conexão"),
        ),
      );
      return;
    }
    this.treeEl.replaceChildren(
      ...rows.map(({ n, depth }) => {
        const expandable = !!(n.load || n.children);
        const isConn = n.key.startsWith("conn|");
        const connId = isConn ? n.key.split("|")[1] : "";
        const row = h(
          "div.tree-row",
          {
            class: [n === this.selected && "selected", n.dim && "dim"].filter(Boolean).join(" "),
            style: `padding-left:${6 + depth * 16}px`,
          },
          h(
            "span.twisty",
            {
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                this.toggle(n);
              },
            },
            expandable ? icon(n.loading ? "refresh" : n.expanded ? "chevronD" : "chevronR", n.loading ? "spin" : "") : null,
          ),
          icon(n.icon),
          isConn ? h("span.conn-dot", { class: store.connected.has(connId) ? "on" : store.connecting.has(connId) ? "busy" : "" }) : null,
          h("span.tree-label", null, n.label),
          n.detail ? h("span.tree-detail", null, n.detail) : null,
          n.color ? h("span.tree-color", { style: `background:${n.color}` }) : null,
        );
        row.addEventListener("mousedown", () => {
          this.selected = n;
          this.treeEl.querySelectorAll(".tree-row.selected").forEach((x) => x.classList.remove("selected"));
          row.classList.add("selected");
        });
        row.addEventListener("dblclick", () => (n.open ? n.open() : this.toggle(n)));
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.selected = n;
          this.render();
          const m = n.menu?.();
          if (m?.length) contextMenu(e.clientX, e.clientY, m);
        });
        return row;
      }),
    );
  }

  private onKey(e: KeyboardEvent) {
    const rows = this.visible().map((r) => r.n);
    let i = this.selected ? rows.indexOf(this.selected) : -1;
    const sel = (j: number) => {
      j = Math.max(0, Math.min(rows.length - 1, j));
      this.selected = rows[j];
      this.render();
      this.treeEl.querySelector(".tree-row.selected")?.scrollIntoView({ block: "nearest" });
      e.preventDefault();
    };
    const n = this.selected;
    if (e.key === "ArrowDown") sel(i + 1);
    else if (e.key === "ArrowUp") sel(i - 1);
    else if (e.key === "ArrowRight" && n) {
      if (!n.expanded && (n.load || n.children)) this.expand(n);
      else sel(i + 1);
      e.preventDefault();
    } else if (e.key === "ArrowLeft" && n) {
      if (n.expanded) this.collapse(n);
      else if (n.parent) sel(rows.indexOf(n.parent));
      e.preventDefault();
    } else if (e.key === "Enter" && n) {
      n.open ? n.open() : this.toggle(n);
      e.preventDefault();
    } else if (e.key === "F5") {
      this.refreshSelected();
      e.preventDefault();
    } else if (e.key === "F4" && n) {
      const { conn } = this.ctxOf(n);
      if (conn && n.key.startsWith("conn|")) this.act.editConnection(conn);
      e.preventDefault();
    }
    if (i < 0) i = 0;
  }

  /** Flat list of loaded objects for "search everywhere". */
  loadedObjects(): { conn: ConnConfig; ref: ObjectRef }[] {
    const out: { conn: ConnConfig; ref: ObjectRef }[] = [];
    const walk = (ns?: Node[]) =>
      ns?.forEach((n) => {
        if (n.key.startsWith("obj|")) {
          const [, connId, db, schema, kind, ...name] = n.key.split("|");
          const conn = store.conn(connId);
          if (conn) out.push({ conn, ref: { connId, db, schema, kind, name: name.join("|") } });
        }
        walk(n.children);
      });
    walk(this.roots);
    return out;
  }
}
