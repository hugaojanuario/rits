// SQL console tab: editor + results.
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, type ConnConfig, type QueryResult } from "./api";
import { createEditor, formatSql, statementAt, type EditorHandle } from "./editor";
import { fileIconName } from "./icons";
import { host, P } from "./ide/host";
import { DataGrid } from "./grid";
import { exportMenu, rowsToInsert } from "./export";
import { icon } from "./icons";
import { store } from "./state";
import type { Tab } from "./tabs";
import { button, confirmDialog, dropdown, makeSplitter, modal, toast } from "./ui";
import { debounce, formatDuration, h, splitSql, uid } from "./util";
import { sqlParams, tableRefs, type Stmt } from "./sqlscan";
import type { ObjectRef } from "./tableView";
import { EditorView } from "@codemirror/view";
import { dialect } from "./dialects";

export interface ConsoleState {
  id: string;
  /** "" = no connection yet (a SQL script that was never bound). */
  connId: string;
  db: string;
  schema: string;
  title: string;
  text: string;
  /** Set for SQL scripts: the .sql file the tab edits (auto-saved). */
  file?: string;
}

export interface ConsoleHooks {
  onPersist: () => void;
  /** Opens a .sql file in its own script tab, bound to this console's connection. */
  openScript?: (path: string, conn: ConnConfig | null, db: string, schema: string) => void;
  /** Ctrl/Cmd+click on a table name: opens its data. */
  openTable?: (c: ConnConfig, ref: ObjectRef) => void;
  /** A script changed its file, connection, database or schema (`oldFile`: it was renamed). */
  scriptBound?: (state: ConsoleState, oldFile?: string) => void;
}

export interface ConsoleTab extends Tab {
  kind: "console";
  state: ConsoleState;
  editor: EditorHandle;
  insertText: (text: string, run?: boolean) => void;
  setConnection: (c: ConnConfig | null, db?: string, schema?: string) => void;
}

let counter = 0;

export function createConsole(
  initialConn: ConnConfig | null,
  init: Partial<ConsoleState>,
  hooks: ConsoleHooks,
): ConsoleTab {
  let conn = initialConn;
  const onPersist = hooks.onPersist;
  const state: ConsoleState = {
    id: init.id ?? uid(),
    connId: conn?.id ?? "",
    db: init.db ?? conn?.database ?? "",
    schema: init.schema ?? "",
    title: init.file ? P.base(init.file) : (init.title ?? `${conn?.name ?? "Console"}${++counter > 1 ? ` [${counter}]` : ""}`),
    text: init.text ?? "",
    file: init.file,
  };
  const channel = "console-" + state.id;
  const kind = () => conn?.kind ?? "postgres";
  let running = false;
  let manualTx = false;
  let inTx = false;

  // --- toolbar ---
  const runBtn = h("button.tool-btn", { title: "Executar instrução (Ctrl+Enter)", onclick: () => run("current") }, icon("play"));
  const runAllBtn = h("button.tool-btn", { title: "Executar script (Ctrl+Shift+Enter)", onclick: () => run("all") }, icon("playAll"));
  const explainBtn = h("button.tool-btn", { title: "Explain plan (Ctrl+Shift+E)", onclick: () => run("explain") }, icon("explain"));
  const stopBtn = h("button.tool-btn", { title: "Cancelar execução", disabled: true, onclick: () => cancel() }, icon("stop"));
  const txBtn = h("button.tool-btn.text", { title: "Modo de transação", onclick: () => txMenu() }, "Tx: Auto");
  const commitBtn = h("button.tool-btn", { title: "Commit", style: "display:none", onclick: () => endTx("COMMIT") }, icon("commit"));
  const rollbackBtn = h("button.tool-btn", { title: "Rollback", style: "display:none", onclick: () => endTx("ROLLBACK") }, icon("rollback"));
  const connBtn = h("button.tool-btn.text.ctx", { title: "Conexão", onclick: () => connMenu() });
  const dbBtn = h("button.tool-btn.text.ctx", { title: "Database / schema", onclick: () => ctxMenu() });
  const toolbar = h(
    "div.toolbar",
    null,
    runBtn,
    runAllBtn,
    explainBtn,
    stopBtn,
    h("span.tool-sep"),
    txBtn,
    commitBtn,
    rollbackBtn,
    h("span.tool-sep"),
    h("button.tool-btn", { title: "Formatar SQL (Ctrl+Alt+L)", onclick: () => format() }, icon("format")),
    h("button.tool-btn", { title: "Abrir arquivo .sql", onclick: () => openFile() }, icon("open")),
    h("button.tool-btn", { title: "Salvar como script .sql (Ctrl+S)", onclick: () => saveFile() }, icon("save")),
    h("span.grow"),
    connBtn,
    dbBtn,
  );

  // --- editor ---
  const editorHost = h("div.editor-host");
  const persist = debounce(onPersist, 600);
  // SQL script: the text lives in the file, auto-saved like the code editors
  let savedText = state.text;
  let loading = false;
  let saveTimer: number | undefined;
  let lastWrite = 0;
  let crlf = false;
  const editor = createEditor(
    editorHost,
    state.text,
    kind(),
    [
      { key: "Mod-Enter", run: () => (run("current"), true), preventDefault: true },
      { key: "Mod-Shift-Enter", run: () => (run("all"), true), preventDefault: true },
      { key: "Mod-Shift-e", run: () => (run("explain"), true), preventDefault: true },
      { key: "Mod-Alt-l", run: () => (format(), true), preventDefault: true },
      { key: "Mod-s", run: () => (saveFile(), true), preventDefault: true },
    ],
    (text) => {
      state.text = text;
      if (state.file) {
        if (loading) return;
        markDirty();
        clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => flush(), 1500);
      } else persist();
    },
    [
      EditorView.domEventHandlers({
        mousedown: (e, view) => {
          if (e.button !== 0 || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null || !conn) return false;
          const ref = tableRefs(view.state.doc.toString(), conn.kind).refs.find((r) => pos >= r.from && pos <= r.to);
          if (!ref) return false;
          e.preventDefault();
          void openRef(ref.schema, ref.name);
          return true;
        },
      }),
    ],
  );

  /** Opens the data of a table named in the script (Ctrl/Cmd+click). */
  async function openRef(schema: string | null, name: string) {
    const c = conn;
    if (!c || !hooks.openTable) return;
    try {
      await store.connect(c.id);
      const tables = await store.completionFor(c.id, state.db);
      const def = state.schema || (c.kind === "postgres" ? "public" : state.db);
      const lower = name.toLowerCase();
      const hit =
        tables.find((t) => t.table.toLowerCase() === lower && (schema ? t.schema.toLowerCase() === schema.toLowerCase() : t.schema === def)) ??
        (schema ? undefined : tables.find((t) => t.table.toLowerCase() === lower));
      const sch = hit ? hit.schema || (dialect(c.kind).schemas ? def : state.db) : (schema ?? (dialect(c.kind).schemas ? def : state.db));
      const objs = await api.objects(c.id, state.db, sch).catch(() => []);
      const obj = objs.find((o) => o.name.toLowerCase() === lower);
      if (!obj && !hit) return toast(`Tabela "${name}" não encontrada.`);
      hooks.openTable(c, { connId: c.id, db: state.db, schema: sch, name: obj?.name ?? hit!.table, kind: obj?.kind ?? "table" });
    } catch (e) {
      toast(String(e), "error");
    }
  }

  const markDirty = () => {
    const dirty = !!state.file && state.text !== savedText;
    if (dirty !== (tab.cls === "modified")) {
      tab.cls = dirty ? "modified" : "";
      store.emit("tabs");
    }
  };

  async function flush() {
    clearTimeout(saveTimer);
    if (!state.file || state.text === savedText) return;
    const text = state.text;
    try {
      lastWrite = Date.now();
      await host.write(state.file, text, crlf);
      savedText = text;
      markDirty();
    } catch (e) {
      toast(`Não foi possível salvar ${P.base(state.file)}: ${e}`, "error");
    }
  }

  /** Reads the file again (external change); keeps unsaved edits. */
  async function reload(first = false) {
    if (!state.file || (!first && Date.now() - lastWrite < 1500)) return;
    try {
      const f = await host.read(state.file);
      if (f.binary) return;
      crlf = f.crlf;
      if (f.text === savedText && !first) return;
      if (!first && state.text !== savedText) return;
      savedText = f.text;
      loading = true;
      const v = editor.view;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: f.text } });
      loading = false;
      state.text = f.text;
      markDirty();
    } catch (e) {
      loading = false;
      if (first) logLine("err", `Não foi possível ler ${state.file}: ${e}`);
    }
  }

  // --- results ---
  const resultTabs = h("div.result-tabs");
  const resultBody = h("div.result-body");
  const resultsPane = h("div.results-pane", null, resultTabs, resultBody);
  const splitter = h("div.splitter-y");
  const el = h("div.console", null, toolbar, editorHost, splitter, resultsPane);
  makeSplitter(splitter, resultsPane, "y", "console-results", true, 60);

  interface ResultView {
    title: string;
    el: HTMLElement;
    grid?: DataGrid;
  }
  let views: ResultView[] = [];
  let activeView = 0;
  const output = h("div.output");
  const outputView: ResultView = { title: "Saída", el: output };

  const renderResultTabs = () => {
    const all = [...views, outputView];
    resultTabs.replaceChildren(
      ...all.map((v, i) =>
        h(
          "div.rtab",
          { class: i === activeView ? "active" : "", onclick: () => showView(i) },
          icon(v === outputView ? "log" : "table"),
          v.title,
        ),
      ),
    );
    resultBody.replaceChildren(all[activeView]?.el ?? output);
    all[activeView]?.grid?.renderRows();
  };
  const showView = (i: number) => {
    activeView = i;
    renderResultTabs();
  };

  const logLine = (cls: string, text: string) => {
    const t = new Date().toLocaleTimeString();
    output.append(h("div.out-line", { class: cls }, h("span.out-time", null, t), h("span.out-text", null, text)));
    output.scrollTop = output.scrollHeight;
  };

  const makeResultView = (c: ConnConfig, r: QueryResult, sqlText: string, n: number, index: number): ResultView => {
    const db = state.db;
    const grid = new DataGrid({
      copyAsInsert: (rows) => rowsToInsert(c.kind, guessTable(sqlText), r.columns, rows.map((i) => r.rows[i])),
    });
    grid.setData(r.columns, r.rows);
    const exportBtn = h("button.btn.small.export-btn", { title: "Exportar o resultado (CSV, Excel, JSON, XML…)" }, icon("export"), "Exportar", icon("general/chevronDown"));
    exportBtn.onclick = () =>
      exportMenu(exportBtn, () => ({ columns: r.columns, rows: r.rows }), c.kind, guessTable(sqlText).replace(/[`"]/g, "") || "resultado", undefined, {
        full: { connId: c.id, db, sql: sqlText, truncated: r.truncated },
      });
    const info = h("div.result-info");
    const renderInfo = () => {
      // only queries are executed again; running an UPDATE twice to get more rows would change data twice
      const more = r.truncated && /^\s*(\(\s*)?(select|with|values|table|show|explain|describe|desc|pragma|call|exec)\b/i.test(sqlText) && r.rows.length < MAX_ROWS_CAP;
      info.replaceChildren(
        h("span", null, `${r.rows.length.toLocaleString()} linha(s)`),
        r.truncated ? h("span.warn", null, ` — limitado às primeiras ${r.rows.length.toLocaleString()}`) : "",
        h("span.dim", null, ` · ${formatDuration(r.elapsedMs)}`),
        more ? h("button.btn.small.fetch-more", { title: "Executa a consulta de novo, trazendo mais 50 mil linhas", onclick: () => fetchMore(r.rows.length + PAGE) }, "Buscar mais") : "",
        more ? h("button.btn.small.fetch-more", { title: `Executa a consulta de novo, trazendo até ${MAX_ROWS_CAP.toLocaleString()} linhas`, onclick: () => fetchMore(MAX_ROWS_CAP) }, "Buscar tudo") : "",
        h("span.grow"),
        exportBtn,
      );
    };
    const fetchMore = async (limit: number) => {
      if (running) return;
      if (conn?.id !== c.id || state.db !== db) return toast("A conexão do console mudou desde esta execução.");
      setRunning(true);
      try {
        const res = (await api.execute(c.id, db, channel, sqlText, limit)).filter((x) => x.hasRows)[index];
        if (!res) throw new Error("A consulta não devolveu linhas desta vez.");
        r = res;
        grid.setData(r.columns, r.rows);
        logLine("ok", `${r.rows.length.toLocaleString()} linha(s) obtida(s) em ${formatDuration(r.elapsedMs)}${r.truncated ? " (ainda há mais)" : ""}`);
        renderInfo();
      } catch (e) {
        logLine("err", String(e));
      } finally {
        setRunning(false);
      }
    };
    renderInfo();
    return { title: `Resultado ${n}`, el: h("div.result-view", null, info, grid.el), grid };
  };

  const setRunning = (v: boolean) => {
    running = v;
    stopBtn.disabled = !v;
    runBtn.disabled = runAllBtn.disabled = explainBtn.disabled = v;
    el.classList.toggle("busy", v);
  };

  async function exec(sqlText: string) {
    if (!conn) throw new Error("Escolha uma conexão.");
    return api.execute(conn.id, state.db, channel, sqlText);
  }

  async function ensureSchema() {
    if (conn?.kind === "postgres" && state.schema && !schemaApplied) {
      await exec(`SET search_path TO ${quoteSchema(state.schema)}, public`);
      schemaApplied = true;
    }
  }
  let schemaApplied = false;
  const quoteSchema = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);

  /** Points at the error in the editor when the database says where it is. */
  function markError(st: Stmt, msg: string, exact: boolean) {
    const doc = editor.view.state.doc;
    if (doc.sliceString(st.from, st.to) !== st.text) return;
    const pos = exact ? /Posição: (\d+)/.exec(msg) : null;
    let from = -1;
    if (pos) from = st.from + Math.min(Number(pos[1]) - 1, st.text.length - 1);
    else {
      // MySQL, SQLite, SQL Server, DuckDB: "... near 'text' [at line N]"
      const near = /near ["'](.*?)["']( at line (\d+))?/is.exec(msg);
      if (near) {
        const lines = st.text.split("\n");
        const skip = near[3] ? lines.slice(0, Number(near[3]) - 1).join("\n").length + (Number(near[3]) > 1 ? 1 : 0) : 0;
        const probe = near[1].slice(0, 40);
        const at = probe ? st.text.indexOf(probe, skip) : -1;
        if (at >= 0) from = st.from + at;
        else if (!probe && near[3]) from = st.to - 1;
      }
    }
    const first = msg.split("\n")[0];
    if (from < 0) return editor.setExecError({ from: st.from, to: doc.lineAt(st.from).to, message: first });
    const word = /^[\w$#@."`[\]]+/.exec(doc.sliceString(from, Math.min(from + 80, doc.length)));
    editor.setExecError({ from, to: from + (word ? word[0].length : 1), message: first });
  }

  async function run(mode: "current" | "all" | "explain") {
    if (running) return;
    const c = conn;
    if (!c) {
      toast("Escolha a conexão do script para executar.");
      connMenu();
      return;
    }
    if (!store.connected.has(c.id)) store.connect(c.id).then(() => refreshCompletion(), () => {});
    const view = editor.view;
    const sel = view.state.selection.main;
    const text = view.state.doc.toString();
    let statements: Stmt[];
    if (!sel.empty) statements = splitSql(view.state.sliceDoc(sel.from, sel.to), c.kind).map((s) => ({ ...s, from: s.from + sel.from, to: s.to + sel.from }));
    else if (mode === "all") statements = splitSql(text, c.kind);
    else {
      const st = statementAt(text, sel.head, c.kind);
      statements = st ? [st] : [];
    }
    if (!statements.length) {
      toast("Nada para executar");
      return;
    }
    if (mode === "explain") {
      const ex = dialect(c.kind).explain;
      if (!ex) return toast(`EXPLAIN não está disponível para ${dialect(c.kind).label} no console.`);
      statements = [{ ...statements[0], text: ex(statements[0].text) }];
    }
    // :name, ${name}, ? and $1: the values are asked once and written into the SQL
    const params = statements.map((st) => sqlParams(st.text, c.kind));
    let texts = statements.map((st) => st.text);
    if (params.some((p) => p.length)) {
      const values = await askParams(params.flat().map((p) => p.name));
      if (!values) return;
      let q = 0;
      texts = statements.map((st, i) => {
        let t = st.text;
        const ps = params[i];
        const vals = ps.map((p) => (p.name === "?" ? values.positional[q++] : values.named.get(p.name)!));
        for (let k = ps.length - 1; k >= 0; k--) t = t.slice(0, ps[k].from) + vals[k] + t.slice(ps[k].to);
        return t;
      });
    }
    if (c.readOnly === false && texts.some((s) => /^\s*(drop|truncate)\s/i.test(s)) && !manualTx) {
      const ok = await confirmDialog("Instrução destrutiva", `Executar ${statements.length > 1 ? "script com " : ""}DROP/TRUNCATE em "${c.name}"?`, "Executar", true);
      if (!ok) return;
    }

    editor.setExecError(null);
    setRunning(true);
    views = [];
    let n = 0;
    const started = performance.now();
    try {
      await store.connect(c.id);
      await ensureSchema();
      if (manualTx && !inTx && c.kind === "postgres") {
        await exec("BEGIN");
        setTx(true);
      }
      let skipErrors = false;
      let failed = 0;
      for (const [i, st] of statements.entries()) {
        const s = texts[i];
        const t0 = performance.now();
        try {
          const results = await exec(s);
          const ms = Math.round(performance.now() - t0);
          let idx = 0;
          for (const r of results) {
            if (r.hasRows) {
              views.push(makeResultView(c, r, s, ++n, idx++));
              logLine("ok", `${r.rows.length} linha(s) obtida(s) em ${formatDuration(r.elapsedMs)}`);
            } else {
              logLine("ok", `${r.affected ?? 0} linha(s) afetada(s) em ${formatDuration(ms)}`);
            }
          }
          if (/^\s*(commit|rollback|end)\b/i.test(s)) setTx(false);
          if (/^\s*(begin|start\s+transaction)\b/i.test(s)) setTx(true);
          if (/^\s*(create|alter|drop|rename)\s/i.test(s)) store.invalidateCompletion(c.id), store.emit("ddl");
          store.addLog({ time: Date.now(), connName: c.name, db: state.db, sql: s, ok: true, message: results.map((r) => (r.hasRows ? `${r.rows.length} linhas` : `${r.affected ?? 0} afetadas`)).join(", "), elapsedMs: ms });
          store.addHistory({ time: Date.now(), connId: c.id, db: state.db, sql: s });
        } catch (e) {
          const ms = Math.round(performance.now() - t0);
          logLine("cmd", s.length > 300 ? s.slice(0, 300) + "…" : s);
          logLine("err", String(e));
          if (mode !== "explain") markError(st, String(e), s === st.text);
          store.addLog({ time: Date.now(), connName: c.name, db: state.db, sql: s, ok: false, message: String(e), elapsedMs: ms });
          store.addHistory({ time: Date.now(), connId: c.id, db: state.db, sql: s });
          if (manualTx) setTx(true);
          failed++;
          // the rest of the script: stop, skip this error or skip all of them (like DataGrip)
          const left = statements.length - i - 1;
          const choice = left > 0 ? (skipErrors ? "skip" : await askOnError(String(e), i + 1, statements.length)) : "stop";
          if (choice === "all") skipErrors = true;
          if (choice === "stop") {
            if (left > 0) logLine("info", `Script interrompido na instrução ${i + 1} de ${statements.length}.`);
            activeView = views.length;
            renderResultTabs();
            return;
          }
        }
      }
      if (statements.length > 1)
        logLine(failed ? "err" : "info", `Script concluído: ${statements.length} instruções em ${formatDuration(Math.round(performance.now() - started))}${failed ? `, ${failed} com erro` : ""}`);
      activeView = views.length ? 0 : views.length;
      renderResultTabs();
    } catch (e) {
      logLine("err", String(e));
      activeView = views.length;
      renderResultTabs();
    } finally {
      setRunning(false);
    }
  }

  async function cancel() {
    if (!conn) return;
    try {
      await api.cancel(conn.id, state.db, channel);
      logLine("info", "Cancelamento solicitado");
    } catch (e) {
      toast(String(e), "error");
    }
  }

  function setTx(v: boolean) {
    inTx = v;
    commitBtn.style.display = rollbackBtn.style.display = manualTx ? "" : "none";
    txBtn.classList.toggle("pending", inTx && manualTx);
    txBtn.textContent = manualTx ? (inTx ? "Tx: Manual •" : "Tx: Manual") : "Tx: Auto";
  }

  function txMenu() {
    dropdown(txBtn, [
      { label: "Auto-commit", icon: !manualTx ? "check" : undefined, action: () => setTxMode(false) },
      { label: "Manual (commit/rollback)", icon: manualTx ? "check" : undefined, action: () => setTxMode(true) },
    ]);
  }

  async function setTxMode(manual: boolean) {
    if (manual === manualTx) return;
    if (!manual && inTx) {
      const ok = await confirmDialog("Transação aberta", "Fazer COMMIT da transação atual antes de voltar ao auto-commit?", "Commit");
      if (ok) await endTx("COMMIT");
      else await endTx("ROLLBACK");
    }
    const c = conn;
    if (c && (c.kind === "mysql" || viaDriver(c))) {
      try {
        await store.connect(c.id);
        if (c.kind === "mysql") await exec(`SET autocommit=${manual ? 0 : 1}`);
        else await api.txControl(c.id, state.db, channel, manual ? "manual" : "auto");
      } catch (e) {
        return toast(String(e), "error");
      }
    }
    manualTx = manual;
    setTx(manual && implicitTx());
  }

  /** On-demand drivers control the transaction themselves (tx_control). */
  const viaDriver = (c: ConnConfig) => c.kind !== "postgres" && c.kind !== "mysql";
  /** Every statement is inside the transaction as soon as manual mode starts (no BEGIN). */
  const implicitTx = () => !!conn && (conn.kind === "mysql" || viaDriver(conn));

  async function endTx(cmd: "COMMIT" | "ROLLBACK") {
    try {
      if (conn && viaDriver(conn)) await api.txControl(conn.id, state.db, channel, cmd === "COMMIT" ? "commit" : "rollback");
      else await exec(cmd);
      logLine("ok", cmd === "COMMIT" ? "Commit realizado" : "Rollback realizado");
      setTx(implicitTx() && manualTx);
    } catch (e) {
      logLine("err", String(e));
    }
  }

  // --- connection / database / schema context ---
  const renderCtx = () => {
    connBtn.replaceChildren(icon(conn?.kind ?? "database"), h("span", null, conn?.name ?? "Escolher conexão…"), icon("chevronD"));
    connBtn.classList.toggle("warn", !conn);
    // ClickHouse and MongoDB have no transactions to control from the console
    txBtn.style.display = conn && ["clickhouse", "mongodb"].includes(conn.kind) ? "none" : "";
    dbBtn.style.display = conn ? "" : "none";
    if (conn) dbBtn.replaceChildren(icon(dialect(conn.kind).schemas ? "database" : "schema"), h("span", null, [state.db || "(padrão)", state.schema].filter(Boolean).join(" / ")), icon("chevronD"));
  };
  function connMenu() {
    const list = store.connections;
    if (!list.length) return toast("Nenhuma conexão cadastrada. Crie uma na janela Database.");
    dropdown(
      connBtn,
      list.map((c) => ({ label: c.name, icon: conn?.id === c.id ? "check" : c.kind, action: () => setConnection(c) })),
    );
  }
  async function closeChannel() {
    if (conn) await api.closeChannel(conn.id, state.db, channel).catch(() => {});
  }
  function resetSession() {
    schemaApplied = false;
    manualTx = false;
    inTx = false;
    setTx(false);
  }
  async function setConnection(c: ConnConfig | null, db?: string, schema?: string) {
    if (c?.id === conn?.id && db === undefined) return;
    if (inTx && manualTx && !(await confirmDialog("Transação aberta", "Trocar de conexão desfaz (rollback) a transação aberta. Continuar?", "Trocar", true))) return;
    void closeChannel();
    conn = c;
    state.connId = c?.id ?? "";
    state.db = db ?? c?.database ?? "";
    state.schema = schema ?? "";
    resetSession();
    tab.color = c?.color || undefined;
    tab.tooltip = tooltip();
    editor.setLanguage(kind(), [], "");
    renderCtx();
    refreshCompletion();
    store.emit("tabs");
    if (state.file) hooks.scriptBound?.(state);
    onPersist();
  }
  async function ctxMenu() {
    const c = conn;
    if (!c) return connMenu();
    try {
      await store.connect(c.id);
      const dbs = await api.databases(c.id);
      const items = await Promise.all(
        dbs.map(async (d) => {
          if (!dialect(c.kind).schemas) return { label: d, icon: d === state.db ? "check" : "schema", action: () => switchCtx(d, "") };
          return {
            label: d,
            icon: d === state.db ? "check" : "database",
            submenu: [
              { label: "(sem schema)", action: () => switchCtx(d, "") },
              ...(await api.schemas(c.id, d).catch(() => [] as string[])).map((s) => ({
                label: s,
                icon: d === state.db && s === state.schema ? "check" : "schema",
                action: () => switchCtx(d, s),
              })),
            ],
          };
        }),
      );
      dropdown(dbBtn, items);
    } catch (e) {
      toast(String(e), "error");
    }
  }
  async function switchCtx(db: string, schema: string) {
    if (db !== state.db) void closeChannel();
    state.db = db;
    state.schema = schema;
    schemaApplied = false;
    inTx = false;
    setTx(false);
    renderCtx();
    refreshCompletion();
    if (state.file) hooks.scriptBound?.(state);
    onPersist();
  }

  async function refreshCompletion() {
    if (!conn || !store.connected.has(conn.id)) return;
    const c = conn;
    const tables = await store.completionFor(c.id, state.db);
    if (conn === c) editor.setLanguage(c.kind, tables, state.schema || (c.kind === "postgres" ? "public" : state.db));
  }

  function format() {
    const v = editor.view;
    const sel = v.state.selection.main;
    const from = sel.empty ? 0 : sel.from;
    const to = sel.empty ? v.state.doc.length : sel.to;
    v.dispatch({ changes: { from, to, insert: formatSql(v.state.sliceDoc(from, to)) } });
  }

  async function openFile() {
    const path = await open({ filters: [{ name: "SQL", extensions: ["sql", "txt"] }] });
    if (typeof path !== "string") return;
    if (hooks.openScript) return hooks.openScript(P.norm(path), conn, state.db, state.schema);
    const text = await api.readTextFile(path);
    editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: text } });
  }

  /** Scripts save now; a console becomes a script saved in the chosen file. */
  async function saveFile() {
    if (state.file) return flush();
    const p = await save({ defaultPath: `${state.title.replace(/[^\w.-]+/g, "_")}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (!p) return;
    try {
      await host.write(P.norm(p), editor.view.state.doc.toString());
    } catch (e) {
      return toast(String(e), "error");
    }
    state.file = P.norm(p);
    savedText = state.text = editor.view.state.doc.toString();
    tab.title = state.title = P.base(state.file);
    tab.icon = fileIconName(tab.title);
    tab.tooltip = tooltip();
    store.emit("tabs");
    hooks.scriptBound?.(state);
    onPersist();
    toast(`Salvo em ${state.file}`, "ok");
  }

  const tooltip = () => (state.file ? `${P.win(state.file)}${conn ? ` — ${conn.name}` : ""}` : `${conn?.name ?? ""} — console`);

  const tab: ConsoleTab = {
    kind: "console",
    id: "console:" + state.id,
    title: state.title,
    icon: state.file ? fileIconName(state.title) : "console",
    color: conn?.color || undefined,
    tooltip: tooltip(),
    el,
    state,
    editor,
    file: {
      path: () => state.file ?? "",
      flush,
      reload: () => void reload(),
      moved: (path: string) => {
        const old = state.file;
        state.file = P.norm(path);
        tab.title = state.title = P.base(state.file);
        tab.icon = fileIconName(tab.title);
        tab.tooltip = tooltip();
        store.emit("tabs");
        hooks.scriptBound?.(state, old);
        onPersist();
      },
    },
    onActivate: () => {
      setTimeout(() => editor.view.focus());
      refreshCompletion();
    },
    onDeactivate: () => void flush(),
    canClose: async () => {
      await flush();
      if (inTx && manualTx) {
        return confirmDialog("Transação aberta", "Há uma transação aberta neste console. Fechar mesmo assim (rollback)?", "Fechar", true);
      }
      return true;
    },
    onClose: () => {
      clearTimeout(saveTimer);
      void closeChannel();
      onPersist();
    },
    insertText(text: string, runIt = false) {
      const v = editor.view;
      const doc = v.state.doc;
      const prefix = doc.length && !doc.toString().endsWith("\n\n") ? (doc.toString().endsWith("\n") ? "\n" : "\n\n") : "";
      const insert = prefix + text;
      v.dispatch({ changes: { from: doc.length, insert }, selection: { anchor: doc.length + insert.length } });
      v.focus();
      if (runIt) {
        v.dispatch({ selection: { anchor: doc.length + prefix.length, head: doc.length + insert.length } });
        run("current").then(() => v.dispatch({ selection: { anchor: v.state.doc.length } }));
      }
    },
    setConnection: (c, db, schema) => void setConnection(c, db, schema),
  };

  store.on("ddl", () => refreshCompletion());
  renderCtx();
  renderResultTabs();
  if (state.file) {
    void reload(true);
    logLine("info", conn ? `Script ligado a ${conn.name}. Ctrl+Enter executa a instrução sob o cursor.` : "Escolha a conexão do script no canto direito da barra para executar.");
  } else logLine("info", `Console conectado a ${conn?.name}. Ctrl+Enter executa a instrução sob o cursor.`);
  return tab;
}

const PAGE = 50_000;
/** Same cap as the backend (db::MAX_ROWS_CAP). */
const MAX_ROWS_CAP = 1_000_000;

/** Values typed for each parameter, remembered while the app is open. */
const lastParams = new Map<string, string>();

/** Asks the values of the script parameters; null = cancelled. Values go into the SQL as typed. */
function askParams(names: string[]): Promise<{ named: Map<string, string>; positional: string[] } | null> {
  return new Promise((resolve) => {
    let done = false;
    const m = modal("Parâmetros da consulta", { width: 460, onClose: () => !done && resolve(null) });
    const named = [...new Set(names.filter((n) => n !== "?"))];
    const positional = names.filter((n) => n === "?").length;
    const rows: { key: string; label: string; input: HTMLInputElement }[] = [
      ...named.map((n) => ({ key: n, label: n })),
      ...Array.from({ length: positional }, (_, i) => ({ key: `?${i + 1}`, label: `? (${i + 1}º)` })),
    ].map((r) => ({ ...r, input: h("input.input", { value: lastParams.get(r.key) ?? "", spellcheck: false, placeholder: "10, 'texto', NULL…" }) as HTMLInputElement }));
    const submit = () => {
      const empty = rows.find((r) => !r.input.value.trim());
      if (empty) {
        empty.input.focus();
        return toast(`Informe o valor de ${empty.label} (use NULL para nulo).`);
      }
      done = true;
      for (const r of rows) lastParams.set(r.key, r.input.value);
      m.close();
      resolve({ named: new Map(named.map((n) => [n, lastParams.get(n)!])), positional: Array.from({ length: positional }, (_, i) => lastParams.get(`?${i + 1}`)!) });
    };
    m.body.append(
      h("p.dim", null, "Os valores entram no SQL como você escrever: textos e datas entre aspas simples ('abc'), números e NULL sem aspas."),
      ...rows.map((r) => h("label.field", null, h("span", null, r.label), r.input)),
    );
    for (const r of rows) r.input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
    m.footer.append(button("Cancelar", () => m.close()), button("Executar", submit, "primary"));
    setTimeout(() => rows[0]?.input.focus());
  });
}

/** An error in the middle of a script: stop, skip it, or skip every error. */
function askOnError(msg: string, at: number, total: number): Promise<"stop" | "skip" | "all"> {
  return new Promise((resolve) => {
    let choice: "stop" | "skip" | "all" = "stop";
    const m = modal(`Erro na instrução ${at} de ${total}`, { width: 520, onClose: () => resolve(choice) });
    m.body.append(h("pre.error-text", null, msg.length > 1200 ? msg.slice(0, 1200) + "…" : msg), h("p.dim", null, "Continuar com as próximas instruções do script?"));
    const pick = (c: typeof choice) => () => {
      choice = c;
      m.close();
    };
    m.footer.append(button("Ignorar todos os erros", pick("all")), button("Ignorar e continuar", pick("skip")), button("Parar", pick("stop"), "primary"));
  });
}

function guessTable(sqlText: string) {
  const m = /\bfrom\s+([\w."`]+)/i.exec(sqlText);
  return m ? m[1] : "tabela";
}
