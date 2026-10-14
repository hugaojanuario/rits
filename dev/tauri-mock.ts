// Dev-only stand-in for the Tauri backend so the UI can be previewed in a normal browser.
const conns = [
  { id: "pg1", name: "Local Postgres", kind: "postgres", host: "localhost", port: 5432, user: "postgres", password: "", database: "loja", ssl: false, toolsDir: "", color: "#3fb27f", readOnly: false },
  { id: "my1", name: "MySQL Loja", kind: "mysql", host: "localhost", port: 3306, user: "root", password: "", database: "loja", ssl: false, toolsDir: "", color: "#e5a50a", readOnly: false },
];
const clientes = Array.from({ length: 200 }, (_, i) => [String(i + 1), `Cliente ${i + 1}`, i % 7 ? `c${i + 1}@ex.com` : null, `2026-10-${String((i % 28) + 1).padStart(2, "0")} 10:${String(i % 60).padStart(2, "0")}:00-03`]);
const handlers: Record<string, (a: any) => unknown> = {
  list_connections: () => conns,
  connect: () => ({ version: "PostgreSQL 17.11 on x86_64", currentUser: "postgres" }),
  list_databases: (a) => (a.connId === "pg1" ? ["loja", "postgres"] : ["loja", "mysql", "sys"]),
  list_schemas: () => ["public", "vendas", "pg_catalog", "information_schema"],
  list_objects: (a) =>
    a.schema === "vendas" || a.schema === "loja"
      ? [
          { name: "clientes", kind: "table", comment: "Cadastro de clientes" },
          { name: "pedidos", kind: "table", comment: null },
          { name: "resumo", kind: "view", comment: null },
          { name: "total_cliente(cid bigint)", kind: "function", comment: null },
          { name: "pedidos_id_seq", kind: "sequence", comment: null },
        ]
      : [{ name: "log_sem_pk", kind: "table", comment: null }],
  list_columns: () => [
    { name: "id", dataType: "bigint", nullable: false, default: null, pk: true, comment: null },
    { name: "nome", dataType: "text", nullable: false, default: null, pk: false, comment: "Nome completo" },
    { name: "email", dataType: "text", nullable: true, default: null, pk: false, comment: null },
    { name: "criado_em", dataType: "timestamp with time zone", nullable: true, default: "now()", pk: false, comment: null },
  ],
  list_indexes: () => [{ name: "clientes_pkey", columns: "id", unique: true, primary: true }, { name: "clientes_email_key", columns: "email", unique: true, primary: false }],
  get_ddl: () => "CREATE TABLE vendas.clientes (\n    id bigint NOT NULL,\n    nome text NOT NULL,\n    CONSTRAINT clientes_pkey PRIMARY KEY (id)\n);",
  completion_info: () => [{ schema: "vendas", table: "clientes", columns: ["id", "nome", "email", "criado_em"] }, { schema: "vendas", table: "pedidos", columns: ["id", "cliente_id", "total", "status"] }],
  execute: (a) => {
    const s: string = a.sql;
    if (/count\(\*\)/i.test(s)) return [{ columns: ["count"], rows: [["1500"]], affected: null, hasRows: true, truncated: false, elapsedMs: 3 }];
    if (/^\s*select/i.test(s)) return [{ columns: ["id", "nome", "email", "criado_em"], rows: clientes, affected: null, hasRows: true, truncated: false, elapsedMs: 12 }];
    if (/nao_existe/.test(s)) throw 'ERROR: relation "nao_existe" does not exist\nPosição: 15';
    return [{ columns: [], rows: [], affected: 3, hasRows: false, truncated: false, elapsedMs: 4 }];
  },
  detect_tools: () => [{ name: "pg_dump", path: "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe", version: "pg_dump (PostgreSQL) 17.11" }, { name: "pg_restore", path: null, version: null }, { name: "psql", path: null, version: null }],
  load_doc: (a) => (a.key === "history" ? [{ time: Date.now(), connId: "pg1", db: "loja", sql: "SELECT * FROM vendas.clientes" }] : null),
  save_doc: () => null,
  test_connection: () => ({ version: "PostgreSQL 17.11", currentUser: "postgres" }),
  "plugin:event|listen": () => 1,
  "plugin:event|unlisten": () => null,
};
let cb = 0;
(window as any).__TAURI_INTERNALS__ = {
  transformCallback: () => ++cb,
  unregisterCallback: () => {},
  invoke: async (cmd: string, args: any) => {
    await new Promise((r) => setTimeout(r, 60));
    const f = handlers[cmd];
    if (!f) return null;
    return f(args);
  },
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
