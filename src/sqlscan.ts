// SQL script scanner: splits a script into statements and finds structural problems
// (unclosed quotes, comments and parentheses, statements without a terminator).
//
// A statement ends at the delimiter (";", or the one set by MySQL DELIMITER / Firebird SET TERM),
// at a "GO" line (SQL Server) or a "/" line (Oracle). Like DataGrip, a line that starts a new
// statement (SELECT, INSERT, CREATE TABLE...) also ends the previous one when it has no ";", so
// "select 1\nselect 2" is two statements. Words that continue a statement (UNION, AS, THEN, a
// comma...) and procedural bodies keep the text together.
import type { DbKind } from "./api";
import { dialect } from "./dialects";

export interface Stmt {
  from: number;
  to: number;
  text: string;
  /** Ended by the delimiter (or GO, "/"); false when the next statement or the end of the text ended it. */
  terminated: boolean;
}

export interface SqlProblem {
  from: number;
  to: number;
  message: string;
  severity: "error" | "warning";
}

const w = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

/** Line-leading words that start a new statement. */
const HARD = w(`INSERT UPDATE DELETE MERGE CREATE ALTER DROP TRUNCATE GRANT REVOKE SHOW DESCRIBE EXPLAIN CALL EXEC COPY
  VACUUM USE COMMIT ROLLBACK REINDEX REFRESH PRAGMA ATTACH DETACH OPTIMIZE LISTEN NOTIFY UNLISTEN DISCARD CHECKPOINT`);
/** Query starters: a new statement unless the current one is still waiting for its query. */
const QUERY = w("SELECT WITH VALUES");
/** After these words the next line continues the statement. */
const CONT = w(`UNION ALL EXCEPT INTERSECT MINUS AS DISTINCT ON OF FOR DO KEY ROW THEN ELSE BEGIN INSTEAD ALSO OR AND NOT
  AFTER BEFORE EXPLAIN ANALYZE VERBOSE GRANT REVOKE EXECUTE IN EXISTS BY WHERE FROM JOIN INTO TO USING SET RETURNS
  RETURN WHEN IS LIKE ILIKE BETWEEN ANY SOME CREATE ALTER DROP REPLACE TEMP TEMPORARY TABLE VIEW IF ONLY LATERAL
  RECURSIVE MATERIALIZED STATEMENT EACH ATOMIC WITH SELECT INSERT UPDATE DELETE MERGE CASE`);
/** Statements whose query comes later ("INSERT INTO t\nSELECT ..."). */
const WAITS_QUERY = w("WITH INSERT CREATE EXPLAIN COPY DECLARE PREPARE REPLACE");
/** Procedural statements: never split by line (T-SQL IF ... / WHILE ...). */
const NO_SPLIT = w("IF WHILE BEGIN ELSE CASE FOR LOOP DO REPEAT");
/** What follows CREATE/ALTER/DROP when they start a statement. */
const OBJECTS = w(`TABLE VIEW INDEX UNIQUE SEQUENCE SCHEMA DATABASE FUNCTION PROCEDURE PROC TRIGGER TYPE EXTENSION ROLE
  USER MATERIALIZED OR TEMP TEMPORARY UNLOGGED GLOBAL LOCAL POLICY DOMAIN PUBLICATION SUBSCRIPTION EVENT SERVER FOREIGN
  AGGREGATE COLLATION OPERATOR RULE TABLESPACE PACKAGE SYNONYM LOGIN DEFINER ALGORITHM IF VIRTUAL CLUSTERED
  NONCLUSTERED FULLTEXT SPATIAL STATISTICS EDITIONABLE NONEDITIONABLE MACRO SECRET DICTIONARY RECURSIVE OWNED SYSTEM
  TEXT CAST CONVERSION ACCESS DEFAULT`);
/** Inside ALTER TABLE, "DROP INDEX", "ALTER COLUMN"... are clauses, not statements. */
const OBJECTS_IN_ALTER = new Set([...OBJECTS].filter((x) => !w("INDEX UNIQUE IF FOREIGN FULLTEXT SPATIAL CLUSTERED NONCLUSTERED VIRTUAL DEFAULT TYPE").has(x)));
const ROUTINES = w("PROCEDURE FUNCTION TRIGGER EVENT PACKAGE TYPE");
const END_OF = w("IF LOOP WHILE REPEAT FOR");

type Prev = { k: "word"; up: string } | { k: "close" | "lit" | "punct" };

export function scanSql(sql: string, kind: DbKind): { stmts: Stmt[]; problems: SqlProblem[] } {
  const fam = dialect(kind).family;
  const mongo = fam === "mongo";
  const n = sql.length;
  const stmts: Stmt[] = [];
  const problems: SqlProblem[] = [];
  const err = (from: number, to: number, message: string) => problems.push({ from, to: Math.max(to, from + 1), message, severity: "error" });

  let delimiter = ";";
  let custom = false;
  let start = 0;
  let lineStart = true;
  // current statement
  let words = 0;
  let first = "";
  let head: string[] = [];
  let sawQuery = false;
  let prev: Prev | null = null;
  let lastSigEnd = 0;
  let stack: number[] = [];
  /** Body that ";" does not end: until a "/" line (Oracle), a GO line (SQL Server) or the END of BEGIN (MySQL, SQLite). */
  let block: "" | "slash" | "go" | "beginend" = "";
  let routine = false;
  let beginDepth = 0;
  let caseDepth = 0;

  const push = (end: number, next: number, terminated: boolean) => {
    const raw = sql.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text && stripComments(text).trim() !== "") out(start + lead, text, terminated);
    for (const p of stack) err(p, p + 1, `"${sql[p]}" sem fechamento`);
    start = next;
    words = 0;
    first = "";
    head = [];
    sawQuery = false;
    prev = null;
    stack = [];
    block = "";
    routine = false;
    beginDepth = caseDepth = 0;
  };
  const out = (from: number, text: string, terminated: boolean) => stmts.push({ from, to: from + text.length, text, terminated });

  const eol = (i: number) => {
    const e = sql.indexOf("\n", i);
    return e < 0 ? n : e;
  };
  const nextWord = (j: number) => {
    for (;;) {
      while (j < n && /\s/.test(sql[j])) j++;
      if (sql.startsWith("--", j)) j = eol(j);
      else if (sql.startsWith("/*", j)) {
        const e = sql.indexOf("*/", j + 2);
        j = e < 0 ? n : e + 2;
      } else break;
    }
    const m = /^[A-Za-z_][\w$#]*/.exec(sql.slice(j, j + 64));
    return m ? m[0].toUpperCase() : "";
  };

  const prevContinues = () => {
    const p = prev;
    if (!p) return true;
    if (p.k === "word") return CONT.has(p.up);
    return p.k === "punct";
  };

  /** Whether a word at the start of a line begins a new statement. */
  const startsStatement = (up: string, after: number) => {
    if (mongo) return (up === "DB" && sql[after] === ".") || up === "USE" || up === "SHOW" ? !prevContinues() : false;
    if (prevContinues() || NO_SPLIT.has(first)) return false;
    if (QUERY.has(up)) return !(WAITS_QUERY.has(first) && !sawQuery);
    if (!HARD.has(up)) return false;
    const next = nextWord(after);
    if (up === "CREATE" || up === "ALTER" || up === "DROP") {
      if (!(first === "ALTER" ? OBJECTS_IN_ALTER : OBJECTS).has(next)) return false;
    }
    if (up === "USE" && (next === "INDEX" || next === "KEY")) return false;
    if (WAITS_QUERY.has(first) && !sawQuery && (up === "INSERT" || up === "UPDATE" || up === "DELETE" || up === "MERGE")) return false;
    return true;
  };

  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === "\n") {
      lineStart = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") {
      i++;
      continue;
    }
    // comments
    if (sql.startsWith("--", i) || (fam === "mysql" && c === "#") || (mongo && sql.startsWith("//", i))) {
      i = eol(i);
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const e = sql.indexOf("*/", i + 2);
      if (e < 0) err(i, i + 2, "Comentário /* sem fechamento");
      i = e < 0 ? n : e + 2;
      continue;
    }

    // whole-line commands: DELIMITER, SET TERM, GO, "/"
    if (lineStart) {
      const line = sql.slice(i, eol(i));
      const delim = fam === "mysql" && /^delimiter\s+(\S+)/i.exec(line);
      const term = fam === "firebird" && /^set\s+term\s+(.+)$/i.exec(line.trim());
      if (delim || term) {
        push(i, eol(i), true);
        if (delim) delimiter = delim[1];
        else if (term) {
          let t = term[1].trim();
          if (t.endsWith(delimiter) && t.length > delimiter.length) t = t.slice(0, -delimiter.length).trim();
          delimiter = t.split(/\s+/)[0] || ";";
        }
        custom = delimiter !== ";";
        i = eol(i);
        start = i;
        continue;
      }
      if ((fam === "sqlserver" && /^go(\s+\d+)?\s*$/i.test(line)) || (fam === "oracle" && /^\/\s*$/.test(line))) {
        push(i, eol(i), true);
        i = eol(i);
        start = i;
        continue;
      }
    }

    // delimiter
    if (sql.startsWith(delimiter, i) && block !== "slash" && block !== "go" && !(block === "beginend" && beginDepth > 0)) {
      push(i, i + delimiter.length, true);
      i += delimiter.length;
      lineStart = false;
      continue;
    }

    // quoted text and identifiers
    const bracket = c === "[" && (fam === "sqlserver" || fam === "sqlite");
    if (c === "'" || c === '"' || c === "`" || bracket) {
      const close = bracket ? "]" : c;
      const backslash = fam === "mysql" || fam === "clickhouse" || mongo || (c === "'" && (fam === "pg" || fam === "duckdb") && /[eE]/.test(sql[i - 1] ?? "") && !/\w/.test(sql[i - 2] ?? ""));
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === "\\" && backslash && close !== "`") j += 2;
        else if (sql[j] === close && sql[j + 1] === close) j += 2;
        else if (sql[j] === close) {
          closed = true;
          break;
        } else j++;
      }
      if (!closed) err(i, i + 1, c === "'" ? "Texto entre aspas sem fechamento" : `Identificador ${c} sem fechamento`);
      i = closed ? j + 1 : n;
      sig(i, { k: "lit" });
      continue;
    }
    if (c === "$" && (fam === "pg" || fam === "duckdb")) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const e = sql.indexOf(m[0], i + m[0].length);
        if (e < 0) err(i, i + m[0].length, `Corpo ${m[0]} sem fechamento`);
        i = e < 0 ? n : e + m[0].length;
        sig(i, { k: "lit" });
        continue;
      }
    }

    // words
    const wm = /^[A-Za-z_][\w$#]*/.exec(sql.slice(i, i + 128));
    if (wm) {
      const up = wm[0].toUpperCase();
      const after = i + wm[0].length;
      if (lineStart && words > 0 && !stack.length && !custom && !block && startsStatement(up, after)) {
        if (fam !== "sqlserver" && !mongo) err(lastSigEnd - 1, lastSigEnd, `Falta "${delimiter}" no fim da instrução`);
        // a comment after the last token, on the same line, stays out of the next statement
        push(lastSigEnd, eol(lastSigEnd), false);
      }
      words++;
      if (words === 1) first = up;
      if (head.length < 6) head.push(up);
      if (!stack.length && (up === "SELECT" || up === "VALUES")) sawQuery = true;
      if (!custom && !block && words <= 6) {
        const isRoutine = (head[0] === "CREATE" || head[0] === "ALTER") && ROUTINES.has(up);
        if (fam === "oracle" && (words === 1 ? up === "DECLARE" || up === "BEGIN" : isRoutine)) block = "slash";
        else if (fam === "sqlserver" && isRoutine && up !== "TYPE") block = "go";
        else if ((fam === "mysql" || fam === "sqlite") && isRoutine) routine = true;
      }
      if (routine && !stack.length) {
        if (up === "BEGIN") {
          beginDepth++;
          block = "beginend";
        } else if (up === "CASE" && beginDepth > 0) caseDepth++;
        else if (up === "END" && beginDepth > 0) {
          const nx = nextWord(after);
          if (nx === "CASE" || (caseDepth > 0 && !END_OF.has(nx))) caseDepth = Math.max(0, caseDepth - 1);
          else if (!END_OF.has(nx)) beginDepth--;
        }
      }
      i = after;
      sig(i, { k: "word", up });
      continue;
    }

    // numbers, brackets and operators
    if (/[0-9]/.test(c)) {
      const m = /^[0-9][\w.]*/.exec(sql.slice(i, i + 64))!;
      i += m[0].length;
      sig(i, { k: "lit" });
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      stack.push(i);
      i++;
      sig(i, { k: "punct" });
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      const open = { ")": "(", "]": "[", "}": "{" }[c];
      const top = stack[stack.length - 1];
      if (top !== undefined && sql[top] === open) stack.pop();
      else if (c === ")" || mongo) err(i, i + 1, `"${c}" sem abertura`);
      i++;
      sig(i, { k: "close" });
      continue;
    }
    i++;
    sig(i, { k: "punct" });
  }
  push(n, n, false);
  return { stmts, problems };

  function sig(end: number, p: Prev) {
    lastSigEnd = end;
    prev = p;
    lineStart = false;
  }
}

function stripComments(s: string) {
  return s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Split a SQL script into statements (see scanSql). */
export function splitSql(sql: string, kind: DbKind): Stmt[] {
  return scanSql(sql, kind).stmts;
}

/** The statement under the caret: the one containing it, or the one ending right before it on the same block. */
export function statementAt(text: string, pos: number, kind: DbKind) {
  const stmts = splitSql(text, kind);
  let best = stmts.find((s) => pos >= s.from && pos <= s.to);
  if (!best) {
    // Caret after a statement's ';' or on a blank line right below: take the previous one.
    best = [...stmts].reverse().find((s) => s.to <= pos && !/\n\s*\n/.test(text.slice(s.to, pos)));
  }
  return best ?? null;
}

// ---------------------------------------------------------------------------------------------
// Tokens, parameters and table references (for the console: parameter prompt, unknown tables,
// Ctrl+click to open a table)
// ---------------------------------------------------------------------------------------------

export interface Tok {
  t: "word" | "ident" | "str" | "num" | "punct";
  /** Words keep their case; quoted identifiers are unquoted. */
  text: string;
  from: number;
  to: number;
}

/** Tokens of a SQL text without comments; quoted identifiers become "ident" with the inner name. */
export function sqlTokens(sql: string, kind: DbKind): Tok[] {
  const fam = dialect(kind).family;
  const out: Tok[] = [];
  const n = sql.length;
  const wordRe = fam === "sqlserver" ? /^[A-Za-z_#@][\w$#@]*/ : /^[A-Za-z_][\w$#]*/;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (sql.startsWith("--", i) || (fam === "mysql" && c === "#") || (fam === "mongo" && sql.startsWith("//", i))) {
      const e = sql.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    const bracket = c === "[" && (fam === "sqlserver" || fam === "sqlite");
    if (c === "'" || c === '"' || c === "`" || bracket) {
      const close = bracket ? "]" : c;
      const backslash = c === "'" && (fam === "mysql" || fam === "clickhouse");
      let j = i + 1;
      let val = "";
      while (j < n) {
        if (sql[j] === "\\" && backslash) {
          val += sql.slice(j, j + 2);
          j += 2;
        } else if (sql[j] === close && sql[j + 1] === close) {
          val += close;
          j += 2;
        } else if (sql[j] === close) break;
        else val += sql[j++];
      }
      const to = Math.min(j + 1, n);
      out.push({ t: c === "'" ? "str" : "ident", text: val, from: i, to });
      i = to;
      continue;
    }
    if (c === "$" && (fam === "pg" || fam === "duckdb")) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const e = sql.indexOf(m[0], i + m[0].length);
        const to = e < 0 ? n : e + m[0].length;
        out.push({ t: "str", text: sql.slice(i, to), from: i, to });
        i = to;
        continue;
      }
    }
    const wm = wordRe.exec(sql.slice(i, i + 128));
    if (wm) {
      out.push({ t: "word", text: wm[0], from: i, to: i + wm[0].length });
      i += wm[0].length;
      continue;
    }
    const nm = /^[0-9][\w.]*/.exec(sql.slice(i, i + 64));
    if (nm) {
      out.push({ t: "num", text: nm[0], from: i, to: i + nm[0].length });
      i += nm[0].length;
      continue;
    }
    const two = sql.slice(i, i + 2);
    const p = two === "::" || two === ":=" || two === "${" ? two : c;
    out.push({ t: "punct", text: p, from: i, to: i + p.length });
    i += p.length;
  }
  return out;
}

export interface SqlParam {
  /** ":id", "?", "$1" or "${var}" as written. */
  name: string;
  from: number;
  to: number;
}

/** Parameters to ask before running: :name, ${name}, ? (not PostgreSQL, where ? is a JSON operator) and $1 (PostgreSQL). */
export function sqlParams(sql: string, kind: DbKind): SqlParam[] {
  const fam = dialect(kind).family;
  if (fam === "mongo") return [];
  const toks = sqlTokens(sql, kind);
  const out: SqlParam[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const prev = toks[k - 1];
    const next = toks[k + 1];
    const glued = (a: Tok | undefined, b: Tok | undefined) => !!a && !!b && a.to === b.from;
    if (t.t === "punct" && t.text === ":" && next?.t === "word" && glued(t, next) && !/^[#@]/.test(next.text)) {
      // a[1:n] (array slice) and x:y are not parameters
      if (prev && glued(prev, t) && (prev.t === "word" || prev.t === "num" || prev.t === "ident" || prev.text === ")" || prev.text === "]")) continue;
      out.push({ name: ":" + next.text, from: t.from, to: next.to });
      k++;
    } else if (t.t === "punct" && t.text === "${" && next?.t === "word" && toks[k + 2]?.text === "}") {
      out.push({ name: "${" + next.text + "}", from: t.from, to: toks[k + 2].to });
      k += 2;
    } else if (t.t === "punct" && t.text === "?" && fam !== "pg") {
      out.push({ name: "?", from: t.from, to: t.to });
    } else if (t.t === "punct" && t.text === "$" && fam === "pg" && next?.t === "num" && glued(t, next) && /^\d+$/.test(next.text)) {
      out.push({ name: "$" + next.text, from: t.from, to: next.to });
      k++;
    }
  }
  return out;
}

export interface TableRef {
  from: number;
  to: number;
  schema: string | null;
  name: string;
}

const REF_END = w(`WHERE ON USING SET GROUP ORDER LIMIT HAVING UNION EXCEPT INTERSECT MINUS VALUES SELECT RETURNING WINDOW
  FETCH OFFSET FOR JOIN INNER LEFT RIGHT FULL CROSS NATURAL OUTER QUALIFY PIVOT UNPIVOT TABLESAMPLE WITH INTO OUTPUT DEFAULT`);

/** Clauses that close the FROM list. */
const FROM_END = w("WHERE GROUP ORDER HAVING LIMIT UNION EXCEPT INTERSECT MINUS WINDOW SET RETURNING FOR QUALIFY OFFSET FETCH VALUES SELECT");

/**
 * Tables a script reads or writes (FROM, JOIN, UPDATE, INSERT/MERGE INTO, TRUNCATE) and the names it
 * defines itself (CTEs, CREATE TABLE/VIEW, SELECT INTO), which are not checked against the database.
 */
export function tableRefs(sql: string, kind: DbKind): { refs: TableRef[]; local: Set<string> } {
  const refs: TableRef[] = [];
  const local = new Set<string>();
  if (dialect(kind).family === "mongo") return { refs, local };
  for (const st of splitSql(sql, kind)) {
    const toks = sqlTokens(st.text, kind).map((t) => ({ ...t, from: t.from + st.from, to: t.to + st.from, up: t.t === "word" ? t.text.toUpperCase() : "" }));
    const first = toks[0]?.up ?? "";
    // per parenthesis depth: is it a subquery, and are we reading table names
    // fromList: inside a FROM clause, where "," starts another table; fn: a name followed by "(" is a function (FROM/JOIN only)
    const frames: { query: boolean; mode: "none" | "table" | "after"; fromList: boolean; fn: boolean }[] = [{ query: true, mode: "none", fromList: false, fn: false }];
    const top = () => frames[frames.length - 1];
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      const prev = toks[k - 1];
      const next = toks[k + 1];
      // names defined by the script
      if (t.up === "AS" && next?.text === "(") {
        let j = k - 1;
        if (toks[j]?.text === ")") {
          let d = 0;
          for (; j >= 0; j--) {
            if (toks[j].text === ")") d++;
            else if (toks[j].text === "(" && --d === 0) break;
          }
          j--;
        }
        const nm = toks[j];
        if (nm && (nm.t === "word" || nm.t === "ident")) local.add(nm.text.toLowerCase());
      }
      if ((t.up === "TABLE" || t.up === "VIEW") && toks.slice(0, k).some((x) => x.up === "CREATE")) {
        let j = k + 1;
        while (toks[j] && ["IF", "NOT", "EXISTS"].includes(toks[j].up)) j++;
        const nm = readName(toks, j);
        if (nm) local.add(nm.name.toLowerCase());
      }
      if (t.up === "INTO" && first === "SELECT") {
        const nm = readName(toks, k + 1);
        if (nm) local.add(nm.name.toLowerCase());
      }
      if (t.text === "(") {
        frames.push({ query: next?.up === "SELECT" || next?.up === "WITH" || next?.up === "VALUES", mode: "none", fromList: false, fn: false });
        continue;
      }
      if (t.text === ")") {
        if (frames.length > 1) frames.pop();
        continue;
      }
      const f = top();
      const starts =
        ((t.up === "FROM" && prev?.up !== "DISTINCT") || t.up === "JOIN" || (t.up === "TRUNCATE" && k === 0)) && f.query
          ? true
          : t.up === "UPDATE" && !["FOR", "DO", "KEY", "ON", "OF", "BEFORE", "AFTER", "OR"].includes(prev?.up ?? "") && f.query
            ? true
            : t.up === "INTO" && (first === "INSERT" || first === "MERGE" || first === "REPLACE" || first === "WITH") && f.query;
      if (starts) {
        f.mode = "table";
        f.fn = t.up === "FROM" || t.up === "JOIN";
        f.fromList = t.up === "FROM" || t.up === "JOIN" || f.fromList;
        continue;
      }
      if (t.t === "word" && FROM_END.has(t.up)) f.fromList = false;
      if (f.mode === "table") {
        if (t.up === "ONLY" || t.up === "TABLE" || t.up === "IGNORE" || t.up === "LATERAL") continue;
        const nm = readName(toks, k);
        if (nm) {
          if (!(f.fn && toks[nm.end]?.text === "(")) refs.push({ from: nm.from, to: nm.to, schema: nm.schema, name: nm.name });
          k = nm.end - 1;
        }
        f.mode = "after";
        continue;
      }
      if (t.text === "," && f.fromList) f.mode = "table";
      else if (f.mode === "after" && t.t === "word" && REF_END.has(t.up)) f.mode = "none";
    }
  }
  return { refs, local };
}

/** schema.name / name at toks[k] (three-part names keep the last two). */
function readName(toks: (Tok & { up: string })[], k: number) {
  const parts: (Tok & { up: string })[] = [];
  let j = k;
  while (toks[j] && (toks[j].t === "word" || toks[j].t === "ident")) {
    parts.push(toks[j]);
    if (toks[j + 1]?.text === "." && toks[j + 1].from === toks[j].to) j += 2;
    else {
      j++;
      break;
    }
  }
  if (!parts.length || (parts.length === 1 && parts[0].t === "word" && REF_END.has(parts[0].up))) return null;
  const last = parts[parts.length - 1];
  const schema = parts.length > 1 ? parts[parts.length - 2].text : null;
  return { name: last.text, schema, from: parts[0].from, to: last.to, end: j };
}

/** Table references that the database does not have, as lint warnings. */
export function unknownTables(sql: string, kind: DbKind, tables: { schema: string; table: string }[], defaultSchema: string): SqlProblem[] {
  // the metadata query stops at 5000 tables: past that, a missing name proves nothing
  if (!tables.length || tables.length >= 5000) return [];
  const fam = dialect(kind).family;
  const bySchema = new Map<string, Set<string>>();
  const anywhere = new Set<string>();
  for (const t of tables) {
    const s = t.schema.toLowerCase();
    if (!bySchema.has(s)) bySchema.set(s, new Set());
    bySchema.get(s)!.add(t.table.toLowerCase());
    anywhere.add(t.table.toLowerCase());
  }
  const system = (n: string) =>
    /^(pg_|sqlite_|information_schema|sys|mysql|performance_schema|rdb\$|mon\$|system\.)/i.test(n) || n === "dual" || /^[#@]/.test(n);
  const { refs, local } = tableRefs(sql, kind);
  const out: SqlProblem[] = [];
  for (const r of refs) {
    const name = r.name.toLowerCase();
    if (local.has(name) || system(name)) continue;
    if (r.schema) {
      const known = bySchema.get(r.schema.toLowerCase());
      if (!known || system(r.schema) || known.has(name)) continue;
      out.push({ from: r.from, to: r.to, message: `Tabela "${r.name}" não encontrada em ${r.schema}`, severity: "warning" });
    } else if (!anywhere.has(name)) {
      const where = fam === "pg" || fam === "sqlserver" || fam === "oracle" || fam === "duckdb" ? defaultSchema : "";
      out.push({ from: r.from, to: r.to, message: `Tabela "${r.name}" não encontrada${where ? ` (schema ${where})` : ""}`, severity: "warning" });
    }
  }
  return out;
}
