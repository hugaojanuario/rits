// DAG tab: run history, task graph colored by the selected run, task details and logs per try
// (live while running), trigger with JSON conf and clear/re-run with the scope shown first.
import { h } from "../../util";
import { icon } from "../../icons";
import { button, modal, notify, toast } from "../../ui";
import type { Tab } from "../../tabs";
import {
  AirflowApi,
  errorText,
  fmtDate,
  fmtDuration,
  isAfError,
  TERMINAL_RUN,
  TERMINAL_TASK,
  type Dag,
  type DagRun,
  type LogEvent,
  type Task,
  type TaskInstance,
} from "./api";
import { openWeb } from "./web";
import type { AirflowTools } from "./panel";

const POLL_MS = 3000;

export function openDagTab(tools: AirflowTools, api: AirflowApi, dagId: string, runId?: string) {
  const id = `airflow:${api.inst.id}:${dagId}`;
  const existing = tools.wb.tabs.find(id) as (Tab & { selectRun?: (r: string) => void }) | undefined;
  if (existing) {
    tools.wb.tabs.activate(existing);
    if (runId) existing.selectRun?.(runId);
    return;
  }
  tools.wb.tabs.open(createDagTab(tools, api, dagId, runId));
}

function createDagTab(tools: AirflowTools, api: AirflowApi, dagId: string, initialRun?: string): Tab & { selectRun: (r: string) => void } {
  let dag: Dag | null = null;
  let tasks: Task[] = [];
  let runs: DagRun[] = [];
  let runsTotal = 0;
  let run: DagRun | null = null;
  let tis: TaskInstance[] = [];
  let task: string | null = null;
  let tryNo = 1;
  let active = true;
  let closed = false;
  let timer: number | null = null;
  let logTimer: number | null = null;
  let logToken: string | null = null;
  let logKey = "";

  const header = h("div.afd-head");
  const runList = h("div.afd-runs");
  const runInfo = h("div.afd-runinfo");
  const graph = h("div.afd-graph");
  const taskPane = h("div.afd-task");
  const logView = h("pre.afd-log");
  const el = h(
    "div.afd",
    null,
    header,
    h("div.afd-body", null, h("div.afd-left", null, h("div.afd-sec", null, "Execuções"), runList), h("div.afd-right", null, runInfo, graph, taskPane)),
  );

  // ---------------- loading ----------------

  async function loadAll() {
    try {
      [dag, tasks] = await Promise.all([api.dag(dagId), api.tasks(dagId).then((r) => r.tasks)]);
    } catch (e) {
      el.replaceChildren(h("div.af-empty", null, icon("status/warningOutline", "ic20"), h("b", null, "Não foi possível abrir a DAG"), h("span.dim.af-err", null, errorText(e)), button("Tentar de novo", () => (el.replaceChildren(header, el.lastChild!), loadAll()))));
      return;
    }
    renderHeader();
    await loadRuns(initialRun);
  }

  async function loadRuns(select?: string) {
    try {
      const r = await api.runs(dagId, Math.max(30, runs.length));
      runs = r.dag_runs;
      runsTotal = r.total_entries;
    } catch (e) {
      toast(errorText(e), "error");
    }
    const keep = select ?? run?.dag_run_id ?? runs[0]?.dag_run_id;
    run = runs.find((x) => x.dag_run_id === keep) ?? runs[0] ?? null;
    renderRuns();
    await loadRun();
  }

  async function loadRun() {
    if (!run) {
      tis = [];
      renderRun();
      return;
    }
    try {
      const [r, t] = await Promise.all([api.run(dagId, run.dag_run_id), api.taskInstances(dagId, run.dag_run_id)]);
      run = r;
      tis = t.task_instances;
      const i = runs.findIndex((x) => x.dag_run_id === r.dag_run_id);
      if (i >= 0) runs[i] = r;
    } catch (e) {
      if (!(isAfError(e) && e.kind === "cancelled")) toast(errorText(e), "error");
    }
    renderRuns();
    renderRun();
    schedule();
  }

  /** Polls the run while it is not finished and the tab is visible. */
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (closed || !run) return;
    const unfinished = !TERMINAL_RUN.includes(run.state) || tis.some((t) => t.state && !TERMINAL_TASK.has(t.state));
    if (!unfinished) return;
    timer = window.setTimeout(() => (active ? loadRun() : schedule()), POLL_MS);
  }

  // ---------------- header ----------------

  function renderHeader() {
    if (!dag) return;
    const d = dag;
    const local = tools.project.localFileFor(d);
    const sw = h("button.af-switch", { class: d.is_paused ? "" : "on", title: d.is_paused ? "Pausada" : "Ativa" }, h("i")) as HTMLButtonElement;
    sw.onclick = async () => {
      sw.disabled = true;
      try {
        dag = await api.setPaused(d.dag_id, !d.is_paused);
        renderHeader();
      } catch (e) {
        notify("Não foi possível alterar a pausa", errorText(e), "error");
        sw.disabled = false;
      }
    };
    header.replaceChildren(
      h(
        "div.afd-title",
        null,
        sw,
        h("div", null, h("b", null, d.dag_display_name || d.dag_id), h("div.dim", null, d.description ?? "")),
        h("span.grow"),
        button("Disparar…", () => triggerDialog(api, d, (r) => loadRuns(r.dag_run_id)), "primary", "run/run"),
        button("Atualizar", () => loadRuns(), "", "general/refresh"),
        local ? button("Abrir arquivo", () => tools.wb.editors.openFile(local), "", "fileTypes/python") : "",
        button("Web", () => openWeb(api.webUrl(d.dag_id), d.dag_id), "", "general/openNewTab"),
      ),
      h(
        "div.afd-meta",
        null,
        meta("Agendamento", d.timetable_description || d.timetable_summary || "sem agendamento"),
        meta("Próxima execução", fmtDate(d.next_dagrun_run_after)),
        meta("Donos", d.owners.join(", ") || "—"),
        meta("Tags", d.tags.map((t) => t.name).join(", ") || "—"),
        meta("Arquivo", d.relative_fileloc ?? d.fileloc),
        meta("Processada em", fmtDate(d.last_parsed_time)),
        d.is_paused ? h("span.af-badge", { title: "Execuções disparadas ficam na fila até a DAG ser ativada" }, "pausada") : "",
        d.has_import_errors ? h("span.af-badge.err", null, "erro de importação") : "",
      ),
    );
  }

  const meta = (k: string, v: string) => h("span.afd-kv", null, h("span.dim", null, k), h("span", { title: v }, v));

  // ---------------- runs ----------------

  function renderRuns() {
    if (!runs.length) {
      runList.replaceChildren(h("div.empty-note", null, "Nenhuma execução ainda."));
      return;
    }
    runList.replaceChildren(
      ...runs.map((r) =>
        h(
          "div.afd-run",
          { class: r.dag_run_id === run?.dag_run_id ? "selected" : "", onclick: () => selectRun(r.dag_run_id), title: r.dag_run_id },
          h("span.af-dot", { class: r.state }),
          h("div.af-main", null, h("span", null, fmtDate(r.start_date ?? r.run_after)), h("span.af-sub", null, `${r.run_type} · ${fmtDuration(r.duration)}`)),
        ),
      ),
      runs.length < runsTotal ? h("button.link", { onclick: () => loadMoreRuns() }, `Carregar mais (${runsTotal - runs.length})`) : "",
    );
  }

  async function loadMoreRuns() {
    try {
      const r = await api.runs(dagId, 30, runs.length);
      runs.push(...r.dag_runs);
      runsTotal = r.total_entries;
      renderRuns();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  function selectRun(id: string) {
    run = runs.find((r) => r.dag_run_id === id) ?? run;
    task = null;
    stopLogs();
    renderRuns();
    loadRun();
  }

  // ---------------- run + graph ----------------

  function renderRun() {
    if (!run) {
      runInfo.replaceChildren(h("div.dim", null, "Dispare uma execução para acompanhar as tarefas aqui."));
      renderGraph();
      taskPane.replaceChildren();
      return;
    }
    const r = run;
    runInfo.replaceChildren(
      h("span.af-state", { class: r.state }, r.state),
      meta("Execução", r.dag_run_id),
      meta("Início", fmtDate(r.start_date)),
      meta("Fim", fmtDate(r.end_date)),
      meta("Duração", fmtDuration(r.duration)),
      meta("Disparada por", r.triggering_user_name ?? r.triggered_by ?? r.run_type),
      r.conf && Object.keys(r.conf).length ? h("span.afd-kv", null, h("span.dim", null, "conf"), h("code", null, JSON.stringify(r.conf))) : "",
      h("span.grow"),
      h("button.link", { onclick: () => openWeb(api.webUrl(dagId, r.dag_run_id), r.dag_run_id) }, "Abrir na web"),
    );
    renderGraph();
    renderTask();
  }

  /** Layered graph: roots on the left, edges from downstream_task_ids. */
  function renderGraph() {
    if (!tasks.length) return graph.replaceChildren(h("div.dim", null, "DAG sem tarefas."));
    const byId = new Map(tasks.map((t) => [t.task_id, t]));
    const ups = new Map<string, string[]>(tasks.map((t) => [t.task_id, []]));
    for (const t of tasks) for (const d of t.downstream_task_ids) ups.get(d)?.push(t.task_id);
    const rank = new Map<string, number>();
    const visit = (id: string, seen: Set<string>): number => {
      if (rank.has(id)) return rank.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const r = Math.max(-1, ...(ups.get(id) ?? []).map((u) => visit(u, seen))) + 1;
      rank.set(id, r);
      return r;
    };
    tasks.forEach((t) => visit(t.task_id, new Set()));
    const cols: string[][] = [];
    for (const t of tasks) (cols[rank.get(t.task_id)!] ??= []).push(t.task_id);
    const W = 176;
    const H = 38;
    const GX = 64;
    const GY = 16;
    const pos = new Map<string, { x: number; y: number }>();
    const maxRows = Math.max(...cols.map((c) => c?.length ?? 0));
    cols.forEach((c, ci) => c?.forEach((id, ri) => pos.set(id, { x: 12 + ci * (W + GX), y: 12 + (ri + (maxRows - c.length) / 2) * (H + GY) })));
    const width = 24 + cols.length * (W + GX) - GX;
    const height = 24 + maxRows * (H + GY) - GY;
    const state = new Map<string, TaskInstance>();
    for (const t of tis) if (!state.has(t.task_id) || t.map_index <= 0) state.set(t.task_id, t);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.classList.add("afd-svg");
    let edges = `<defs><marker id="afd-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L8 4L0 8z" style="fill:var(--dg-edge)"/></marker></defs>`;
    for (const t of tasks) {
      const a = pos.get(t.task_id)!;
      for (const d of t.downstream_task_ids) {
        const b = pos.get(d);
        if (!b) continue;
        const x1 = a.x + W;
        const y1 = a.y + H / 2;
        const x2 = b.x;
        const y2 = b.y + H / 2;
        edges += `<path class="afd-edge" d="M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2 - 2},${y2}" marker-end="url(#afd-arrow)"/>`;
      }
    }
    svg.innerHTML = edges;
    const wrap = h("div.afd-canvas", { style: `width:${width}px;height:${height}px` }, svg);
    for (const [id, p] of pos) {
      const ti = state.get(id);
      const t = byId.get(id)!;
      wrap.append(
        h(
          "button.afd-node",
          {
            class: [ti?.state ?? "none", task === id ? "selected" : ""].join(" "),
            style: `left:${p.x}px;top:${p.y}px;width:${W}px;height:${H}px`,
            title: `${id}${t.operator_name ? ` · ${t.operator_name}` : ""}${ti ? ` · ${ti.state ?? "sem estado"}` : ""}`,
            onclick: () => selectTask(id),
          },
          h("span.af-dot", { class: ti?.state ?? "" }),
          h("span.afd-node-name", null, t.task_display_name || id),
          h("span.afd-node-op", null, t.operator_name ?? ""),
        ),
      );
    }
    graph.replaceChildren(wrap);
  }

  // ---------------- task + logs ----------------

  function selectTask(id: string) {
    task = id;
    const ti = tis.find((t) => t.task_id === id);
    tryNo = Math.max(1, ti?.try_number ?? 1);
    renderGraph();
    renderTask();
  }

  function renderTask() {
    if (!task || !run) {
      stopLogs();
      taskPane.replaceChildren(run ? h("div.dim.afd-hint", null, "Clique numa tarefa do grafo para ver detalhes e logs.") : "");
      return;
    }
    const ti = tis.find((t) => t.task_id === task);
    const tries = Math.max(1, ti?.try_number ?? 1);
    const trySel = h("select.select.small", { onchange: (e: Event) => ((tryNo = Number((e.target as HTMLSelectElement).value)), startLogs(true)) }, ...Array.from({ length: tries }, (_, i) => h("option", { value: i + 1, selected: i + 1 === tryNo }, `Tentativa ${i + 1}`)));
    taskPane.replaceChildren(
      h(
        "div.afd-task-head",
        null,
        h("b", null, task),
        ti ? h("span.af-state", { class: ti.state ?? "" }, ti.state ?? "sem estado") : h("span.dim", null, "sem instância nesta execução"),
        ti ? meta("Duração", fmtDuration(ti.duration)) : "",
        ti ? meta("Tentativas", `${ti.try_number}/${ti.max_tries + 1}`) : "",
        ti?.hostname ? meta("Host", ti.hostname) : "",
        h("span.grow"),
        trySel,
        button("Limpar / reexecutar…", () => clearDialog(), "", "run/rerun"),
        h("button.link", { onclick: () => openWeb(api.webUrl(dagId, run!.dag_run_id, task!), task!) }, "Web"),
      ),
      logView,
    );
    startLogs(logKey !== `${run.dag_run_id}|${task}|${tryNo}`);
  }

  function stopLogs() {
    if (logTimer) clearTimeout(logTimer);
    logTimer = null;
  }

  /** Loads the log of the selected try; keeps polling while the task runs. */
  async function startLogs(reset: boolean) {
    stopLogs();
    if (!run || !task) return;
    const key = `${run.dag_run_id}|${task}|${tryNo}`;
    if (reset || key !== logKey) {
      logKey = key;
      logToken = null;
      logView.textContent = "Carregando log…";
    }
    const ti = tis.find((t) => t.task_id === task);
    if (!ti || !ti.state || ti.state === "scheduled" || ti.state === "queued") {
      logView.textContent = ti?.state ? `A tarefa está ${ti.state === "queued" ? "na fila" : "agendada"}; o log aparece quando ela começar.` : "Ainda não há log para esta tarefa.";
    } else {
      try {
        const r = await api.logs(dagId, run.dag_run_id, task, tryNo, ti.map_index ?? -1);
        if (key !== logKey) return;
        logView.replaceChildren(...renderLog(r.content));
        logView.scrollTop = logView.scrollHeight;
        logToken = r.continuation_token;
      } catch (e) {
        if (key === logKey) logView.textContent = errorText(e);
      }
    }
    const running = ti && ti.state && !TERMINAL_TASK.has(ti.state) && tryNo === ti.try_number;
    if (running && !closed) logTimer = window.setTimeout(() => (active ? startLogs(false) : stopLogs()), POLL_MS);
  }

  function renderLog(content: LogEvent[] | string): Node[] {
    if (typeof content === "string") return [document.createTextNode(content)];
    const out: Node[] = [];
    for (const ev of content) {
      const text = String(ev.event ?? "");
      if (text.startsWith("::group::")) {
        out.push(h("span.afl-group", null, "▸ " + text.slice(9) + "\n"));
        continue;
      }
      if (text === "::endgroup::") continue;
      const time = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString("pt-BR", { hour12: false }) + " " : "";
      const lvl = (ev.level ?? "").toUpperCase();
      out.push(h("span", { class: `afl-${(ev.level ?? "info").toLowerCase()}` }, `${time}${lvl ? lvl.padEnd(7) : ""}${text}\n`));
      for (const k of ["error_detail", "exception"]) if (ev[k]) out.push(h("span.afl-error", null, JSON.stringify(ev[k], null, 2) + "\n"));
    }
    if (logToken) out.push(h("span.dim", null, "…\n"));
    return out;
  }

  /** Clear (re-run) with the scope computed by a dry run before anything changes. */
  function clearDialog() {
    if (!run || !task) return;
    const m = modal(`Limpar tarefa ${task}`, { width: 560 });
    const opt = { include_downstream: true, include_upstream: false, only_failed: false };
    const scope = h("div.afd-scope", null, "Calculando alcance…");
    const chk = (k: keyof typeof opt, label: string) => {
      const i = h("input", { type: "checkbox", checked: opt[k], onchange: (e: Event) => ((opt[k] = (e.target as HTMLInputElement).checked), dry()) });
      return h("label.check", null, i, label);
    };
    const go = button("Limpar e reexecutar", () => apply(), "danger", "run/rerun") as HTMLButtonElement;
    go.disabled = true;
    const body = () => ({ dag_run_id: run!.dag_run_id, task_ids: [task!], ...opt, reset_dag_runs: true });
    let found = 0;
    const dry = async () => {
      go.disabled = true;
      scope.textContent = "Calculando alcance…";
      try {
        const r = await api.clear(dagId, { dry_run: true, ...body() });
        found = r.task_instances.length;
        scope.replaceChildren(
          h("div", null, found ? `${found} instância(s) de tarefa voltarão a executar:` : "Nenhuma instância seria afetada com essas opções."),
          ...r.task_instances.map((t) => h("div.afd-scope-row", null, h("span.af-dot", { class: t.state ?? "" }), t.task_id, h("span.dim", null, ` ${t.state ?? "sem estado"}`))),
        );
        go.disabled = found === 0;
      } catch (e) {
        scope.replaceChildren(h("span.err", null, errorText(e)));
      }
    };
    const apply = async () => {
      go.disabled = true; // one click = one request; never re-sent automatically
      try {
        const r = await api.clear(dagId, { dry_run: false, ...body() });
        m.close();
        toast(`${r.task_instances.length} instância(s) limpas; o scheduler vai reexecutá-las.`, "ok");
        loadRun();
      } catch (e) {
        scope.append(h("div.err", null, errorText(e)));
      }
    };
    m.body.append(
      h("p.dim", null, `Execução ${run.dag_run_id}. Limpar apaga o estado das instâncias para que o scheduler as execute de novo.`),
      h("div.checks", null, chk("include_downstream", "Incluir tarefas seguintes (downstream)"), chk("include_upstream", "Incluir tarefas anteriores (upstream)"), chk("only_failed", "Somente as que falharam")),
      scope,
    );
    m.footer.append(button("Cancelar", () => m.close()), go);
    dry();
  }

  setTimeout(loadAll);
  return {
    id: `airflow:${api.inst.id}:${dagId}`,
    title: dagId,
    icon: "airflow",
    tooltip: `${api.inst.name} — ${dagId}`,
    el,
    onActivate: () => {
      active = true;
      if (run && !timer) schedule();
    },
    onDeactivate: () => {
      active = false;
    },
    onClose: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      stopLogs();
    },
    selectRun: (r: string) => loadRuns(r),
  };
}

/** Trigger with optional JSON conf. The button is disabled after the click: no duplicate runs. */
export function triggerDialog(api: AirflowApi, dag: Dag, onDone: (run: DagRun) => void) {
  const m = modal(`Disparar ${dag.dag_id}`, { width: 560 });
  const conf = h("textarea.textarea.afd-conf", { rows: 8, spellcheck: false, placeholder: '{\n  "data": "2026-01-01"\n}' }) as HTMLTextAreaElement;
  const note = h("input.input", { placeholder: "Nota (opcional)" }) as HTMLInputElement;
  const err = h("div.err");
  const go = button("Disparar", () => run(), "primary", "run/run") as HTMLButtonElement;
  const run = async () => {
    let parsed: Record<string, unknown> | null = null;
    const t = conf.value.trim();
    if (t) {
      try {
        parsed = JSON.parse(t);
        if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) throw new Error("A configuração precisa ser um objeto JSON.");
      } catch (e) {
        err.textContent = `JSON inválido: ${(e as Error).message}`;
        return;
      }
    }
    go.disabled = true;
    err.textContent = "";
    try {
      const r = await api.trigger(dag.dag_id, parsed, note.value.trim() || null);
      m.close();
      toast(`Execução ${r.dag_run_id} criada (${r.state}).`, "ok");
      onDone(r);
    } catch (e) {
      // not retried: if the server is unsure (timeout), check the run list before trying again
      err.textContent = errorText(e) + (isAfError(e) && (e.kind === "timeout" || e.kind === "server") ? "\nConfira a lista de execuções antes de disparar de novo." : "");
      go.disabled = false;
    }
  };
  m.body.append(
    dag.is_paused ? h("div.af-warn", null, icon("status/warning"), "A DAG está pausada: a execução fica na fila até ela ser ativada.") : "",
    h("label.field", null, h("span", null, "Configuração (conf, JSON)"), conf),
    h("label.field", { style: "margin-top:10px" }, h("span", null, "Nota"), note),
    err,
  );
  m.footer.append(button("Cancelar", () => m.close()), go);
  setTimeout(() => conf.focus());
}
