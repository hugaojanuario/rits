// Git integration: VCS widget/branches popup, Commit and Git (log) tool windows, diffs.
import { MergeView } from "@codemirror/merge";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { h } from "../util";
import { icon, fileIconName } from "../icons";
import { button, confirmDialog, contextMenu, modal, notify, popupList, promptDialog, toast, type PopupItem } from "../ui";
import { host, P } from "./host";
import { islandsTheme, langExtensions, langFor } from "./lang";
import { runBackground } from "./sdk";
import type { Workbench } from "./workbench";
import type { Tab } from "../tabs";

export type FileStatus = "modified" | "added" | "untracked" | "deleted" | "conflict" | "renamed";

interface Change {
  path: string;
  status: FileStatus;
  staged: boolean;
  orig?: string;
}

export class Git {
  isRepo: boolean | null = null;
  repoRoot = "";
  branch: string | null = null;
  upstream: string | null = null;
  ahead = 0;
  behind = 0;
  private changes: Change[] = [];
  private status = new Map<string, FileStatus>();
  private refreshTimer: number | undefined;
  private commitBody = h("div.commit-wrap");
  private logBody = h("div.git-log");
  private checked = new Set<string>();
  private msgInput = h("textarea.textarea", { placeholder: "Mensagem do commit", spellcheck: false }) as HTMLTextAreaElement;
  private amend = h("input", { type: "checkbox" }) as HTMLInputElement;

  constructor(private wb: Workbench) {
    wb.register({ id: "commit", title: "Commit", icon: "commit", anchor: "left", shortcut: "Alt+0", body: h("div.tw-body", null, this.commitBody), onShow: () => this.refresh(), actions: () => [
      h("button.icon-btn", { title: "Atualizar", onclick: () => this.refresh() }, icon("general/refresh")),
      h("button.icon-btn", { title: "Reverter selecionados", onclick: () => this.rollback([...this.checked]) }, icon("vcs/revert")),
      h("button.icon-btn", { title: "Mostrar diff", onclick: () => this.checked.size && this.showDiff([...this.checked][0]) }, icon("vcs/diff")),
    ] });
    wb.register({ id: "git", title: "Git", icon: "vcs", anchor: "bottom", shortcut: "Alt+9", body: h("div.tw-body", null, this.logBody), onShow: () => this.renderLog() });
    this.refresh();
  }

  private async git(args: string[], cwd = this.repoRoot || this.wb.root, input?: string) {
    return host.capture("git", ["-c", "core.quotepath=false", "-c", "color.ui=false", ...args], cwd, input, 60);
  }

  onFsChange(paths: string[]) {
    if (!paths.length) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refresh(), 600);
  }

  async refresh() {
    const top = await this.git(["rev-parse", "--show-toplevel"], this.wb.root).catch(() => null);
    if (!top || top.code !== 0) {
      const changed = this.isRepo !== false;
      this.isRepo = false;
      this.branch = null;
      this.status.clear();
      this.changes = [];
      if (changed) {
        this.wb.renderVcsWidget();
        this.renderCommit();
      }
      return;
    }
    this.isRepo = true;
    this.repoRoot = P.norm(top.stdout.trim());
    const st = await this.git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    const prevBranch = this.branch;
    const prevStatus = [...this.status.entries()].join("|");
    this.parseStatus(st.stdout);
    if (prevBranch !== this.branch) this.wb.renderVcsWidget();
    if (prevStatus !== [...this.status.entries()].join("|")) {
      this.wb.projectView?.render();
      this.wb.editors?.refreshTabStates();
      if (prevBranch !== this.branch) this.wb.editors?.refreshVcs();
    }
    this.renderCommit();
  }

  private parseStatus(out: string) {
    this.status.clear();
    this.changes = [];
    const recs = out.split("\0");
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (!r) continue;
      if (r.startsWith("# branch.head ")) this.branch = r.slice(14) === "(detached)" ? "HEAD destacado" : r.slice(14);
      else if (r.startsWith("# branch.upstream ")) this.upstream = r.slice(18);
      else if (r.startsWith("# branch.ab ")) {
        const m = /\+(\d+) -(\d+)/.exec(r);
        if (m) [this.ahead, this.behind] = [Number(m[1]), Number(m[2])];
      } else if (r[0] === "1" || r[0] === "2") {
        const parts = r.split(" ");
        const xy = parts[1];
        const path = r[0] === "1" ? parts.slice(8).join(" ") : parts.slice(9).join(" ");
        const orig = r[0] === "2" ? recs[++i] : undefined;
        let s: FileStatus = "modified";
        if (xy.includes("A")) s = "added";
        else if (xy.includes("D")) s = "deleted";
        else if (r[0] === "2") s = "renamed";
        this.addChange({ path: P.join(this.repoRoot, path), status: s, staged: xy[0] !== ".", orig });
      } else if (r[0] === "u") {
        const path = r.split(" ").slice(10).join(" ");
        this.addChange({ path: P.join(this.repoRoot, path), status: "conflict", staged: false });
      } else if (r[0] === "?") {
        this.addChange({ path: P.join(this.repoRoot, r.slice(2)), status: "untracked", staged: false });
      }
    }
  }

  private addChange(c: Change) {
    this.changes.push(c);
    this.status.set(c.path.toLowerCase(), c.status);
  }

  statusOf(path: string, dir = false): FileStatus | null {
    const k = P.norm(path).toLowerCase();
    const s = this.status.get(k);
    if (s || !dir) return s ?? null;
    for (const [p, st] of this.status) if (p.startsWith(k + "/") && st !== "untracked") return "modified";
    return null;
  }

  async headContent(path: string): Promise<string | null> {
    if (!this.isRepo) return null;
    const rel = P.rel(this.repoRoot, path);
    const r = await this.git(["show", `HEAD:${rel}`]).catch(() => null);
    return r && r.code === 0 ? r.stdout.replace(/\r\n/g, "\n") : null;
  }

  // ---------------- widget / popup ----------------
  async branchesPopup(anchor: HTMLElement) {
    if (!this.isRepo) {
      popupList(anchor, [
        { label: "Criar repositório Git…", icon: "general/add", action: () => this.init() },
        { label: "Clonar repositório…", icon: "vcs/fetch", action: () => import("./welcome").then((m) => m.openCloneDialog(this.wb)) },
      ], { width: 320 });
      return;
    }
    const [loc, rem] = await Promise.all([
      this.git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)", "refs/heads"]),
      this.git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/remotes"]),
    ]);
    const locals = loc.stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split("\t"));
    const remotes = rem.stdout.trim().split(/\r?\n/).filter((x) => x && !x.endsWith("/HEAD"));
    const items: PopupItem[] = [
      { label: "Atualizar projeto…", icon: "vcs/update", right: "Ctrl+T", action: () => this.pull() },
      { label: "Commit…", icon: "vcs/commit", right: "Ctrl+K", action: () => this.wb.show("commit", true) },
      { label: "Push…", icon: "vcs/push", right: "Ctrl+Shift+K", action: () => this.push() },
      { label: "Novo branch…", icon: "general/add", action: () => this.newBranch() },
      { label: "Fazer checkout de tag ou revisão…", action: () => this.checkoutRev() },
    ];
    locals.forEach(([name, up, track], i) =>
      items.push({
        section: i === 0 ? "Local" : undefined,
        separatorBefore: i === 0,
        label: name,
        icon: name === this.branch ? "gutter/bookmark" : "branch",
        current: name === this.branch,
        right: [track?.replace(/[[\]]/g, "").replace("ahead ", "↑").replace("behind ", "↓"), up].filter(Boolean).join("  "),
        children: () => [
          ...(name !== this.branch ? [{ label: "Checkout", action: () => this.checkout(name) }] : []),
          { label: `Novo branch a partir de '${name}'…`, action: () => this.newBranch(name) },
          ...(name !== this.branch ? [{ label: `Merge de '${name}' em '${this.branch}'`, action: () => this.merge(name) }] : []),
          { label: "Push…", action: () => this.push(name) },
          { label: "Renomear…", action: () => this.renameBranch(name) },
          ...(name !== this.branch ? [{ label: "Excluir", action: () => this.deleteBranch(name) }] : []),
        ],
      }),
    );
    remotes.forEach((r, i) =>
      items.push({
        section: i === 0 ? "Remoto" : undefined,
        separatorBefore: i === 0,
        label: r,
        icon: "branch",
        children: () => [
          { label: "Checkout", action: () => this.checkoutRemote(r) },
          { label: `Merge de '${r}' em '${this.branch}'`, action: () => this.merge(r) },
        ],
      }),
    );
    popupList(anchor, items, { width: 400, placeholder: "Buscar branches e ações" });
  }

  private async run(title: string, args: string[], ok?: string) {
    const t = await runBackground(title, "git", ["-c", "color.ui=false", ...args], this.repoRoot || this.wb.root, { GIT_TERMINAL_PROMPT: "0" });
    await this.refresh();
    if (t.code === 0) {
      if (ok) notify(ok, t.output.trim().split("\n").slice(-2).join("\n"), "ok", [], 4000);
      return true;
    }
    notify(`${title} falhou`, t.output.trim().split("\n").slice(-6).join("\n"), "error", [], 12000);
    return false;
  }

  async checkout(name: string) {
    await this.wb.editors.saveAll();
    if (await this.run(`Checkout de ${name}`, ["checkout", name], `Checkout de '${name}' concluído`)) this.wb.editors.refreshVcs();
  }

  async checkoutRemote(remote: string) {
    const local = remote.replace(/^[^/]+\//, "");
    await this.run(`Checkout de ${remote}`, ["checkout", "-b", local, "--track", remote], `Branch '${local}' criado a partir de '${remote}'`);
  }

  async checkoutRev() {
    const rev = await promptDialog("Checkout", "Tag, hash ou referência");
    if (rev) await this.run(`Checkout de ${rev}`, ["checkout", rev], `Checkout de '${rev}' concluído`);
  }

  async newBranch(from?: string) {
    const m = modal("Criar novo branch", { width: 440 });
    const name = h("input.input", { spellcheck: false, placeholder: "feature/minha-tarefa" }) as HTMLInputElement;
    const co = h("input", { type: "checkbox", checked: true }) as HTMLInputElement;
    m.body.append(h("label.field", null, h("span", null, "Nome do branch"), name), h("label.check", { style: "margin-top:10px" }, co, "Fazer checkout do branch"));
    const go = async () => {
      const n = name.value.trim();
      if (!n) return;
      m.close();
      const args = co.checked ? ["checkout", "-b", n, ...(from ? [from] : [])] : ["branch", n, ...(from ? [from] : [])];
      await this.run(`Criar branch ${n}`, args, `Branch '${n}' criado`);
    };
    name.addEventListener("keydown", (e) => e.key === "Enter" && go());
    m.footer.append(button("Cancelar", () => m.close()), button("Criar", go, "primary"));
    setTimeout(() => name.focus());
  }

  private async renameBranch(old: string) {
    const n = await promptDialog("Renomear branch", "Novo nome", old);
    if (n && n !== old) await this.run("Renomear branch", ["branch", "-m", old, n], `Branch renomeado para '${n}'`);
  }

  private async deleteBranch(name: string) {
    if (await confirmDialog("Excluir branch", `Excluir o branch local '${name}'?`, "Excluir", true)) await this.run(`Excluir ${name}`, ["branch", "-d", name], `Branch '${name}' excluído`);
  }

  private async merge(name: string) {
    await this.wb.editors.saveAll();
    await this.run(`Merge de ${name}`, ["merge", "--no-edit", name], `Merge de '${name}' concluído`);
  }

  async pull() {
    if (!this.isRepo) return;
    await this.wb.editors.saveAll();
    await this.run("Atualizando projeto", ["pull", "--rebase", "--autostash"], "Projeto atualizado");
  }

  async fetch() {
    if (this.isRepo) await this.run("Fetch", ["fetch", "--all", "--prune"], "Fetch concluído");
  }

  async push(branch = this.branch ?? "") {
    if (!this.isRepo) return;
    const log = await this.git(["log", "--oneline", this.upstream ? `${this.upstream}..${branch}` : branch, "-n", "30"]);
    const commits = log.stdout.trim().split(/\r?\n/).filter(Boolean);
    const remotes = (await this.git(["remote"])).stdout.trim().split(/\r?\n/).filter(Boolean);
    if (!remotes.length) return toast("Nenhum remoto configurado. Use 'git remote add origin <url>' no terminal.", "error", 8000);
    const m = modal(`Push de commits para ${this.upstream ?? remotes[0] + "/" + branch}`, { width: 620 });
    m.body.append(
      commits.length
        ? h("div.list", { style: "max-height:300px;border:1px solid var(--border);border-radius:6px" }, ...commits.map((c) => h("div.list-row", null, icon("vcs/commit"), h("span.mono", { style: "color:var(--fg-faint)" }, c.slice(0, 7)), h("span", null, c.slice(8)))))
        : h("p.dim", null, "Nenhum commit novo — o branch será publicado."),
    );
    const force = h("input", { type: "checkbox" }) as HTMLInputElement;
    m.footer.append(h("label.check", { style: "margin-right:auto" }, force, "Force push (--force-with-lease)"), button("Cancelar", () => m.close()), button("Push", async () => {
      m.close();
      const args = ["push", ...(force.checked ? ["--force-with-lease"] : []), ...(this.upstream ? [] : ["-u", remotes[0], branch])];
      await this.run("Push", args, `Push de ${commits.length} commit(s) concluído`);
    }, "primary"));
  }

  async init() {
    if (await this.run("git init", ["init"], "Repositório Git criado")) {
      if (!(await host.exists(P.join(this.wb.root, ".gitignore")))) {
        const { defaultGitignore } = await import("./projectView");
        await host.write(P.join(this.wb.root, ".gitignore"), defaultGitignore());
      }
      await this.refresh();
      this.wb.renderVcsWidget();
    }
  }

  async add(paths: string[]) {
    await this.run("git add", ["add", "--", ...paths.map((p) => P.rel(this.repoRoot, p))]);
  }

  askAdd(path: string) {
    notify("Adicionar arquivo ao Git?", P.base(path), "info", [{ label: "Adicionar", run: () => this.add([path]) }], 6000);
  }

  async rollback(paths: string[]) {
    if (!paths.length) return;
    const tracked = paths.filter((p) => this.statusOf(p) !== "untracked");
    const untracked = paths.filter((p) => this.statusOf(p) === "untracked" || this.statusOf(p) === "added");
    const ok = await confirmDialog("Reverter alterações", `Reverter ${paths.length} arquivo(s) para a versão do HEAD? Alterações locais serão perdidas.${untracked.length ? `\n${untracked.length} arquivo(s) novo(s) serão apenas removidos do índice.` : ""}`, "Reverter", true);
    if (!ok) return;
    await this.wb.editors.saveAll();
    const rel = (ps: string[]) => ps.map((p) => P.rel(this.repoRoot, p));
    const added = paths.filter((p) => this.statusOf(p) === "added");
    if (added.length) await this.git(["reset", "-q", "--", ...rel(added)]);
    const restore = tracked.filter((p) => this.statusOf(p) !== "added");
    if (restore.length) await this.run("Reverter", ["checkout", "HEAD", "--", ...rel(restore)], "Alterações revertidas");
    for (const p of restore) this.wb.editors.get(p)?.reload(true);
    await this.refresh();
  }

  // ---------------- commit tool window ----------------
  private renderCommit() {
    if (!this.wb.isVisible("commit")) return;
    if (!this.isRepo) {
      this.commitBody.replaceChildren(
        h("div.empty-note", null, h("p", null, "Este projeto não está sob controle de versão."), h("button.btn.primary", { onclick: () => this.init() }, "Criar repositório Git")),
      );
      return;
    }
    const tracked = this.changes.filter((c) => c.status !== "untracked");
    const untracked = this.changes.filter((c) => c.status === "untracked");
    for (const c of this.changes) if (!this.knownPaths.has(c.path) && c.status !== "untracked") this.checked.add(c.path);
    this.knownPaths = new Set(this.changes.map((c) => c.path));
    for (const p of [...this.checked]) if (!this.knownPaths.has(p)) this.checked.delete(p);
    const group = (title: string, list: Change[]) => {
      if (!list.length) return [];
      const all = list.every((c) => this.checked.has(c.path));
      const box = h("input", { type: "checkbox", checked: all }) as HTMLInputElement;
      box.onchange = () => {
        list.forEach((c) => (box.checked ? this.checked.add(c.path) : this.checked.delete(c.path)));
        this.renderCommit();
      };
      return [
        h("div.tree-row", { style: "padding-left:10px" }, box, icon(title === "Alterações" ? "vcs/changelist" : "vcs/showUnversionedFiles"), h("span.tree-label", { style: "font-weight:600" }, title), h("span.tree-detail", null, `${list.length} arquivo(s)`)),
        ...list.map((c) => {
          const cb = h("input", { type: "checkbox", checked: this.checked.has(c.path) }) as HTMLInputElement;
          cb.onchange = () => (cb.checked ? this.checked.add(c.path) : this.checked.delete(c.path), this.updateCommitButtons());
          const row = h(
            "div.tree-row.change-row",
            { class: "vcs-" + (c.status === "renamed" ? "modified" : c.status), style: "padding-left:30px" },
            cb,
            icon(fileIconName(P.base(c.path))),
            h("span.tree-label", null, P.base(c.path)),
            h("span.ch-path", null, P.rel(this.wb.root, P.dir(c.path)) === P.norm(P.dir(c.path)) ? "" : P.rel(this.wb.root, P.dir(c.path))),
          );
          row.addEventListener("dblclick", () => (c.status === "deleted" ? undefined : this.showDiff(c.path)));
          row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            contextMenu(e.clientX, e.clientY, [
              { label: "Mostrar diff", icon: "vcs/diff", shortcut: "Ctrl+D", action: () => this.showDiff(c.path) },
              { label: "Abrir arquivo", icon: "general/open", disabled: c.status === "deleted", action: () => this.wb.editors.openFile(c.path) },
              { label: "Reverter…", icon: "vcs/revert", action: () => this.rollback([c.path]) },
              ...(c.status === "untracked" ? [{ label: "Adicionar ao VCS", icon: "general/add", action: () => this.add([c.path]) }] : []),
            ]);
          });
          return row;
        }),
      ];
    };
    const tree = h("div.commit-tree.tree", { tabIndex: 0 }, ...group("Alterações", tracked), ...group("Arquivos não versionados", untracked));
    if (!this.changes.length) tree.append(h("div.empty-note", null, "Nenhuma alteração"));
    this.commitBtn = h("button.btn.primary", { onclick: () => this.commit(false) }, "Commit") as HTMLButtonElement;
    this.commitPushBtn = h("button.btn", { onclick: () => this.commit(true) }, "Commit e Push…") as HTMLButtonElement;
    this.msgInput.onkeydown = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) this.commit(false);
    };
    this.commitBody.replaceChildren(
      tree,
      h(
        "div.commit-box",
        null,
        h("label.check", null, this.amend, "Corrigir (amend) o último commit"),
        this.msgInput,
        h("div.commit-actions", null, this.commitBtn, this.commitPushBtn, h("span.grow"), h("span.faint", null, `${this.branch ?? ""}${this.ahead ? ` ↑${this.ahead}` : ""}${this.behind ? ` ↓${this.behind}` : ""}`)),
      ),
    );
    this.amend.onchange = async () => {
      if (this.amend.checked && !this.msgInput.value) this.msgInput.value = (await this.git(["log", "-1", "--format=%B"])).stdout.trim();
    };
    this.updateCommitButtons();
  }
  private knownPaths = new Set<string>();
  private commitBtn: HTMLButtonElement | null = null;
  private commitPushBtn: HTMLButtonElement | null = null;

  private updateCommitButtons() {
    const n = this.checked.size;
    if (this.commitBtn) this.commitBtn.disabled = !n && !this.amend.checked;
    if (this.commitPushBtn) this.commitPushBtn.disabled = !n && !this.amend.checked;
  }

  private async commit(andPush: boolean) {
    const msg = this.msgInput.value.trim();
    if (!msg) return toast("Escreva uma mensagem de commit", "error");
    const files = [...this.checked].map((p) => P.rel(this.repoRoot, p));
    await this.wb.editors.saveAll();
    if (files.length) {
      const r = await this.git(["add", "-A", "--", ...files]);
      if (r.code !== 0) return notify("git add falhou", r.stderr, "error");
    }
    const r = await this.git(["commit", ...(this.amend.checked ? ["--amend"] : []), "-F", "-", "--", ...files], undefined, msg);
    if (r.code !== 0) return notify("Commit falhou", (r.stderr || r.stdout).trim(), "error", [], 12000);
    this.msgInput.value = "";
    this.amend.checked = false;
    this.checked.clear();
    notify(`${files.length} arquivo(s) commitado(s)`, msg.split("\n")[0], "ok", [], 4000);
    await this.refresh();
    this.wb.editors.refreshVcs();
    if (andPush) this.push();
  }

  // ---------------- diff ----------------
  async showDiff(path: string) {
    const head = (await this.headContent(path)) ?? "";
    const cur = (await host.read(path).catch(() => ({ text: "" }))).text;
    const hostEl = h("div.diff-host");
    const el = h(
      "div.code-pane",
      null,
      h("div.toolbar", null, icon("vcs/diff"), h("span", { style: "margin-left:6px" }, `HEAD ↔ Cópia local`), h("span.grow"), h("button.tool-btn.text", { onclick: () => this.wb.editors.openFile(path) }, icon("general/open"), "Abrir arquivo"), h("button.tool-btn.text", { onclick: () => this.rollback([path]).then(() => this.wb.tabs.close(tab)) }, icon("vcs/revert"), "Reverter")),
      hostEl,
    );
    const lang = langFor(path);
    const ext = [lineNumbers(), ...langExtensions(lang), islandsTheme, EditorView.editable.of(false), EditorState.readOnly.of(true)];
    const mv = new MergeView({ a: { doc: head, extensions: ext }, b: { doc: cur, extensions: ext }, parent: hostEl, collapseUnchanged: { margin: 3, minSize: 6 }, gutter: true });
    const tab: Tab = { id: "diff:" + path.toLowerCase(), title: `${P.base(path)} (diff)`, icon: "vcs/diff", el, onClose: () => mv.destroy() };
    this.wb.tabs.open(tab);
  }

  // ---------------- log ----------------
  async showLog(path?: string) {
    this.logPath = path ?? null;
    this.wb.show("git");
  }
  private logPath: string | null = null;

  private async renderLog() {
    if (!this.isRepo) {
      this.logBody.replaceChildren(h("div.empty-note", null, "Sem repositório Git."));
      return;
    }
    const args = ["log", "--all", "--date=format:%d/%m/%Y %H:%M", "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%D", "-n", "400"];
    if (this.logPath) args.push("--", P.rel(this.repoRoot, this.logPath));
    const r = await this.git(args);
    const rows = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.split("\x1f"));
    const detail = h("div.git-detail", null, h("div.faint", null, "Selecione um commit"));
    const filter = h("input.input", { placeholder: "Filtrar por texto, autor ou hash", spellcheck: false, style: "height:26px" }) as HTMLInputElement;
    const list = h("div.git-log-list");
    let selected = "";
    const draw = () => {
      const q = filter.value.toLowerCase();
      list.replaceChildren(
        ...rows
          .filter((x) => !q || x.join(" ").toLowerCase().includes(q))
          .map(([hash, short, author, date, subject, refs]) => {
            const row = h(
              "div.log-row",
              { class: hash === selected ? "selected" : "" },
              h("span.log-dot"),
              h("span", null, ...(refs ? refs.split(", ").filter((x) => x && !x.startsWith("tag:") || x).map((ref) => h("span.ref-label", { class: ref.startsWith("HEAD") ? "head" : "" }, ref.replace("HEAD -> ", ""))) : []), subject),
              h("span.faint", null, author),
              h("span.faint", null, date),
              h("span.mono.faint", null, short),
            );
            row.onclick = async () => {
              selected = hash;
              list.querySelectorAll(".log-row.selected").forEach((x) => x.classList.remove("selected"));
              row.classList.add("selected");
              const s = await this.git(["show", "--stat", "--format=%H%n%an <%ae>%n%ad%n%n%B", "--date=format:%d/%m/%Y %H:%M", hash]);
              const [full, auth, when, , ...rest] = s.stdout.split("\n");
              const body = rest.join("\n");
              const statStart = body.search(/\n [^\n]+\|/);
              detail.replaceChildren(
                h("div", { style: "font-weight:600;white-space:pre-wrap;margin-bottom:8px" }, statStart > 0 ? body.slice(0, statStart).trim() : body.trim()),
                h("div.faint", null, `${auth}`),
                h("div.faint", null, `${when}  ·  ${full.slice(0, 10)}`),
                h("pre.mono", { style: "font-size:12px;white-space:pre-wrap;margin-top:12px" }, statStart > 0 ? body.slice(statStart).trim() : ""),
                h("div", { style: "margin-top:8px;display:flex;gap:8px" }, h("button.btn", { onclick: () => navigator.clipboard.writeText(full) }, "Copiar hash"), h("button.btn", { onclick: () => this.run(`Checkout ${short}`, ["checkout", hash]) }, "Checkout")),
              );
            };
            return row;
          }),
      );
    };
    filter.oninput = draw;
    draw();
    this.logBody.replaceChildren(
      h("div", { style: "flex:1;min-width:0;display:flex;flex-direction:column" }, h("div.pane-toolbar", { style: "display:flex;gap:8px;align-items:center" }, filter, this.logPath ? h("span.tag", null, P.base(this.logPath), h("button.link", { onclick: () => ((this.logPath = null), this.renderLog()) }, "×")) : null, h("button.icon-btn", { title: "Atualizar", onclick: () => this.renderLog() }, icon("general/refresh"))), list),
      detail,
    );
  }
}

/** Clones a repository with progress; resolves with the destination path or null. */
export async function cloneRepo(url: string, dest: string, onProgress: (line: string) => void): Promise<boolean> {
  const t = await runBackground(`Clonando ${url}`, "git", ["clone", "--progress", url, P.win(dest)], P.dir(dest), { GIT_TERMINAL_PROMPT: "0" }, (chunk) => {
    const last = chunk.split(/[\r\n]+/).filter(Boolean).pop();
    if (last) onProgress(last);
  });
  if (t.code !== 0) onProgress(t.output.trim().split(/\r?\n/).slice(-3).join("\n"));
  return t.code === 0;
}
