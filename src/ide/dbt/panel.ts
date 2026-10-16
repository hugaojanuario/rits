// dbt tool window: project detection (dbt_project.yml), runtime (dbt Core of a Python environment
// or the official Docker image; nothing is installed automatically), managed PostgreSQL profiles
// with passwords in the OS store, commands with structured selection, a scope preview before
// commands that change the database, last results, lineage and generated documentation.
// dbt's dependency graph is not a scheduler: periodic runs belong to Airflow or another orchestrator.
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { h, uid } from "../../util";
import { icon } from "../../icons";
import { button, confirmDialog, contextMenu, modal, notify, promptDialog, textViewer, toast, type MenuItem } from "../../ui";
import { host, on, onFsChange, P, type ProcExit, type ProcOut } from "../host";
import { contribute, type PluginHandle } from "../plugins";
import { runBackground, scriptsDir } from "../sdk";
import { store } from "../../state";
import type { Workbench } from "../workbench";
import { dbt, DBT_IMAGE, errText, WRITES_DB, type DbtNode, type DbtProjectSettings, type Profile, type RunSpec, type Summary, type Target, type VersionInfo } from "./api";
import { jinjaHighlight, refAt, resolveRef, TEMPLATES } from "./editor";
import { DbtRunTab } from "./run";

const COMMANDS: { cmd: string; label: string; icon: string; title: string }[] = [
  { cmd: "debug", label: "debug", icon: "actions/checked", title: "Testa a conexão, o perfil e as dependências (dbt debug)" },
  { cmd: "deps", label: "deps", icon: "actions/install", title: "Instala os pacotes de packages.yml (dbt deps)" },
  { cmd: "parse", label: "parse", icon: "general/refresh", title: "Lê o projeto e gera o manifest (dbt parse)" },
  { cmd: "compile", label: "compile", icon: "actions/reformatCode", title: "Compila o SQL sem executar (dbt compile)" },
  { cmd: "run", label: "run", icon: "run/run", title: "Materializa os modelos no banco (dbt run)" },
  { cmd: "test", label: "test", icon: "run/testPassed", title: "Executa os testes de dados (dbt test)" },
  { cmd: "build", label: "build", icon: "run/rerun", title: "run + test + seed + snapshot em ordem de dependência (dbt build)" },
  { cmd: "docs-generate", label: "docs generate", icon: "fileTypes/html", title: "Gera a documentação (dbt docs generate)" },
];

const defaults = (dir: string): DbtProjectSettings => ({ projectDir: dir, runtime: { kind: "local", dbt: "", image: DBT_IMAGE }, profileId: "", profilesDir: "", target: "", threads: null, vars: "", history: [] });

export class DbtTools implements PluginHandle {
  private body = h("div.tw-body.af.dbt");
  private projects: string[] = [];
  private version: VersionInfo | null = null;
  private versionErr = "";
  private summary: Summary | null = null;
  private profiles: Profile[] = [];
  private running: DbtRunTab | null = null;
  private docs: { procId: string; port: number } | null = null;
  private selected: string | null = null;
  private filter = "";
  private sel = h("input.input.dbt-sel", { placeholder: "seleção: modelo, +modelo+, tag:x, path:models/y", spellcheck: false }) as HTMLInputElement;
  private exc = h("input.input.dbt-sel", { placeholder: "excluir (opcional)", spellcheck: false }) as HTMLInputElement;
  private full = h("input", { type: "checkbox" }) as HTMLInputElement;
  private offContrib: () => void;
  private offFs: Promise<() => void>;
  private disposed = false;
  private onOpenNode = (e: Event) => this.openNode((e as CustomEvent<string>).detail);

  constructor(readonly wb: Workbench) {
    wb.register({
      id: "dbt",
      title: "dbt",
      icon: "dbtTw",
      anchor: "right",
      body: this.body,
      actions: () => [
        h("button.icon-btn", { title: "Atualizar", onclick: () => this.refresh() }, icon("general/refresh")),
        h("button.icon-btn", { title: "Ambiente de execução do dbt", onclick: () => this.runtimeDialog() }, icon("general/settings")),
      ],
      onShow: () => this.refresh(),
    });
    this.offContrib = contribute({
      id: "dbt",
      extensions: (path) => (this.inProject(path) && /\.(sql|yml|yaml)$/i.test(path) ? [jinjaHighlight] : []),
      definition: (path, text, pos) => this.definition(path, text, pos),
      actions: (path) => this.editorActions(path),
    });
    this.offFs = onFsChange((root, paths) => {
      if (P.same(root, wb.root) && paths.some((p) => /\/target\/(run_results|manifest)\.json$/.test(p) || p.endsWith("dbt_project.yml"))) this.loadArtifacts();
    });
    window.addEventListener("rits-dbt-open-node", this.onOpenNode);
    this.sel.onkeydown = (e) => e.key === "Enter" && this.runCmd("build");
    this.refresh();
  }

  async dispose() {
    this.disposed = true;
    this.offContrib();
    (await this.offFs)();
    window.removeEventListener("rits-dbt-open-node", this.onOpenNode);
    for (const t of [...this.wb.tabs.tabs]) if (t.id.startsWith("dbt-run:")) await this.wb.tabs.close(t);
    await dbt.release().catch(() => {});
    this.docs = null;
    this.wb.unregister("dbt");
  }

  newItems(dir: string): MenuItem[] {
    const proj = this.cfg?.projectDir;
    if (!proj) return [];
    return [{ label: "Arquivo dbt", icon: "dbt", submenu: TEMPLATES.map((t) => ({ label: t.label, action: () => this.newFromTemplate(t.id, P.inside(proj, dir) ? dir : P.join(proj, t.dir)) })) }];
  }

  // ---------------- config ----------------

  get cfg(): DbtProjectSettings | undefined {
    return this.wb.settings.dbt;
  }

  private save(c: DbtProjectSettings) {
    this.wb.settings.dbt = c;
    this.wb.saveSettings();
  }

  private inProject(path: string) {
    return !!this.cfg?.projectDir && P.inside(this.cfg.projectDir, path);
  }

  private async detect() {
    const files = await host.files(this.wb.root).catch(() => [] as string[]);
    this.projects = files.filter((f) => P.base(f) === "dbt_project.yml" && !/\/(dbt_packages|target|node_modules)\//.test(f)).map((f) => P.dir(f)).slice(0, 20);
    if (!this.cfg && this.projects.length) this.save(defaults(this.projects[0]));
    if (this.cfg && !this.projects.some((p) => P.same(p, this.cfg!.projectDir)) && this.projects.length) this.save({ ...this.cfg, projectDir: this.projects[0] });
  }

  private async resolveDbt(): Promise<string> {
    const c = this.cfg!;
    if (c.runtime.kind === "docker") return "";
    if (c.runtime.dbt && (await host.exists(c.runtime.dbt))) return c.runtime.dbt;
    const exe = navigator.userAgent.includes("Windows") ? "dbt.exe" : "dbt";
    if (this.wb.python) {
      const p = P.join(scriptsDir(this.wb.python.path), exe);
      if (await host.exists(p)) return p;
    }
    return (await host.which("dbt")) ?? "";
  }

  async refresh() {
    if (this.disposed) return;
    await this.detect();
    if (this.cfg) {
      const path = await this.resolveDbt();
      if (path && this.cfg.runtime.kind === "local" && path !== this.cfg.runtime.dbt) this.save({ ...this.cfg, runtime: { ...this.cfg.runtime, dbt: path } });
      this.version = null;
      this.versionErr = "";
      if (this.cfg.runtime.kind === "docker" || path) {
        dbt
          .version(this.cfg.runtime)
          .then((v) => (this.version = v))
          .catch((e) => (this.versionErr = errText(e)))
          .finally(() => this.render());
      } else this.versionErr = "dbt não encontrado no ambiente Python do projeto nem no PATH.";
      this.profiles = await dbt.profiles().catch(() => []);
      await this.loadArtifacts();
    }
    this.render();
  }

  private async loadArtifacts() {
    if (!this.cfg?.projectDir) return;
    this.summary = await dbt.artifacts(this.cfg.projectDir).catch(() => null);
    this.render();
  }

  private profile(): Profile | undefined {
    return this.profiles.find((p) => p.id === this.cfg?.profileId);
  }

  private targetInfo(): string {
    const p = this.profile();
    const name = this.cfg?.target || p?.defaultTarget || "";
    if (!p) return name ? `target "${name}" do seu profiles.yml` : "target padrão do seu profiles.yml";
    const t = p.targets.find((x) => x.name === name);
    if (!t) return name;
    const c = t.connId ? store.all.find((x) => x.id === t.connId) : null;
    const where = c ? `${c.host}:${c.port}/${t.dbname || c.database || "postgres"}` : `${t.host}:${t.port || 5432}/${t.dbname}`;
    return `${t.name} → schema "${t.schema}" em ${where}`;
  }

  // ---------------- render ----------------

  render() {
    if (this.disposed) return;
    const c = this.cfg;
    if (!c) {
      this.body.replaceChildren(
        h(
          "div.af-empty",
          null,
          icon("dbt"),
          h("b", null, "Nenhum projeto dbt neste projeto"),
          h("div.dim", null, "O plugin procura o arquivo dbt_project.yml. Crie um projeto com o comando oficial dbt init ou abra a pasta de um projeto existente."),
          h("div.af-empty-actions", null, button("Criar projeto dbt…", () => this.initWizard(), "primary", "general/add"), button("Ambiente do dbt…", () => this.runtimeDialog(), "", "general/settings")),
        ),
      );
      return;
    }
    const busy = !!this.running?.isRunning;
    const ver = this.version
      ? h("span.dim", null, `dbt Core ${this.version.core}${this.version.adapters.length ? " · " + this.version.adapters.map(([a, v]) => `${a} ${v}`).join(", ") : ""}`)
      : h("span.dim", null, this.versionErr ? "dbt indisponível" : "verificando o dbt…");
    const warns: HTMLElement[] = [];
    if (this.versionErr) warns.push(this.warn(this.versionErr + " Configure o ambiente (engrenagem) — o Rits não instala nada globalmente.", [["Configurar", () => this.runtimeDialog()]]));
    if (this.version?.v2) warns.push(this.warn("dbt v2 detectado: esta versão do plugin foi validada com o dbt Core v1 (1.10–1.12). Comandos podem funcionar, mas não há garantia."));
    if (this.version && !this.version.adapters.some(([a]) => a === "postgres") && this.cfg?.profileId) warns.push(this.warn("O adapter dbt-postgres não está instalado neste ambiente, e o perfil gerenciado pelo Rits é PostgreSQL."));
    if (!c.profileId && !c.profilesDir) warns.push(this.warn("Sem perfil configurado: o dbt vai procurar ~/.dbt/profiles.yml.", [["Configurar perfil", () => this.profileDialog()]]));
    const s = this.summary;
    if (s?.manifest.compat && s.manifest.compat !== "ok") warns.push(this.warn(`manifest.json ${s.manifest.compat === "newer" ? "mais novo que o suportado" : s.manifest.compat === "old" ? "antigo" : s.manifest.compat === "invalid" ? "ilegível" : "sem versão"} (schema v${s.manifest.schemaVersion ?? "?"}). ${s.manifest.error}`));
    if (s?.runResults.compat && s.runResults.compat !== "ok") warns.push(this.warn(`run_results.json ${s.runResults.compat} (schema v${s.runResults.schemaVersion ?? "?"}): os resultados podem estar incompletos.`));
    if (s?.resultsFromOtherInvocation) warns.push(this.warn("Os resultados são de uma execução anterior ao manifest atual."));
    if (s?.changedSinceResults.length) warns.push(this.warn(`${s.changedSinceResults.length} arquivo(s) alterado(s) depois da última execução: ${s.changedSinceResults.slice(0, 4).join(", ")}${s.changedSinceResults.length > 4 ? "…" : ""}`));
    const projSel = this.projects.length > 1
      ? h("select.input", { onchange: (e: Event) => (this.save({ ...c, projectDir: (e.target as HTMLSelectElement).value }), this.refresh()) }, ...this.projects.map((p) => h("option", { value: p, selected: P.same(p, c.projectDir) }, P.rel(this.wb.root, p) || ".")))
      : h("span", null, P.rel(this.wb.root, c.projectDir) || P.base(c.projectDir));
    const p = this.profile();
    const targets = p ? p.targets.map((t) => t.name) : [];
    const tsel = h("select.input", { title: "Target", onchange: (e: Event) => this.save({ ...c, target: (e.target as HTMLSelectElement).value }) }, h("option", { value: "" }, p ? `padrão (${p.defaultTarget})` : "padrão do perfil"), ...targets.map((t) => h("option", { value: t, selected: c.target === t }, t))) as HTMLSelectElement;
    this.body.replaceChildren(
      h("div.af-head", null, icon("dbt"), h("b", null, projSel), h("span.grow"), ver),
      ...warns,
      h(
        "div.dbt-form",
        null,
        h("div.af-filter-row", null, h("span.dim", null, "Target"), tsel, h("button.btn", { onclick: () => this.profileDialog() }, icon("general/settings"), p ? "Perfil" : "Configurar perfil")),
        h("div.dim.dbt-target", null, this.targetInfo()),
        this.sel,
        this.exc,
        h("label.check", { title: "Recria do zero modelos incrementais e seeds (opção explícita)" }, this.full, "--full-refresh"),
        h("div.dbt-cmds", null, ...COMMANDS.map((x) => h("button.btn", { title: x.title, disabled: busy, onclick: () => this.runCmd(x.cmd) }, icon(x.icon), x.label))),
        h(
          "div.af-filter-row",
          null,
          this.docs ? h("button.btn", { onclick: () => this.openDocs() }, icon("general/openNewTab"), "Abrir documentação") : h("button.btn", { onclick: () => this.serveDocs(), disabled: busy }, icon("fileTypes/html"), "Ver documentação"),
          this.docs ? h("button.btn", { onclick: () => this.stopDocs() }, icon("run/stop"), "Parar servidor") : "",
          busy ? h("button.btn", { onclick: () => this.running?.cancel() }, icon("run/stop"), "Cancelar execução") : "",
        ),
      ),
      this.resultsSection(),
      this.nodesSection(),
    );
  }

  private warn(text: string, actions: [string, () => void][] = []) {
    return h("div.af-warn.dbt-warn", null, icon("status/warning"), h("div", null, text, ...actions.map(([l, f]) => h("button.link", { onclick: f, style: "margin-left:6px" }, l))));
  }

  private nodeBy(id: string) {
    return this.summary?.nodes.find((n) => n.uniqueId === id);
  }

  private resultsSection() {
    const s = this.summary;
    if (!s?.results.length) return h("div.jp-sec", null, h("div.afd-sec", null, "Última execução"), h("div.dim.jp-pad", null, "Nenhum resultado em target/run_results.json."));
    const order = (st: string) => (["error", "fail", "runtime error"].includes(st) ? 0 : st === "warn" ? 1 : st === "skipped" ? 2 : 3);
    const rows = s.results
      .slice()
      .sort((a, b) => order(a.status) - order(b.status) || b.executionTime - a.executionTime)
      .slice(0, 300)
      .map((r) => {
        const n = this.nodeBy(r.uniqueId);
        const cls = ["error", "fail", "runtime error"].includes(r.status) ? "failed" : r.status === "skipped" ? "skipped" : r.status === "warn" ? "queued" : "success";
        return h(
          "div.af-row.dbt-res",
          { title: r.message, onclick: () => this.openNode(r.uniqueId) },
          h(`span.af-dot.${cls}` as "span"),
          h("div.af-main", null, h("div.af-name", null, n?.name ?? r.uniqueId), h("div.af-sub", null, `${n?.resourceType ?? ""} · ${r.status}${r.failures ? ` · ${r.failures} falhas` : ""} · ${r.executionTime.toFixed(2)}s${r.message && cls === "failed" ? " · " + r.message : ""}`)),
        );
      });
    const failed = s.results.filter((r) => ["error", "fail", "runtime error"].includes(r.status)).length;
    return h("div.jp-sec", null, h("div.afd-sec", null, `Última execução (dbt ${s.command || "?"}, ${s.elapsed.toFixed(1)} s) — ${s.results.length} nós${failed ? `, ${failed} com falha` : ""}`), ...rows);
  }

  private nodesSection() {
    const s = this.summary;
    if (!s?.nodes.length) return h("div.jp-sec", null, h("div.afd-sec", null, "Nós do projeto"), h("div.dim.jp-pad", null, "Execute dbt parse para ler o projeto."));
    const search = h("input.input.af-search", { placeholder: "filtrar nós", value: this.filter, oninput: (e: Event) => ((this.filter = (e.target as HTMLInputElement).value), this.renderNodeList(list)) }) as HTMLInputElement;
    const list = h("div.dbt-nodelist");
    this.renderNodeList(list);
    return h("div.jp-sec", null, h("div.afd-sec", null, `Nós do projeto (${s.projectName})`), h("div", { style: "padding:0 10px 6px" }, search), list, this.lineage());
  }

  private renderNodeList(list: HTMLElement) {
    const s = this.summary!;
    const f = this.filter.toLowerCase();
    const res = new Map(s.results.map((r) => [r.uniqueId, r.status]));
    const nodes = s.nodes.filter((n) => n.package === s.projectName && ["model", "seed", "snapshot", "source", "test", "unit_test"].includes(n.resourceType) && (!f || n.name.toLowerCase().includes(f) || n.tags.some((t) => t.includes(f))));
    list.replaceChildren(
      ...nodes.slice(0, 400).map((n) =>
        h(
          "div.af-row.dbt-nrow",
          { class: this.selected === n.uniqueId ? "selected" : "", onclick: () => ((this.selected = n.uniqueId), this.render()), ondblclick: () => this.openNode(n.uniqueId), oncontextmenu: (e: MouseEvent) => (e.preventDefault(), contextMenu(e.clientX, e.clientY, this.nodeMenu(n))) },
          h(`span.af-dot.${({ success: "success", pass: "success", fail: "failed", error: "failed", skipped: "skipped" } as Record<string, string>)[res.get(n.uniqueId) ?? ""] ?? ""}` as "span"),
          h("div.af-main", null, h("div.af-name", null, n.resourceType === "source" ? `${n.sourceName}.${n.name}` : n.name), h("div.af-sub", null, `${n.resourceType}${n.materialized ? " · " + n.materialized : ""}${n.tags.length ? " · " + n.tags.join(", ") : ""}`)),
        ),
      ),
    );
  }

  private nodeMenu(n: DbtNode): MenuItem[] {
    const sel = n.resourceType === "source" ? `source:${n.sourceName}.${n.name}` : n.name;
    return [
      { label: "Abrir arquivo", icon: "general/open", action: () => this.openNode(n.uniqueId) },
      { label: "Ver SQL compilado", icon: "fileTypes/sql", disabled: !["model", "test", "snapshot"].includes(n.resourceType), action: () => this.showCompiled(n) },
      { separator: true },
      { label: `Selecionar ${sel}`, action: () => ((this.sel.value = sel), this.sel.focus()) },
      { label: `Selecionar +${sel}+ (dependências)`, action: () => ((this.sel.value = `+${sel}+`), this.sel.focus()) },
      { label: "dbt build deste nó", icon: "run/run", action: () => this.runCmd("build", [sel]) },
      { label: "dbt test deste nó", icon: "run/testPassed", action: () => this.runCmd("test", [sel]) },
    ];
  }

  private lineage() {
    const s = this.summary!;
    const n = this.selected ? this.nodeBy(this.selected) : null;
    if (!n) return h("div.dim.jp-pad", null, "Selecione um nó para ver dependências e dependentes.");
    const parents = n.dependsOn.map((id) => this.nodeBy(id)).filter((x): x is DbtNode => !!x);
    const children = s.nodes.filter((x) => x.dependsOn.includes(n.uniqueId));
    const chip = (x: DbtNode) => h("button.dbt-chip", { title: x.uniqueId, onclick: () => ((this.selected = x.uniqueId), this.render()), ondblclick: () => this.openNode(x.uniqueId) }, icon(x.resourceType === "source" ? "dbTable" : x.resourceType === "test" ? "run/testPassed" : "dbt"), x.resourceType === "source" ? `${x.sourceName}.${x.name}` : x.name);
    return h(
      "div.dbt-lineage",
      null,
      h("div.afd-sec", null, "Linhagem"),
      h("div.dbt-lin-row", null, h("span.dim", null, "depende de"), ...(parents.length ? parents.map(chip) : [h("span.dim", null, "—")])),
      h("div.dbt-lin-row", null, h("span.dim", null, "nó"), h("b", null, n.name)),
      h("div.dbt-lin-row", null, h("span.dim", null, "usado por"), ...(children.length ? children.map(chip) : [h("span.dim", null, "—")])),
      h("div.hint", null, "O grafo mostra dependências entre modelos; não é um agendador. Execuções periódicas ficam com o Airflow ou outro orquestrador."),
    );
  }

  // ---------------- navigation ----------------

  async openNode(id: string) {
    const n = this.nodeBy(id);
    const proj = this.cfg?.projectDir;
    if (!n || !proj || !n.path) return toast("Arquivo do nó não encontrado no manifest (execute dbt parse).", "info");
    const path = P.join(proj, n.path);
    if (n.resourceType === "source" || n.path.endsWith(".yml") || n.path.endsWith(".yaml")) {
      const text = (await host.read(path).catch(() => null))?.text ?? "";
      const needle = n.resourceType === "test" ? (n.attached ? this.nodeBy(n.attached)?.name ?? n.name : n.name) : n.name;
      const line = text.split("\n").findIndex((l) => new RegExp(`name:\\s*['"]?${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]?\\s*$`).test(l));
      return this.wb.editors.openFile(path, { line: line >= 0 ? line + 1 : 1 });
    }
    this.wb.editors.openFile(path);
  }

  private async definition(path: string, text: string, pos: number) {
    if (!this.inProject(path)) return false;
    const r = refAt(text, pos);
    if (!r) return false;
    if (!this.summary?.nodes.length) await this.loadArtifacts();
    const n = this.summary ? resolveRef(r, this.summary.nodes) : null;
    if (n) {
      await this.openNode(n.uniqueId);
      return true;
    }
    // without a manifest: look for the file by name
    if (r.kind === "ref") {
      const name = r.args[r.args.length - 1];
      const files = await host.files(this.cfg!.projectDir).catch(() => [] as string[]);
      const f = files.find((x) => /\.(sql|py|csv)$/.test(x) && P.base(x).replace(/\.\w+$/, "") === name && !x.includes("/target/") && !x.includes("/dbt_packages/"));
      if (f) {
        this.wb.editors.openFile(f);
        return true;
      }
    }
    toast(`${r.kind}(${r.args.map((a) => `'${a}'`).join(", ")}) não encontrado. Execute dbt parse para atualizar o manifest.`, "info");
    return true;
  }

  private nodeForFile(path: string) {
    const proj = this.cfg?.projectDir;
    if (!proj || !this.summary) return null;
    const rel = P.rel(proj, path);
    return this.summary.nodes.find((n) => n.path === rel && ["model", "seed", "snapshot", "test"].includes(n.resourceType)) ?? null;
  }

  private editorActions(path: string) {
    if (!this.inProject(path) || !/\.(sql|py|csv)$/.test(path) || path.includes("/target/")) return [];
    const name = P.base(path).replace(/\.\w+$/, "");
    const node = this.nodeForFile(path);
    const sel = node?.name ?? name;
    return [
      { label: "dbt compile", icon: "actions/reformatCode", run: () => this.runCmd("compile", [sel]) },
      { label: "dbt build", icon: "run/run", title: `dbt build --select ${sel}`, run: () => this.runCmd("build", [sel]) },
      { label: "Testar", icon: "run/testPassed", run: () => this.runCmd("test", [sel]) },
      { label: "SQL compilado", icon: "fileTypes/sql", run: () => (node ? this.showCompiled(node) : toast("Execute dbt parse/compile para ver o SQL compilado.", "info")) },
      { label: "Linhagem", icon: "dbt", run: () => ((this.selected = node?.uniqueId ?? null), this.wb.show("dbt", true), this.render()) },
    ];
  }

  private async showCompiled(n: DbtNode) {
    const sql = await dbt.compiled(this.cfg!.projectDir, n.uniqueId).catch(() => null);
    if (!sql) return notify("SQL compilado indisponível", `Execute dbt compile --select ${n.name} para gerá-lo.`, "info", [{ label: "Compilar agora", run: () => this.runCmd("compile", [n.name]) }]);
    textViewer(`SQL compilado — ${n.name}`, sql);
  }

  // ---------------- commands ----------------

  private tokens(s: string) {
    return s.split(/\s+/).map((x) => x.trim()).filter(Boolean);
  }

  private async spec(command: string, select?: string[]): Promise<RunSpec | null> {
    const c = this.cfg;
    if (!c) return null;
    if (c.runtime.kind === "local" && !c.runtime.dbt) {
      this.runtimeDialog();
      return null;
    }
    let vars: Record<string, unknown> | null = null;
    if (c.vars.trim()) {
      try {
        vars = JSON.parse(c.vars);
      } catch {
        toast("As variáveis (--vars) precisam ser um objeto JSON.", "error");
        return null;
      }
    }
    return {
      projectDir: c.projectDir,
      runtime: c.runtime,
      command,
      select: select ?? this.tokens(this.sel.value),
      exclude: this.tokens(this.exc.value),
      target: c.target,
      fullRefresh: this.full.checked && ["run", "build", "seed"].includes(command),
      vars,
      threads: c.threads,
      profileId: c.profileId,
      profilesDir: c.profilesDir,
    };
  }

  /** Runs `dbt ls` with the same selection and returns the selected nodes. */
  private preview(spec: RunSpec): Promise<{ type: string; name: string; materialized: string }[] | null> {
    const procId = "dbtls-" + uid();
    let out = "";
    return new Promise((resolve) => {
      const offOut = on<ProcOut>("proc-out", procId, (e) => (out += e.data));
      const offExit = on<ProcExit>("proc-exit", procId, (e) => {
        offOut();
        offExit();
        if (e.code !== 0) return resolve(null);
        const nodes = out
          .split(/\r?\n/)
          .filter((l) => l.trim().startsWith("{"))
          .map((l) => {
            try {
              const j = JSON.parse(l);
              return { type: j.resource_type ?? "", name: j.name ?? "", materialized: j.config?.materialized ?? "" };
            } catch {
              return null;
            }
          })
          .filter((x): x is { type: string; name: string; materialized: string } => !!x);
        resolve(nodes);
      });
      dbt.run(procId, { ...spec, command: "ls", fullRefresh: false, threads: null }).catch(() => {
        offOut();
        offExit();
        resolve(null);
      });
    });
  }

  async runCmd(command: string, select?: string[]) {
    if (this.running?.isRunning) return toast("Já há uma execução do dbt em andamento neste projeto.", "info");
    const spec = await this.spec(command, select);
    if (!spec) return;
    if (WRITES_DB.includes(command)) {
      const nodes = await this.preview(spec);
      const affected = nodes?.filter((n) => ["model", "seed", "snapshot"].includes(n.type)) ?? null;
      const tests = nodes?.filter((n) => n.type === "test" || n.type === "unit_test").length ?? 0;
      const incr = affected?.filter((n) => n.materialized === "incremental" || n.type === "seed").length ?? 0;
      const m = modal(`dbt ${command}: confirmar alterações no banco`, { width: 560 });
      m.body.append(
        h("div", null, "Target: ", h("b", null, this.targetInfo())),
        h("div", { style: "margin-top:6px" }, "Seleção: ", h("code", null, spec.select?.length ? spec.select.join(" ") : "projeto inteiro"), spec.exclude?.length ? h("span", null, " · excluir ", h("code", null, spec.exclude.join(" "))) : ""),
        affected
          ? h("div", { style: "margin-top:6px" }, `${affected.length} objeto(s) serão criados ou alterados no banco (${affected.filter((n) => n.type === "model").length} modelos, ${affected.filter((n) => n.type === "seed").length} seeds, ${affected.filter((n) => n.type === "snapshot").length} snapshots)${tests ? ` e ${tests} testes executados` : ""}.`)
          : h("div.af-warn", { style: "margin-top:6px" }, icon("status/warning"), "Não foi possível calcular o alcance (dbt ls falhou). Confira a seleção."),
        affected?.length ? h("div.dbt-scope", null, ...affected.slice(0, 60).map((n) => h("div", null, h("span.dim", null, n.type + " "), n.name, n.materialized ? h("span.dim", null, ` (${n.materialized})`) : ""))) : "",
        spec.fullRefresh ? h("div.af-warn", { style: "margin-top:8px" }, icon("status/warning"), `--full-refresh: ${incr} modelo(s) incremental(is) e seed(s) serão descartados e reconstruídos do zero. Dados históricos acumulados por incrementais podem ser perdidos, e a execução pode demorar.`) : "",
      );
      const ok = await new Promise<boolean>((resolve) => {
        m.footer.append(button("Cancelar", () => (m.close(), resolve(false))), button(`Executar dbt ${command}`, () => (m.close(), resolve(true)), spec.fullRefresh ? "danger" : "primary"));
      });
      if (!ok) return;
    }
    const display = `dbt ${command.replace("-", " ")}${spec.select?.length ? " -s " + spec.select.join(" ") : ""}${spec.fullRefresh ? " --full-refresh" : ""}`;
    const tab = new DbtRunTab(this.wb, spec, display, () => {
      this.loadArtifacts();
      this.render();
    });
    this.running = tab;
    this.render();
    await tab.start();
    this.render();
  }

  // ---------------- docs ----------------

  private async serveDocs() {
    if (!this.summary?.manifest.present || !(await host.exists(P.join(this.cfg!.projectDir, "target", "index.html")))) {
      if (await confirmDialog("Documentação não gerada", "Execute dbt docs generate primeiro?", "Gerar")) this.runCmd("docs-generate");
      return;
    }
    const spec = await this.spec("docs-serve", []);
    if (!spec) return;
    const port = await host.freePort();
    const procId = "dbtdocs-" + uid();
    const offExit = on<ProcExit>("proc-exit", procId, () => {
      offExit();
      if (this.docs?.procId === procId) this.docs = null;
      this.render();
    });
    try {
      await dbt.run(procId, { ...spec, select: [], exclude: [], port });
    } catch (e) {
      offExit();
      return notify("Falha ao servir a documentação", errText(e), "error");
    }
    this.docs = { procId, port };
    this.render();
    for (let i = 0; i < 40; i++) {
      const up = await fetch(`http://127.0.0.1:${port}/`, { mode: "no-cors" }).then(() => true).catch(() => false);
      if (up) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    this.openDocs();
  }

  private openDocs() {
    if (!this.docs) return;
    const url = `http://127.0.0.1:${this.docs.port}/`;
    const w = new WebviewWindow(`dbt-docs-${this.docs.port}`, { url, title: `dbt docs — ${P.base(this.cfg!.projectDir)}`, width: 1280, height: 860, center: true });
    w.once("tauri://error", () => import("../airflow/web").then((m) => m.openExternal(url)));
  }

  private async stopDocs() {
    if (!this.docs) return;
    await dbt.cancel(this.docs.procId).catch(() => {});
    this.docs = null;
    this.render();
  }

  // ---------------- dialogs ----------------

  private async newFromTemplate(id: string, dir: string) {
    const t = TEMPLATES.find((x) => x.id === id)!;
    const name = await promptDialog(`Novo: ${t.label}`, "Nome do arquivo (sem extensão)", t.name);
    if (!name) return;
    if (!/^[A-Za-z0-9_]+$/.test(name)) return toast("Use letras, números e _ no nome.", "error");
    const path = P.join(dir, name + t.ext);
    if (await host.exists(path)) return toast("Já existe um arquivo com esse nome.", "error");
    if (!(await host.exists(dir))) await host.create(dir, true);
    await host.write(path, t.body(name));
    this.wb.editors.openFile(path);
  }

  runtimeDialog() {
    const c = this.cfg ?? defaults("");
    const m = modal("Ambiente de execução do dbt", { width: 600 });
    const kind = h("select.input", null, h("option", { value: "local" }, "dbt Core de um ambiente Python"), h("option", { value: "docker" }, "Container Docker (imagem oficial dbt Labs)")) as HTMLSelectElement;
    kind.value = c.runtime.kind;
    const path = h("input.input", { value: c.runtime.dbt, placeholder: "caminho do executável dbt", spellcheck: false }) as HTMLInputElement;
    const image = h("input.input", { value: c.runtime.image || DBT_IMAGE, spellcheck: false }) as HTMLInputElement;
    const threads = h("input.input", { type: "number", min: 1, max: 64, value: c.threads ?? "", placeholder: "do perfil", style: "width:90px" }) as HTMLInputElement;
    const vars = h("textarea.input", { rows: 3, placeholder: '{"data_inicio": "2024-01-01"}', spellcheck: false }, c.vars) as HTMLTextAreaElement;
    const py = this.wb.python;
    m.body.append(
      h(
        "div.form-grid",
        null,
        h("label.field.span2", null, h("span", null, "Execução"), kind),
        h("label.field.span2", null, h("span", null, "Executável do dbt (ambiente Python)"), h("div.af-filter-row", null, path, h("button.btn", { onclick: async () => { const f = await openDialog({ multiple: false }); if (typeof f === "string") path.value = P.norm(f); } }, "…"))),
        h("label.field.span2", null, h("span", null, "Imagem Docker"), image),
        h("label.field", null, h("span", null, "Threads"), threads),
        h("label.field.span2", null, h("span", null, "Variáveis (--vars, JSON)"), vars),
      ),
      h(
        "div.hint",
        { style: "margin-top:8px" },
        "Validado com dbt Core 1.10–1.12 e dbt-postgres. O Rits não instala dependências globalmente. ",
        py ? h("button.link", { onclick: () => this.installInVenv(m.close) }, `Instalar dbt-core e dbt-postgres no ambiente do projeto (${py.label ?? py.path})`) : "Crie um ambiente virtual do projeto para instalar o dbt nele.",
      ),
      h("div.hint", null, "Docker: o projeto é montado em /usr/app e o profiles.yml gerenciado em /rits/profiles; para um banco em localhost, use host.docker.internal no target."),
    );
    m.footer.append(
      button("Cancelar", () => m.close()),
      button("Salvar", () => {
        if (!this.cfg && !c.projectDir) {
          // no project yet: runtime saved for the wizard
          this.save({ ...c, projectDir: "", runtime: { kind: kind.value as "local" | "docker", dbt: path.value.trim(), image: image.value.trim() || DBT_IMAGE } });
        } else {
          this.save({ ...c, runtime: { kind: kind.value as "local" | "docker", dbt: path.value.trim(), image: image.value.trim() || DBT_IMAGE }, threads: Number(threads.value) || null, vars: vars.value.trim() });
        }
        m.close();
        this.refresh();
      }, "primary"),
    );
  }

  private async installInVenv(close: () => void) {
    const py = this.wb.python;
    if (!py) return;
    if (!(await confirmDialog("Instalar o dbt no ambiente do projeto", `Executar "pip install dbt-core dbt-postgres" no interpretador ${py.path}? Nada é instalado globalmente.`, "Instalar"))) return;
    close();
    const t = await runBackground("Instalando dbt-core e dbt-postgres", py.path, ["-m", "pip", "install", "dbt-core>=1.10,<1.13", "dbt-postgres"]);
    if (t.code === 0) {
      toast("dbt instalado no ambiente do projeto.", "ok");
      if (this.cfg) this.save({ ...this.cfg, runtime: { ...this.cfg.runtime, kind: "local", dbt: "" } });
      this.refresh();
    } else notify("Falha ao instalar o dbt", t.output.split("\n").slice(-8).join("\n"), "error");
  }

  async profileDialog() {
    const c = this.cfg;
    if (!c) return;
    const profileName = (await dbt.projectProfile(c.projectDir).catch(() => null)) ?? P.base(c.projectDir);
    const existing = this.profile();
    const pgConns = store.connections.filter((x) => x.kind === "postgres");
    const m = modal("Perfil do dbt (profiles.yml)", { width: 720 });
    const mode = h("select.input", null, h("option", { value: "managed" }, "Gerenciado pelo Rits (PostgreSQL, senhas no cofre do sistema)"), h("option", { value: "own" }, "Meu próprio profiles.yml (qualquer adapter)")) as HTMLSelectElement;
    mode.value = c.profileId || !c.profilesDir ? "managed" : "own";
    const ownDir = h("input.input", { value: c.profilesDir, placeholder: "pasta com profiles.yml (vazio = ~/.dbt)", spellcheck: false }) as HTMLInputElement;
    type Row = { t: Target; pw: HTMLInputElement; el: HTMLElement };
    const rows: Row[] = [];
    const list = h("div.dbt-targets");
    const passwords: Record<string, string> = {};
    const addRow = (t: Target) => {
      const name = h("input.input", { value: t.name, placeholder: "dev", style: "width:90px" }) as HTMLInputElement;
      const conn = h("select.input", null, h("option", { value: "" }, "digitar host…"), ...pgConns.map((x) => h("option", { value: x.id, selected: x.id === t.connId }, `${x.name} (${x.host}:${x.port})`))) as HTMLSelectElement;
      const hostI = h("input.input", { value: t.host, placeholder: "host" }) as HTMLInputElement;
      const port = h("input.input", { type: "number", value: t.port || 5432, style: "width:80px" }) as HTMLInputElement;
      const user = h("input.input", { value: t.user, placeholder: "usuário" }) as HTMLInputElement;
      const db = h("input.input", { value: t.dbname, placeholder: "banco" }) as HTMLInputElement;
      const schema = h("input.input", { value: t.schema, placeholder: "schema (obrigatório)" }) as HTMLInputElement;
      const threads = h("input.input", { type: "number", value: t.threads || 4, min: 1, max: 64, style: "width:70px" }) as HTMLInputElement;
      const ssl = h("select.input", null, ...["prefer", "disable", "require", "verify-ca", "verify-full"].map((x) => h("option", { value: x, selected: (t.sslmode || "prefer") === x }, x))) as HTMLSelectElement;
      const pw = h("input.input", { type: "password", placeholder: existing?.targetsWithPassword?.includes(t.name) ? "(mantém a senha salva)" : "senha", autocomplete: "off" }) as HTMLInputElement;
      const manual = h("div.dbt-trow", null, hostI, port, user, pw);
      const sync = () => (manual.style.display = conn.value ? "none" : "");
      conn.onchange = sync;
      sync();
      const el = h("div.dbt-target", null, h("div.dbt-trow", null, name, conn, db, schema, threads, ssl, h("button.icon-btn", { title: "Remover", onclick: () => (rows.splice(rows.indexOf(row), 1), el.remove()) }, icon("general/delete"))), manual, h("div.hint", null, "Com uma conexão do Rits, host, porta, usuário e senha vêm dela (somente conexões PostgreSQL têm mapeamento válido para o dbt-postgres)."));
      const row: Row = {
        t,
        pw,
        el,
      };
      Object.defineProperty(row, "t", { get: () => ({ name: name.value.trim(), connId: conn.value, host: hostI.value.trim(), port: Number(port.value) || 5432, user: user.value.trim(), dbname: db.value.trim(), schema: schema.value.trim(), threads: Number(threads.value) || 4, sslmode: ssl.value }) });
      rows.push(row);
      list.append(el);
    };
    for (const t of existing?.targets ?? [{ name: "dev", connId: pgConns[0]?.id ?? "", host: "", port: 5432, user: "", dbname: "", schema: "", threads: 4, sslmode: "prefer" }]) addRow(t);
    const envList = h("div.dbt-env");
    const envRows: { n: HTMLInputElement; v: HTMLInputElement; s: HTMLInputElement }[] = [];
    const addEnv = (e = { name: "", value: "", secret: false }) => {
      const n = h("input.input", { value: e.name, placeholder: "NOME_DA_VARIAVEL", style: "width:200px" }) as HTMLInputElement;
      const v = h("input.input", { value: e.secret ? "" : e.value, type: e.secret ? "password" : "text", placeholder: e.secret ? "(mantém o valor salvo)" : "valor" }) as HTMLInputElement;
      const s = h("input", { type: "checkbox", checked: e.secret, onchange: () => (v.type = s.checked ? "password" : "text") }) as HTMLInputElement;
      envRows.push({ n, v, s });
      envList.append(h("div.dbt-trow", null, n, v, h("label.check", null, s, "secreta")));
    };
    for (const e of existing?.env ?? []) addEnv(e);
    const defaultT = h("input.input", { value: existing?.defaultTarget ?? "dev", style: "width:110px" }) as HTMLInputElement;
    const managed = h(
      "div",
      null,
      h("div.dim", null, `Perfil "${profileName}" (do dbt_project.yml). O profiles.yml é gravado na pasta de configuração do Rits, fora do repositório, sem senhas: elas entram como variável de ambiente só durante a execução.`),
      h("div.af-filter-row", { style: "margin:8px 0" }, h("span.dim", null, "Target padrão"), defaultT, h("span.grow"), h("button.btn", { onclick: () => addRow({ name: "", connId: "", host: "", port: 5432, user: "", dbname: "", schema: "", threads: 4, sslmode: "prefer" }) }, icon("general/add"), "Target")),
      list,
      h("div.afd-sec", { style: "padding-left:0" }, "Variáveis de ambiente (env_var() no projeto)"),
      envList,
      h("button.btn", { onclick: () => addEnv() }, icon("general/add"), "Variável"),
    );
    const own = h("div", null, h("label.field", null, h("span", null, "Pasta do profiles.yml"), ownDir), h("div.hint", null, this.version?.adapters.length ? `Adapters instalados: ${this.version.adapters.map(([a, v]) => `${a} ${v}`).join(", ")}.` : "", " Outros bancos só funcionam quando o adapter correspondente está instalado e validado por você; nem todo banco suportado pela IDE tem adapter dbt."));
    const sync = () => {
      managed.style.display = mode.value === "managed" ? "" : "none";
      own.style.display = mode.value === "own" ? "" : "none";
    };
    mode.onchange = sync;
    sync();
    m.body.append(h("label.field", null, h("span", null, "Tipo de perfil"), mode), h("div", { style: "margin-top:10px" }, managed, own));
    m.footer.append(
      button("Cancelar", () => m.close()),
      button("Salvar", async () => {
        if (mode.value === "own") {
          this.save({ ...c, profileId: "", profilesDir: ownDir.value.trim() });
          m.close();
          return this.refresh();
        }
        const targets = rows.map((r) => r.t);
        for (const r of rows) if (r.pw.value) passwords[r.t.name] = r.pw.value;
        const env = envRows.filter((e) => e.n.value.trim()).map((e) => ({ name: e.n.value.trim(), value: e.s.checked ? "" : e.v.value, secret: e.s.checked }));
        const secretEnv: Record<string, string> = {};
        for (const e of envRows) if (e.s.checked && e.v.value) secretEnv[e.n.value.trim()] = e.v.value;
        try {
          const saved = await dbt.saveProfile({ id: existing?.id ?? "", projectDir: c.projectDir, profileName, defaultTarget: defaultT.value.trim() || targets[0]?.name || "dev", targets, env }, passwords, secretEnv);
          this.save({ ...c, profileId: saved.id, profilesDir: "" });
          m.close();
          this.refresh();
          toast("Perfil salvo. Rode dbt debug para testar a conexão.", "ok");
        } catch (e) {
          toast(errText(e), "error");
        }
      }, "primary"),
    );
  }

  private async initWizard() {
    const m = modal("Criar projeto dbt (dbt init)", { width: 560 });
    const name = h("input.input", { value: "analytics", spellcheck: false }) as HTMLInputElement;
    const parent = h("input.input", { value: this.wb.root, spellcheck: false }) as HTMLInputElement;
    m.body.append(
      h("div.form-grid", null, h("label.field.span2", null, h("span", null, "Nome do projeto (letras minúsculas, números e _)"), name), h("label.field.span2", null, h("span", null, "Pasta onde criar"), parent)),
      h("div.hint", { style: "margin-top:8px" }, "Usa o comando oficial dbt init --skip-profile-setup. O perfil é configurado em seguida, pelo Rits, sem gravar senhas no repositório."),
    );
    m.footer.append(
      button("Cancelar", () => m.close()),
      button("Criar", async () => {
        const base = this.cfg ?? defaults("");
        const runtime = base.runtime.kind === "local" && !base.runtime.dbt ? { ...base.runtime, dbt: await this.resolveDbt().catch(() => "") } : base.runtime;
        if (runtime.kind === "local" && !runtime.dbt) {
          m.close();
          toast("Configure o ambiente do dbt primeiro.", "info");
          return this.runtimeDialog();
        }
        m.close();
        const spec: RunSpec = { projectDir: P.norm(parent.value.trim()), runtime, command: "init", initName: name.value.trim() };
        const tab = new DbtRunTab(this.wb, spec, `dbt init ${spec.initName}`, async (code) => {
          if (code !== 0) return;
          const dir = P.join(spec.projectDir, spec.initName!);
          this.save({ ...defaults(dir), runtime });
          await this.refresh();
          this.wb.projectView?.reveal(P.join(dir, "dbt_project.yml"));
          this.profileDialog();
        });
        tab.start();
      }, "primary"),
    );
  }
}
