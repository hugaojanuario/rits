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


export { splitSql, type Stmt } from "./sqlscan";


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
