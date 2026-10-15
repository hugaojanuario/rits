// Docker plugin: optional (enabled in Settings › Plugins). Adds the "Docker" tool window to manage local
// containers, images and volumes. Everything goes through the docker CLI (run_capture / proc_spawn).
import { h, uid, debounce } from "../util";
import { icon } from "../icons";
import { button, confirmDialog, contextMenu, notify, textViewer, toast, type MenuItem } from "../ui";
import { host, IS_MAC, IS_WIN, on, type ProcExit, type ProcOut } from "./host";
import { runBackground, type Component } from "./sdk";
import type { Workbench } from "./workbench";

const KEY = "plugin.docker";

export function dockerEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setDockerEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("rits-plugins"));
}

async function docker(args: string[], timeout = 30) {
  return host.capture("docker", args, "", undefined, timeout);
}

async function firstLine(args: string[]): Promise<string | null> {
  const r = await docker(args, 15).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] || "instalado" : null;
}

export const DOCKER_INSTALL = IS_WIN
  ? { program: "winget", args: ["install", "--id", "Docker.DockerDesktop", "-e", "--accept-source-agreements", "--accept-package-agreements"], label: "winget install Docker.DockerDesktop" }
  : { program: "brew", args: ["install", "--cask", "docker"], label: "brew install --cask docker" };

// Launchers that return at once: the app must outlive the command (capture/runBackground kill what they started).
const startEngine = () =>
  IS_MAC
    ? { program: "open", args: ["-a", "Docker"] }
    : IS_WIN
      ? { program: "cmd", args: ["/c", "start", "", "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"] }
      : { program: "systemctl", args: ["--user", "start", "docker-desktop"] };

/** Components shown on the plugin card. */
export const DOCKER_COMPONENTS: (Component & { action: string })[] = [
  {
    id: "cli",
    name: "Docker CLI",
    purpose: "Comando docker (vem com o Docker Desktop, OrbStack ou Colima)",
    action: "Instalar",
    check: () => firstLine(["version", "--format", "{{.Client.Version}}"]),
    install: () => ({ program: DOCKER_INSTALL.program, args: DOCKER_INSTALL.args }),
  },
  {
    id: "engine",
    name: "Docker Engine",
    purpose: "Daemon em execução (necessário para listar e controlar containers)",
    action: "Iniciar",
    check: () => firstLine(["info", "--format", "{{.ServerVersion}}"]),
    install: startEngine,
  },
  {
    id: "compose",
    name: "Docker Compose",
    purpose: "Agrupa os containers por projeto do compose",
    action: "",
    check: () => firstLine(["compose", "version", "--short"]),
    install: () => null,
  },
];

// ---------------- data ----------------

interface Container {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  Ports: string;
  Labels: string;
  RunningFor: string;
  project?: string;
  service?: string;
}
interface Image {
  ID: string;
  Repository: string;
  Tag: string;
  Size: string;
  CreatedSince: string;
}
interface Volume {
  Name: string;
  Driver: string;
  Mountpoint?: string;
}
interface Stat {
  CPUPerc: string;
  MemUsage: string;
}

function jsonLines<T>(text: string): T[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

/** One label from docker's "k=v,k2=v2" string (values may contain commas, so match the key). */
function label(labels: string, key: string): string | undefined {
  const m = new RegExp(`(?:^|,)${key.replace(/\./g, "\\.")}=([^,]*)`).exec(labels ?? "");
  return m?.[1] || undefined;
}

/** "0.0.0.0:5432->5432/tcp, :::5432->5432/tcp" → ["5432→5432"] (unique host ports). */
function shortPorts(p: string): string[] {
  const seen = new Set<string>();
  for (const m of (p ?? "").matchAll(/:(\d+)->(\d+)\/(\w+)/g)) seen.add(m[1] === m[2] ? m[1] : `${m[1]}→${m[2]}`);
  return [...seen];
}

type View = "containers" | "images" | "volumes";

export class DockerTools {
  private view: View = "containers";
  private tabsEl = h("div.tw-tabs");
  private list = h("div.dk-list", { tabIndex: 0 });
  private body = h("div.tw-body.dk", null, this.list);
  private containers: Container[] = [];
  private images: Image[] = [];
  private volumes: Volume[] = [];
  private stats = new Map<string, Stat>();
  private selected: string | null = null;
  private collapsed = new Set<string>();
  private state: "loading" | "ok" | "no-cli" | "no-engine" = "loading";
  private error = "";
  private eventsId: string | null = null;
  private offEvents: (() => void)[] = [];
  private statsTimer: number | null = null;
  private refreshSoon = debounce(() => this.refresh(), 350);

  constructor(private wb: Workbench) {
    wb.register({
      id: "docker",
      title: "Docker",
      icon: "dockerTw",
      anchor: "bottom",
      side: "right",
      body: this.body,
      headerTabs: this.tabsEl,
      actions: () => [
        h("button.icon-btn", { title: "Atualizar", onclick: () => this.refresh() }, icon("general/refresh")),
        h("button.icon-btn", { title: "Limpar recursos não usados (prune)", onclick: () => this.prune() }, icon("general/delete")),
      ],
      onShow: () => {
        this.refresh();
        this.startEvents();
        this.startStats();
      },
    });
    this.list.addEventListener("keydown", (e) => this.onKey(e));
    this.renderTabs();
  }

  dispose() {
    this.stopEvents();
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.wb.unregister("docker");
  }

  // ---------------- loading ----------------

  async refresh() {
    const v = await docker(["version", "--format", "{{.Server.Version}}"], 10).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
    if (v.code !== 0) {
      const cliMissing = /não encontrado|not found|No such file/i.test(v.stderr) && !/daemon|Cannot connect/i.test(v.stderr);
      this.state = cliMissing ? "no-cli" : "no-engine";
      this.error = v.stderr.trim().split(/\r?\n/).pop() ?? "";
      this.stopEvents();
      return this.render();
    }
    const [c, i, vol] = await Promise.all([
      docker(["ps", "-a", "--format", "{{json .}}"]),
      docker(["images", "--format", "{{json .}}"]),
      docker(["volume", "ls", "--format", "{{json .}}"]),
    ]);
    this.containers = jsonLines<Container>(c.stdout).map((x) => ({
      ...x,
      project: label(x.Labels, "com.docker.compose.project"),
      service: label(x.Labels, "com.docker.compose.service"),
    }));
    this.images = jsonLines<Image>(i.stdout);
    this.volumes = jsonLines<Volume>(vol.stdout);
    this.state = "ok";
    this.startEvents();
    this.render();
  }

  /** Live updates: one `docker events` stream while the plugin is active. */
  private async startEvents() {
    if (this.eventsId || this.state !== "ok") return;
    const id = "docker-events-" + uid();
    this.eventsId = id;
    this.offEvents = [
      on<ProcOut>("proc-out", id, () => this.refreshSoon()),
      on<ProcExit>("proc-exit", id, () => {
        this.offEvents.forEach((f) => f());
        this.offEvents = [];
        this.eventsId = null;
      }),
    ];
    await host
      .spawn({ id, program: "docker", args: ["events", "--format", "{{json .}}", "--filter", "type=container", "--filter", "type=image", "--filter", "type=volume"] })
      .catch(() => {
        this.offEvents.forEach((f) => f());
        this.offEvents = [];
        this.eventsId = null;
      });
  }

  private stopEvents() {
    if (this.eventsId) host.kill(this.eventsId).catch(() => {});
  }

  /** CPU/memory of running containers, every 5 s while the tool window is open. */
  private startStats() {
    if (this.statsTimer) return;
    const tick = async () => {
      if (!this.wb.isVisible("docker") || this.state !== "ok" || this.view !== "containers") return;
      if (!this.containers.some((c) => c.State === "running")) return;
      const r = await docker(["stats", "--no-stream", "--format", "{{json .}}"], 20).catch(() => null);
      if (!r || r.code !== 0) return;
      this.stats = new Map(jsonLines<Stat & { ID: string; Name: string }>(r.stdout).map((s) => [s.Name, s]));
      this.render();
    };
    tick();
    this.statsTimer = window.setInterval(tick, 5000);
  }

  // ---------------- rendering ----------------

  private renderTabs() {
    const running = this.containers.filter((c) => c.State === "running").length;
    const tab = (v: View, label: string) =>
      h("div.tw-tab", { class: this.view === v ? "active" : "", onclick: () => ((this.view = v), (this.selected = null), this.render()) }, label);
    this.tabsEl.replaceChildren(
      tab("containers", `Containers ${this.containers.length ? `${running}/${this.containers.length}` : ""}`),
      tab("images", `Imagens ${this.images.length || ""}`),
      tab("volumes", `Volumes ${this.volumes.length || ""}`),
    );
  }

  private render() {
    this.renderTabs();
    if (this.state === "loading") return this.list.replaceChildren(h("div.empty-note", null, "Conectando ao Docker…"));
    if (this.state === "no-cli")
      return this.list.replaceChildren(
        h(
          "div.dk-empty",
          null,
          icon("dockerTw", "ic20"),
          h("b", null, "Docker não encontrado"),
          h("span.dim", null, `Instale o Docker Desktop (${DOCKER_INSTALL.label}), OrbStack ou Colima e clique em Atualizar.`),
          h("div.dk-empty-actions", null, button("Instalar Docker Desktop", () => this.install(), "primary", "actions/install"), button("Atualizar", () => this.refresh())),
        ),
      );
    if (this.state === "no-engine")
      return this.list.replaceChildren(
        h(
          "div.dk-empty",
          null,
          icon("dockerTw", "ic20"),
          h("b", null, "O Docker Engine não está rodando"),
          h("span.dim.mono", null, this.error),
          h("div.dk-empty-actions", null, button("Iniciar Docker", () => this.startEngine(), "primary", "run/run"), button("Atualizar", () => this.refresh())),
        ),
      );
    if (this.view === "containers") this.renderContainers();
    else if (this.view === "images") this.renderImages();
    else this.renderVolumes();
  }

  private renderContainers() {
    if (!this.containers.length) return this.list.replaceChildren(h("div.empty-note", null, "Nenhum container. Rode um com docker run ou docker compose up."));
    const groups = new Map<string, Container[]>();
    for (const c of this.containers) {
      const g = c.project ? c.project : "";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(c);
    }
    const order = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
    const rows: HTMLElement[] = [];
    for (const g of order) {
      const items = groups.get(g)!.sort((a, b) => Number(b.State === "running") - Number(a.State === "running") || a.Names.localeCompare(b.Names));
      const key = g || "__single";
      const isOpen = !this.collapsed.has(key);
      const up = items.filter((c) => c.State === "running").length;
      rows.push(
        h(
          "div.dk-group",
          { onclick: () => (isOpen ? this.collapsed.add(key) : this.collapsed.delete(key), this.render()) },
          icon(isOpen ? "general/chevronDown" : "general/chevronRight"),
          icon(g ? "containerStack" : "docker"),
          h("b", null, g || "Containers avulsos"),
          h("span.dim", null, `${up}/${items.length} rodando`),
          h("span.grow"),
          g
            ? h(
                "span.dk-group-actions",
                { onclick: (e: MouseEvent) => e.stopPropagation() },
                h("button.icon-btn", { title: "Iniciar todos", onclick: () => this.composeAll(items, "start") }, icon("run/run")),
                h("button.icon-btn", { title: "Parar todos", onclick: () => this.composeAll(items, "stop") }, icon("run/stop")),
              )
            : "",
        ),
      );
      if (!isOpen) continue;
      for (const c of items) rows.push(this.containerRow(c));
    }
    this.list.replaceChildren(...rows);
  }

  private containerRow(c: Container): HTMLElement {
    const running = c.State === "running";
    const st = this.stats.get(c.Names);
    const ports = shortPorts(c.Ports);
    const row = h(
      "div.dk-row",
      {
        class: [this.selected === c.ID && "selected", c.State].filter(Boolean).join(" "),
        onclick: () => ((this.selected = c.ID), this.render(), this.list.focus()),
        ondblclick: () => this.logs(c),
        oncontextmenu: (e: MouseEvent) => (e.preventDefault(), (this.selected = c.ID), this.render(), contextMenu(e.clientX, e.clientY, this.containerMenu(c))),
      },
      h("span.dk-dot", { class: c.State, title: c.Status }),
      h("div.dk-main", null, h("span.dk-name", null, c.service && c.project ? c.service : c.Names), h("span.dk-sub", null, c.Image)),
      h("div.dk-ports", null, ...ports.slice(0, 3).map((p) => h("span.dk-port", { title: `localhost:${p.split("→")[0]}` }, p))),
      h("div.dk-stat", null, running && st ? `${st.CPUPerc} · ${st.MemUsage.split(" / ")[0]}` : ""),
      h("div.dk-status", null, c.Status),
      h(
        "div.dk-actions",
        { onclick: (e: MouseEvent) => e.stopPropagation() },
        running
          ? h("button.icon-btn", { title: "Parar", onclick: () => this.act(c, "stop", "Parando") }, icon("run/stop"))
          : h("button.icon-btn", { title: "Iniciar", onclick: () => this.act(c, "start", "Iniciando") }, icon("run/run")),
        h("button.icon-btn", { title: "Reiniciar", onclick: () => this.act(c, "restart", "Reiniciando") }, icon("run/restart")),
        h("button.icon-btn", { title: "Logs", onclick: () => this.logs(c) }, icon("log")),
        h("button.icon-btn", { title: "Terminal no container", disabled: !running, onclick: () => this.exec(c) }, icon("toolwindows/terminal")),
      ),
    );
    return row;
  }

  private containerMenu(c: Container): MenuItem[] {
    const running = c.State === "running";
    return [
      running ? { label: "Parar", icon: "run/stop", action: () => this.act(c, "stop", "Parando") } : { label: "Iniciar", icon: "run/run", action: () => this.act(c, "start", "Iniciando") },
      { label: "Reiniciar", icon: "run/restart", action: () => this.act(c, "restart", "Reiniciando") },
      running && c.State !== "paused" ? { label: "Pausar", action: () => this.act(c, "pause", "Pausando") } : { label: "Retomar", disabled: c.State !== "paused", action: () => this.act(c, "unpause", "Retomando") },
      { separator: true },
      { label: "Logs", icon: "log", action: () => this.logs(c) },
      { label: "Abrir terminal no container", icon: "toolwindows/terminal", disabled: !running, action: () => this.exec(c) },
      { label: "Inspecionar", icon: "general/show", action: () => this.inspect("container", c.ID, c.Names) },
      ...shortPorts(c.Ports).map((p) => ({ label: `Copiar localhost:${p.split("→")[0]}`, icon: "general/copy", action: () => (navigator.clipboard.writeText(`localhost:${p.split("→")[0]}`), toast("Copiado")) })),
      { label: "Copiar ID", icon: "general/copy", action: () => (navigator.clipboard.writeText(c.ID), toast("Copiado")) },
      { separator: true },
      { label: "Remover…", icon: "general/delete", danger: true, action: () => this.remove(c) },
    ];
  }

  private renderImages() {
    if (!this.images.length) return this.list.replaceChildren(h("div.empty-note", null, "Nenhuma imagem local."));
    const used = new Set(this.containers.map((c) => c.Image));
    this.list.replaceChildren(
      ...this.images.map((im) => {
        const name = im.Repository === "<none>" ? im.ID.slice(0, 12) : `${im.Repository}:${im.Tag}`;
        return h(
          "div.dk-row",
          {
            class: this.selected === im.ID ? "selected" : "",
            onclick: () => ((this.selected = im.ID), this.render()),
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault();
              contextMenu(e.clientX, e.clientY, [
                { label: "Executar container…", icon: "run/run", action: () => this.runImage(name) },
                { label: "Atualizar (pull)", icon: "vcs/update", disabled: im.Repository === "<none>", action: () => this.pull(name) },
                { label: "Inspecionar", icon: "general/show", action: () => this.inspect("image", im.ID, name) },
                { separator: true },
                { label: "Remover…", icon: "general/delete", danger: true, action: () => this.removeImage(im, name) },
              ]);
            },
          },
          icon("pkg"),
          h("div.dk-main", null, h("span.dk-name", null, name), h("span.dk-sub", null, im.ID.replace("sha256:", "").slice(0, 12))),
          h("div.dk-ports", null, used.has(name) || used.has(im.Repository) ? h("span.dk-port", null, "em uso") : ""),
          h("div.dk-stat", null, im.Size),
          h("div.dk-status", null, im.CreatedSince),
          h(
            "div.dk-actions",
            { onclick: (e: MouseEvent) => e.stopPropagation() },
            h("button.icon-btn", { title: "Executar container", onclick: () => this.runImage(name) }, icon("run/run")),
            h("button.icon-btn", { title: "Remover", onclick: () => this.removeImage(im, name) }, icon("general/delete")),
          ),
        );
      }),
    );
  }

  private renderVolumes() {
    if (!this.volumes.length) return this.list.replaceChildren(h("div.empty-note", null, "Nenhum volume."));
    this.list.replaceChildren(
      ...this.volumes.map((v) =>
        h(
          "div.dk-row",
          { class: this.selected === v.Name ? "selected" : "", onclick: () => ((this.selected = v.Name), this.render()) },
          icon("nodes/folder"),
          h("div.dk-main", null, h("span.dk-name", null, v.Name), h("span.dk-sub", null, v.Driver)),
          h("div.dk-ports"),
          h("div.dk-stat"),
          h("div.dk-status"),
          h(
            "div.dk-actions",
            null,
            h("button.icon-btn", { title: "Inspecionar", onclick: () => this.inspect("volume", v.Name, v.Name) }, icon("general/show")),
            h("button.icon-btn", { title: "Remover", onclick: () => this.removeVolume(v) }, icon("general/delete")),
          ),
        ),
      ),
    );
  }

  private onKey(e: KeyboardEvent) {
    if (this.view !== "containers") return;
    const flat = this.containers.filter((c) => !this.collapsed.has(c.project || "__single"));
    const i = flat.findIndex((c) => c.ID === this.selected);
    const c = flat[i];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (n) (this.selected = n.ID), this.render();
    } else if (c && e.key === "Enter") this.logs(c);
    else if (c && (e.key === "Delete" || e.key === "Backspace")) this.remove(c);
  }

  // ---------------- actions ----------------

  private async run(title: string, args: string[]) {
    const t = await runBackground(title, "docker", args);
    if (t.code !== 0) notify(`Docker: falha em "${title}"`, t.output.trim().split(/\r?\n/).slice(-4).join("\n"), "error", [], 10000);
    this.refresh();
    return t.code === 0;
  }

  private act(c: Container, cmd: string, verb: string) {
    return this.run(`${verb} ${c.Names}`, [cmd, c.ID]);
  }

  private async composeAll(items: Container[], cmd: "start" | "stop") {
    const ids = items.filter((c) => (cmd === "stop" ? c.State === "running" : c.State !== "running")).map((c) => c.ID);
    if (ids.length) await this.run(`${cmd === "stop" ? "Parando" : "Iniciando"} ${items[0].project}`, [cmd, ...ids]);
  }

  private async remove(c: Container) {
    const running = c.State === "running";
    if (!(await confirmDialog("Remover container", `Remover "${c.Names}"?${running ? " Ele está rodando e será parado." : ""}`, "Remover", true))) return;
    this.run(`Removendo ${c.Names}`, ["rm", ...(running ? ["-f"] : []), c.ID]);
  }

  private async removeImage(im: Image, name: string) {
    if (!(await confirmDialog("Remover imagem", `Remover a imagem "${name}"?`, "Remover", true))) return;
    this.run(`Removendo ${name}`, ["rmi", im.ID]);
  }

  private async removeVolume(v: Volume) {
    if (!(await confirmDialog("Remover volume", `Remover o volume "${v.Name}"? Os dados dele serão apagados.`, "Remover", true))) return;
    this.run(`Removendo volume ${v.Name}`, ["volume", "rm", v.Name]);
  }

  private pull(name: string) {
    return this.run(`Baixando ${name}`, ["pull", name]);
  }

  private async runImage(name: string) {
    const { promptDialog } = await import("../ui");
    const extra = await promptDialog(`Executar ${name}`, "Argumentos do docker run (ex.: -p 8080:80 -e CHAVE=valor)", "-d");
    if (extra === null) return;
    const args = extra.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((a) => a.replace(/^"|"$/g, "")) ?? [];
    this.run(`Executando ${name}`, ["run", ...args, name]);
  }

  private async prune() {
    if (!(await confirmDialog("Limpar recursos não usados", "Remove containers parados, redes e imagens sem tag (docker system prune -f). Volumes não são removidos.", "Limpar", true))) return;
    const ok = await this.run("Limpando Docker", ["system", "prune", "-f"]);
    if (ok) toast("Recursos não usados removidos", "ok");
  }

  private logs(c: Container) {
    this.wb.show("terminal");
    this.wb.terminals.newTab(this.wb.root, `docker logs -f --tail 300 ${c.Names}`);
  }

  private exec(c: Container) {
    this.wb.show("terminal");
    const shell = IS_WIN ? `docker exec -it ${c.Names} sh` : `docker exec -it ${c.Names} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`;
    this.wb.terminals.newTab(this.wb.root, shell);
  }

  private async inspect(kind: "container" | "image" | "volume", id: string, name: string) {
    const r = await docker([kind, "inspect", id]);
    if (r.code !== 0) return toast(r.stderr.trim(), "error");
    let text = r.stdout;
    try {
      text = JSON.stringify(JSON.parse(r.stdout), null, 2);
    } catch {
      /* keep raw */
    }
    textViewer(`Inspecionar ${name}`, text);
  }

  private async install() {
    const t = await runBackground("Instalando Docker Desktop", DOCKER_INSTALL.program, DOCKER_INSTALL.args);
    t.code === 0 ? notify("Docker instalado", "Abra o Docker Desktop uma vez para iniciar o Engine.", "ok") : notify("Falha ao instalar o Docker", t.output.slice(-500), "error");
    this.refresh();
  }

  private async startEngine() {
    const s = startEngine();
    await host.capture(s.program, s.args, "", undefined, 20).catch(() => null);
    toast("Iniciando o Docker… a lista atualiza quando o Engine responder.");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const v = await docker(["info", "--format", "{{.ServerVersion}}"], 5).catch(() => null);
      if (v?.code === 0) return this.refresh();
    }
    this.refresh();
  }
}
