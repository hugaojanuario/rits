// CodeMirror setup shared by consoles and DDL viewers.
import { EditorView, keymap, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, rectangularSelection, crosshairCursor, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment, RangeSetBuilder, StateEffect, type Extension } from "@codemirror/state";
import { sql, PostgreSQL, MySQL, MSSQL, PLSQL, SQLite, StandardSQL, type SQLDialect, type SQLNamespace } from "@codemirror/lang-sql";
import { javascript } from "@codemirror/lang-javascript";
import { dialect } from "./dialects";
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import type { CompletionTable, DbKind } from "./api";
import { scanSql, statementAt, unknownTables } from "./sqlscan";
import { linter, type Diagnostic } from "@codemirror/lint";
import { completionTabKeymap } from "./ide/completion";

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syn-keyword)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.typeName, t.standard(t.name)], color: "var(--syn-type)" },
  { tag: [t.function(t.variableName), t.function(t.name)], color: "var(--syn-func)" },
  { tag: [t.operator, t.punctuation], color: "var(--syn-op)" },
  { tag: [t.special(t.name), t.quote], color: "var(--syn-ident)" },
]);

const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--editor-font-size)", backgroundColor: "var(--editor-bg)", color: "var(--fg)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--accent)", paddingTop: "calc(8px + 1.55em)" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-gutters": { backgroundColor: "var(--editor-bg)", color: "var(--fg-dim)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg)" },
  ".cm-activeLine": { backgroundColor: "var(--editor-active-line)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--editor-selection) !important" },
  ".cm-current-stmt": { backgroundColor: "var(--editor-stmt)" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--border)", color: "var(--fg)", borderRadius: "6px", overflow: "hidden" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-bg)", color: "var(--fg)" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", maxHeight: "18em" },
  ".cm-completionDetail": { color: "var(--fg-dim)", fontStyle: "normal", marginLeft: "1em" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)", borderColor: "var(--border)" },
  ".cm-panels input, .cm-panels button": { color: "var(--fg)", background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: "4px" },
  ".cm-searchMatch": { backgroundColor: "var(--search-match)" },
  ".cm-matchingBracket": { backgroundColor: "var(--editor-selection)", outline: "none" },
  ".cm-foldGutter span": { color: "var(--fg-dim)" },
});

/** Highlights the statement under the caret (what Ctrl+Enter will run). */
function currentStatement(kind: () => DbKind): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.focusChanged) this.decorations = this.build(u.view);
      }
      build(view: EditorView) {
        const b = new RangeSetBuilder<Decoration>();
        const sel = view.state.selection.main;
        if (!sel.empty || !view.hasFocus) return b.finish();
        const stmt = statementAt(view.state.doc.toString(), sel.head, kind());
        if (!stmt) return b.finish();
        const doc = view.state.doc;
        const l1 = doc.lineAt(stmt.from).number;
        const l2 = doc.lineAt(stmt.to).number;
        if (l1 === l2 && doc.lines === 1) return b.finish();
        for (let l = l1; l <= l2; l++) b.add(doc.line(l).from, doc.line(l).from, Decoration.line({ class: "cm-current-stmt" }));
        return b.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

export { statementAt };

export function buildNamespace(tables: CompletionTable[], defaultSchema: string): SQLNamespace {
  const ns: Record<string, Record<string, string[]>> = {};
  const top: Record<string, string[]> = {};
  for (const tb of tables) {
    (ns[tb.schema] ??= {})[tb.table] = tb.columns;
    if (tb.schema === defaultSchema) top[tb.table] = tb.columns;
  }
  return { ...ns, ...top } as SQLNamespace;
}

export interface EditorHandle {
  view: EditorView;
  setLanguage: (kind: DbKind, tables: CompletionTable[], defaultSchema: string) => void;
  setReadOnly: (ro: boolean) => void;
  /** Marks where the database reported an error (cleared on the next edit); null clears it. */
  setExecError: (e: { from: number; to: number; message: string } | null) => void;
}

export function createEditor(
  parent: HTMLElement,
  doc: string,
  kind: DbKind,
  extraKeys: { key: string; run: () => boolean; preventDefault?: boolean }[] = [],
  onChange?: (text: string) => void,
  extra: Extension[] = [],
): EditorHandle {
  const lang = new Compartment();
  const ro = new Compartment();
  let curKind = kind;
  let execErrors: Diagnostic[] = [];
  /** Tables of the connected database (from the completion metadata) for the "unknown table" warning. */
  let known: { tables: CompletionTable[]; def: string } = { tables: [], def: "" };
  const CM_DIALECT: Record<string, SQLDialect> = { pg: PostgreSQL, mysql: MySQL, clickhouse: MySQL, sqlserver: MSSQL, oracle: PLSQL, sqlite: SQLite, duckdb: PostgreSQL, firebird: StandardSQL };
  // MongoDB consoles take mongosh-style JavaScript.
  const langExt = (k: DbKind, ns: SQLNamespace = {}, def?: string): Extension =>
    dialect(k).family === "mongo" ? javascript() : sql({ dialect: CM_DIALECT[dialect(k).family] ?? StandardSQL, schema: ns, defaultSchema: def, upperCaseKeywords: true });
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        completionTabKeymap,
        autocompletion({ activateOnTyping: true, maxRenderedOptions: 80 }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          ...extraKeys,
          { key: "Mod-/", run: toggleComment },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        lang.of(langExt(kind)),
        ro.of(EditorState.readOnly.of(false)),
        syntaxHighlighting(highlight),
        baseTheme,
        currentStatement(() => curKind),
        sqlLint(() => curKind, () => execErrors, () => known),
        ...extra,
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          execErrors = [];
          onChange?.(u.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    view,
    setLanguage(k, tables, def) {
      curKind = k;
      known = { tables, def };
      view.dispatch({ effects: [lang.reconfigure(langExt(k, buildNamespace(tables, def), def)), relint.of(null)] });
    },
    setReadOnly(r) {
      view.dispatch({ effects: ro.reconfigure(EditorState.readOnly.of(r)) });
    },
    setExecError(e) {
      const len = view.state.doc.length;
      execErrors = e ? [{ from: Math.min(e.from, len), to: Math.min(Math.max(e.to, e.from + 1), len), severity: "error", message: e.message, source: "Banco" }] : [];
      view.dispatch({ effects: relint.of(null) });
    },
  };
}

const relint = StateEffect.define<null>();

/** Structural problems of the script (missing ";", unclosed quotes and parentheses) plus the last database error. */
function sqlLint(kind: () => DbKind, exec: () => Diagnostic[], known: () => { tables: CompletionTable[]; def: string }): Extension {
  return linter(
    (view) => {
      const text = view.state.doc.toString();
      const k = known();
      const found: Diagnostic[] = [...scanSql(text, kind()).problems, ...unknownTables(text, kind(), k.tables, k.def)].map((p) => ({ ...p, source: "SQL" }));
      return [...found, ...exec()];
    },
    { delay: 350, needsRefresh: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(relint))) },
  );
}

const KW_BREAK = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "UNION ALL", "UNION", "EXCEPT", "INTERSECT",
  "VALUES", "SET", "RETURNING", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "FULL OUTER JOIN", "LEFT OUTER JOIN", "CROSS JOIN", "JOIN", "ON CONFLICT", "WINDOW",
];
const KW_UPPER = new Set(
  "select from where group by order having limit offset union all except intersect values set returning left right inner outer full cross join on and or not in is null as distinct case when then else end insert into update delete create table alter drop index view with asc desc like ilike between exists default primary key references foreign unique check constraint returning conflict do nothing true false cast over partition by begin commit rollback grant revoke truncate if replace function procedure trigger language returns".split(
    " ",
  ),
);

/** Lightweight, token-aware SQL formatter: uppercases keywords and breaks main clauses. */
export function formatSql(src: string): string {
  const tokens = src.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\$\w*\$[\s\S]*?\$\w*\$|--[^\n]*|\/\*[\s\S]*?\*\/|\w+|\s+|./g) ?? [];
  let out = "";
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i];
    if (/^\s+$/.test(tok)) {
      if (!out.endsWith(" ") && !out.endsWith("\n")) out += " ";
      continue;
    }
    if (/^\w+$/.test(tok) && KW_UPPER.has(tok.toLowerCase())) tok = tok.toUpperCase();
    const upcoming = (tok + " " + (tokens.slice(i + 1, i + 6).join("").trim())).toUpperCase();
    const brk = KW_BREAK.find((k) => upcoming.startsWith(k + " ") || upcoming === k);
    if (brk && depth === 0 && out.trim() !== "") {
      out = out.trimEnd() + "\n";
    } else if ((tok === "AND" || tok === "OR") && depth === 0) {
      out = out.trimEnd() + "\n  ";
    }
    if (tok === "(") depth++;
    if (tok === ")") depth = Math.max(0, depth - 1);
    if (tok === ";") {
      out = out.trimEnd() + ";\n\n";
      continue;
    }
    if (tok === "," && depth === 0) {
      out = out.trimEnd() + ",\n       ";
      continue;
    }
    out += tok;
  }
  return out.replace(/[ \t]+\n/g, "\n").trim() + "\n";
}
