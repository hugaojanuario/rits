import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type DbKind = "postgres" | "mysql" | "sqlserver" | "oracle" | "firebird" | "sqlite" | "duckdb" | "clickhouse" | "mongodb";

export interface ConnConfig {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  toolsDir: string;
  color: string;
  readOnly: boolean;
  /** Project folder the connection belongs to; "" = shown in every project. */
  project: string;
}

export interface DriverStatus {
  native: boolean;
  installed: boolean;
  packages: string[];
}

export interface ForeignKey {
  name: string;
  table: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

export interface DiagramTable {
  name: string;
  kind: string;
  columns: ColumnInfo[];
}

export interface DiagramInfo {
  tables: DiagramTable[];
  fks: ForeignKey[];
}

export interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
  affected: number | null;
  hasRows: boolean;
  truncated: boolean;
  elapsedMs: number;
}

export interface DbObject {
  name: string;
  kind: string;
  comment: string | null;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  pk: boolean;
  comment: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string;
  unique: boolean;
  primary: boolean;
}

export interface CompletionTable {
  schema: string;
  table: string;
  columns: string[];
}

export interface ServerInfo {
  version: string;
  currentUser: string;
}

export interface ToolStatus {
  name: string;
  path: string | null;
  version: string | null;
}

export interface TaskSpec {
  taskId: string;
  connId: string;
  action: "backup" | "restore";
  database: string;
  path: string;
  format?: string;
  schemas?: string[];
  tables?: string[];
  excludeTables?: string[];
  compression?: number | null;
  dataOnly?: boolean;
  schemaOnly?: boolean;
  noOwner?: boolean;
  noPrivileges?: boolean;
  clean?: boolean;
  ifExists?: boolean;
  create?: boolean;
  inserts?: boolean;
  columnInserts?: boolean;
  encoding?: string;
  jobs?: number | null;
  singleTransaction?: boolean;
  routines?: boolean;
  triggers?: boolean;
  events?: boolean;
  addDropTable?: boolean;
  extendedInsert?: boolean;
  lockTables?: boolean;
  extraArgs?: string;
}

export interface TaskEvent {
  taskId: string;
  kind: "cmd" | "out" | "err" | "done";
  line: string;
}

export const api = {
  listConnections: () => invoke<ConnConfig[]>("list_connections"),
  saveConnection: (cfg: ConnConfig) => invoke<void>("save_connection", { cfg }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  testConnection: (cfg: ConnConfig) => invoke<ServerInfo>("test_connection", { cfg }),
  connect: (connId: string) => invoke<ServerInfo>("connect", { connId }),
  disconnect: (connId: string) => invoke<void>("disconnect", { connId }),
  databases: (connId: string) => invoke<string[]>("list_databases", { connId }),
  schemas: (connId: string, db: string) => invoke<string[]>("list_schemas", { connId, db }),
  objects: (connId: string, db: string, schema: string) =>
    invoke<DbObject[]>("list_objects", { connId, db, schema }),
  columns: (connId: string, db: string, schema: string, table: string) =>
    invoke<ColumnInfo[]>("list_columns", { connId, db, schema, table }),
  indexes: (connId: string, db: string, schema: string, table: string) =>
    invoke<IndexInfo[]>("list_indexes", { connId, db, schema, table }),
  driverStatus: (kind: DbKind) => invoke<DriverStatus>("driver_status", { kind }),
  installDriver: (kind: DbKind) => invoke<void>("install_driver", { kind }),
  removeDriver: (kind: DbKind) => invoke<void>("remove_driver", { kind }),
  diagram: (connId: string, db: string, schema: string) => invoke<DiagramInfo>("diagram_info", { connId, db, schema }),
  onDriverProgress: (cb: (p: { kind: DbKind; line: string; done: boolean }) => void) => listen<{ kind: DbKind; line: string; done: boolean }>("driver-progress", (e) => cb(e.payload)),
  ddl: (connId: string, db: string, schema: string, name: string, kind: string) =>
    invoke<string>("get_ddl", { connId, db, schema, name, kind }),
  completion: (connId: string, db: string) => invoke<CompletionTable[]>("completion_info", { connId, db }),
  /** `maxRows`: row limit of each result (default 50 000; "Buscar mais" asks for more). */
  execute: (connId: string, db: string, channel: string, sql: string, maxRows?: number) =>
    invoke<QueryResult[]>("execute", { connId, db, channel, sql, maxRows }),
  /** Manual transactions of the on-demand drivers (SQL Server, Oracle, Firebird, SQLite, DuckDB). */
  txControl: (connId: string, db: string, channel: string, action: "manual" | "auto" | "commit" | "rollback") =>
    invoke<void>("tx_control", { connId, db, channel, action }),
  cancel: (connId: string, db: string, channel: string) => invoke<void>("cancel_query", { connId, db, channel }),
  closeChannel: (connId: string, db: string, channel: string) =>
    invoke<void>("close_channel", { connId, db, channel }),
  detectTools: (connId: string) => invoke<ToolStatus[]>("detect_tools", { connId }),
  runTask: (spec: TaskSpec) => invoke<number>("run_task", { spec }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, contents: string) => invoke<void>("write_text_file", { path, contents }),
  loadDoc: <T>(key: string) => invoke<T | null>("load_doc", { key }),
  saveDoc: (key: string, value: unknown) => invoke<void>("save_doc", { key, value }),
  onTaskEvent: (cb: (e: TaskEvent) => void) => listen<TaskEvent>("task-event", (e) => cb(e.payload)),
};
