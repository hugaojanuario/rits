// Per-database behavior used by the explorer, console, table editor and connection dialog.
// Native drivers (Postgres, MySQL) are compiled into the app; the others are downloaded on demand
// the first time a connection is tested or saved (src-tauri/src/db/ext.rs).
import type { DbKind } from "./api";

export type Family = "pg" | "mysql" | "sqlserver" | "oracle" | "firebird" | "sqlite" | "duckdb" | "clickhouse" | "mongo";

export interface Dialect {
  kind: DbKind;
  label: string;
  icon: string;
  family: Family;
  port: number;
  user: string;
  database: string;
  /** database > schema > objects (false: database > objects, like MySQL). */
  schemas: boolean;
  /** Single file database (SQLite, DuckDB): "database" is the file path, no host/port/user. */
  file?: boolean;
  /** SQL console (false for MongoDB, which takes mongosh-style commands). */
  sql: boolean;
  /** pg_dump/mysqldump backups. */
  backup: boolean;
  native: boolean;
  /** What "database" means in the connection dialog. */
  databaseLabel: string;
  databasePlaceholder?: string;
  /** Folder name for "table" objects in the explorer. */
  tablesLabel?: string;
  quote: (name: string) => string;
  /** Wraps a SELECT with paging. */
  page: (select: string, limit: number, offset: number, hasOrder: boolean) => string;
  browse?: (schema: string, name: string, limit: number, offset: number, orderBy: string) => string;
  count?: (schema: string, name: string) => string;
  explain?: (sql: string) => string;
  begin?: string;
  createTable?: (fq: string) => string;
}

const dq = (n: string) => '"' + n.replace(/"/g, '""') + '"';
const bq = (n: string) => "`" + n.replace(/`/g, "``") + "`";
const br = (n: string) => "[" + n.replace(/]/g, "]]") + "]";
const PG_RESERVED = new Set(
  "all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp not null offset on only or order placing primary references returning select session_user some symmetric table then to trailing true union unique user using variadic when where window with".split(" "),
);
const pgQuote = (n: string) => (/^[a-z_][a-z0-9_]*$/.test(n) && !PG_RESERVED.has(n) ? n : dq(n));
const limitOffset = (s: string, l: number, o: number) => `${s} LIMIT ${l}${o ? ` OFFSET ${o}` : ""}`;
const fetchFirst = (s: string, l: number, o: number, hasOrder: boolean, noOrder = "") => `${s}${hasOrder ? "" : noOrder} OFFSET ${o} ROWS FETCH NEXT ${l} ROWS ONLY`;

const base = { sql: true, backup: false, native: false, schemas: false, user: "", database: "", databaseLabel: "Database" };

export const DIALECTS: Dialect[] = [
  {
    ...base,
    kind: "postgres",
    label: "PostgreSQL",
    icon: "postgres",
    family: "pg",
    port: 5432,
    user: "postgres",
    database: "postgres",
    schemas: true,
    backup: true,
    native: true,
    quote: pgQuote,
    page: limitOffset,
    explain: (s) => `EXPLAIN (VERBOSE, COSTS) ${s}`,
    begin: "BEGIN",
    createTable: (t) => `CREATE TABLE ${t} (\n    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n    nome       TEXT NOT NULL,\n    criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()\n);`,
  },
  {
    ...base,
    kind: "mysql",
    label: "MySQL / MariaDB",
    icon: "mysql",
    family: "mysql",
    port: 3306,
    user: "root",
    backup: true,
    native: true,
    databasePlaceholder: "(opcional)",
    quote: bq,
    page: limitOffset,
    explain: (s) => `EXPLAIN FORMAT=TREE ${s}`,
    begin: "START TRANSACTION",
    createTable: (t) => `CREATE TABLE ${t} (\n    id         BIGINT AUTO_INCREMENT PRIMARY KEY,\n    nome       VARCHAR(255) NOT NULL,\n    criado_em  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n);`,
  },
  {
    ...base,
    kind: "sqlserver",
    label: "SQL Server",
    icon: "dbSqlserver",
    family: "sqlserver",
    port: 1433,
    user: "sa",
    schemas: true,
    databasePlaceholder: "(opcional) master",
    quote: br,
    page: (s, l, o, hasOrder) => fetchFirst(s, l, o, hasOrder, " ORDER BY (SELECT NULL)"),
    createTable: (t) => `CREATE TABLE ${t} (\n    id         BIGINT IDENTITY(1,1) PRIMARY KEY,\n    nome       NVARCHAR(255) NOT NULL,\n    criado_em  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()\n);`,
  },
  {
    ...base,
    kind: "oracle",
    label: "Oracle",
    icon: "dbOracle",
    family: "oracle",
    port: 1521,
    user: "system",
    database: "FREEPDB1",
    schemas: true,
    databaseLabel: "Serviço",
    databasePlaceholder: "FREEPDB1, XEPDB1, ORCL…",
    quote: (n) => (/^[A-Z][A-Z0-9_$#]*$/.test(n) ? n : dq(n)),
    page: (s, l, o) => `${s} OFFSET ${o} ROWS FETCH NEXT ${l} ROWS ONLY`,
    explain: (s) => `EXPLAIN PLAN FOR ${s}`,
    createTable: (t) => `CREATE TABLE ${t} (\n    id         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n    nome       VARCHAR2(255) NOT NULL,\n    criado_em  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL\n)`,
  },
  {
    ...base,
    kind: "firebird",
    label: "Firebird",
    icon: "dbFirebird",
    family: "firebird",
    port: 3050,
    user: "SYSDBA",
    databaseLabel: "Arquivo ou alias do banco no servidor",
    databasePlaceholder: "/firebird/data/loja.fdb ou employee",
    quote: (n) => (/^[A-Z][A-Z0-9_$]*$/.test(n) ? n : dq(n)),
    page: (s, l, o) => `${s} OFFSET ${o} ROWS FETCH NEXT ${l} ROWS ONLY`,
    createTable: (t) => `CREATE TABLE ${t} (\n    id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,\n    nome       VARCHAR(255) NOT NULL,\n    criado_em  TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n);`,
  },
  {
    ...base,
    kind: "sqlite",
    label: "SQLite",
    icon: "dbSqlite",
    family: "sqlite",
    port: 0,
    file: true,
    databaseLabel: "Arquivo do banco",
    databasePlaceholder: "/caminho/para/banco.db",
    quote: dq,
    page: limitOffset,
    explain: (s) => `EXPLAIN QUERY PLAN ${s}`,
    begin: "BEGIN",
    createTable: (t) => `CREATE TABLE ${t} (\n    id         INTEGER PRIMARY KEY AUTOINCREMENT,\n    nome       TEXT NOT NULL,\n    criado_em  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);`,
  },
  {
    ...base,
    kind: "duckdb",
    label: "DuckDB",
    icon: "dbDuckdb",
    family: "duckdb",
    port: 0,
    file: true,
    schemas: true,
    databaseLabel: "Arquivo do banco",
    databasePlaceholder: "/caminho/para/dados.duckdb (vazio = memória)",
    quote: dq,
    page: limitOffset,
    explain: (s) => `EXPLAIN ${s}`,
    createTable: (t) => `CREATE TABLE ${t} (\n    id         BIGINT PRIMARY KEY,\n    nome       VARCHAR NOT NULL,\n    criado_em  TIMESTAMP DEFAULT current_timestamp\n);`,
  },
  {
    ...base,
    kind: "clickhouse",
    label: "ClickHouse",
    icon: "dbClickhouse",
    family: "clickhouse",
    port: 8123,
    user: "default",
    databasePlaceholder: "(opcional) default",
    quote: bq,
    page: limitOffset,
    explain: (s) => `EXPLAIN ${s}`,
    createTable: (t) => `CREATE TABLE ${t} (\n    id         UInt64,\n    nome       String,\n    criado_em  DateTime DEFAULT now()\n)\nENGINE = MergeTree\nORDER BY id;`,
  },
  {
    ...base,
    kind: "mongodb",
    label: "MongoDB",
    icon: "dbMongo",
    family: "mongo",
    port: 27017,
    sql: false,
    databasePlaceholder: "(opcional) test",
    tablesLabel: "Coleções",
    quote: (n) => n,
    page: (s) => s,
    browse: (_s, name, l, o, orderBy) => `db.getCollection(${JSON.stringify(name)}).find({})${orderBy ? `.sort(${orderBy})` : ""}${o ? `.skip(${o})` : ""}.limit(${l})`,
    count: (_s, name) => `db.getCollection(${JSON.stringify(name)}).countDocuments({})`,
  },
];

/** Postgres/MySQL-compatible servers offered as presets in the connection dialog. */
export const PRESETS: { label: string; kind: DbKind; port: number; user?: string; database?: string; ssl?: boolean; icon: string }[] = [
  { label: "MariaDB", kind: "mysql", port: 3306, user: "root", icon: "mysql" },
  { label: "CockroachDB", kind: "postgres", port: 26257, user: "root", database: "defaultdb", icon: "postgres" },
  { label: "TimescaleDB", kind: "postgres", port: 5432, user: "postgres", database: "postgres", icon: "postgres" },
  { label: "Supabase / Neon", kind: "postgres", port: 5432, user: "postgres", database: "postgres", ssl: true, icon: "postgres" },
  { label: "TiDB", kind: "mysql", port: 4000, user: "root", icon: "mysql" },
  { label: "Amazon Redshift", kind: "postgres", port: 5439, user: "awsuser", database: "dev", ssl: true, icon: "postgres" },
];

const byKind = new Map(DIALECTS.map((d) => [d.kind, d]));

export function dialect(kind: DbKind): Dialect {
  return byKind.get(kind) ?? DIALECTS[0];
}
