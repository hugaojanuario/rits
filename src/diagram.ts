// ER diagram tab: tables of a schema as cards, foreign keys as curved crow's-foot links.
// Infinite canvas (wheel = pan, Ctrl/⌘ + wheel or pinch = zoom), draggable cards, automatic
// layered layout, minimap, search and SVG / Mermaid export. Positions are kept per schema.
import { save } from "@tauri-apps/plugin-dialog";
import { api, type ConnConfig, type DiagramInfo, type DiagramTable, type ForeignKey } from "./api";
import { icon } from "./icons";
import type { Tab } from "./tabs";
import { toast } from "./ui";
import { h } from "./util";

interface Pos {
  x: number;
  y: number;
}
interface Card {
  t: DiagramTable;
  el: HTMLElement;
  pos: Pos;
  w: number;
  h: number;
  color: number;
  rows: Map<string, HTMLElement>;
}

const HEADER_H = 40;
const COLORS = 8;

function hash(s: string) {
  let x = 0;
  for (const ch of s) x = (x * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(x);
}

function storageKey(connId: string, db: string, schema: string) {
  return `diagram:${connId}:${db}:${schema}`;
}

function loadSaved(key: string): { pos: Record<string, Pos>; keysOnly?: boolean; types?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    return { pos: {} };
  }
}

export function createDiagramTab(conn: ConnConfig, db: string, schema: string, opts: { focus?: string; openTable?: (name: string, kind: string) => void } = {}): Tab {
  const key = storageKey(conn.id, db, schema);
  const saved = loadSaved(key);
  saved.pos ??= {};
  let keysOnly = saved.keysOnly ?? false;
  let showTypes = saved.types ?? true;
  let info: DiagramInfo = { tables: [], fks: [] };
  const cards = new Map<string, Card>();
  let view = { x: 40, y: 40, k: 1 };
  let hoverTable: string | null = null;
  let selected: string | null = opts.focus ?? null;

  const world = h("div.dg-world");
  const edges = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  edges.classList.add("dg-edges");
  world.append(edges);
  const canvas = h("div.dg-canvas", { tabIndex: 0 }, world);
  const minimap = h("div.dg-minimap");
  const zoomLabel = h("span.dg-zoom", null, "100%");
  const search = h("input.dg-search", { placeholder: "Buscar tabela…", spellcheck: false }) as HTMLInputElement;
  const status = h("div.dg-status");
  const tbBtn = (title: string, ic: string, fn: () => void, extra = "") => h("button.dg-btn", { class: extra, title, onclick: fn }, icon(ic));
  const keysBtn = tbBtn("Somente chaves (PK/FK)", "key", () => ((keysOnly = !keysOnly), persist(), build()), keysOnly ? "on" : "");
  const typesBtn = tbBtn("Mostrar tipos", "column", () => ((showTypes = !showTypes), persist(), build()), showTypes ? "on" : "");
  const toolbar = h(
    "div.dg-toolbar",
    null,
    h("span.dg-title", null, icon("diagram"), h("b", null, schema), h("span.dim", null, conn.name)),
    h("span.dg-sep"),
    tbBtn("Diminuir zoom", "general/remove", () => zoomAt(0.8)),
    zoomLabel,
    tbBtn("Aumentar zoom", "general/add", () => zoomAt(1.25)),
    tbBtn("Ajustar à tela", "general/expandAll", () => fit()),
    h("span.dg-sep"),
    tbBtn("Organizar automaticamente", "general/layout", () => (autoLayout(true), fit())),
    keysBtn,
    typesBtn,
    h("span.dg-sep"),
    h("label.dg-search-wrap", null, icon("search"), search),
    h("span.dg-sep"),
    tbBtn("Exportar SVG", "export", () => exportSvg()),
    tbBtn("Copiar como Mermaid (erDiagram)", "general/copy", () => copyMermaid()),
    tbBtn("Atualizar", "refresh", () => load()),
  );
  const dg = h("div.dg", null, canvas, toolbar, minimap, status);
  // The tab root gets the absolute "tab-pane" class; .dg (position: relative) must not be that root.
  const el = h("div", null, dg);

  // ---------------- data ----------------

  // Cards are measured after rendering, so a tab restored in the background builds on first activation.
  let pendingBuild = false;

  async function load() {
    status.textContent = "Lendo o schema…";
    status.classList.remove("hidden");
    try {
      info = await api.diagram(conn.id, db, schema);
      status.classList.add("hidden");
      if (!el.isConnected || !el.offsetWidth) {
        pendingBuild = true;
        return;
      }
      build();
      if (!Object.keys(saved.pos).length || info.tables.some((t) => !saved.pos[t.name])) autoLayout(false);
      requestAnimationFrame(() => (opts.focus ? focusTable(opts.focus) : fit()));
    } catch (e) {
      status.textContent = String(e);
      status.classList.add("err");
    }
  }

  const fkCols = () => {
    const set = new Set<string>();
    for (const f of info.fks) for (const c of f.columns) set.add(`${f.table}.${c}`);
    return set;
  };

  function build() {
    keysBtn.classList.toggle("on", keysOnly);
    typesBtn.classList.toggle("on", showTypes);
    world.querySelectorAll(".dg-card").forEach((c) => c.remove());
    cards.clear();
    const fk = fkCols();
    const refd = new Set(info.fks.flatMap((f) => f.refColumns.map((c) => `${f.refTable}.${c}`)));
    for (const t of info.tables) {
      const color = hash(t.name) % COLORS;
      const rows = new Map<string, HTMLElement>();
      const cols = t.columns.filter((c) => !keysOnly || c.pk || fk.has(`${t.name}.${c.name}`) || refd.has(`${t.name}.${c.name}`));
      const body = h(
        "div.dg-rows",
        null,
        ...cols.map((c) => {
          const isFk = fk.has(`${t.name}.${c.name}`);
          const r = h(
            "div.dg-row",
            { class: [c.pk && "pk", isFk && "fk"].filter(Boolean).join(" "), title: [c.name, c.dataType, c.nullable ? "NULL" : "NOT NULL", c.comment].filter(Boolean).join(" · ") },
            h("span.dg-key", null, c.pk ? icon("key") : isFk ? icon("dgLink") : ""),
            h("span.dg-col", null, c.name),
            showTypes ? h("span.dg-type", null, c.dataType.replace(/character varying/, "varchar").replace(/timestamp with(out)? time zone/, (m) => (m.includes("out") ? "timestamp" : "timestamptz"))) : "",
            c.nullable ? "" : h("span.dg-nn", { title: "NOT NULL" }, "•"),
          );
          rows.set(c.name, r);
          return r;
        }),
        cols.length < t.columns.length ? h("div.dg-more", null, `+ ${t.columns.length - cols.length} colunas`) : "",
      );
      const header = h(
        "div.dg-head",
        null,
        h("span.dg-chip"),
        icon(t.kind === "table" ? "table" : "view"),
        h("span.dg-name", null, t.name),
        h("span.dg-count", null, String(t.columns.length)),
      );
      const card = h("div.dg-card", { class: `c${color} ${t.kind !== "table" ? "view" : ""}`, "data-t": t.name }, header, body);
      card.addEventListener("pointerenter", () => ((hoverTable = t.name), paintFocus()));
      card.addEventListener("pointerleave", () => ((hoverTable = null), paintFocus()));
      card.addEventListener("dblclick", () => opts.openTable?.(t.name, t.kind));
      header.addEventListener("pointerdown", (e) => dragCard(t.name, e));
      card.addEventListener("pointerdown", () => ((selected = t.name), paintFocus()));
      world.append(card);
      const p = saved.pos[t.name] ?? { x: 0, y: 0 };
      cards.set(t.name, { t, el: card, pos: { ...p }, w: 0, h: 0, color, rows });
    }
    for (const c of cards.values()) {
      c.w = c.el.offsetWidth;
      c.h = c.el.offsetHeight;
      place(c);
    }
    drawEdges();
    paintFocus();
    renderMinimap();
    if (!info.tables.length) {
      status.textContent = "Nenhuma tabela neste schema.";
      status.classList.remove("hidden", "err");
    }
  }

  const place = (c: Card) => (c.el.style.transform = `translate(${c.pos.x}px, ${c.pos.y}px)`);

  function persist() {
    const pos: Record<string, Pos> = {};
    for (const [n, c] of cards) pos[n] = { x: Math.round(c.pos.x), y: Math.round(c.pos.y) };
    saved.pos = { ...saved.pos, ...pos };
    try {
      localStorage.setItem(key, JSON.stringify({ pos: saved.pos, keysOnly, types: showTypes }));
    } catch {
      /* ignore */
    }
  }

  // ---------------- layout ----------------

  /** Layered layout: referenced (parent) tables to the left, children to the right. */
  function autoLayout(force: boolean) {
    const names = [...cards.keys()];
    const parents = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
    const children = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
    for (const f of info.fks) {
      if (!cards.has(f.refTable) || !cards.has(f.table) || f.refTable === f.table) continue;
      parents.get(f.table)!.add(f.refTable);
      children.get(f.refTable)!.add(f.table);
    }
    // longest path from roots, cycles broken by a visit guard
    const rank = new Map<string, number>();
    const visit = (n: string, stack: Set<string>): number => {
      if (rank.has(n)) return rank.get(n)!;
      if (stack.has(n)) return 0;
      stack.add(n);
      let r = 0;
      for (const p of parents.get(n)!) r = Math.max(r, visit(p, stack) + 1);
      stack.delete(n);
      rank.set(n, r);
      return r;
    };
    names.forEach((n) => visit(n, new Set()));
    const linked = names.filter((n) => parents.get(n)!.size || children.get(n)!.size);
    const isolated = names.filter((n) => !parents.get(n)!.size && !children.get(n)!.size).sort();
    const layers: string[][] = [];
    for (const n of linked) (layers[rank.get(n)!] ??= []).push(n);
    // barycenter ordering, a few sweeps
    const order = new Map<string, number>();
    layers.forEach((l) => l.sort().forEach((n, i) => order.set(n, i)));
    for (let sweep = 0; sweep < 4; sweep++) {
      for (const l of layers) {
        if (!l) continue;
        const bc = (n: string) => {
          const ns = [...parents.get(n)!, ...children.get(n)!].filter((x) => order.has(x));
          return ns.length ? ns.reduce((a, x) => a + order.get(x)!, 0) / ns.length : order.get(n)!;
        };
        l.sort((a, b) => bc(a) - bc(b));
        l.forEach((n, i) => order.set(n, i));
      }
    }
    const GAP_X = 110;
    const GAP_Y = 36;
    let x = 0;
    let maxY = 0;
    for (const l of layers) {
      if (!l) continue;
      let y = 0;
      let w = 0;
      for (const n of l) {
        const c = cards.get(n)!;
        if (force || !saved.pos[n]) c.pos = { x, y };
        y += c.h + GAP_Y;
        w = Math.max(w, c.w);
      }
      maxY = Math.max(maxY, y);
      x += w + GAP_X;
    }
    // tables without relations: a grid below (or alone when nothing is linked)
    const cols = Math.max(3, Math.ceil(Math.sqrt(isolated.length)));
    let gx = 0;
    let gy = linked.length ? maxY + 60 : 0;
    let rowH = 0;
    isolated.forEach((n, i) => {
      const c = cards.get(n)!;
      if (force || !saved.pos[n]) c.pos = { x: gx, y: gy };
      gx += c.w + 50;
      rowH = Math.max(rowH, c.h);
      if ((i + 1) % cols === 0) {
        gx = 0;
        gy += rowH + 40;
        rowH = 0;
      }
    });
    for (const c of cards.values()) place(c);
    drawEdges();
    persist();
    renderMinimap();
  }

  // ---------------- edges ----------------

  function anchor(c: Card, column: string | undefined, side: "l" | "r"): Pos {
    const row = column ? c.rows.get(column) : undefined;
    const y = row ? c.pos.y + row.offsetTop + row.offsetHeight / 2 : c.pos.y + HEADER_H / 2;
    return { x: side === "l" ? c.pos.x : c.pos.x + c.w, y };
  }

  function edgePath(f: ForeignKey) {
    const a = cards.get(f.table);
    const b = cards.get(f.refTable);
    if (!a || !b) return null;
    if (a === b) {
      const p = anchor(a, f.columns[0], "r");
      const q = anchor(a, f.refColumns[0], "r");
      return { d: `M${p.x},${p.y} C${p.x + 60},${p.y} ${q.x + 60},${q.y} ${q.x},${q.y}`, from: p, to: q, dir: 1 };
    }
    // connect the facing sides; overlapping columns route around the right side
    const aRight = a.pos.x + a.w;
    const bRight = b.pos.x + b.w;
    let sa: "l" | "r";
    let sb: "l" | "r";
    if (aRight + 30 < b.pos.x) (sa = "r"), (sb = "l");
    else if (bRight + 30 < a.pos.x) (sa = "l"), (sb = "r");
    else (sa = "r"), (sb = "r");
    const p = anchor(a, f.columns[0], sa);
    const q = anchor(b, f.refColumns[0], sb);
    const dx = Math.max(50, Math.abs(q.x - p.x) / 2);
    const c1 = p.x + (sa === "r" ? dx : -dx);
    const c2 = q.x + (sb === "r" ? dx : -dx);
    return { d: `M${p.x},${p.y} C${c1},${p.y} ${c2},${q.y} ${q.x},${q.y}`, from: p, to: q, sa, sb };
  }

  function drawEdges() {
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    for (const c of cards.values()) {
      minX = Math.min(minX, c.pos.x - 200);
      minY = Math.min(minY, c.pos.y - 200);
      maxX = Math.max(maxX, c.pos.x + c.w + 200);
      maxY = Math.max(maxY, c.pos.y + c.h + 200);
    }
    edges.setAttribute("viewBox", `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
    Object.assign(edges.style, { left: minX + "px", top: minY + "px", width: maxX - minX + "px", height: maxY - minY + "px" });
    const NS = "http://www.w3.org/2000/svg";
    const parts: string[] = [
      `<defs>
        <marker id="dg-many" viewBox="0 0 14 14" refX="1" refY="7" markerWidth="14" markerHeight="14" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
          <path d="M13 7H1M13 7L1 1M13 7L1 13" fill="none" style="stroke:var(--dg-edge)" stroke-width="1.4"/></marker>
        <marker id="dg-one" viewBox="0 0 14 14" refX="13" refY="7" markerWidth="14" markerHeight="14" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M1 7H13M8 1V13M11 1V13" fill="none" style="stroke:var(--dg-edge)" stroke-width="1.4"/></marker>
      </defs>`,
    ];
    info.fks.forEach((f, i) => {
      const e = edgePath(f);
      if (!e) return;
      const nullable = f.columns.some((c) => cards.get(f.table)?.t.columns.find((x) => x.name === c)?.nullable);
      parts.push(
        `<path class="dg-edge${nullable ? " opt" : ""}" data-i="${i}" data-a="${esc(f.table)}" data-b="${esc(f.refTable)}" d="${e.d}" marker-start="url(#dg-many)" marker-end="url(#dg-one)"><title>${esc(`${f.table}(${f.columns.join(", ")}) → ${f.refTable}(${f.refColumns.join(", ")})`)}</title></path>`,
      );
    });
    edges.innerHTML = parts.join("");
    void NS;
    paintFocus();
  }

  function paintFocus() {
    const focus = hoverTable ?? selected;
    const related = new Set<string>();
    if (focus) {
      related.add(focus);
      for (const f of info.fks) {
        if (f.table === focus) related.add(f.refTable);
        if (f.refTable === focus) related.add(f.table);
      }
    }
    const q = search.value.trim().toLowerCase();
    for (const [n, c] of cards) {
      c.el.classList.toggle("dim", (!!focus && !related.has(n)) || (!!q && !n.toLowerCase().includes(q)));
      c.el.classList.toggle("focus", n === focus);
      c.el.classList.toggle("match", !!q && n.toLowerCase().includes(q));
    }
    edges.querySelectorAll<SVGPathElement>(".dg-edge").forEach((p) => {
      const on = !!focus && (p.dataset.a === focus || p.dataset.b === focus);
      p.classList.toggle("hot", on);
      p.classList.toggle("dim", !!focus && !on);
    });
    world.querySelectorAll(".dg-row.hot").forEach((r) => r.classList.remove("hot"));
    if (!focus) return;
    for (const f of info.fks) {
      if (f.table !== focus && f.refTable !== focus) continue;
      f.columns.forEach((c) => cards.get(f.table)?.rows.get(c)?.classList.add("hot"));
      f.refColumns.forEach((c) => cards.get(f.refTable)?.rows.get(c)?.classList.add("hot"));
    }
  }

  // ---------------- interaction ----------------

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    canvas.style.backgroundSize = `${22 * view.k}px ${22 * view.k}px`;
    canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
    zoomLabel.textContent = Math.round(view.k * 100) + "%";
    renderMinimap();
  }

  function zoomAt(factor: number, cx?: number, cy?: number) {
    const r = canvas.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    const k = Math.min(2.5, Math.max(0.15, view.k * factor));
    view.x = px - ((px - view.x) * k) / view.k;
    view.y = py - ((py - view.y) * k) / view.k;
    view.k = k;
    applyView();
  }

  function bounds() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of cards.values()) {
      minX = Math.min(minX, c.pos.x);
      minY = Math.min(minY, c.pos.y);
      maxX = Math.max(maxX, c.pos.x + c.w);
      maxY = Math.max(maxY, c.pos.y + c.h);
    }
    return cards.size ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }

  function fit() {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    const b = bounds();
    const pad = 60;
    const k = Math.min(1.2, Math.max(0.15, Math.min((r.width - pad * 2) / (b.maxX - b.minX), (r.height - pad * 2 - 50) / (b.maxY - b.minY))));
    view = { k, x: (r.width - (b.maxX - b.minX) * k) / 2 - b.minX * k, y: 50 + (r.height - 50 - (b.maxY - b.minY) * k) / 2 - b.minY * k };
    applyView();
  }

  function focusTable(name: string) {
    const c = cards.get(name);
    if (!c) return fit();
    const r = canvas.getBoundingClientRect();
    view.k = 1;
    view.x = r.width / 2 - (c.pos.x + c.w / 2);
    view.y = r.height / 2 - (c.pos.y + c.h / 2);
    selected = name;
    applyView();
    paintFocus();
  }

  function dragCard(name: string, e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const c = cards.get(name)!;
    const sx = e.clientX;
    const sy = e.clientY;
    const start = { ...c.pos };
    c.el.classList.add("dragging");
    const move = (ev: PointerEvent) => {
      c.pos = { x: start.x + (ev.clientX - sx) / view.k, y: start.y + (ev.clientY - sy) / view.k };
      place(c);
      drawEdges();
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      c.el.classList.remove("dragging");
      persist();
      renderMinimap();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest(".dg-card")) return;
    selected = null;
    paintFocus();
    const sx = e.clientX - view.x;
    const sy = e.clientY - view.y;
    canvas.classList.add("panning");
    const move = (ev: PointerEvent) => {
      view.x = ev.clientX - sx;
      view.y = ev.clientY - sy;
      applyView();
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      canvas.classList.remove("panning");
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      // pinch on a trackpad arrives as ctrl+wheel; plain wheel/two-finger scroll pans
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else {
        view.x -= e.deltaX;
        view.y -= e.deltaY;
        applyView();
      }
    },
    { passive: false },
  );
  canvas.addEventListener("keydown", (e) => {
    if (e.key === "0" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), fit());
    else if ((e.key === "=" || e.key === "+") && (e.metaKey || e.ctrlKey)) (e.preventDefault(), zoomAt(1.2));
    else if (e.key === "-" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), zoomAt(1 / 1.2));
    else if (e.key === "f" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), search.focus());
  });
  search.addEventListener("input", () => paintFocus());
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const q = search.value.trim().toLowerCase();
      const hit = [...cards.keys()].find((n) => n.toLowerCase().includes(q));
      if (hit) focusTable(hit);
    } else if (e.key === "Escape") (search.value = ""), paintFocus(), canvas.focus();
  });

  // ---------------- minimap ----------------

  function renderMinimap() {
    if (!cards.size) return minimap.replaceChildren();
    const b = bounds();
    const W = 180;
    const H = 120;
    const s = Math.min(W / (b.maxX - b.minX + 200), H / (b.maxY - b.minY + 200));
    const ox = -b.minX + 100;
    const oy = -b.minY + 100;
    const r = canvas.getBoundingClientRect();
    const vx = (-view.x / view.k + ox) * s;
    const vy = (-view.y / view.k + oy) * s;
    const vw = (r.width / view.k) * s;
    const vh = (r.height / view.k) * s;
    const rects = [...cards.values()].map((c) => `<rect class="c${c.color}" x="${(c.pos.x + ox) * s}" y="${(c.pos.y + oy) * s}" width="${c.w * s}" height="${c.h * s}" rx="2"/>`).join("");
    minimap.innerHTML = `<svg width="${W}" height="${H}">${rects}<rect class="vp" x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="3"/></svg>`;
    minimap.onpointerdown = (e) => {
      const go = (ev: PointerEvent) => {
        const mr = minimap.getBoundingClientRect();
        const wx = (ev.clientX - mr.left) / s - ox;
        const wy = (ev.clientY - mr.top) / s - oy;
        view.x = r.width / 2 - wx * view.k;
        view.y = r.height / 2 - wy * view.k;
        applyView();
      };
      go(e);
      const up = () => (document.removeEventListener("pointermove", go), document.removeEventListener("pointerup", up));
      document.addEventListener("pointermove", go);
      document.addEventListener("pointerup", up);
    };
  }

  // ---------------- export ----------------

  function exportSvgText(): string {
    const css = getComputedStyle(dg);
    const v = (n: string) => css.getPropertyValue(n).trim();
    const b = bounds();
    const pad = 40;
    const W = b.maxX - b.minX + pad * 2;
    const H = b.maxY - b.minY + pad * 2;
    const tx = -b.minX + pad;
    const ty = -b.minY + pad;
    const out: string[] = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Figtree, -apple-system, Segoe UI, sans-serif" font-size="12">`);
    out.push(`<rect width="100%" height="100%" fill="${v("--dg-bg-solid")}"/>`);
    out.push(`<g transform="translate(${tx},${ty})" fill="none" stroke="${v("--dg-edge")}" stroke-width="1.4">`);
    for (const f of info.fks) {
      const e = edgePath(f);
      if (e) out.push(`<path d="${e.d}"/>`);
    }
    out.push(`</g>`);
    for (const c of cards.values()) {
      const x = c.pos.x + tx;
      const y = c.pos.y + ty;
      const accent = v(`--dg-c${c.color + 1}`);
      out.push(`<g transform="translate(${x},${y})">`);
      out.push(`<rect width="${c.w}" height="${c.h}" rx="12" fill="${v("--dg-card-solid")}" stroke="${v("--dg-card-border")}"/>`);
      out.push(`<rect x="0" y="0" width="${c.w}" height="4" rx="2" fill="${accent}"/>`);
      out.push(`<text x="14" y="25" font-weight="600" font-size="13" fill="${v("--fg-strong")}">${esc(c.t.name)}</text>`);
      for (const [name, row] of c.rows) {
        const col = c.t.columns.find((x) => x.name === name)!;
        const ry = row.offsetTop + row.offsetHeight / 2 + 4;
        const mark = col.pk ? "🔑 " : fkCols().has(`${c.t.name}.${name}`) ? "↗ " : "";
        out.push(`<text x="14" y="${ry}" fill="${v("--fg")}">${esc(mark + name)}</text>`);
        if (showTypes) out.push(`<text x="${c.w - 12}" y="${ry}" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="11" fill="${v("--fg-faint")}">${esc(col.dataType)}</text>`);
      }
      out.push(`</g>`);
    }
    out.push(`</svg>`);
    return out.join("\n");
  }

  async function exportSvg() {
    const path = await save({ defaultPath: `${schema}-diagrama.svg`, filters: [{ name: "SVG", extensions: ["svg"] }] });
    if (!path) return;
    try {
      await api.writeTextFile(path, exportSvgText());
      toast("Diagrama exportado", "ok");
    } catch (e) {
      toast(String(e), "error");
    }
  }

  function copyMermaid() {
    const id = (s: string) => s.replace(/[^\w]/g, "_");
    const lines = ["erDiagram"];
    for (const t of info.tables) {
      lines.push(`    ${id(t.name)} {`);
      for (const c of t.columns) lines.push(`        ${(c.dataType.split(/[\s(]/)[0] || "any").replace(/[^\w]/g, "_")} ${id(c.name)}${c.pk ? " PK" : fkCols().has(`${t.name}.${c.name}`) ? " FK" : ""}`);
      lines.push("    }");
    }
    for (const f of info.fks) lines.push(`    ${id(f.refTable)} ||--o{ ${id(f.table)} : "${f.columns.join(", ")}"`);
    navigator.clipboard.writeText(lines.join("\n"));
    toast("Copiado como Mermaid (erDiagram)", "ok");
  }

  // ---------------- tab ----------------

  const ro = new ResizeObserver(() => renderMinimap());
  ro.observe(canvas);
  setTimeout(() => load());
  return {
    id: `diagram:${conn.id}:${db}:${schema}`,
    title: `Diagrama · ${schema}`,
    icon: "diagram",
    tooltip: `${conn.name} — ${db}${schema !== db ? ` / ${schema}` : ""}`,
    color: conn.color || undefined,
    el,
    onActivate: () =>
      setTimeout(() => {
        if (pendingBuild) {
          pendingBuild = false;
          build();
          if (!Object.keys(saved.pos).length || info.tables.some((t) => !saved.pos[t.name])) autoLayout(false);
          opts.focus ? focusTable(opts.focus) : fit();
        }
        canvas.focus();
      }),
  };
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
