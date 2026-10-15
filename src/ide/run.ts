// Run configurations, the main-toolbar run widget and the "Run" tool window.
import { h, uid } from "../util";
import { icon } from "../icons";
import { button, modal, popupList, toast, type PopupItem } from "../ui";
import { host, INSTALL, IS_WIN, on, P, type ProcExit, type ProcOut } from "./host";
import { findGo, scriptsDir } from "./sdk";
import type { RunConfig } from "./project";
import type { RunTarget } from "./editors";
import type { Workbench } from "./workbench";

export interface Command {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

interface Session {
  id: string;
  config: RunConfig;
  procId: string;
  running: boolean;
  start: number;
  console: HTMLElement;
  input: HTMLInputElement;
  exitCode: number | null;
}

const KIND_ICON: Record<RunConfig["kind"], string> = { python: "python/python", pytest: "python/pythonTests", go: "goFile", gotest: "run/testPassed", shell: "fileTypes/shell" };

export function parseEnv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(/[;\n]/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) {
      if (cur) out.push(cur), (cur = "");
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export class Runner {
  private sessions: Session[] = [];
  private active: Session | null = null;
  private tabsEl = h("div.tw-tabs");
  private body = h("div.run-wrap");
  constructor(private wb: Workbench) {
    wb.register({ id: "run", title: "Run", icon: "run", anchor: "bottom", shortcut: "Alt+4", body: h("div.tw-body", null, this.body), headerTabs: this.tabsEl });
    if (!wb.settings.runConfigs) wb.settings.runConfigs = [];
    this.renderWidget();
    this.renderBody();
  }

  get configs(): RunConfig[] {
    return this.wb.settings.runConfigs!;
  }

  selected(): RunConfig | null {
    return this.configs.find((c) => c.id === this.wb.settings.selectedRunConfig) ?? this.configs[0] ?? null;
  }

  // ---------------- widget ----------------
  renderWidget() {
    const cfg = this.selected();
    const running = this.sessions.some((s) => s.running);
    const w = this.wb.runWidget;
    const cfgBtn = h(
      "button.tb-btn.config",
      { class: running ? "running" : "", title: "Configurações de execução" },
      cfg ? icon(KIND_ICON[cfg.kind]) : icon("run/run"),
      h("span.tb-label", null, cfg ? cfg.name : "Configurações de execução"),
      icon("general/chevronDown"),
    );
    cfgBtn.onclick = () => this.configPopup(cfgBtn);
    w.replaceChildren(
      cfgBtn,
      h("button.tb-btn", { title: cfg ? `Executar '${cfg.name}' (Shift+F10)` : "Executar arquivo atual", onclick: () => this.runSelected(false) }, icon(running ? "run/rerun" : "run/run")),
      h("button.tb-btn", { title: cfg ? `Depurar '${cfg.name}' (Shift+F9)` : "Depurar", onclick: () => this.runSelected(true) }, icon("run/debug")),
      running || this.wb.debugger?.active ? h("button.tb-btn", { title: "Parar (Ctrl+F2)", onclick: () => this.stopAll() }, icon("run/stop")) : "",
    );
  }

  private configPopup(anchor: HTMLElement) {
    const items: PopupItem[] = this.configs.map((c, i) => ({
      section: i === 0 ? "Configurações" : undefined,
      label: c.name + (c.temporary ? "" : ""),
      icon: KIND_ICON[c.kind],
      current: c.id === this.selected()?.id,
      sub: c.temporary ? "temporária" : undefined,
      children: () => [
        { label: "Executar", icon: "run/run", action: () => this.run(c, false) },
        { label: "Depurar", icon: "run/debug", action: () => this.run(c, true) },
        { label: "Selecionar", action: () => this.select(c) },
        ...(c.temporary ? [{ label: "Salvar configuração", icon: "general/save", action: () => ((c.temporary = false), this.save()) }] : []),
        { label: "Editar…", icon: "general/edit", action: () => this.editConfigs(c.id) },
        { label: "Excluir", icon: "general/delete", action: () => this.removeConfig(c) },
      ],
    }));
    const cur = this.fileTarget(this.wb.editors.active()?.path ?? "");
    if (cur) items.push({ label: `Executar ${cur.label}`, icon: "run/run", separatorBefore: true, right: "Ctrl+Shift+F10", action: () => this.runTarget(cur, false) });
    items.push({ label: "Editar configurações…", icon: "general/edit", separatorBefore: !cur, action: () => this.editConfigs() });
    popupList(anchor, items, { width: 360, search: this.configs.length > 7 });
  }

  private select(c: RunConfig) {
    this.wb.settings.selectedRunConfig = c.id;
    this.save();
  }

  private save() {
    this.wb.saveSettings();
    this.renderWidget();
  }

  private removeConfig(c: RunConfig) {
    this.wb.settings.runConfigs = this.configs.filter((x) => x !== c);
    this.save();
  }

  // ---------------- targets ----------------
  fileTarget(path: string): RunTarget | null {
    if (!path) return null;
    const name = P.base(path);
    const ext = P.ext(path);
    if (ext === "py") return /^test_|_test\.py$/.test(name) ? { kind: "pytest", path, label: `pytest em ${name}` } : { kind: "python", path, label: `'${name}'` };
    if (ext === "go") return name.endsWith("_test.go") ? { kind: "gotest", path, label: `go test ${P.base(P.dir(path))}` } : { kind: "go", path, label: `go build ${P.base(P.dir(path))}` };
    return null;
  }

  private configFor(t: RunTarget): RunConfig {
    const rel = P.rel(this.wb.root, t.path);
    const name =
      t.kind === "python" ? P.base(t.path).replace(/\.py$/, "") : t.kind === "pytest" ? `pytest ${t.filter ?? P.base(t.path)}` : t.kind === "go" ? `go build ${P.base(P.dir(t.path))}` : `go test ${t.filter ?? P.base(P.dir(t.path))}`;
    let c = this.configs.find((x) => x.kind === t.kind && P.same(x.target, rel) && (x.filter ?? "") === (t.filter ?? ""));
    if (!c) {
      c = { id: uid(), name, kind: t.kind, target: rel, args: "", cwd: "", env: "", filter: t.filter, temporary: true };
      // keep at most 5 temporary configs, like JetBrains
      const temps = this.configs.filter((x) => x.temporary);
      if (temps.length >= 5) this.wb.settings.runConfigs = this.configs.filter((x) => x !== temps[0]);
      this.configs.push(c);
    }
    this.wb.settings.selectedRunConfig = c.id;
    this.save();
    return c;
  }

  runTarget(t: RunTarget, debug: boolean) {
    return this.run(this.configFor(t), debug);
  }

  async runSelected(debug: boolean) {
    const c = this.selected();
    if (c) return this.run(c, debug);
    return this.runCurrentFile(debug);
  }

  async runCurrentFile(debug: boolean) {
    const ed = this.wb.editors.active();
    const t = ed ? this.fileTarget(ed.path) : null;
    if (!t) return toast("Abra um arquivo Python ou Go para executar.", "info");
    return this.runTarget(t, debug);
  }

  async runTestsIn(dir: string) {
    const hasGo = (await host.list(dir).catch(() => [])).some((e) => e.name.endsWith(".go"));
    const rel = P.rel(this.wb.root, dir);
    const kind = hasGo ? "gotest" : "pytest";
    const c: RunConfig = { id: uid(), name: `${kind === "gotest" ? "go test" : "pytest"} em ${P.base(dir)}`, kind, target: P.same(dir, this.wb.root) ? "." : rel, args: "", cwd: "", env: "", temporary: true };
    this.configs.push(c);
    this.select(c);
    this.run(c, false);
  }

  /** Resolves a config into the concrete command line. */
  async command(c: RunConfig): Promise<Command> {
    const root = this.wb.root;
    const abs = P.same(c.target, ".") ? root : P.isAbs(c.target) ? P.norm(c.target) : P.join(root, c.target);
    const env = parseEnv(c.env);
    const cwd = c.cwd ? (P.isAbs(c.cwd) ? c.cwd : P.join(root, c.cwd)) : root;
    const args = splitArgs(c.args);
    const py = this.wb.python?.path;
    if ((c.kind === "python" || c.kind === "pytest") && !py) throw new Error("Nenhum interpretador Python configurado. Configure em Configurações › Python.");
    if (py) env.RITS_PATH_PREPEND = [scriptsDir(py), P.dir(py)].map(P.win).join(";");
    switch (c.kind) {
      case "python":
        return { program: py!, args: ["-X", "utf8", P.win(abs), ...args], cwd, env };
      case "pytest": {
        const target = P.win(abs) + (c.filter ? "::" + c.filter : "");
        return { program: py!, args: ["-m", "pytest", "-v", "--color=yes", target, ...args], cwd, env };
      }
      case "go":
      case "gotest": {
        const go = await findGo();
        if (!go) throw new Error(`Go SDK não encontrado. Instale o Go (${INSTALL.go}) e reinicie.`);
        const pkgDir = (await host.list(abs).then(() => abs).catch(() => P.dir(abs))) as string;
        let rel = "./" + P.rel(root, pkgDir);
        if (P.same(pkgDir, root)) rel = ".";
        if (c.kind === "go") return { program: go.path, args: ["run", rel, ...args], cwd, env };
        return { program: go.path, args: ["test", "-v", ...(c.filter ? ["-run", `^${c.filter}$`] : []), rel === "." ? "./..." : rel, ...args], cwd, env };
      }
      case "shell":
        if (!IS_WIN) return { program: "/bin/sh", args: ["-c", c.target + " " + c.args], cwd, env };
        return { program: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-Command", c.target + " " + c.args], cwd, env };
    }
  }

  // ---------------- execution ----------------
  async run(c: RunConfig, debug: boolean) {
    await this.wb.editors.saveAll();
    if (debug) return this.wb.debugger.start(c);
    let cmd: Command;
    try {
      cmd = await this.command(c);
    } catch (e) {
      return toast(String((e as Error).message ?? e), "error", 8000);
    }
    // Rerun replaces a finished/running session of the same config.
    const prev = this.sessions.find((s) => s.config.id === c.id);
    if (prev) {
      if (prev.running) await host.kill(prev.procId);
      this.sessions = this.sessions.filter((s) => s !== prev);
    }
    const s = this.newSession(c);
    this.sessions.push(s);
    this.active = s;
    this.wb.show("run");
    this.renderBody();
    this.append(s, `${P.win(cmd.program)} ${cmd.args.join(" ")}\n`, "sys-text");
    const offOut = on<ProcOut>("proc-out", s.procId, (e) => this.append(s, e.data, e.stream === "stderr" ? "err-text" : ""));
    const offExit = on<ProcExit>("proc-exit", s.procId, (e) => {
      offOut();
      offExit();
      s.running = false;
      s.exitCode = e.code;
      this.append(s, `\nProcesso finalizado com código de saída ${e.code ?? "?"} (${((Date.now() - s.start) / 1000).toFixed(1)} s)\n`, "sys-text");
      this.renderTabs();
      this.renderWidget();
      if (c.kind === "pytest" || c.kind === "gotest") {
        const txt = s.console.textContent ?? "";
        const passed = /(\d+) passed/.exec(txt)?.[1] ?? (txt.match(/^--- PASS/gm)?.length ?? 0);
        const failed = /(\d+) failed/.exec(txt)?.[1] ?? (txt.match(/^--- FAIL/gm)?.length ?? 0);
        toast(`Testes: ${passed} passaram, ${failed} falharam`, Number(failed) ? "error" : "ok", 5000);
      }
    });
    try {
      await host.spawn({ id: s.procId, program: cmd.program, args: cmd.args, cwd: cmd.cwd, env: cmd.env });
    } catch (e) {
      offOut();
      offExit();
      s.running = false;
      this.append(s, String(e) + "\n", "err-text");
    }
    this.renderTabs();
    this.renderWidget();
  }

  private newSession(c: RunConfig): Session {
    const consoleEl = h("div.run-console", { tabIndex: 0 });
    const input = h("input.input", { placeholder: "Entrada (stdin) — Enter para enviar", spellcheck: false }) as HTMLInputElement;
    const s: Session = { id: uid(), config: c, procId: "run-" + uid(), running: true, start: Date.now(), console: consoleEl, input, exitCode: null };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && s.running) {
        host.write_(s.procId, input.value + "\n");
        this.append(s, input.value + "\n", "sys-text");
        input.value = "";
      }
    });
    consoleEl.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains("link-text")) {
        const p = t.dataset.path!;
        this.wb.editors.openFile(/^[A-Za-z]:/.test(p) ? p : P.join(this.wb.root, p), { line: Number(t.dataset.line) || 1, col: Number(t.dataset.col) || 1 });
      }
    });
    return s;
  }

  private append(s: Session, text: string, cls: string) {
    const atBottom = s.console.scrollTop + s.console.clientHeight >= s.console.scrollHeight - 30;
    s.console.append(...renderAnsi(text, cls));
    while (s.console.childNodes.length > 20000) s.console.firstChild?.remove();
    if (atBottom) s.console.scrollTop = s.console.scrollHeight;
  }

  async stopAll() {
    for (const s of this.sessions) if (s.running) await host.kill(s.procId);
    await this.wb.debugger?.stop();
    this.renderWidget();
  }

  private renderTabs() {
    this.tabsEl.replaceChildren(
      ...this.sessions.map((s) =>
        h(
          "div.tw-tab",
          { class: s === this.active ? "active" : "", onclick: () => ((this.active = s), this.renderBody()) },
          icon(s.running ? KIND_ICON[s.config.kind] : s.exitCode === 0 ? "run/testPassed" : "run/testFailed"),
          s.config.name,
          h(
            "button.tab-x",
            {
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                if (s.running) host.kill(s.procId);
                this.sessions = this.sessions.filter((x) => x !== s);
                if (this.active === s) this.active = this.sessions[this.sessions.length - 1] ?? null;
                this.renderBody();
              },
            },
            icon("general/closeSmall"),
          ),
        ),
      ),
    );
    this.wb.refreshHeader("run");
  }

  private renderBody() {
    this.renderTabs();
    const s = this.active;
    if (!s) {
      this.body.replaceChildren(h("div.empty-note", { style: "flex:1" }, "Nada em execução. Use Shift+F10 ou o ▶ no gutter do editor."));
      return;
    }
    const side = h(
      "div.run-side",
      null,
      h("button.icon-btn", { title: "Executar novamente", onclick: () => this.run(s.config, false) }, icon("run/rerun")),
      h("button.icon-btn", { title: "Parar", disabled: !s.running, onclick: () => host.kill(s.procId) }, icon("run/stop")),
      h("button.icon-btn", { title: "Limpar", onclick: () => s.console.replaceChildren() }, icon("general/delete")),
      h("button.icon-btn", { title: "Rolar até o fim", onclick: () => (s.console.scrollTop = s.console.scrollHeight) }, icon("general/scrollDown")),
      h("button.icon-btn", { title: "Editar configuração", onclick: () => this.editConfigs(s.config.id) }, icon("general/edit")),
    );
    this.body.replaceChildren(side, h("div.run-main", null, s.console, h("div.run-input", null, icon("debugger/promptInput"), s.input)));
  }

  // ---------------- edit dialog ----------------
  editConfigs(focusId?: string) {
    const m = modal("Configurações de execução/depuração", { width: 860 });
    m.root.classList.add("split");
    const list = h("div.modal-nav");
    const form = h("div.np-form");
    let cur: RunConfig | null = this.configs.find((c) => c.id === focusId) ?? this.selected();
    const drawList = () => {
      list.replaceChildren(
        h(
          "div",
          { style: "display:flex;gap:2px;padding:0 8px 8px" },
          h("button.icon-btn", { title: "Adicionar", onclick: (e: MouseEvent) => addMenu(e) }, icon("general/add")),
          h("button.icon-btn", { title: "Remover", onclick: () => cur && (this.removeConfig(cur), (cur = this.configs[0] ?? null), drawList(), drawForm()) }, icon("general/remove")),
          h("button.icon-btn", { title: "Duplicar", onclick: () => cur && (this.configs.push({ ...cur, id: uid(), name: cur.name + " (cópia)" }), drawList()) }, icon("general/copy")),
        ),
        ...this.configs.map((c) => h("div.nav-item", { class: c === cur ? "active" : "", onclick: () => ((cur = c), drawList(), drawForm()) }, icon(KIND_ICON[c.kind]), c.name)),
      );
    };
    const addMenu = (e: MouseEvent) => {
      popupList({ x: e.clientX, y: e.clientY }, (["python", "pytest", "go", "gotest", "shell"] as RunConfig["kind"][]).map((k) => ({
        label: { python: "Python", pytest: "pytest", go: "Go Build", gotest: "Go Test", shell: "Comando shell" }[k],
        icon: KIND_ICON[k],
        action: () => {
          cur = { id: uid(), name: "Nova configuração", kind: k, target: k === "go" || k === "gotest" ? "." : "", args: "", cwd: "", env: "" };
          this.configs.push(cur);
          drawList();
          drawForm();
        },
      })), { width: 240 });
    };
    const field = (label: string, key: keyof RunConfig, placeholder = "") => {
      const inp = h("input.input", { value: String(cur![key] ?? ""), placeholder, spellcheck: false, oninput: (e: Event) => ((cur as any)[key] = (e.target as HTMLInputElement).value) }) as HTMLInputElement;
      return h("label.field.row", null, h("span", null, label), inp);
    };
    const drawForm = () => {
      if (!cur) {
        form.replaceChildren(h("div.empty-note", null, "Nenhuma configuração. Clique em + para adicionar."));
        return;
      }
      const targetLabel = { python: "Script", pytest: "Alvo (arquivo/pasta)", go: "Pacote (pasta)", gotest: "Pacote (pasta)", shell: "Comando" }[cur.kind];
      const tmp = h("input", { type: "checkbox", checked: !cur.temporary, onchange: (e: Event) => (cur!.temporary = !(e.target as HTMLInputElement).checked) });
      form.replaceChildren(
        field("Nome", "name"),
        field(targetLabel, "target", cur.kind === "python" ? "main.py" : "."),
        cur.kind === "pytest" || cur.kind === "gotest" ? field("Filtro de teste", "filter", cur.kind === "gotest" ? "TestNome" : "TestClasse::test_metodo") : "",
        field("Argumentos", "args"),
        field("Diretório de trabalho", "cwd", "(raiz do projeto)"),
        field("Variáveis de ambiente", "env", "CHAVE=valor;OUTRA=valor"),
        h("label.check", null, tmp, "Salvar como configuração do projeto"),
        h("div.hint", null, cur.kind === "python" || cur.kind === "pytest" ? `Interpretador: ${this.wb.python?.label ?? "nenhum"} — ${this.wb.python?.path ?? ""}` : "Usa o Go SDK do PATH."),
      );
    };
    drawList();
    drawForm();
    m.body.style.padding = "0";
    m.body.style.display = "flex";
    m.body.style.minHeight = "420px";
    m.body.append(list, form);
    m.footer.append(
      button("Cancelar", () => m.close()),
      button("Executar", () => (this.save(), m.close(), cur && this.run(cur, false)), "", "run/run"),
      button("OK", () => (cur && (this.wb.settings.selectedRunConfig = cur.id), this.save(), m.close()), "primary"),
    );
  }
}

// ---------------- ANSI + link rendering ----------------
const ANSI_COLORS = ["#4C4F56", "#F75464", "#5FB865", "#E5C07B", "#548AF7", "#C678DD", "#2AACB8", "#D1D3D9"];
const ANSI_BRIGHT = ["#73767C", "#FF7B85", "#89D185", "#F2C55C", "#6EA6FF", "#D7A1F0", "#56C8D3", "#FFFFFF"];
let ansiState: { color?: string; bold?: boolean } = {};

export function renderAnsi(text: string, cls: string): Node[] {
  const out: Node[] = [];
  const parts = text.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      for (const code of parts[i].split(";").map((x) => Number(x || 0))) {
        if (code === 0) ansiState = {};
        else if (code === 1) ansiState.bold = true;
        else if (code === 22) ansiState.bold = false;
        else if (code >= 30 && code <= 37) ansiState.color = ANSI_COLORS[code - 30];
        else if (code >= 90 && code <= 97) ansiState.color = ANSI_BRIGHT[code - 90];
        else if (code === 39) ansiState.color = undefined;
      }
      continue;
    }
    const chunk = parts[i].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r(?!\n)/g, "");
    if (!chunk) continue;
    out.push(...linkify(chunk, cls, ansiState));
  }
  return out;
}

const LINK_RE = /(File "([^"]+)", line (\d+))|((?:[A-Za-z]:)?[\w./\\-]+\.(?:py|go)):(\d+)(?::(\d+))?/g;

function linkify(text: string, cls: string, st: { color?: string; bold?: boolean }): Node[] {
  const style = [st.color ? `color:${st.color}` : "", st.bold ? "font-weight:600" : ""].filter(Boolean).join(";");
  const mk = (t: string) => (cls || style ? h("span", { class: cls, style }, t) : document.createTextNode(t));
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    if (m.index! > last) out.push(mk(text.slice(last, m.index)));
    const path = (m[2] ?? m[4]).replace(/\\/g, "/");
    const line = m[3] ?? m[5];
    const col = m[6] ?? "1";
    out.push(h("span.link-text", { "data-path": path, "data-line": line, "data-col": col }, m[0]));
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(mk(text.slice(last)));
  return out;
}
