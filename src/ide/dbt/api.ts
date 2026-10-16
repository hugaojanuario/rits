// Typed wrappers of the dbt plugin commands (src-tauri/src/dbt). Commands run with structured
// arguments in the backend; passwords come from the OS store or the linked IDE connection.
import { invoke } from "@tauri-apps/api/core";

export interface Runtime {
  kind: "local" | "docker";
  dbt: string;
  image: string;
}

export interface RunSpec {
  projectDir: string;
  runtime: Runtime;
  command: string;
  select?: string[];
  exclude?: string[];
  target?: string;
  fullRefresh?: boolean;
  vars?: Record<string, unknown> | null;
  threads?: number | null;
  failFast?: boolean;
  profileId?: string;
  profilesDir?: string;
  initName?: string;
  port?: number;
}

export interface Target {
  name: string;
  connId: string;
  host: string;
  port: number;
  user: string;
  dbname: string;
  schema: string;
  threads: number;
  sslmode: string;
}

export interface EnvVar {
  name: string;
  value: string;
  secret: boolean;
}

export interface Profile {
  id: string;
  projectDir: string;
  profileName: string;
  defaultTarget: string;
  targets: Target[];
  env: EnvVar[];
  targetsWithPassword?: string[];
}

export interface VersionInfo {
  core: string;
  major: number;
  adapters: [string, string][];
  v2: boolean;
}

export interface DbtNode {
  uniqueId: string;
  resourceType: string;
  name: string;
  package: string;
  path: string;
  dependsOn: string[];
  tags: string[];
  materialized: string;
  schema: string;
  compiledPath: string;
  attached: string;
  sourceName: string;
}

export interface NodeResult {
  uniqueId: string;
  status: string;
  executionTime: number;
  message: string;
  failures: number | null;
  relation: string;
}

export interface ArtifactInfo {
  present: boolean;
  schemaVersion: number | null;
  dbtVersion: string;
  generatedAt: string;
  invocationId: string;
  compat: "ok" | "old" | "newer" | "unknown" | "invalid" | "";
  error: string;
}

export interface Summary {
  manifest: ArtifactInfo;
  runResults: ArtifactInfo;
  projectName: string;
  nodes: DbtNode[];
  results: NodeResult[];
  elapsed: number;
  command: string;
  resultsFromOtherInvocation: boolean;
  changedSinceResults: string[];
}

export const dbt = {
  profiles: () => invoke<Profile[]>("dbt_profiles"),
  saveProfile: (profile: Profile, passwords: Record<string, string>, secretEnv: Record<string, string>) => invoke<Profile>("dbt_save_profile", { profile, passwords, secretEnv }),
  deleteProfile: (id: string) => invoke<void>("dbt_delete_profile", { id }),
  run: (procId: string, spec: RunSpec) => invoke<number>("dbt_run", { procId, spec }),
  cancel: (procId: string) => invoke<void>("dbt_cancel", { procId }),
  release: () => invoke<void>("dbt_release"),
  version: (runtime: Runtime) => invoke<VersionInfo>("dbt_version", { runtime }),
  projectProfile: (projectDir: string) => invoke<string | null>("dbt_project_profile", { projectDir }),
  artifacts: (projectDir: string) => invoke<Summary>("dbt_artifacts", { projectDir }),
  compiled: (projectDir: string, uniqueId: string) => invoke<string | null>("dbt_compiled", { projectDir, uniqueId }),
};

export const DBT_IMAGE = "ghcr.io/dbt-labs/dbt-postgres:1.9.0";
export const WRITES_DB = ["run", "build", "seed", "snapshot"];

/** Settings of the dbt plugin in the IDE project (ProjectSettings.dbt). */
export interface DbtProjectSettings {
  /** Folder of dbt_project.yml (absolute). */
  projectDir: string;
  runtime: Runtime;
  /** Managed profile id; "" = the user's own profiles.yml. */
  profileId: string;
  profilesDir: string;
  target: string;
  threads: number | null;
  vars: string;
  history: string[];
}

export function errText(e: unknown) {
  return typeof e === "string" ? e : e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : String(e);
}
