// "Structure" tool window and helpers to get a file's symbols (LSP documentSymbol, syntax fallback).
import { h } from "../util";
import { icon } from "../icons";
import { P } from "./host";
import type { Workbench } from "./workbench";

export interface Sym {
  name: string;
  detail?: string;
  kind: number;
  line: number;
  col: number;
  children: Sym[];
}

// LSP SymbolKind -> expui node icon
const KIND_ICON: Record<number, string> = {
  2: "nodes/module", 3: "nodes/package", 4: "nodes/package", 5: "nodes/class", 6: "nodes/method", 7: "nodes/property", 8: "nodes/field",
  9: "nodes/method", 10: "nodes/enum", 11: "nodes/interface", 12: "nodes/function", 13: "nodes/variable", 14: "nodes/constant",
  22: "nodes/enum", 23: "nodes/record", 26: "nodes/type",
};
export const symIcon = (k: number) => KIND_ICON[k] ?? "nodes/unknown";

export async function documentSymbols(wb: Workbench, path: string): Promise<Sym[]> {
  const ed = wb.editors.get(path);
  if (!ed?.lspLang) return fallbackSymbols(ed?.view.state.doc.toString() ?? "", P.ext(path));
  const res = await wb.lsp.request<any[]>(ed.lspLang, "textDocument/documentSymbol", { textDocument: { uri: P.uri(path) } });
  if (!res) return fallbackSymbols(ed.view.state.doc.toString(), P.ext(path));
  const conv = (s: any): Sym => {
    const r = s.selectionRange ?? s.range ?? s.location?.range;
    return { name: s.name, detail: s.detail, kind: s.kind, line: r.start.line + 1, col: r.start.character + 1, children: (s.children ?? []).map(conv) };
  };
  return res.map(conv);
}

function fallbackSymbols(text: string, ext: string): Sym[] {
  const out: Sym[] = [];
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    let m: RegExpExecArray | null;
    if (ext === "py") {
      if ((m = /^(\s*)class\s+(\w+)/.exec(l))) out.push({ name: m[2], kind: 5, line: i + 1, col: m[1].length + 1, children: [] });
      else if ((m = /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(l))) out.push({ name: m[2], kind: m[1] ? 6 : 12, line: i + 1, col: m[1].length + 1, children: [] });
    } else if (ext === "go") {
      if ((m = /^func\s+(?:\([^)]*\)\s*)?(\w+)/.exec(l))) out.push({ name: m[1], kind: 12, line: i + 1, col: 1, children: [] });
      else if ((m = /^type\s+(\w+)\s+(struct|interface)/.exec(l))) out.push({ name: m[1], kind: m[2] === "struct" ? 23 : 11, line: i + 1, col: 1, children: [] });
    }
  });
  return out;
}

export class Structure {
  private body = h("div.tree", { tabIndex: 0 });
  private timer: number | undefined;
  constructor(private wb: Workbench) {
    wb.register({ id: "structure", title: "Estrutura", icon: "structure", anchor: "left", shortcut: "Alt+7", body: h("div.tw-body", null, this.body), onShow: () => this.refresh() });
  }

  refresh() {
    if (!this.wb.isVisible("structure")) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.render(), 300);
  }

  private async render() {
    const ed = this.wb.editors.active();
    if (!ed) {
      this.body.replaceChildren(h("div.empty-note", null, "Nenhum arquivo aberto"));
      return;
    }
    const syms = await documentSymbols(this.wb, ed.path);
    const rows: HTMLElement[] = [];
    const walk = (s: Sym, depth: number) => {
      const row = h("div.tree-row", { style: `padding-left:${10 + depth * 18}px` }, h("span.twisty"), icon(symIcon(s.kind)), h("span.tree-label", null, s.name), s.detail ? h("span.tree-detail", null, s.detail) : null);
      row.addEventListener("click", () => ed.reveal(s.line, s.col));
      rows.push(row);
      s.children.forEach((c) => walk(c, depth + 1));
    };
    syms.forEach((s) => walk(s, 0));
    if (!rows.length) rows.push(h("div.empty-note", null, "Sem símbolos"));
    this.body.replaceChildren(...rows);
  }
}
