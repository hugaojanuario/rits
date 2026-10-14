// Backup & restore wizards (pg_dump / pg_restore / psql / mysqldump / mysql) and the task panel.
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, type ConnConfig, type TaskSpec, type ToolStatus } from "./api";
import { icon } from "./icons";
import { store } from "./state";
import { button, confirmDialog, modal, toast } from "./ui";
import { formatDuration, h, timestamp, uid } from "./util";

// ---------------- task panel ----------------

interface TaskView {
  spec: TaskSpec;
  connName: string;
  start: number;
  status: "running" | "ok" | "error";
  lines: { kind: string; line: string }[];
  el: HTMLElement;
}

const tasks: TaskView[] = [];
export const taskPanel = h("div.task-panel", null, h("div.empty-note", null, "Nenhuma tarefa executada. Use Backup… ou Restaurar… no Explorador."));
let onTaskStarted: (() => void) | null = null;
export function setTaskStartedHook(fn: () => void) {
  onTaskStarted = fn;
}

api.onTaskEvent((e) => {
  const t = tasks.find((x) => x.spec.taskId === e.taskId);
  if (!t) return;
  if (e.kind === "done") return;
  t.lines.push({ kind: e.kind, line: e.line });
  const log = t.el.querySelector(".task-log")!;
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.append(h("div", { class: "tl-" + e.kind }, e.line));
  if (log.childElementCount > 5000) log.firstElementChild?.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
  t.el.querySelector(".task-last")!.textContent = e.line.slice(0, 160);
});

function renderTaskHead(t: TaskView) {
  const head = t.el.querySelector(".task-head")!;
  const label = t.spec.action === "backup" ? "Backup" : "Restauração";
  const st =
    t.status === "running"
      ? h("span.task-status.running", null, icon("refresh", "spin"), "Executando")
      : t.status === "ok"
        ? h("span.task-status.ok", null, icon("check"), "Concluído")
        : h("span.task-status.err", null, icon("warn"), "Falhou");
  head.replaceChildren(
    icon(t.spec.action),
    h("b", null, `${label} — ${t.spec.database}`),
    h("span.dim", null, ` · ${t.connName} · ${new Date(t.start).toLocaleTimeString()}`),
    h("span.grow"),
    st,
    t.status !== "running" ? h("span.dim", null, ` ${formatDuration(Date.now() - t.start)}`) : "",
  );
}

async function startTask(conn: ConnConfig, spec: TaskSpec) {
  if (!tasks.length) taskPanel.replaceChildren();
  const t: TaskView = {
    spec,
    connName: conn.name,
    start: Date.now(),
    status: "running",
    lines: [],
    el: h(
      "div.task",
      null,
      h("div.task-head"),
      h("div.task-path.mono", null, spec.path),
      h("div.task-last.mono.dim"),
      h("details", null, h("summary", null, "Log completo"), h("div.task-log.mono")),
    ),
  };
  tasks.unshift(t);
  taskPanel.prepend(t.el);
  renderTaskHead(t);
  onTaskStarted?.();
  try {
    const code = await api.runTask(spec);
    t.status = code === 0 ? "ok" : "error";
    if (code === 0) toast(`${spec.action === "backup" ? "Backup" : "Restauração"} de ${spec.database} concluído`, "ok", 6000);
    else {
      toast(`${spec.action === "backup" ? "Backup" : "Restauração"} terminou com código ${code} — veja o log`, "error", 8000);
      (t.el.querySelector("details") as HTMLDetailsElement).open = true;
    }
    if (spec.action === "restore" && code === 0) {
      store.invalidateCompletion(conn.id);
      store.emit("ddl");
    }
  } catch (e) {
    t.status = "error";
    t.el.querySelector(".task-last")!.textContent = String(e);
    toast(String(e), "error", 10000);
  }
  renderTaskHead(t);
}

// ---------------- shared bits ----------------

const opt = (label: string, checked: boolean, hint = "") => {
  const input = h("input", { type: "checkbox", checked }) as HTMLInputElement;
  return { input, el: h("label.check", { title: hint }, input, label) };
};

function toolsBox(conn: ConnConfig, needed: string[]) {
  const box = h("div.tools-box", null, h("span.dim", null, "Verificando ferramentas nativas…"));
  api
    .detectTools(conn.id)
    .then((list: ToolStatus[]) => {
      const rel = list.filter((t) => needed.includes(t.name));
      const missing = rel.filter((t) => !t.path);
      box.replaceChildren(
        ...rel.map((t) =>
          h(
            "div.tool-line",
            { class: t.path ? "ok" : "missing" },
            icon(t.path ? "check" : "warn"),
            h("b", null, t.name),
            h("span.dim.mono", null, t.path ? ` ${t.version ?? ""} — ${t.path}` : " não encontrado"),
          ),
        ),
        missing.length
          ? h(
              "div.tool-hint",
              null,
              conn.kind === "postgres"
                ? "Instale o PostgreSQL client (ex.: winget install PostgreSQL.PostgreSQL) ou informe a pasta \\bin nas propriedades da conexão."
                : "Instale o MySQL Shell/Server ou MariaDB client (ex.: winget install Oracle.MySQL) ou informe a pasta \\bin nas propriedades da conexão.",
            )
          : "",
      );
    })
    .catch((e) => box.replaceChildren(h("span.err", null, String(e))));
  return box;
}

async function checklist(items: string[], preselected: string[], emptyNote: string) {
  const wrap = h("div.checklist");
  const boxes = items.map((it) => {
    const input = h("input", { type: "checkbox", checked: preselected.includes(it) }) as HTMLInputElement;
    wrap.append(h("label.check", null, input, it));
    return { it, input };
  });
  if (!items.length) wrap.append(h("div.empty-note", null, emptyNote));
  const tools = h(
    "div.checklist-tools",
    null,
    h("button.link", { onclick: () => boxes.forEach((b) => (b.input.checked = true)) }, "Todos"),
    h("button.link", { onclick: () => boxes.forEach((b) => (b.input.checked = false)) }, "Nenhum"),
  );
  return { el: h("div", null, tools, wrap), get: () => boxes.filter((b) => b.input.checked).map((b) => b.it) };
}

// ---------------- backup wizard ----------------

export async function openBackupWizard(conn: ConnConfig, db: string, schemas: string[] = [], tables: string[] = []) {
  const k = conn.kind;
  try {
    await store.connect(conn.id);
  } catch (e) {
    toast(String(e), "error");
    return;
  }
  const dbs = await api.databases(conn.id);
  if (!db || !dbs.includes(db)) db = dbs.find((d) => !["postgres", "information_schema", "mysql", "sys", "performance_schema"].includes(d)) ?? dbs[0];

  const m = modal("Backup do banco de dados", { width: 720 });
  const steps = ["Objetos", "Opções", "Saída"];
  let step = 0;

  // --- step 1: objects ---
  const dbSel = h("select.select", null, ...dbs.map((d) => h("option", { value: d, selected: d === db }, d))) as HTMLSelectElement;
  const objHost = h("div.obj-host");
  let schemaList: Awaited<ReturnType<typeof checklist>> | null = null;
  let tableList: Awaited<ReturnType<typeof checklist>> | null = null;
  const loadObjects = async () => {
    objHost.replaceChildren(h("span.dim", null, "Carregando…"));
    const d = dbSel.value;
    try {
      if (k === "postgres") {
        const sch = (await api.schemas(conn.id, d)).filter((s) => s !== "pg_catalog" && s !== "information_schema");
        schemaList = await checklist(sch, schemas.length ? schemas : [], "Sem schemas");
        const tbls: string[] = [];
        for (const s of sch) for (const o of await api.objects(conn.id, d, s)) if (o.kind === "table") tbls.push(`${s}.${o.name}`);
        tableList = await checklist(tbls, tables, "Sem tabelas");
      } else {
        schemaList = null;
        const tbls = (await api.objects(conn.id, d, d)).filter((o) => o.kind === "table").map((o) => o.name);
        tableList = await checklist(tbls, tables, "Sem tabelas");
      }
      objHost.replaceChildren(
        h(
          "div.obj-cols",
          null,
          schemaList ? h("div", null, h("div.sub-label", null, "Schemas (nenhum = todos)"), schemaList.el) : null,
          h("div", null, h("div.sub-label", null, "Tabelas (nenhuma = todas)"), tableList.el),
        ),
      );
    } catch (e) {
      objHost.replaceChildren(h("span.err", null, String(e)));
    }
  };
  dbSel.onchange = () => {
    loadObjects();
    updateName();
  };
  const step1 = h("div.wizard-step", null, h("label.field", null, h("span", null, "Database"), dbSel), objHost);

  // --- step 2: options ---
  const fmtSel = h(
    "select.select",
    null,
    h("option", { value: "custom" }, "Custom (.backup) — compactado, restauração seletiva"),
    h("option", { value: "plain" }, "SQL puro (.sql)"),
    h("option", { value: "tar" }, "Tar (.tar)"),
    h("option", { value: "directory" }, "Diretório (paralelo)"),
  ) as HTMLSelectElement;
  const compSel = h("select.select", null, ...["padrão", "0", "1", "3", "5", "6", "9"].map((x) => h("option", { value: x === "padrão" ? "" : x }, x))) as HTMLSelectElement;
  const jobsI = h("input.input", { type: "number", min: 1, max: 32, value: 4 }) as HTMLInputElement;
  const encI = h("input.input", { placeholder: k === "postgres" ? "ex.: UTF8" : "ex.: utf8mb4", value: k === "mysql" ? "utf8mb4" : "" }) as HTMLInputElement;
  const what = h(
    "select.select",
    null,
    h("option", { value: "all" }, "Estrutura e dados"),
    h("option", { value: "schema" }, "Somente estrutura"),
    h("option", { value: "data" }, "Somente dados"),
  ) as HTMLSelectElement;
  const o = {
    noOwner: opt("Não salvar dono (--no-owner)", true, "Útil para restaurar com outro usuário"),
    noPriv: opt("Não salvar privilégios (--no-privileges)", false),
    clean: opt("Incluir DROP antes de CREATE (--clean)", false),
    create: opt(k === "postgres" ? "Incluir CREATE DATABASE (--create)" : "Incluir CREATE DATABASE", false),
    inserts: opt("Dados como INSERT em vez de COPY", false, "Mais lento, porém portável"),
    colInserts: opt("INSERT com nomes de colunas", false),
    singleTx: opt("Transação única (--single-transaction)", true, "Snapshot consistente sem travar tabelas InnoDB"),
    routines: opt("Rotinas (procedures/funções)", true),
    triggers: opt("Triggers", true),
    events: opt("Eventos", false),
    addDrop: opt("DROP TABLE antes de CREATE", true),
    extInsert: opt("INSERT estendido (multi-linhas)", true, "Arquivo menor e restauração mais rápida"),
    lockTables: opt("Travar tabelas (--lock-tables)", false),
  };
  const fmtFields =
    k === "postgres"
      ? [
          h("label.field", null, h("span", null, "Formato"), fmtSel),
          h("label.field", null, h("span", null, "Compressão"), compSel),
          h("label.field", { class: "jobs-field" }, h("span", null, "Jobs paralelos (formato diretório)"), jobsI),
        ]
      : [];
  const optChecks =
    k === "postgres"
      ? [o.noOwner, o.noPriv, o.clean, o.create, o.inserts, o.colInserts]
      : [o.singleTx, o.routines, o.triggers, o.events, o.addDrop, o.extInsert, o.lockTables, o.create, o.colInserts];
  const step2 = h(
    "div.wizard-step",
    null,
    h("div.form-grid", null, ...fmtFields, h("label.field", null, h("span", null, "Conteúdo"), what), h("label.field", null, h("span", null, "Encoding"), encI)),
    h("div.sub-label", null, "Opções"),
    h("div.check-grid", null, ...optChecks.map((x) => x.el)),
  );

  // --- step 3: output ---
  const ext = () => (k === "mysql" ? "sql" : { custom: "backup", plain: "sql", tar: "tar", directory: "" }[fmtSel.value] ?? "backup");
  const pathI = h("input.input.mono", { spellcheck: false }) as HTMLInputElement;
  let userEditedPath = false;
  pathI.oninput = () => (userEditedPath = true);
  const lastDir = (() => {
    try {
      return localStorage.getItem("backup-dir") ?? "";
    } catch {
      return "";
    }
  })();
  const updateName = () => {
    if (userEditedPath) return;
    const e = ext();
    const name = `${dbSel.value}-${timestamp()}${e ? "." + e : ""}`;
    pathI.value = lastDir ? `${lastDir}\\${name}` : name;
  };
  fmtSel.onchange = () => {
    userEditedPath = false;
    updateName();
  };
  const browse = button("Procurar…", async () => {
    let p: string | null;
    if (fmtSel.value === "directory" && k === "postgres") {
      const d = await open({ directory: true });
      p = typeof d === "string" ? `${d}\\${dbSel.value}-${timestamp()}` : null;
    } else {
      p = await save({ defaultPath: pathI.value, filters: [{ name: "Backup", extensions: [ext() || "*"] }] });
    }
    if (p) {
      pathI.value = p;
      userEditedPath = true;
    }
  });
  const extraI = h("input.input.mono", { placeholder: "ex.: --exclude-table-data=logs", spellcheck: false }) as HTMLInputElement;
  const needed = k === "postgres" ? ["pg_dump"] : ["mysqldump"];
  const summary = h("div.summary");
  const step3 = h(
    "div.wizard-step",
    null,
    h("label.field", null, h("span", null, "Arquivo de saída"), h("div.input-row", null, pathI, browse)),
    h("label.field", null, h("span", null, "Argumentos extras (avançado)"), extraI),
    h("div.sub-label", null, "Ferramentas"),
    toolsBox(conn, needed),
    summary,
  );

  // --- wizard frame ---
  const stepBar = h("div.wizard-steps");
  const host = h("div.wizard-host");
  const backBtn = button("Voltar", () => go(step - 1));
  const nextBtn = button("Próximo", () => go(step + 1), "primary");
  const runBtn = button("Iniciar backup", () => runIt(), "primary", "backup");
  const go = (s: number) => {
    step = Math.max(0, Math.min(2, s));
    stepBar.replaceChildren(...steps.map((label, i) => h("div.wstep", { class: i === step ? "active" : i < step ? "done" : "", onclick: () => go(i) }, h("span.wnum", null, String(i + 1)), label)));
    host.replaceChildren([step1, step2, step3][step]);
    backBtn.disabled = step === 0;
    nextBtn.style.display = step === 2 ? "none" : "";
    if (step === 2) {
      updateName();
      const sch = schemaList?.get() ?? [];
      const tb = tableList?.get() ?? [];
      summary.replaceChildren(
        h("div.sub-label", null, "Resumo"),
        h("div.dim", null, `${conn.name} → ${dbSel.value}`),
        h("div.dim", null, `${sch.length ? "Schemas: " + sch.join(", ") : "Todos os schemas"} · ${tb.length ? tb.length + " tabela(s)" : "todas as tabelas"}`),
      );
    }
  };
  m.body.append(stepBar, host);
  m.footer.append(h("span.grow"), button("Cancelar", () => m.close()), backBtn, nextBtn, runBtn);
  go(0);
  updateName();
  loadObjects();

  async function runIt() {
    const path = pathI.value.trim();
    if (!path) return toast("Informe o arquivo de saída", "error");
    try {
      const dir = path.replace(/[\\/][^\\/]*$/, "");
      if (dir && dir !== path) localStorage.setItem("backup-dir", dir);
    } catch {
      /* ignore */
    }
    const spec: TaskSpec = {
      taskId: uid(),
      connId: conn.id,
      action: "backup",
      database: dbSel.value,
      path,
      format: k === "postgres" ? fmtSel.value : "plain",
      schemas: schemaList?.get() ?? [],
      tables: tableList?.get() ?? [],
      compression: compSel.value === "" ? null : Number(compSel.value),
      jobs: Number(jobsI.value) || null,
      encoding: encI.value.trim(),
      schemaOnly: what.value === "schema",
      dataOnly: what.value === "data",
      noOwner: o.noOwner.input.checked,
      noPrivileges: o.noPriv.input.checked,
      clean: o.clean.input.checked || (k === "mysql" && o.addDrop.input.checked),
      ifExists: true,
      create: o.create.input.checked,
      inserts: o.inserts.input.checked,
      columnInserts: o.colInserts.input.checked,
      singleTransaction: o.singleTx.input.checked,
      routines: o.routines.input.checked,
      triggers: o.triggers.input.checked,
      events: o.events.input.checked,
      addDropTable: o.addDrop.input.checked,
      extendedInsert: o.extInsert.input.checked,
      lockTables: o.lockTables.input.checked,
      extraArgs: extraI.value,
    };
    m.close();
    startTask(conn, spec);
  }
}

// ---------------- restore wizard ----------------

export async function openRestoreWizard(conn: ConnConfig, db: string) {
  const k = conn.kind;
  try {
    await store.connect(conn.id);
  } catch (e) {
    toast(String(e), "error");
    return;
  }
  const dbs = await api.databases(conn.id);
  const m = modal("Restaurar banco de dados", { width: 660 });

  const fileI = h("input.input.mono", { spellcheck: false, placeholder: "Selecione o arquivo de backup" }) as HTMLInputElement;
  const fmtInfo = h("div.dim.fmt-info");
  const detectFmt = () => {
    const p = fileI.value.toLowerCase();
    const f = p.endsWith(".sql") ? "plain" : p.endsWith(".tar") ? "tar" : p ? "custom" : "";
    fmtInfo.textContent = !f
      ? ""
      : k === "mysql"
        ? "Arquivo SQL — será executado com o cliente mysql"
        : f === "plain"
          ? "SQL puro — será executado com psql"
          : `Arquivo ${f} — será restaurado com pg_restore`;
    tools.replaceChildren(toolsBox(conn, k === "postgres" ? (f === "plain" ? ["psql"] : ["pg_restore"]) : ["mysql"]));
    pgOpts.style.display = k === "postgres" && f !== "plain" ? "" : "none";
    return f;
  };
  fileI.oninput = detectFmt;
  const browse = button("Procurar…", async () => {
    const p = await open({
      filters: [
        { name: "Backups", extensions: k === "postgres" ? ["backup", "dump", "sql", "tar", "custom"] : ["sql", "dump"] },
        { name: "Todos os arquivos", extensions: ["*"] },
      ],
    });
    if (typeof p === "string") {
      fileI.value = p;
      detectFmt();
    }
  });
  const dirBtn =
    k === "postgres"
      ? button("Pasta…", async () => {
          const p = await open({ directory: true });
          if (typeof p === "string") {
            fileI.value = p;
            detectFmt();
            fmtInfo.textContent = "Diretório — será restaurado com pg_restore";
          }
        })
      : null;

  const dbSel = h("select.select", null, ...dbs.map((d) => h("option", { value: d, selected: d === db }, d))) as HTMLSelectElement;
  const newDbBtn = button("Novo…", async () => {
    const { promptDialog } = await import("./ui");
    const name = await promptDialog("Criar database", "Nome do database de destino");
    if (!name) return;
    try {
      const q = k === "postgres" ? `"${name.replace(/"/g, '""')}"` : "`" + name.replace(/`/g, "``") + "`";
      await api.execute(conn.id, k === "postgres" ? conn.database || "postgres" : "", "meta-run", `CREATE DATABASE ${q}`);
      dbSel.append(h("option", { value: name, selected: true }, name));
      store.emit("ddl");
      toast(`Database ${name} criado`, "ok");
    } catch (e) {
      toast(String(e), "error");
    }
  });

  const o = {
    clean: opt("Apagar objetos existentes antes (--clean --if-exists)", false),
    noOwner: opt("Ignorar dono (--no-owner)", true),
    noPriv: opt("Ignorar privilégios (--no-privileges)", false),
    singleTx: opt("Transação única (tudo ou nada)", true),
    dataOnly: opt("Somente dados", false),
    schemaOnly: opt("Somente estrutura", false),
  };
  const jobsI = h("input.input", { type: "number", min: 1, max: 32, value: 1 }) as HTMLInputElement;
  const pgOpts = h(
    "div",
    null,
    h("div.check-grid", null, o.clean.el, o.noOwner.el, o.noPriv.el, o.dataOnly.el, o.schemaOnly.el),
    h("label.field.inline", null, h("span", null, "Jobs paralelos"), jobsI),
  );
  const extraI = h("input.input.mono", { spellcheck: false }) as HTMLInputElement;
  const tools = h("div");

  m.body.append(
    h("label.field", null, h("span", null, "Arquivo de backup"), h("div.input-row", null, fileI, browse, dirBtn)),
    fmtInfo,
    h("label.field", null, h("span", null, "Database de destino"), h("div.input-row", null, dbSel, newDbBtn)),
    h("div.sub-label", null, "Opções"),
    h("div.check-grid", null, o.singleTx.el),
    pgOpts,
    h("label.field", null, h("span", null, "Argumentos extras (avançado)"), extraI),
    h("div.sub-label", null, "Ferramentas"),
    tools,
  );
  detectFmt();

  m.footer.append(
    h("span.grow"),
    button("Cancelar", () => m.close()),
    button("Restaurar", async () => {
      const path = fileI.value.trim();
      if (!path) return toast("Selecione o arquivo de backup", "error");
      const target = dbSel.value;
      const ok = await confirmDialog(
        "Confirmar restauração",
        `Restaurar "${path.split(/[\\/]/).pop()}" em "${target}" (${conn.name})?${o.clean.input.checked ? "\n\nObjetos existentes serão APAGADOS antes." : ""}`,
        "Restaurar",
        true,
      );
      if (!ok) return;
      const f = detectFmt();
      m.close();
      startTask(conn, {
        taskId: uid(),
        connId: conn.id,
        action: "restore",
        database: target,
        path,
        format: f === "plain" ? "plain" : "",
        clean: o.clean.input.checked,
        ifExists: true,
        noOwner: o.noOwner.input.checked,
        noPrivileges: o.noPriv.input.checked,
        singleTransaction: o.singleTx.input.checked,
        dataOnly: o.dataOnly.input.checked,
        schemaOnly: o.schemaOnly.input.checked,
        jobs: Number(jobsI.value) || null,
        extraArgs: extraI.value,
      });
    }, "danger", "restore"),
  );
}
