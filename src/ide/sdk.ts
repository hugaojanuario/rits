// SDK detection (Python interpreters, Go) and language "plugins" (language servers, debuggers, tools).
import { EXE, host, IS_WIN, on, P, type ProcExit, type ProcOut } from "./host";
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
  return [".venv", "venv", "env", ".env"].map((d) => P.join(root, d, IS_WIN ? "Scripts/python.exe" : "bin/python"));
}

/** Interpreters outside PATH on macOS/Linux: Homebrew, python.org framework builds and pyenv. */
async function unixInterpreters(): Promise<string[]> {
  const out: string[] = [];
  const home = (await host.env()).home;
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/Library/Frameworks/Python.framework/Versions/Current/bin"];
  for (const d of dirs) {
    const entries = await host.list(d).catch(() => []);
    for (const e of entries) if (/^python3\.\d+$/.test(e.name)) out.push(P.join(d, e.name));
  }
  for (const v of await host.list(P.join(home, ".pyenv/versions")).catch(() => [])) out.push(P.join(v.path, "bin/python"));
  return out;
}

export async function findInterpreters(root?: string): Promise<PyInterp[]> {
  const paths = new Set<string>();
  if (root) for (const c of projectVenvCandidates(root)) if (await host.exists(c)) paths.add(P.norm(c));
  if (IS_WIN) {
    try {
      const r = await host.capture("py", ["-0p"], "", undefined, 10);
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = /([A-Za-z]:\\.+python(w)?\.exe)\s*$/i.exec(line.trim());
        if (m) paths.add(P.norm(m[1]));
      }
    } catch {
      /* py launcher missing */
    }
  } else {
    for (const p of await unixInterpreters().catch(() => [])) if (await host.exists(p)) paths.add(P.norm(p));
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

/** Folder with the interpreter's console scripts (venv "Scripts" on Windows, "bin" elsewhere). */
export function scriptsDir(python: string) {
  const d = P.dir(python);
  if (!IS_WIN) return d;
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
  id: "python" | "go" | "infra";
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
    const p = P.join(scriptsDir(currentPython.path), name + EXE);
    if (await host.exists(p)) return p;
  }
  return host.which(name);
}

export async function goTool(name: string): Promise<string | null> {
  const g = await findGo();
  if (g) {
    const p = P.join(g.gopath, "bin", name + EXE);
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

/** First line of `<bin> <args>` when the binary exists (null otherwise). */
async function binVersion(name: string, args: string[]): Promise<string | null> {
  const p = await host.which(name);
  if (!p) return null;
  const r = await host.capture(p, args, "", undefined, 20).catch(() => null);
  return r ? (r.stdout + r.stderr).trim().split(/\r?\n/)[0].slice(0, 80) || "instalado" : "instalado";
}

const npmInstall = (pkg: string) => ({ program: IS_WIN ? "npm.cmd" : "npm", args: ["install", "-g", pkg] });
const brewOrWinget = (brew: string[], winget: string) => (IS_WIN ? { program: "winget", args: ["install", "--id", winget, "-e", "--accept-source-agreements", "--accept-package-agreements"] } : { program: "brew", args: ["install", ...brew] });

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
  {
    id: "infra",
    name: "Infraestrutura (IaC)",
    icon: "terraform",
    description: "Terraform, Dockerfile, Docker Compose e Kubernetes: autocomplete, validação por schema, documentação ao passar o mouse, formatação e ações (plan/apply, compose up/down, kubectl apply/diff).",
    components: [
      { id: "terraform", name: "Terraform CLI", purpose: "init, plan, apply, fmt e validate", check: () => binVersion("terraform", ["version"]), install: () => brewOrWinget(["hashicorp/tap/terraform"], "Hashicorp.Terraform") },
      { id: "terraform-ls", name: "terraform-ls", purpose: "Servidor de linguagem oficial da HashiCorp para .tf", check: () => binVersion("terraform-ls", ["version"]), install: () => (IS_WIN ? goInstall("github.com/hashicorp/terraform-ls@latest") : { program: "brew", args: ["install", "hashicorp/tap/terraform-ls"] }) },
      { id: "docker-langserver", name: "Dockerfile LS", purpose: "Autocomplete e validação de Dockerfile (precisa do Node.js)", check: () => host.which("docker-langserver").then((p) => (p ? "instalado" : null)), install: () => npmInstall("dockerfile-language-server-nodejs") },
      { id: "yaml-language-server", name: "YAML LS", purpose: "Schemas do Docker Compose e do Kubernetes (precisa do Node.js)", check: () => host.which("yaml-language-server").then((p) => (p ? "instalado" : null)), install: () => npmInstall("yaml-language-server") },
      { id: "kubectl", name: "kubectl", purpose: "apply, diff e get dos manifestos", check: () => binVersion("kubectl", ["version", "--client"]), install: () => brewOrWinget(["kubectl"], "Kubernetes.kubectl") },
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
