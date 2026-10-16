// Types and command wrappers of the Migration Audit plugin (src-tauri/src/audit). Everything is
// deterministic: SQL, metadata, explicit rules and evidence comparison (no AI or inference).
import { invoke } from "@tauri-apps/api/core";

export type Side = "both" | "source" | "target";

export interface Rules {
  trim: boolean;
  caseInsensitive: boolean;
  unicodeNfc: boolean;
  removeAccents: boolean;
  stripPunct: boolean;
  emptyIsNull: boolean;
  nullSentinels: string[];
  sentinelSide: Side;
  enumMap: [string, string][];
  trueValues: string[];
  falseValues: string[];
  dateFormat: string;
  dateFormatSide: Side;
  dateOnly: boolean;
  tsPrecision: number | null;
  naiveOffsetSource: string;
  naiveOffsetTarget: string;
  decimalScale: number | null;
  tolAbs: string;
  tolRel: string;
  jsonCanonical: boolean;
  compareAs: string;
}

export const emptyRules = (): Rules => ({
  trim: false, caseInsensitive: false, unicodeNfc: false, removeAccents: false, stripPunct: false, emptyIsNull: false, nullSentinels: [], sentinelSide: "both",
  enumMap: [], trueValues: [], falseValues: [], dateFormat: "", dateFormatSide: "source", dateOnly: false, tsPrecision: null, naiveOffsetSource: "", naiveOffsetTarget: "",
  decimalScale: null, tolAbs: "", tolRel: "", jsonCanonical: false, compareAs: "",
});

export interface ConnRef {
  connId: string;
  name: string;
  kind: string;
  host: string;
  database: string;
  version: string;
}

export interface Excluded {
  schema: string;
  table: string;
  reason: string;
}

export interface ScopeSide {
  schemas: string[];
  includeViews: boolean;
  excluded: Excluded[];
  technical: string[];
}

export interface Perf {
  mode: "quick" | "volume" | "identity" | "fields" | "deep";
  concurrency: number;
  perConnection: number;
  timeoutSecs: number;
  batchRows: number;
  memoryMb: number;
  diskMb: number;
  maxExamples: number;
  queryBudget: number;
  excludeLobs: boolean;
  retention: number;
}

export interface Project {
  format: number;
  id: string;
  name: string;
  description: string;
  created: number;
  updated: number;
  source: ConnRef;
  target: ConnRef;
  sourceScope: ScopeSide;
  targetScope: ScopeSide;
  consistency: "frozen" | "snapshot" | "watermark" | "none";
  watermarkNote: string;
  perf: Perf;
  evidenceLevel: "basic" | "identity" | "fields";
  storeValues: boolean;
  aliases: [string, string][];
  stripPrefixes: string[];
}

export interface Pred {
  column: string;
  op: string;
  values: string[];
}

export interface Dataset {
  kind: "table" | "query";
  schema: string;
  table: string;
  sql: string;
  filters: Pred[];
}

export interface KeyCol {
  column: string;
  rules: Rules;
}

export interface IdMap {
  side: "source" | "target";
  dataset: Dataset;
  sourceCols: string[];
  targetCols: string[];
  allowDupTarget: boolean;
}

export interface Identity {
  kind: "none" | "key" | "map" | "content";
  source: KeyCol[];
  target: KeyCol[];
  map: IdMap | null;
}

export type FieldKind = "map" | "concat" | "split" | "constant" | "derived" | "ignored" | "target_only" | "unmapped";

export interface FieldMap {
  id: string;
  kind: FieldKind;
  sourceCols: string[];
  targetCol: string;
  sep: string;
  index: number;
  constant: string;
  rules: Rules;
  justification: string;
  confirmed: boolean;
  sensitive: boolean;
  suggestedBy: string[];
}

export interface Relationship {
  id: string;
  name: string;
  parentUnit: string;
  sourceCols: string[];
  targetCols: string[];
}

export interface Exclusion {
  predicate: Pred[];
  reason: string;
}

export interface Unit {
  id: string;
  name: string;
  description: string;
  criticality: "alta" | "media" | "baixa" | "";
  source: Dataset;
  target: Dataset;
  cardinality: "1:1" | "1:N" | "N:1";
  normalized: boolean;
  identity: Identity;
  fields: FieldMap[];
  exclusions: Exclusion[];
  targetScope: Pred[];
  excludePreexisting: boolean;
  relationships: Relationship[];
  confirmed: boolean;
}

export interface Mappings {
  format: number;
  version: number;
  units: Unit[];
  ignored: [string, string, string, string][];
}

export interface Column {
  name: string;
  position: number;
  native: string;
  ltype: string | null;
  length: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  default: string | null;
  generated: boolean;
}

export interface Constraint {
  name: string;
  kind: "primary" | "unique" | "foreign";
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

export interface Table {
  schema: string;
  name: string;
  kind: string;
  columns: Column[];
  constraints: Constraint[];
  indexes: [string, boolean, string[]][];
  estimatedRows: number | null;
  technical: boolean;
  excluded: string | null;
  error: string;
}

export interface Structure {
  dialect: string;
  version: string;
  capturedAt: number;
  tables: Table[];
  errors: string[];
}

export interface Dim {
  result: "compatible" | "divergent" | "inconclusive" | "not_verified" | "";
  note: string;
}

export interface FieldResult {
  fieldId: string;
  label: string;
  compared: number;
  equal: number;
  bothEmpty: number;
  lost: number;
  created: number;
  divergent: number;
  notCompared: number;
  invalid: number;
  derived: boolean;
  result: Dim["result"];
  note: string;
  aggregate: [number, number] | null;
}

export interface EvidenceFile {
  path: string;
  bytes: number;
  sha256: string;
  records: number;
}

export interface UnitCapture {
  unitId: string;
  status: string;
  error: string;
  countKind: string;
  rows: number | null;
  excluded: number;
  nullKeys: number;
  distinctKeys: number;
  duplicateKeys: number;
  collisions: number;
  evidence: EvidenceFile | null;
  sortedRuns: number;
  queries: number;
  elapsedMs: number;
  warnings: string[];
  fieldsSkipped: Record<string, string>;
}

export interface UnitResult {
  unitId: string;
  name: string;
  criticality: string;
  status: string;
  error: string;
  counts: { source: number | null; excluded: number; expected: number | null; target: number | null; preexisting: number; diff: number | null; kind: string; rule: string };
  volume: Dim;
  identity: Dim;
  fieldsDim: Dim;
  relations: Dim;
  missing: number;
  extra: number;
  multiplicity: number;
  nullKeysSource: number;
  nullKeysTarget: number;
  collisions: number;
  ambiguous: number;
  mapIssues: Record<string, number>;
  fields: FieldResult[];
  unmappedSource: string[];
  unsourcedRequiredTarget: string[];
  relationIssues: Record<string, number>;
  findings: Record<string, EvidenceFile>;
  warnings: string[];
}

export interface Consistency {
  requested: string;
  obtained: string;
  notes: string[];
}

export interface BaselineManifest {
  id: string;
  side: string;
  startedAt: number;
  finishedAt: number;
  status: string;
  level: string;
  storeValues: boolean;
  mappingsVersion: number;
  consistency: Consistency;
  units: UnitCapture[];
  errors: string[];
  note: string;
  digest: string;
}

export interface RunManifest {
  id: string;
  baselineId: string;
  targetPreBaselineId: string;
  startedAt: number;
  finishedAt: number;
  status: string;
  mappingsVersion: number;
  consistency: Consistency;
  units: UnitResult[];
  uncoveredTables: string[];
  structureAlerts: { kind: string; message: string; unit?: string; field?: string }[];
  sourceChanged: string[];
  coverage: Record<string, [number, number]>;
  errors: string[];
  digest: string;
}

export interface Integrity {
  ok: boolean;
  problems: string[];
}

export interface HistoryItem {
  id: string;
  side?: string;
  status: string;
  startedAt?: number;
  finishedAt?: number;
  level?: string;
  units?: number;
  note?: string;
  baselineId?: string;
  summary?: string;
  consistency?: string;
  mappingsVersion?: number;
  integrity: Integrity;
}

export interface UnitCheck {
  unitId: string;
  errors: string[];
  warnings: string[];
  alerts: { kind: string; field: string; message: string; nature: string }[];
  unmappedSource: string[];
  unsourcedRequired: string[];
}

export interface Capability {
  kind: string;
  label: string;
  support: "full" | "partial" | "none";
  items: [string, string, string][];
  validated: string;
}

export interface Progress {
  phase: string;
  unit: string;
  processed: number;
  total: number | null;
  elapsedMs: number;
  message: string;
  queries: number;
  diskBytes: number;
}

export const audit = {
  capabilities: () => invoke<Capability[]>("audit_capabilities"),
  projects: () => invoke<{ project: Project; baselines: number; runs: number }[]>("audit_projects"),
  load: (id: string) => invoke<{ project: Project; mappings: Mappings; sourceStructure: Structure | null; targetStructure: Structure | null }>("audit_load", { id }),
  saveProject: (project: Project) => invoke<Project>("audit_save_project", { project }),
  saveMappings: (id: string, mappings: Mappings) => invoke<Mappings>("audit_save_mappings", { id, mappings }),
  deleteProject: (id: string) => invoke<void>("audit_delete_project", { id }),
  deleteArtifact: (projectId: string, kind: "baseline" | "run", id: string) => invoke<void>("audit_delete_artifact", { projectId, kind, id }),
  schemas: (connId: string, db: string) => invoke<string[]>("audit_schemas", { connId, db }),
  discover: (job: string, id: string) => invoke<{ sourceStructure: Structure; targetStructure: Structure }>("audit_discover", { job, id }),
  suggest: (id: string) => invoke<Unit[]>("audit_suggest", { id }),
  validate: (id: string, checkQueries: boolean) => invoke<{ units: UnitCheck[]; uncovered: string[]; views: string[] }>("audit_validate", { id, checkQueries }),
  estimate: (id: string) => invoke<{ rows: number; bytes: number }>("audit_estimate", { id }),
  capture: (job: string, id: string, side: "source" | "target", unitIds: string[] | null, note: string) => invoke<BaselineManifest>("audit_capture", { job, id, side, unitIds, note }),
  reconcile: (job: string, id: string, baselineId: string, preBaselineId: string | null, unitIds: string[] | null, checkSource: boolean) => invoke<RunManifest>("audit_reconcile", { job, id, baselineId, preBaselineId, unitIds, checkSource }),
  cancel: (job: string) => invoke<void>("audit_cancel", { job }),
  release: () => invoke<void>("audit_release"),
  history: (id: string) => invoke<{ baselines: HistoryItem[]; runs: HistoryItem[] }>("audit_history", { id }),
  get: <T>(id: string, kind: "baseline" | "run", artifact: string) => invoke<{ manifest: T | null; integrity: Integrity }>("audit_get", { id, kind, artifact }),
  findings: (id: string, runId: string, unitId: string, kind: string, offset: number, limit: number, reveal: boolean) => invoke<{ headers: string[]; rows: string[][]; total: number; masked: boolean }>("audit_findings", { id, runId, unitId, kind, offset, limit, reveal }),
  export: (id: string, runId: string, format: string, unitId: string | null, kind: string | null, detailed: boolean, path: string) => invoke<number>("audit_export", { id, runId, format, unitId, kind, detailed, path }),
};

export const RESULT_LABEL: Record<string, string> = { compatible: "Compatível no escopo verificado", divergent: "Divergente", inconclusive: "Inconclusivo", not_verified: "Não verificado", "": "—" };
export const STATUS_LABEL: Record<string, string> = { pending: "Pendente", running: "Em execução", complete: "Concluída", partial: "Parcial", cancelled: "Cancelada", error: "Erro", invalid: "Ilegível" };
export const FINDING_LABEL: Record<string, string> = {
  missing: "Identidades ausentes no destino",
  extra: "Identidades extras no destino",
  multiplicity: "Multiplicidade diferente (duplicações)",
  fields: "Campos: perdas, criações e divergências",
  relations: "Relacionamentos alterados",
  relations_map: "Relacionamentos (via mapa de IDs)",
  orphans: "Órfãos no destino",
  ambiguous: "Identidades não comparadas (ambíguas)",
  map_unmapped: "Origem sem correspondência no mapa",
  map_ambiguous_source: "Correspondências ambíguas no mapa",
  map_without_source: "Mapa aponta para registro inexistente na origem",
  map_dup_source: "IDs de origem repetidos no mapa",
  map_dup_target: "IDs de destino repetidos no mapa",
};

export function errText(e: unknown) {
  return typeof e === "string" ? e : e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : String(e);
}

export function fmtTime(ms: number | undefined) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("pt-BR");
}
