// SQL console tab: editor + results.
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, type ConnConfig, type QueryResult } from "./api";
import { createEditor, formatSql, statementAt, type EditorHandle } from "./editor";
import { DataGrid } from "./grid";
import { exportMenu, rowsToInsert } from "./export";
import { icon } from "./icons";
import { store } from "./state";
import type { Tab } from "./tabs";
import { confirmDialog, dropdown, makeSplitter, toast } from "./ui";
import { debounce, formatDuration, h, splitSql, uid } from "./util";

export interface ConsoleState {
  id: string;
  connId: string;
  db: string;
  schema: string;
  title: string;
  text: string;
  file?: string;
}

export interface ConsoleTab extends Tab {
  kind: "console";
  state: ConsoleState;
  editor: EditorHandle;
  insertText: (text: string, run?: boolean) => void;
}

let counter = 0;

export function createConsole(
  conn: ConnConfig,
  init: Partial<ConsoleState>,
  onPersist: () => void,
): ConsoleTab {
  const state: ConsoleState = {
    id: init.id ?? uid(),
    connId: conn.id,
    db: init.db ?? conn.database,
    schema: init.schema ?? "",
    title: init.title ?? `${conn.name}${++counter > 1 ? ` [${counter}]` : ""}`,
    text: init.text ?? "",
    file: init.file,
  };
  const channel = "console-" + state.id;
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
    h("button.tool-btn", { title: "Salvar em arquivo (Ctrl+S)", onclick: () => saveFile() }, icon("save")),
    h("span.grow"),
    dbBtn,
  );

  // --- editor ---
  const editorHost = h("div.editor-host");
  const persist = debounce(onPersist, 600);
  const editor = createEditor(
    editorHost,
    state.text,
    conn.kind,
    [
      { key: "Mod-Enter", run: () => (run("current"), true), preventDefault: true },
      { key: "Mod-Shift-Enter", run: () => (run("all"), true), preventDefault: true },
      { key: "Mod-Shift-e", run: () => (run("explain"), true), preventDefault: true },
      { key: "Mod-Alt-l", run: () => (format(), true), preventDefault: true },
      { key: "Mod-s", run: () => (saveFile(), true), preventDefault: true },
    ],
    (text) => {
      state.text = text;
      persist();
    },
  );

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

  const makeResultView = (r: QueryResult, sqlText: string, n: number): ResultView => {
    const grid = new DataGrid({
      copyAsInsert: (rows) => rowsToInsert(conn.kind, guessTable(sqlText), r.columns, rows.map((i) => r.rows[i])),
    });
    grid.setData(r.columns, r.rows);
    const exportBtn = h("button.tool-btn", { title: "Exportar" }, icon("export"));
    exportBtn.onclick = () =>
      exportMenu(exportBtn, () => ({ columns: r.columns, rows: r.rows }), conn.kind, guessTable(sqlText).replace(/[`"]/g, "") || "resultado");
    const info = h(
      "div.result-info",
      null,
      h("span", null, `${r.rows.length.toLocaleString()} linha(s)`),
      r.truncated ? h("span.warn", null, ` — limitado às primeiras ${r.rows.length.toLocaleString()}`) : null,
      h("span.dim", null, ` · ${formatDuration(r.elapsedMs)}`),
      h("span.grow"),
      exportBtn,
    );
    return { title: `Resultado ${n}`, el: h("div.result-view", null, info, grid.el), grid };
  };

  const setRunning = (v: boolean) => {
    running = v;
    stopBtn.disabled = !v;
    runBtn.disabled = runAllBtn.disabled = explainBtn.disabled = v;
    el.classList.toggle("busy", v);
  };

  async function exec(sqlText: string) {
    return api.execute(conn.id, state.db, channel, sqlText);
  }

  async function ensureSchema() {
    if (conn.kind === "postgres" && state.schema && !schemaApplied) {
      await exec(`SET search_path TO ${quoteSchema(state.schema)}, public`);
      schemaApplied = true;
    }
  }
  let schemaApplied = false;
  const quoteSchema = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);

  async function run(mode: "current" | "all" | "explain") {
    if (running) return;
    const view = editor.view;
    const sel = view.state.selection.main;
    const text = view.state.doc.toString();
    let statements: string[];
    if (!sel.empty) statements = splitSql(view.state.sliceDoc(sel.from, sel.to), conn.kind).map((s) => s.text);
    else if (mode === "all") statements = splitSql(text, conn.kind).map((s) => s.text);
    else {
      const st = statementAt(text, sel.head, conn.kind);
      statements = st ? [st.text] : [];
    }
    if (!statements.length) {
      toast("Nada para executar");
      return;
    }
    if (mode === "explain") {
      statements = [conn.kind === "postgres" ? `EXPLAIN (VERBOSE, COSTS) ${statements[0]}` : `EXPLAIN FORMAT=TREE ${statements[0]}`];
    }
    if (conn.readOnly === false && statements.some((s) => /^\s*(drop|truncate)\s/i.test(s)) && !manualTx) {
      const ok = await confirmDialog("Instrução destrutiva", `Executar ${statements.length > 1 ? "script com " : ""}DROP/TRUNCATE em "${conn.name}"?`, "Executar", true);
      if (!ok) return;
    }

    setRunning(true);
    views = [];
    let n = 0;
    const started = performance.now();
    try {
      await store.connect(conn.id);
      await ensureSchema();
      if (manualTx && !inTx && conn.kind === "postgres") {
        await exec("BEGIN");
        setTx(true);
      }
      for (const s of statements) {
        const t0 = performance.now();
        try {
          const results = await exec(s);
          const ms = Math.round(performance.now() - t0);
          for (const r of results) {
            if (r.hasRows) {
              views.push(makeResultView(r, s, ++n));
              logLine("ok", `${r.rows.length} linha(s) obtida(s) em ${formatDuration(r.elapsedMs)}`);
            } else {
              logLine("ok", `${r.affected ?? 0} linha(s) afetada(s) em ${formatDuration(ms)}`);
            }
          }
          if (/^\s*(commit|rollback|end)\b/i.test(s)) setTx(false);
          if (/^\s*(begin|start\s+transaction)\b/i.test(s)) setTx(true);
          if (/^\s*(create|alter|drop|rename)\s/i.test(s)) store.invalidateCompletion(conn.id), store.emit("ddl");
          store.addLog({ time: Date.now(), connName: conn.name, db: state.db, sql: s, ok: true, message: results.map((r) => (r.hasRows ? `${r.rows.length} linhas` : `${r.affected ?? 0} afetadas`)).join(", "), elapsedMs: ms });
          store.addHistory({ time: Date.now(), connId: conn.id, db: state.db, sql: s });
        } catch (e) {
          const ms = Math.round(performance.now() - t0);
          logLine("cmd", s.length > 300 ? s.slice(0, 300) + "…" : s);
          logLine("err", String(e));
          store.addLog({ time: Date.now(), connName: conn.name, db: state.db, sql: s, ok: false, message: String(e), elapsedMs: ms });
          store.addHistory({ time: Date.now(), connId: conn.id, db: state.db, sql: s });
          activeView = views.length;
          renderResultTabs();
          if (manualTx) setTx(true);
          return;
        }
      }
      if (statements.length > 1) logLine("info", `Script concluído: ${statements.length} instruções em ${formatDuration(Math.round(performance.now() - started))}`);
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
    manualTx = manual;
    if (conn.kind === "mysql") {
      try {
        await exec(`SET autocommit=${manual ? 0 : 1}`);
        if (manual) inTx = true;
      } catch (e) {
        toast(String(e), "error");
      }
    }
    setTx(manual && conn.kind === "mysql");
  }

  async function endTx(cmd: "COMMIT" | "ROLLBACK") {
    try {
      await exec(cmd);
      logLine("ok", cmd === "COMMIT" ? "Commit realizado" : "Rollback realizado");
      setTx(conn.kind === "mysql" && manualTx);
    } catch (e) {
      logLine("err", String(e));
    }
  }

  // --- database / schema context ---
  const renderCtx = () => {
    dbBtn.replaceChildren(icon(conn.kind === "postgres" ? "database" : "schema"), h("span", null, [state.db || "(padrão)", state.schema].filter(Boolean).join(" / ")), icon("chevronD"));
  };
  async function ctxMenu() {
    try {
      await store.connect(conn.id);
      const dbs = await api.databases(conn.id);
      const items = await Promise.all(
        dbs.map(async (d) => {
          if (conn.kind === "mysql") return { label: d, icon: d === state.db ? "check" : "schema", action: () => switchCtx(d, "") };
          return {
            label: d,
            icon: d === state.db ? "check" : "database",
            submenu: [
              { label: "(sem schema)", action: () => switchCtx(d, "") },
              ...(await api.schemas(conn.id, d).catch(() => [] as string[])).map((s) => ({
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
    if (db !== state.db) api.closeChannel(conn.id, state.db, channel).catch(() => {});
    state.db = db;
    state.schema = schema;
    schemaApplied = false;
    inTx = false;
    setTx(false);
    renderCtx();
    refreshCompletion();
    onPersist();
  }

  async function refreshCompletion() {
    if (!store.connected.has(conn.id)) return;
    const tables = await store.completionFor(conn.id, state.db);
    editor.setLanguage(conn.kind, tables, state.schema || (conn.kind === "postgres" ? "public" : state.db));
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
    const text = await api.readTextFile(path);
    editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: text } });
    state.file = path;
    tab.title = path.split(/[\\/]/).pop()!;
    state.title = tab.title;
    tab.tooltip = path;
    store.emit("tabs");
  }

  async function saveFile() {
    let path = state.file;
    if (!path) {
      const p = await save({ defaultPath: `${state.title.replace(/[^\w.-]+/g, "_")}.sql`, filters: [{ name: "SQL", extensions: ["sql"] }] });
      if (!p) return;
      path = p;
    }
    await api.writeTextFile(path, editor.view.state.doc.toString());
    state.file = path;
    toast(`Salvo em ${path}`, "ok");
  }

  const tab: ConsoleTab = {
    kind: "console",
    id: "console:" + state.id,
    title: state.title,
    icon: "console",
    color: conn.color || undefined,
    tooltip: `${conn.name} — console`,
    el,
    state,
    editor,
    onActivate: () => {
      setTimeout(() => editor.view.focus());
      refreshCompletion();
    },
    canClose: async () => {
      if (inTx && manualTx) {
        return confirmDialog("Transação aberta", "Há uma transação aberta neste console. Fechar mesmo assim (rollback)?", "Fechar", true);
      }
      return true;
    },
    onClose: () => {
      api.closeChannel(conn.id, state.db, channel).catch(() => {});
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
  };

  store.on("ddl", () => refreshCompletion());
  renderCtx();
  renderResultTabs();
  logLine("info", `Console conectado a ${conn.name}. Ctrl+Enter executa a instrução sob o cursor.`);
  return tab;
}

function guessTable(sqlText: string) {
  const m = /\bfrom\s+([\w."`]+)/i.exec(sqlText);
  return m ? m[1] : "tabela";
}
