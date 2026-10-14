// Virtualized, editable data grid.
import { h, copyText, isNumericLike } from "./util";
import { contextMenu, textViewer, type MenuItem } from "./ui";

const ROW_H = 24;
const OVERSCAN = 10;

export type Cell = string | null;

export interface GridChangeSet {
  updated: Map<number, Map<number, Cell>>; // row index -> col -> new value
  inserted: Set<number>;
  deleted: Set<number>;
}

export interface GridOptions {
  editable?: boolean;
  /** Called when the user clicks a header. Return true if handled (server sort). */
  onSort?: (col: number, dir: "asc" | "desc" | null) => boolean;
  onChange?: () => void;
  onFilterByValue?: (col: number, value: Cell) => void;
  extraMenu?: (row: number, col: number) => MenuItem[];
  copyAsInsert?: (rows: number[]) => string;
}

export class DataGrid {
  el: HTMLElement;
  columns: string[] = [];
  rows: Cell[][] = [];
  original: Cell[][] = [];
  widths: number[] = [];
  changes: GridChangeSet = { updated: new Map(), inserted: new Set(), deleted: new Set() };
  private view: number[] = []; // display order -> row index
  private sortCol = -1;
  private sortDir: "asc" | "desc" | null = null;
  private sel = { r1: 0, c1: 0, r2: 0, c2: 0 };
  private anchor = { r: 0, c: 0 };
  private header: HTMLElement;
  private body: HTMLElement;
  private sizer: HTMLElement;
  private editing: HTMLInputElement | null = null;
  private numeric: boolean[] = [];

  constructor(private opts: GridOptions = {}) {
    this.header = h("div.grid-header");
    this.body = h("div.grid-rows");
    this.sizer = h("div.grid-sizer", null, this.body);
    this.el = h("div.grid", { tabIndex: 0 }, this.header, this.sizer);
    this.el.addEventListener("scroll", () => this.renderRows());
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    new ResizeObserver(() => this.renderRows()).observe(this.el);
  }

  setData(columns: string[], rows: Cell[][], keepSort = false) {
    this.columns = columns;
    this.rows = rows.map((r) => [...r]);
    this.original = rows;
    this.changes = { updated: new Map(), inserted: new Set(), deleted: new Set() };
    this.numeric = columns.map((_, c) => {
      let seen = 0;
      for (const r of rows) {
        const v = r[c];
        if (v === null || v === "") continue;
        if (!isNumericLike(v)) return false;
        if (++seen > 30) break;
      }
      return seen > 0;
    });
    this.widths = columns.map((name, c) => {
      let w = name.length * 8 + 36;
      for (let i = 0; i < Math.min(rows.length, 60); i++) {
        const v = rows[i][c];
        w = Math.max(w, Math.min(360, (v === null ? 6 : v.length) * 7.2 + 20));
      }
      return Math.round(Math.min(Math.max(w, 64), 380));
    });
    if (!keepSort) {
      this.sortCol = -1;
      this.sortDir = null;
    }
    this.sel = { r1: 0, c1: 0, r2: 0, c2: 0 };
    this.rebuildView();
    this.renderHeader();
    this.renderRows();
  }

  setSortIndicator(col: number, dir: "asc" | "desc" | null) {
    this.sortCol = col;
    this.sortDir = dir;
    this.renderHeader();
  }

  get rowCount() {
    return this.rows.length;
  }

  get dirty() {
    return this.changes.updated.size + this.changes.inserted.size + this.changes.deleted.size;
  }

  private rebuildView() {
    this.view = this.rows.map((_, i) => i);
    if (this.sortCol >= 0 && this.sortDir && !this.opts.onSort) {
      const c = this.sortCol;
      const num = this.numeric[c];
      const dir = this.sortDir === "asc" ? 1 : -1;
      this.view.sort((a, b) => {
        const x = this.rows[a][c];
        const y = this.rows[b][c];
        if (x === y) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        return (num ? Number(x) - Number(y) : x.localeCompare(y, undefined, { numeric: true })) * dir;
      });
    }
  }

  private template() {
    return `48px ${this.widths.map((w) => w + "px").join(" ")}`;
  }

  private renderHeader() {
    this.header.style.gridTemplateColumns = this.template();
    this.header.replaceChildren(
      h("div.gh.gutter", {
        title: "Selecionar tudo",
        onclick: () => this.selectAll(),
      }),
      ...this.columns.map((name, c) => {
        const arrow = this.sortCol === c && this.sortDir ? (this.sortDir === "asc" ? " ▲" : " ▼") : "";
        const resizer = h("div.col-resize");
        resizer.addEventListener("mousedown", (e) => this.startResize(e, c));
        resizer.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          this.widths[c] = Math.max(this.widths[c], 280);
          this.renderHeader();
          this.renderRows();
        });
        const cell = h(
          "div.gh",
          { class: this.numeric[c] ? "num" : "", title: name },
          h("span.gh-name", null, name),
          h("span.gh-sort", null, arrow),
          resizer,
        );
        cell.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).classList.contains("col-resize")) return;
          this.toggleSort(c);
        });
        return cell;
      }),
    );
    const total = 48 + this.widths.reduce((a, b) => a + b, 0);
    this.header.style.width = total + "px";
    this.sizer.style.width = total + "px";
  }

  private toggleSort(c: number) {
    let dir: "asc" | "desc" | null = "asc";
    if (this.sortCol === c) dir = this.sortDir === "asc" ? "desc" : this.sortDir === "desc" ? null : "asc";
    this.sortCol = dir ? c : -1;
    this.sortDir = dir;
    if (this.opts.onSort?.(c, dir)) {
      this.renderHeader();
      return;
    }
    this.rebuildView();
    this.renderHeader();
    this.renderRows();
  }

  private startResize(e: MouseEvent, c: number) {
    e.preventDefault();
    e.stopPropagation();
    const start = e.clientX;
    const w0 = this.widths[c];
    const move = (ev: MouseEvent) => {
      this.widths[c] = Math.max(40, w0 + ev.clientX - start);
      this.renderHeader();
      this.renderRows();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  renderRows() {
    const n = this.view.length;
    this.sizer.style.height = n * ROW_H + "px";
    const top = this.el.scrollTop;
    const height = this.el.clientHeight || 400;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(n, Math.ceil((top + height) / ROW_H) + OVERSCAN);
    this.body.style.transform = `translateY(${first * ROW_H}px)`;
    const tpl = this.template();
    const { r1, r2, c1, c2 } = this.normSel();
    const frag = document.createDocumentFragment();
    for (let vi = first; vi < last; vi++) {
      const ri = this.view[vi];
      const row = this.rows[ri];
      const upd = this.changes.updated.get(ri);
      const cls = this.changes.deleted.has(ri) ? "deleted" : this.changes.inserted.has(ri) ? "inserted" : "";
      const rowEl = h("div.gr", { class: cls, style: `grid-template-columns:${tpl}` });
      const gutter = h("div.gc.gutter", { class: vi >= r1 && vi <= r2 ? "sel-row" : "" }, String(vi + 1));
      gutter.addEventListener("mousedown", (e) => {
        this.selectRange(vi, 0, e.shiftKey);
        this.sel.c1 = 0;
        this.sel.c2 = this.columns.length - 1;
        this.renderRows();
      });
      rowEl.append(gutter);
      for (let c = 0; c < this.columns.length; c++) {
        const v = row[c];
        const selected = vi >= r1 && vi <= r2 && c >= c1 && c <= c2;
        const classes = [
          v === null ? "null" : "",
          this.numeric[c] ? "num" : "",
          upd?.has(c) ? "modified" : "",
          selected ? "sel" : "",
          selected && vi === this.anchorView() && c === this.anchor.c ? "focus" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const text = v === null ? "<null>" : v.length > 500 ? v.slice(0, 500) + "…" : v;
        const cell = h("div.gc", { class: classes }, text.replace(/\n/g, "↵"));
        cell.addEventListener("mousedown", (e) => {
          if (e.button === 2 && selected) return;
          this.selectRange(vi, c, e.shiftKey);
          this.renderRows();
        });
        cell.addEventListener("dblclick", () => this.beginEdit(vi, c));
        cell.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.showMenu(e.clientX, e.clientY, vi, c);
        });
        rowEl.append(cell);
      }
      frag.append(rowEl);
    }
    this.body.replaceChildren(frag);
  }

  private anchorView() {
    return this.view.indexOf(this.anchor.r);
  }

  private normSel() {
    const s = this.sel;
    return {
      r1: Math.min(s.r1, s.r2),
      r2: Math.max(s.r1, s.r2),
      c1: Math.min(s.c1, s.c2),
      c2: Math.max(s.c1, s.c2),
    };
  }

  private selectRange(vi: number, c: number, extend: boolean) {
    this.el.focus({ preventScroll: true });
    if (extend) {
      this.sel.r2 = vi;
      this.sel.c2 = c;
    } else {
      this.sel = { r1: vi, c1: c, r2: vi, c2: c };
      this.anchor = { r: this.view[vi], c };
    }
  }

  selectAll() {
    this.sel = { r1: 0, c1: 0, r2: this.view.length - 1, c2: this.columns.length - 1 };
    this.renderRows();
  }

  /** Row indexes (into rows[]) covered by the selection. */
  selectedRows(): number[] {
    const { r1, r2 } = this.normSel();
    const out: number[] = [];
    for (let v = r1; v <= r2 && v < this.view.length; v++) out.push(this.view[v]);
    return out;
  }

  private selectedText(withHeader = false) {
    const { r1, r2, c1, c2 } = this.normSel();
    const lines: string[] = [];
    if (withHeader) lines.push(this.columns.slice(c1, c2 + 1).join("\t"));
    for (let v = r1; v <= r2 && v < this.view.length; v++) {
      const row = this.rows[this.view[v]];
      lines.push(row.slice(c1, c2 + 1).map((x) => (x === null ? "" : x)).join("\t"));
    }
    return lines.join("\n");
  }

  private ensureVisible(vi: number) {
    const top = vi * ROW_H;
    const headerH = 26;
    if (top < this.el.scrollTop) this.el.scrollTop = top;
    else if (top + ROW_H > this.el.scrollTop + this.el.clientHeight - headerH)
      this.el.scrollTop = top + ROW_H - this.el.clientHeight + headerH;
  }

  private onKey(e: KeyboardEvent) {
    if (this.editing) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const maxR = this.view.length - 1;
    const maxC = this.columns.length - 1;
    let { r2, c2 } = this.sel;
    const move = (r: number, c: number) => {
      r = Math.max(0, Math.min(maxR, r));
      c = Math.max(0, Math.min(maxC, c));
      if (e.shiftKey) {
        this.sel.r2 = r;
        this.sel.c2 = c;
      } else {
        this.sel = { r1: r, c1: c, r2: r, c2: c };
        this.anchor = { r: this.view[r], c };
      }
      this.ensureVisible(r);
      this.renderRows();
      e.preventDefault();
    };
    if (ctrl && e.key.toLowerCase() === "c") {
      copyText(this.selectedText(e.shiftKey));
      e.preventDefault();
    } else if (ctrl && e.key.toLowerCase() === "a") {
      this.selectAll();
      e.preventDefault();
    } else if (e.key === "ArrowDown") move(r2 + 1, c2);
    else if (e.key === "ArrowUp") move(r2 - 1, c2);
    else if (e.key === "ArrowLeft") move(r2, c2 - 1);
    else if (e.key === "ArrowRight") move(r2, c2 + 1);
    else if (e.key === "Tab") move(r2, c2 + (e.shiftKey ? -1 : 1));
    else if (e.key === "PageDown") move(r2 + Math.floor(this.el.clientHeight / ROW_H), c2);
    else if (e.key === "PageUp") move(r2 - Math.floor(this.el.clientHeight / ROW_H), c2);
    else if (e.key === "Home" && ctrl) move(0, c2);
    else if (e.key === "End" && ctrl) move(maxR, c2);
    else if ((e.key === "Enter" || e.key === "F2") && !e.shiftKey) {
      this.beginEdit(r2, c2);
      e.preventDefault();
    } else if (e.key === "Enter" && e.shiftKey) {
      const v = this.rows[this.view[r2]]?.[c2];
      textViewer(this.columns[c2], v ?? "NULL");
      e.preventDefault();
    } else if (e.key === "Delete" && this.opts.editable && !ctrl) {
      this.deleteSelectedRows();
      e.preventDefault();
    }
  }

  beginEdit(vi: number, c: number) {
    if (!this.opts.editable || vi < 0 || vi >= this.view.length) return;
    const ri = this.view[vi];
    if (this.changes.deleted.has(ri)) return;
    this.ensureVisible(vi);
    this.renderRows();
    const rowEl = this.body.children[vi - Math.max(0, Math.floor(this.el.scrollTop / ROW_H) - OVERSCAN)] as HTMLElement;
    const cellEl = rowEl?.children[c + 1] as HTMLElement;
    if (!cellEl) return;
    const cur = this.rows[ri][c];
    const input = h("input.cell-editor", { value: cur ?? "", spellcheck: false }) as HTMLInputElement;
    if (cur === null) input.placeholder = "<null>";
    cellEl.replaceChildren(input);
    cellEl.classList.add("editing");
    this.editing = input;
    input.focus();
    input.select();
    let finished = false;
    const finish = (commit: boolean, nullify = false) => {
      if (finished) return;
      finished = true;
      this.editing = null;
      if (commit) this.setCell(ri, c, nullify ? null : input.value === "" && cur === null ? null : input.value);
      this.renderRows();
      this.el.focus({ preventScroll: true });
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
      else if (e.key === "Tab") {
        e.preventDefault();
        finish(true);
        this.sel = { r1: vi, r2: vi, c1: c + 1, c2: c + 1 };
        this.beginEdit(vi, Math.min(c + 1, this.columns.length - 1));
      } else if (e.key === "Delete" && e.ctrlKey) finish(true, true);
    });
    input.addEventListener("blur", () => finish(true));
  }

  setCell(ri: number, c: number, v: Cell) {
    if (this.rows[ri][c] === v) return;
    this.rows[ri][c] = v;
    if (!this.changes.inserted.has(ri)) {
      const orig = this.original[ri]?.[c];
      let m = this.changes.updated.get(ri);
      if (orig === v) {
        m?.delete(c);
        if (m && m.size === 0) this.changes.updated.delete(ri);
      } else {
        if (!m) this.changes.updated.set(ri, (m = new Map()));
        m.set(c, v);
      }
    }
    this.opts.onChange?.();
  }

  addRow() {
    const ri = this.rows.length;
    this.rows.push(this.columns.map(() => null));
    this.changes.inserted.add(ri);
    this.view.push(ri);
    const vi = this.view.length - 1;
    this.sel = { r1: vi, r2: vi, c1: 0, c2: 0 };
    this.anchor = { r: ri, c: 0 };
    this.renderRows();
    this.ensureVisible(vi);
    this.opts.onChange?.();
    setTimeout(() => this.beginEdit(vi, 0));
  }

  deleteSelectedRows() {
    for (const ri of this.selectedRows()) {
      if (this.changes.inserted.has(ri)) {
        this.changes.inserted.delete(ri);
        this.view = this.view.filter((x) => x !== ri);
      } else if (this.changes.deleted.has(ri)) this.changes.deleted.delete(ri);
      else this.changes.deleted.add(ri);
    }
    this.renderRows();
    this.opts.onChange?.();
  }

  revert() {
    this.setData(this.columns, this.original, true);
    this.opts.onChange?.();
  }

  private showMenu(x: number, y: number, vi: number, c: number) {
    const ri = this.view[vi];
    const value = this.rows[ri][c];
    const items: MenuItem[] = [
      { label: "Copiar", icon: "copy", shortcut: "Ctrl+C", action: () => copyText(this.selectedText()) },
      { label: "Copiar com cabeçalho", shortcut: "Ctrl+Shift+C", action: () => copyText(this.selectedText(true)) },
      {
        label: "Copiar como",
        submenu: [
          {
            label: "JSON",
            action: () => {
              const rows = this.selectedRows().map((r) =>
                Object.fromEntries(this.columns.map((col, i) => [col, this.rows[r][i]])),
              );
              copyText(JSON.stringify(rows, null, 2));
            },
          },
          {
            label: "CSV",
            action: () => {
              const esc = (v: Cell) => (v === null ? "" : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
              copyText(
                [this.columns.join(","), ...this.selectedRows().map((r) => this.rows[r].map(esc).join(","))].join("\n"),
              );
            },
          },
          ...(this.opts.copyAsInsert
            ? [{ label: "SQL INSERT", action: () => copyText(this.opts.copyAsInsert!(this.selectedRows())) }]
            : []),
          {
            label: "Markdown",
            action: () => {
              const rows = this.selectedRows();
              const md = [
                `| ${this.columns.join(" | ")} |`,
                `| ${this.columns.map(() => "---").join(" | ")} |`,
                ...rows.map((r) => `| ${this.rows[r].map((v) => (v ?? "NULL").replace(/\|/g, "\\|")).join(" | ")} |`),
              ];
              copyText(md.join("\n"));
            },
          },
        ],
      },
      { label: "Ver valor", icon: "value", shortcut: "Shift+Enter", action: () => textViewer(this.columns[c], value ?? "NULL") },
    ];
    if (this.opts.onFilterByValue) {
      items.push({ separator: true }, { label: "Filtrar por este valor", icon: "filter", action: () => this.opts.onFilterByValue!(c, value) });
    }
    if (this.opts.editable) {
      items.push(
        { separator: true },
        { label: "Editar célula", icon: "edit", shortcut: "F2", action: () => this.beginEdit(vi, c) },
        { label: "Definir NULL", action: () => {
          this.setCell(ri, c, null);
          this.renderRows();
        } },
        { label: "Adicionar linha", icon: "plus", action: () => this.addRow() },
        { label: "Excluir linha(s)", icon: "trash", danger: true, shortcut: "Delete", action: () => this.deleteSelectedRows() },
      );
    }
    if (this.opts.extraMenu) items.push(...this.opts.extraMenu(ri, c));
    contextMenu(x, y, items);
  }
}
