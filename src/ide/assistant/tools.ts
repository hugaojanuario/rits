// IDE tools exposed to the agent through the local MCP server (backend: assistant.rs). They are
// read-only (MCP annotation readOnlyHint) and reuse the IDE's own APIs, so the agent sees exactly
// what the user sees: project and editors, databases, Airflow, dbt, Jupyter, Docker and audits.
// "approve" is Claude Code's permission prompt: the user allows or denies each sensitive action.
import { invoke } from "@tauri-apps/api/core";
import { api } from "../../api";
import { store } from "../../state";
import { host, P } from "../host";
import type { Workbench } from "../workbench";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const ro = (title: string) => ({ title, readOnlyHint: true, openWorldHint: false });

export const TOOLS: ToolDef[] = [
  { name: "ide_context", title: "Contexto da IDE", description: "Projeto aberto, arquivo ativo (cursor e seleção), arquivos abertos, plugins ativos, interpretador Python, branch e alterações do Git. Chame primeiro para saber o que o usuário está vendo.", inputSchema: obj(), annotations: ro("Contexto da IDE") },
  { name: "read_editor", title: "Ler editor", description: "Conteúdo atual de um arquivo aberto na IDE, incluindo alterações ainda não salvas. Sem path, o arquivo ativo.", inputSchema: obj({ path: str("Caminho absoluto ou relativo ao projeto") }), annotations: ro("Ler editor") },
  { name: "diagnostics", title: "Problemas", description: "Erros e avisos dos servidores de linguagem (LSP) de um arquivo ou do projeto inteiro.", inputSchema: obj({ path: str("Arquivo (opcional)") }), annotations: ro("Problemas") },
  { name: "open_in_editor", title: "Abrir no editor", description: "Abre um arquivo do projeto no editor da IDE, opcionalmente numa linha, para mostrar algo ao usuário.", inputSchema: obj({ path: str("Arquivo"), line: { type: "integer", minimum: 1 } }, ["path"]), annotations: { title: "Abrir no editor", readOnlyHint: true } },
  { name: "db_connections", title: "Conexões de banco", description: "Conexões de banco configuradas na IDE (id, nome, tipo, host, banco padrão, somente leitura). Sem senhas.", inputSchema: obj(), annotations: ro("Conexões de banco") },
  { name: "db_schema", title: "Estrutura do banco", description: "Tabelas e colunas de um banco (e schema) de uma conexão da IDE.", inputSchema: obj({ connection: str("id ou nome da conexão"), database: str("banco (opcional)"), schema: str("schema (opcional)"), table: str("tabela para detalhar colunas, tipos e chaves (opcional)") }, ["connection"]), annotations: ro("Estrutura do banco") },
  { name: "db_query", title: "Consultar banco", description: "Executa SQL numa conexão da IDE em transação SOMENTE LEITURA e devolve até max_rows linhas (padrão 100). Use para explorar dados; alterações são recusadas pelo banco.", inputSchema: obj({ connection: str("id ou nome da conexão"), sql: str("uma instrução SELECT/WITH"), database: str("banco (opcional)"), max_rows: { type: "integer", minimum: 1, maximum: 2000 } }, ["connection", "sql"]), annotations: ro("Consultar banco") },
  { name: "airflow_overview", title: "Airflow", description: "Instâncias do Airflow cadastradas, DAGs (pausa, tags, último estado) e erros de importação.", inputSchema: obj({ instance: str("id ou nome da instância (opcional)"), search: str("filtro de DAG (opcional)") }), annotations: ro("Airflow") },
  { name: "airflow_runs", title: "Execuções do Airflow", description: "Últimas execuções de uma DAG e o estado das tarefas da execução mais recente (ou de run_id).", inputSchema: obj({ dag_id: str("DAG"), run_id: str("execução (opcional)"), instance: str("instância (opcional)") }, ["dag_id"]), annotations: ro("Execuções do Airflow") },
  { name: "airflow_task_log", title: "Log de tarefa do Airflow", description: "Log de uma tentativa de tarefa do Airflow.", inputSchema: obj({ dag_id: str("DAG"), run_id: str("execução"), task_id: str("tarefa"), try_number: { type: "integer", minimum: 1 }, instance: str("instância (opcional)") }, ["dag_id", "run_id", "task_id"]), annotations: ro("Log do Airflow") },
  { name: "dbt_overview", title: "dbt", description: "Projeto dbt configurado: modelos, fontes, testes, dependências e o resultado da última execução (falhas e tempos).", inputSchema: obj({ filter: str("nome de nó (opcional)") }), annotations: ro("dbt") },
  { name: "jupyter_notebooks", title: "Notebooks", description: "Notebooks abertos no editor da IDE: kernel, estado, células e saídas em texto.", inputSchema: obj({ path: str("notebook (opcional)") }), annotations: ro("Notebooks") },
  { name: "docker_containers", title: "Docker", description: "Containers Docker (nome, imagem, estado, portas, projeto do Compose).", inputSchema: obj(), annotations: ro("Docker") },
  { name: "audit_overview", title: "Migration Audit", description: "Projetos do Migration Audit e o resumo da última reconciliação (divergências por unidade).", inputSchema: obj(), annotations: ro("Migration Audit") },
];

export const APPROVE_TOOL: ToolDef = {
  name: "approve",
  title: "Aprovação do usuário",
  description: "Uso interno: pede ao usuário, na IDE, para permitir uma ação do agente.",
  inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
  annotations: { title: "Aprovação do usuário", readOnlyHint: true },
};

const LIMIT = 60_000;
const clip = (s: string) => (s.length > LIMIT ? s.slice(0, LIMIT) + `\n… (cortado: ${s.length - LIMIT} caracteres a mais)` : s);
const json = (v: unknown) => clip(JSON.stringify(v, null, 1));

function conn(ref: string) {
  const all = store.connections;
  const c = all.find((x) => x.id === ref) ?? all.find((x) => x.name.toLowerCase() === (ref ?? "").toLowerCase());
  if (!c) throw new Error(`Conexão "${ref}" não encontrada. Use db_connections para ver as disponíveis.`);
  return c;
}

function resolve(wb: Workbench, p?: string) {
  if (!p) return wb.editors.active()?.path ?? null;
  return P.isAbs(p) ? P.norm(p) : P.join(wb.root, p);
}

async function airflowInstance(ref?: string) {
  const { instances, AirflowApi } = await import("../airflow/api");
  const all = await instances.list();
  const inst = ref ? all.find((i) => i.id === ref || i.name.toLowerCase() === ref.toLowerCase()) : all[0];
  if (!inst) throw new Error(all.length ? `Instância "${ref}" não encontrada.` : "Nenhuma instância do Airflow cadastrada na IDE.");
  return { inst, api: new AirflowApi(inst), all };
}

/** Runs a tool and returns its text result (throws on error). */
export async function runTool(wb: Workbench, name: string, a: Record<string, any>): Promise<string> {
  switch (name) {
    case "ide_context": {
      const ed = wb.editors.active();
      let selection = "";
      let cursor = null as null | { line: number; col: number };
      if (ed?.view) {
        const s = ed.view.state.selection.main;
        selection = ed.view.state.sliceDoc(s.from, s.to);
        const line = ed.view.state.doc.lineAt(s.head);
        cursor = { line: line.number, col: s.head - line.from + 1 };
      }
      const branch = wb.git?.branch ?? null;
      const changes = await host.capture("git", ["-C", wb.root, "status", "--porcelain"], wb.root, undefined, 10).then((r) => (r.code === 0 ? r.stdout.split("\n").filter(Boolean).slice(0, 60) : [])).catch(() => []);
      return json({
        project: wb.root,
        activeFile: ed?.path ?? null,
        cursor,
        selection: selection ? clip(selection) : null,
        unsavedChanges: ed?.dirty ?? false,
        openFiles: wb.editors.all().map((e) => e.path),
        openTabs: wb.tabs.tabs.map((t) => t.title),
        pythonInterpreter: wb.python?.path ?? null,
        git: { branch, changes },
        plugins: { airflow: !!wb.airflow, ...Object.fromEntries(Object.entries(wb.plugins).map(([k, v]) => [k, !!v])), docker: !!wb.docker },
        dbtProject: wb.settings.dbt?.projectDir ?? null,
      });
    }
    case "read_editor": {
      const p = resolve(wb, a.path);
      if (!p) throw new Error("Nenhum arquivo ativo.");
      const ed = wb.editors.get(p);
      const text = ed?.view ? ed.view.state.doc.toString() : (await host.read(p)).text;
      return clip(`${p}${ed?.dirty ? " (com alterações não salvas)" : ""}\n\n${text}`);
    }
    case "diagnostics": {
      const p = a.path ? resolve(wb, a.path) : null;
      const out: unknown[] = [];
      for (const [file, list] of wb.lsp.diagnostics) {
        if (p && !P.same(file, p)) continue;
        for (const d of list) out.push({ file, line: d.line + 1, col: d.col + 1, severity: ["", "erro", "aviso", "info", "dica"][d.severity] ?? d.severity, message: d.message, source: d.source, code: d.code });
      }
      return out.length ? json(out.slice(0, 500)) : "Nenhum problema reportado pelos servidores de linguagem.";
    }
    case "open_in_editor": {
      const p = resolve(wb, a.path)!;
      await wb.editors.openFile(p, { line: a.line });
      return `Aberto: ${p}${a.line ? `:${a.line}` : ""}`;
    }
    case "db_connections":
      await store.load().catch(() => {});
      return json(store.connections.map((c) => ({ id: c.id, name: c.name, kind: c.kind, host: c.host, port: c.port, database: c.database, readOnly: c.readOnly })));
    case "db_schema": {
      const c = conn(a.connection);
      const db = a.database || c.database || "";
      if (a.table) {
        const schema = a.schema || (c.kind === "postgres" ? "public" : db);
        const [cols, idx] = await Promise.all([api.columns(c.id, db, schema, a.table), api.indexes(c.id, db, schema, a.table).catch(() => [])]);
        return json({ table: `${schema}.${a.table}`, columns: cols, indexes: idx });
      }
      let tables = await api.completion(c.id, db);
      if (a.schema) tables = tables.filter((t) => t.schema === a.schema);
      return json(tables.slice(0, 400).map((t) => ({ table: t.schema ? `${t.schema}.${t.table}` : t.table, columns: t.columns })));
    }
    case "db_query": {
      const c = conn(a.connection);
      const r = await invoke<{ columns: string[]; rows: (string | null)[][]; truncated: boolean }>("assistant_db_query", { connId: c.id, db: a.database || "", sql: a.sql, maxRows: a.max_rows ?? 100 });
      return json({ columns: r.columns, rows: r.rows, rowCount: r.rows.length, truncated: r.truncated });
    }
    case "airflow_overview": {
      const { inst, api: af, all } = await airflowInstance(a.instance);
      const [dags, errs] = await Promise.all([af.dags({ limit: 100, offset: 0, search: a.search }), af.importErrors().catch(() => null)]);
      return json({
        instances: all.map((i) => ({ id: i.id, name: i.name, url: i.url })),
        instance: inst.name,
        dags: dags.dags.map((d) => ({ dag_id: d.dag_id, paused: d.is_paused, tags: d.tags.map((t) => t.name), schedule: d.timetable_summary, file: d.relative_fileloc, import_errors: d.has_import_errors, next_run: d.next_dagrun_run_after })),
        totalDags: dags.total_entries,
        importErrors: (errs as { import_errors?: unknown[] } | null)?.import_errors ?? [],
      });
    }
    case "airflow_runs": {
      const { api: af } = await airflowInstance(a.instance);
      const runs = await af.runs(a.dag_id, 10, 0);
      const runId = a.run_id ?? runs.dag_runs[0]?.dag_run_id;
      const tasks = runId ? await af.taskInstances(a.dag_id, runId) : null;
      return json({ runs: runs.dag_runs.map((r) => ({ run_id: r.dag_run_id, state: r.state, type: r.run_type, start: r.start_date, end: r.end_date })), tasks: tasks?.task_instances.map((t: any) => ({ task_id: t.task_id, state: t.state, try_number: t.try_number, duration: t.duration })) ?? [], run_id: runId ?? null });
    }
    case "airflow_task_log": {
      const { api: af } = await airflowInstance(a.instance);
      const r = await af.logs(a.dag_id, a.run_id, a.task_id, a.try_number ?? 1);
      const text = typeof r.content === "string" ? r.content : r.content.map((e: any) => `${e.timestamp ?? ""} ${e.level ?? ""} ${e.event ?? ""}`).join("\n");
      return clip(text.slice(-LIMIT));
    }
    case "dbt_overview": {
      const dir = wb.settings.dbt?.projectDir;
      if (!dir) return "Nenhum projeto dbt configurado nesta janela (plugin dbt).";
      const { dbt } = await import("../dbt/api");
      const s = await dbt.artifacts(dir);
      const f = (a.filter ?? "").toLowerCase();
      const nodes = s.nodes.filter((n) => n.package === s.projectName && (!f || n.name.toLowerCase().includes(f)));
      return json({
        projectDir: dir,
        project: s.projectName,
        artifacts: { manifest: s.manifest.compat, runResults: s.runResults.compat, dbtVersion: s.manifest.dbtVersion, staleFiles: s.changedSinceResults },
        nodes: nodes.slice(0, 300).map((n) => ({ id: n.uniqueId, type: n.resourceType, file: n.path, depends_on: n.dependsOn, materialized: n.materialized || undefined, tags: n.tags.length ? n.tags : undefined })),
        lastRun: { command: s.command, elapsed: s.elapsed, results: s.results.map((r) => ({ id: r.uniqueId, status: r.status, time: r.executionTime, message: r.status === "success" || r.status === "pass" ? undefined : r.message, failures: r.failures ?? undefined })) },
      });
    }
    case "jupyter_notebooks": {
      const jt = wb.plugins.jupyter as unknown as { notebooks?: Map<string, any> } | null;
      if (!jt?.notebooks) return "O plugin Jupyter não está ativo.";
      const out = [];
      for (const nb of jt.notebooks.values()) {
        if (a.path && !String(nb.storage?.path ?? "").includes(a.path)) continue;
        out.push({
          path: nb.storage?.path,
          kernel: `${nb.kernelLabel} (${nb.kstate})`,
          server: nb.srv?.name ?? null,
          cells: (nb.cells ?? []).map((c: any, i: number) => ({
            index: i + 1,
            type: c.cell.cell_type,
            execution_count: c.cell.execution_count ?? null,
            source: c.editor.state.doc.toString(),
            outputs: (c.cell.outputs ?? []).map((o: any) => (o.output_type === "stream" ? [o.text].flat().join("") : o.output_type === "error" ? `${o.ename}: ${o.evalue}` : o.data?.["text/plain"] ? [o.data["text/plain"]].flat().join("") : `[${Object.keys(o.data ?? {}).join(", ")}]`).slice(0, 3000)),
          })),
        });
      }
      return out.length ? json(out) : "Nenhum notebook aberto.";
    }
    case "docker_containers": {
      const r = await host.capture("docker", ["ps", "-a", "--format", "{{json .}}"], "", undefined, 20).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      if (r.code !== 0) return `Docker indisponível: ${r.stderr.trim()}`;
      return json(r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((c: any) => ({ name: c.Names, image: c.Image, state: c.State, status: c.Status, ports: c.Ports, compose: (c.Labels as string)?.match(/com\.docker\.compose\.project=([^,]+)/)?.[1] })));
    }
    case "audit_overview": {
      const { audit } = await import("../audit/api");
      const projects = await audit.projects();
      const out = [];
      for (const { project: p, baselines, runs } of projects) {
        const h = await audit.history(p.id).catch(() => null);
        out.push({ id: p.id, name: p.name, source: p.source.name, target: p.target.name, baselines, runs, lastRun: h?.runs[0] ? { id: h.runs[0].id, status: h.runs[0].status, summary: h.runs[0].summary } : null });
      }
      return out.length ? json(out) : "Nenhum projeto do Migration Audit.";
    }
  }
  throw new Error(`Ferramenta desconhecida: ${name}`);
}
