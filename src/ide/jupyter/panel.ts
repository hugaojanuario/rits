// Jupyter tool window: servers (local, remote, or a local JupyterLab created on Docker), connection
// test, server files, running kernels, and notebooks opened in the IDE's own editor. The official
// JupyterLab opens as a complement, in a separate window (outside the IDE capabilities) or in the
// system browser. Disabling the plugin closes the IDE's connections; servers and kernels keep running.
import { invoke } from "@tauri-apps/api/core";
import { h, uid } from "../../util";
import { icon } from "../../icons";
import { button, confirmDialog, contextMenu, modal, notify, promptDialog, toast, type MenuItem } from "../../ui";
import type { Tab } from "../../tabs";
import { host, on, P, type ProcExit, type ProcOut } from "../host";
import { contribute, type PluginHandle } from "../plugins";
import { dockerEnabled, setDockerEnabled } from "../docker";
import type { Workbench } from "../workbench";
import { errorText, JupyterApi, newNotebook, serializeNotebook, servers, type ContentModel, type JpServer, type KernelModel } from "./api";
import { notebookTabId, NotebookTab, type Storage } from "./notebook";

const IMAGE = "quay.io/jupyter/scipy-notebook:2026-10-12";
const ENV_DOC = "jupyter-envs";

interface LocalEnv {
  slug: string;
  name: string;
  port: number;
  project: string;
  created: number;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "lab";

function webMode(): "window" | "browser" {
  try {
    return localStorage.getItem("jupyter.web") === "browser" ? "browser" : "window";
  } catch {
    return "window";
  }
}

export class JupyterTools implements PluginHandle {
  private body = h("div.tw-body.af.jp");
  private head = h("div.af-head");
  private content = h("div.af-list");
  private all: JpServer[] = [];
  private srv: JpServer | null = null;
  private conn: { state: "idle" | "ok" | "error"; text?: string } = { state: "idle" };
  private envs: LocalEnv[] = [];
  private envState = new Map<string, string>();
  private kernels: KernelModel[] = [];
  private browse = "";
  private files: ContentModel[] | null = null;
  private notebooks = new Map<string, NotebookTab>();
  private offContrib: () => void;
  private disposed = false;

  constructor(readonly wb: Workbench) {
    wb.register({
      id: "jupyter",
      title: "Jupyter",
      icon: "jupyterTw",
      anchor: "right",
      body: this.body,
      actions: () => [
        h("button.icon-btn", { title: "Atualizar", onclick: () => this.refresh() }, icon("general/refresh")),
        h("button.icon-btn", { title: "Abrir no JupyterLab", disabled: !this.srv, onclick: () => this.srv && this.openLab(null) }, icon("general/openNewTab")),
        h("button.icon-btn", { title: "Adicionar servidor", onclick: () => this.serverDialog(null) }, icon("general/add")),
      ],
      onShow: () => this.refresh(),
    });
    this.body.append(this.head, this.content);
    this.offContrib = contribute({
      id: "jupyter",
      open: (path, o) => {
        if (P.ext(path) !== "ipynb") return false;
        this.openNotebook({ kind: "local", path }, o.background);
        return true;
      },
    });
    this.load();
  }

  newItems(dir: string): MenuItem[] {
    return [{ label: "Notebook Jupyter", icon: "fileTypes/jupyter", action: () => this.newLocalNotebook(dir) }];
  }

  async dispose() {
    this.disposed = true;
    this.offContrib();
    // notebook tabs ask to save; their kernel connections close (servers keep running)
    for (const t of [...this.wb.tabs.tabs]) if (t.id.startsWith("notebook:") || t.id.startsWith("jupyter-")) await this.wb.tabs.close(t);
    for (const nb of this.notebooks.values()) await nb.detach();
    this.wb.unregister("jupyter");
    await servers.release().catch(() => {});
  }

  // ---------------- data ----------------

  private async load() {
    this.envs = (await host.loadDoc<LocalEnv[]>(ENV_DOC).catch(() => null)) ?? [];
    await this.loadServers();
    for (const e of this.envs) this.envState.set(e.slug, "…");
    this.refreshEnvs();
  }

  private async loadServers(select?: string) {
    this.all = await servers.list().catch(() => []);
    let want = select;
    try {
      want ??= localStorage.getItem("jupyter.server") ?? undefined;
    } catch {
      /* ignore */
    }
    this.select(this.all.find((s) => s.id === want) ?? this.all[0] ?? null);
  }

  private select(s: JpServer | null) {
    this.srv = s;
    this.conn = { state: "idle" };
    this.kernels = [];
    this.files = null;
    this.browse = s?.remoteRoot ?? "";
    try {
      if (s) localStorage.setItem("jupyter.server", s.id);
    } catch {
      /* ignore */
    }
    this.render();
    if (s) this.refresh();
  }

  async refresh() {
    if (this.disposed) return;
    const s = this.srv;
    if (!s) return this.render();
    const api = new JupyterApi(s);
    try {
      const [st, kernels] = await Promise.all([api.status(), api.kernels()]);
      this.kernels = kernels;
      this.conn = { state: "ok", text: `${kernels.length} kernel(s) · ${st.connections ?? 0} conexões` };
      this.files = (await api.list(this.browse).catch(() => null))?.content ?? null;
    } catch (e) {
      this.conn = { state: "error", text: errorText(e) };
    }
    this.render();
  }

  // ---------------- render ----------------

  render() {
    if (this.disposed) return;
    const s = this.srv;
    const inst = h(
      "button.af-inst",
      { title: "Servidor Jupyter", onclick: (e: MouseEvent) => this.serverMenu(e) },
      icon("jupyter"),
      h("span", null, s?.name ?? "Nenhum servidor"),
      icon("general/chevronDown"),
    );
    const st = h(`div.af-status${this.conn.state === "ok" ? ".ok" : this.conn.state === "error" ? ".err" : ""}` as "div", { title: this.conn.text ?? "" }, h("i"), h("span", null, this.conn.state === "ok" ? "conectado" : this.conn.state === "error" ? "erro" : s ? "…" : ""));
    this.head.replaceChildren(inst, st);
    const parts: HTMLElement[] = [];
    if (!s) {
      parts.push(
        h(
          "div.af-empty",
          null,
          icon("jupyter"),
          h("b", null, "Conecte um Jupyter Server"),
          h("div.dim", null, "Use um servidor existente (local ou remoto, com token) ou crie um JupyterLab local no Docker com a pasta do projeto montada."),
          h("div.af-empty-actions", null, button("Conectar servidor", () => this.serverDialog(null), "primary", "general/add"), button("Criar JupyterLab local (Docker)", () => this.createEnvDialog(), "", "docker")),
        ),
      );
    } else {
      if (this.conn.state === "error") parts.push(h("div.af-warn", { style: "margin:4px 10px" }, icon("status/error"), h("div.af-err", null, this.conn.text ?? "")));
      parts.push(this.section("Servidor", h("div.jp-kv", null, h("div", null, h("span.dim", null, "URL "), h("code", null, s.url)), h("div", null, h("span.dim", null, "Autenticação "), s.auth === "token" ? (s.hasSecret ? "token no cofre do sistema" : "token não informado") : "nenhuma"), h("div", null, h("span.dim", null, "Pasta do projeto no servidor "), s.localRoot ? h("code", null, s.remoteRoot || "/") : h("span.dim", null, "não mapeada (o kernel roda na raiz do servidor)")), h("div.dim", null, "O kernel usa o ambiente Python do servidor, que pode ser diferente do interpretador da IDE."))));
      parts.push(this.kernelSection(), this.filesSection());
    }
    parts.push(this.envSection());
    this.content.replaceChildren(...parts);
  }

  private section(title: string, ...children: (HTMLElement | string)[]) {
    return h("div.jp-sec", null, h("div.afd-sec", null, title), ...children);
  }

  private kernelSection() {
    const s = this.srv!;
    const api = new JupyterApi(s);
    const rows = this.kernels.map((k) =>
      h(
        "div.af-row",
        null,
        h(`span.af-dot.${k.execution_state === "busy" ? "running" : k.execution_state === "idle" ? "success" : ""}` as "span"),
        h("div.af-main", null, h("div.af-name", null, k.name), h("div.af-sub", null, `${k.execution_state ?? "?"} · ${k.connections ?? 0} conexões · ${k.id.slice(0, 8)}`)),
        h("button.icon-btn", { title: "Interromper", onclick: () => api.interrupt(k.id).then(() => this.refresh()).catch((e) => toast(errorText(e), "error")) }, icon("run/stop")),
        h("button.icon-btn", {
          title: "Reiniciar (perde as variáveis)",
          onclick: async () => {
            if (await confirmDialog("Reiniciar o kernel", "As variáveis deste kernel serão perdidas.", "Reiniciar", true)) api.restart(k.id).then(() => this.refresh()).catch((e) => toast(errorText(e), "error"));
          },
        }, icon("run/restart")),
        h("button.icon-btn", {
          title: "Encerrar o kernel",
          onclick: async () => {
            if (await confirmDialog("Encerrar o kernel", "O kernel será encerrado no servidor e as variáveis serão perdidas. Notebooks abertos nele ficam desconectados.", "Encerrar", true)) api.shutdown(k.id).then(() => this.refresh()).catch((e) => toast(errorText(e), "error"));
          },
        }, icon("general/delete")),
      ),
    );
    return this.section("Kernels em execução", ...(rows.length ? rows : [h("div.dim.jp-pad", null, "Nenhum kernel em execução.")]));
  }

  private filesSection() {
    const s = this.srv!;
    const crumbs = h("div.jp-crumbs", null, h("button.link", { onclick: () => this.go("") }, "raiz"), ...this.browse.split("/").filter(Boolean).flatMap((seg, i, arr) => [" / ", h("button.link", { onclick: () => this.go(arr.slice(0, i + 1).join("/")) }, seg)]));
    const rows = (this.files ?? [])
      .slice()
      .sort((a, b) => (a.type === "directory" ? 0 : 1) - (b.type === "directory" ? 0 : 1) || a.name.localeCompare(b.name))
      .map((f) =>
        h(
          "div.af-row.jp-file",
          { ondblclick: () => (f.type === "directory" ? this.go(f.path) : f.type === "notebook" ? this.openNotebook({ kind: "remote", serverId: s.id, path: f.path }) : this.openLab(f.path)) },
          icon(f.type === "directory" ? "nodes/folder" : f.type === "notebook" ? "fileTypes/jupyter" : "fileTypes/text"),
          h("div.af-main", null, h("div.af-name", null, f.name), h("div.af-sub", null, f.type === "notebook" ? "notebook — duplo clique abre no editor da IDE" : f.type === "directory" ? "pasta" : "arquivo — abre no JupyterLab")),
        ),
      );
    const actions = h("div.jp-actions", null, h("button.btn", { onclick: () => this.newRemoteNotebook() }, icon("general/add"), "Novo notebook aqui"));
    return this.section("Arquivos do servidor", crumbs, ...(this.files === null ? [h("div.dim.jp-pad", null, "Sem acesso aos arquivos.")] : rows.length ? rows : [h("div.dim.jp-pad", null, "Pasta vazia.")]), actions);
  }

  private go(path: string) {
    this.browse = path;
    this.refresh();
  }

  private envSection() {
    const rows = this.envs.map((e) => {
      const st = this.envState.get(e.slug) ?? "…";
      return h(
        "div.af-row",
        null,
        icon("docker"),
        h("div.af-main", null, h("div.af-name", null, e.name), h("div.af-sub", null, `127.0.0.1:${e.port} · ${st} · ${P.base(e.project)}`)),
        h("button.icon-btn", { title: "Ações", onclick: (ev: MouseEvent) => contextMenu(ev.clientX, ev.clientY + 6, this.envMenu(e)) }, icon("general/moreHorizontal")),
      );
    });
    return this.section("Ambientes locais (Docker)", ...rows, h("div.jp-actions", null, h("button.btn", { onclick: () => this.createEnvDialog() }, icon("docker"), "Criar JupyterLab local")));
  }

  private serverMenu(e: MouseEvent) {
    const items: MenuItem[] = [
      ...this.all.map((s) => ({ label: s.name + (s.id === this.srv?.id ? "  ✓" : ""), icon: s.localEnv ? "docker" : "jupyter", action: () => this.select(s) })),
      { separator: true },
      { label: "Adicionar servidor…", icon: "general/add", action: () => this.serverDialog(null) },
      ...(this.srv
        ? [
            { label: "Editar servidor…", icon: "general/edit", action: () => this.serverDialog(this.srv) },
            { label: "Testar conexão", icon: "general/refresh", action: () => this.test(this.srv!, null) },
            { label: "Remover da IDE (não para o servidor)", icon: "general/delete", action: () => this.removeServer(this.srv!) },
          ]
        : []),
      { separator: true },
      { label: `JupyterLab: ${webMode() === "window" ? "janela da IDE ✓" : "janela da IDE"}`, action: () => this.setWeb("window") },
      { label: `JupyterLab: ${webMode() === "browser" ? "navegador ✓" : "navegador do sistema"}`, action: () => this.setWeb("browser") },
    ];
    contextMenu(e.clientX, e.clientY + 6, items);
  }

  private setWeb(m: "window" | "browser") {
    try {
      localStorage.setItem("jupyter.web", m);
    } catch {
      /* ignore */
    }
  }

  private openLab(path: string | null) {
    if (!this.srv) return;
    servers.openLab(this.srv.id, path, webMode() === "browser").catch((e) => notify("Não foi possível abrir o JupyterLab", errorText(e), "error"));
  }

  // ---------------- servers ----------------

  private async test(s: JpServer, secret: string | null) {
    try {
      const r = await servers.test(s, secret);
      toast(`Jupyter Server ${r.version} · kernels: ${r.kernelspecs.join(", ")}`, "ok", 5000);
      return true;
    } catch (e) {
      notify("Falha na conexão", errorText(e), "error");
      return false;
    }
  }

  private async removeServer(s: JpServer) {
    if (!(await confirmDialog("Remover servidor", `Remover "${s.name}" da IDE e apagar o token do cofre do sistema? O servidor e os kernels continuam rodando.`, "Remover"))) return;
    await servers.remove(s.id).catch((e) => toast(errorText(e), "error"));
    this.loadServers();
  }

  serverDialog(edit: JpServer | null) {
    const m = modal(edit ? "Editar servidor Jupyter" : "Conectar servidor Jupyter", { width: 600 });
    const name = h("input.input", { value: edit?.name ?? "" }) as HTMLInputElement;
    const url = h("input.input", { value: edit?.url ?? "http://127.0.0.1:8888", placeholder: "https://jupyter.exemplo.com/user/ana", spellcheck: false }) as HTMLInputElement;
    const auth = h("select.input", null, h("option", { value: "token" }, "Token"), h("option", { value: "none" }, "Sem autenticação (servidor iniciado sem token)")) as HTMLSelectElement;
    auth.value = edit?.auth ?? "token";
    const token = h("input.input", { type: "password", placeholder: edit?.hasSecret ? "(mantém o token salvo)" : "token do servidor", autocomplete: "off" }) as HTMLInputElement;
    const tls = h("input", { type: "checkbox", checked: edit?.verifyTls ?? true }) as HTMLInputElement;
    const timeout = h("input.input", { type: "number", value: String(edit?.timeoutSecs ?? 30), min: 3, max: 600, style: "width:90px" }) as HTMLInputElement;
    const mapOn = h("input", { type: "checkbox", checked: !!edit?.localRoot }) as HTMLInputElement;
    const remoteRoot = h("input.input", { value: edit?.remoteRoot ?? "", placeholder: "pasta do projeto vista pelo servidor (ex.: work ou vazio)", spellcheck: false }) as HTMLInputElement;
    m.body.append(
      h(
        "div.form-grid",
        null,
        h("label.field.span2", null, h("span", null, "Nome"), name),
        h("label.field.span2", null, h("span", null, "URL (sem ?token=)"), url),
        h("label.field", null, h("span", null, "Autenticação"), auth),
        h("label.field", null, h("span", null, "Token"), token),
        h("label.field", null, h("span", null, "Tempo limite (s)"), timeout),
        h("label.check", null, tls, "Validar o certificado TLS"),
        h("label.check.span2", null, mapOn, `Este servidor enxerga a pasta do projeto (${P.base(this.wb.root)})`),
        h("label.field.span2", null, h("span", null, "Caminho do projeto no servidor"), remoteRoot),
      ),
      h("div.hint", { style: "margin-top:8px" }, "O token fica no cofre do sistema (Keychain / Credential Manager) e nunca é gravado em arquivos nem exibido. Desconectar ou desativar o plugin não para o servidor."),
    );
    const build = (): JpServer => ({
      id: edit?.id ?? "",
      name: name.value.trim(),
      url: url.value.trim(),
      auth: auth.value as "token" | "none",
      timeoutSecs: Number(timeout.value) || 30,
      verifyTls: tls.checked,
      localEnv: edit?.localEnv ?? "",
      localRoot: mapOn.checked ? this.wb.root : "",
      remoteRoot: mapOn.checked ? remoteRoot.value.trim().replace(/^\/+|\/+$/g, "") : "",
    });
    m.footer.append(
      button("Testar", () => this.test(build(), token.value || null)),
      button("Cancelar", () => m.close()),
      button("Salvar", async () => {
        if (!tls.checked && !(await confirmDialog("TLS desativado", "Sem validar o certificado, o token pode ser interceptado. Continuar?", "Continuar", true))) return;
        try {
          const saved = await servers.save(build(), token.value || null);
          m.close();
          this.loadServers(saved.id);
        } catch (e) {
          toast(errorText(e), "error");
        }
      }, "primary"),
    );
  }

  // ---------------- notebooks ----------------

  async openNotebook(storage: Storage, background = false) {
    const id = notebookTabId(storage);
    const open = this.wb.tabs.find(id);
    if (open) return background ? undefined : this.wb.tabs.activate(open);
    const nb = new NotebookTab(this.wb, storage, () => this.notebooks.delete(id));
    try {
      await nb.load();
    } catch (e) {
      notify("Não foi possível abrir o notebook", errorText(e) + (storage.kind === "local" ? "\nVocê pode abri-lo como texto." : ""), "error", storage.kind === "local" ? [{ label: "Abrir como texto", run: () => this.wb.editors.openFile(storage.path, { text: true }) }] : []);
      return;
    }
    this.notebooks.set(id, nb);
    this.wb.tabs.open(nb.tab, background);
  }

  private async newLocalNotebook(dir: string) {
    const n = await promptDialog("Novo notebook", "Nome do arquivo", "analise.ipynb");
    if (!n) return;
    const path = P.join(dir, n.endsWith(".ipynb") ? n : n + ".ipynb");
    if (await host.exists(path)) return toast("Já existe um arquivo com esse nome.", "error");
    await host.write(path, serializeNotebook(newNotebook()));
    this.openNotebook({ kind: "local", path });
  }

  private async newRemoteNotebook() {
    if (!this.srv) return;
    try {
      const m = await new JupyterApi(this.srv).newUntitled(this.browse);
      await this.refresh();
      this.openNotebook({ kind: "remote", serverId: this.srv.id, path: m.path });
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  // ---------------- local environments (Docker) ----------------

  private async refreshEnvs() {
    for (const e of this.envs) {
      const r = await host.capture("docker", ["ps", "-a", "--filter", `label=dev.rits.env=${e.slug}`, "--filter", "label=dev.rits.plugin=jupyter", "--format", "{{.State}}"], "", undefined, 15).catch(() => null);
      this.envState.set(e.slug, !r || r.code !== 0 ? "docker indisponível" : !r.stdout.trim() ? "não criado" : r.stdout.includes("running") ? "rodando" : "parado");
    }
    this.render();
  }

  private envMenu(e: LocalEnv): MenuItem[] {
    return [
      { label: "Iniciar", icon: "run/run", action: () => this.startEnv(e) },
      { label: "Parar (mantém os arquivos)", icon: "run/stop", action: () => this.compose(e, ["stop"], "Parando o JupyterLab local") },
      { label: "Logs", icon: "log", action: () => this.envLogs(e) },
      ...(dockerEnabled() ? [{ label: "Abrir janela Docker", icon: "docker", action: () => this.wb.show("docker", true) }] : []),
      { separator: true },
      { label: "Excluir ambiente e volume…", icon: "general/delete", danger: true, action: () => this.destroyEnv(e) },
    ];
  }

  private async createEnvDialog() {
    const r = await host.capture("docker", ["info", "--format", "{{.ServerVersion}}"], "", undefined, 15).catch(() => null);
    if (!r || r.code !== 0) return notify("Docker indisponível", "O ambiente local usa o Docker. Instale ou inicie o Docker e tente de novo.", "error");
    const m = modal("Criar JupyterLab local", { width: 620 });
    const name = h("input.input", { value: `${P.base(this.wb.root)} (lab)` }) as HTMLInputElement;
    const port = h("input.input", { type: "number", value: "8888", min: 1024, max: 65535, style: "width:110px" }) as HTMLInputElement;
    m.body.append(
      h("div.af-warn", null, icon("status/info"), "Ambiente de desenvolvimento local. Para dados sensíveis, prefira um servidor gerenciado pela sua equipe."),
      h("div.form-grid", { style: "margin-top:12px" }, h("label.field.span2", null, h("span", null, "Nome"), name), h("label.field", null, h("span", null, "Porta em 127.0.0.1"), port)),
      h(
        "div.af-plan",
        { style: "margin-top:12px" },
        h("div", null, "Imagem fixada: ", h("code", null, IMAGE), h("span.dim", null, " (JupyterLab 4.6.4, Python 3.13, pandas, matplotlib, scikit-learn; ~5 GB)")),
        h("div", null, "Pasta do projeto montada em ", h("code", null, "/home/jovyan/work"), h("span.dim", null, " (os notebooks ficam no seu disco)")),
        h("div", null, "Volume persistente ", h("code", null, "home"), " para configurações e pacotes instalados com pip --user"),
        h("div", null, "Porta publicada somente em ", h("code", null, "127.0.0.1"), "; token aleatório no cofre do sistema (autenticação obrigatória)"),
        h("div.dim", null, "Containers e volumes recebem o rótulo dev.rits.plugin=jupyter."),
      ),
    );
    const go = button("Criar e iniciar", async () => {
      go.disabled = true;
      const env: LocalEnv = { slug: slugify(name.value), name: name.value.trim() || "JupyterLab", port: Math.max(1024, Math.min(65535, Number(port.value) || 8888)), project: this.wb.root, created: Date.now() };
      if (this.envs.some((x) => x.slug === env.slug)) env.slug = `${env.slug}-${uid().slice(-4)}`;
      m.close();
      if (!dockerEnabled()) {
        setDockerEnabled(true);
        toast("Plugin Docker ativado: o container do JupyterLab aparece na janela Docker.", "info", 6000);
      }
      this.envs.push(env);
      await host.saveDoc(ENV_DOC, this.envs);
      this.render();
      this.startEnv(env);
    }, "primary", "docker") as HTMLButtonElement;
    m.footer.append(button("Cancelar", () => m.close()), go);
  }

  private async startEnv(e: LocalEnv) {
    try {
      await invoke("jupyter_env_create", { slug: e.slug });
    } catch (err) {
      return notify("Falha ao preparar o ambiente", errorText(err), "error");
    }
    if (!(await this.compose(e, ["up", "-d", "--quiet-pull"], `Iniciando o JupyterLab local (${e.name})`))) return;
    const key = "jupyter-env-" + e.slug;
    this.wb.setProgress(key, "JupyterLab local: aguardando o servidor");
    try {
      const t0 = Date.now();
      for (;;) {
        if (await invoke("jupyter_env_health", { port: e.port }).then(() => true).catch(() => false)) break;
        if (Date.now() - t0 > 4 * 60_000) {
          notify("O JupyterLab local não respondeu", "Veja os logs do ambiente.", "error", [{ label: "Ver logs", run: () => this.envLogs(e) }]);
          return;
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
      const srv = await invoke<JpServer>("jupyter_env_register", { slug: e.slug, name: e.name, port: e.port, projectDir: e.project });
      await this.loadServers(srv.id);
      notify("JupyterLab local pronto", `http://127.0.0.1:${e.port} (token no cofre do sistema). Os notebooks do projeto rodam com o kernel deste container.`, "ok", [], 9000);
    } finally {
      this.wb.setProgress(key, null);
      this.refreshEnvs();
    }
  }

  private compose(e: LocalEnv, args: string[], title: string): Promise<boolean> {
    const procId = "jpenv-" + uid();
    const key = "jupyter-compose-" + procId;
    let out = "";
    this.wb.setProgress(key, title);
    return new Promise((resolve) => {
      const offOut = on<ProcOut>("proc-out", procId, (x) => (out = (out + x.data).slice(-6000)));
      const offExit = on<ProcExit>("proc-exit", procId, (x) => {
        offOut();
        offExit();
        this.wb.setProgress(key, null);
        this.refreshEnvs();
        if (x.code === 0) return resolve(true);
        notify(`Falha: ${title}`, out.trim().split("\n").slice(-6).join("\n") || `docker compose terminou com código ${x.code}`, "error", [], 15000);
        resolve(false);
      });
      invoke<number>("jupyter_env_compose", { procId, slug: e.slug, args, projectDir: P.win(e.project), port: e.port }).catch((err) => {
        offOut();
        offExit();
        this.wb.setProgress(key, null);
        notify(`Falha: ${title}`, errorText(err), "error");
        resolve(false);
      });
    });
  }

  private envLogs(e: LocalEnv) {
    const id = `jupyter-envlogs:${e.slug}`;
    const open = this.wb.tabs.find(id);
    if (open) return this.wb.tabs.activate(open);
    const procId = "jpenvlog-" + uid();
    const pre = h("pre.afd-log");
    const el = h("div.afd", null, h("div.afd-head", null, h("div.afd-title", null, icon("docker"), h("b", null, `Logs — ${e.name}`))), pre);
    const offOut = on<ProcOut>("proc-out", procId, (x) => {
      // the server prints its URL with the token: hide it
      pre.append(x.data.replace(/\x1b\[[0-9;]*m/g, "").replace(/token=[A-Za-z0-9_\-]+/g, "token=•••"));
      pre.scrollTop = pre.scrollHeight;
    });
    const offExit = on<ProcExit>("proc-exit", procId, () => pre.append("\n[fim dos logs]\n"));
    const tab: Tab = { id, title: `Logs · ${e.name}`, icon: "log", el, onClose: () => (offOut(), offExit(), host.kill(procId).catch(() => {})) };
    this.wb.tabs.open(tab);
    invoke("jupyter_env_compose", { procId, slug: e.slug, args: ["logs", "-f", "--tail", "300", "--no-color"], projectDir: P.win(e.project), port: e.port }).catch((err) => pre.append(errorText(err)));
  }

  private async destroyEnv(e: LocalEnv) {
    const typed = await promptDialog("Excluir ambiente", `Remove o container e o volume "home" (configurações e pacotes instalados no container) de "${e.name}". Os notebooks da pasta do projeto NÃO são apagados. Digite ${e.slug} para confirmar:`);
    if (typed !== e.slug) {
      if (typed !== null) toast("Nome não confere: nada foi excluído.", "error");
      return;
    }
    if (!(await this.compose(e, ["down", "-v", "--remove-orphans", "--rits-confirmed-delete"], "Excluindo o JupyterLab local"))) return;
    await invoke("jupyter_env_forget", { slug: e.slug }).catch(() => {});
    const srv = this.all.find((s) => s.localEnv === e.slug);
    if (srv) await servers.remove(srv.id).catch(() => {});
    this.envs = this.envs.filter((x) => x.slug !== e.slug);
    await host.saveDoc(ENV_DOC, this.envs);
    toast("Ambiente excluído.", "ok");
    this.loadServers();
  }
}
