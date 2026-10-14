// Table / view data editor tab.
import { api, type ColumnInfo, type ConnConfig } from "./api";
import { createEditor } from "./editor";
import { DataGrid, type Cell } from "./grid";
import { exportMenu, rowsToInsert } from "./export";
import { icon } from "./icons";
import { store } from "./state";
import type { Tab } from "./tabs";
import { button, confirmDialog, modal, toast } from "./ui";
import { formatDuration, h, qualified, quoteIdent, quoteLiteral } from "./util";

export interface ObjectRef {
  connId: string;
  db: string;
  schema: string;
  name: string;
  kind: string; // table | view | matview ...
}

const CHANNEL = "data";

export function createTableView(conn: ConnConfig, ref: ObjectRef, onOpenConsole: (sql: string) => void): Tab {
  const k = conn.kind;
  const fq = qualified(k, ref.schema, ref.name);
  const editable = ref.kind === "table" && !conn.readOnly;
  let columns: ColumnInfo[] = [];
  let pageSize = 200;
  let page = 0;
  let total: number | null = null;
  let orderBy = "";
  let loading = false;

  // ----- toolbar -----
  const status = h("span.dim");
  const pageInfo = h("span.page-info");
  const countBtn = h("button.tool-btn.text", { title: "Contar linhas", onclick: () => countRows() }, "Σ ?");
  const submitBtn = h("button.tool-btn.text.submit", { title: "Gravar alterações (Ctrl+Enter)", disabled: true, onclick: () => submit() }, icon("check"), "Gravar");
  const revertBtn = h("button.tool-btn", { title: "Desfazer alterações", disabled: true, onclick: () => grid.revert() }, icon("undo"));
  const previewBtn = h("button.tool-btn", { title: "Ver SQL das alterações", disabled: true, onclick: () => preview() }, icon("ddl"));
  const exportBtn = h("button.tool-btn", { title: "Exportar" }, icon("export"));
  const sizeSel = h(
    "select.select.small",
    {
      title: "Linhas por página",
      onchange: (e: Event) => {
        pageSize = Number((e.target as HTMLSelectElement).value);
        page = 0;
        load();
      },
    },
    ...[100, 200, 500, 1000, 5000].map((n) => h("option", { value: n, selected: n === pageSize }, String(n))),
  );
  const toolbar = h(
    "div.toolbar",
    null,
    h("button.tool-btn", { title: "Primeira página", onclick: () => goto(0) }, icon("first")),
    h("button.tool-btn", { title: "Página anterior", onclick: () => goto(page - 1) }, icon("left")),
    pageInfo,
    h("button.tool-btn", { title: "Próxima página", onclick: () => goto(page + 1) }, icon("right")),
    h("button.tool-btn", { title: "Última página", onclick: () => gotoLast() }, icon("last")),
    countBtn,
    sizeSel,
    h("span.tool-sep"),
    h("button.tool-btn", { title: "Recarregar (F5)", onclick: () => load() }, icon("refresh")),
    editable ? h("button.tool-btn", { title: "Adicionar linha (Alt+Insert)", onclick: () => grid.addRow() }, icon("plus")) : null,
    editable ? h("button.tool-btn", { title: "Excluir linha(s) (Delete)", onclick: () => grid.deleteSelectedRows() }, icon("minus")) : null,
    editable ? h("span.tool-sep") : null,
    editable ? revertBtn : null,
    editable ? previewBtn : null,
    editable ? submitBtn : null,
    h("span.tool-sep"),
    exportBtn,
    h("button.tool-btn", { title: "Abrir no console", onclick: () => onOpenConsole(buildSelect()) }, icon("console")),
    h("span.grow"),
    status,
  );

  // ----- filter bar -----
  const whereI = h("input.input.mono", { placeholder: "WHERE  ex.: id > 10 AND nome ILIKE '%a%'", spellcheck: false }) as HTMLInputElement;
  const orderI = h("input.input.mono", { placeholder: "ORDER BY", spellcheck: false }) as HTMLInputElement;
  for (const i of [whereI, orderI])
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        page = 0;
        total = null;
        orderBy = orderI.value.trim();
        load();
      }
    });
  const filterBar = h("div.filter-bar", null, icon("filter"), whereI, h("span.filter-sep"), orderI);

  const grid = new DataGrid({
    editable,
    onChange: () => updateDirty(),
    onSort: (c, dir) => {
      orderI.value = dir ? `${quoteIdent(k, grid.columns[c])} ${dir.toUpperCase()}` : "";
      orderBy = orderI.value;
      load(true);
      return true;
    },
    onFilterByValue: (c, v) => {
      const col = quoteIdent(k, grid.columns[c]);
      whereI.value = v === null ? `${col} IS NULL` : `${col} = ${quoteLiteral(k, v)}`;
      page = 0;
      total = null;
      load();
    },
    copyAsInsert: (rows) => rowsToInsert(k, fq, grid.columns, rows.map((r) => grid.rows[r])),
  });
  exportBtn.onclick = () => exportMenu(exportBtn, () => ({ columns: grid.columns, rows: grid.rows }), k, ref.name, fq);

  const dataPane = h("div.data-pane", null, filterBar, grid.el);
  const colsPane = h("div.info-pane");
  const idxPane = h("div.info-pane");
  const ddlPane = h("div.ddl-pane");

  // ----- sub tabs -----
  const panes: [string, string, HTMLElement][] = [
    ["Dados", "table", dataPane],
    ["Colunas", "column", colsPane],
    ...(ref.kind === "table" ? ([["Índices", "index", idxPane]] as [string, string, HTMLElement][]) : []),
    ["DDL", "ddl", ddlPane],
  ];
  const subTabs = h("div.subtabs");
  const paneHost = h("div.pane-host");
  let activePane = 0;
  const showPane = (i: number) => {
    activePane = i;
    subTabs.replaceChildren(
      ...panes.map(([label, ic], j) => h("div.subtab", { class: j === i ? "active" : "", onclick: () => showPane(j) }, icon(ic), label)),
    );
    paneHost.replaceChildren(panes[i][2]);
    if (panes[i][2] === colsPane) renderColumns();
    if (panes[i][2] === idxPane) renderIndexes();
    if (panes[i][2] === ddlPane) renderDdl();
    if (i === 0) grid.renderRows();
  };

  const el = h("div.table-view", null, toolbar, paneHost, subTabs);
  el.addEventListener("keydown", (e) => {
    if (e.key === "F5") {
      e.preventDefault();
      load();
    } else if (e.key === "Insert" && e.altKey && editable) grid.addRow();
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && grid.dirty) submit();
  });

  function buildSelect(limit = true) {
    const where = whereI.value.trim();
    let s = `SELECT * FROM ${fq}`;
    if (where) s += ` WHERE ${where}`;
    if (orderBy) s += ` ORDER BY ${orderBy}`;
    if (limit) s += ` LIMIT ${pageSize} OFFSET ${page * pageSize}`;
    return s;
  }

  function updateDirty() {
    const n = grid.dirty;
    submitBtn.disabled = revertBtn.disabled = previewBtn.disabled = n === 0;
    submitBtn.lastChild!.textContent = n ? `Gravar (${n})` : "Gravar";
    tab.title = (n ? "● " : "") + ref.name;
    store.emit("tabs");
  }

  function renderPageInfo() {
    const from = grid.rowCount ? page * pageSize + 1 : 0;
    const to = page * pageSize + grid.rowCount;
    pageInfo.textContent = `${from}-${to}${total !== null ? ` de ${total.toLocaleString()}` : ""}`;
    countBtn.textContent = total !== null ? `Σ ${total.toLocaleString()}` : "Σ ?";
  }

  async function load(keepSort = false) {
    if (loading) return;
    if (grid.dirty && !(await confirmDialog("Alterações pendentes", "Descartar as alterações não gravadas?", "Descartar", true))) return;
    loading = true;
    status.textContent = "Carregando…";
    el.classList.add("busy");
    try {
      await store.connect(conn.id);
      if (!columns.length) columns = await api.columns(conn.id, ref.db, ref.schema, ref.name);
      const t0 = performance.now();
      const [r] = await api.execute(conn.id, ref.db, CHANNEL, buildSelect());
      grid.setData(r.columns, r.rows, keepSort);
      status.textContent = `${r.rows.length} linha(s) · ${formatDuration(Math.round(performance.now() - t0))}`;
      renderPageInfo();
      updateDirty();
    } catch (e) {
      status.textContent = "";
      grid.setData([], []);
      toast(String(e), "error", 8000);
    } finally {
      loading = false;
      el.classList.remove("busy");
    }
  }

  async function countRows() {
    try {
      const where = whereI.value.trim();
      const [r] = await api.execute(conn.id, ref.db, CHANNEL, `SELECT COUNT(*) FROM ${fq}${where ? ` WHERE ${where}` : ""}`);
      total = Number(r.rows[0][0]);
      renderPageInfo();
    } catch (e) {
      toast(String(e), "error");
    }
  }

  function goto(p: number) {
    if (p < 0 || (total !== null && p * pageSize >= total) || (p > page && grid.rowCount < pageSize)) return;
    page = p;
    load(true);
  }

  async function gotoLast() {
    if (total === null) await countRows();
    if (total !== null) goto(Math.max(0, Math.ceil(total / pageSize) - 1));
  }

  // ----- DML generation -----
  function whereFor(ri: number): string {
    const orig = grid.original[ri];
    const pks = columns.filter((c) => c.pk).map((c) => grid.columns.indexOf(c.name)).filter((i) => i >= 0);
    const idx = pks.length ? pks : grid.columns.map((_, i) => i);
    const cond = idx
      .map((i) => {
        const col = quoteIdent(k, grid.columns[i]);
        const v = orig[i];
        return v === null ? `${col} IS NULL` : `${col} = ${quoteLiteral(k, v)}`;
      })
      .join(" AND ");
    if (pks.length) return cond;
    return k === "postgres" ? `ctid = (SELECT ctid FROM ${fq} WHERE ${cond} LIMIT 1)` : `${cond} LIMIT 1`;
  }

  function buildDml(): string[] {
    const out: string[] = [];
    const { updated, inserted, deleted } = grid.changes;
    for (const [ri, cols] of updated) {
      if (deleted.has(ri)) continue;
      const set = [...cols].map(([c, v]) => `${quoteIdent(k, grid.columns[c])} = ${quoteLiteral(k, v)}`).join(", ");
      out.push(`UPDATE ${fq} SET ${set} WHERE ${whereFor(ri)}`);
    }
    for (const ri of inserted) {
      const row = grid.rows[ri];
      const idx = row.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
      if (!idx.length) {
        out.push(k === "postgres" ? `INSERT INTO ${fq} DEFAULT VALUES` : `INSERT INTO ${fq} () VALUES ()`);
        continue;
      }
      out.push(
        `INSERT INTO ${fq} (${idx.map((i) => quoteIdent(k, grid.columns[i])).join(", ")}) VALUES (${idx.map((i) => quoteLiteral(k, row[i] as Cell)).join(", ")})`,
      );
    }
    for (const ri of deleted) out.push(`DELETE FROM ${fq} WHERE ${whereFor(ri)}`);
    return out;
  }

  function preview() {
    const sqlText = buildDml().map((s) => s + ";").join("\n");
    const m = modal("Alterações pendentes", { width: 780 });
    const host = h("div.ddl-preview");
    m.body.append(host);
    createEditor(host, sqlText, k).setReadOnly(true);
    m.footer.append(
      button("Abrir no console", () => {
        m.close();
        onOpenConsole(sqlText);
      }, "", "console"),
      button("Fechar", () => m.close()),
      button("Gravar", () => {
        m.close();
        submit();
      }, "primary", "check"),
    );
  }

  async function submit() {
    const stmts = buildDml();
    if (!stmts.length) return;
    if (!columns.some((c) => c.pk) && (grid.changes.updated.size || grid.changes.deleted.size)) {
      const ok = await confirmDialog("Tabela sem chave primária", "Esta tabela não tem chave primária. As linhas serão localizadas comparando todas as colunas. Continuar?", "Continuar");
      if (!ok) return;
    }
    const begin = k === "postgres" ? "BEGIN" : "START TRANSACTION";
    try {
      await api.execute(conn.id, ref.db, CHANNEL, begin);
      for (const s of stmts) await api.execute(conn.id, ref.db, CHANNEL, s);
      await api.execute(conn.id, ref.db, CHANNEL, "COMMIT");
      for (const s of stmts) store.addLog({ time: Date.now(), connName: conn.name, db: ref.db, sql: s, ok: true, message: "ok", elapsedMs: 0 });
      toast(`${stmts.length} alteração(ões) gravada(s)`, "ok");
      grid.changes = { updated: new Map(), inserted: new Set(), deleted: new Set() };
      updateDirty();
      load(true);
    } catch (e) {
      await api.execute(conn.id, ref.db, CHANNEL, "ROLLBACK").catch(() => {});
      store.addLog({ time: Date.now(), connName: conn.name, db: ref.db, sql: stmts.join(";\n"), ok: false, message: String(e), elapsedMs: 0 });
      toast(`Erro ao gravar — nada foi alterado.\n${e}`, "error", 10000);
    }
  }

  // ----- info panes -----
  async function renderColumns() {
    try {
      if (!columns.length) columns = await api.columns(conn.id, ref.db, ref.schema, ref.name);
      colsPane.replaceChildren(
        h(
          "table.info-table",
          null,
          h("thead", null, h("tr", null, ...["#", "Nome", "Tipo", "Nulo", "Default", "Comentário"].map((x) => h("th", null, x)))),
          h(
            "tbody",
            null,
            ...columns.map((c, i) =>
              h(
                "tr",
                null,
                h("td.dim", null, String(i + 1)),
                h("td", null, c.pk ? icon("key") : icon("column"), " ", c.name),
                h("td.mono.type", null, c.dataType),
                h("td", null, c.nullable ? "sim" : "NOT NULL"),
                h("td.mono", null, c.default ?? ""),
                h("td.dim", null, c.comment ?? ""),
              ),
            ),
          ),
        ),
      );
    } catch (e) {
      colsPane.textContent = String(e);
    }
  }

  async function renderIndexes() {
    try {
      const idx = await api.indexes(conn.id, ref.db, ref.schema, ref.name);
      idxPane.replaceChildren(
        h(
          "table.info-table",
          null,
          h("thead", null, h("tr", null, ...["Nome", "Colunas", "Único", "Primário"].map((x) => h("th", null, x)))),
          h(
            "tbody",
            null,
            ...idx.map((i) =>
              h("tr", null, h("td", null, icon(i.primary ? "key" : "index"), " ", i.name), h("td.mono", null, i.columns), h("td", null, i.unique ? "sim" : ""), h("td", null, i.primary ? "sim" : "")),
            ),
          ),
        ),
      );
      if (!idx.length) idxPane.append(h("div.empty-note", null, "Nenhum índice."));
    } catch (e) {
      idxPane.textContent = String(e);
    }
  }

  let ddlLoaded = false;
  async function renderDdl() {
    if (ddlLoaded) return;
    ddlLoaded = true;
    try {
      const ddl = await api.ddl(conn.id, ref.db, ref.schema, ref.name, ref.kind);
      ddlPane.replaceChildren();
      createEditor(ddlPane, ddl, k).setReadOnly(true);
    } catch (e) {
      ddlPane.textContent = String(e);
      ddlLoaded = false;
    }
  }

  const tab: Tab = {
    id: `table:${ref.connId}:${ref.db}:${ref.schema}:${ref.name}`,
    title: ref.name,
    icon: ref.kind === "view" || ref.kind === "matview" ? "view" : "table",
    color: conn.color || undefined,
    tooltip: `${conn.name} · ${ref.db}${ref.schema !== ref.db ? "." + ref.schema : ""}.${ref.name}`,
    el,
    canClose: async () => !grid.dirty || confirmDialog("Alterações pendentes", `Descartar alterações em ${ref.name}?`, "Descartar", true),
    onActivate: () => grid.renderRows(),
  };
  showPane(activePane);
  load();
  return tab;
}

/** Read-only DDL tab for functions, procedures, triggers, sequences. */
export function createDdlTab(conn: ConnConfig, ref: ObjectRef, onOpenConsole: (sql: string) => void): Tab {
  const host = h("div.ddl-pane");
  const el = h(
    "div.table-view",
    null,
    h(
      "div.toolbar",
      null,
      h("button.tool-btn.text", { onclick: () => onOpenConsole(text) }, icon("console"), "Editar no console"),
      h("span.grow"),
      h("span.dim", null, `${ref.kind} · ${ref.schema}`),
    ),
    host,
  );
  let text = "";
  api
    .ddl(conn.id, ref.db, ref.schema, ref.name, ref.kind)
    .then((d) => {
      text = d;
      createEditor(host, d, conn.kind).setReadOnly(true);
    })
    .catch((e) => (host.textContent = String(e)));
  return {
    id: `ddl:${ref.connId}:${ref.db}:${ref.schema}:${ref.kind}:${ref.name}`,
    title: ref.name.replace(/\(.*\)$/, "()"),
    icon: ref.kind,
    color: conn.color || undefined,
    tooltip: `${conn.name} · ${ref.schema}.${ref.name}`,
    el,
  };
}
