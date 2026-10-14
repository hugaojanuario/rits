// SDK detection (Python interpreters, Go) and language "plugins" (language servers, debuggers, tools).
import { host, on, P, type ProcExit, type ProcOut } from "./host";
import { uid } from "../util";

export interface PyInterp {
  path: string;
  version: string;
  venv: boolean;
  label: string;
}

const cache = new Map<string, unknown>();

async function pyInfo(path: string): Promise<PyInterp | null> {
  const key = "py:" + path;
  if (cache.has(key)) return cache.get(key) as PyInterp | null;
  try {
    const r = await host.capture(path, ["-c", "import sys,json;print(json.dumps([sys.version.split()[0], sys.prefix != sys.base_prefix]))"], "", undefined, 15);
    if (r.code !== 0) throw new Error(r.stderr);
    const [version, venv] = JSON.parse(r.stdout.trim().split("\n").pop()!);
    const info: PyInterp = { path: P.norm(path), version, venv, label: "" };
    info.label = venv ? `Python ${version} (${P.base(P.dir(P.dir(path)))})` : `Python ${version}`;
    cache.set(key, info);
    return info;
  } catch {
    cache.set(key, null);
    return null;
  }
}

export function projectVenvCandidates(root: string): string[] {
  return [".venv", "venv", "env", ".env"].map((d) => P.join(root, d, "Scripts", "python.exe"));
}

export async function findInterpreters(root?: string): Promise<PyInterp[]> {
  const paths = new Set<string>();
  if (root) for (const c of projectVenvCandidates(root)) if (await host.exists(c)) paths.add(P.norm(c));
  try {
    const r = await host.capture("py", ["-0p"], "", undefined, 10);
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /([A-Za-z]:\\.+python(w)?\.exe)\s*$/i.exec(line.trim());
      if (m) paths.add(P.norm(m[1]));
    }
  } catch {
    /* py launcher missing */
  }
  for (const n of ["python", "python3"]) {
    const w = await host.which(n);
    if (w && !/WindowsApps/i.test(w)) paths.add(P.norm(w));
  }
  const infos = await Promise.all([...paths].map(pyInfo));
  const seen = new Set<string>();
  return infos.filter((i): i is PyInterp => {
    if (!i || seen.has(i.path.toLowerCase())) return false;
    seen.add(i.path.toLowerCase());
    return true;
  });
}

/** Interpreter for a project: configured one, else project venv, else first found. */
export async function resolveInterpreter(root: string, configured?: string): Promise<PyInterp | null> {
  if (configured && (await host.exists(configured))) return pyInfo(configured);
  for (const c of projectVenvCandidates(root)) if (await host.exists(c)) return pyInfo(c);
  const all = await findInterpreters();
  return all.sort((a, b) => cmpVer(b.version, a.version))[0] ?? null;
}

function cmpVer(a: string, b: string) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export function scriptsDir(python: string) {
  const d = P.dir(python);
  return P.base(d).toLowerCase() === "scripts" ? d : P.join(d, "Scripts");
}

export interface GoInfo {
  path: string;
  version: string;
  gopath: string;
  goroot: string;
}

export async function findGo(): Promise<GoInfo | null> {
  if (cache.has("go")) return cache.get("go") as GoInfo | null;
  const path = await host.which("go");
  if (!path) return null;
  try {
    const r = await host.capture(path, ["env", "GOVERSION", "GOPATH", "GOROOT"], "", undefined, 15);
    const [version, gopath, goroot] = r.stdout.trim().split(/\r?\n/);
    const info = { path: P.norm(path), version: version.replace(/^go/, ""), gopath: P.norm(gopath), goroot: P.norm(goroot) };
    cache.set("go", info);
    return info;
  } catch {
    return null;
  }
}

export function clearSdkCache() {
  cache.clear();
}

// ---------------- plugin components ----------------

export interface Component {
  id: string;
  name: string;
  purpose: string;
  /** Returns version text when installed, null otherwise. */
  check: () => Promise<string | null>;
  install: () => { program: string; args: string[] } | null;
}

export interface LangPlugin {
  id: "python" | "go";
  name: string;
  icon: string;
  description: string;
  components: Component[];
}

let currentPython: PyInterp | null = null;
export function setCurrentPython(p: PyInterp | null) {
  currentPython = p;
}
export function getCurrentPython() {
  return currentPython;
}

async function pyModuleVersion(mod: string): Promise<string | null> {
  if (!currentPython) return null;
  const r = await host
    .capture(currentPython.path, ["-c", `import importlib.metadata as m;print(m.version("${mod}"))`], "", undefined, 20)
    .catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() : null;
}

const pip = (pkg: string) => (currentPython ? { program: currentPython.path, args: ["-m", "pip", "install", "-U", pkg] } : null);

export async function pyTool(name: string): Promise<string | null> {
  if (currentPython) {
    const p = P.join(scriptsDir(currentPython.path), name + ".exe");
    if (await host.exists(p)) return p;
  }
  return host.which(name);
}

export async function goTool(name: string): Promise<string | null> {
  const g = await findGo();
  if (g) {
    const p = P.join(g.gopath, "bin", name + ".exe");
    if (await host.exists(p)) return p;
  }
  return host.which(name);
}

async function goToolVersion(name: string, args: string[]): Promise<string | null> {
  const p = await goTool(name);
  if (!p) return null;
  const r = await host.capture(p, args, "", undefined, 20).catch(() => null);
  return r ? (r.stdout + r.stderr).trim().split(/\r?\n/)[0].slice(0, 80) || "instalado" : "instalado";
}

const goInstall = (pkg: string) => ({ program: "go", args: ["install", pkg] });

export const PLUGINS: LangPlugin[] = [
  {
    id: "python",
    name: "Python",
    icon: "python/python",
    description: "Análise de código, autocomplete, navegação, refatoração, formatação, testes e depuração para Python.",
    components: [
      { id: "basedpyright", name: "basedpyright", purpose: "Servidor de linguagem: autocomplete, tipos, erros, rename, ir para definição", check: () => pyModuleVersion("basedpyright"), install: () => pip("basedpyright") },
      { id: "ruff", name: "Ruff", purpose: "Linter e formatador (Reformat Code / Ctrl+Alt+L)", check: () => pyModuleVersion("ruff"), install: () => pip("ruff") },
      { id: "debugpy", name: "debugpy", purpose: "Depurador (breakpoints, step, variáveis)", check: () => pyModuleVersion("debugpy"), install: () => pip("debugpy") },
      { id: "pytest", name: "pytest", purpose: "Execução de testes pelo gutter e configurações de teste", check: () => pyModuleVersion("pytest"), install: () => pip("pytest") },
    ],
  },
  {
    id: "go",
    name: "Go",
    icon: "goSdk",
    description: "Suporte completo a Go via gopls: autocomplete, navegação, refatoração, gofmt/goimports, testes e depuração com Delve.",
    components: [
      { id: "gopls", name: "gopls", purpose: "Servidor de linguagem oficial do Go (inclui gofmt, goimports e análises)", check: () => goToolVersion("gopls", ["version"]), install: () => goInstall("golang.org/x/tools/gopls@latest") },
      { id: "dlv", name: "Delve", purpose: "Depurador do Go", check: () => goToolVersion("dlv", ["version"]), install: () => goInstall("github.com/go-delve/delve/cmd/dlv@latest") },
      { id: "staticcheck", name: "staticcheck", purpose: "Análise estática avançada (Inspect Code)", check: () => goToolVersion("staticcheck", ["-version"]), install: () => goInstall("honnef.co/go/tools/cmd/staticcheck@latest") },
    ],
  },
];

// ---------------- background tasks with progress ----------------

export interface BgTask {
  id: string;
  title: string;
  output: string;
  running: boolean;
  code: number | null;
}

type TaskListener = (tasks: BgTask[]) => void;
const bgTasks: BgTask[] = [];
const taskListeners = new Set<TaskListener>();
export function onBgTasks(fn: TaskListener) {
  taskListeners.add(fn);
  return () => taskListeners.delete(fn);
}
const emitTasks = () => taskListeners.forEach((f) => f(bgTasks));

/** Runs a command in the background, tracked in the status bar. Resolves with exit code and output. */
export function runBackground(title: string, program: string, args: string[], cwd = "", env: Record<string, string> = {}, onLine?: (s: string) => void): Promise<BgTask> {
  const id = "bg-" + uid();
  const task: BgTask = { id, title, output: "", running: true, code: null };
  bgTasks.push(task);
  emitTasks();
  return new Promise((resolve) => {
    const offOut = on<ProcOut>("proc-out", id, (e) => {
      task.output += e.data;
      onLine?.(e.data);
    });
    const offExit = on<ProcExit>("proc-exit", id, (e) => {
      offOut();
      offExit();
      task.running = false;
      task.code = e.code;
      bgTasks.splice(bgTasks.indexOf(task), 1);
      emitTasks();
      resolve(task);
    });
    host.spawn({ id, program, args, cwd, env }).catch((err) => {
      task.output += String(err);
      task.running = false;
      task.code = -1;
      offOut();
      offExit();
      bgTasks.splice(bgTasks.indexOf(task), 1);
      emitTasks();
      resolve(task);
    });
  });
}
