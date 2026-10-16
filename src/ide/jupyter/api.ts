// Typed client of the Jupyter plugin. REST calls and kernel WebSockets go through the Rust commands
// (src-tauri/src/jupyter): the token never reaches this code, and every kernel message is built and
// parsed by the backend (protocol 5.3). Errors share the {kind, status, message} shape of Airflow.
import { invoke } from "@tauri-apps/api/core";
import { uid } from "../../util";
import { on } from "../host";

export interface JpServer {
  id: string;
  name: string;
  url: string;
  auth: "token" | "none";
  timeoutSecs: number;
  verifyTls: boolean;
  /** Slug of the local Docker environment that created it ("" = external server). */
  localEnv: string;
  /** Local project folder seen by the server and its path relative to the server root. */
  localRoot: string;
  remoteRoot: string;
  hasSecret?: boolean;
}

export interface JpError {
  kind: string;
  status: number | null;
  message: string;
}

export function isJpError(e: unknown): e is JpError {
  return !!e && typeof e === "object" && "kind" in e && "message" in e;
}

export function errorText(e: unknown): string {
  if (!isJpError(e)) return String(e);
  const prefix: Record<string, string> = { unreachable: "Servidor indisponível", timeout: "Servidor não respondeu", tls: "Erro de TLS", auth: "Erro de autenticação", incompatible: "Servidor incompatível" };
  return prefix[e.kind] ? `${prefix[e.kind]}: ${e.message}` : e.message;
}

export const servers = {
  list: () => invoke<JpServer[]>("jupyter_servers"),
  save: (srv: JpServer, secret: string | null) => invoke<JpServer>("jupyter_save_server", { srv, secret }),
  remove: (id: string) => invoke<void>("jupyter_delete_server", { id }),
  test: (srv: JpServer, secret: string | null) => invoke<{ version: string; kernelspecs: string[]; default: string | null }>("jupyter_test", { srv, secret }),
  release: () => invoke<void>("jupyter_release"),
  openLab: (id: string, path: string | null, external: boolean) => invoke<void>("jupyter_open_lab", { id, path, external }),
};

/** Encodes each segment of a contents path ("pasta/a b.ipynb" -> "pasta/a%20b.ipynb"). */
export const encPath = (p: string) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");

export interface KernelSpec {
  name: string;
  spec: { display_name: string; language: string; interrupt_mode?: string };
}

export interface KernelModel {
  id: string;
  name: string;
  last_activity?: string;
  execution_state?: string;
  connections?: number;
}

export interface SessionModel {
  id: string;
  path: string;
  name: string;
  type: string;
  kernel: KernelModel;
}

export interface ContentModel {
  name: string;
  path: string;
  type: "directory" | "file" | "notebook";
  last_modified: string;
  content: unknown;
  format: string | null;
}

export class JupyterApi {
  constructor(readonly srv: JpServer) {}

  req<T>(method: string, path: string, body?: unknown, query?: [string, string][], requestId?: string) {
    return invoke<T>("jupyter_request", { id: this.srv.id, method, path, query: query ?? null, body: body ?? null, requestId: requestId ?? null });
  }
  status() {
    return this.req<{ started: string; kernels: number; connections: number }>("GET", "/api/status");
  }
  kernelspecs() {
    return this.req<{ default: string; kernelspecs: Record<string, KernelSpec> }>("GET", "/api/kernelspecs");
  }
  kernels() {
    return this.req<KernelModel[]>("GET", "/api/kernels");
  }
  kernel(id: string) {
    return this.req<KernelModel>("GET", `/api/kernels/${encodeURIComponent(id)}`);
  }
  sessions() {
    return this.req<SessionModel[]>("GET", "/api/sessions");
  }
  createSession(path: string, kernel: string) {
    return this.req<SessionModel>("POST", "/api/sessions", { path, type: "notebook", name: path.split("/").pop() ?? "", kernel: { name: kernel } });
  }
  changeKernel(sessionId: string, kernel: string) {
    return this.req<SessionModel>("PATCH", `/api/sessions/${encodeURIComponent(sessionId)}`, { kernel: { name: kernel } });
  }
  deleteSession(id: string) {
    return this.req<void>("DELETE", `/api/sessions/${encodeURIComponent(id)}`);
  }
  interrupt(kid: string) {
    return this.req<void>("POST", `/api/kernels/${encodeURIComponent(kid)}/interrupt`);
  }
  restart(kid: string) {
    return this.req<KernelModel>("POST", `/api/kernels/${encodeURIComponent(kid)}/restart`);
  }
  shutdown(kid: string) {
    return this.req<void>("DELETE", `/api/kernels/${encodeURIComponent(kid)}`);
  }
  list(path: string) {
    return this.req<ContentModel & { content: ContentModel[] }>("GET", `/api/contents/${encPath(path)}`, undefined, [["content", "1"]]);
  }
  get(path: string) {
    return this.req<ContentModel>("GET", `/api/contents/${encPath(path)}`, undefined, [["content", "1"], ["type", "notebook"]]);
  }
  saveNotebook(path: string, nb: unknown) {
    return this.req<ContentModel>("PUT", `/api/contents/${encPath(path)}`, { type: "notebook", format: "json", content: nb });
  }
  newUntitled(dir: string) {
    return this.req<ContentModel>("POST", `/api/contents/${encPath(dir)}`, { type: "notebook" });
  }
}

/** Flattened kernel message from the backend. */
export interface KMsg {
  id: string;
  channel: string;
  msgType: string;
  msgId: string;
  parentId: string;
  content: any;
  metadata: any;
  buffers: number;
}

/** WebSocket of one kernel (one per open notebook). */
export class KernelChannel {
  readonly chan = "jpk-" + uid();
  private offMsg: (() => void) | null = null;
  private offClosed: (() => void) | null = null;
  open = false;

  constructor(
    readonly serverId: string,
    readonly kernelId: string,
    readonly sessionId: string,
    private onMsg: (m: KMsg) => void,
    private onClose: (reason: string) => void,
  ) {}

  async connect() {
    this.offMsg = on<KMsg>("jupyter-msg", this.chan, (m) => this.onMsg(m));
    this.offClosed = on<{ id: string; reason: string }>("jupyter-closed", this.chan, (e) => {
      this.open = false;
      this.onClose(e.reason);
    });
    try {
      await invoke("jupyter_ws_open", { chan: this.chan, id: this.serverId, kernelId: this.kernelId, sessionId: this.sessionId });
      this.open = true;
    } catch (e) {
      this.detach();
      throw e;
    }
  }

  send(channel: string, msgType: string, content: unknown) {
    return invoke<string>("jupyter_ws_send", { chan: this.chan, channel, msgType, content });
  }

  execute(code: string) {
    return this.send("shell", "execute_request", { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true });
  }

  complete(code: string, cursor: number) {
    return this.send("shell", "complete_request", { code, cursor_pos: cursor });
  }

  inspect(code: string, cursor: number) {
    return this.send("shell", "inspect_request", { code, cursor_pos: cursor, detail_level: 0 });
  }

  private detach() {
    this.offMsg?.();
    this.offClosed?.();
    this.offMsg = this.offClosed = null;
  }

  async close() {
    this.open = false;
    this.detach();
    await invoke("jupyter_ws_close", { chan: this.chan }).catch(() => {});
  }
}

/** nbformat 4 (as stored on disk); unknown fields are kept untouched. */
export interface NbOutput {
  output_type: "stream" | "display_data" | "execute_result" | "error" | "update_display_data";
  name?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  transient?: { display_id?: string };
  [k: string]: unknown;
}

export interface NbCell {
  cell_type: "code" | "markdown" | "raw";
  id?: string;
  source: string | string[];
  metadata: Record<string, unknown>;
  outputs?: NbOutput[];
  execution_count?: number | null;
  attachments?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Notebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, any>;
  cells: NbCell[];
  [k: string]: unknown;
}

export const joinSource = (s: string | string[] | undefined) => (Array.isArray(s) ? s.join("") : (s ?? ""));

/** Jupyter stores multi-line strings as lists of lines (each keeps its "\n"). */
export function toLines(s: string): string[] {
  if (!s) return [];
  const out = s.split(/(?<=\n)/);
  return out;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

/** Same layout nbformat writes (indent 1, sorted keys, trailing newline), for small diffs. */
export function serializeNotebook(nb: Notebook): string {
  return JSON.stringify(sortKeys(nb), null, 1) + "\n";
}

export function newNotebook(kernel = "python3", display = "Python 3"): Notebook {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: kernel, display_name: display, language: "python" }, language_info: { name: "python" } },
    cells: [{ cell_type: "code", id: cellId(), metadata: {}, source: [], outputs: [], execution_count: null }],
  };
}

export function cellId() {
  return uid().slice(-8);
}

/** Parses and validates the basic nbformat 4 structure. */
export function parseNotebook(text: string): Notebook {
  const nb = JSON.parse(text) as Notebook;
  if (!nb || typeof nb !== "object" || !Array.isArray(nb.cells)) throw new Error("Arquivo .ipynb inválido: falta a lista de células.");
  if (nb.nbformat !== 4) throw new Error(`nbformat ${nb.nbformat} não é suportado (somente nbformat 4).`);
  for (const c of nb.cells) {
    if (!["code", "markdown", "raw"].includes(c.cell_type)) throw new Error(`Tipo de célula desconhecido: ${c.cell_type}`);
    c.metadata ??= {};
    if (c.cell_type === "code") {
      c.outputs ??= [];
      if (c.execution_count === undefined) c.execution_count = null;
    }
  }
  nb.metadata ??= {};
  return nb;
}

export async function sha256(text: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
