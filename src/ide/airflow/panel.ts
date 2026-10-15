// Airflow tool window: instance + connection state, DAG list (server-side search, tags, state,
// paging), pause/resume/trigger, import errors and the local environment. Polls only while the
// window is visible, backs off on errors and stops completely on dispose.
import { h, debounce } from "../../util";
import { icon } from "../../icons";
import { button, confirmDialog, contextMenu, modal, notify, popupList, toast, type PopupItem } from "../../ui";
import { onFsChange, P } from "../host";
import type { Workbench } from "../workbench";
import { AirflowApi, errorText, fmtDate, instances, isAfError, newRequestId, type AfInstance, type Dag, type DagRun, type DagRunState, type ImportError } from "./api";
import { openDagTab, triggerDialog } from "./dagTab";
import { openInstanceDialog } from "./instanceDialog";
import { LocalEnvs } from "./env";
import { ProjectLink } from "./project";
import { openWeb } from "./web";
import type { AirflowHandle } from "./plugin";

type StateFilter = "all" | "active" | "paused" | "failed" | "running";
type Conn = { state: "idle" | "ok" | "error"; version?: string; error?: string; kind?: string };

const PAGE = 50;

export class AirflowTools implements AirflowHandle {
  private list = h("div.af-list", { tabIndex: 0 });
  private head = h("div.af-head");
  private filters = h("div.af-filters");
  private footer = h("div.af-footer");
  private tabsEl = h("div.tw-tabs");
  private body = h("div.tw-body.af", null, this.head, this.filters, this.list, this.footer);
  private view: "dags" | "errors" = "dags";
  private all: AfInstance[] = [];
  private inst: AfInstance | null = null;
  private api: AirflowApi | null = null;
  private conn: Conn = { state: "idle" };
  private dags: Dag[] = [];
  private total = 0;
  private lastRuns = new Map<string, DagRun | null>();
  private errors: ImportError[] = [];
  private search = "";
  private tags: string[] = [];
  private stateFilter: StateFilter = "all";
  private timer: number | null = null;
  private failures = 0;
  private inflight: string | null = null;
  private disposed = false;
  private offFs: Promise<() => void> | null = null;
  readonly envs: LocalEnvs;
  readonly project: ProjectLink;

  constructor(readonly wb: Workbench) {
    this.envs = new LocalEnvs(this);
    this.project = new ProjectLink(this);
    wb.register({
      id: "airflow",
      title: "Airflow",
      icon: "airflowTw",
      anchor: "right",
      body: this.body,
      headerTabs: this.tabsEl,
      actions: () => [
        h("button.icon-btn", { title: "Atualizar", onclick: () => this.refresh(true) }, icon("general/refresh")),
        h("button.icon-btn", { title: "Abrir a interface web do Airflow", disabled: !this.inst, onclick: () => this.inst && openWeb(this.inst.url, this.inst.name) }, icon("general/openNewTab")),
        h("button.icon-btn", { title: "Associar este projeto a uma instância", onclick: () => this.project.linkDialog() }, icon("general/settings")),
      ],
      onShow: () => this.refresh(true),
    });
    this.offFs = onFsChange((root, paths) => P.same(root, wb.root) && this.project.onFilesChanged(paths));
    this.renderTabs();
    this.loadInstances();
  }

  newDag(dir?: string) {
    this.project.newDag(dir);
  }

  async dispose() {
    this.disposed = true;
    this.stopPolling();
    if (this.inflight) AirflowApi.cancel(this.inflight).catch(() => {});
    (await this.offFs)?.();
    this.project.dispose();
    this.envs.dispose();
    for (const t of [...this.wb.tabs.tabs]) if (t.id.startsWith("airflow:")) this.wb.tabs.close(t);
    this.wb.unregister("airflow");
    // drop tokens and in-flight requests; external Airflow instances keep running
    await instances.release().catch(() => {});
  }

  // ---------------- instances ----------------

  async loadInstances(selectId?: string) {
    try {
      this.all = await instances.list();
    } catch (e) {
      this.all = [];
      toast(errorText(e), "error");
    }
    const want = selectId ?? this.wb.settings.airflow?.instanceId ?? localStorage.getItem("airflow.instance") ?? this.inst?.id;
    const pick = this.all.find((i) => i.id === want) ?? this.all[0] ?? null;
    this.select(pick);
  }

  select(inst: AfInstance | null) {
    this.inst = inst;
    this.api = inst ? new AirflowApi(inst) : null;
    this.conn = { state: "idle" };
    this.dags = [];
    this.lastRuns.clear();
    this.errors = [];
    try {
      if (inst) localStorage.setItem("airflow.instance", inst.id);
    } catch {
      /* ignore */
    }
    this.render();
    if (inst) this.connect();
  }

  instance() {
    return this.inst;
  }

  apiFor(id?: string) {
    if (!id || id === this.inst?.id) return this.api;
    const i = this.all.find((x) => x.id === id);
    return i ? new AirflowApi(i) : null;
  }

  instancesList() {
    return this.all;
  }

  private async connect() {
    if (!this.inst) return;
    const inst = this.inst;
    try {
      const r = await instances.test(inst, null);
      if (this.inst !== inst) return;
      this.conn = { state: "ok", version: r.version };
      this.failures = 0;
      await this.refresh(true);
    } catch (e) {
      if (this.inst !== inst) return;
      this.conn = { state: "error", error: errorText(e), kind: isAfError(e) ? e.kind : "http" };
      this.render();
      this.schedule();
    }
  }

  private instanceMenu(anchor: HTMLElement) {
    const items: PopupItem[] = [
      ...this.all.map((i) => ({
        label: i.name,
        sub: i.url + (i.localEnv ? "  · ambiente local" : ""),
        icon: "airflow",
        current: i.id === this.inst?.id,
        section: "Instâncias",
        action: () => this.select(i),
      })),
      { label: "Conectar a uma instância…", icon: "general/add", section: "Adicionar", action: () => this.editInstance() },
      { label: "Criar ambiente local (Docker)…", icon: "docker", section: "Adicionar", action: () => this.envs.createDialog() },
      { label: "Instalar SDK do Airflow no interpretador (autocomplete)", icon: "python/pythonClosed", section: "Projeto", action: () => this.project.installSdk() },
    ];
    if (this.inst) {
      items.push(
        { label: `Editar "${this.inst.name}"…`, icon: "general/edit", section: "Instância atual", action: () => this.editInstance(this.inst!) },
        { label: `Remover "${this.inst.name}"…`, icon: "general/delete", section: "Instância atual", action: () => this.removeInstance(this.inst!) },
      );
    }
    popupList(anchor, items, { width: 320, tall: true });
  }

  editInstance(inst?: AfInstance) {
    openInstanceDialog(inst, (saved) => this.loadInstances(saved.id));
  }

  private async removeInstance(inst: AfInstance) {
    const local = inst.localEnv ? "\n\nO ambiente local continua existindo; use a aba Ambiente para pará-lo ou excluí-lo." : "";
    if (!(await confirmDialog("Remover instância", `Remover "${inst.name}" da IDE? A senha/token salvo no cofre do sistema também é apagado. O Airflow não é alterado.${local}`, "Remover", true))) return;
    try {
      await instances.remove(inst.id);
    } catch (e) {
      return toast(errorText(e), "error");
    }
    this.loadInstances();
  }

  // ---------------- data ----------------

  /** Loads the first page again (filters changed, manual refresh, polling). */
  async refresh(reset = false) {
    if (this.disposed || !this.api || this.conn.state !== "ok") {
      if (this.conn.state === "error" && reset) this.connect();
      return this.render();
    }
    if (this.inflight) AirflowApi.cancel(this.inflight).catch(() => {});
    const rid = newRequestId();
    this.inflight = rid;
    const api = this.api;
    try {
      if (this.view === "errors") {
        const r = await api.importErrors(rid);
        this.errors = r.import_errors;
      } else {
        const keep = reset ? PAGE : Math.max(PAGE, this.dags.length);
        const f = this.filterArgs();
        const r = await api.dags({ limit: keep, offset: 0, search: this.search || undefined, tags: this.tags, ...f, rid });
        this.dags = r.dags;
        this.total = r.total_entries;
        this.loadLastRuns(api, r.dags);
        this.errors = (await api.importErrors().catch(() => ({ import_errors: this.errors }))).import_errors;
      }
      this.failures = 0;
      if (this.conn.state !== "ok") this.conn = { ...this.conn, state: "ok" };
    } catch (e) {
      if (isAfError(e) && e.kind === "cancelled") return;
      this.failures++;
      // auth and server problems turn the header red; the list keeps the last data
      if (isAfError(e) && ["unreachable", "timeout", "tls", "auth", "incompatible"].includes(e.kind)) this.conn = { state: "error", error: errorText(e), kind: e.kind };
      else toast(errorText(e), "error");
    } finally {
      if (this.inflight === rid) this.inflight = null;
    }
    this.render();
    this.schedule();
  }

  private filterArgs(): { paused?: boolean; lastState?: DagRunState } {
    switch (this.stateFilter) {
      case "active":
        return { paused: false };
      case "paused":
        return { paused: true };
      case "failed":
        return { lastState: "failed" };
      case "running":
        return { lastState: "running" };
      default:
        return {};
    }
  }

  private async loadMore() {
    if (!this.api) return;
    try {
      const r = await this.api.dags({ limit: PAGE, offset: this.dags.length, search: this.search || undefined, tags: this.tags, ...this.filterArgs() });
      this.dags.push(...r.dags);
      this.total = r.total_entries;
      this.loadLastRuns(this.api, r.dags);
      this.render();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  /** Latest run per visible DAG (4 requests at a time). */
  private async loadLastRuns(api: AirflowApi, dags: Dag[]) {
    const queue = [...dags];
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        if (this.disposed || api !== this.api) return;
        try {
          const r = await api.runs(d.dag_id, 1);
          this.lastRuns.set(d.dag_id, r.dag_runs[0] ?? null);
        } catch {
          /* keep previous */
        }
      }
      this.renderList();
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  private schedule() {
    this.stopPolling();
    if (this.disposed) return;
    // 20 s while healthy; doubling up to 160 s after consecutive failures
    const delay = Math.min(160_000, 20_000 * 2 ** Math.min(this.failures, 3));
    this.timer = window.setTimeout(() => {
      if (!this.wb.isVisible("airflow")) return this.schedule();
      if (this.conn.state === "error") this.connect();
      else this.refresh();
    }, delay);
  }

  private stopPolling() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------------- actions ----------------

  async togglePause(d: Dag) {
    if (!this.api) return;
    try {
      const nd = await this.api.setPaused(d.dag_id, !d.is_paused);
      Object.assign(d, nd);
      toast(nd.is_paused ? `${d.dag_id} pausada` : `${d.dag_id} ativa`, "ok");
    } catch (e) {
      notify("Não foi possível alterar a pausa", errorText(e), "error");
    }
    this.renderList();
  }

  trigger(d: Dag) {
    if (!this.api) return;
    const api = this.api;
    triggerDialog(api, d, (run) => {
      this.lastRuns.set(d.dag_id, run);
      this.renderList();
      openDagTab(this, api, d.dag_id, run.dag_run_id);
    });
  }

  // ---------------- rendering ----------------

  private renderTabs() {
    const tab = (v: typeof this.view, label: string) => h("div.tw-tab", { class: this.view === v ? "active" : "", onclick: () => ((this.view = v), this.refresh(true)) }, label);
    const errs = this.errors.length;
    this.tabsEl.replaceChildren(tab("dags", "DAGs"), tab("errors", errs ? `Erros de importação (${errs})` : "Erros de importação"));
  }

  render() {
    if (this.disposed) return;
    this.renderTabs();
    this.renderHead();
    this.renderFilters();
    this.renderList();
  }

  private renderHead() {
    const pick = h("button.af-inst", { title: "Escolher instância" }, icon("airflow"), h("span", null, this.inst?.name ?? "Nenhuma instância"), icon("general/chevronDown")) as HTMLButtonElement;
    pick.onclick = () => this.instanceMenu(pick);
    const c = this.conn;
    const status =
      !this.inst
        ? h("span.af-status", null, "Adicione uma instância")
        : c.state === "ok"
          ? h("span.af-status.ok", null, h("i"), `Conectado · Airflow ${c.version ?? ""}`)
          : c.state === "error"
            ? h("span.af-status.err", { title: c.error }, h("i"), c.kind === "auth" ? "Falha de autenticação" : c.kind === "incompatible" ? "Versão incompatível" : c.kind === "forbidden" ? "Sem permissão" : "Servidor indisponível")
            : h("span.af-status", null, h("i"), "Conectando…");
    const env = this.inst?.localEnv ? this.envs.badge(this.inst.localEnv) : "";
    this.head.replaceChildren(pick, status, h("span.grow"), env);
  }

  private renderFilters() {
    if (this.view !== "dags" || !this.inst || this.conn.state !== "ok") return this.filters.replaceChildren();
    const q = h("input.input.af-search", { placeholder: "Buscar DAG (use % como curinga)", value: this.search, spellcheck: false }) as HTMLInputElement;
    const run = debounce(() => ((this.search = q.value.trim()), this.refresh(true)), 350);
    q.oninput = () => run();
    const st = h(
      "select.select.small",
      { title: "Estado", onchange: (e: Event) => ((this.stateFilter = (e.target as HTMLSelectElement).value as StateFilter), this.refresh(true)) },
      ...([
        ["all", "Todas"],
        ["active", "Ativas"],
        ["paused", "Pausadas"],
        ["running", "Executando"],
        ["failed", "Última falhou"],
      ] as [StateFilter, string][]).map(([v, l]) => h("option", { value: v, selected: this.stateFilter === v }, l)),
    );
    const tagBtn = h("button.tool-btn.text", { title: "Filtrar por tags" }, icon("general/filter"), this.tags.length ? this.tags.join(", ") : "Tags") as HTMLButtonElement;
    tagBtn.onclick = async () => {
      if (!this.api) return;
      const r = await this.api.allTags().catch(() => ({ tags: [] as string[] }));
      popupList(
        tagBtn,
        [
          ...(this.tags.length ? [{ label: "Limpar filtro", icon: "general/close", action: () => ((this.tags = []), this.refresh(true)) }] : []),
          ...r.tags.map((t) => ({ label: t, current: this.tags.includes(t), icon: this.tags.includes(t) ? "check" : "", action: () => ((this.tags = this.tags.includes(t) ? this.tags.filter((x) => x !== t) : [...this.tags, t]), this.refresh(true)) })),
        ],
        { width: 240, compact: true, placeholder: "Buscar tag…" },
      );
    };
    this.filters.replaceChildren(q, h("div.af-filter-row", null, st, tagBtn, h("span.grow"), h("span.dim", null, this.total ? `${this.dags.length} de ${this.total}` : "")));
  }

  private renderList() {
    if (this.disposed) return;
    this.footer.replaceChildren();
    if (!this.inst) {
      return this.list.replaceChildren(
        h(
          "div.af-empty",
          null,
          icon("airflowTw", "ic20"),
          h("b", null, "Conecte o Airflow"),
          h("span.dim", null, "Use uma instância existente (Airflow 3) ou crie um ambiente local de desenvolvimento com Docker."),
          h("div.af-empty-actions", null, button("Conectar instância…", () => this.editInstance(), "primary", "general/add"), button("Criar ambiente local…", () => this.envs.createDialog(), "", "docker")),
        ),
      );
    }
    if (this.conn.state === "error") {
      const auth = this.conn.kind === "auth";
      return this.list.replaceChildren(
        h(
          "div.af-empty",
          null,
          icon(auth ? "general/user" : "status/warningOutline", "ic20"),
          h("b", null, auth ? "Erro de autenticação" : this.conn.kind === "incompatible" ? "Versão não suportada" : "Servidor indisponível"),
          h("span.dim.af-err", null, this.conn.error ?? ""),
          h(
            "div.af-empty-actions",
            null,
            button("Tentar de novo", () => this.connect(), "primary", "general/refresh"),
            button("Editar instância…", () => this.editInstance(this.inst!), "", "general/edit"),
            this.inst.localEnv ? button("Iniciar ambiente", () => this.envs.start(this.inst!.localEnv), "", "run/run") : "",
          ),
        ),
      );
    }
    if (this.conn.state !== "ok") return this.list.replaceChildren(h("div.empty-note", null, "Conectando…"));
    if (this.view === "errors") return this.renderErrors();
    if (!this.dags.length) {
      return this.list.replaceChildren(
        h(
          "div.af-empty",
          null,
          h("b", null, this.search || this.tags.length || this.stateFilter !== "all" ? "Nenhuma DAG com esses filtros" : "Nenhuma DAG nesta instância"),
          h("span.dim", null, this.wb.settings.airflow ? `As DAGs de "${this.wb.settings.airflow.dagsDir}" aparecem aqui depois que o Airflow processar os arquivos.` : "Associe o projeto a esta instância para criar e publicar DAGs pela IDE."),
          h("div.af-empty-actions", null, button("Nova DAG…", () => this.project.newDag(), "primary", "general/add"), this.wb.settings.airflow ? "" : button("Associar projeto…", () => this.project.linkDialog())),
        ),
      );
    }
    this.list.replaceChildren(...this.dags.map((d) => this.dagRow(d)));
    if (this.dags.length < this.total) this.footer.append(h("button.link", { onclick: () => this.loadMore() }, `Carregar mais (${this.total - this.dags.length})`));
  }

  private dagRow(d: Dag): HTMLElement {
    const last = this.lastRuns.get(d.dag_id);
    const sw = h("button.af-switch", { class: d.is_paused ? "" : "on", title: d.is_paused ? "Pausada: clique para ativar" : "Ativa: clique para pausar", onclick: (e: MouseEvent) => (e.stopPropagation(), this.togglePause(d)) }, h("i"));
    const row = h(
      "div.af-row",
      {
        class: d.is_paused ? "paused" : "",
        onclick: () => this.api && openDagTab(this, this.api, d.dag_id),
        oncontextmenu: (e: MouseEvent) => (e.preventDefault(), contextMenu(e.clientX, e.clientY, this.dagMenu(d))),
      },
      sw,
      h(
        "div.af-main",
        null,
        h("span.af-name", null, d.dag_display_name || d.dag_id, d.has_import_errors ? h("span.af-badge.err", { title: "Erro de importação" }, "erro") : ""),
        h("span.af-sub", null, [d.timetable_summary ?? "sem agendamento", ...d.tags.map((t) => "#" + t.name)].join("  ")),
      ),
      h(
        "div.af-last",
        { title: last ? `Última execução: ${last.state} · ${fmtDate(last.start_date ?? last.run_after)}` : "Sem execuções" },
        last ? h("span.af-dot", { class: last.state }) : h("span.af-dot"),
        h("span", null, last ? fmtDate(last.start_date ?? last.run_after) : "—"),
      ),
      h("button.icon-btn.af-play", { title: "Disparar execução…", onclick: (e: MouseEvent) => (e.stopPropagation(), this.trigger(d)) }, icon("run/run")),
    );
    return row;
  }

  private dagMenu(d: Dag) {
    const local = this.project.localFileFor(d);
    return [
      { label: "Abrir detalhes", icon: "general/show", action: () => this.api && openDagTab(this, this.api, d.dag_id) },
      { label: "Disparar execução…", icon: "run/run", action: () => this.trigger(d) },
      { label: d.is_paused ? "Ativar" : "Pausar", icon: d.is_paused ? "run/run" : "run/pause", action: () => this.togglePause(d) },
      { separator: true },
      { label: "Abrir arquivo local", icon: "fileTypes/python", disabled: !local, action: () => local && this.wb.editors.openFile(local) },
      { label: "Abrir na interface web", icon: "general/openNewTab", action: () => this.inst && openWeb(this.api!.webUrl(d.dag_id), d.dag_id) },
      { label: "Copiar ID", icon: "general/copy", action: () => navigator.clipboard.writeText(d.dag_id) },
    ];
  }

  private renderErrors() {
    this.footer.replaceChildren();
    if (!this.errors.length) return this.list.replaceChildren(h("div.af-empty", null, icon("status/success", "ic20"), h("b", null, "Nenhum erro de importação"), h("span.dim", null, "Todos os arquivos de DAG foram processados sem erro.")));
    this.list.replaceChildren(
      ...this.errors.map((e) => {
        const local = this.project.localFileForPath(e.filename);
        const trace = h("pre.af-trace.hidden", null, e.stack_trace);
        return h(
          "div.af-error",
          null,
          h(
            "div.af-error-head",
            { onclick: () => trace.classList.toggle("hidden") },
            icon("status/error"),
            h("b", null, e.filename.split("/").pop() ?? e.filename),
            h("span.dim", null, fmtDate(e.timestamp)),
            h("span.grow"),
            local ? h("button.link", { onclick: (ev: MouseEvent) => (ev.stopPropagation(), this.wb.editors.openFile(local)) }, "Abrir arquivo") : "",
          ),
          h("div.af-sub", null, e.stack_trace.trim().split("\n").pop() ?? ""),
          trace,
        );
      }),
    );
  }

  /** Small "how to" dialog shown from the plugin card. */
  static about() {
    const m = modal("Plugin Apache Airflow", { width: 560 });
    m.body.append(
      h("p", null, "Conecta a IDE à API pública do Airflow 3 (/api/v2): DAGs, execuções, tarefas, grafo, logs, pausa, disparo e limpeza de tarefas."),
      h("p.dim", null, "Credenciais ficam no cofre do sistema (Keychain / Credential Manager). As chamadas passam pelo backend da IDE, com TLS validado."),
    );
    m.footer.append(button("Fechar", () => m.close(), "primary"));
  }
}
