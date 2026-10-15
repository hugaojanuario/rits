// Code completion, JetBrains-style: popup while typing, server relevance order, kind icons,
// type on the right, documentation beside the list, auto-import edits applied on accept
// (completionItem/resolve), snippets, and buffer words when there is no language server.
// Settings live in localStorage ("completion") and are applied live to open editors.
import {
  autocompletion,
  completeAnyWord,
  completeFromList,
  insertCompletionText,
  pickedCompletion,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { LSPPlugin, serverCompletionSource } from "@codemirror/lsp-client";

export interface CompletionSettings {
  /** Popup appears while typing (off: only Ctrl+Space). */
  auto: boolean;
  /** Documentation panel beside the list. */
  docs: boolean;
  /** Tab also accepts the selected item (like Enter). */
  tabAccepts: boolean;
  /** Words from the open file when there is no language server. */
  words: boolean;
  /** Delay before the popup, in ms. */
  delay: number;
}

const DEFAULTS: CompletionSettings = { auto: true, docs: true, tabAccepts: true, words: true, delay: 60 };
const KEY = "completion";

export function completionSettings(): CompletionSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setCompletionSettings(s: Partial<CompletionSettings>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...completionSettings(), ...s }));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("rits-completion"));
}

// LSP CompletionItemKind → CodeMirror type (drives the icon).
const KIND: Record<number, string> = {
  1: "text", 2: "method", 3: "function", 4: "constructor", 5: "field", 6: "variable", 7: "class", 8: "interface", 9: "module",
  10: "property", 11: "unit", 12: "value", 13: "enum", 14: "keyword", 15: "snippet", 16: "color", 17: "file", 18: "reference",
  19: "folder", 20: "enummember", 21: "constant", 22: "struct", 23: "event", 24: "operator", 25: "typeparameter",
};

/** LSP snippet syntax ($1, ${1:x}) → CodeMirror snippet syntax (${}, ${x}). */
function lspToSnippet(text: string) {
  return text.replace(/\\([$}\\])|\$(\d+)/g, (_m, esc, field) => esc || `\${${field}}`);
}

interface LspItem {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: { newText: string; range?: unknown; insert?: unknown };
  textEditText?: string;
  additionalTextEdits?: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[];
  tags?: number[];
  deprecated?: boolean;
  data?: unknown;
}

function posOf(view: EditorView, p: { line: number; character: number }) {
  const doc = view.state.doc;
  const line = doc.line(Math.min(p.line + 1, doc.lines));
  return Math.min(line.from + p.character, line.to);
}

async function resolve(plugin: LSPPlugin, item: LspItem): Promise<LspItem> {
  const caps = plugin.client.serverCapabilities?.completionProvider as { resolveProvider?: boolean } | undefined;
  if (!caps?.resolveProvider) return item;
  try {
    return { ...item, ...((await plugin.client.request<LspItem, LspItem>("completionItem/resolve", item)) ?? {}) };
  } catch {
    return item;
  }
}

/** Language server completions with resolve (docs + auto-import) and the server's relevance order. */
const lspSource: CompletionSource = async (context: CompletionContext) => {
  const plugin = context.view && LSPPlugin.get(context.view);
  if (!plugin) return null;
  const caps = plugin.client.serverCapabilities?.completionProvider as { triggerCharacters?: string[] } | undefined;
  if (!caps) return null;
  const ch = context.state.sliceDoc(context.pos - 1, context.pos);
  const word = context.matchBefore(/[\w$]+$/);
  const isTrigger = !!caps.triggerCharacters?.includes(ch);
  if (!context.explicit && !isTrigger && !word) return null;
  plugin.client.sync();
  let resp: { items: LspItem[]; isIncomplete?: boolean } | LspItem[] | null = null;
  try {
    resp = await plugin.client.request("textDocument/completion", {
      textDocument: { uri: plugin.uri },
      position: plugin.toPosition(context.pos),
      context: isTrigger && !word ? { triggerKind: 2, triggerCharacter: ch } : { triggerKind: 1 },
    });
  } catch {
    return null;
  }
  if (context.aborted || !resp) return null;
  const items = Array.isArray(resp) ? resp : resp.items;
  const incomplete = !Array.isArray(resp) && !!resp.isIncomplete;
  if (!items.length) return null;
  const view = context.view!;
  let from = word ? word.from : context.pos;
  // Ranges from the server (textEdit.range or insert) may start before the word (e.g. "@decorator", "$var").
  type Rng = { start: { line: number; character: number } };
  const rangeOf = (i: LspItem) => (i.textEdit as { range?: Rng; insert?: Rng } | undefined)?.range ?? (i.textEdit as { insert?: Rng } | undefined)?.insert;
  const r0 = items.map(rangeOf).find(Boolean);
  if (r0) from = Math.min(from, posOf(view, r0.start));
  const settings = completionSettings();
  const order = items.map((it, i) => ({ k: it.sortText ?? it.label, i })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i));
  const rank = new Map(order.map((x, r) => [x.i, r]));
  const n = Math.max(1, items.length);
  const options = items.map((it, i): Completion => {
    const text = it.textEdit?.newText ?? it.textEditText ?? it.insertText ?? it.label;
    const detail = [it.labelDetails?.detail, it.labelDetails?.description ?? it.detail].filter(Boolean).join("  ");
    const deprecated = it.deprecated || it.tags?.includes(1);
    return {
      label: it.filterText || it.label,
      displayLabel: it.label,
      type: (it.kind && KIND[it.kind]) || "text",
      detail: detail ? detail.slice(0, 80) : undefined,
      // Server relevance (sortText) first; CodeMirror's fuzzy score refines it. Deprecated items sink.
      boost: Math.round(40 - (rank.get(i)! / n) * 80) - (deprecated ? 50 : 0),
      info: settings.docs
        ? async () => {
            const full = await resolve(plugin, it);
            const parts: string[] = [];
            if (full.detail) parts.push(`<pre class="cm-doc-sig">${esc(full.detail)}</pre>`);
            if (full.documentation) parts.push(plugin.docToHTML(full.documentation as never));
            if (!parts.length) return null;
            const el = document.createElement("div");
            el.className = "cm-lsp-doc";
            el.innerHTML = parts.join("");
            return el;
          }
        : undefined,
      apply: async (v: EditorView, completion: Completion, f: number, t: number) => {
        // Auto-import and other edits often arrive only in completionItem/resolve.
        const full = it.additionalTextEdits ? it : await resolve(plugin, it);
        const extra = (full.additionalTextEdits ?? [])
          .map((e) => ({ from: posOf(v, e.range.start), to: posOf(v, e.range.end), insert: e.newText }))
          .filter((e) => e.to <= f || e.from >= t);
        if (it.insertTextFormat === 2) snippet(lspToSnippet(text))(v, completion, f, t);
        else v.dispatch({ ...insertCompletionText(v.state, text, f, t), annotations: pickedCompletion.of(completion) });
        // Imports go above the insertion point, so their positions are still valid.
        if (extra.length) v.dispatch({ changes: extra });
      },
    };
  });
  return { from, options, validFor: incomplete ? undefined : /^[\w$]*$/ };
};

/** One source: the language server when attached; otherwise language completions + buffer words. */
const combined: CompletionSource = async (context) => {
  const view = context.view;
  if (view && LSPPlugin.get(view)?.client.serverCapabilities?.completionProvider) return lspSource(context);
  const settings = completionSettings();
  const results: CompletionResult[] = [];
  for (const src of context.state.languageDataAt<CompletionSource | readonly (string | Completion)[]>("autocomplete", context.pos)) {
    if (src === serverCompletionSource) continue;
    const fn = typeof src === "function" ? src : completeFromList(src as (string | Completion)[]);
    const r = await fn(context);
    if (r) results.push(r);
  }
  if (settings.words) {
    const w = await completeAnyWord(context);
    if (w) results.push({ ...w, options: w.options.map((o) => ({ ...o, boost: -20 })) });
  }
  if (!results.length) return null;
  if (results.length === 1) return results[0];
  // Merge: same range required; keep the widest "from" common to all.
  const from = Math.max(...results.map((r) => r.from));
  const seen = new Set<string>();
  const options: Completion[] = [];
  for (const r of results) {
    if (r.from !== from) continue;
    for (const o of r.options) {
      if (seen.has(o.label)) continue;
      seen.add(o.label);
      options.push(o);
    }
  }
  return { from, options, validFor: /^[\w$]*$/ };
};

export const completionComp = new Compartment();

export function completionExtension(): Extension {
  const s = completionSettings();
  return autocompletion({
    override: [combined],
    activateOnTyping: s.auto,
    activateOnTypingDelay: s.delay,
    maxRenderedOptions: 150,
    icons: true,
    closeOnBlur: true,
    selectOnOpen: true,
    tooltipClass: () => "rits-completion",
    optionClass: (c) => (c.type ? `rc-${c.type}` : ""),
  });
}

/** Tab accepts like Enter (JetBrains default), when enabled. */
export function tabAccepts() {
  return completionSettings().tabAccepts;
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
