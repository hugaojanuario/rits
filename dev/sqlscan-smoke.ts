// Statement splitting cases of the SQL console (src/sqlscan.ts). In the app served by Vite (or the IDE mock):
// await (await import('/dev/sqlscan-smoke.ts')).probeSqlScan()  → [] when every case passes.
import type { DbKind } from "../src/api";
import { scanSql, sqlParams, tableRefs, unknownTables } from "../src/sqlscan";

const CASES: [DbKind, string, number][] = [
  ["postgres", "select * from rental\nselect * from film", 2],
  ["postgres", "select * from rental;\nselect 1", 2],
  ["postgres", "SELECT a\nFROM t\nUNION\nSELECT b FROM u", 1],
  ["postgres", "WITH x AS (\n select 1\n),\ny AS (select 2)\nSELECT * FROM x", 1],
  ["postgres", "INSERT INTO t (a)\nSELECT 1\nSELECT 2", 2],
  ["postgres", "INSERT INTO t\nSELECT 1", 1],
  ["postgres", "UPDATE t\nSET a = 1\nWHERE b = 2\nDELETE FROM t", 2],
  ["postgres", "ALTER TABLE t\n  ALTER COLUMN x TYPE int,\n  DROP COLUMN y\nALTER TABLE u ADD z int", 2],
  ["mysql", "ALTER TABLE t\nDROP INDEX i\nSELECT 1", 2],
  ["postgres", "CREATE VIEW v AS\nSELECT 1\nSELECT 2", 2],
  ["postgres", "EXPLAIN ANALYZE\nSELECT 1", 1],
  ["postgres", "INSERT INTO t VALUES (1)\nON CONFLICT (id) DO\nUPDATE SET a = 1", 1],
  ["postgres", "SELECT * FROM t\nFOR\nUPDATE", 1],
  ["postgres", "CREATE TABLE a (id int REFERENCES b(id) ON\nDELETE CASCADE)\nCREATE INDEX i ON a(id)", 2],
  ["postgres", "CREATE FUNCTION f() RETURNS int AS $$\nBEGIN\n select 1;\n return 2;\nEND $$ LANGUAGE plpgsql;\nselect f()", 2],
  ["mysql", "DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n SELECT 1;\n SELECT 2;\nEND$$\nDELIMITER ;\nCALL p();", 2],
  ["mysql", "CREATE PROCEDURE p()\nBEGIN\n IF x THEN SELECT 1; END IF;\n SELECT CASE WHEN 1 THEN 2 END;\nEND;\nCALL p();", 2],
  ["sqlite", "CREATE TRIGGER tr AFTER INSERT ON t\nBEGIN\n UPDATE u SET a=1;\n DELETE FROM v;\nEND;\nSELECT 1;", 2],
  ["sqlserver", "SELECT 1\nSELECT 2\nGO\nCREATE PROCEDURE p AS\nBEGIN\n SELECT 1;\n SELECT 2;\nEND\nGO\nEXEC p", 4],
  ["sqlserver", "IF EXISTS (SELECT 1)\nDROP TABLE t", 1],
  ["oracle", "CREATE OR REPLACE PROCEDURE p AS\nBEGIN\n NULL;\n INSERT INTO t VALUES (1);\nEND;\n/\nSELECT 1 FROM dual", 2],
  ["firebird", "SET TERM ^ ;\nCREATE PROCEDURE p AS BEGIN\n  SUSPEND;\nEND^\nSET TERM ; ^\nSELECT 1 FROM rdb$database;", 2],
  ["mongodb", "db.a.find({x: 1})\ndb.b.find()", 2],
  ["postgres", "select 'a;b' -- c;\n, \"x;\" from t", 1],
  ["postgres", "select 1\n\n-- comentario\nselect 2", 2],
  ["mysql", "SELECT * FROM t\nUSE INDEX (i)\nWHERE a=1", 1],
  ["postgres", "GRANT SELECT,\nINSERT ON t TO u\nGRANT ALL ON v TO u", 2],
  ["postgres", "select E'it\\'s' from t\nselect 2", 2],
];

const PROBLEMS: [string, string][] = [
  ["select 'abc from t", "Texto entre aspas sem fechamento"],
  ["select (1 from t", '"(" sem fechamento'],
  ["select 1) from t", '")" sem abertura'],
  ["/* x\nselect 1", "Comentário /* sem fechamento"],
  ["select 1\nselect 2", 'Falta ";" no fim da instrução'],
];

/** [kind, sql, parameters found] */
const PARAMS: [DbKind, string, string[]][] = [
  ["postgres", "select * from t where id = :id and nome = ':x' and a::int = 1 and b[1:n] = $1", [":id", "$1"]],
  ["mysql", "select * from t where a = ? and b = ${limite} and c = '?'", ["?", "${limite}"]],
  ["postgres", "select data ? 'chave' from t", []],
  ["sqlserver", "select @x, #t from t where id = :id", [":id"]],
];

/** [sql, tables referenced (schema.name), names defined by the script] */
const REFS: [string, string[], string[]][] = [
  ["select * from a join s.b on true, c x where y in (select 1 from d)", ["a", "s.b", "c", "d"], []],
  ["with w as (select 1 from e) select extract(year from now()) from w", ["e", "w"], ["w"]],
  ["insert into f (a) select * from generate_series(1, 2)", ["f"], []],
  ["update g set a = 1 from h where g.id = h.id", ["g", "h"], []],
  ["create table k as select 1; select * from k", ["k"], ["k"]],
  ["select * from t for update", ["t"], []],
  ["select a is distinct from b from m", ["m"], []],
];

export function probeSqlScan(): string[] {
  const failed: string[] = [];
  for (const [kind, sql, want] of CASES) {
    const got = scanSql(sql, kind).stmts.length;
    if (got !== want) failed.push(`${kind}: ${JSON.stringify(sql)} → ${got} instruções (esperado ${want})`);
  }
  for (const [sql, msg] of PROBLEMS) {
    if (!scanSql(sql, "postgres").problems.some((p) => p.message === msg)) failed.push(`${JSON.stringify(sql)}: sem "${msg}"`);
  }
  if (scanSql("select 1;\nselect 2;", "postgres").problems.length) failed.push("script com ; não deveria ter problemas");
  for (const [kind, sql, want] of PARAMS) {
    const got = sqlParams(sql, kind).map((p) => p.name);
    if (got.join() !== want.join()) failed.push(`parâmetros ${JSON.stringify(sql)} → ${got.join(" ")} (esperado ${want.join(" ")})`);
  }
  for (const [sql, want, local] of REFS) {
    const r = tableRefs(sql, "postgres");
    const got = r.refs.map((x) => (x.schema ? `${x.schema}.${x.name}` : x.name));
    if (got.join() !== want.join()) failed.push(`tabelas ${JSON.stringify(sql)} → ${got.join(" ")} (esperado ${want.join(" ")})`);
    for (const l of local) if (!r.local.has(l)) failed.push(`${JSON.stringify(sql)}: "${l}" deveria ser local`);
  }
  const known = [{ schema: "public", table: "film" }, { schema: "vendas", table: "pedido" }];
  const warn = unknownTables("select * from film, filme, vendas.pedido, vendas.x, outro.y, pg_class", "postgres", known, "public").map((p) => p.message);
  if (warn.join("|") !== 'Tabela "filme" não encontrada (schema public)|Tabela "x" não encontrada em vendas') failed.push(`tabelas desconhecidas: ${warn.join(" | ")}`);
  return failed;
}
