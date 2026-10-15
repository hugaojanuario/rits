// Project model: the open folder, recent projects and per-project settings.
import { host, P } from "./host";

export interface RecentProject {
  path: string;
  name: string;
  opened: number;
  branch?: string;
}

export interface ProjectSettings {
  pythonInterpreter?: string;
  goRoot?: string;
  runConfigs?: RunConfig[];
  selectedRunConfig?: string;
  breakpoints?: Record<string, number[]>;
  openFiles?: string[];
  activeFile?: string | null;
  expanded?: string[];
  layout?: Record<string, unknown>;
  goFmtOnSave?: boolean;
  dbConsoles?: import("../console").ConsoleState[];
  /** Airflow plugin: instance the project deploys to and how DAG files reach it. */
  airflow?: AirflowProjectLink;
}

export interface AirflowProjectLink {
  instanceId: string;
  /** DAG folder inside the project (relative), e.g. "dags". */
  dagsDir: string;
  /** volume: mounted in the local Docker environment; git: published by commit + push (CI/git-sync); manual: the user copies them. */
  delivery: "volume" | "git" | "manual";
}

export interface RunConfig {
  id: string;
  name: string;
  kind: "python" | "go" | "pytest" | "gotest" | "shell";
  /** File or package directory */
  target: string;
  args: string;
  cwd: string;
  env: string;
  /** For tests: test name filter */
  filter?: string;
  temporary?: boolean;
}

const PALETTE = [
  ["#E36A5D", "#C24E7A"],
  ["#5F87F5", "#7C5CE6"],
  ["#34B27D", "#2E8FB7"],
  ["#E89E3B", "#D9622B"],
  ["#A35BE8", "#5D5FEF"],
  ["#2DB3B7", "#3B82F6"],
  ["#D6524B", "#E89E3B"],
  ["#6A9F3C", "#2FA371"],
];

export function projectColors(name: string): [string, string] {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length] as [string, string];
}

export function projectInitials(name: string): string {
  const parts = name.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+|(?=[A-Z][a-z])/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "P").toUpperCase();
}

export function projectBadge(name: string, big = false): HTMLSpanElement {
  const [a, b] = projectColors(name);
  const s = document.createElement("span");
  s.className = "project-badge" + (big ? " big" : "");
  s.style.background = `linear-gradient(135deg, ${a}, ${b})`;
  s.textContent = projectInitials(name);
  return s;
}

export async function recentProjects(): Promise<RecentProject[]> {
  return ((await host.loadDoc<RecentProject[]>("recentProjects")) ?? []).filter((p) => p && p.path);
}

export async function touchRecent(path: string, branch?: string) {
  const list = await recentProjects();
  const norm = P.norm(path);
  const rest = list.filter((p) => !P.same(p.path, norm));
  const prev = list.find((p) => P.same(p.path, norm));
  rest.unshift({ path: norm, name: P.base(norm), opened: Date.now(), branch: branch ?? prev?.branch });
  await host.saveDoc("recentProjects", rest.slice(0, 40));
}

export async function removeRecent(path: string) {
  const list = await recentProjects();
  await host.saveDoc("recentProjects", list.filter((p) => !P.same(p.path, path)));
}

const settingsKey = (path: string) => "project-" + P.norm(path).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(-120);

export async function loadProjectSettings(path: string): Promise<ProjectSettings> {
  return (await host.loadDoc<ProjectSettings>(settingsKey(path))) ?? {};
}

let saveTimer: number | undefined;
export function saveProjectSettings(path: string, s: ProjectSettings) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => host.saveDoc(settingsKey(path), s).catch(() => {}), 400);
}
