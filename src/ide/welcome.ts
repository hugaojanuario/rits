// Welcome screen (no project open), New Project and Clone Repository dialogs.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { h } from "../util";
import { icon } from "../icons";
import { button, contextMenu, modal, toast } from "../ui";
import { host, INSTALL, P, REVEAL_LABEL } from "./host";
import { projectBadge, recentProjects, removeRecent, type RecentProject } from "./project";
import { findGo, findInterpreters, runBackground } from "./sdk";
import { cloneRepo } from "./git";
import { defaultGitignore } from "./projectView";
import type { Workbench } from "./workbench";

const VERSION = "0.2.0";

function openPath(wb: Workbench | null, path: string) {
  if (wb) wb.openProject(path);
  else location.href = `index.html?project=${encodeURIComponent(P.norm(path))}`;
}

async function defaultParent() {
  const env = await host.env();
  return P.join(env.home, "RitsProjects");
}

export async function mountWelcome(app: HTMLElement) {
  const win = getCurrentWindow();
  win.setTitle("Bem-vindo ao Rits").catch(() => {});
  document.title = "Bem-vindo ao Rits";
  const env = await host.env();
  const drag = h("div.tb-drag", { "data-tauri-drag-region": true });
  const toolbar = h(
    "div.main-toolbar",
    null,
    h("span", { style: "width:8px" }),
    drag,
    h(
      "div.win-controls",
      null,
      h("button.win-btn", { onclick: () => win.minimize() }, icon("minimize")),
      h("button.win-btn", { onclick: () => win.toggleMaximize() }, icon("maximize")),
      h("button.win-btn.close", { onclick: () => win.close() }, icon("closeWin")),
    ),
  );
  let page: "projects" | "customize" | "learn" = "projects";
  const main = h("div.welcome-main");
  const nav = h("div.welcome-nav");
  const drawNav = () =>
    nav.replaceChildren(
      h("div.welcome-brand", null, icon("logo"), h("div", null, h("div.wb-name", null, "Rits"), h("div.wb-ver", null, VERSION))),
      ...([["projects", "Projetos", "nodes/folder"], ["customize", "Personalizar", "general/settings"], ["learn", "Aprender", "general/help"]] as const).map(([id, label, ic]) =>
        h("div.nav-item", { class: page === id ? "active" : "", onclick: () => ((page = id), drawNav(), draw()) }, icon(ic), label),
      ),
    );
  const draw = async () => {
    if (page === "customize") {
      const theme = document.documentElement.dataset.theme ?? "dark";
      const sel = h("select.select", { style: "width:240px" }, h("option", { value: "dark", selected: theme === "dark" }, "Islands Dark"), h("option", { value: "light", selected: theme === "light" }, "Islands Light")) as HTMLSelectElement;
      sel.onchange = () => (window as any).__setTheme?.(sel.value);
      main.replaceChildren(h("div.settings-page", null, h("h3", null, "Tema de cores"), sel, h("div.hint", null, "Mais opções em Configurações (Ctrl+Alt+S) dentro de um projeto.")));
      return;
    }
    if (page === "learn") {
      const tips: [string, string][] = [
        ["Shift duplo", "Buscar em tudo: arquivos, símbolos e ações"],
        ["Clique no nome do projeto", "Trocar de projeto, criar, abrir ou clonar"],
        ["Clique no branch", "Trocar de branch, commit, push e pull"],
        ["Alt+Enter", "Correções rápidas do servidor de linguagem"],
        ["Ctrl+Shift+F10", "Executar o arquivo atual (Python ou Go)"],
        ["Clique no gutter", "Criar breakpoint e depurar com Shift+F9"],
        ["Alt+2", "Database: PostgreSQL, MySQL, backup e restauração"],
      ];
      main.replaceChildren(h("div.settings-page", null, h("h3", null, "Primeiros passos"), h("div.keys-list", null, ...tips.map(([a, b]) => h("div.wk", null, h("kbd", null, a), h("span", null, b))))));
      return;
    }
    const recent = await recentProjects();
    const search = h("input.input", { placeholder: "Buscar projetos", spellcheck: false }) as HTMLInputElement;
    const listEl = h("div.welcome-list");
    const drawList = () => {
      const q = search.value.toLowerCase();
      listEl.replaceChildren(
        ...recent
          .filter((r) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q))
          .map((r) => recentRow(r, env.home, () => draw())),
      );
    };
    search.oninput = drawList;
    const actions = h(
      "div",
      { style: "display:flex;gap:8px;margin-left:auto" },
      button("Novo projeto", () => openNewProjectDialog(null), "primary"),
      button("Abrir", async () => {
        const d = await openDialog({ directory: true, title: "Abrir projeto" });
        if (typeof d === "string") openPath(null, d);
      }),
      button("Clonar repositório", () => openCloneDialog(null)),
    );
    if (!recent.length) {
      main.replaceChildren(
        h(
          "div.welcome-hero",
          null,
          icon("logo"),
          h("h2", null, "Bem-vindo ao Rits"),
          h("div.dim", null, "Crie um novo projeto para começar do zero."),
          h("div.dim", null, "Abra um projeto existente do disco ou do controle de versão."),
          h(
            "div.welcome-actions",
            null,
            ...([["Novo projeto", "welcome/createNewProjectTab", () => openNewProjectDialog(null)], ["Abrir", "welcome/open", async () => {
              const d = await openDialog({ directory: true });
              if (typeof d === "string") openPath(null, d);
            }], ["Clonar repositório", "welcome/fromVCSTab", () => openCloneDialog(null)]] as const).map(([label, ic, fn]) =>
              h("div.welcome-action", null, h("button.wa-btn", { onclick: fn }, icon(ic)), h("span", null, label)),
            ),
          ),
        ),
      );
      return;
    }
    main.replaceChildren(h("div.welcome-top", null, search, actions), listEl);
    drawList();
    setTimeout(() => search.focus());
  };
  drawNav();
  draw();
  app.replaceChildren(toolbar, h("div.welcome-win", null, nav, main));
}

function recentRow(r: RecentProject, home: string, refresh: () => void) {
  const more = h("button.icon-btn.ri-more", { title: "Opções" }, icon("general/moreVertical"));
  const row = h(
    "div.recent-item",
    { title: P.win(r.path) },
    projectBadge(r.name, true),
    h("div", { style: "min-width:0" }, h("div.ri-name", null, r.name), h("div.ri-path", null, P.win(r.path).replace(P.win(home), "~") + (r.branch ? `   ${r.branch}` : ""))),
    more,
  );
  row.onclick = async (e) => {
    if ((e.target as HTMLElement).closest(".ri-more")) return;
    if (!(await host.exists(r.path))) {
      toast("A pasta do projeto não existe mais.", "error");
      return;
    }
    openPath(null, r.path);
  };
  more.onclick = (e) =>
    contextMenu(e.clientX, e.clientY, [
      { label: REVEAL_LABEL, action: () => host.reveal(r.path) },
      { label: "Copiar caminho", action: () => navigator.clipboard.writeText(P.win(r.path)) },
      { label: "Remover da lista", icon: "general/remove", action: () => removeRecent(r.path).then(refresh) },
    ]);
  return row;
}

// ---------------- New Project ----------------
export async function openNewProjectDialog(wb: Workbench | null) {
  const m = modal("Novo projeto", { width: 900 });
  m.root.style.height = "620px";
  m.body.style.cssText = "padding:0;display:flex;min-height:0;overflow:hidden";
  type Kind = "python" | "go" | "empty";
  let kind: Kind = "python";
  const parent = await defaultParent();
  const nav = h("div.modal-nav.gen-list");
  const form = h("div.np-form");
  m.body.append(nav, form);
  const nameI = h("input.input", { value: "meuProjeto", spellcheck: false }) as HTMLInputElement;
  const locI = h("input.input", { value: P.win(parent), spellcheck: false }) as HTMLInputElement;
  const preview = h("div.np-preview");
  const gitCb = h("input", { type: "checkbox", checked: true }) as HTMLInputElement;
  const sampleCb = h("input", { type: "checkbox", checked: true }) as HTMLInputElement;
  const venvCb = h("input", { type: "checkbox", checked: true }) as HTMLInputElement;
  const interpSel = h("select.select") as HTMLSelectElement;
  const modI = h("input.input", { spellcheck: false, placeholder: "github.com/usuario/projeto" }) as HTMLInputElement;
  const goInfo = h("span.dim");
  const upd = () => {
    preview.textContent = `O projeto será criado em: ${P.win(P.join(P.norm(locI.value), nameI.value.trim()))}`;
    if (!modI.dataset.touched) modI.value = nameI.value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  };
  nameI.oninput = upd;
  locI.oninput = upd;
  modI.oninput = () => (modI.dataset.touched = "1");
  findInterpreters().then((list) => {
    const base = list.filter((p) => !p.venv).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    interpSel.replaceChildren(...base.map((p) => h("option", { value: p.path }, `${p.label} — ${P.win(p.path)}`)));
    if (!base.length) interpSel.append(h("option", { value: "" }, "Nenhum Python encontrado"));
  });
  findGo().then((g) => (goInfo.textContent = g ? `Go ${g.version} — ${P.win(g.goroot)}` : `Go SDK não encontrado (instale com ${INSTALL.go})`));
  const drawNav = () =>
    nav.replaceChildren(
      ...([["python", "Python puro", "python/python"], ["go", "Go", "goFile"], ["empty", "Projeto vazio", "nodes/folder"]] as const).map(([k, label, ic]) =>
        h("div.nav-item", { class: k === kind ? "active" : "", onclick: () => ((kind = k), drawNav(), drawForm()) }, icon(ic), label),
      ),
    );
  const row = (label: string, el: HTMLElement) => h("label.field.row", null, h("span", null, label), el);
  const drawForm = () => {
    form.replaceChildren(
      row("Nome:", nameI),
      row(
        "Local:",
        h("div.input-row", { style: "flex:1" }, locI, button("…", async () => {
          const d = await openDialog({ directory: true });
          if (typeof d === "string") (locI.value = P.win(d)), upd();
        })),
      ),
      preview,
      h("label.check", null, gitCb, "Criar repositório Git"),
      ...(kind === "python"
        ? [h("div.sub-label", null, "Interpretador"), h("label.check", null, venvCb, "Criar ambiente virtual (.venv) com:"), interpSel, h("label.check", null, sampleCb, "Criar script de boas-vindas main.py")]
        : kind === "go"
          ? [h("div.sub-label", null, "Go"), goInfo, row("Caminho do módulo:", modI), h("label.check", null, sampleCb, "Criar main.go de exemplo")]
          : []),
    );
    upd();
  };
  drawNav();
  drawForm();
  const status = h("span.dim", { style: "margin-right:auto" });
  const createBtn = button("Criar", async () => {
    const name = nameI.value.trim();
    if (!name) return;
    const dir = P.join(P.norm(locI.value), name);
    if ((await host.exists(dir)) && (await host.list(dir)).length) return toast("A pasta de destino já existe e não está vazia.", "error");
    createBtn.disabled = true;
    try {
      await host.create(dir, true).catch(() => {});
      if (kind === "python") {
        if (sampleCb.checked)
          await host.write(P.join(dir, "main.py"), `# Este é um script Python de exemplo.\n\n# Pressione Shift+F10 para executar ou substitua pelo seu código.\n# Clique no gutter para criar breakpoints e Shift+F9 para depurar.\n\n\ndef print_hi(name: str) -> None:\n    print(f"Olá, {name}")  # Ctrl+F8 alterna o breakpoint.\n\n\nif __name__ == "__main__":\n    print_hi("Rits")\n`);
        if (venvCb.checked && interpSel.value) {
          status.textContent = "Criando ambiente virtual…";
          const t = await runBackground("Criando .venv", interpSel.value, ["-m", "venv", ".venv"], dir);
          if (t.code !== 0) toast("Falha ao criar venv: " + t.output.slice(-300), "error");
        }
      } else if (kind === "go") {
        const g = await findGo();
        if (g) {
          status.textContent = "go mod init…";
          await host.capture(g.path, ["mod", "init", modI.value.trim() || name.toLowerCase()], dir, undefined, 60);
        } else await host.write(P.join(dir, "go.mod"), `module ${modI.value.trim() || name.toLowerCase()}\n\ngo 1.23\n`);
        if (sampleCb.checked)
          await host.write(P.join(dir, "main.go"), `package main\n\nimport "fmt"\n\n// Pressione Shift+F10 para executar ou clique no ▶ do gutter.\nfunc main() {\n\tnome := "Rits"\n\tfmt.Printf("Olá, %s!\\n", nome)\n\n\tfor i := 1; i <= 5; i++ {\n\t\t// Clique no gutter para criar um breakpoint e depure com Shift+F9.\n\t\tfmt.Println("i =", 100/i)\n\t}\n}\n`);
      }
      if (gitCb.checked) {
        await host.write(P.join(dir, ".gitignore"), defaultGitignore());
        await host.capture("git", ["init"], dir, undefined, 30).catch(() => null);
      }
      m.close();
      openPath(wb, dir);
    } catch (e) {
      toast(String(e), "error");
      createBtn.disabled = false;
    }
  }, "primary");
  m.footer.append(status, button("Cancelar", () => m.close()), createBtn);
  setTimeout(() => nameI.select());
}

// ---------------- Clone ----------------
export async function openCloneDialog(wb: Workbench | null) {
  const m = modal("Clonar repositório", { width: 640 });
  const parent = await defaultParent();
  const urlI = h("input.input", { placeholder: "https://github.com/usuario/repositorio.git", spellcheck: false }) as HTMLInputElement;
  const dirI = h("input.input", { value: P.win(parent), spellcheck: false }) as HTMLInputElement;
  let touched = false;
  dirI.oninput = () => (touched = true);
  urlI.oninput = () => {
    if (touched) return;
    const name = urlI.value.trim().replace(/\.git$/, "").split(/[/:]/).pop() || "";
    dirI.value = P.win(P.join(parent, name));
  };
  navigator.clipboard
    .readText()
    .then((t) => {
      if (/^(https?:\/\/|git@).+/.test(t.trim()) && !urlI.value) {
        urlI.value = t.trim();
        urlI.dispatchEvent(new Event("input"));
      }
    })
    .catch(() => {});
  const progress = h("div.mono.dim", { style: "font-size:12px;min-height:18px;white-space:pre-wrap;margin-top:8px" });
  m.body.append(
    h("label.field", null, h("span", null, "URL:"), urlI),
    h("label.field", { style: "margin-top:10px" }, h("span", null, "Diretório:"), h("div.input-row", null, dirI, button("…", async () => {
      const d = await openDialog({ directory: true });
      if (typeof d === "string") (dirI.value = P.win(P.join(P.norm(d), P.base(P.norm(dirI.value))))), (touched = true);
    }))),
    progress,
  );
  const cloneBtn = button("Clonar", async () => {
    const url = urlI.value.trim();
    const dest = P.norm(dirI.value.trim());
    if (!url || !dest) return;
    if (!(await host.which("git"))) return toast(`Git não encontrado. Instale com: ${INSTALL.git}`, "error", 8000);
    if (await host.exists(dest)) return toast("O diretório de destino já existe.", "error");
    await host.create(P.dir(dest), true).catch(() => {});
    cloneBtn.disabled = true;
    progress.textContent = "Clonando…";
    const ok = await cloneRepo(url, dest, (line) => (progress.textContent = line));
    if (!ok) {
      cloneBtn.disabled = false;
      return;
    }
    m.close();
    openPath(wb, dest);
  }, "primary");
  m.footer.append(button("Cancelar", () => m.close()), cloneBtn);
  setTimeout(() => urlI.focus());
}
