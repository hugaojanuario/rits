// Local Airflow environment on Docker (development only). The compose file is generated from the
// official docker-compose.yaml of the pinned Airflow version, with LocalExecutor instead of Celery.
// Secrets come from the OS store at "docker compose" time (backend: airflow_env_compose); ports are
// published on 127.0.0.1 only; containers and volumes carry the label dev.rits.plugin=airflow.
import { invoke } from "@tauri-apps/api/core";
import { h, uid } from "../../util";
import { icon } from "../../icons";
import { button, confirmDialog, contextMenu, modal, notify, promptDialog, toast } from "../../ui";
import { host, on, P, type ProcExit, type ProcOut } from "../host";
import type { Tab } from "../../tabs";
import { dockerEnabled, setDockerEnabled } from "../docker";
import { errorText, instances } from "./api";
import type { AirflowTools } from "./panel";

export const AIRFLOW_VERSION = "3.3.2";
/** apache-airflow-task-sdk pinned by apache-airflow 3.3.2 (its requires_dist). */
export const TASK_SDK_VERSION = "1.3.2";
export const POSTGRES_IMAGE = "postgres:16.15";

export interface LocalEnv {
  slug: string;
  name: string;
  port: number;
  /** Absolute folder mounted at /opt/airflow/dags. */
  dagsDir: string;
  project: string;
  created: number;
}

const DOC = "airflow-envs";

export const ENV_SERVICES: [string, string][] = [
  ["postgres", `Banco de metadados (${POSTGRES_IMAGE}), volume persistente`],
  ["airflow-init", "Migração do banco e criação do usuário admin (roda uma vez)"],
  ["airflow-apiserver", "API pública /api/v2 e interface web, em 127.0.0.1"],
  ["airflow-scheduler", "Agenda e executa as tarefas (LocalExecutor)"],
  ["airflow-dag-processor", "Lê os arquivos de DAG da pasta montada"],
  ["airflow-triggerer", "Tarefas adiadas (deferrable)"],
];

export function composeFor(env: LocalEnv) {
  return `# Ambiente LOCAL de desenvolvimento do Apache Airflow ${AIRFLOW_VERSION}, criado pelo Rits.
# Baseado no docker-compose.yaml oficial da ${AIRFLOW_VERSION}, trocando CeleryExecutor por LocalExecutor
# (sem Redis, worker e Flower) para usar menos recursos. NÃO é uma implantação de produção.
# Segredos (senha do admin, JWT e Fernet) vêm do Keychain / Credential Manager como variáveis
# de ambiente no momento do "docker compose": nada sensível fica gravado neste arquivo.
# Gerencie pelo Rits (janela Airflow): os comandos precisam dessas variáveis.
name: rits-airflow-${env.slug}

x-rits-labels: &rits-labels
  dev.rits.plugin: airflow
  dev.rits.env: "${env.slug}"
  dev.rits.purpose: development

x-airflow-common: &airflow-common
  image: apache/airflow:${AIRFLOW_VERSION}
  labels: *rits-labels
  environment: &airflow-common-env
    AIRFLOW__CORE__EXECUTOR: LocalExecutor
    AIRFLOW__CORE__AUTH_MANAGER: airflow.providers.fab.auth_manager.fab_auth_manager.FabAuthManager
    AIRFLOW__DATABASE__SQL_ALCHEMY_CONN: postgresql+psycopg2://airflow:airflow@postgres/airflow
    AIRFLOW__CORE__FERNET_KEY: \${RITS_AF_FERNET_KEY:?defina pelo Rits}
    AIRFLOW__CORE__DAGS_ARE_PAUSED_AT_CREATION: "true"
    AIRFLOW__CORE__LOAD_EXAMPLES: "false"
    AIRFLOW__CORE__EXECUTION_API_SERVER_URL: http://airflow-apiserver:8080/execution/
    AIRFLOW__API_AUTH__JWT_SECRET: \${RITS_AF_JWT_SECRET:?defina pelo Rits}
    AIRFLOW__API_AUTH__JWT_ISSUER: rits-airflow
    AIRFLOW__SCHEDULER__ENABLE_HEALTH_CHECK: "true"
    # novos arquivos de DAG são descobertos em até 30 s (padrão: 300 s)
    AIRFLOW__DAG_PROCESSOR__REFRESH_INTERVAL: "30"
    AIRFLOW_CONFIG: /opt/airflow/config/airflow.cfg
  volumes:
    - \${RITS_AF_DAGS:?defina pelo Rits}:/opt/airflow/dags
    - logs:/opt/airflow/logs
    - config:/opt/airflow/config
    - plugins:/opt/airflow/plugins
  user: "\${AIRFLOW_UID:-50000}:0"
  depends_on: &airflow-common-depends-on
    postgres:
      condition: service_healthy

services:
  postgres:
    image: ${POSTGRES_IMAGE}
    labels: *rits-labels
    environment:
      POSTGRES_USER: airflow
      POSTGRES_PASSWORD: airflow
      POSTGRES_DB: airflow
    volumes:
      - postgres-db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "airflow"]
      interval: 10s
      retries: 5
      start_period: 5s
    restart: unless-stopped

  airflow-apiserver:
    <<: *airflow-common
    command: api-server
    ports:
      - "127.0.0.1:\${RITS_AF_PORT:-8080}:8080"
    healthcheck:
      test: ["CMD", "curl", "--fail", "http://localhost:8080/api/v2/monitor/health"]
      interval: 15s
      timeout: 10s
      retries: 10
      start_period: 30s
    restart: unless-stopped
    depends_on:
      <<: *airflow-common-depends-on
      airflow-init:
        condition: service_completed_successfully

  airflow-scheduler:
    <<: *airflow-common
    command: scheduler
    healthcheck:
      test: ["CMD-SHELL", 'airflow jobs check --job-type SchedulerJob --hostname "$\${HOSTNAME}"']
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 30s
    restart: unless-stopped
    depends_on:
      <<: *airflow-common-depends-on
      airflow-init:
        condition: service_completed_successfully

  airflow-dag-processor:
    <<: *airflow-common
    command: dag-processor
    healthcheck:
      test: ["CMD-SHELL", 'airflow jobs check --job-type DagProcessorJob --hostname "$\${HOSTNAME}"']
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 30s
    restart: unless-stopped
    depends_on:
      <<: *airflow-common-depends-on
      airflow-init:
        condition: service_completed_successfully

  airflow-triggerer:
    <<: *airflow-common
    command: triggerer
    healthcheck:
      test: ["CMD-SHELL", 'airflow jobs check --job-type TriggererJob --hostname "$\${HOSTNAME}"']
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 30s
    restart: unless-stopped
    depends_on:
      <<: *airflow-common-depends-on
      airflow-init:
        condition: service_completed_successfully

  airflow-init:
    <<: *airflow-common
    entrypoint: /bin/bash
    command:
      - -c
      - |
        mkdir -p /opt/airflow/{logs,dags,plugins,config}
        /entrypoint airflow version
        /entrypoint airflow config list >/dev/null
        chown -R "\${AIRFLOW_UID:-50000}:0" /opt/airflow/{logs,plugins,config}
    environment:
      <<: *airflow-common-env
      _AIRFLOW_DB_MIGRATE: "true"
      _AIRFLOW_WWW_USER_CREATE: "true"
      _AIRFLOW_WWW_USER_USERNAME: airflow
      _AIRFLOW_WWW_USER_PASSWORD: \${RITS_AF_ADMIN_PASSWORD:?defina pelo Rits}
    user: "0:0"

volumes:
  postgres-db:
    labels: *rits-labels
  logs:
    labels: *rits-labels
  config:
    labels: *rits-labels
  plugins:
    labels: *rits-labels
`;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "dev";

export class LocalEnvs {
  private list: LocalEnv[] = [];
  private states = new Map<string, string>();
  private logTabs = new Set<string>();

  constructor(private tools: AirflowTools) {
    this.load();
  }

  dispose() {
    // log followers are tied to their tabs, closed by the panel; containers keep running
  }

  private async load() {
    this.list = (await host.loadDoc<LocalEnv[]>(DOC).catch(() => null)) ?? [];
    for (const e of this.list) this.refreshState(e.slug);
  }

  private save() {
    return host.saveDoc(DOC, this.list);
  }

  get(slug: string) {
    return this.list.find((e) => e.slug === slug);
  }

  /** "running 6/6" from docker ps, by label (no secrets needed). */
  async refreshState(slug: string) {
    const r = await host.capture("docker", ["ps", "-a", "--filter", `label=dev.rits.env=${slug}`, "--filter", "label=dev.rits.plugin=airflow", "--format", "{{.Label \"com.docker.compose.service\"}}\t{{.State}}"], "", undefined, 15).catch(() => null);
    if (!r || r.code !== 0) {
      this.states.set(slug, "docker indisponível");
    } else {
      const rows = r.stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split("\t"));
      const longRunning = rows.filter(([s]) => s !== "airflow-init");
      const up = longRunning.filter(([, st]) => st === "running").length;
      this.states.set(slug, rows.length === 0 ? "não criado" : up === 0 ? "parado" : up === longRunning.length ? "rodando" : `${up}/${longRunning.length} rodando`);
    }
    this.tools.render();
  }

  badge(slug: string): HTMLElement {
    const st = this.states.get(slug) ?? "…";
    const b = h("button.af-env", { class: st === "rodando" ? "ok" : "", title: "Ambiente local de desenvolvimento (Docker)" }, icon("docker"), h("span", null, `dev · ${st}`), icon("general/chevronDown")) as HTMLButtonElement;
    b.onclick = (e) => contextMenu(e.clientX, e.clientY + 8, this.menu(slug));
    return b;
  }

  private menu(slug: string) {
    return [
      { label: "Iniciar", icon: "run/run", action: () => this.start(slug) },
      { label: "Parar (mantém os dados)", icon: "run/stop", action: () => this.compose(slug, ["stop"], "Parando o Airflow local") },
      { label: "Reiniciar", icon: "run/restart", action: () => this.compose(slug, ["restart"], "Reiniciando o Airflow local") },
      { label: "Logs dos serviços", icon: "log", action: () => this.logs(slug) },
      { label: "Atualizar estado", icon: "general/refresh", action: () => this.refreshState(slug) },
      ...(dockerEnabled() ? [{ label: "Abrir janela Docker", icon: "docker", action: () => this.tools.wb.show("docker", true) }] : []),
      { separator: true },
      { label: "Excluir ambiente e dados…", icon: "general/delete", danger: true, action: () => this.destroy(slug) },
    ];
  }

  // ---------------- creation ----------------

  async createDialog() {
    const wb = this.tools.wb;
    const r = await host.capture("docker", ["info", "--format", "{{.ServerVersion}}"], "", undefined, 15).catch(() => null);
    if (!r || r.code !== 0) {
      return notify("Docker indisponível", "O ambiente local usa o Docker. Instale ou inicie o Docker (plugin Docker em Configurações › Plugins) e tente de novo.", "error", [], 10000);
    }
    const m = modal("Criar ambiente local do Airflow", { width: 640 });
    const base = P.base(wb.root);
    const name = h("input.input", { value: `${base} (dev)` }) as HTMLInputElement;
    const port = h("input.input", { type: "number", value: "8080", min: 1024, max: 65535, style: "width:110px" }) as HTMLInputElement;
    const dags = h("input.input", { value: wb.settings.airflow?.dagsDir ?? "dags", spellcheck: false }) as HTMLInputElement;
    m.body.append(
      h("div.af-warn", null, icon("status/warning"), "Ambiente de desenvolvimento. Não é uma implantação de produção (sem alta disponibilidade, segredos de banco simples, executor local)."),
      h(
        "div.form-grid",
        { style: "margin-top:12px" },
        h("label.field.span2", null, h("span", null, "Nome"), name),
        h("label.field", null, h("span", null, "Pasta de DAGs (no projeto)"), dags),
        h("label.field", null, h("span", null, "Porta em 127.0.0.1"), port),
      ),
      h("h4", { style: "margin:14px 0 6px" }, `Serviços (Airflow ${AIRFLOW_VERSION}, versões fixadas)`),
      h("div.af-plan", null, ...ENV_SERVICES.map(([s, d]) => h("div", null, h("b", null, s), h("span.dim", null, ` — ${d}`)))),
      h("h4", { style: "margin:14px 0 6px" }, "Recursos criados"),
      h(
        "div.af-plan",
        null,
        h("div", null, "Volumes persistentes: ", h("code", null, "postgres-db, logs, config, plugins"), h("span.dim", null, " (preservados ao parar)")),
        h("div", null, "Pasta do projeto montada em ", h("code", null, "/opt/airflow/dags")),
        h("div", null, "Usuário ", h("code", null, "airflow"), " com senha aleatória no cofre do sistema; autenticação obrigatória"),
        h("div", null, "Imagens: ", h("code", null, `apache/airflow:${AIRFLOW_VERSION}`), " (~3,2 GB) e ", h("code", null, POSTGRES_IMAGE), h("span.dim", null, " · recomendado: 4 GB de RAM para o Docker")),
        h("div.dim", null, "Containers e volumes recebem o rótulo dev.rits.plugin=airflow."),
      ),
    );
    const go = button("Criar e iniciar", async () => {
      go.disabled = true;
      const env: LocalEnv = {
        slug: slugify(name.value || base),
        name: name.value.trim() || base,
        port: Math.max(1024, Math.min(65535, Number(port.value) || 8080)),
        dagsDir: P.join(wb.root, dags.value.trim().replace(/^\/+|\/+$/g, "") || "dags"),
        project: wb.root,
        created: Date.now(),
      };
      if (this.get(env.slug)) env.slug = `${env.slug}-${uid().slice(-4)}`;
      m.close();
      await this.create(env, dags.value.trim().replace(/^\/+|\/+$/g, "") || "dags");
    }, "primary", "docker") as HTMLButtonElement;
    m.footer.append(button("Cancelar", () => m.close()), go);
  }

  private async create(env: LocalEnv, dagsRel: string) {
    const wb = this.tools.wb;
    if (!dockerEnabled()) {
      setDockerEnabled(true);
      toast("Plugin Docker ativado: os containers do Airflow aparecem na janela Docker.", "info", 6000);
    }
    try {
      if (!(await host.exists(env.dagsDir))) await host.create(env.dagsDir, true);
      const dir = await invoke<string>("airflow_env_dir", { slug: env.slug });
      await host.write(P.join(dir, "compose.yaml"), composeFor(env));
    } catch (e) {
      return notify("Falha ao preparar o ambiente", errorText(e), "error");
    }
    this.list.push(env);
    await this.save();
    wb.settings.airflow = { instanceId: wb.settings.airflow?.instanceId ?? "", dagsDir: dagsRel, delivery: "volume" };
    wb.saveSettings();
    const ok = await this.compose(env.slug, ["up", "-d", "--quiet-pull"], `Criando o Airflow local (${env.name})`);
    if (!ok) return;
    await this.waitAndRegister(env);
  }

  /** Waits for /api/v2/monitor/health, then registers the IDE instance and links the project. */
  private async waitAndRegister(env: LocalEnv) {
    const wb = this.tools.wb;
    const key = "airflow-env-" + env.slug;
    const t0 = Date.now();
    wb.setProgress(key, "Airflow local: aguardando ficar saudável");
    try {
      for (;;) {
        const hlt = await invoke<Record<string, { status?: string }>>("airflow_env_health", { port: env.port }).catch(() => null);
        if (hlt && hlt.metadatabase?.status === "healthy" && hlt.scheduler?.status === "healthy") break;
        if (Date.now() - t0 > 6 * 60_000) {
          notify("O Airflow local não ficou saudável", "Veja os logs dos serviços (menu do ambiente) para entender o motivo.", "error", [{ label: "Ver logs", run: () => this.logs(env.slug) }], 15000);
          return;
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
      const inst = await invoke<{ id: string }>("airflow_env_register", { slug: env.slug, name: env.name, port: env.port });
      const r = await instances.test({ ...(await instances.list()).find((i) => i.id === inst.id)! }, null);
      if (wb.settings.airflow) wb.settings.airflow.instanceId = inst.id;
      wb.saveSettings();
      await this.tools.loadInstances(inst.id);
      notify("Airflow local pronto", `Airflow ${r.version} em http://127.0.0.1:${env.port} (usuário airflow; senha no cofre do sistema). Projeto associado: as DAGs de ${P.rel(wb.root, env.dagsDir)} são lidas pelo Airflow.`, "ok", [{ label: "Nova DAG", run: () => this.tools.project.newDag() }], 12000);
    } catch (e) {
      notify("Falha ao conectar no Airflow local", errorText(e), "error");
    } finally {
      wb.setProgress(key, null);
      this.refreshState(env.slug);
    }
  }

  // ---------------- lifecycle ----------------

  async start(slug: string) {
    const env = this.get(slug);
    if (!env) return toast("Ambiente não encontrado nesta máquina.", "error");
    if (await this.compose(slug, ["up", "-d"], "Iniciando o Airflow local")) await this.waitAndRegister(env);
  }

  /** Runs docker compose through the backend (which injects the secrets); resolves true on exit 0. */
  compose(slug: string, args: string[], title: string): Promise<boolean> {
    const env = this.get(slug);
    if (!env) return Promise.resolve(false);
    const wb = this.tools.wb;
    const procId = "afenv-" + uid();
    const key = "airflow-compose-" + procId;
    let out = "";
    wb.setProgress(key, title);
    return new Promise((resolve) => {
      const offOut = on<ProcOut>("proc-out", procId, (e) => (out = (out + e.data).slice(-6000)));
      const offExit = on<ProcExit>("proc-exit", procId, (e) => {
        offOut();
        offExit();
        wb.setProgress(key, null);
        this.refreshState(slug);
        if (e.code === 0) return resolve(true);
        notify(`Falha: ${title}`, out.trim().split("\n").slice(-6).join("\n") || `docker compose terminou com código ${e.code}`, "error", [], 15000);
        resolve(false);
      });
      invoke<number>("airflow_env_compose", { procId, slug, args, dagsDir: env.dagsDir, port: env.port }).catch((e) => {
        offOut();
        offExit();
        wb.setProgress(key, null);
        notify(`Falha: ${title}`, errorText(e), "error");
        resolve(false);
      });
    });
  }

  /** Follows the services' logs in an editor tab (the follower stops when the tab closes; Airflow keeps running). */
  logs(slug: string) {
    const env = this.get(slug);
    const wb = this.tools.wb;
    if (!env) return;
    const id = `airflow-envlogs:${slug}`;
    const open = wb.tabs.find(id);
    if (open) return wb.tabs.activate(open);
    const procId = "afenvlog-" + uid();
    const pre = h("pre.afd-log.af-envlog");
    const el = h("div.afd", null, h("div.afd-head", null, h("div.afd-title", null, icon("docker"), h("b", null, `Logs — ${env.name}`), h("span.dim", null, " (docker compose logs -f)"))), pre);
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const offOut = on<ProcOut>("proc-out", procId, (e) => {
      const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
      pre.append(strip(e.data));
      if (pre.textContent!.length > 400_000) pre.textContent = pre.textContent!.slice(-300_000);
      if (atEnd) pre.scrollTop = pre.scrollHeight;
    });
    const offExit = on<ProcExit>("proc-exit", procId, () => pre.append("\n[fim dos logs]\n"));
    const tab: Tab = {
      id,
      title: `Logs · ${env.name}`,
      icon: "log",
      el,
      onClose: () => {
        offOut();
        offExit();
        host.kill(procId).catch(() => {});
        this.logTabs.delete(procId);
      },
    };
    this.logTabs.add(procId);
    wb.tabs.open(tab);
    invoke<number>("airflow_env_compose", { procId, slug, args: ["logs", "-f", "--tail", "300", "--no-color"], dagsDir: env.dagsDir, port: env.port }).catch((e) => pre.append(errorText(e)));
  }

  /** Deletes containers AND volumes after the user types the environment name. */
  async destroy(slug: string) {
    const env = this.get(slug);
    if (!env) return;
    const typed = await promptDialog(
      "Excluir ambiente e dados",
      `Isto remove os containers e os volumes (banco de metadados, histórico de execuções, logs) de "${env.name}". Os arquivos de DAG do projeto não são apagados. Digite ${env.slug} para confirmar:`,
    );
    if (typed !== env.slug) {
      if (typed !== null) toast("Nome não confere: nada foi excluído.", "error");
      return;
    }
    if (!(await confirmDialog("Confirmar exclusão", `Excluir definitivamente os dados de ${env.slug}?`, "Excluir dados", true))) return;
    const ok = await this.compose(slug, ["down", "-v", "--remove-orphans", "--rits-confirmed-delete"], "Excluindo o ambiente local");
    if (!ok) return;
    await invoke("airflow_env_forget", { slug }).catch(() => {});
    const inst = (await instances.list()).find((i) => i.localEnv === slug);
    if (inst) await instances.remove(inst.id).catch(() => {});
    this.list = this.list.filter((e) => e.slug !== slug);
    await this.save();
    toast("Ambiente e dados excluídos.", "ok");
    this.tools.loadInstances();
  }
}
