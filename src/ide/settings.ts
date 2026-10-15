// Settings dialog: appearance, editor, Python interpreter, Go SDK, plugins, keymap, about.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { h } from "../util";
import { icon } from "../icons";
import { button, modal, notify, toast } from "../ui";
import { host, INSTALL, IS_MAC, IS_WIN, P } from "./host";
import { keymapId, keymapTable, setKeymap, type KeymapId } from "./keymap";
import { completionSettings, setCompletionSettings, type CompletionSettings } from "./completion";
import { DOCKER_COMPONENTS, DOCKER_INSTALL, dockerEnabled, setDockerEnabled } from "./docker";
import { PLUGINS, clearSdkCache, findGo, findInterpreters, runBackground, setCurrentPython, getCurrentPython, type LangPlugin } from "./sdk";
import type { Workbench } from "./workbench";

type Page = "appearance" | "editor" | "python" | "go" | "plugins" | "keymap" | "about";

const PAGES: [Page, string, string][] = [
  ["appearance", "Aparência", "general/layout"],
  ["editor", "Editor", "general/edit"],
  ["python", "Interpretador Python", "python/pythonClosed"],
  ["go", "Go", "goSdk"],
  ["plugins", "Plugins", "plugins"],
  ["keymap", "Keymap", "general/keyboard"],
  ["about", "Sobre", "status/info"],
];

export function openSettings(wb: Workbench, page: Page | string = "appearance", focusPlugin?: string) {
  const m = modal("Configurações", { width: 980 });
  m.root.style.height = "78vh";
  const nav = h("div.modal-nav");
  const main = h("div.modal-main");
  m.body.style.cssText = "padding:0;display:flex;min-height:0;overflow:hidden";
  m.body.append(nav, main);
  m.footer.append(button("Fechar", () => m.close(), "primary"));
  let current = page as Page;
  const go = (p: Page) => {
    current = p;
    nav.replaceChildren(...PAGES.map(([id, label, ic]) => h("div.nav-item", { class: id === current ? "active" : "", onclick: () => go(id) }, icon(ic), label)));
    const pageEl = h("div.settings-page");
    main.replaceChildren(pageEl);
    ({ appearance, editor, python: pythonPage, go: goPage, plugins: pluginsPage, keymap, about })[p](wb, pageEl, focusPlugin);
  };
  go(current);
}

function appearance(_wb: Workbench, el: HTMLElement) {
  const theme = document.documentElement.dataset.theme ?? "dark";
  const sel = h("select.select", { style: "width:240px" }, h("option", { value: "dark", selected: theme === "dark" }, "Islands Dark"), h("option", { value: "light", selected: theme === "light" }, "Islands Light")) as HTMLSelectElement;
  sel.onchange = () => (window as any).__setTheme?.(sel.value);
  const size = h("input.input", { type: "number", min: 11, max: 18, value: parseInt(getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size")) || 13, style: "width:90px" }) as HTMLInputElement;
  size.onchange = () => {
    document.documentElement.style.setProperty("--ui-font-size", size.value + "px");
    try {
      localStorage.setItem("ui-font", size.value);
    } catch {
      /* ignore */
    }
  };
  el.append(h("h3", null, "Aparência"), h("label.field.row", null, h("span", null, "Tema"), sel), h("label.field.row", null, h("span", null, "Tamanho da fonte da interface"), size));
  if (IS_MAC) {
    const glass = h("input", { type: "checkbox", checked: (window as any).__glassOn?.() }) as HTMLInputElement;
    glass.onchange = () => (window as any).__setGlass?.(glass.checked);
    el.append(
      h("label.field.row", null, h("span", null, "Liquid Glass"), h("label.check", null, glass, "Janela translúcida com o material de vidro do macOS")),
      h("div.hint", { style: "margin-left:152px" }, "Usa o Liquid Glass nativo no macOS 26 e a vibrancy nas versões anteriores."),
    );
  }
}

function editor(wb: Workbench, el: HTMLElement) {
  const size = h("input.input", { type: "number", min: 10, max: 28, value: parseInt(getComputedStyle(document.documentElement).getPropertyValue("--editor-font-size")) || 13, style: "width:90px" }) as HTMLInputElement;
  size.onchange = () => {
    document.documentElement.style.setProperty("--editor-font-size", size.value + "px");
    try {
      localStorage.setItem("editor-font", size.value);
    } catch {
      /* ignore */
    }
  };
  const fmt = h("input", { type: "checkbox", checked: wb.settings.goFmtOnSave !== false }) as HTMLInputElement;
  fmt.onchange = () => ((wb.settings.goFmtOnSave = fmt.checked), wb.saveSettings());
  el.append(
    h("h3", null, "Editor"),
    h("label.field.row", null, h("span", null, "Tamanho da fonte"), size),
    h("div.hint", null, "Fonte: JetBrains Mono. Arquivos são salvos automaticamente, como nas IDEs JetBrains."),
    h("label.check", null, fmt, "Go: executar gofmt/goimports ao salvar"),
  );
  const cs = completionSettings();
  const toggle = (key: keyof CompletionSettings, label: string, hint?: string) => {
    const inp = h("input", { type: "checkbox", checked: Boolean(cs[key]) }) as HTMLInputElement;
    inp.onchange = () => setCompletionSettings({ [key]: inp.checked });
    return h("div", null, h("label.check", null, inp, label), hint ? h("div.hint", { style: "margin:-2px 0 6px 21px" }, hint) : "");
  };
  const delay = h("input.input", { type: "number", min: 0, max: 1000, step: 20, value: cs.delay, style: "width:90px" }) as HTMLInputElement;
  delay.onchange = () => setCompletionSettings({ delay: Math.max(0, Number(delay.value) || 0) });
  el.append(
    h("h3", { style: "margin-top:18px" }, "Autocompletar"),
    toggle("auto", "Mostrar sugestões automaticamente ao digitar", "Desligado: as sugestões só aparecem com Ctrl+Espaço (⌃Espaço no Mac)."),
    toggle("docs", "Mostrar documentação ao lado da lista"),
    toggle("tabAccepts", "Tab também aceita a sugestão (além de Enter)"),
    toggle("words", "Sugerir palavras do arquivo quando não há servidor de linguagem"),
    h("label.field.row", null, h("span", null, "Atraso do popup (ms)"), delay),
    h("div.hint", null, "As sugestões vêm do servidor de linguagem (Pyright, gopls, terraform-ls, YAML LS, Docker LS) com a ordem de relevância dele, documentação e importação automática ao aceitar."),
  );
}

async function pythonPage(wb: Workbench, el: HTMLElement) {
  el.append(h("h3", null, "Interpretador Python do projeto"), h("div.dim", null, "Detectando interpretadores…"));
  clearSdkCache();
  const list = await findInterpreters(wb.root);
  const current = wb.python?.path.toLowerCase();
  const rows = h("div.list", { style: "border:1px solid var(--border);border-radius:8px;max-height:220px;flex:none" });
  const draw = () =>
    rows.replaceChildren(
      ...list.map((p) =>
        h(
          "div.list-row",
          { class: p.path.toLowerCase() === current ? "selected" : "", onclick: async () => (await wb.setPython(p), pythonPage(wb, clear(el))) },
          icon("python/pythonClosed"),
          h("span", null, p.label),
          h("span.detail", null, P.win(p.path)),
        ),
      ),
    );
  draw();
  const pkgs = h("div.list", { style: "border:1px solid var(--border);border-radius:8px;height:220px;flex:none" }, h("div.empty-note", null, "Carregando pacotes…"));
  const pkgInput = h("input.input", { placeholder: "pacote (ex.: requests, fastapi==0.115)", spellcheck: false }) as HTMLInputElement;
  el.replaceChildren(
    h("h3", null, "Interpretador Python do projeto"),
    rows,
    h(
      "div",
      { style: "display:flex;gap:8px" },
      button("Criar ambiente virtual (.venv)…", () => createVenv(wb, el), "", "general/add"),
      button("Adicionar interpretador…", async () => {
        const f = await openDialog({ filters: [{ name: "Python", extensions: ["exe"] }] });
        if (typeof f === "string") {
          const all = await findInterpreters();
          const { resolveInterpreter } = await import("./sdk");
          const info = await resolveInterpreter(wb.root, P.norm(f));
          if (info) await wb.setPython(info);
          void all;
          pythonPage(wb, clear(el));
        }
      }),
      button("Atualizar", () => pythonPage(wb, clear(el)), "", "general/refresh"),
    ),
    !list.length ? h("div.warn", null, `Nenhum Python encontrado. Instale com: ${INSTALL.python}`) : "",
    h("h3", { style: "margin-top:10px" }, "Pacotes"),
    pkgs,
    h(
      "div",
      { style: "display:flex;gap:8px" },
      pkgInput,
      button("Instalar", async () => {
        const pk = pkgInput.value.trim();
        if (!pk || !wb.python) return;
        const t = await runBackground(`pip install ${pk}`, wb.python.path, ["-m", "pip", "install", pk]);
        t.code === 0 ? notify(`${pk} instalado`, "", "ok", [], 3000) : notify(`Falha ao instalar ${pk}`, t.output.slice(-500), "error");
        pythonPage(wb, clear(el));
      }, "primary", "actions/install"),
      (await host.exists(P.join(wb.root, "requirements.txt"))) && wb.python
        ? button("Instalar requirements.txt", async () => {
            const t = await runBackground("pip install -r requirements.txt", wb.python!.path, ["-m", "pip", "install", "-r", "requirements.txt"], wb.root);
            t.code === 0 ? notify("Dependências instaladas", "", "ok") : notify("Falha no pip", t.output.slice(-600), "error");
            pythonPage(wb, clear(el));
          })
        : null,
    ),
  );
  if (!wb.python) return;
  const r = await host.capture(wb.python.path, ["-m", "pip", "list", "--format", "json", "--disable-pip-version-check"], "", undefined, 60).catch(() => null);
  try {
    const items = JSON.parse(r?.stdout || "[]") as { name: string; version: string }[];
    pkgs.replaceChildren(
      ...items.map((p) =>
        h(
          "div.list-row",
          null,
          icon("python/pythonPackages"),
          h("span", null, p.name),
          h("span.detail", { style: "margin-left:auto" }, p.version),
          h("button.icon-btn", {
            title: "Desinstalar",
            onclick: async () => {
              await runBackground(`pip uninstall ${p.name}`, wb.python!.path, ["-m", "pip", "uninstall", "-y", p.name]);
              pythonPage(wb, clear(el));
            },
          }, icon("general/remove")),
        ),
      ),
    );
  } catch {
    pkgs.replaceChildren(h("div.empty-note", null, "pip indisponível neste interpretador"));
  }
}

async function createVenv(wb: Workbench, el: HTMLElement) {
  const base = (await findInterpreters()).filter((p) => !p.venv).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  if (!base) return toast("Nenhum Python base encontrado para criar o ambiente.", "error");
  const t = await runBackground("Criando .venv", base.path, ["-m", "venv", ".venv"], wb.root);
  if (t.code !== 0) return notify("Falha ao criar venv", t.output.slice(-600), "error");
  clearSdkCache();
  const { resolveInterpreter } = await import("./sdk");
  const info = await resolveInterpreter(wb.root, P.join(wb.root, ".venv", IS_WIN ? "Scripts/python.exe" : "bin/python"));
  await wb.setPython(info);
  notify("Ambiente virtual criado", `${info?.label} — instale os plugins do Python neste ambiente.`, "ok", [{ label: "Instalar plugins", run: () => openSettings(wb, "plugins", "python") }], 10000);
  pythonPage(wb, clear(el));
}

async function goPage(_wb: Workbench, el: HTMLElement) {
  clearSdkCache();
  const g = await findGo();
  el.append(
    h("h3", null, "Go SDK"),
    g
      ? h("div", null, h("label.field.row", null, h("span", null, "Versão"), h("b", null, g.version)), h("label.field.row", null, h("span", null, "GOROOT"), h("span.mono", null, P.win(g.goroot))), h("label.field.row", null, h("span", null, "GOPATH"), h("span.mono", null, P.win(g.gopath))))
      : h(
          "div",
          null,
          h("p.warn", null, "Go não encontrado no PATH."),
          button(IS_WIN ? "Instalar Go (winget)" : "Instalar Go (Homebrew)", async () => {
            const t = IS_WIN
              ? await runBackground("Instalando Go", "winget", ["install", "--id", "GoLang.Go", "-e", "--silent", "--accept-source-agreements", "--accept-package-agreements"])
              : await runBackground("Instalando Go", "brew", ["install", "go"]);
            t.code === 0 ? notify("Go instalado", "Reinicie o Rits para atualizar o PATH.", "ok") : notify("Falha", t.output.slice(-500), "error");
          }, "primary", "actions/install"),
        ),
    h("div.hint", { style: "margin-top:8px" }, "Os componentes (gopls, Delve, staticcheck) ficam em Plugins."),
  );
}

async function pluginsPage(wb: Workbench, el: HTMLElement, focus?: string) {
  el.append(h("h3", null, "Plugins"), h("div.dim", null, "Componentes de linguagem são instalados no interpretador do projeto (Python) e no GOPATH (Go)."));
  const cards: HTMLElement[] = [];
  for (const p of PLUGINS) cards.push(await pluginCard(wb, p, el, focus === p.id));
  el.append(...cards);
  el.append(h("h3", { style: "margin-top:8px" }, "Infraestrutura"), await dockerCard(wb, el, focus === "docker"));
  const builtin: [string, string, string][] = [
    ["Database Tools", "database", "PostgreSQL e MySQL/MariaDB: explorador, console SQL, editor de dados, backup e restauração."],
    ["Git", "branch", "Branches, commit, push/pull, log, diff e marcadores de alteração no editor."],
    ["Terminal", "toolwindows/terminal", "Terminal integrado com PTY real e ativação do venv."],
    ["Markdown, JSON, YAML, TOML, HTML, CSS, JS/TS, SQL, Dockerfile, Shell", "fileTypes/text", "Realce de sintaxe e edição."],
  ];
  el.append(
    h("h3", { style: "margin-top:8px" }, "Incluídos"),
    ...builtin.map(([name, ic, desc]) =>
      h("div.plugin-card", null, h("div.pc-icon", null, icon(ic)), h("div.pc-body", null, h("div.pc-title", null, name, h("span.tag.ok", null, "incluído")), h("div.dim", null, desc))),
    ),
  );
}

async function dockerCard(wb: Workbench, el: HTMLElement, highlightCard: boolean): Promise<HTMLElement> {
  const on = dockerEnabled();
  const comps = h("div", { style: "display:flex;flex-direction:column;gap:2px;margin-top:6px" });
  const toggle = h("button.btn", { class: on ? "" : "primary" }, icon(on ? "general/delete" : "actions/install"), on ? "Desinstalar" : "Instalar plugin") as HTMLButtonElement;
  toggle.onclick = () => {
    setDockerEnabled(!on);
    if (!on) {
      notify("Plugin Docker instalado", "A janela Docker apareceu na faixa da direita, embaixo.", "ok", [{ label: "Abrir", run: () => wb.show("docker", true) }], 6000);
    }
    pluginsPage(wb, clear(el), "docker");
  };
  const card = h(
    "div.plugin-card",
    { style: highlightCard ? "border-color:var(--accent)" : "" },
    h("div.pc-icon", null, icon("docker")),
    h(
      "div.pc-body",
      null,
      h("div.pc-title", null, "Docker", on ? h("span.tag.ok", null, "ativo") : "", h("span.grow"), toggle),
      h("div.dim", null, "Gerencie os containers, imagens e volumes locais: iniciar, parar, reiniciar, logs, terminal no container, inspeção, uso de CPU/memória e grupos do Docker Compose."),
      comps,
    ),
  );
  const statuses = await Promise.all(DOCKER_COMPONENTS.map((c) => c.check().catch(() => null)));
  DOCKER_COMPONENTS.forEach((c, i) => {
    const v = statuses[i];
    const cmd = c.install();
    comps.append(
      h(
        "div.plugin-comp",
        null,
        icon(v ? "status/success" : "status/warningOutline"),
        h("b", null, c.name),
        h("span.pc-ver", { title: c.purpose }, v ? `${v} — ${c.purpose}` : c.purpose),
        !v && cmd && c.action
          ? h(
              "button.btn",
              {
                style: "height:24px;min-width:0;padding:0 10px",
                onclick: async () => {
                  const t = await runBackground(`${c.action} ${c.name}`, cmd.program, cmd.args);
                  if (t.code !== 0) notify(`Falha: ${c.name}`, t.output.trim().split("\n").slice(-4).join("\n"), "error", [], 12000);
                  setTimeout(() => pluginsPage(wb, clear(el), "docker"), c.id === "engine" ? 8000 : 0);
                },
              },
              c.action,
            )
          : "",
      ),
    );
  });
  if (!statuses[0]) comps.append(h("div.hint", null, `Sem o Docker? Instale o Docker Desktop (${DOCKER_INSTALL.label}), o OrbStack ou o Colima. O plugin usa o comando docker de qualquer um deles.`));
  return card;
}

async function pluginCard(wb: Workbench, p: LangPlugin, el: HTMLElement, highlightCard: boolean): Promise<HTMLElement> {
  const comps = h("div", { style: "display:flex;flex-direction:column;gap:2px;margin-top:6px" });
  const installAll = h("button.btn.primary", null, icon("actions/install"), "Instalar tudo") as HTMLButtonElement;
  const card = h(
    "div.plugin-card",
    { style: highlightCard ? "border-color:var(--accent)" : "" },
    h("div.pc-icon", null, icon(p.icon)),
    h("div.pc-body", null, h("div.pc-title", null, p.name, h("span.grow"), installAll), h("div.dim", null, p.description), comps),
  );
  const prereq = p.id === "python" ? getCurrentPython() : p.id === "go" ? await findGo() : true;
  if (!prereq) {
    comps.append(h("div.warn", null, p.id === "python" ? "Configure um interpretador Python primeiro (página Interpretador Python)." : "Instale o Go SDK primeiro (página Go)."));
    installAll.disabled = true;
    return card;
  }
  if (p.id === "python") comps.append(h("div.hint", null, `Interpretador: ${getCurrentPython()!.label} — ${P.win(getCurrentPython()!.path)}`));
  const statuses = await Promise.all(p.components.map((c) => c.check().catch(() => null)));
  const install = async (list: typeof p.components) => {
    installAll.disabled = true;
    for (const c of list) {
      const cmd = c.install();
      if (!cmd) continue;
      const t = await runBackground(`Instalando ${c.name}`, cmd.program, cmd.args, wb.root);
      if (t.code !== 0) notify(`Falha ao instalar ${c.name}`, t.output.trim().split("\n").slice(-4).join("\n"), "error", [], 12000);
    }
    clearSdkCache();
    setCurrentPython(wb.python);
    notify(`Plugin ${p.name} atualizado`, "Servidor de linguagem reiniciado.", "ok", [], 4000);
    for (const lang of p.id === "infra" ? (["terraform", "dockerfile", "yaml"] as const) : [p.id]) {
      await wb.lsp.restart(lang).catch(() => null);
      wb.editors.reattachLsp(lang);
    }
    wb.renderStatus();
    pluginsPage(wb, clear(el));
  };
  installAll.onclick = () => install(p.components.filter((_, i) => !statuses[i]));
  installAll.disabled = statuses.every(Boolean);
  if (statuses.every(Boolean)) installAll.replaceChildren(icon("actions/checked"), "Instalado");
  p.components.forEach((c, i) => {
    const v = statuses[i];
    comps.append(
      h(
        "div.plugin-comp",
        null,
        icon(v ? "status/success" : "status/warningOutline"),
        h("b", null, c.name),
        h("span.pc-ver", { title: c.purpose }, v ? `${v} — ${c.purpose}` : c.purpose),
        h("button.btn", { style: "height:24px;min-width:0;padding:0 10px", onclick: () => install([c]) }, v ? "Atualizar" : "Instalar"),
      ),
    );
  });
  return card;
}

function keymap(wb: Workbench, el: HTMLElement) {
  const sel = h(
    "select.select",
    { style: "width:240px" },
    h("option", { value: "vscode", selected: keymapId() === "vscode" }, "VS Code"),
    h("option", { value: "jetbrains", selected: keymapId() === "jetbrains" }, IS_MAC ? "JetBrains (Ctrl = ⌘)" : "JetBrains para Windows"),
  ) as HTMLSelectElement;
  sel.onchange = () => {
    setKeymap(sel.value as KeymapId);
    keymap(wb, clear(el));
  };
  el.append(
    h("h3", null, "Keymap"),
    h("label.field.row", null, h("span", null, "Esquema de atalhos"), sel),
    h("div.hint", { style: "margin:4px 0 12px" }, "Os menus e a paleta de comandos mostram os atalhos do esquema escolhido."),
    h("div.keys-list", null, ...keymapTable().map(([a, b]) => h("div.wk", null, h("span", { style: "color:var(--fg)" }, a), h("kbd", null, b)))),
  );
}

function about(_wb: Workbench, el: HTMLElement) {
  el.append(
    h(
      "div.about",
      { style: "margin-top:30px" },
      icon("logo"),
      h("h2", null, "Rits 0.2.0"),
      h("p.dim", null, "IDE leve para Python, Go e bancos de dados — Tauri + Rust + TypeScript."),
      h("p.dim", null, "Interface no estilo Islands. Ícones e cores derivados do projeto IntelliJ Community (Apache 2.0)."),
      h("p.dim", null, "Fontes: Inter e JetBrains Mono (SIL OFL)."),
    ),
  );
}

function clear(el: HTMLElement) {
  el.replaceChildren();
  return el;
}
