// Typed client for the Airflow 3 public REST API (/api/v2). Every call goes through the Rust
// commands in src-tauri/src/airflow (auth, secrets, TLS, retries policy); nothing here sees a
// password or token. Endpoints and fields follow the OpenAPI of Airflow 3.3.
import { invoke } from "@tauri-apps/api/core";
import { uid } from "../../util";

export type AuthKind = "password" | "token" | "none";

export interface AfInstance {
  id: string;
  name: string;
  url: string;
  auth: AuthKind;
  username: string;
  timeoutSecs: number;
  verifyTls: boolean;
  /** Slug of the local Docker environment that created it ("" = external instance). */
  localEnv: string;
  hasSecret?: boolean;
}

/** Classified error from the backend (see client.rs). */
export interface AfError {
  kind: "auth" | "forbidden" | "notFound" | "conflict" | "unreachable" | "timeout" | "tls" | "server" | "http" | "incompatible" | "cancelled" | "invalid" | "secret";
  status: number | null;
  message: string;
}

export function isAfError(e: unknown): e is AfError {
  return !!e && typeof e === "object" && "kind" in e && "message" in e;
}

/** Short explanation for the UI, telling server/auth problems apart from pipeline failures. */
export function errorText(e: unknown): string {
  if (!isAfError(e)) return String(e);
  const prefix: Partial<Record<AfError["kind"], string>> = {
    unreachable: "Servidor indisponível",
    timeout: "Servidor não respondeu",
    tls: "Erro de TLS",
    auth: "Erro de autenticação",
    forbidden: "Sem permissão",
    incompatible: "Versão incompatível",
  };
  return prefix[e.kind] ? `${prefix[e.kind]}: ${e.message}` : e.message;
}

export type DagRunState = "queued" | "running" | "success" | "failed";
export type TaskState =
  | "removed" | "scheduled" | "queued" | "running" | "success" | "restarting" | "failed" | "up_for_retry"
  | "up_for_reschedule" | "upstream_failed" | "skipped" | "deferred" | "awaiting_input" | null;

export interface Dag {
  dag_id: string;
  dag_display_name: string;
  is_paused: boolean;
  is_stale: boolean;
  last_parsed_time: string | null;
  relative_fileloc: string | null;
  fileloc: string;
  description: string | null;
  timetable_summary: string | null;
  timetable_description: string | null;
  tags: { name: string }[];
  owners: string[];
  has_import_errors: boolean;
  next_dagrun_run_after: string | null;
  max_active_runs: number | null;
}

export interface DagRun {
  dag_run_id: string;
  dag_id: string;
  logical_date: string | null;
  run_after: string;
  queued_at: string | null;
  start_date: string | null;
  end_date: string | null;
  duration: number | null;
  run_type: string;
  state: DagRunState;
  triggered_by: string | null;
  triggering_user_name: string | null;
  conf: Record<string, unknown> | null;
  note: string | null;
}

export interface TaskInstance {
  task_id: string;
  task_display_name: string;
  dag_run_id: string;
  map_index: number;
  state: TaskState;
  try_number: number;
  max_tries: number;
  start_date: string | null;
  end_date: string | null;
  duration: number | null;
  operator_name: string | null;
  hostname: string | null;
}

export interface Task {
  task_id: string;
  task_display_name: string;
  operator_name: string | null;
  downstream_task_ids: string[];
  retries: number | null;
  doc_md: string | null;
  is_mapped: boolean | null;
  trigger_rule: string | null;
}

export interface ImportError {
  import_error_id: number;
  timestamp: string;
  filename: string;
  bundle_name: string | null;
  stack_trace: string;
}

export interface LogEvent {
  event: string;
  timestamp?: string;
  level?: string;
  logger?: string;
  [k: string]: unknown;
}

const seg = (s: string) => encodeURIComponent(s);
type Q = [string, string][];

/** API bound to one instance. `rid` lets the caller cancel slow requests. */
export class AirflowApi {
  constructor(readonly inst: AfInstance) {}

  private call<T>(method: string, path: string, query: Q = [], body?: unknown, rid?: string): Promise<T> {
    return invoke<T>("airflow_request", { id: this.inst.id, method, path, query, body: body ?? null, requestId: rid ?? null });
  }

  static cancel(rid: string) {
    return invoke<void>("airflow_cancel", { requestId: rid });
  }

  dags(opts: { limit: number; offset: number; search?: string; tags?: string[]; paused?: boolean; lastState?: DagRunState; rid?: string }) {
    const q: Q = [["limit", String(opts.limit)], ["offset", String(opts.offset)], ["order_by", "dag_id"], ["exclude_stale", "true"]];
    if (opts.search) q.push(["dag_id_pattern", opts.search]);
    for (const t of opts.tags ?? []) q.push(["tags", t]);
    if (opts.paused !== undefined) q.push(["paused", String(opts.paused)]);
    if (opts.lastState) q.push(["last_dag_run_state", opts.lastState]);
    return this.call<{ dags: Dag[]; total_entries: number }>("GET", "/api/v2/dags", q, undefined, opts.rid);
  }

  allTags() {
    return invoke<{ tags: string[]; total_entries: number }>("airflow_get_all", { id: this.inst.id, path: "/api/v2/dagTags", query: [["order_by", "name"]], key: "tags", max: 2000, requestId: null });
  }

  dag(dagId: string) {
    return this.call<Dag>("GET", `/api/v2/dags/${seg(dagId)}`);
  }

  setPaused(dagId: string, paused: boolean) {
    return this.call<Dag>("PATCH", `/api/v2/dags/${seg(dagId)}`, [["update_mask", "is_paused"]], { is_paused: paused });
  }

  /** logical_date null = run now (Airflow 3). Never retried automatically. */
  trigger(dagId: string, conf: Record<string, unknown> | null, note: string | null) {
    return this.call<DagRun>("POST", `/api/v2/dags/${seg(dagId)}/dagRuns`, [], { logical_date: null, conf: conf ?? {}, note });
  }

  runs(dagId: string, limit = 50, offset = 0, rid?: string) {
    return this.call<{ dag_runs: DagRun[]; total_entries: number }>("GET", `/api/v2/dags/${seg(dagId)}/dagRuns`, [["limit", String(limit)], ["offset", String(offset)], ["order_by", "-run_after"]], undefined, rid);
  }

  run(dagId: string, runId: string) {
    return this.call<DagRun>("GET", `/api/v2/dags/${seg(dagId)}/dagRuns/${seg(runId)}`);
  }

  taskInstances(dagId: string, runId: string, rid?: string) {
    return this.call<{ task_instances: TaskInstance[]; total_entries: number }>("GET", `/api/v2/dags/${seg(dagId)}/dagRuns/${seg(runId)}/taskInstances`, [["limit", "1000"]], undefined, rid);
  }

  tasks(dagId: string) {
    return this.call<{ tasks: Task[]; total_entries: number }>("GET", `/api/v2/dags/${seg(dagId)}/tasks`);
  }

  logs(dagId: string, runId: string, taskId: string, tryNumber: number, mapIndex = -1, token?: string | null, rid?: string) {
    const q: Q = [["full_content", "true"], ["map_index", String(mapIndex)]];
    if (token) q.push(["token", token]);
    return this.call<{ content: LogEvent[] | string; continuation_token: string | null }>(
      "GET",
      `/api/v2/dags/${seg(dagId)}/dagRuns/${seg(runId)}/taskInstances/${seg(taskId)}/logs/${tryNumber}`,
      q,
      undefined,
      rid,
    );
  }

  /** Clear task instances; call with dry_run first to show the scope. */
  clear(dagId: string, body: { dry_run: boolean; dag_run_id: string; task_ids: string[]; include_downstream: boolean; include_upstream: boolean; only_failed: boolean; reset_dag_runs?: boolean }) {
    return this.call<{ task_instances: TaskInstance[]; total_entries: number }>("POST", `/api/v2/dags/${seg(dagId)}/clearTaskInstances`, [], body);
  }

  importErrors(rid?: string) {
    return this.call<{ import_errors: ImportError[]; total_entries: number }>("GET", "/api/v2/importErrors", [["limit", "100"], ["order_by", "-timestamp"]], undefined, rid);
  }

  /** Web UI page for a DAG / run / task (opened outside the API, for the official interface). */
  webUrl(dagId?: string, runId?: string, taskId?: string) {
    let u = this.inst.url.replace(/\/+$/, "");
    if (dagId) u += `/dags/${seg(dagId)}`;
    if (runId) u += `/runs/${seg(runId)}`;
    if (taskId) u += `/tasks/${seg(taskId)}`;
    return u;
  }
}

// ---------------- instances ----------------

export const instances = {
  list: () => invoke<AfInstance[]>("airflow_instances"),
  save: (inst: AfInstance, secret: string | null) => invoke<AfInstance>("airflow_save_instance", { inst, secret }),
  remove: (id: string) => invoke<void>("airflow_delete_instance", { id }),
  test: (inst: AfInstance, secret: string | null) =>
    invoke<{ version: string; gitVersion: string | null; health: Record<string, { status?: string }>; dags: number | null }>("airflow_test", { inst, secret }),
  release: () => invoke<void>("airflow_release"),
};

export function newRequestId() {
  return "af-" + uid();
}

// ---------------- formatting ----------------

export function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(+d) ? s : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" });
}

export function fmtDuration(sec: number | null | undefined) {
  if (sec == null) return "—";
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)} s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min ${Math.round(sec % 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const TERMINAL_RUN: DagRunState[] = ["success", "failed"];
export const TERMINAL_TASK = new Set<TaskState>(["success", "failed", "skipped", "upstream_failed", "removed"]);
