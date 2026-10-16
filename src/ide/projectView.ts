// "Project" tool window: lazy file tree with VCS colors, file operations and drag & drop.
import { h } from "../util";
import { icon, fileIconName } from "../icons";
import { confirmDialog, contextMenu, modal, button, toast, type MenuItem } from "../ui";
import { host, P, REVEAL_LABEL, type Entry } from "./host";
import { infraActions, infraKind, INFRA_ICON, INFRA_LABEL, INFRA_TEMPLATES, type InfraTemplate } from "./infra";
import type { Workbench } from "./workbench";

interface Node {
  path: string;
  name: string;
  dir: boolean;
  ignored: boolean;
  children?: Node[];
  expanded?: boolean;
  loading?: boolean;
  parent?: Node;
}

export class ProjectView {
  el = h("div.tree", { tabIndex: 0 });
  private root: Node;
  private selected: Node | null = null;
  private expanded: Set<string>;
  private renameEl: { node: Node; input: HTMLInputElement } | null = null;

  constructor(private wb: Workbench) {
    this.root = { path: wb.root, name: wb.name, dir: true, ignored: false, expanded: true };
    this.expanded = new Set((wb.settings.expanded ?? []).map((p) => p.toLowerCase()));
    this.expanded.add(wb.root.toLowerCase());
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    this.el.addEventListener("contextmenu", (e) => {
      if (e.target === this.el) {
        e.preventDefault();
        this.select(this.root);
        contextMenu(e.clientX, e.clientY, this.menu(this.root));
      }
    });
    this.el.addEventListener("dragover", (e) => e.preventDefault());
    wb.register({
      id: "project",
      title: "Projeto",
      icon: "project",
      anchor: "left",
      shortcut: "Alt+1",
      body: h("div.tw-body", null, this.el),
      actions: () => [
        h("button.icon-btn", { title: "Selecionar arquivo aberto", onclick: () => this.locateActive() }, icon("general/locate")),
        h("button.icon-btn", { title: "Expandir selecionado", onclick: () => this.selected && this.expandAll(this.selected) }, icon("general/expandAll")),
        h("button.icon-btn", { title: "Recolher tudo", onclick: () => this.collapseAll() }, icon("general/collapseAll")),
      ],
    });
    this.load(this.root).then(() => this.render());
  }

  // ---------- data ----------
  private async load(n: Node) {
    n.loading = true;
    try {
      const list: Entry[] = await host.list(n.path);
      const prev = new Map((n.children ?? []).map((c) => [c.path.toLowerCase(), c]));
      n.children = list.map((e) => {
        const old = prev.get(e.path.toLowerCase());
        if (old) {
          old.ignored = e.ignored;
          return old;
        }
        return { path: P.norm(e.path), name: e.name, dir: e.isDir, ignored: e.ignored, parent: n };
      });
      for (const c of n.children) {
        c.parent = n;
        if (c.dir && this.expanded.has(c.path.toLowerCase())) {
          c.expanded = true;
          await this.load(c);
        }
      }
    } catch {
      n.children = [];
    } finally {
      n.loading = false;
    }
  }

  async onFsChange(paths: string[]) {
    const dirs = new Set<string>();
    for (const p of paths) {
      if (/\/\.git(\/|$)/.test(p)) continue;
      dirs.add(P.dir(p).toLowerCase());
    }
    let changed = false;
    const walk = async (n: Node) => {
      if (!n.dir || !n.children) return;
      if (dirs.has(n.path.toLowerCase())) {
        await this.load(n);
        changed = true;
      }
      for (const c of n.children) if (c.expanded) await walk(c);
    };
    await walk(this.root);
    if (changed) this.render();
  }

  async refresh() {
    await this.load(this.root);
    this.render();
  }

  // ---------- rendering ----------
  private visibleRows(): { n: Node; depth: number }[] {
    const out: { n: Node; depth: number }[] = [];
    const walk = (n: Node, depth: number) => {
      out.push({ n, depth });
      if (n.expanded && n.children) for (const c of n.children) walk(c, depth + 1);
    };
    walk(this.root, 0);
    return out;
  }

  render() {
    const git = this.wb.git;
    const diag = this.wb.lsp.diagnostics;
    const errorFiles = [...diag.entries()].filter(([, d]) => d.some((x) => x.severity === 1)).map(([p]) => p.toLowerCase());
    const rows = this.visibleRows().map(({ n, depth }) => {
      const vcs = git?.statusOf(n.path, n.dir);
      const hasErr = n.dir ? errorFiles.some((f) => f.startsWith(n.path.toLowerCase() + "/")) : errorFiles.includes(n.path.toLowerCase());
      const row = h(
        "div.tree-row",
        {
          class: [n === this.selected && "selected", n.ignored && "ignored", vcs && "vcs-" + vcs, hasErr && "has-error"].filter(Boolean).join(" "),
          style: `padding-left:${8 + depth * 18}px`,
          draggable: n !== this.root,
        },
        h(
          "span.twisty",
          { onclick: (e: MouseEvent) => (e.stopPropagation(), this.toggle(n)) },
          n.dir ? icon(n.loading ? "general/refresh" : n.expanded ? "general/chevronDown" : "general/chevronRight", n.loading ? "spin" : "") : null,
        ),
        icon(n === this.root ? "nodes/folder" : n.dir ? this.folderIcon(n) : fileIconName(n.name)),
        h("span.tree-label", { style: n === this.root ? "font-weight:600" : "" }, n.name),
        n === this.root ? h("span.tree-detail", null, P.win(n.path).replace(P.win(this.wb.env.home), "~")) : null,
      );
      if (this.renameEl?.node === n) {
        row.querySelector(".tree-label")!.replaceWith(this.renameEl.input);
      }
      row.addEventListener("mousedown", () => this.select(n));
      row.addEventListener("dblclick", () => (n.dir ? this.toggle(n) : this.open(n)));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.select(n);
        const x = e.clientX;
        const y = e.clientY;
        if (!n.dir && /\.ya?ml$/i.test(n.name) && !this.infraText.has(n.path.toLowerCase()))
          host
            .read(n.path)
            .then((t) => this.infraText.set(n.path.toLowerCase(), t.text.slice(0, 4000)))
            .catch(() => {})
            .finally(() => contextMenu(x, y, this.menu(n)));
        else contextMenu(x, y, this.menu(n));
      });
      row.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/rits-path", n.path));
      row.addEventListener("dragover", (e) => {
        if (n.dir) {
          e.preventDefault();
          row.classList.add("drop-target");
        }
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
      row.addEventListener("drop", (e) => {
        row.classList.remove("drop-target");
        const src = e.dataTransfer?.getData("text/rits-path");
        if (src && n.dir) this.move(src, n.path);
      });
      return row;
    });
    this.el.replaceChildren(...rows);
    if (this.renameEl) setTimeout(() => this.renameEl?.input.focus());
  }

  private folderIcon(n: Node) {
    const name = n.name.toLowerCase();
    if (n.ignored || name === "__pycache__" || name === ".venv" || name === "venv" || name === "node_modules") return "nodes/excludeRoot";
    if (name === "tests" || name === "test") return "nodes/testRoot";
    if (name === ".github") return "nodes/folderGithub";
    if (name === ".idea" || name === ".vscode") return "nodes/editFolder";
    return "nodes/folder";
  }

  highlight(path: string) {
    const n = this.find(path);
    if (n && n !== this.selected) {
      this.selected = n;
      this.render();
    }
  }

  private find(path: string): Node | null {
    const key = P.norm(path).toLowerCase();
    let found: Node | null = null;
    const walk = (n: Node) => {
      if (n.path.toLowerCase() === key) found = n;
      else if (n.children && key.startsWith(n.path.toLowerCase() + "/")) n.children.forEach(walk);
    };
    walk(this.root);
    return found;
  }

  async reveal(path: string) {
    this.wb.show("project");
    const parts = P.rel(this.root.path, path).split("/");
    let n: Node = this.root;
    for (const part of parts) {
      if (!n.children) await this.load(n);
      const next: Node | undefined = n.children?.find((c) => c.name.toLowerCase() === part.toLowerCase());
      if (!next) break;
      if (next.dir && next !== n) {
        next.expanded = true;
        this.expanded.add(next.path.toLowerCase());
        if (!next.children) await this.load(next);
      }
      n = next;
    }
    this.selected = n;
    this.saveExpanded();
    this.render();
    this.el.querySelector(".tree-row.selected")?.scrollIntoView({ block: "center" });
  }

  private locateActive() {
    const ed = this.wb.editors.active();
    if (ed) this.reveal(ed.path);
  }

  private select(n: Node) {
    this.selected = n;
    this.el.querySelectorAll(".tree-row.selected").forEach((x) => x.classList.remove("selected"));
    const idx = this.visibleRows().findIndex((r) => r.n === n);
    this.el.children[idx]?.classList.add("selected");
  }

  selectedPath() {
    return this.selected?.path ?? null;
  }

  private async toggle(n: Node) {
    if (!n.dir) return;
    n.expanded = !n.expanded;
    if (n.expanded) {
      this.expanded.add(n.path.toLowerCase());
      if (!n.children) {
        this.render();
        await this.load(n);
      }
    } else this.expanded.delete(n.path.toLowerCase());
    this.saveExpanded();
    this.render();
  }

  private async expandAll(n: Node) {
    const walk = async (x: Node, depth: number) => {
      if (!x.dir || x.ignored || depth > 6) return;
      x.expanded = true;
      this.expanded.add(x.path.toLowerCase());
      if (!x.children) await this.load(x);
      for (const c of x.children ?? []) await walk(c, depth + 1);
    };
    await walk(n, 0);
    this.saveExpanded();
    this.render();
  }

  private collapseAll() {
    const walk = (n: Node) => {
      if (n !== this.root) n.expanded = false;
      n.children?.forEach(walk);
    };
    walk(this.root);
    this.expanded = new Set([this.root.path.toLowerCase()]);
    this.saveExpanded();
    this.render();
  }

  private saveExpanded() {
    this.wb.settings.expanded = [...this.expanded];
    this.wb.saveSettings();
  }

  private open(n: Node) {
    if (!n.dir) this.wb.editors.openFile(n.path);
  }

  private onKey(e: KeyboardEvent) {
    if (this.renameEl) return;
    const rows = this.visibleRows().map((r) => r.n);
    const i = this.selected ? rows.indexOf(this.selected) : -1;
    const n = this.selected;
    const sel = (j: number) => {
      const t = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (t) this.select(t);
      this.el.querySelector(".tree-row.selected")?.scrollIntoView({ block: "nearest" });
    };
    if (e.key === "ArrowDown") sel(i + 1);
    else if (e.key === "ArrowUp") sel(i - 1);
    else if (e.key === "ArrowRight" && n?.dir) n.expanded ? sel(i + 1) : this.toggle(n);
    else if (e.key === "ArrowLeft" && n) n.dir && n.expanded ? this.toggle(n) : n.parent && this.select(n.parent);
    else if (e.key === "Enter" && n) n.dir ? this.toggle(n) : this.open(n);
    else if (e.key === "F4" && n && !n.dir) this.open(n);
    else if (e.key === "Delete" && n && n !== this.root) this.delete(n);
    else if (e.key === "F6" && e.shiftKey && n && n !== this.root) this.startRename(n);
    else if (e.key === "Insert" && e.altKey) this.newFileAt(n ? (n.dir ? n.path : P.dir(n.path)) : null);
    else if (e.key === "c" && e.ctrlKey && e.shiftKey && n) navigator.clipboard.writeText(P.win(n.path));
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // ---------- operations ----------
  private menu(n: Node): MenuItem[] {
    const dir = n.dir ? n.path : P.dir(n.path);
    const target = !n.dir ? this.wb.runner.fileTarget(n.path) : null;
    const items: MenuItem[] = [
      {
        label: "Novo",
        icon: "general/add",
        submenu: [
          { label: "Arquivo", icon: "fileTypes/text", action: () => this.newEntry(dir, "file") },
          { label: "Diretório", icon: "nodes/folder", action: () => this.newEntry(dir, "dir") },
          { separator: true },
          { label: "Arquivo Python", icon: "python/python", action: () => this.newEntry(dir, "python") },
          { label: "Pacote Python", icon: "nodes/package", action: () => this.newEntry(dir, "package") },
          { label: "Arquivo Go", icon: "goFile", action: () => this.newEntry(dir, "go") },
          { separator: true },
          { label: "Arquivo Markdown", icon: "fileTypes/markdown", action: () => this.newEntry(dir, "md") },
          { label: ".gitignore", icon: "fileTypes/gitignore", action: () => this.createFile(P.join(dir, ".gitignore"), defaultGitignore()) },
          { separator: true },
          ...INFRA_TEMPLATES.map((t) => ({ label: t.label, icon: t.icon, action: () => this.createInfra(t, dir) })),
          ...(this.wb.airflow ? [{ label: "DAG do Airflow", icon: "airflow", action: () => this.wb.airflow!.newDag(dir) }] : []),
          ...Object.values(this.wb.plugins).flatMap((p) => p?.newItems?.(dir) ?? []),
        ],
      },
      { separator: true },
      { label: "Recortar", icon: "general/cut", disabled: n === this.root, action: () => (clip = { path: n.path, cut: true }) },
      { label: "Copiar", icon: "general/copy", action: () => (clip = { path: n.path, cut: false }) },
      { label: "Copiar caminho", shortcut: "Ctrl+Shift+C", action: () => navigator.clipboard.writeText(P.win(n.path)) },
      { label: "Copiar caminho relativo", action: () => navigator.clipboard.writeText(P.rel(this.wb.root, n.path)) },
      { label: "Colar", icon: "general/paste", disabled: !clip, action: () => this.paste(dir) },
      { separator: true },
      { label: "Renomear…", shortcut: "Shift+F6", disabled: n === this.root, action: () => this.startRename(n) },
      { label: "Excluir…", icon: "general/delete", shortcut: "Delete", disabled: n === this.root, action: () => this.delete(n) },
      { separator: true },
    ];
    const ik = n.dir ? null : infraKind(n.path, /\.ya?ml$/i.test(n.name) ? this.infraText.get(n.path.toLowerCase()) : undefined);
    if (ik) items.push({ label: INFRA_LABEL[ik], icon: INFRA_ICON[ik], submenu: infraActions(this.wb, n.path, ik) }, { separator: true });
    if (target) {
      items.push(
        { label: `Executar ${target.label}`, icon: "run/run", shortcut: "Ctrl+Shift+F10", action: () => this.wb.runner.runTarget(target, false) },
        { label: `Depurar ${target.label}`, icon: "run/debug", action: () => this.wb.runner.runTarget(target, true) },
        { separator: true },
      );
    }
    if (n.dir) {
      const hasTests = /tests?$/i.test(n.name) || n === this.root;
      if (hasTests) items.push({ label: "Executar testes aqui", icon: "run/testPassed", action: () => this.wb.runner.runTestsIn(n.path) }, { separator: true });
    }
    items.push(
      { label: REVEAL_LABEL, icon: "general/open", action: () => host.reveal(n.path) },
      { label: "Abrir no Terminal", icon: "toolwindows/terminal", action: () => this.wb.terminals.newTab(dir) },
      { separator: true },
      {
        label: "Git",
        icon: "branch",
        disabled: !this.wb.git.isRepo,
        submenu: [
          { label: "Adicionar ao VCS", icon: "general/add", action: () => this.wb.git.add([n.path]) },
          { label: "Comparar com HEAD", icon: "vcs/diff", disabled: n.dir, action: () => this.wb.git.showDiff(n.path) },
          { label: "Reverter alterações…", icon: "vcs/revert", action: () => this.wb.git.rollback([n.path]) },
          { label: "Histórico do arquivo", icon: "general/history", action: () => this.wb.git.showLog(n.path) },
          { label: "Adicionar ao .gitignore", action: () => this.addToGitignore(n) },
        ],
      },
      { separator: true },
      { label: "Recarregar do disco", icon: "general/refresh", action: () => this.refresh() },
    );
    return items;
  }

  /** First lines of YAML files, read when the context menu opens, to recognize Kubernetes manifests. */
  private infraText = new Map<string, string>();

  private async createInfra(t: InfraTemplate, dir: string) {
    const files = t.files(dir);
    for (const f of files) {
      if (await host.exists(f.path)) {
        toast(`${P.base(f.path)} já existe — não foi sobrescrito.`, "info");
        continue;
      }
      if (!(await host.exists(P.dir(f.path)))) await host.create(P.dir(f.path), true).catch(() => {});
      await this.createFile(f.path, f.content);
    }
  }

  newFileAt(dir: string | null) {
    this.newEntry(dir ?? (this.selected ? (this.selected.dir ? this.selected.path : P.dir(this.selected.path)) : this.wb.root), "file");
  }

  private newEntry(dir: string, kind: "file" | "dir" | "python" | "package" | "go" | "md") {
    const titles = { file: "Novo arquivo", dir: "Novo diretório", python: "Novo arquivo Python", package: "Novo pacote Python", go: "Novo arquivo Go", md: "Novo arquivo Markdown" };
    const m = modal(titles[kind], { width: 400 });
    const input = h("input.input", { spellcheck: false, placeholder: kind === "dir" ? "pasta ou pasta/subpasta" : kind === "go" ? "main.go" : kind === "python" ? "nome (sem .py)" : "nome" }) as HTMLInputElement;
    m.body.append(input);
    const submit = async () => {
      let name = input.value.trim();
      if (!name) return;
      m.close();
      if (kind === "dir") return this.createDir(P.join(dir, name));
      if (kind === "package") {
        await this.createDir(P.join(dir, name));
        return this.createFile(P.join(dir, name, "__init__.py"), "");
      }
      if (kind === "python" && !name.endsWith(".py")) name += ".py";
      if (kind === "go" && !name.endsWith(".go")) name += ".go";
      if (kind === "md" && !name.endsWith(".md")) name += ".md";
      let content = "";
      if (kind === "go") content = `package ${await this.goPackageFor(dir)}\n\n`;
      if (kind === "python" && /^test_/.test(P.base(name))) content = `def test_example():\n    assert True\n`;
      this.createFile(P.join(dir, name), content);
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
    m.footer.append(button("Cancelar", () => m.close()), button("OK", submit, "primary"));
    setTimeout(() => input.focus());
  }

  private async goPackageFor(dir: string) {
    try {
      const files = (await host.list(dir)).filter((e) => e.name.endsWith(".go"));
      for (const f of files) {
        const t = await host.read(f.path);
        const m = /^package\s+(\w+)/m.exec(t.text);
        if (m) return m[1].replace(/_test$/, "");
      }
    } catch {
      /* new dir */
    }
    return P.same(dir, this.wb.root) ? "main" : P.base(dir).replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();
  }

  private async createDir(path: string) {
    try {
      await host.create(path, true);
      await this.reveal(path);
    } catch (e) {
      toast(String(e), "error");
    }
  }

  private async createFile(path: string, content: string) {
    try {
      if (await host.exists(path)) return toast(`${P.base(path)} já existe`, "error");
      await host.write(path, content);
      await this.reveal(path);
      const ed = await this.wb.editors.openFile(path);
      if (ed && content) ed.reveal(ed.view.state.doc.lines, 1, false);
      if (this.wb.git.isRepo) this.wb.git.askAdd(path);
    } catch (e) {
      toast(String(e), "error");
    }
  }

  private startRename(n: Node) {
    const input = h("input.tree-rename", { value: n.name, spellcheck: false }) as HTMLInputElement;
    this.renameEl = { node: n, input };
    let done = false;
    const finish = async (ok: boolean) => {
      if (done) return;
      done = true;
      this.renameEl = null;
      const name = input.value.trim();
      if (ok && name && name !== n.name) {
        const to = P.join(P.dir(n.path), name);
        try {
          await this.wb.editors.saveAll();
          await host.rename(n.path, to);
          await this.wb.editors.renamed(n.path, to);
          if (n.parent) await this.load(n.parent);
          this.selected = null;
          await this.reveal(to);
        } catch (e) {
          toast(String(e), "error");
        }
      }
      this.render();
      this.el.focus();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    this.render();
    const dot = n.dir ? -1 : n.name.lastIndexOf(".");
    setTimeout(() => input.setSelectionRange(0, dot > 0 ? dot : n.name.length));
  }

  private async delete(n: Node) {
    const ok = await confirmDialog("Excluir", `Mover "${n.name}"${n.dir ? " e todo o conteúdo" : ""} para a Lixeira?`, "Excluir", true);
    if (!ok) return;
    try {
      this.wb.editors.closeDeleted([n.path]);
      await host.remove([n.path]);
      if (n.parent) await this.load(n.parent);
      this.render();
    } catch (e) {
      toast(String(e), "error");
    }
  }

  private async move(src: string, destDir: string) {
    if (P.same(P.dir(src), destDir) || P.inside(src, destDir)) return;
    const to = P.join(destDir, P.base(src));
    try {
      await this.wb.editors.saveAll();
      await host.rename(src, to);
      await this.wb.editors.renamed(src, to);
      await this.refresh();
    } catch (e) {
      toast(String(e), "error");
    }
  }

  private async paste(dir: string) {
    if (!clip) return;
    try {
      if (clip.cut) {
        await this.move(clip.path, dir);
        clip = null;
      } else {
        const np = await host.copy(clip.path, dir);
        await this.reveal(np);
      }
    } catch (e) {
      toast(String(e), "error");
    }
  }

  private async addToGitignore(n: Node) {
    const gi = P.join(this.wb.root, ".gitignore");
    const cur = (await host.exists(gi)) ? (await host.read(gi)).text : "";
    const line = "/" + P.rel(this.wb.root, n.path) + (n.dir ? "/" : "");
    await host.write(gi, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n");
    toast(`${line} adicionado ao .gitignore`, "ok");
  }
}

let clip: { path: string; cut: boolean } | null = null;

export function defaultGitignore() {
  return [
    "# Python", "__pycache__/", "*.py[cod]", ".venv/", "venv/", ".pytest_cache/", ".ruff_cache/", ".mypy_cache/", "*.egg-info/", "dist/", "build/", "",
    "# Go", "*.exe", "*.test", "*.out", "/bin/", "",
    "# IDE", ".idea/", ".vscode/", ".DS_Store", "",
  ].join("\n");
}
