import type { DbKind } from "./api";
import { dialect } from "./dialects";

type Attrs = Record<string, unknown> & { class?: string; style?: string };
type Child = Node | string | null | undefined | false;

/** Tiny hyperscript helper: h("div.foo", {onclick}, child...) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | `${K}.${string}`,
  attrs?: Attrs | null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name as K);
  if (classes.length) el.className = classes.join(" ");
  if (name === "input" || name === "textarea") {
    // macOS WebKit autocorrects and capitalizes typed text (file names, identifiers, SQL) even with
    // spellcheck off; none of the IDE's fields want that.
    el.setAttribute("autocorrect", "off");
    el.setAttribute("autocapitalize", "off");
    el.setAttribute("autocomplete", "off");
    if (name === "input") el.setAttribute("spellcheck", "false");
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2), v as EventListener);
      } else if (k === "class") {
        el.className = [el.className, v].filter(Boolean).join(" ");
      } else if (k === "style") {
        el.setAttribute("style", String(v));
      } else if (k === "html") {
        el.innerHTML = String(v);
      } else if (k in el && typeof v !== "string") {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, v === true ? "" : String(v));
      }
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return el;
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: number | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

export function quoteIdent(kind: DbKind, name: string): string {
  return dialect(kind).quote(name);
}

export function quoteLiteral(kind: DbKind, v: string | null): string {
  if (v === null) return "NULL";
  let s = v.replace(/'/g, "''");
  if (kind === "mysql") s = s.replace(/\\/g, "\\\\");
  return `'${s}'`;
}

export function qualified(kind: DbKind, schema: string, name: string): string {
  // Databases without schemas (SQLite "main", Firebird file, Mongo) are addressed by name only.
  const d = dialect(kind);
  if (!schema || d.family === "firebird" || d.family === "mongo" || (d.family === "sqlite" && schema === "main")) return quoteIdent(kind, name);
  return `${quoteIdent(kind, schema)}.${quoteIdent(kind, name)}`;
}


export interface Stmt {
  from: number;
  to: number;
  text: string;
}

/** Split a SQL script into statements, honouring quotes, comments and $$ bodies. */
export function splitSql(sql: string, kind: DbKind): Stmt[] {
  const out: Stmt[] = [];
  let start = 0;
  let i = 0;
  let delimiter = ";";
  const n = sql.length;
  const push = (end: number, next: number) => {
    const raw = sql.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) out.push({ from: start + lead, to: start + lead + text.length, text });
    start = next;
  };
  while (i < n) {
    const c = sql[i];
    const c2 = sql.slice(i, i + 2);
    if (c2 === "--" || (kind === "mysql" && c === "#")) {
      const e = sql.indexOf("\n", i);
      i = e < 0 ? n : e + 1;
    } else if (c2 === "/*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "\\" && kind === "mysql" && c !== "`") j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      i = j + 1;
    } else if (c === "$" && kind === "postgres") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const e = sql.indexOf(m[0], i + m[0].length);
        i = e < 0 ? n : e + m[0].length;
      } else i++;
    } else if (
      kind === "mysql" &&
      (i === 0 || sql[i - 1] === "\n") &&
      /^delimiter\s+/i.test(sql.slice(i, i + 10))
    ) {
      const e = sql.indexOf("\n", i);
      const line = sql.slice(i, e < 0 ? n : e);
      push(i, e < 0 ? n : e + 1);
      delimiter = line.trim().split(/\s+/)[1] || ";";
      i = e < 0 ? n : e + 1;
    } else if (sql.startsWith(delimiter, i)) {
      push(i, i + delimiter.length);
      i += delimiter.length;
    } else i++;
  }
  push(n, n);
  return out.filter((s) => !/^delimiter\s/i.test(s.text) && stripComments(s.text).trim() !== "");
}

function stripComments(s: string) {
  return s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}

export function timestamp() {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function copyText(text: string) {
  return navigator.clipboard.writeText(text);
}

export function escapeCsv(v: string | null) {
  if (v === null) return "";
  return /[",\n\r;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

export function isNumericLike(v: string) {
  return /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v);
}
