// Migration Audit tool window: audit projects (source and target connections of the IDE), the
// capability matrix per database, and the project workspace tabs. Nothing runs when the window
// opens: discovery, baselines and reconciliations start only by explicit action.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { h } from "../../util";
import { icon } from "../../icons";
import { button, confirmDialog, modal, toast } from "../../ui";
import { store } from "../../state";
import type { PluginHandle } from "../plugins";
import type { Workbench } from "../workbench";
import { audit, errText, fmtTime, type Capability, type Progress, type Project } from "./api";
import { AuditProjectTab, defaultProject } from "./projectTab";

const SUPPORTED = ["postgres", "mysql", "sqlserver", "firebird"];

export class AuditTools implements PluginHandle {
  private body = h("div.tw-body.af.ma");
  private list: { project: Project; baselines: number; runs: number }[] = [];
  private tabs = new Map<string, AuditProjectTab>();
  private offProgress: Promise<UnlistenFn>;
  private disposed = false;

  constructor(readonly wb: Workbench) {
    wb.register({
      id: "audit",
      title: "Migration Audit",
      icon: "auditTw",
      anchor: "right",
      body: this.body,
      actions: () => [
        h("button.icon-btn", { title: "Bancos suportados e capacidades", onclick: () => this.capabilities() }, icon("status/info")),
        h("button.icon-btn", { title: "Novo projeto de auditoria", onclick: () => this.newProject() }, icon("general/add")),
      ],
      onShow: () => this.load(),
    });
    this.offProgress = listen<{ id: string; progress: Progress }>("audit-progress", (e) => {
      for (const t of this.tabs.values()) t.onProgress(e.payload.id, e.payload.progress);
    });
    this.load();
  }

  async dispose() {
    this.disposed = true;
    // cancel running jobs (their partial state is recorded); projects and evidence stay on disk
    await audit.release().catch(() => {});
    for (const t of [...this.wb.tabs.tabs]) if (t.id.startsWith("audit:")) await this.wb.tabs.close(t);
    (await this.offProgress)();
    this.wb.unregister("audit");
  }

  async load() {
    if (this.disposed) return;
    this.list = await audit.projects().catch(() => []);
    this.render();
  }

  private render() {
    const rows = this.list.map(({ project: p, baselines, runs }) =>
      h(
        "div.af-row",
        { onclick: () => this.open(p.id) },
        icon("audit"),
        h("div.af-main", null, h("div.af-name", null, p.name), h("div.af-sub", null, `${p.source.name} → ${p.target.name} · ${baselines} baseline(s) · ${runs} execução(ões) · ${fmtTime(p.updated)}`)),
      ),
    );
    this.body.replaceChildren(
      h("div.af-head", null, icon("audit"), h("b", null, "Projetos de auditoria"), h("span.grow"), h("button.btn", { onclick: () => this.newProject() }, icon("general/add"), "Novo")),
      rows.length
        ? h("div.af-list", null, ...rows)
        : h(
            "div.af-empty",
            null,
            icon("audit"),
            h("b", null, "Audite uma conversão de dados"),
            h("div.dim", null, "Compare a origem e o destino de uma migração por unidades de reconciliação: volume, identidade dos registros, campos e relacionamentos — com evidências e limitações explícitas. O plugin não executa nem corrige a conversão."),
            h("div.af-empty-actions", null, button("Novo projeto de auditoria", () => this.newProject(), "primary", "general/add"), button("Bancos suportados", () => this.capabilities(), "", "status/info")),
          ),
      h("div.hint.jp-pad", null, "Análise determinística (SQL, metadados, regras explícitas). Sem IA ou serviços externos de inferência."),
    );
  }

  async open(id: string, focus?: string) {
    const tid = "audit:" + id;
    const open = this.wb.tabs.find(tid);
    if (open) return this.wb.tabs.activate(open);
    try {
      const data = await audit.load(id);
      const t = new AuditProjectTab(this.wb, data, () => {
        this.tabs.delete(id);
        this.load();
      });
      this.tabs.set(id, t);
      this.wb.tabs.open(t.tab);
      if (focus) t.go(focus);
      this.wb.settings.audit = { lastProject: id };
      this.wb.saveSettings();
    } catch (e) {
      toast(errText(e), "error");
    }
  }

  private async newProject() {
    await store.load?.();
    const conns = store.connections.filter((c) => SUPPORTED.includes(c.kind));
    const m = modal("Novo projeto de auditoria", { width: 560 });
    if (conns.length < 1) {
      m.body.append(h("div.af-warn", null, icon("status/warning"), "Crie as conexões de origem e destino na janela Database primeiro (PostgreSQL, MySQL/MariaDB, SQL Server ou Firebird)."));
      m.footer.append(button("Abrir Database", () => (m.close(), this.wb.show("database", true)), "primary"));
      return;
    }
    const name = h("input.input", { placeholder: "Ex.: Conversão do ERP legado" }) as HTMLInputElement;
    const desc = h("input.input", { placeholder: "Descrição (opcional)" }) as HTMLInputElement;
    const opt = (sel?: string) => conns.map((c) => h("option", { value: c.id, selected: c.id === sel }, `${c.name} (${c.kind}, ${c.host}:${c.port})`));
    const src = h("select.input", null, ...opt(conns[0].id)) as HTMLSelectElement;
    const dst = h("select.input", null, ...opt(conns[1]?.id ?? conns[0].id)) as HTMLSelectElement;
    const sdb = h("input.input", { placeholder: "banco (vazio = o da conexão)" }) as HTMLInputElement;
    const tdb = h("input.input", { placeholder: "banco (vazio = o da conexão)" }) as HTMLInputElement;
    m.body.append(
      h(
        "div.form-grid",
        null,
        h("label.field.span2", null, h("span", null, "1. Nome do projeto"), name),
        h("label.field.span2", null, h("span", null, "Descrição"), desc),
        h("label.field", null, h("span", null, "2. Origem"), src),
        h("label.field", null, h("span", null, "Banco da origem"), sdb),
        h("label.field", null, h("span", null, "3. Destino"), dst),
        h("label.field", null, h("span", null, "Banco do destino"), tdb),
      ),
      h("div.hint", { style: "margin-top:8px" }, "As conexões são referenciadas pelo identificador; senhas e strings de conexão não são gravadas no projeto. Prefira usuários somente leitura: o plugin nunca escreve nos bancos auditados."),
    );
    m.footer.append(
      button("Cancelar", () => m.close()),
      button("Criar", async () => {
        if (!name.value.trim()) return toast("Dê um nome ao projeto.", "error");
        const p = defaultProject();
        p.name = name.value.trim();
        p.description = desc.value.trim();
        p.source.connId = src.value;
        p.source.database = sdb.value.trim();
        p.target.connId = dst.value;
        p.target.database = tdb.value.trim();
        try {
          const saved = await audit.saveProject(p);
          m.close();
          await this.load();
          this.open(saved.id, "scope");
        } catch (e) {
          toast(errText(e), "error");
        }
      }, "primary"),
    );
    setTimeout(() => name.focus());
  }

  private async capabilities() {
    const caps: Capability[] = await audit.capabilities().catch(() => []);
    const m = modal("Migration Audit — bancos e capacidades", { width: 820 });
    for (const c of caps) {
      m.body.append(
        h("h4", { style: "margin:12px 0 4px" }, c.label, " ", h(`span.tag.${c.support === "full" ? "ok" : c.support === "partial" ? "warn" : "err"}` as "span", null, c.support === "full" ? "suporte completo" : c.support === "partial" ? "suporte parcial" : "fora desta versão")),
        h("div.hint", null, c.validated),
        h("table.ma-table", null, h("tbody", null, ...c.items.map(([what, s, note]) => h("tr", null, h("td", null, what), h("td", { class: s === "sim" ? "ma-ok" : s === "parcial" ? "ma-warn" : "ma-bad" }, s), h("td.dim", null, note))))),
      );
    }
    m.footer.append(button("Fechar", () => m.close(), "primary"));
  }

  async deleteProject(p: Project) {
    if (!(await confirmDialog("Excluir projeto de auditoria", `Excluir "${p.name}" com todas as baselines, execuções e exportações (vão para a lixeira do sistema)? Os bancos auditados não são alterados.`, "Excluir", true))) return false;
    await audit.deleteProject(p.id);
    this.load();
    return true;
  }
}
