// Project ↔ Airflow: association (instance, DAG folder, delivery), DAG templates, local file of a
// DAG, and feedback after saving (saving a file does not mean Airflow has processed it).
import { h } from "../../util";
import { button, confirmDialog, modal, notify, promptDialog, toast } from "../../ui";
import { host, P } from "../host";
import { runBackground } from "../sdk";
import type { AirflowProjectLink } from "../project";
import { instances, type Dag } from "./api";
import { AIRFLOW_VERSION, TASK_SDK_VERSION } from "./env";
import type { AirflowTools } from "./panel";

const dagTemplate = (id: string) => `"""DAG ${id} (Airflow 3, TaskFlow API)."""
from datetime import datetime

from airflow.sdk import dag, task


@dag(schedule=None, start_date=datetime(2026, 1, 1), catchup=False, tags=["rits"])
def ${id}():
    @task
    def extrair() -> list[int]:
        return [1, 2, 3]

    @task
    def carregar(valores: list[int]) -> None:
        print(f"total={sum(valores)}")

    carregar(extrair())


${id}()
`;

export class ProjectLink {
  private watches = new Map<string, number>();
  private sdkOffered = false;

  constructor(private tools: AirflowTools) {}

  dispose() {
    for (const t of this.watches.values()) clearTimeout(t);
    this.watches.clear();
  }

  private get link(): AirflowProjectLink | undefined {
    return this.tools.wb.settings.airflow;
  }

  private dagsAbs() {
    return this.link ? P.join(this.tools.wb.root, this.link.dagsDir) : null;
  }

  localFileFor(d: Dag): string | null {
    const base = this.dagsAbs();
    return base && d.relative_fileloc ? P.join(base, d.relative_fileloc) : null;
  }

  localFileForPath(filename: string): string | null {
    const base = this.dagsAbs();
    const i = filename.indexOf("/dags/");
    return base && i >= 0 ? P.join(base, filename.slice(i + 6)) : null;
  }

  async linkDialog() {
    const wb = this.tools.wb;
    const all = await instances.list().catch(() => []);
    const m = modal("Associar projeto ao Airflow", { width: 520 });
    const inst = h("select.select", null, ...all.map((i) => h("option", { value: i.id, selected: i.id === this.link?.instanceId }, i.name))) as HTMLSelectElement;
    const dags = h("input.input", { value: this.link?.dagsDir ?? "dags" }) as HTMLInputElement;
    const delivery = h(
      "select.select",
      null,
      ...([
        ["volume", "Volume do ambiente local (Docker)"],
        ["git", "Git: commit e push (CI ou git-sync publica)"],
        ["manual", "Manual (eu copio os arquivos)"],
      ] as const).map(([v, l]) => h("option", { value: v, selected: this.link?.delivery === v }, l)),
    ) as HTMLSelectElement;
    m.body.append(
      h("label.field", null, h("span", null, "Instância"), inst),
      h("label.field", null, h("span", null, "Pasta de DAGs no projeto"), dags),
      h("label.field", null, h("span", null, "Como os arquivos chegam ao Airflow"), delivery),
      h("div.hint", { style: "margin-top:8px" }, "A API do Airflow não recebe arquivos Python: a publicação é feita pelo volume local ou pelo seu fluxo Git."),
    );
    m.footer.append(
      button("Cancelar", () => m.close()),
      button("Salvar", () => {
        wb.settings.airflow = { instanceId: inst.value, dagsDir: dags.value.trim().replace(/^\/+|\/+$/g, "") || "dags", delivery: delivery.value as AirflowProjectLink["delivery"] };
        wb.saveSettings();
        m.close();
        this.tools.loadInstances(inst.value);
        this.offerSdk();
      }, "primary"),
    );
  }

  async newDag(dir?: string) {
    const base = dir ?? this.dagsAbs() ?? P.join(this.tools.wb.root, "dags");
    const id = await promptDialog("Nova DAG (Airflow 3)", "ID da DAG (letras, números e _)", "minha_dag");
    if (!id) return;
    if (!/^[A-Za-z_][\w]*$/.test(id)) return toast("Use letras, números e _ (começando por letra).", "error");
    const path = P.join(base, `${id}.py`);
    if (await host.exists(path)) return toast("Já existe um arquivo com esse nome.", "error");
    if (!(await host.exists(base))) await host.create(base, true);
    await host.write(path, dagTemplate(id));
    await this.tools.wb.editors.openFile(path);
    notify("DAG criada", "Salvar o arquivo não significa que o Airflow já o processou: o dag-processor lê a pasta periodicamente (até 30 s no ambiente local).", "info", [], 9000);
    this.offerSdk();
  }

  // ---------------- Task SDK (editor autocomplete) ----------------

  /** Installed version of the Task SDK in the project interpreter, or null. */
  async sdkVersion(): Promise<string | null> {
    const py = this.tools.wb.python;
    if (!py) return null;
    const r = await host.capture(py.path, ["-c", 'import importlib.metadata as m;print(m.version("apache-airflow-task-sdk"))'], "", undefined, 20).catch(() => null);
    return r && r.code === 0 ? r.stdout.trim() : null;
  }

  /** Once per session: suggest the SDK when the interpreter does not have it (no automatic install). */
  async offerSdk() {
    if (this.sdkOffered || !this.tools.wb.python || (await this.sdkVersion())) return;
    this.sdkOffered = true;
    notify(
      "Autocomplete das DAGs",
      `O interpretador do projeto não tem o SDK do Airflow (airflow.sdk). Instale apache-airflow-task-sdk ${TASK_SDK_VERSION}, a versão do Airflow ${AIRFLOW_VERSION}, para ter autocomplete e checagem de tipos. As DAGs rodam no Airflow, não neste interpretador.`,
      "info",
      [{ label: "Instalar SDK", run: () => this.installSdk() }],
      15000,
    );
  }

  /** pip install of the pinned Task SDK into the project interpreter, then restarts the Python LSP. */
  async installSdk() {
    const wb = this.tools.wb;
    const py = wb.python;
    if (!py) return toast("Configure um interpretador Python para o projeto (Configurações › Python).", "error");
    if (!py.venv && !(await confirmVenvless(py.label))) return;
    const t = await runBackground(`Instalando apache-airflow-task-sdk ${TASK_SDK_VERSION}`, py.path, ["-m", "pip", "install", `apache-airflow-task-sdk==${TASK_SDK_VERSION}`], wb.root);
    if (t.code !== 0) {
      return notify("Falha ao instalar o SDK do Airflow", t.output.trim().split("\n").slice(-6).join("\n") || `pip terminou com código ${t.code}`, "error", [], 15000);
    }
    await wb.lsp.restart("python").catch(() => null);
    wb.editors.reattachLsp("python");
    toast(`SDK do Airflow ${TASK_SDK_VERSION} instalado em ${py.label}.`, "ok", 6000);
  }

  /** After saves inside the DAG folder: explain the delivery and wait for processing (volume). */
  onFilesChanged(paths: string[]) {
    const base = this.dagsAbs();
    if (!base || !this.link) return;
    for (const p of paths.filter((x) => x.endsWith(".py") && P.inside(base, x))) {
      const key = p.toLowerCase();
      clearTimeout(this.watches.get(key));
      this.watches.set(key, window.setTimeout(() => this.watchProcessing(p, base), 1500));
    }
  }

  private async watchProcessing(path: string, base: string) {
    const link = this.link;
    if (!link) return;
    if (link.delivery !== "volume") {
      toast(link.delivery === "git" ? `${P.base(path)} salvo localmente: publique via Git (commit e push) para o Airflow ler.` : `${P.base(path)} salvo localmente: copie para a pasta de DAGs do Airflow.`, "info", 6000);
      return;
    }
    const api = this.tools.apiFor(link.instanceId);
    if (!api) return;
    const rel = P.rel(base, path);
    const since = Date.now() - 2000;
    const key = "airflow-parse-" + rel;
    this.tools.wb.setProgress(key, `Airflow: aguardando processamento de ${rel}`);
    try {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const errs = await api.importErrors().catch(() => null);
        const err = errs?.import_errors.find((e) => e.filename.endsWith("/" + rel) && Date.parse(e.timestamp) >= since);
        if (err) return notify(`Erro de importação em ${rel}`, err.stack_trace.trim().split("\n").slice(-3).join("\n"), "error", [], 12000);
        const dags = await api.dags({ limit: 100, offset: 0 }).catch(() => null);
        const dag = dags?.dags.find((d) => d.relative_fileloc === rel && d.last_parsed_time && Date.parse(d.last_parsed_time) >= since);
        if (dag) return toast(`DAG ${dag.dag_id} processada pelo Airflow.`, "ok", 5000);
      }
    } finally {
      this.tools.wb.setProgress(key, null);
    }
  }
}

function confirmVenvless(label: string) {
  return confirmDialog(
    "Instalar fora de um venv",
    `O interpretador ${label} não é um ambiente virtual. Recomendado: crie um .venv no projeto (Configurações › Python). Instalar mesmo assim?`,
    "Instalar",
  );
}
