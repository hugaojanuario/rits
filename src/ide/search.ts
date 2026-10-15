// Search Everywhere, Find in Files, Recent Files, Go to Line, File Structure and the Find tool window.
import { EditorView, lineNumbers, Decoration } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { h, debounce } from "../util";
import { icon, fileIconName } from "../icons";
import { closePopup, modal } from "../ui";
import { host, P, type SearchHit } from "./host";
import { documentSymbols, symIcon, type Sym } from "./structure";
import { islandsTheme, langExtensions, langFor } from "./lang";
import { openSettings } from "./settings";
import type { Workbench } from "./workbench";
import { displayShortcut } from "./keymap";

let fileCache: { root: string; at: number; files: string[] } | null = null;
async function projectFiles(wb: Workbench) {
  if (!fileCache || fileCache.root !== wb.root || Date.now() - fileCache.at > 15000) {
    fileCache = { root: wb.root, at: Date.now(), files: await host.files(wb.root) };
  }
  return fileCache.files;
}

function fuzzyScore(text: string, q: string): number {
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 500 - t.length;
  const i = t.indexOf(q);
  if (i >= 0) return 300 - i - t.length / 10;
  // camel/word initials and subsequence
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    const f = t.indexOf(ch, ti);
    if (f < 0) return 0;
    score += f === ti ? 3 : 1;
    ti = f + 1;
  }
  return score;
}

function highlight(text: string, q: string): HTMLElement {
  const span = h("span");
  if (!q) {
    span.textContent = text;
    return span;
  }
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i >= 0) {
    span.append(text.slice(0, i), h("span.hl", null, text.slice(i, i + q.length)), text.slice(i + q.length));
    return span;
  }
  let qi = 0;
  for (const ch of text) {
    if (qi < q.length && ch.toLowerCase() === q[qi].toLowerCase()) {
      span.append(h("span.hl", null, ch));
      qi++;
    } else span.append(ch);
  }
  return span;
}

interface Item {
  label: string;
  detail?: string;
  icon: string;
  score: number;
  section: string;
  run: () => void;
}

function actions(wb: Workbench): { label: string; icon: string; run: () => void; shortcut?: string }[] {
  const ed = () => wb.editors.active();
  return [
    { label: "Executar", icon: "run/run", shortcut: "Shift+F10", run: () => wb.runner.runSelected(false) },
    { label: "Depurar", icon: "run/debug", shortcut: "Shift+F9", run: () => wb.runner.runSelected(true) },
    { label: "Executar arquivo atual", icon: "run/run", shortcut: "Ctrl+Shift+F10", run: () => wb.runner.runCurrentFile(false) },
    { label: "Editar configurações de execução", icon: "general/edit", run: () => wb.runner.editConfigs() },
    { label: "Reformatar código", icon: "actions/reformatCode", shortcut: "Ctrl+Alt+L", run: () => ed()?.format() },
    { label: "Otimizar imports", icon: "actions/reformatCode", shortcut: "Ctrl+Alt+O", run: () => ed()?.organizeImports() },
    { label: "Localizar nos arquivos", icon: "toolwindows/find", shortcut: "Ctrl+Shift+F", run: () => findInFiles(wb) },
    { label: "Commit", icon: "vcs/commit", shortcut: "Ctrl+K", run: () => wb.show("commit", true) },
    { label: "Push", icon: "vcs/push", shortcut: "Ctrl+Shift+K", run: () => wb.git.push() },
    { label: "Atualizar projeto (Git pull)", icon: "vcs/update", shortcut: "Ctrl+T", run: () => wb.git.pull() },
    { label: "Branches", icon: "branch", run: () => wb.git.branchesPopup(wb.vcsBtn) },
    { label: "Novo branch", icon: "branch", run: () => wb.git.newBranch() },
    { label: "Terminal", icon: "toolwindows/terminal", shortcut: "Alt+F12", run: () => wb.show("terminal", true) },
    { label: "Database", icon: "database", run: () => wb.show("database", true) },
    { label: "Nova conexão de banco", icon: "general/add", run: () => wb.db.newConnection() },
    { label: "Backup de banco de dados", icon: "backup", run: () => wb.db.backup() },
    { label: "Restaurar banco de dados", icon: "restore", run: () => wb.db.restore() },
    { label: "Configurações", icon: "general/settings", shortcut: "Ctrl+Alt+S", run: () => openSettings(wb) },
    { label: "Plugins", icon: "plugins", run: () => openSettings(wb, "plugins") },
    ...(wb.docker ? [{ label: "Docker: containers", icon: "docker", run: () => wb.show("docker", true) }] : [{ label: "Instalar plugin Docker", icon: "docker", run: () => openSettings(wb, "plugins", "docker") }]),
    { label: "Interpretador Python", icon: "python/pythonClosed", run: () => openSettings(wb, "python") },
    { label: "Inspecionar código", icon: "general/inspections", run: () => wb.problems.inspectProject() },
    { label: "Alternar tema claro/escuro", icon: "sun", run: () => (window as any).__toggleTheme?.() },
    { label: "Abrir projeto", icon: "general/open", run: () => wb.openFolder() },
    { label: "Fechar projeto", icon: "general/closeSmall", run: () => wb.closeProject() },
    { label: "Reiniciar servidores de linguagem", icon: "general/refresh", run: () => (wb.lsp.restart("python"), wb.lsp.restart("go")) },
  ];
}

export async function searchEverywhere(wb: Workbench, tab: "all" | "files" | "symbols" | "actions" = "all") {
  closePopup();
  document.querySelector(".se-overlay")?.remove();
  const input = h("input.se-input", { placeholder: "Digite / para ações, # para símbolos…", spellcheck: false }) as HTMLInputElement;
  const list = h("div.se-list");
  const tabsEl = h("div.se-tabs");
  const pop = h("div.popup.se-popup", null, tabsEl, h("div.se-input-wrap", null, icon("general/search"), input), list);
  const overlay = h("div.se-overlay", { style: "position:fixed;inset:0;z-index:140" }, pop);
  pop.style.left = "50%";
  pop.style.transform = "translateX(-50%)";
  pop.style.top = "14vh";
  overlay.addEventListener("mousedown", (e) => e.target === overlay && overlay.remove());
  document.body.append(overlay);

  let items: Item[] = [];
  let sel = 0;
  const labels = { all: "Tudo", files: "Arquivos", symbols: "Símbolos", actions: "Ações" } as const;
  const drawTabs = () =>
    tabsEl.replaceChildren(...(Object.keys(labels) as (keyof typeof labels)[]).map((k) => h("div.se-tab", { class: k === tab ? "active" : "", onclick: () => ((tab = k), drawTabs(), update()) }, labels[k])));
  drawTabs();
  const draw = () => {
    let last = "";
    list.replaceChildren(
      ...items.flatMap((it, i) => {
        const els: HTMLElement[] = [];
        if (it.section !== last && tab === "all") els.push(h("div.popup-section", null, it.section));
        last = it.section;
        const row = h("div.popup-item", { class: i === sel ? "active" : "" }, icon(it.icon), highlight(it.label, input.value.trim().replace(/^[/#]/, "")), it.detail ? h("span.pi-right", null, it.detail) : null);
        row.onclick = () => choose(i);
        row.onmousemove = () => {
          if (sel !== i) (sel = i), draw();
        };
        els.push(row);
        return els;
      }),
    );
    if (!items.length) list.append(h("div.empty-note", null, input.value ? "Nada encontrado" : "Comece a digitar"));
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  };
  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    overlay.remove();
    it.run();
  };
  let reqId = 0;
  const update = debounce(async () => {
    const my = ++reqId;
    let q = input.value.trim();
    let t = tab;
    if (q.startsWith("/")) (t = "actions"), (q = q.slice(1));
    else if (q.startsWith("#")) (t = "symbols"), (q = q.slice(1));
    const ql = q.toLowerCase();
    const out: Item[] = [];
    if (t === "all" || t === "files") {
      const recent = wb.tabs.recent().map((x) => x.tooltip ?? "");
      const files = q ? await projectFiles(wb) : wb.editors.all().map((e) => e.path);
      for (const f of files) {
        const name = P.base(f);
        let s = fuzzyScore(name, ql);
        if (!s && ql.includes("/")) s = fuzzyScore(P.rel(wb.root, f), ql) / 2;
        if (s) out.push({ label: name, detail: P.rel(wb.root, P.dir(f)), icon: fileIconName(name), score: s + (recent.includes(P.win(f)) ? 50 : 0), section: "Arquivos", run: () => wb.editors.openFile(f) });
      }
    }
    if ((t === "all" || t === "actions") && q) {
      for (const a of actions(wb)) {
        const s = fuzzyScore(a.label, ql);
        if (s) out.push({ label: a.label, detail: displayShortcut(a.shortcut), icon: a.icon, score: s - 100, section: "Ações", run: a.run });
      }
    } else if (t === "actions") for (const a of actions(wb)) out.push({ label: a.label, detail: displayShortcut(a.shortcut), icon: a.icon, score: 0, section: "Ações", run: a.run });
    if ((t === "all" || t === "symbols") && q.length >= 2) {
      for (const lang of ["python", "go"] as const) {
        if (wb.lsp.status(lang) !== "ready") continue;
        const res = await wb.lsp.request<any[]>(lang, "workspace/symbol", { query: q });
        for (const s of res ?? []) {
          const loc = s.location;
          if (!loc?.range) continue;
          const path = P.fromUri(loc.uri);
          if (!P.inside(wb.root, path)) continue;
          out.push({ label: s.name, detail: `${s.containerName ? s.containerName + " · " : ""}${P.rel(wb.root, path)}`, icon: symIcon(s.kind), score: fuzzyScore(s.name, ql) - 50, section: "Símbolos", run: () => wb.editors.openFile(path, { line: loc.range.start.line + 1, col: loc.range.start.character + 1 }) });
        }
      }
    }
    if (my !== reqId) return;
    const order = ["Arquivos", "Símbolos", "Ações"];
    items = out.sort((a, b) => (tab === "all" ? order.indexOf(a.section) - order.indexOf(b.section) : 0) || b.score - a.score).slice(0, 80);
    sel = 0;
    draw();
  }, 90);
  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") (sel = Math.min(items.length - 1, sel + 1)), draw(), e.preventDefault();
    else if (e.key === "ArrowUp") (sel = Math.max(0, sel - 1)), draw(), e.preventDefault();
    else if (e.key === "Enter") choose(sel);
    else if (e.key === "Escape") overlay.remove();
    else if (e.key === "Tab") {
      e.preventDefault();
      const ks = Object.keys(labels) as (keyof typeof labels)[];
      tab = ks[(ks.indexOf(tab) + (e.shiftKey ? ks.length - 1 : 1)) % ks.length];
      drawTabs();
      update();
    }
  });
  update();
  input.focus();
}

export function recentFiles(wb: Workbench) {
  const items = wb.tabs.recent();
  const m = modal("Arquivos recentes", { width: 620 });
  m.footer.remove();
  const listEl = h("div.list", { style: "max-height:420px" });
  let sel = Math.min(1, items.length - 1);
  const draw = () =>
    listEl.replaceChildren(
      ...items.map((t, i) => {
        const r = h("div.list-row", { class: i === sel ? "selected" : "" }, icon(t.icon), h("span", null, t.title), h("span.detail", null, t.tooltip ? P.rel(wb.root, P.dir(P.norm(t.tooltip))) : ""));
        r.onclick = () => (m.close(), wb.tabs.activate(t));
        return r;
      }),
    );
  draw();
  m.body.append(listEl);
  m.root.tabIndex = -1;
  m.root.focus();
  m.root.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || (e.key === "e" && e.ctrlKey)) (sel = (sel + 1) % items.length), draw(), e.preventDefault();
    else if (e.key === "ArrowUp") (sel = (sel - 1 + items.length) % items.length), draw(), e.preventDefault();
    else if (e.key === "Enter" && items[sel]) m.close(), wb.tabs.activate(items[sel]);
  });
}

export function gotoLine(wb: Workbench) {
  const ed = wb.editors.active();
  if (!ed) return;
  const m = modal("Ir para linha e coluna", { width: 380 });
  const pos = ed.cursorInfo();
  const input = h("input.input", { value: `${pos.line}:${pos.col}`, spellcheck: false }) as HTMLInputElement;
  m.body.append(h("label.field", null, h("span", null, "[Linha] [:coluna]"), input));
  const go = () => {
    const [l, c] = input.value.split(/[:,]/).map((x) => Number(x.trim()));
    m.close();
    if (l) ed.reveal(l, c || 1, true);
    ed.focus();
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
  m.footer.append(h("button.btn", { onclick: () => m.close() }, "Cancelar"), h("button.btn.primary", { onclick: go }, "OK"));
  setTimeout(() => input.select());
}

export async function fileStructurePopup(wb: Workbench) {
  const ed = wb.editors.active();
  if (!ed) return;
  const syms = await documentSymbols(wb, ed.path);
  const flat: { s: Sym; depth: number }[] = [];
  const walk = (s: Sym, d: number) => {
    flat.push({ s, depth: d });
    s.children.forEach((c) => walk(c, d + 1));
  };
  syms.forEach((s) => walk(s, 0));
  const m = modal(`Estrutura de ${P.base(ed.path)}`, { width: 520 });
  m.footer.remove();
  const input = h("input.input", { placeholder: "Filtrar", spellcheck: false }) as HTMLInputElement;
  const listEl = h("div.list", { style: "max-height:440px;margin-top:8px" });
  let sel = 0;
  let shown = flat;
  const draw = () => {
    const q = input.value.toLowerCase();
    shown = flat.filter((x) => !q || fuzzyScore(x.s.name, q));
    listEl.replaceChildren(
      ...shown.map((x, i) => {
        const r = h("div.list-row", { class: i === sel ? "selected" : "", style: `padding-left:${14 + x.depth * 18}px` }, icon(symIcon(x.s.kind)), highlight(x.s.name, q), x.s.detail ? h("span.detail", null, x.s.detail) : null);
        r.onclick = () => (m.close(), ed.reveal(x.s.line, x.s.col));
        return r;
      }),
    );
  };
  input.addEventListener("input", () => ((sel = 0), draw()));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") (sel = Math.min(shown.length - 1, sel + 1)), draw(), e.preventDefault();
    else if (e.key === "ArrowUp") (sel = Math.max(0, sel - 1)), draw(), e.preventDefault();
    else if (e.key === "Enter" && shown[sel]) m.close(), ed.reveal(shown[sel].s.line, shown[sel].s.col);
  });
  draw();
  m.body.append(input, listEl);
  setTimeout(() => input.focus());
}

// ---------------- Find in Files ----------------
let lastFind = { q: "", regex: false, case: false, word: false, mask: "" };

export function findInFiles(wb: Workbench) {
  const m = modal("Localizar nos arquivos", { width: 900 });
  m.root.classList.add("find-popup");
  m.footer.remove();
  const sel = wb.editors.active()?.view?.state;
  const selected = sel ? sel.sliceDoc(sel.selection.main.from, sel.selection.main.to) : "";
  const q = h("input.input", { value: selected && !selected.includes("\n") ? selected : lastFind.q, placeholder: "Texto a procurar", spellcheck: false }) as HTMLInputElement;
  const mask = h("input.input", { value: lastFind.mask, placeholder: "Máscara: *.py, *.go", spellcheck: false, style: "width:180px" }) as HTMLInputElement;
  const opts = { regex: lastFind.regex, case: lastFind.case, word: lastFind.word };
  const toggle = (k: keyof typeof opts, label: string, title: string) => {
    const b = h("button.tool-btn.text", { title, class: opts[k] ? "on" : "" }, label);
    b.onclick = () => {
      opts[k] = !opts[k];
      b.classList.toggle("on", opts[k]);
      run();
    };
    return b;
  };
  const status = h("span.faint");
  const listEl = h("div.list.find-results", { style: "height:300px;border-top:1px solid var(--border);margin-top:8px" });
  const preview = h("div.find-preview");
  let hits: SearchHit[] = [];
  let selIdx = 0;
  let pv: EditorView | null = null;
  const showPreview = async () => {
    const hit = hits[selIdx];
    pv?.destroy();
    preview.replaceChildren();
    if (!hit) return;
    const ft = await host.read(hit.path).catch(() => null);
    if (!ft || hits[selIdx] !== hit) return;
    const state = EditorState.create({ doc: ft.text, extensions: [lineNumbers(), ...langExtensions(langFor(hit.path)), islandsTheme, EditorState.readOnly.of(true), EditorView.decorations.of((v) => {
      const line = v.state.doc.line(Math.min(hit.line, v.state.doc.lines));
      return Decoration.set([Decoration.line({ class: "cm-activeLine" }).range(line.from)]);
    })] });
    pv = new EditorView({ state, parent: preview });
    const line = pv.state.doc.line(Math.min(hit.line, pv.state.doc.lines));
    pv.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
  };
  const draw = () => {
    listEl.replaceChildren(
      ...hits.slice(0, 1000).map((x, i) => {
        const before = x.text.slice(0, x.col - 1).replace(/^\s+/, "");
        const mid = x.text.slice(x.col - 1, x.col - 1 + x.len);
        const after = x.text.slice(x.col - 1 + x.len);
        const r = h(
          "div.list-row",
          { class: i === selIdx ? "selected" : "" },
          h("span.hit-line", { style: "flex:1;overflow:hidden;text-overflow:ellipsis" }, before.slice(-60), h("mark", null, mid), after),
          h("span.detail", null, `${P.base(x.path)} ${x.line}`),
        );
        r.onclick = () => ((selIdx = i), draw(), showPreview());
        r.ondblclick = () => openHit(x);
        return r;
      }),
    );
    listEl.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  };
  const openHit = (x: SearchHit) => {
    m.close();
    wb.editors.openFile(x.path, { line: x.line, col: x.col, len: x.len });
  };
  let reqId = 0;
  const run = debounce(async () => {
    const my = ++reqId;
    lastFind = { q: q.value, mask: mask.value, ...opts };
    if (!q.value) {
      hits = [];
      status.textContent = "";
      draw();
      return;
    }
    status.textContent = "Procurando…";
    try {
      const res = await host.search(wb.root, q.value, { ...opts, mask: mask.value });
      if (my !== reqId) return;
      hits = res;
      const files = new Set(res.map((r) => r.path)).size;
      status.textContent = `${res.length >= 2000 ? "2000+" : res.length} resultado(s) em ${files} arquivo(s)`;
      selIdx = 0;
      draw();
      showPreview();
    } catch (e) {
      status.textContent = String(e);
    }
  }, 220);
  q.addEventListener("input", run);
  mask.addEventListener("input", run);
  const keys = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") (selIdx = Math.min(hits.length - 1, selIdx + 1)), draw(), showPreview(), e.preventDefault();
    else if (e.key === "ArrowUp") (selIdx = Math.max(0, selIdx - 1)), draw(), showPreview(), e.preventDefault();
    else if (e.key === "Enter" && e.ctrlKey) (m.close(), showFindResults(wb, `'${q.value}'`, hits));
    else if (e.key === "Enter" && hits[selIdx]) openHit(hits[selIdx]);
  };
  q.addEventListener("keydown", keys);
  m.body.append(
    h("div", { style: "display:flex;gap:6px;align-items:center" }, q, toggle("case", "Aa", "Diferenciar maiúsculas"), toggle("word", "W", "Palavra inteira"), toggle("regex", ".*", "Expressão regular"), mask),
    h("div", { style: "display:flex;align-items:center;margin-top:6px" }, status, h("span.grow"), h("button.link", { onclick: () => (m.close(), showFindResults(wb, `'${q.value}'`, hits)) }, "Abrir na janela Find (Ctrl+Enter)")),
    listEl,
    preview,
  );
  setTimeout(() => (q.focus(), q.select()));
  if (q.value) run();
}

// ---------------- Find tool window ----------------
let findBody: HTMLElement | null = null;
export function showFindResults(wb: Workbench, title: string, hits: SearchHit[]) {
  if (!findBody) {
    findBody = h("div.tree", { tabIndex: 0 });
    wb.register({ id: "find", title: "Find", icon: "find", anchor: "bottom", shortcut: "Alt+3", body: h("div.tw-body", null, findBody) });
  }
  const byFile = new Map<string, SearchHit[]>();
  for (const x of hits) byFile.set(x.path, [...(byFile.get(x.path) ?? []), x]);
  const rows: HTMLElement[] = [h("div.tree-row", { style: "padding-left:10px;font-weight:600" }, icon("general/search"), `${title} — ${hits.length} resultado(s) em ${byFile.size} arquivo(s)`)];
  for (const [path, list] of byFile) {
    rows.push(h("div.tree-row", { style: "padding-left:24px" }, icon(fileIconName(P.base(path))), h("span.tree-label", null, P.base(path)), h("span.tree-detail", null, `${P.rel(wb.root, P.dir(path))}  ${list.length}`)));
    for (const x of list) {
      const r = h("div.tree-row", { style: "padding-left:50px" }, h("span.faint", { style: "width:44px;text-align:right;margin-right:8px" }, String(x.line)), h("span.hit-line.tree-label", null, x.text.trim() || "…"));
      r.onclick = () => wb.editors.openFile(x.path, { line: x.line, col: x.col, len: x.len });
      rows.push(r);
    }
    if (!list[0].text) {
      // references from LSP come without text: load lines lazily
      host.read(path).then((ft) => {
        const lines = ft.text.split("\n");
        list.forEach((x) => (x.text = lines[x.line - 1] ?? ""));
        showFindResults(wb, title, hits);
      });
      return;
    }
  }
  findBody.replaceChildren(...rows);
  wb.show("find");
}
