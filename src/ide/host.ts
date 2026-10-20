// Thin wrappers over the IDE backend commands and events.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  ignored: boolean;
}

export interface FileText {
  text: string;
  binary: boolean;
  tooLarge: boolean;
  crlf: boolean;
  encoding: string;
}

export interface SearchHit {
  path: string;
  line: number;
  col: number;
  len: number;
  text: string;
}

export interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface EnvInfo {
  home: string;
  sep: string;
  os: string;
  defaultShell: string;
  username: string;
}

export interface SpawnSpec {
  id: string;
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  mode?: "plain" | "rpc";
}

export const host = {
  list: (path: string) => invoke<Entry[]>("fs_list", { path }),
  read: (path: string) => invoke<FileText>("fs_read", { path }),
  write: (path: string, text: string, crlf = false) => invoke<void>("fs_write", { path, text, crlf }),
  create: (path: string, dir: boolean) => invoke<void>("fs_create", { path, dir }),
  rename: (from: string, to: string) => invoke<void>("fs_rename", { from, to }),
  remove: (paths: string[]) => invoke<void>("fs_delete", { paths }),
  removePermanently: (paths: string[]) => invoke<void>("fs_delete_permanently", { paths }),
  copy: (src: string, destDir: string) => invoke<string>("fs_copy", { src, destDir }),
  exists: (path: string) => invoke<boolean>("fs_exists", { path }),
  files: (root: string) => invoke<string[]>("fs_files", { root }),
  search: (root: string, query: string, o: { regex: boolean; case: boolean; word: boolean; mask: string }) =>
    invoke<SearchHit[]>("fs_search", { root, query, ...o }),
  watch: (root: string) => invoke<void>("fs_watch", { root }),
  unwatch: (root: string) => invoke<void>("fs_unwatch", { root }),
  reveal: (path: string) => invoke<void>("reveal_in_explorer", { path: P.win(path) }),
  spawn: (spec: SpawnSpec) => invoke<number>("proc_spawn", { spec: { args: [], cwd: "", env: {}, mode: "plain", ...spec } }),
  connect: (id: string, addr: string) => invoke<void>("proc_connect", { id, addr }),
  write_: (id: string, data: string) => invoke<void>("proc_write", { id, data }),
  closeStdin: (id: string) => invoke<void>("proc_close_stdin", { id }),
  kill: (id: string) => invoke<void>("proc_kill", { id }),
  capture: (program: string, args: string[], cwd = "", input?: string, timeout?: number) =>
    invoke<Captured>("run_capture", { program, args, cwd, input: input ?? null, timeout: timeout ?? null }),
  which: (name: string, extra: string[] = []) => invoke<string | null>("which", { name, extra }),
  freePort: () => invoke<number>("free_port"),
  env: () => invoke<EnvInfo>("env_info"),
  ptyOpen: (id: string, shell: string, cwd: string, cols: number, rows: number, env: Record<string, string> = {}) =>
    invoke<void>("pty_open", { id, shell, cwd, cols, rows, env }),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyClose: (id: string) => invoke<void>("pty_close", { id }),
  windowReset: () => invoke<void>("window_reset"),
  loadDoc: <T>(key: string) => invoke<T | null>("load_doc", { key }),
  saveDoc: (key: string, value: unknown) => invoke<void>("save_doc", { key, value }),
};

// ---- event fan-out (one Tauri listener per event, many local subscribers keyed by id) ----
type Handler<T> = (payload: T) => void;
const routes = new Map<string, Map<string, Set<Handler<any>>>>();
const started = new Set<string>();

function route<T extends { id: string }>(event: string) {
  if (!started.has(event)) {
    started.add(event);
    listen<T>(event, (e) => {
      const subs = routes.get(event)?.get(e.payload.id);
      subs?.forEach((h) => h(e.payload));
    }).catch(() => {});
  }
}

export function on<T extends { id: string }>(event: string, id: string, h: Handler<T>): () => void {
  route<T>(event);
  if (!routes.has(event)) routes.set(event, new Map());
  const m = routes.get(event)!;
  if (!m.has(id)) m.set(id, new Set());
  m.get(id)!.add(h);
  return () => m.get(id)?.delete(h);
}

export interface ProcOut {
  id: string;
  stream: "stdout" | "stderr";
  data: string;
}
export interface ProcExit {
  id: string;
  code: number | null;
}
export interface RpcIn {
  id: string;
  msg: string;
}

export function onFsChange(cb: (root: string, paths: string[]) => void): Promise<UnlistenFn> {
  return listen<{ root: string; paths: string[] }>("fs-change", (e) => cb(e.payload.root, e.payload.paths));
}

// ---- platform ----
export const IS_WIN = /Windows/i.test(navigator.userAgent);
export const IS_MAC = /Macintosh|Mac OS X/i.test(navigator.userAgent);
export const IS_LINUX = !IS_WIN && !IS_MAC;
/** Suffix of native executables ("python.exe" on Windows, "python" elsewhere). */
export const EXE = IS_WIN ? ".exe" : "";
/** Install commands suggested to the user (winget on Windows, Homebrew on macOS, apt on Linux). */
export const INSTALL = IS_WIN
  ? { go: "winget install GoLang.Go", python: "winget install Python.Python.3.13", git: "winget install Git.Git", pg: "winget install PostgreSQL.PostgreSQL", mysql: "winget install Oracle.MySQL" }
  : IS_LINUX
    ? { go: "sudo apt install golang-go", python: "sudo apt install python3 python3-venv", git: "sudo apt install git", pg: "sudo apt install postgresql-client", mysql: "sudo apt install mysql-client" }
    : { go: "brew install go", python: "brew install python", git: "xcode-select --install", pg: "brew install libpq", mysql: "brew install mysql-client" };
/** Label of the "reveal in file manager" action. */
export const REVEAL_LABEL = IS_MAC ? "Mostrar no Finder" : IS_WIN ? "Abrir no Explorer" : "Abrir no gerenciador de arquivos";

// ---- path helpers (paths are kept with forward slashes) ----
export const P = {
  norm: (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, ""),
  join: (...parts: string[]) => parts.filter(Boolean).join("/").replace(/\/+/g, "/").replace(/^([A-Za-z]):\/?/, "$1:/"),
  base: (p: string) => P.norm(p).split("/").pop() ?? p,
  dir: (p: string) => {
    const n = P.norm(p);
    const i = n.lastIndexOf("/");
    return i <= 0 ? n : n.slice(0, i);
  },
  ext: (p: string) => {
    const b = P.base(p);
    const i = b.lastIndexOf(".");
    return i > 0 ? b.slice(i + 1).toLowerCase() : "";
  },
  rel: (root: string, p: string) => {
    const r = P.norm(root);
    const n = P.norm(p);
    return n.toLowerCase().startsWith(r.toLowerCase() + "/") ? n.slice(r.length + 1) : n;
  },
  same: (a: string, b: string) => P.norm(a).toLowerCase() === P.norm(b).toLowerCase(),
  inside: (root: string, p: string) => P.norm(p).toLowerCase().startsWith(P.norm(root).toLowerCase() + "/") || P.same(root, p),
  /** Native form for processes and the user (backslashes on Windows, unchanged elsewhere). */
  win: (p: string) => (IS_WIN ? p.replace(/\//g, "\\") : p),
  isAbs: (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\"),
  uri: (p: string) => "file:///" + P.norm(p).replace(/^\//, "").split("/").map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s.toUpperCase() : encodeURIComponent(s))).join("/"),
  fromUri: (u: string) => {
    let p = decodeURIComponent(u.replace(/^file:\/\//, ""));
    if (/^\/[a-zA-Z]:/.test(p)) p = p[1].toUpperCase() + p.slice(2);
    return P.norm(p);
  },
};
