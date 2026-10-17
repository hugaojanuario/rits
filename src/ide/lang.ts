// Editor theme (Islands color scheme) and per-file language support.
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting, StreamLanguage, indentUnit, type LanguageSupport, type Language } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import { python } from "@codemirror/lang-python";
import { go } from "@codemirror/lang-go";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { P } from "./host";

export const islandsHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: "var(--syn-keyword)" },
  { tag: [t.bool, t.null, t.atom], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.character, t.regexp], color: "var(--syn-string)" },
  { tag: t.escape, color: "var(--syn-escape)" },
  { tag: [t.number, t.integer, t.float], color: "var(--syn-number)" },
  { tag: [t.lineComment, t.blockComment, t.comment], color: "var(--syn-comment)" },
  { tag: t.docComment, color: "var(--syn-doc)", fontStyle: "italic" },
  { tag: [t.function(t.definition(t.variableName)), t.function(t.definition(t.propertyName))], color: "var(--syn-func)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-call)" },
  { tag: [t.definition(t.className), t.className, t.typeName, t.namespace], color: "var(--syn-type)" },
  { tag: t.standard(t.typeName), color: "var(--syn-keyword)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-field)" },
  { tag: [t.constant(t.variableName), t.constant(t.name)], color: "var(--syn-const)" },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: "var(--syn-meta)" },
  { tag: [t.standard(t.variableName), t.standard(t.name)], color: "var(--syn-builtin)" },
  { tag: t.self, color: "var(--syn-self)" },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator, t.derefOperator], color: "var(--syn-op)" },
  { tag: [t.variableName, t.name, t.labelName], color: "var(--syn-ident)" },
  { tag: t.tagName, color: "var(--syn-tag)" },
  { tag: t.heading, color: "var(--syn-keyword)", fontWeight: "bold" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--accent)", textDecoration: "underline" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.invalid, color: "var(--danger)" },
]);

export const islandsTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--editor-font-size)", backgroundColor: "var(--editor-bg)", color: "var(--editor-fg)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6", fontVariantLigatures: "contextual" },
  ".cm-content": { caretColor: "var(--icon)", padding: "calc(10px + 1.6em) 0 40vh" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--icon)", borderLeftWidth: "2px" },
  ".cm-gutters": { backgroundColor: "var(--editor-bg)", color: "var(--editor-gutter-fg)", border: "none", paddingLeft: "6px" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 6px", minWidth: "36px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--editor-gutter-active)" },
  ".cm-activeLine": { backgroundColor: "var(--editor-caret-row)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--editor-selection) !important" },
  ".cm-selectionMatch": { backgroundColor: "var(--ident-caret)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "var(--brace-match)", outline: "none", color: "inherit" },
  ".cm-searchMatch": { backgroundColor: "var(--search-match)", outline: "none" },
  ".cm-searchMatch-selected": { outline: "1px solid var(--accent)" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--fg-faint)", padding: "0 2px" },
  ".cm-foldPlaceholder": { background: "var(--sel-inactive)", border: "none", color: "var(--fg-dim)", padding: "0 6px", borderRadius: "4px" },
  ".cm-tooltip": { backgroundColor: "var(--popup)", border: "1px solid var(--border)", color: "var(--fg)", borderRadius: "8px", boxShadow: "var(--shadow)", overflow: "hidden" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", fontSize: "var(--editor-font-size)", maxHeight: "20em", padding: "4px 0" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "2px 10px", lineHeight: "1.6" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--sel)", color: "var(--fg)" },
  ".cm-completionDetail": { color: "var(--fg-faint)", fontStyle: "normal", marginLeft: "1.5em", fontFamily: "var(--ui)" },
  ".cm-completionMatchedText": { color: "var(--accent)", textDecoration: "none", fontWeight: "600" },
  ".cm-completionInfo": { padding: "8px 12px", maxWidth: "460px", fontFamily: "var(--ui)" },
  ".cm-tooltip-hover, .cm-lsp-documentation": { padding: "8px 12px", maxWidth: "620px", maxHeight: "360px", overflow: "auto", fontFamily: "var(--ui)", lineHeight: "1.5" },
  ".cm-tooltip-hover pre, .cm-lsp-documentation pre": { fontFamily: "var(--mono)", whiteSpace: "pre-wrap", margin: "4px 0" },
  ".cm-tooltip-hover code": { fontFamily: "var(--mono)" },
  ".cm-diagnostic": { padding: "6px 10px", fontFamily: "var(--ui)", borderLeft: "none" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--error-underline)" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--warning-underline)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--error-underline)", textDecorationThickness: "1px", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { backgroundImage: "none", backgroundColor: "rgba(242,197,92,0.12)", textDecoration: "underline wavy var(--warning-underline)", textDecorationThickness: "1px", textUnderlineOffset: "3px" },
  ".cm-lintRange-info, .cm-lintRange-hint": { backgroundImage: "none", textDecoration: "underline dotted var(--fg-faint)" },
  ".cm-lint-marker": { width: "10px", height: "10px" },
  ".cm-panels": { backgroundColor: "var(--island)", color: "var(--fg)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-search": { fontFamily: "var(--ui)", padding: "6px 10px" },
  ".cm-search input, .cm-search button, .cm-panel input, .cm-panel button": {
    color: "var(--fg)", background: "var(--input-bg)", border: "1px solid var(--border-2)", borderRadius: "4px", fontFamily: "var(--ui)", height: "26px", backgroundImage: "none",
  },
  ".cm-search label": { fontSize: "12px" },
  ".cm-indent-markers": { "--indent-marker-bg-color": "var(--indent-guide)" },
  ".cm-signature-tooltip": { padding: "6px 10px", fontFamily: "var(--mono)" },
  ".cm-lsp-signature-tooltip": { padding: "6px 10px", fontFamily: "var(--mono)" },
});

export interface LangInfo {
  id: string; // LSP language id
  label: string;
  ext: () => Extension;
  indent: string;
}

const legacy = (m: Parameters<typeof StreamLanguage.define>[0]) => () => StreamLanguage.define(m);

/** HCL / Terraform: blocks, attributes, strings with ${} interpolation, heredocs, comments. */
const HCL_BLOCKS = new Set(["resource", "data", "variable", "output", "locals", "module", "provider", "terraform", "required_providers", "backend", "moved", "import", "check", "removed", "dynamic", "content", "lifecycle", "provisioner", "connection"]);
const HCL_KEYWORDS = new Set(["for", "in", "if", "else", "endif", "endfor"]);
const HCL_ATOMS = new Set(["true", "false", "null"]);
const HCL_TYPES = new Set(["string", "number", "bool", "list", "map", "set", "object", "tuple", "any"]);
interface HclState {
  inString: boolean;
  interp: number;
  heredoc: string | null;
  comment: boolean;
}
const hcl = {
  name: "hcl",
  startState: (): HclState => ({ inString: false, interp: 0, heredoc: null, comment: false }),
  token(stream: any, st: HclState): string | null {
    if (st.comment) {
      if (stream.match(/^.*?\*\//)) st.comment = false;
      else stream.skipToEnd();
      return "comment";
    }
    if (st.heredoc) {
      if (stream.sol() && stream.match(new RegExp(`^\\s*${st.heredoc}\\s*$`))) {
        st.heredoc = null;
        return "string";
      }
      if (stream.match("${")) return (st.interp++, "meta");
      stream.next();
      return "string";
    }
    if (st.inString && !st.interp) {
      if (stream.match("${") || stream.match("%{")) return (st.interp++, "meta");
      if (stream.match(/^\\./)) return "string.special";
      const ch = stream.next();
      if (ch === '"') st.inString = false;
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (st.interp && stream.peek() === "}") {
      stream.next();
      st.interp--;
      return "meta";
    }
    if (stream.match("#") || stream.match("//")) return (stream.skipToEnd(), "comment");
    if (stream.match("/*")) return ((st.comment = true), "comment");
    const hd = stream.match(/^<<-?\s*([A-Z_]+)/);
    if (hd) return ((st.heredoc = hd[1]), "string");
    if (stream.peek() === '"') {
      stream.next();
      st.inString = true;
      return "string";
    }
    if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return "number";
    const w = stream.match(/^[A-Za-z_][\w-]*/);
    if (w) {
      const word = w[0];
      if (HCL_ATOMS.has(word)) return "atom";
      if (HCL_KEYWORDS.has(word)) return "keyword";
      if (stream.sol !== undefined && HCL_BLOCKS.has(word) && /^\s*("|\{|[A-Za-z_])/.test(stream.string.slice(stream.pos)) && stream.string.slice(0, stream.start).trim() === "") return "keyword";
      if (HCL_TYPES.has(word)) return "typeName";
      if (/^\s*\(/.test(stream.string.slice(stream.pos))) return "variableName.function";
      if (/^\s*=(?!=)/.test(stream.string.slice(stream.pos))) return "propertyName";
      if (["var", "local", "module", "data", "each", "count", "path", "self", "terraform"].includes(word) && stream.peek() === ".") return "variableName.special";
      return "variableName";
    }
    if (stream.match(/^(==|!=|>=|<=|&&|\|\||=>|[=+\-*/%<>!?:])/)) return "operator";
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "#", block: { open: "/*", close: "*/" } }, closeBrackets: { brackets: ["(", "[", "{", '"'] } },
};

const LANGS: Record<string, LangInfo> = {
  python: { id: "python", label: "Python", ext: () => python(), indent: "    " },
  go: { id: "go", label: "Go", ext: () => go(), indent: "\t" },
  json: { id: "json", label: "JSON", ext: () => json(), indent: "  " },
  yaml: { id: "yaml", label: "YAML", ext: () => yaml(), indent: "  " },
  markdown: { id: "markdown", label: "Markdown", ext: () => markdown(), indent: "  " },
  javascript: { id: "javascript", label: "JavaScript", ext: () => javascript({ jsx: true }), indent: "  " },
  typescript: { id: "typescript", label: "TypeScript", ext: () => javascript({ jsx: true, typescript: true }), indent: "  " },
  html: { id: "html", label: "HTML", ext: () => html(), indent: "  " },
  css: { id: "css", label: "CSS", ext: () => css(), indent: "  " },
  sql: { id: "sql", label: "SQL", ext: () => sql({ dialect: PostgreSQL, upperCaseKeywords: true }), indent: "    " },
  toml: { id: "toml", label: "TOML", ext: legacy(toml), indent: "  " },
  shell: { id: "shellscript", label: "Shell", ext: legacy(shell), indent: "  " },
  powershell: { id: "powershell", label: "PowerShell", ext: legacy(powerShell), indent: "    " },
  dockerfile: { id: "dockerfile", label: "Dockerfile", ext: legacy(dockerFile), indent: "  " },
  terraform: { id: "terraform", label: "Terraform", ext: legacy(hcl as never), indent: "  " },
  tfvars: { id: "terraform-vars", label: "Terraform vars", ext: legacy(hcl as never), indent: "  " },
  hcl: { id: "hcl", label: "HCL", ext: legacy(hcl as never), indent: "  " },
  ignore: { id: "ignore", label: "Ignore", ext: legacy(properties), indent: "  " },
  properties: { id: "properties", label: "Properties", ext: legacy(properties), indent: "  " },
  gomod: { id: "go.mod", label: "Go Module", ext: legacy(properties), indent: "\t" },
  text: { id: "plaintext", label: "Texto", ext: () => [], indent: "    " },
};

const EXT: Record<string, string> = {
  py: "python", pyi: "python", pyw: "python", go: "go", json: "json", jsonc: "json", ipynb: "json", yaml: "yaml", yml: "yaml",
  md: "markdown", markdown: "markdown", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript",
  tsx: "typescript", html: "html", htm: "html", vue: "html", css: "css", scss: "css", sql: "sql", toml: "toml", sh: "shell",
  bash: "shell", zsh: "shell", ps1: "powershell", psm1: "powershell", ini: "properties", cfg: "properties", properties: "properties",
  env: "properties", conf: "properties", tf: "terraform", tfvars: "tfvars", hcl: "hcl", nomad: "hcl", tftest: "hcl",
};

export function langFor(path: string): LangInfo {
  const base = P.base(path).toLowerCase();
  if (base === "dockerfile" || base === "containerfile" || base.endsWith(".dockerfile") || base.startsWith("dockerfile.")) return LANGS.dockerfile;
  if (base === ".dockerignore" || base === ".helmignore") return LANGS.ignore;
  if (base.endsWith(".tf.json")) return LANGS.json;
  if (base === "go.mod" || base === "go.work") return LANGS.gomod;
  if (base === ".env" || base.startsWith(".env.")) return LANGS.properties;
  if (base === "makefile") return LANGS.shell;
  return LANGS[EXT[P.ext(path)]] ?? LANGS.text;
}

export function langExtensions(info: LangInfo): Extension[] {
  return [info.ext() as LanguageSupport | Language | Extension, indentUnit.of(info.indent), syntaxHighlighting(islandsHighlight)];
}
