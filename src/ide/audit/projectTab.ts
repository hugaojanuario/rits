// Workspace of an audit project, organized as the audit flow:
// 1 Projeto · 2 Escopo · 3 Estrutura · 4 Mapeamento · 5 Evidência e desempenho · 6 Baseline ·
// 7 Reconciliação · 8 Relatórios.
// Suggestions are shown with their criteria and only take part after confirmation. Results keep
// the dimensions apart (volume, identity, fields, relationships) and never become a single score.
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { h, uid } from "../../util";
import { icon } from "../../icons";
import { button, confirmDialog, modal, notify, toast } from "../../ui";
import type { Tab } from "../../tabs";
import { store } from "../../state";
import type { Workbench } from "../workbench";
import {
  audit, emptyRules, errText, FINDING_LABEL, fmtTime, RESULT_LABEL, STATUS_LABEL,
  type BaselineManifest, type Dataset, type Dim, type FieldKind, type HistoryItem, type Mappings, type Pred, type Progress, type Project, type Rules, type RunManifest, type Structure, type Table, type Unit, type UnitCheck, type UnitResult,
} from "./api";

export function defaultProject(): Project {
  return {
    format: 1, id: "", name: "", description: "", created: 0, updated: 0,
    source: { connId: "", name: "", kind: "", host: "", database: "", version: "" },
    target: { connId: "", name: "", kind: "", host: "", database: "", version: "" },
    sourceScope: { schemas: [], includeViews: false, excluded: [], technical: [] },
    targetScope: { schemas: [], includeViews: false, excluded: [], technical: [] },
    consistency: "snapshot", watermarkNote: "",
    perf: { mode: "fields", concurrency: 1, perConnection: 1, timeoutSecs: 1800, batchRows: 200000, memoryMb: 512, diskMb: 20480, maxExamples: 50, queryBudget: 0, excludeLobs: true, retention: 0 },
    evidenceLevel: "fields", storeValues: false, aliases: [], stripPrefixes: [],
  };
}

const ds = (): Dataset => ({ kind: "table", schema: "", table: "", sql: "", filters: [] });

function newUnit(n: number): Unit {
  return { id: `u${Date.now().toString(36)}${n}`, name: `Unidade ${n}`, description: "", criticality: "media", source: ds(), target: ds(), cardinality: "1:1", normalized: false, identity: { kind: "key", source: [], target: [], map: null }, fields: [], exclusions: [], targetScope: [], excludePreexisting: false, relationships: [], confirmed: false };
}

const STEPS: [string, string][] = [
  ["project", "1. Projeto"],
  ["scope", "2. Escopo"],
  ["structure", "3. Estrutura"],
  ["mapping", "4. Mapeamento"],
  ["evidence", "5. Evidência e desempenho"],
  ["baseline", "6. Baseline"],
  ["reconcile", "7. Reconciliação"],
  ["report", "8. Relatórios"],
];

const OPS = ["=", "<>", "<", "<=", ">", ">=", "is null", "is not null", "in"];

const resTag = (r: string) => h(`span.ma-res.${r || "none"}` as "span", null, RESULT_LABEL[r] ?? r);

export class AuditProjectTab {
  tab: Tab;
  private el = h("div.ma-tab");
  private nav = h("div.ma-nav");
  private page = h("div.ma-page");
  private step = "project";
  private project: Project;
  private mappings: Mappings;
  private src: Structure | null;
  private dst: Structure | null;
  private unitSel: string | null = null;
  private mapDirty = false;
  private checks: UnitCheck[] | null = null;
  private uncovered: string[] = [];
  private history: { baselines: HistoryItem[]; runs: HistoryItem[] } = { baselines: [], runs: [] };
  private job: { id: string; label: string; progress: Progress | null; started: number } | null = null;
  private progressEl = h("div.ma-progress");
  private run: RunManifest | null = null;
  private runUnit: string | null = null;
  private finding: { kind: string; offset: number; reveal: boolean } | null = null;

  constructor(
    private wb: Workbench,
    data: { project: Project; mappings: Mappings; sourceStructure: Structure | null; targetStructure: Structure | null },
    private onClose: () => void,
  ) {
    this.project = data.project;
    this.mappings = data.mappings;
    this.src = data.sourceStructure;
    this.dst = data.targetStructure;
    this.tab = {
      id: "audit:" + this.project.id,
      title: this.project.name,
      icon: "audit",
      el: this.el,
      canClose: async () => {
        if (this.job && !(await confirmDialog("Tarefa em andamento", "Cancelar a tarefa e fechar? O que já foi feito fica registrado como parcial.", "Cancelar e fechar", true))) return false;
        if (this.job) await audit.cancel(this.job.id).catch(() => {});
        if (this.mapDirty && !(await confirmDialog("Mapeamento não salvo", "Descartar as alterações do mapeamento?", "Descartar", true))) return false;
        return true;
      },
      onClose: () => this.onClose(),
    };
    this.el.append(this.nav, h("div.ma-main", null, this.progressEl, this.page));
    this.loadHistory();
    this.render();
  }

  go(step: string) {
    this.step = step;
    this.render();
  }

  private async loadHistory() {
    this.history = await audit.history(this.project.id).catch(() => ({ baselines: [], runs: [] }));
    if (["baseline", "reconcile", "report"].includes(this.step)) this.render();
  }

  // ---------------- progress ----------------

  onProgress(job: string, p: Progress) {
    if (this.job?.id !== job) return;
    this.job.progress = p;
    this.renderProgress();
  }

  private renderProgress() {
    const j = this.job;
    if (!j) return this.progressEl.replaceChildren();
    const p = j.progress;
    const secs = Math.round((Date.now() - j.started) / 1000);
    // no invented percentage: totals are often unknown
    this.progressEl.replaceChildren(
      h(
        "div.ma-prog",
        null,
        h("span.af-dot.running"),
        h("b", null, j.label),
        h("span", null, p?.phase ? `fase: ${p.phase}` : "iniciando…"),
        p?.unit ? h("span", null, `unidade: ${p.unit}`) : "",
        p?.processed ? h("span", null, `${p.processed.toLocaleString("pt-BR")} registros lidos`) : "",
        h("span.dim", null, `${secs} s`),
        p?.queries ? h("span.dim", null, `${p.queries} consultas`) : "",
        p?.message ? h("span.dim", null, p.message) : "",
        h("span.grow"),
        h("button.btn", { onclick: () => audit.cancel(j.id) }, icon("run/stop"), "Cancelar"),
      ),
    );
  }

  private async runJob<T>(label: string, fn: (job: string) => Promise<T>): Promise<T | null> {
    if (this.job) {
      toast("Já há uma tarefa em andamento neste projeto.", "info");
      return null;
    }
    const id = "ma-" + uid();
    this.job = { id, label, progress: null, started: Date.now() };
    this.renderProgress();
    const timer = window.setInterval(() => this.renderProgress(), 1000);
    try {
      return await fn(id);
    } catch (e) {
      notify(`${label}: falhou`, errText(e), "error", [], 12000);
      return null;
    } finally {
      clearInterval(timer);
      this.job = null;
      this.renderProgress();
    }
  }

  // ---------------- render ----------------

  private render() {
    this.tab.title = this.project.name;
    this.wb.tabs.update(this.tab);
    this.nav.replaceChildren(
      h("div.ma-title", null, icon("audit"), h("b", null, this.project.name)),
      h("div.dim.ma-sub", null, `${this.project.source.name} → ${this.project.target.name}`),
      ...STEPS.map(([id, label]) => h("button.ma-step", { class: this.step === id ? "active" : "", onclick: () => this.go(id) }, label, id === "mapping" && this.mapDirty ? h("span.ma-dot") : "")),
      h("span.grow"),
      h("div.hint.ma-sub", null, "O plugin audita: não executa a conversão nem corrige dados."),
    );
    const pages: Record<string, () => HTMLElement> = {
      project: () => this.pageProject(),
      scope: () => this.pageScope(),
      structure: () => this.pageStructure(),
      mapping: () => this.pageMapping(),
      evidence: () => this.pageEvidence(),
      baseline: () => this.pageBaseline(),
      reconcile: () => this.pageReconcile(),
      report: () => this.pageReport(),
    };
    this.page.replaceChildren(pages[this.step]());
  }

  private async saveProject() {
    try {
      this.project = await audit.saveProject(this.project);
      toast("Projeto salvo", "ok", 1500);
      this.render();
    } catch (e) {
      toast(errText(e), "error");
    }
  }

  private card(title: string, ...children: (HTMLElement | string | null)[]) {
    return h("div.ma-card", null, h("h3", null, title), ...children);
  }

  private input(value: string, onchange: (v: string) => void, attrs: Record<string, unknown> = {}) {
    const i = h("input.input", { value, spellcheck: false, ...attrs }) as HTMLInputElement;
    i.onchange = () => onchange(i.value);
    return i;
  }

  private select(options: [string, string][], value: string, onchange: (v: string) => void) {
    const s = h("select.input", null, ...options.map(([v, l]) => h("option", { value: v, selected: v === value }, l))) as HTMLSelectElement;
    s.onchange = () => onchange(s.value);
    return s;
  }

  private check(label: string, value: boolean, onchange: (v: boolean) => void, title = "") {
    const c = h("input", { type: "checkbox", checked: value }) as HTMLInputElement;
    c.onchange = () => onchange(c.checked);
    return h("label.check", { title }, c, label);
  }

  // ---------------- 1. project ----------------

  private pageProject() {
    const p = this.project;
    const conns = store.connections.filter((c) => ["postgres", "mysql", "sqlserver", "firebird"].includes(c.kind));
    const connOpts = conns.map((c) => [c.id, `${c.name} (${c.kind}, ${c.host}:${c.port})`] as [string, string]);
    return h(
      "div",
      null,
      this.card(
        "Projeto",
        h(
          "div.form-grid",
          null,
          h("label.field.span2", null, h("span", null, "Nome"), this.input(p.name, (v) => (p.name = v))),
          h("label.field.span2", null, h("span", null, "Descrição"), this.input(p.description, (v) => (p.description = v))),
          h("label.field", null, h("span", null, "Origem"), this.select(connOpts, p.source.connId, (v) => (p.source.connId = v))),
          h("label.field", null, h("span", null, "Banco da origem"), this.input(p.source.database, (v) => (p.source.database = v))),
          h("label.field", null, h("span", null, "Destino"), this.select(connOpts, p.target.connId, (v) => (p.target.connId = v))),
          h("label.field", null, h("span", null, "Banco do destino"), this.input(p.target.database, (v) => (p.target.database = v))),
        ),
        h("div.hint", null, `Versões detectadas: origem ${p.source.version || "—"} · destino ${p.target.version || "—"}. Credenciais não são gravadas no projeto: ele referencia as conexões do Rits.`),
        h("div.ma-actions", null, button("Salvar", () => this.saveProject(), "primary"), button("Próximo: escopo", () => this.go("scope"))),
      ),
      this.card(
        "Excluir projeto",
        h("div.dim", null, "Remove baselines, execuções e exportações deste projeto (vão para a lixeira do sistema). Os bancos auditados não são alterados."),
        h("div.ma-actions", null, button("Excluir projeto…", async () => {
          if (!(await confirmDialog("Excluir projeto de auditoria", `Excluir "${p.name}" e todas as evidências?`, "Excluir", true))) return;
          await audit.deleteProject(p.id).catch((e) => toast(errText(e), "error"));
          this.wb.tabs.close(this.tab);
        }, "danger")),
      ),
    );
  }

  // ---------------- 2. scope ----------------

  private pageScope() {
    const side = (label: string, which: "sourceScope" | "targetScope", conn: { connId: string; database: string }) => {
      const sc = this.project[which];
      const box = h("div.ma-schemas", null, ...sc.schemas.map((s) => h("span.tag", null, s)));
      const load = button("Carregar schemas", async () => {
        try {
          const all = await audit.schemas(conn.connId, conn.database);
          box.replaceChildren(...all.map((s) => this.check(s, sc.schemas.includes(s), (on) => (sc.schemas = on ? [...sc.schemas, s] : sc.schemas.filter((x) => x !== s)))));
        } catch (e) {
          toast(errText(e), "error");
        }
      }, "", "general/refresh");
      const excl = h("div.ma-list");
      const renderExcl = () =>
        excl.replaceChildren(
          ...sc.excluded.map((e, i) =>
            h("div.ma-row", null, this.input(e.schema, (v) => (e.schema = v), { placeholder: "schema", style: "width:120px" }), this.input(e.table, (v) => (e.table = v), { placeholder: "tabela" }), this.input(e.reason, (v) => (e.reason = v), { placeholder: "justificativa (obrigatória)" }), h("button.icon-btn", { onclick: () => (sc.excluded.splice(i, 1), renderExcl()) }, icon("general/delete"))),
          ),
          h("button.btn", { onclick: () => (sc.excluded.push({ schema: "", table: "", reason: "" }), renderExcl()) }, icon("general/add"), "Excluir objeto do escopo"),
        );
      renderExcl();
      return this.card(
        label,
        h("div.ma-row", null, h("span.dim", null, "Schemas (bancos no MySQL)"), load),
        box,
        this.check("Incluir views (contadas separadamente para evitar dupla contagem)", sc.includeViews, (v) => (sc.includeViews = v)),
        h("label.field", null, h("span", null, "Tabelas técnicas, de auditoria ou histórico (padrões LIKE, separados por vírgula)"), this.input(sc.technical.join(", "), (v) => (sc.technical = v.split(",").map((x) => x.trim()).filter(Boolean)), { placeholder: "log_%, %_audit, tmp_%" })),
        h("div.field", null, h("span", null, "Fora do escopo da conversão"), excl),
      );
    };
    return h(
      "div",
      null,
      side("Origem", "sourceScope", this.project.source),
      side("Destino", "targetScope", this.project.target),
      this.card(
        "Sugestões de mapeamento",
        h("label.field", null, h("span", null, "Prefixos a remover na comparação de nomes (vírgula)"), this.input(this.project.stripPrefixes.join(", "), (v) => (this.project.stripPrefixes = v.split(",").map((x) => x.trim()).filter(Boolean)), { placeholder: "tb_, t_" })),
        h("label.field", null, h("span", null, "Dicionário de aliases (origem=destino, um por linha)"), (() => {
          const t = h("textarea.input", { rows: 4, spellcheck: false, placeholder: "cli_nome=nome\ndt_nasc=nascimento" }, this.project.aliases.map(([a, b]) => `${a}=${b}`).join("\n")) as HTMLTextAreaElement;
          t.onchange = () => (this.project.aliases = t.value.split("\n").map((l) => l.split("=").map((x) => x.trim()) as [string, string]).filter((x) => x.length === 2 && x[0] && x[1]));
          return t;
        })()),
        h("div.hint", null, "Sugestões são determinísticas (nome exato, normalizado, prefixos, aliases, tipos e chaves), mostram os critérios e só participam da reconciliação depois de confirmadas."),
      ),
      h("div.ma-actions", null, button("Salvar escopo", () => this.saveProject(), "primary"), button("Próximo: estrutura", () => this.go("structure"))),
    );
  }

  // ---------------- 3. structure ----------------

  private pageStructure() {
    const discover = button("Executar descoberta estrutural", async () => {
      const r = await this.runJob("Descoberta estrutural", (job) => audit.discover(job, this.project.id));
      if (r) {
        this.src = r.sourceStructure;
        this.dst = r.targetStructure;
        const d = await audit.load(this.project.id).catch(() => null);
        if (d) this.project = d.project;
        await this.validate(false);
        toast("Estrutura lida (somente metadados; nenhum dado foi lido).", "ok");
        this.render();
      }
    }, "primary", "general/refresh");
    const table = (s: Structure | null, label: string) => {
      if (!s) return this.card(label, h("div.dim", null, "Ainda não descoberta."));
      const rows = s.tables.map((t) => {
        const pk = t.constraints.find((c) => c.kind === "primary");
        const fks = t.constraints.filter((c) => c.kind === "foreign").length;
        const flags = [t.kind !== "table" ? t.kind : "", t.technical ? "técnica" : "", t.excluded ? `fora do escopo: ${t.excluded}` : "", t.error ? `erro: ${t.error}` : ""].filter(Boolean).join(" · ");
        return h("tr", { class: t.technical || t.excluded ? "dim" : "" }, h("td", null, t.schema ? `${t.schema}.${t.name}` : t.name), h("td", null, String(t.columns.length)), h("td", null, pk ? pk.columns.join(", ") : h("span.ma-warn", null, "sem PK")), h("td", null, String(fks)), h("td", null, t.estimatedRows == null ? "desconhecida" : `~${t.estimatedRows.toLocaleString("pt-BR")}`), h("td.dim", null, flags));
      });
      return this.card(`${label} — ${s.dialect} ${s.version.split(" ").slice(0, 3).join(" ")}`, h("table.ma-table", null, h("thead", null, h("tr", null, ...["Tabela", "Colunas", "Chave primária", "FKs", "Linhas (estimativa do catálogo)", ""].map((x) => h("th", null, x)))), h("tbody", null, ...rows)), ...s.errors.map((e) => h("div.af-warn", null, icon("status/error"), e)));
    };
    return h(
      "div",
      null,
      this.card("Descoberta", h("div.dim", null, "Lê schemas, tabelas, colunas (tipos, tamanho, precisão, nulabilidade, defaults, colunas geradas), chaves, restrições e índices. Estimativas de linhas são do catálogo e nunca aprovam volume."), h("div.ma-actions", null, discover)),
      this.uncovered.length ? this.card("Tabelas da origem sem cobertura", h("div.af-warn", null, icon("status/warning"), `${this.uncovered.length} tabelas no escopo sem unidade de reconciliação nem exclusão justificada: ${this.uncovered.join(", ")}`)) : null,
      table(this.src, "Origem"),
      table(this.dst, "Destino"),
    );
  }

  // ---------------- 4. mapping ----------------

  private tablesOf(s: Structure | null) {
    return (s?.tables ?? []).filter((t) => !t.excluded || t.kind === "table");
  }

  private tableOf(s: Structure | null, d: Dataset): Table | undefined {
    return d.kind === "table" ? s?.tables.find((t) => t.schema === d.schema && t.name === d.table) : undefined;
  }

  private colsOf(s: Structure | null, d: Dataset): string[] {
    return this.tableOf(s, d)?.columns.map((c) => c.name) ?? [];
  }

  private touch() {
    this.mapDirty = true;
    this.nav.querySelector(".ma-step.active")?.classList.add("dirty");
  }

  private async saveMappings() {
    try {
      this.mappings = await audit.saveMappings(this.project.id, this.mappings);
      this.mapDirty = false;
      toast(`Mapeamento salvo (versão ${this.mappings.version})`, "ok", 1800);
      await this.validate(false);
      this.render();
    } catch (e) {
      toast(errText(e), "error");
    }
  }

  private async validate(queries: boolean) {
    if (this.mapDirty) await this.saveMappings();
    const r = await audit.validate(this.project.id, queries).catch((e) => (toast(errText(e), "error"), null));
    if (r) {
      this.checks = r.units;
      this.uncovered = r.uncovered;
    }
  }

  private pageMapping() {
    const units = this.mappings.units;
    const sel = units.find((u) => u.id === this.unitSel) ?? units[0] ?? null;
    if (sel) this.unitSel = sel.id;
    const chk = (u: Unit) => this.checks?.find((c) => c.unitId === u.id);
    const list = h(
      "div.ma-units",
      null,
      ...units.map((u) =>
        h(
          "button.ma-unit",
          { class: u.id === this.unitSel ? "active" : "", onclick: () => ((this.unitSel = u.id), this.render()) },
          h("div.af-name", null, u.name, u.confirmed ? h("span.tag.ok", null, "confirmada") : h("span.tag", null, "rascunho")),
          h("div.af-sub", null, `${u.source.kind === "query" ? "consulta" : u.source.table || "?"} → ${u.target.kind === "query" ? "consulta" : u.target.table || "?"} · identidade: ${({ none: "nenhuma", key: "chave", map: "mapa de IDs", content: "conteúdo" } as Record<string, string>)[u.identity.kind]}`),
          chk(u)?.errors.length ? h("div.ma-bad", null, `${chk(u)!.errors.length} erro(s)`) : "",
        ),
      ),
      h(
        "div.ma-actions",
        null,
        button("Nova unidade", () => {
          const u = newUnit(units.length + 1);
          units.push(u);
          this.unitSel = u.id;
          this.touch();
          this.render();
        }, "", "general/add"),
        button("Sugerir unidades", () => this.suggest(), "", "actions/lightning"),
      ),
      this.mappings.ignored.length || this.uncovered.length
        ? h("div.ma-ignored", null, h("div.afd-sec", null, "Tabelas sem conversão"), ...this.uncovered.map((t) => h("div.ma-row", null, h("span", null, t), h("button.link", { onclick: () => this.ignoreTable(t) }, "marcar como não convertida…"))), ...this.mappings.ignored.map(([, s, t, why], i) => h("div.ma-row.dim", null, `${s ? s + "." : ""}${t}: ${why}`, h("button.icon-btn", { onclick: () => (this.mappings.ignored.splice(i, 1), this.touch(), this.render()) }, icon("general/delete")))))
        : "",
    );
    return h(
      "div.ma-mapping",
      null,
      h("div.ma-mapbar", null, button("Salvar mapeamento", () => this.saveMappings(), this.mapDirty ? "primary" : "", "general/save"), button("Validar (inclui consultas)", async () => (await this.validate(true), this.render()), "", "actions/checked"), h("span.dim", null, `versão ${this.mappings.version}${this.mapDirty ? " · alterações não salvas" : ""}`)),
      h("div.ma-mapbody", null, list, sel ? this.unitEditor(sel, chk(sel)) : h("div.dim.ma-pad", null, "Crie ou sugira unidades de reconciliação.")),
    );
  }

  private async ignoreTable(full: string) {
    const m = modal("Tabela não convertida intencionalmente", { width: 480 });
    const reason = h("input.input", { placeholder: "justificativa (obrigatória)" }) as HTMLInputElement;
    m.body.append(h("div", null, full), h("label.field", { style: "margin-top:8px" }, h("span", null, "Justificativa"), reason));
    m.footer.append(button("Cancelar", () => m.close()), button("Marcar", () => {
      if (!reason.value.trim()) return toast("Informe a justificativa.", "error");
      const [s, t] = full.includes(".") ? [full.slice(0, full.indexOf(".")), full.slice(full.indexOf(".") + 1)] : ["", full];
      this.mappings.ignored.push(["source", s, t, reason.value.trim()]);
      this.uncovered = this.uncovered.filter((x) => x !== full);
      this.touch();
      m.close();
      this.render();
    }, "primary"));
  }

  private async suggest() {
    if (this.mapDirty) await this.saveMappings();
    const list = await audit.suggest(this.project.id).catch((e) => (toast(errText(e), "error"), null));
    if (!list) return;
    if (!list.length) return toast("Nenhuma sugestão nova: as tabelas da origem já têm unidade ou não há nomes correspondentes.", "info", 6000);
    const m = modal(`Sugestões de unidades (${list.length})`, { width: 760 });
    const chosen = new Set(list.map((u) => u.id));
    m.body.append(
      h("div.hint", null, "Critérios determinísticos (nomes, tipos, chaves). Sugestões não provam equivalência: confirme cada unidade e cada campo antes de capturar a baseline."),
      ...list.map((u) =>
        h(
          "div.ma-sugg",
          null,
          this.check(`${u.source.schema}.${u.source.table} → ${u.target.schema}.${u.target.table}`, true, (on) => (on ? chosen.add(u.id) : chosen.delete(u.id))),
          h("div.dim", null, `identidade sugerida: ${u.identity.kind === "key" ? u.identity.source.map((k) => k.column).join(", ") : "nenhuma (sem chave primária correspondente)"} · ${u.fields.filter((f) => f.kind === "map").length} campos com correspondência, ${u.fields.filter((f) => f.kind === "unmapped").length} sem correspondência`),
          h("div.ma-crit", null, ...u.fields.filter((f) => f.kind === "map").slice(0, 12).map((f) => h("span", null, `${f.sourceCols[0]} → ${f.targetCol} (${f.suggestedBy.join("; ")})`))),
        ),
      ),
    );
    m.footer.append(button("Cancelar", () => m.close()), button("Adicionar como rascunho", () => {
      for (const u of list) if (chosen.has(u.id)) this.mappings.units.push(u);
      this.touch();
      m.close();
      this.render();
    }, "primary"));
  }

  private datasetEditor(label: string, d: Dataset, s: Structure | null, onChange: () => void) {
    const tables = this.tablesOf(s);
    const kind = this.select([["table", "Tabela"], ["query", "Consulta somente leitura"]], d.kind, (v) => ((d.kind = v as Dataset["kind"]), onChange()));
    const tableSel = this.select([["", "—"], ...tables.map((t) => [`${t.schema}\u0001${t.name}`, `${t.schema ? t.schema + "." : ""}${t.name}${t.kind !== "table" ? ` (${t.kind})` : ""}`] as [string, string])], `${d.schema}\u0001${d.table}`, (v) => {
      const [sch, tb] = v.split("\u0001");
      d.schema = sch ?? "";
      d.table = tb ?? "";
      onChange();
    });
    const sql = h("textarea.input.ma-sql", { rows: 5, spellcheck: false, placeholder: "SELECT c.id AS id, c.nome AS nome FROM clientes c WHERE c.ativo = true" }, d.sql) as HTMLTextAreaElement;
    sql.onchange = () => ((d.sql = sql.value), onChange());
    return h(
      "div.ma-ds",
      null,
      h("div.afd-sec", null, label),
      h("div.ma-row", null, kind, d.kind === "table" ? tableSel : ""),
      d.kind === "query" ? h("div", null, sql, h("div.hint", null, "Uma única instrução SELECT, com alias em todas as colunas. Executada em transação somente leitura quando o banco permite (PostgreSQL, MySQL, Firebird); no SQL Server use um login somente leitura.")) : "",
      this.predEditor("Filtros do conjunto (valores sempre como parâmetros)", d.filters, this.colsOf(s, d), onChange),
    );
  }

  private predEditor(label: string, preds: Pred[], cols: string[], onChange: () => void) {
    const box = h("div.ma-list");
    const dl = "dl" + uid();
    const render = () =>
      box.replaceChildren(
        h("datalist", { id: dl }, ...cols.map((c) => h("option", { value: c }))),
        ...preds.map((p, i) =>
          h(
            "div.ma-row",
            null,
            this.input(p.column, (v) => ((p.column = v), onChange()), { list: dl, placeholder: "coluna", style: "width:150px" }),
            this.select(OPS.map((o) => [o, o]), p.op || "=", (v) => ((p.op = v), onChange(), render())),
            ["is null", "is not null"].includes(p.op) ? "" : this.input(p.values.join(p.op === "in" ? ", " : ""), (v) => ((p.values = p.op === "in" ? v.split(",").map((x) => x.trim()) : [v]), onChange()), { placeholder: p.op === "in" ? "valores separados por vírgula" : "valor" }),
            h("button.icon-btn", { onclick: () => (preds.splice(i, 1), onChange(), render()) }, icon("general/delete")),
          ),
        ),
        h("button.btn", { onclick: () => (preds.push({ column: cols[0] ?? "", op: "=", values: [""] }), onChange(), render()) }, icon("general/add"), "Condição"),
      );
    render();
    return h("div.field", null, h("span.dim", null, label), box);
  }

  private keyEditor(label: string, keys: { column: string; rules: Rules }[], cols: string[], onChange: () => void) {
    const box = h("div.ma-list");
    const dl = "dlk" + uid();
    const render = () =>
      box.replaceChildren(
        h("datalist", { id: dl }, ...cols.map((c) => h("option", { value: c }))),
        ...keys.map((k, i) =>
          h("div.ma-row", null, this.input(k.column, (v) => ((k.column = v), onChange()), { list: dl, placeholder: "coluna", style: "width:160px" }), this.rulesButton(k.rules, onChange, true), h("button.icon-btn", { onclick: () => (keys.splice(i, 1), onChange(), render()) }, icon("general/delete"))),
        ),
        h("button.btn", { onclick: () => (keys.push({ column: cols[0] ?? "", rules: emptyRules() }), onChange(), render()) }, icon("general/add"), "Coluna"),
      );
    render();
    return h("div.field", null, h("span.dim", null, label), box);
  }

  private rulesSummary(r: Rules) {
    const d: string[] = [];
    if (r.trim) d.push("trim");
    if (r.caseInsensitive) d.push("sem caixa");
    if (r.unicodeNfc) d.push("NFC");
    if (r.removeAccents) d.push("sem acentos");
    if (r.stripPunct) d.push("sem pontuação");
    if (r.emptyIsNull) d.push("vazio=nulo");
    if (r.nullSentinels.length) d.push("sentinelas");
    if (r.enumMap.length) d.push("mapa de valores");
    if (r.trueValues.length || r.falseValues.length) d.push("booleanos");
    if (r.dateFormat) d.push(`data ${r.dateFormat}`);
    if (r.dateOnly) d.push("só data");
    if (r.tsPrecision != null) d.push(`precisão ${r.tsPrecision}`);
    if (r.naiveOffsetSource || r.naiveOffsetTarget) d.push("fuso");
    if (r.decimalScale != null) d.push(`escala ${r.decimalScale}`);
    if (r.tolAbs || r.tolRel) d.push("tolerância");
    if (r.jsonCanonical) d.push("JSON");
    if (r.compareAs) d.push(`como ${r.compareAs}`);
    return d.length ? d.join(", ") : "sem regras";
  }

  private rulesButton(r: Rules, onChange: () => void, key = false) {
    const b = h("button.btn.ma-rules", { title: "Regras explícitas de normalização" }, icon("general/settings"), this.rulesSummary(r)) as HTMLButtonElement;
    b.onclick = () => this.rulesDialog(r, () => ((b.lastChild!.textContent = this.rulesSummary(r)), onChange()), key);
    return b;
  }

  private rulesDialog(r: Rules, done: () => void, key: boolean) {
    const m = modal(key ? "Regras da chave" : "Regras do campo", { width: 640 });
    const ck = (label: string, k: keyof Rules, title = "") => this.check(label, r[k] as boolean, (v) => ((r as unknown as Record<string, unknown>)[k] = v), title);
    const txt = (label: string, k: keyof Rules, ph = "") => h("label.field", null, h("span", null, label), this.input(String(r[k] ?? ""), (v) => ((r as unknown as Record<string, unknown>)[k] = v), { placeholder: ph }));
    const list = (label: string, k: "nullSentinels" | "trueValues" | "falseValues", ph: string) => h("label.field", null, h("span", null, label), this.input((r[k] as string[]).join(", "), (v) => (r[k] = v.split(",").map((x) => x.trim()).filter((x) => x !== "")), { placeholder: ph }));
    const num = (label: string, k: "tsPrecision" | "decimalScale", ph: string) => h("label.field", null, h("span", null, label), this.input(r[k] == null ? "" : String(r[k]), (v) => (r[k] = v.trim() === "" ? null : Math.max(0, Math.min(9, Number(v)))), { type: "number", placeholder: ph }));
    const sideSel = (k: "sentinelSide" | "dateFormatSide") => this.select([["both", "nos dois lados"], ["source", "só na origem"], ["target", "só no destino"]], r[k], (v) => (r[k] = v as Rules["sentinelSide"]));
    const enumT = h("textarea.input", { rows: 3, spellcheck: false, placeholder: "A=ativo\nI=inativo" }, r.enumMap.map(([a, b]) => `${a}=${b}`).join("\n")) as HTMLTextAreaElement;
    enumT.onchange = () => (r.enumMap = enumT.value.split("\n").map((l) => l.split("=") as [string, string]).filter((x) => x.length === 2));
    m.body.append(
      h("div.hint", null, "Por padrão nada é alterado: sem trim, sem ignorar maiúsculas ou acentos, nulo nunca vira zero ou vazio, zeros à esquerda são mantidos e decimais nunca passam por ponto flutuante. Toda regra fica registrada na baseline e no relatório."),
      h("div.ma-rgrid", null, ck("Remover espaços nas pontas", "trim"), ck("Ignorar maiúsculas/minúsculas", "caseInsensitive"), ck("Normalização Unicode (NFC)", "unicodeNfc"), ck("Ignorar acentos", "removeAccents"), ck("Remover pontuação (documentos, códigos)", "stripPunct", "Mantém zeros à esquerda"), ck("Texto vazio equivale a nulo", "emptyIsNull"), ck("JSON canônico (ordem das chaves)", "jsonCanonical"), ck("Comparar somente a data (autorizado)", "dateOnly")),
      h("div.form-grid", { style: "margin-top:10px" },
        list("Sentinelas tratadas como nulo", "nullSentinels", "1900-01-01, 0"), h("label.field", null, h("span", null, "Aplicar sentinelas"), sideSel("sentinelSide")),
        txt("Formato de data em texto", "dateFormat", "DD/MM/YYYY ou YYYYMMDD HHmmss"), h("label.field", null, h("span", null, "Formato aplicado"), sideSel("dateFormatSide")),
        num("Dígitos de fração de segundo", "tsPrecision", "ex.: 3 (milissegundos)"), num("Escala decimal (arredondar)", "decimalScale", "ex.: 2"),
        txt("Fuso das datas sem fuso da origem", "naiveOffsetSource", "-03:00"), txt("Fuso das datas sem fuso do destino", "naiveOffsetTarget", "+00:00"),
        txt("Tolerância absoluta (exige valores guardados)", "tolAbs", "0.01"), txt("Tolerância relativa", "tolRel", "0.001"),
        list("Valores verdadeiros", "trueValues", "S, 1, Y"), list("Valores falsos", "falseValues", "N, 0"),
        h("label.field", null, h("span", null, "Comparar como"), this.select([["", "tipo da coluna"], ["text", "texto"], ["number", "número"]], r.compareAs, (v) => (r.compareAs = v))),
        h("label.field.span2", null, h("span", null, "Mapa de valores da origem (de=para)"), enumT),
      ),
      h("div.hint", null, "Fusos aceitos: deslocamentos fixos (ex.: -03:00). Fusos com horário de verão (America/Sao_Paulo) não são suportados nesta versão."),
    );
    m.footer.append(button("Fechar", () => (m.close(), done()), "primary"));
  }

  private unitEditor(u: Unit, chk: UnitCheck | undefined) {
    const onChange = () => this.touch();
    const rerender = () => (this.touch(), this.render());
    const srcCols = this.colsOf(this.src, u.source);
    const dstCols = this.colsOf(this.dst, u.target);
    const id = u.identity;
    const fieldsBox = h("div.ma-fields");
    const dlS = "dls" + uid();
    const dlT = "dlt" + uid();
    const renderFields = () => {
      const kinds: [FieldKind, string][] = [["map", "1 → 1"], ["concat", "vários → 1 (concatenação)"], ["split", "1 → vários (parte)"], ["constant", "constante no destino"], ["derived", "derivado (sem regra verificável)"], ["ignored", "descartado (com justificativa)"], ["target_only", "criado só no destino"], ["unmapped", "não mapeado"]];
      fieldsBox.replaceChildren(
        h("datalist", { id: dlS }, ...srcCols.map((c) => h("option", { value: c }))),
        h("datalist", { id: dlT }, ...dstCols.map((c) => h("option", { value: c }))),
        h("div.ma-frow.head", null, h("span", null, "Origem"), h("span", null, "Relação"), h("span", null, "Destino"), h("span", null, "Regras"), h("span", null, "Estado")),
        ...u.fields.map((f, i) => {
          const needsSrc = !["constant", "target_only"].includes(f.kind);
          const needsDst = !["ignored", "unmapped", "derived"].includes(f.kind) || f.kind === "derived";
          const state = f.kind === "unmapped" ? "não mapeado" : f.kind === "ignored" ? (f.justification ? "ignorado com justificativa" : "falta justificativa") : f.kind === "derived" ? "não verificável" : f.kind === "target_only" ? "só no destino" : f.confirmed ? (["concat", "split", "constant"].includes(f.kind) ? "derivado com regra" : "mapeado") : "sugestão a confirmar";
          return h(
            "div.ma-frow",
            { title: f.suggestedBy.length ? "Sugerido por: " + f.suggestedBy.join("; ") : "" },
            needsSrc ? this.input(f.sourceCols.join(", "), (v) => ((f.sourceCols = v.split(",").map((x) => x.trim()).filter(Boolean)), onChange()), { list: dlS, placeholder: f.kind === "concat" ? "col1, col2" : "coluna" }) : this.input(f.constant, (v) => ((f.constant = v), onChange()), { placeholder: f.kind === "constant" ? "valor esperado" : "—", disabled: f.kind !== "constant" }),
            h("div.ma-row", null, this.select(kinds, f.kind, (v) => ((f.kind = v as FieldKind), rerender())), f.kind === "concat" || f.kind === "split" ? this.input(f.sep, (v) => ((f.sep = v), onChange()), { placeholder: "separador", style: "width:70px" }) : "", f.kind === "split" ? this.input(String(f.index + 1), (v) => ((f.index = Math.max(0, Number(v) - 1)), onChange()), { type: "number", min: 1, style: "width:60px", title: "parte (1 = primeira)" }) : ""),
            needsDst ? this.input(f.targetCol, (v) => ((f.targetCol = v), onChange()), { list: dlT, placeholder: "coluna de destino" }) : f.kind === "ignored" ? this.input(f.justification, (v) => ((f.justification = v), rerender()), { placeholder: "justificativa (obrigatória)" }) : h("span"),
            ["map", "concat", "split", "constant"].includes(f.kind) ? this.rulesButton(f.rules, onChange) : h("span"),
            h(
              "div.ma-row",
              null,
              ["map", "concat", "split", "constant"].includes(f.kind) ? this.check("confirmado", f.confirmed, (v) => ((f.confirmed = v), rerender())) : "",
              this.check("sensível", f.sensitive, (v) => ((f.sensitive = v), onChange()), "Mascarado na interface e nos relatórios de resumo"),
              h("span.dim", null, state),
              h("button.icon-btn", { onclick: () => (u.fields.splice(i, 1), rerender()) }, icon("general/delete")),
            ),
          );
        }),
        h(
          "div.ma-actions",
          null,
          button("Campo", () => (u.fields.push({ id: "f" + uid().slice(-6), kind: "map", sourceCols: [], targetCol: "", sep: "", index: 0, constant: "", rules: emptyRules(), justification: "", confirmed: false, sensitive: false, suggestedBy: [] }), rerender()), "", "general/add"),
          button("Listar colunas sem cobertura", () => {
            const used = new Set([...u.fields.flatMap((f) => f.sourceCols), ...id.source.map((k) => k.column)]);
            for (const c of srcCols.filter((c) => !used.has(c))) u.fields.push({ id: "f" + uid().slice(-6), kind: "unmapped", sourceCols: [c], targetCol: "", sep: "", index: 0, constant: "", rules: emptyRules(), justification: "", confirmed: false, sensitive: false, suggestedBy: [] });
            rerender();
          }),
          u.fields.some((f) => !f.confirmed && f.kind === "map" && f.targetCol)
            ? button("Confirmar todos os sugeridos…", async () => {
                const n = u.fields.filter((f) => !f.confirmed && f.kind === "map" && f.targetCol).length;
                if (!(await confirmDialog("Confirmar sugestões", `Confirmar ${n} correspondências sugeridas por nome? Nomes iguais não provam o mesmo significado (ex.: "data" pode ser nascimento ou cadastro). Revise antes.`, "Confirmar"))) return;
                for (const f of u.fields) if (f.kind === "map" && f.targetCol) f.confirmed = true;
                rerender();
              })
            : "",
        ),
      );
    };
    renderFields();
    const exclBox = h("div.ma-list");
    const renderExcl = () =>
      exclBox.replaceChildren(
        ...u.exclusions.map((e, i) => h("div.ma-excl", null, this.predEditor("Condição da exclusão", e.predicate, srcCols, onChange), this.input(e.reason, (v) => ((e.reason = v), onChange()), { placeholder: "justificativa (obrigatória)" }), h("button.icon-btn", { onclick: () => (u.exclusions.splice(i, 1), onChange(), renderExcl()) }, icon("general/delete")))),
        h("button.btn", { onclick: () => (u.exclusions.push({ predicate: [], reason: "" }), onChange(), renderExcl()) }, icon("general/add"), "Exclusão justificada"),
      );
    renderExcl();
    const relBox = h("div.ma-list");
    const renderRel = () =>
      relBox.replaceChildren(
        ...u.relationships.map((r, i) =>
          h(
            "div.ma-row",
            null,
            this.input(r.name, (v) => ((r.name = v), onChange()), { placeholder: "nome", style: "width:130px" }),
            this.select([["", "unidade pai…"], ...this.mappings.units.filter((x) => x.id !== u.id).map((x) => [x.id, x.name] as [string, string])], r.parentUnit, (v) => ((r.parentUnit = v), onChange())),
            this.input(r.sourceCols.join(", "), (v) => ((r.sourceCols = v.split(",").map((x) => x.trim()).filter(Boolean)), onChange()), { list: dlS, placeholder: "FK na origem" }),
            this.input(r.targetCols.join(", "), (v) => ((r.targetCols = v.split(",").map((x) => x.trim()).filter(Boolean)), onChange()), { list: dlT, placeholder: "FK no destino" }),
            h("button.icon-btn", { onclick: () => (u.relationships.splice(i, 1), onChange(), renderRel()) }, icon("general/delete")),
          ),
        ),
        h("button.btn", { onclick: () => (u.relationships.push({ id: "r" + uid().slice(-6), name: "", parentUnit: "", sourceCols: [], targetCols: [] }), onChange(), renderRel()) }, icon("general/add"), "Relacionamento"),
      );
    renderRel();
    const map = id.map;
    return h(
      "div.ma-unit-ed",
      null,
      chk && (chk.errors.length || chk.warnings.length || chk.alerts.length)
        ? h("div.ma-checks", null, ...chk.errors.map((e) => h("div.ma-bad", null, "✕ ", e)), ...chk.warnings.map((w) => h("div.ma-warn", null, "⚠ ", w)), ...chk.alerts.map((a) => h("div.dim", null, "◇ ", a.message, h("span.dim", null, ` — ${a.nature}`))))
        : "",
      h(
        "div.form-grid",
        null,
        h("label.field", null, h("span", null, "Nome"), this.input(u.name, (v) => ((u.name = v), onChange()))),
        h("label.field", null, h("span", null, "Criticidade"), this.select([["alta", "alta"], ["media", "média"], ["baixa", "baixa"]], u.criticality, (v) => ((u.criticality = v as Unit["criticality"]), onChange()))),
        h("label.field.span2", null, h("span", null, "Descrição"), this.input(u.description, (v) => ((u.description = v), onChange()))),
        h("label.field", null, h("span", null, "Cardinalidade esperada"), this.select([["1:1", "um para um"], ["1:N", "um para vários"], ["N:1", "vários para um"]], u.cardinality, (v) => ((u.cardinality = v as Unit["cardinality"]), rerender()))),
        h("div.field", null, this.check("Conjuntos normalizados ao mesmo grão por consulta", u.normalized, (v) => ((u.normalized = v), onChange()), "Torna 1:N/N:1 comparáveis como 1:1"), this.check("Unidade confirmada", u.confirmed, (v) => ((u.confirmed = v), rerender()))),
      ),
      h("div.ma-sides", null, this.datasetEditor("Origem", u.source, this.src, rerender), this.datasetEditor("Destino", u.target, this.dst, rerender)),
      h("div.ma-sides", null, h("div"), h("div", null, this.predEditor("Delimitação da carga no destino (lote, marcador de origem…)", u.targetScope, dstCols, onChange), this.check("Ignorar identidades que já existiam no destino antes da carga (exige baseline do destino)", u.excludePreexisting, (v) => ((u.excludePreexisting = v), onChange())))),
      h("div.afd-sec", null, "Identidade"),
      h(
        "div.ma-row",
        null,
        this.select([["key", "chave preservada / de negócio / composta"], ["map", "mapa de IDs (id_origem → id_destino)"], ["content", "conteúdo dos campos (com limitações)"], ["none", "sem identidade comparável"]], id.kind, (v) => ((id.kind = v as Unit["identity"]["kind"]), v === "map" && !id.map && (id.map = { side: "target", dataset: ds(), sourceCols: [], targetCols: [], allowDupTarget: false }), rerender())),
      ),
      id.kind === "key" || id.kind === "map" ? h("div.ma-sides", null, this.keyEditor("Chave na origem", id.source, srcCols, onChange), this.keyEditor("Chave no destino", id.target, dstCols, onChange)) : "",
      id.kind === "none" ? h("div.af-warn", null, icon("status/warning"), "Sem identidade, diferenças de volume não identificam quais registros faltaram, e o preenchimento só é comparado de forma agregada (indício).") : "",
      id.kind === "content" ? h("div.af-warn", null, icon("status/info"), "Identidade por conteúdo: um registro alterado aparece como ausente e extra, e não se sabe qual campo mudou.") : "",
      id.kind === "map" && map
        ? h(
            "div.ma-map",
            null,
            h("div.ma-row", null, h("span.dim", null, "O mapa está no banco da"), this.select([["target", "destino"], ["source", "origem"]], map.side, (v) => ((map.side = v as "source" | "target"), rerender()))),
            this.datasetEditor("Conjunto do mapa (tabela ou consulta)", map.dataset, map.side === "source" ? this.src : this.dst, rerender),
            h("div.ma-row", null, this.input(map.sourceCols.join(", "), (v) => ((map.sourceCols = v.split(",").map((x) => x.trim()).filter(Boolean)), onChange()), { placeholder: "colunas do id de origem" }), h("span", null, "→"), this.input(map.targetCols.join(", "), (v) => ((map.targetCols = v.split(",").map((x) => x.trim()).filter(Boolean)), onChange()), { placeholder: "colunas do id de destino" })),
            this.check("Vários IDs de origem podem virar o mesmo ID de destino (consolidação)", map.allowDupTarget, (v) => ((map.allowDupTarget = v), onChange())),
            h("div.hint", null, "O mapa é lido na reconciliação (ele é produzido pela conversão). IDs repetidos, sem correspondência ou apontando para registros inexistentes são relatados. IDs numéricos iguais nunca são tratados como a mesma entidade sem o mapa."),
          )
        : "",
      h("div.afd-sec", null, "Campos"),
      fieldsBox,
      h("div.afd-sec", null, "Exclusões justificadas (registros da origem fora da conversão)"),
      exclBox,
      h("div.afd-sec", null, "Relacionamentos"),
      relBox,
      h("div.hint", null, "Uma FK válida no destino ainda pode apontar para a entidade errada: a reconciliação compara a associação original (traduzida pelo mapa de IDs do pai, quando houver) e procura órfãos."),
      h("div.ma-actions", null, button("Excluir unidade", async () => {
        if (!(await confirmDialog("Excluir unidade", `Excluir "${u.name}" do mapeamento? Baselines e execuções antigas não mudam.`, "Excluir", true))) return;
        this.mappings.units = this.mappings.units.filter((x) => x.id !== u.id);
        this.unitSel = null;
        rerender();
      }, "danger")),
    );
  }

  // ---------------- 5. evidence & performance ----------------

  private pageEvidence() {
    const p = this.project;
    const pf = p.perf;
    const num = (label: string, k: keyof typeof pf, title = "") => h("label.field", { title }, h("span", null, label), this.input(String(pf[k]), (v) => ((pf as unknown as Record<string, number>)[k] = Math.max(0, Number(v) || 0)), { type: "number" }));
    const est = h("div.dim");
    return h(
      "div",
      null,
      this.card(
        "Nível de evidência da baseline",
        this.select([["basic", "Básico — metadados, contagens e perfilamento"], ["identity", "Identidade — todas as identidades e multiplicidades"], ["fields", "Campos selecionados — identidades e digest/valor canônico por campo"]], p.evidenceLevel, (v) => (p.evidenceLevel = v as Project["evidenceLevel"])),
        h("ul.ma-ul", null, h("li", null, "Básico detecta diferenças agregadas, mas não lista registros ausentes."), h("li", null, "Identidade permite listar ausentes, extras e duplicados."), h("li", null, "Campos permite localizar perdas de preenchimento e divergências por registro."), h("li", null, "Uma baseline só com contagens não reconstrói depois as identidades se a origem mudar.")),
        this.check("Guardar valores canônicos (necessário para tolerâncias e para mostrar valores; usa mais disco e guarda dados sensíveis)", p.storeValues, (v) => (p.storeValues = v)),
        h("div.ma-row", null, button("Estimar armazenamento", async () => {
          const r = await audit.estimate(p.id).catch(() => null);
          est.textContent = r ? `~${r.rows.toLocaleString("pt-BR")} registros (estimativa do catálogo) · ~${(r.bytes / 1048576).toFixed(1)} MB de evidência. A captura completa lê todas as linhas das unidades confirmadas.` : "Execute a descoberta estrutural primeiro.";
        }), est),
      ),
      this.card(
        "Consistência temporal",
        this.select([["snapshot", "Snapshot consistente suportado pelo banco"], ["frozen", "Base congelada para a conversão (+ snapshot quando possível)"], ["watermark", "Recorte por lote ou watermark (filtros das unidades)"], ["none", "Leitura sem garantia de snapshot"]], p.consistency, (v) => (p.consistency = v as Project["consistency"])),
        h("label.field", null, h("span", null, "Observação (lote, watermark, janela de congelamento)"), this.input(p.watermarkNote, (v) => (p.watermarkNote = v))),
        h("ul.ma-ul", null, h("li", null, "PostgreSQL: REPEATABLE READ READ ONLY; várias conexões compartilham o snapshot (pg_export_snapshot)."), h("li", null, "MySQL/MariaDB: snapshot por conexão (InnoDB); com concorrência > 1 as unidades podem ver instantes diferentes."), h("li", null, "SQL Server: SNAPSHOT só com ALLOW_SNAPSHOT_ISOLATION ligado; senão a leitura não tem garantia."), h("li", null, "Firebird: transação SNAPSHOT."), h("li", null, "Transações longas seguram versões antigas no banco: prefira janelas curtas ou uma base congelada."), h("li", null, "Origem e destino nunca são lidos no mesmo instante: a comparação usa a baseline congelada.")),
      ),
      this.card(
        "Desempenho",
        h("label.field", null, h("span", null, "Estratégia"), this.select([["quick", "Análise rápida (estimativas identificadas, sem aprovação)"], ["volume", "Auditoria de volume (contagens exatas e perfil)"], ["identity", "Auditoria de identidade (varredura completa das chaves)"], ["fields", "Auditoria de campos selecionados"], ["deep", "Diagnóstico aprofundado"]], pf.mode, (v) => (pf.mode = v as typeof pf.mode))),
        h(
          "div.form-grid",
          null,
          num("Concorrência global", "concurrency"),
          num("Conexões por banco", "perConnection"),
          num("Tempo limite por consulta (s, 0 = sem)", "timeoutSecs"),
          num("Registros em memória por bloco ordenado", "batchRows", "Acima disso os blocos vão para o disco (ordenação externa)"),
          num("Limite de disco (MB)", "diskMb"),
          num("Exemplos visíveis por lista", "maxExamples"),
          num("Orçamento de consultas (0 = ilimitado)", "queryBudget"),
          num("Execuções mantidas (0 = todas)", "retention"),
        ),
        this.check("Excluir BLOBs e binários da comparação", pf.excludeLobs, (v) => (pf.excludeLobs = v)),
        h("div.hint", null, "Leitura em streaming, sem carregar tabelas em memória, sem criar índices ou tabelas nos bancos auditados e sem consulta por registro. Se o disco ou o orçamento acabar, a unidade fica incompleta (nunca vira amostragem silenciosa)."),
      ),
      h("div.ma-actions", null, button("Salvar", () => this.saveProject(), "primary"), button("Próximo: baseline", () => this.go("baseline"))),
    );
  }

  // ---------------- 6. baseline ----------------

  private historyTable(items: HistoryItem[], kind: "baseline" | "run") {
    if (!items.length) return h("div.dim", null, "Nenhuma ainda.");
    return h(
      "table.ma-table",
      null,
      h("thead", null, h("tr", null, ...(kind === "baseline" ? ["Baseline", "Lado", "Início", "Estado", "Nível", "Consistência", "Integridade", ""] : ["Execução", "Baseline", "Início", "Estado", "Resumo", "Integridade", ""]).map((x) => h("th", null, x)))),
      h(
        "tbody",
        null,
        ...items.map((b) =>
          h(
            "tr",
            null,
            h("td", null, h("code", null, b.id), b.note ? h("div.dim", null, b.note) : ""),
            kind === "baseline" ? h("td", null, b.side === "source" ? "origem" : "destino antes da carga") : h("td", null, h("code", null, b.baselineId ?? "")),
            h("td", null, fmtTime(b.startedAt)),
            h("td", null, STATUS_LABEL[b.status] ?? b.status),
            kind === "baseline" ? h("td", null, b.level ?? "") : h("td.dim", null, b.summary ?? ""),
            kind === "baseline" ? h("td.dim", null, b.consistency ?? "") : "",
            h("td", { class: b.integrity.ok ? "ma-ok" : "ma-bad", title: b.integrity.problems.join("\n") }, b.integrity.ok ? "íntegra" : `problema: ${b.integrity.problems[0] ?? ""}`),
            h(
              "td",
              null,
              kind === "run" ? h("button.link", { onclick: () => this.openRun(b.id) }, "abrir") : "",
              h("button.icon-btn", {
                title: "Excluir",
                onclick: async () => {
                  if (!(await confirmDialog("Excluir", `Excluir ${kind === "baseline" ? "a baseline" : "a execução"} ${b.id} e suas evidências (vão para a lixeira)?`, "Excluir", true))) return;
                  await audit.deleteArtifact(this.project.id, kind, b.id).catch((e) => toast(errText(e), "error"));
                  this.loadHistory();
                },
              }, icon("general/delete")),
            ),
          ),
        ),
      ),
    );
  }

  private pageBaseline() {
    const confirmed = this.mappings.units.filter((u) => u.confirmed);
    const note = h("input.input", { placeholder: "observação (ex.: base congelada em 10/10, lote 42)" }) as HTMLInputElement;
    const capture = (side: "source" | "target") => async () => {
      if (this.mapDirty) await this.saveMappings();
      if (!confirmed.length) return toast("Confirme ao menos uma unidade no mapeamento.", "info");
      const label = side === "source" ? "Captura da baseline da origem" : "Captura do destino antes da carga";
      const m = await this.runJob(label, (job) => audit.capture(job, this.project.id, side, null, note.value.trim()));
      if (m) {
        const bad = m.units.filter((u) => u.status !== "complete");
        notify(`${label}: ${STATUS_LABEL[m.status] ?? m.status}`, bad.length ? `${bad.length} unidade(s) não verificadas: ${bad.map((u) => `${u.unitId} (${u.error})`).join("; ")}` : `${m.units.length} unidades capturadas. Consistência: ${m.consistency.obtained}.`, bad.length ? "error" : "ok", [], 12000);
        this.loadHistory();
      }
    };
    return h(
      "div",
      null,
      this.card(
        "Baseline da origem (estado antes da conversão)",
        h("div.dim", null, `${confirmed.length} unidade(s) confirmada(s) · nível "${this.project.evidenceLevel}" · consistência "${this.project.consistency}" · estratégia "${this.project.perf.mode}". A baseline é imutável e versionada: manifesto JSON com digest, evidências em arquivos ordenados com SHA-256.`),
        note,
        h("div.ma-actions", null, button("Capturar baseline da origem", capture("source"), "primary", "run/run")),
      ),
      this.card(
        "Destino antes da carga (opcional)",
        h("div.dim", null, "Registra as identidades que já existem no destino, para não confundi-las com a carga. Prefira também uma delimitação explícita (lote, marcador de origem) na unidade: diferenças de contagem antes/depois não identificam uma carga quando há atualizações ou escritas concorrentes."),
        h("div.ma-actions", null, button("Capturar estado atual do destino", capture("target"), "", "run/run")),
      ),
      this.card("Histórico de baselines", this.historyTable(this.history.baselines, "baseline")),
      h("div.ma-actions", null, button("Próximo: reconciliação", () => this.go("reconcile"))),
    );
  }

  // ---------------- 7. reconcile ----------------

  private pageReconcile() {
    const bls = this.history.baselines.filter((b) => b.side === "source" && b.integrity.ok);
    const pres = this.history.baselines.filter((b) => b.side === "target-pre" && b.integrity.ok);
    let bl = bls[0]?.id ?? "";
    let pre = "";
    let checkSource = true;
    return h(
      "div",
      null,
      this.card(
        "Reconciliar o destino com a baseline",
        h("div.dim", null, "Execute a conversão por fora do Rits e, depois, reconcilie. Cada reconciliação vira uma execução nova: o histórico é preservado e nada é sobrescrito."),
        h(
          "div.form-grid",
          null,
          h("label.field", null, h("span", null, "Baseline da origem"), this.select(bls.map((b) => [b.id, `${b.id} · ${fmtTime(b.startedAt)} · ${STATUS_LABEL[b.status]}`] as [string, string]), bl, (v) => (bl = v))),
          h("label.field", null, h("span", null, "Destino antes da carga"), this.select([["", "nenhuma"], ...pres.map((b) => [b.id, `${b.id} · ${fmtTime(b.startedAt)}`] as [string, string])], pre, (v) => (pre = v))),
        ),
        this.check("Verificar se a origem mudou desde a baseline (contagem e estrutura; informativo)", checkSource, (v) => (checkSource = v)),
        h("div.ma-actions", null, button("Reconciliar", async () => {
          if (!bl) return toast("Capture uma baseline íntegra da origem primeiro.", "info");
          if (this.mapDirty) await this.saveMappings();
          const r = await this.runJob("Reconciliação", (job) => audit.reconcile(job, this.project.id, bl, pre || null, null, checkSource));
          if (r) {
            this.run = r;
            this.runUnit = null;
            this.finding = null;
            await this.loadHistory();
            this.go("report");
          }
        }, "primary", "run/run")),
        !bls.length ? h("div.af-warn", null, icon("status/info"), "Nenhuma baseline íntegra da origem.") : "",
      ),
      this.card("Execuções", this.historyTable(this.history.runs, "run")),
    );
  }

  // ---------------- 8. report ----------------

  private async openRun(id: string) {
    const r = await audit.get<RunManifest>(this.project.id, "run", id).catch(() => null);
    if (!r?.manifest) return toast("Execução ilegível.", "error");
    if (!r.integrity.ok) toast(`Atenção: ${r.integrity.problems.join("; ")}`, "error", 8000);
    this.run = r.manifest;
    this.runUnit = null;
    this.finding = null;
    this.go("report");
  }

  private dimCell(d: Dim) {
    return h("td", { title: d.note }, resTag(d.result));
  }

  private pageReport() {
    const r = this.run;
    if (!r) {
      return h("div", null, this.card("Relatórios", h("div.dim", null, "Escolha uma execução."), this.historyTable(this.history.runs, "run")));
    }
    if (this.runUnit) return this.unitReport(r, r.units.find((u) => u.unitId === this.runUnit)!);
    const cov = (k: string, label: string) => {
      const [a, b] = r.coverage[k] ?? [0, 0];
      return h("div.ma-cov", null, h("b", null, `${a}/${b}`), h("span.dim", null, label));
    };
    const vol = r.units.filter((u) => u.volume.result === "compatible").length;
    const idv = (r.coverage.identity ?? [0])[0];
    const fv = (r.coverage.fields ?? [0])[0];
    const nokey = r.units.filter((u) => u.identity.result === "not_verified" && /identidade comparável/.test(u.identity.note)).length;
    const exportBtn = (label: string, format: string, ext: string, unitId: string | null = null, kind: string | null = null) =>
      button(label, async () => {
        const detailed = (document.getElementById("ma-detailed") as HTMLInputElement | null)?.checked ?? false;
        const path = await saveDialog({ defaultPath: `${this.project.name.replace(/[^\w-]+/g, "_")}-${r.id}${kind ? "-" + kind : ""}.${ext}` });
        if (!path) return;
        try {
          const n = await audit.export(this.project.id, r.id, format, unitId, kind, detailed, path);
          toast(`Exportado (${n})`, "ok");
        } catch (e) {
          toast(errText(e), "error");
        }
      }, "", "general/export");
    return h(
      "div",
      null,
      this.card(
        `Execução ${r.id} — ${STATUS_LABEL[r.status] ?? r.status}`,
        h("div.ma-summary", null, `Volume compatível em ${vol} unidade(s); identidade verificada em ${idv}; campos verificados em ${fv}; ${nokey} sem identidade comparável configurada.`),
        h("div.ma-covs", null, cov("volume", "volume"), cov("identity", "identidade"), cov("fields", "campos"), cov("relations", "relacionamentos")),
        h("div.dim", null, `Baseline ${r.baselineId}${r.targetPreBaselineId ? ` · destino antes da carga ${r.targetPreBaselineId}` : ""} · mapeamento v${r.mappingsVersion} · ${fmtTime(r.startedAt)} → ${fmtTime(r.finishedAt)}`),
        h("div.dim", null, `Consistência: ${r.consistency.obtained}`),
        ...r.consistency.notes.map((n) => h("div.hint", null, n)),
        ...r.sourceChanged.map((s) => h("div.af-warn", null, icon("status/warning"), s)),
        ...r.errors.map((s) => h("div.af-warn", null, icon("status/error"), s)),
        h("div.ma-actions", null, exportBtn("Relatório HTML", "html", "html"), exportBtn("Manifesto JSON", "json", "json"), exportBtn("Resumo CSV", "csv-summary", "csv"), h("label.check", { title: "Inclui valores e identidades sensíveis sem máscara" }, h("input", { type: "checkbox", id: "ma-detailed" }), "exportação detalhada (sem máscara)")),
      ),
      r.uncoveredTables.length ? this.card("Tabelas inteiramente sem cobertura", h("div.af-warn", null, icon("status/warning"), `${r.uncoveredTables.length} tabela(s) da origem sem unidade nem exclusão justificada (possivelmente esquecidas): ${r.uncoveredTables.join(", ")}`)) : null,
      this.card(
        "Unidades",
        h(
          "table.ma-table.ma-click",
          null,
          h("thead", null, h("tr", null, ...["Unidade", "Execução", "Volume", "Identidade", "Campos", "Relacionamentos", "Origem", "Esperado", "Destino", "Ausentes", "Extras", "Dupl."].map((x) => h("th", null, x)))),
          h(
            "tbody",
            null,
            ...r.units.map((u) =>
              h(
                "tr",
                { onclick: () => ((this.runUnit = u.unitId), (this.finding = null), this.render()) },
                h("td", null, u.name, u.criticality === "alta" ? h("span.tag.err", null, "alta") : ""),
                h("td", null, STATUS_LABEL[u.status] ?? u.status),
                this.dimCell(u.volume),
                this.dimCell(u.identity),
                this.dimCell(u.fieldsDim),
                this.dimCell(u.relations),
                h("td", null, u.counts.source?.toLocaleString("pt-BR") ?? "—"),
                h("td", null, u.counts.expected?.toLocaleString("pt-BR") ?? "—"),
                h("td", null, u.counts.target?.toLocaleString("pt-BR") ?? "—"),
                h("td", { class: u.missing ? "ma-bad" : "" }, String(u.missing)),
                h("td", { class: u.extra ? "ma-bad" : "" }, String(u.extra)),
                h("td", { class: u.multiplicity ? "ma-bad" : "" }, String(u.multiplicity)),
              ),
            ),
          ),
        ),
      ),
      r.structureAlerts.length ? this.card("Alertas estruturais (riscos, não perdas comprovadas)", ...r.structureAlerts.map((a) => h("div", null, a.unit ? h("b", null, a.unit + ": ") : "", a.message))) : null,
      this.card("Outras execuções", this.historyTable(this.history.runs, "run")),
    );
  }

  private unitReport(r: RunManifest, u: UnitResult) {
    const c = u.counts;
    const kv = (k: string, v: string | number | null) => h("div.ma-kv", null, h("span.dim", null, k), h("b", null, v == null ? "—" : typeof v === "number" ? v.toLocaleString("pt-BR") : v));
    const kinds = Object.entries(u.findings).filter(([, f]) => f.records > 0 || ["missing", "extra", "fields"].includes(f.path.replace(/\.tsv$/, "")));
    const findingsBox = h("div.ma-findings");
    if (this.finding) this.loadFindings(findingsBox, r, u);
    return h(
      "div",
      null,
      h("div.ma-actions", null, button("← Todas as unidades", () => ((this.runUnit = null), this.render()))),
      this.card(
        u.name,
        u.error ? h("div.af-warn", null, icon("status/error"), u.error) : "",
        h(
          "table.ma-table",
          null,
          h("tbody", null, ...([["Volume", u.volume], ["Identidade", u.identity], ["Campos", u.fieldsDim], ["Relacionamentos", u.relations]] as [string, Dim][]).map(([l, d]) => h("tr", null, h("th", null, l), h("td", null, resTag(d.result)), h("td", null, d.note)))),
        ),
        h("div.ma-kvs", null, kv("origem elegível", c.source), kv("exclusões justificadas", c.excluded), kv("esperado pela regra", c.expected), kv("observado no destino (escopo)", c.target), kv("pré-existentes no destino", c.preexisting), kv("diferença", c.diff), kv("contagem", c.kind === "exact" ? "exata" : c.kind === "estimated" ? "estimativa" : "não executada"), kv("chaves nulas (origem/destino)", `${u.nullKeysSource} / ${u.nullKeysTarget}`), kv("colisões de normalização", u.collisions), kv("não comparadas (ambíguas)", u.ambiguous)),
        h("div.hint", null, "Regra: ", c.rule),
        ...Object.entries(u.mapIssues).filter(([, v]) => v > 0).map(([k, v]) => h("div", null, h("span.dim", null, k + ": "), h("b", null, v.toLocaleString("pt-BR")))),
        ...Object.entries(u.relationIssues).map(([k, v]) => h("div", { class: v ? "ma-bad" : "dim" }, `${k}: ${v}`)),
        ...u.warnings.map((w) => h("div.af-warn", null, icon("status/warning"), w)),
      ),
      u.fields.length
        ? this.card(
            "Campos",
            h(
              "table.ma-table",
              null,
              h("thead", null, h("tr", null, ...["Campo", "Resultado", "Comparados", "Iguais", "Vazios nos dois", "Perdidos no destino", "Criados no destino", "Divergentes", "Inválidos", "Não comparados", "Preenchidos origem/destino (agregado)"].map((x) => h("th", null, x)))),
              h("tbody", null, ...u.fields.map((f) => h("tr", { title: f.note }, h("td", null, f.label, f.derived ? h("span.dim", null, " (derivado)") : ""), h("td", null, resTag(f.result)), h("td", null, String(f.compared)), h("td", null, String(f.equal)), h("td", null, String(f.bothEmpty)), h("td", { class: f.lost ? "ma-bad" : "" }, String(f.lost)), h("td", { class: f.created ? "ma-warn" : "" }, String(f.created)), h("td", { class: f.divergent ? "ma-bad" : "" }, String(f.divergent)), h("td", null, String(f.invalid)), h("td", null, String(f.notCompared)), h("td.dim", null, f.aggregate ? `${f.aggregate[0]} / ${f.aggregate[1]}` : "—")))),
            ),
            h("div.hint", null, "Sem identidade comparável, a diferença agregada de preenchimento é apenas um indício, não uma lista de perdas por registro. Contagens iguais de preenchidos não provam valores iguais."),
          )
        : null,
      u.unmappedSource.length ? this.card("Campos da origem sem mapeamento", h("div", null, u.unmappedSource.join(", "))) : null,
      u.unsourcedRequiredTarget.length ? this.card("Campos obrigatórios do destino sem fonte", h("div", null, u.unsourcedRequiredTarget.join(", "))) : null,
      this.card(
        "Evidências",
        h("div.ma-kinds", null, ...kinds.map(([k, f]) => h("button.btn", { class: this.finding?.kind === k ? "primary" : "", onclick: () => ((this.finding = { kind: k, offset: 0, reveal: false }), this.render()) }, `${FINDING_LABEL[k] ?? k} (${f.records.toLocaleString("pt-BR")})`))),
        findingsBox,
      ),
    );
  }

  private async loadFindings(box: HTMLElement, r: RunManifest, u: UnitResult) {
    const f = this.finding!;
    const page = 100;
    const res = await audit.findings(this.project.id, r.id, u.unitId, f.kind, f.offset, page, f.reveal).catch((e) => (box.replaceChildren(h("div.ma-bad", null, errText(e))), null));
    if (!res) return;
    const exportBtn = button("Exportar lista completa (CSV)", async () => {
      const detailed = f.reveal && (await confirmDialog("Exportação detalhada", "Exportar com os valores sem máscara? O arquivo pode conter dados sensíveis.", "Exportar sem máscara"));
      const path = await saveDialog({ defaultPath: `${u.unitId}-${f.kind}.csv` });
      if (!path) return;
      try {
        const n = await audit.export(this.project.id, r.id, "csv", u.unitId, f.kind, detailed, path);
        toast(`${n.toLocaleString("pt-BR")} linhas exportadas`, "ok");
      } catch (e) {
        toast(errText(e), "error");
      }
    }, "", "general/export");
    box.replaceChildren(
      h(
        "div.ma-row",
        null,
        h("b", null, `${res.total.toLocaleString("pt-BR")} no total`),
        h("span.dim", null, res.total > page ? `mostrando ${f.offset + 1}–${Math.min(res.total, f.offset + page)}` : ""),
        h("span.grow"),
        this.check("mostrar valores sensíveis", f.reveal, (v) => ((f.reveal = v), this.render()), "Ação explícita: exibe valores sem máscara nesta tela"),
        f.offset > 0 ? h("button.btn", { onclick: () => ((f.offset = Math.max(0, f.offset - page)), this.render()) }, "anteriores") : "",
        f.offset + page < res.total ? h("button.btn", { onclick: () => ((f.offset += page), this.render()) }, "próximos") : "",
        exportBtn,
      ),
      h("table.ma-table", null, h("thead", null, h("tr", null, ...res.headers.map((x) => h("th", null, x)))), h("tbody", null, ...res.rows.map((row) => h("tr", null, ...row.map((c) => h("td", null, c)))))),
    );
  }
}

export type { BaselineManifest };
