// Debugger: Debug Adapter Protocol client for debugpy (Python) and Delve (Go), and the Debug tool window.
import { h, uid } from "../util";
import { icon } from "../icons";
import { notify, toast } from "../ui";
import { host, on, P, type ProcExit, type ProcOut, type RpcIn } from "./host";
import { goTool, scriptsDir } from "./sdk";
import { parseEnv, renderAnsi, splitArgs } from "./run";
import type { RunConfig } from "./project";
import type { Workbench } from "./workbench";

interface Frame {
  id: number;
  name: string;
  line: number;
  column: number;
  source?: { path?: string; name?: string };
}

interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export class Debugger {
  active = false;
  private dapId = "";
  private adapterProc = "";
  private seq = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private offs: (() => void)[] = [];
  private config: RunConfig | null = null;
  private threadId: number | null = null;
  private frames: Frame[] = [];
  private frameId: number | null = null;
  private execEditorPath: string | null = null;
  private state: "running" | "paused" | "idle" = "idle";
  private expanded = new Set<string>();
  private view: "vars" | "console" = "vars";
  private body = h("div.tw-body");
  private consoleEl = h("div.run-console", { tabIndex: 0 });
  private tabsEl = h("div.tw-tabs");
  private varsEl = h("div.tree", { tabIndex: 0 });
  private framesEl = h("div.list");
  private initialized: Promise<void> | null = null;

  constructor(private wb: Workbench) {
    wb.register({ id: "debug", title: "Debug", icon: "debug", anchor: "bottom", shortcut: "Alt+5", body: this.body, headerTabs: this.tabsEl });
    this.render();
  }

  // ---------------- DAP plumbing ----------------
  private send(msg: object) {
    return host.write_(this.dapId, JSON.stringify(msg));
  }

  private request<T = any>(command: string, args: object = {}): Promise<T> {
    const seq = this.seq++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.send({ seq, type: "request", command, arguments: args }).catch(reject);
    });
  }

  private onMessage(raw: string) {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === "response") {
      const p = this.pending.get(m.request_seq);
      if (!p) return;
      this.pending.delete(m.request_seq);
      m.success ? p.resolve(m.body ?? {}) : p.reject(new Error(m.message || m.body?.error?.format || "falha"));
    } else if (m.type === "event") this.onEvent(m.event, m.body ?? {});
    else if (m.type === "request") {
      // reverse requests (runInTerminal/startDebugging) are not supported: answer politely
      this.send({ seq: this.seq++, type: "response", request_seq: m.seq, command: m.command, success: false, message: "não suportado" });
    }
  }

  private onEvent(ev: string, body: any) {
    switch (ev) {
      case "initialized":
        this.initDone?.();
        break;
      case "output":
        if (body.category !== "telemetry") this.log(body.output ?? "", body.category === "stderr" ? "err-text" : body.category === "console" ? "sys-text" : "");
        break;
      case "stopped":
        this.state = "paused";
        this.threadId = body.threadId ?? this.threadId;
        this.onStopped(body.reason, body.text ?? body.description);
        break;
      case "continued":
        this.state = "running";
        this.clearExec();
        this.render();
        break;
      case "terminated":
      case "exited":
        if (ev === "exited") this.log(`\nProcesso finalizado com código ${body.exitCode}\n`, "sys-text");
        if (ev === "terminated") this.finish();
        break;
    }
  }
  private initDone: (() => void) | null = null;

  // ---------------- lifecycle ----------------
  async start(c: RunConfig) {
    if (this.active) await this.stop();
    const cmd = await this.wb.runner.command(c).catch((e) => {
      toast(String(e.message ?? e), "error");
      return null;
    });
    if (!cmd) return;
    this.config = c;
    this.consoleEl.replaceChildren();
    this.dapId = "dap-" + uid();
    this.seq = 1;
    this.active = true;
    this.state = "running";
    this.wb.show("debug");
    this.render();
    this.wb.runner.renderWidget();
    this.initialized = new Promise((r) => (this.initDone = r));
    this.offs.push(on<RpcIn>("rpc-in", this.dapId, (e) => this.onMessage(e.msg)));

    const isPy = c.kind === "python" || c.kind === "pytest";
    try {
      if (isPy) {
        const py = this.wb.python!.path;
        const chk = await host.capture(py, ["-c", "import debugpy"], "", undefined, 20);
        if (chk.code !== 0) throw new Error("debugpy não está instalado neste interpretador. Instale em Configurações › Plugins › Python.");
        this.offs.push(on<ProcOut>("proc-out", this.dapId, (e) => this.log(e.data, "err-text")));
        this.offs.push(on<ProcExit>("proc-exit", this.dapId, () => this.finish()));
        await host.spawn({ id: this.dapId, program: py, args: ["-m", "debugpy.adapter"], cwd: cmd.cwd, env: cmd.env, mode: "rpc" });
        this.adapterProc = this.dapId;
      } else {
        const dlv = await goTool("dlv");
        if (!dlv) throw new Error("Delve (dlv) não está instalado. Instale em Configurações › Plugins › Go.");
        const port = await host.freePort();
        this.adapterProc = "dlv-" + uid();
        this.offs.push(on<ProcOut>("proc-out", this.adapterProc, (e) => this.log(e.data, e.stream === "stderr" ? "err-text" : "")));
        this.offs.push(on<ProcExit>("proc-exit", this.adapterProc, () => this.finish()));
        await host.spawn({ id: this.adapterProc, program: dlv, args: ["dap", `--listen=127.0.0.1:${port}`], cwd: cmd.cwd, env: cmd.env });
        await host.connect(this.dapId, `127.0.0.1:${port}`);
        this.offs.push(on<ProcExit>("proc-exit", this.dapId, () => this.finish()));
      }
      await this.request("initialize", {
        clientID: "rits",
        clientName: "Rits",
        adapterID: isPy ? "debugpy" : "go",
        pathFormat: "path",
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsRunInTerminalRequest: false,
        locale: "pt-BR",
      });
      const launchArgs = isPy ? this.pyLaunch(c, cmd) : await this.goLaunch(c, cmd);
      this.log(`Depurando: ${c.name}\n`, "sys-text");
      const launched = this.request("launch", launchArgs);
      await Promise.race([this.initialized, launched]);
      await this.initialized;
      await this.sendAllBreakpoints();
      await this.request("setExceptionBreakpoints", { filters: isPy ? ["uncaught"] : [] }).catch(() => {});
      await this.request("configurationDone").catch(() => {});
      await launched;
    } catch (e) {
      notify("Falha ao iniciar a depuração", String((e as Error).message ?? e), "error", [], 12000);
      await this.stop();
    }
  }

  private pyLaunch(c: RunConfig, cmd: { args: string[]; cwd: string; env: Record<string, string> }) {
    const env = { ...cmd.env, PYTHONUNBUFFERED: "1" };
    delete (env as any).RITS_PATH_PREPEND;
    const base = { name: c.name, type: "python", request: "launch", cwd: cmd.cwd, env, console: "internalConsole", justMyCode: true, redirectOutput: true, showReturnValue: true };
    if (c.kind === "pytest") {
      const idx = cmd.args.indexOf("pytest");
      return { ...base, module: "pytest", args: cmd.args.slice(idx + 1).filter((a) => a !== "--color=yes") };
    }
    const prog = cmd.args[2];
    return { ...base, program: prog, args: cmd.args.slice(3), python: this.wb.python?.path ? P.win(this.wb.python.path) : undefined };
  }

  private async goLaunch(c: RunConfig, cmd: { args: string[]; cwd: string }) {
    const isTest = c.kind === "gotest";
    const pkg = cmd.args.find((a) => a.startsWith(".")) ?? ".";
    const program = P.win(pkg === "./..." || pkg === "." ? this.wb.root : P.join(this.wb.root, pkg));
    return {
      name: c.name,
      type: "go",
      request: "launch",
      mode: isTest ? "test" : "debug",
      program,
      cwd: cmd.cwd,
      args: isTest ? (c.filter ? ["-test.run", `^${c.filter}$`, "-test.v"] : ["-test.v"]) : splitArgs(c.args),
      env: parseEnv(c.env),
      stopOnEntry: false,
    };
  }

  private async sendAllBreakpoints() {
    const all = new Map<string, number[]>();
    for (const [k, lines] of Object.entries(this.wb.settings.breakpoints ?? {})) all.set(k, lines);
    for (const ed of this.wb.editors.all()) all.set(ed.path.toLowerCase(), ed.breakpointLines());
    for (const [path, lines] of all) {
      const real = this.wb.editors.get(path)?.path ?? path;
      await this.setBreakpoints(real, lines);
    }
  }

  private async setBreakpoints(path: string, lines: number[]) {
    await this.request("setBreakpoints", { source: { path: P.win(path), name: P.base(path) }, breakpoints: lines.map((line) => ({ line })), lines }).catch((e) => this.log(`breakpoint: ${e.message}\n`, "err-text"));
  }

  breakpointsChanged(path: string, lines: number[]) {
    if (this.active) this.setBreakpoints(path, lines);
  }

  async stop() {
    if (!this.active) return;
    try {
      await Promise.race([this.request("disconnect", { terminateDebuggee: true }), new Promise((r) => setTimeout(r, 1500))]);
    } catch {
      /* ignore */
    }
    this.finish();
  }

  private finish() {
    if (!this.active) return;
    this.active = false;
    this.state = "idle";
    this.offs.forEach((f) => f());
    this.offs = [];
    for (const p of this.pending.values()) p.reject(new Error("sessão encerrada"));
    this.pending.clear();
    host.kill(this.dapId);
    if (this.adapterProc && this.adapterProc !== this.dapId) host.kill(this.adapterProc);
    this.clearExec();
    this.frames = [];
    this.log("\nSessão de depuração encerrada\n", "sys-text");
    this.render();
    this.wb.runner.renderWidget();
  }

  // ---------------- stepping ----------------
  private step(cmd: string) {
    if (!this.active || this.threadId === null) return;
    this.state = "running";
    this.clearExec();
    this.render();
    this.request(cmd, { threadId: this.threadId }).catch((e) => toast(e.message, "error"));
  }
  resume = () => this.step("continue");
  stepOver = () => this.step("next");
  stepInto = () => this.step("stepIn");
  stepOut = () => this.step("stepOut");
  pause() {
    if (this.active && this.threadId !== null) this.request("pause", { threadId: this.threadId }).catch(() => {});
    else if (this.active) this.request("threads").then((r) => r.threads?.[0] && this.request("pause", { threadId: r.threads[0].id }));
  }

  private async onStopped(reason: string, text?: string) {
    try {
      if (this.threadId === null) {
        const t = await this.request("threads");
        this.threadId = t.threads?.[0]?.id ?? null;
      }
      const st = await this.request("stackTrace", { threadId: this.threadId, startFrame: 0, levels: 60 });
      this.frames = st.stackFrames ?? [];
      if (reason === "exception" && text) this.log(`Exceção: ${text}\n`, "err-text");
      const top = this.frames.find((f) => f.source?.path) ?? this.frames[0];
      if (top) await this.selectFrame(top);
      else this.render();
      document.querySelector<HTMLElement>(".main-toolbar")?.ownerDocument.defaultView?.focus();
    } catch (e) {
      this.log(String((e as Error).message) + "\n", "err-text");
    }
  }

  private async selectFrame(f: Frame) {
    this.frameId = f.id;
    this.vars = await this.loadScopes(f.id);
    this.render();
    if (f.source?.path) {
      const path = P.norm(f.source.path);
      this.clearExec();
      const ed = await this.wb.editors.openFile(path);
      ed?.setExecLine(f.line);
      this.execEditorPath = path;
    }
  }
  private vars: { name: string; ref: number; children?: Variable[] }[] = [];

  private async loadScopes(frameId: number) {
    const sc = await this.request("scopes", { frameId });
    const scopes = (sc.scopes ?? []) as { name: string; variablesReference: number; expensive?: boolean }[];
    const out = [];
    for (const s of scopes) {
      const children = s.expensive ? undefined : (await this.request("variables", { variablesReference: s.variablesReference }).catch(() => ({ variables: [] }))).variables;
      out.push({ name: s.name, ref: s.variablesReference, children });
    }
    return out;
  }

  private clearExec() {
    if (this.execEditorPath) this.wb.editors.get(this.execEditorPath)?.setExecLine(null);
    this.execEditorPath = null;
  }

  private log(text: string, cls: string) {
    const atBottom = this.consoleEl.scrollTop + this.consoleEl.clientHeight >= this.consoleEl.scrollHeight - 30;
    this.consoleEl.append(...renderAnsi(text, cls));
    if (atBottom) this.consoleEl.scrollTop = this.consoleEl.scrollHeight;
  }

  // ---------------- UI ----------------
  private render() {
    this.tabsEl.replaceChildren(
      h("div.tw-tab", { class: this.view === "vars" ? "active" : "", onclick: () => ((this.view = "vars"), this.render()) }, icon("debugger/variablesTab"), "Threads e variáveis"),
      h("div.tw-tab", { class: this.view === "console" ? "active" : "", onclick: () => ((this.view = "console"), this.render()) }, icon("debugger/promptInput"), "Console"),
    );
    this.wb.refreshHeader("debug");
    const paused = this.state === "paused";
    const side = h(
      "div.run-side",
      null,
      h("button.icon-btn", { title: "Reiniciar", disabled: !this.config, onclick: () => this.config && this.start(this.config) }, icon("run/restartDebug")),
      h("button.icon-btn", { title: "Continuar (F9)", disabled: !paused, onclick: this.resume }, icon("run/resume")),
      h("button.icon-btn", { title: "Pausar", disabled: !this.active || paused, onclick: () => this.pause() }, icon("run/pause")),
      h("button.icon-btn", { title: "Parar (Ctrl+F2)", disabled: !this.active, onclick: () => this.stop() }, icon("run/stop")),
      h("span.tool-sep", { style: "width:16px;height:1px;margin:4px 0" }),
      h("button.icon-btn", { title: "Step over (F8)", disabled: !paused, onclick: this.stepOver }, icon("run/stepOver")),
      h("button.icon-btn", { title: "Step into (F7)", disabled: !paused, onclick: this.stepInto }, icon("run/stepInto")),
      h("button.icon-btn", { title: "Step out (Shift+F8)", disabled: !paused, onclick: this.stepOut }, icon("run/stepOut")),
    );
    if (this.view === "console") {
      const input = h("input.input", { placeholder: this.active ? "Avaliar expressão (Enter)" : "Sem sessão ativa", disabled: !this.active, spellcheck: false }) as HTMLInputElement;
      input.addEventListener("keydown", (e) => e.key === "Enter" && this.evaluate(input));
      this.body.replaceChildren(h("div.run-wrap", null, side, h("div.run-main", null, this.consoleEl, h("div.run-input", null, icon("debugger/promptInput"), input))));
      return;
    }
    // frames
    this.framesEl.replaceChildren(
      ...(this.frames.length
        ? this.frames.map((f) =>
            h(
              "div.list-row",
              { class: f.id === this.frameId ? "selected" : "", onclick: () => this.selectFrame(f), title: f.source?.path ?? "" },
              icon(f.source?.path ? "debugger/frame" : "general/hide"),
              h("span", null, f.name),
              h("span.detail", null, `${f.source?.name ?? ""}:${f.line}`),
            ),
          )
        : [h("div.dbg-status", null, this.active ? (paused ? "" : "Executando…") : "Inicie a depuração com Shift+F9 ou pelo 🐞 do gutter.")]),
    );
    this.renderVars();
    const evalInput = h("input.input", { placeholder: "Avaliar expressão (Enter) ou adicionar watch", disabled: !paused, spellcheck: false }) as HTMLInputElement;
    evalInput.addEventListener("keydown", (e) => e.key === "Enter" && this.evaluate(evalInput));
    this.body.replaceChildren(
      h(
        "div.run-wrap",
        null,
        side,
        h(
          "div.dbg-wrap",
          null,
          h("div.dbg-frames", null, h("div.dbg-section-head", null, icon("debugger/threads"), "Frames"), this.framesEl),
          h("div.dbg-vars", null, h("div.dbg-eval", null, evalInput), this.varsEl),
        ),
      ),
    );
  }

  private renderVars() {
    const rows: HTMLElement[] = [];
    const varRow = (v: Variable, depth: number, key: string) => {
      const open = this.expanded.has(key);
      const t = (v.type ?? "").toLowerCase();
      const cls = /str|string/.test(t) ? "str" : /int|float|number|decimal|complex|uint|byte/.test(t) ? "num" : "";
      const row = h(
        "div.tree-row.var-row",
        { style: `padding-left:${8 + depth * 16}px`, title: v.value },
        h("span.twisty", { onclick: () => this.toggleVar(key, v) }, v.variablesReference ? icon(open ? "general/chevronDown" : "general/chevronRight") : null),
        icon(v.variablesReference ? "debugger/dbObject" : "debugger/dbPrimitive"),
        h("span.var-name", null, v.name),
        h("span.var-type", null, v.type ? ` {${v.type}}` : ""),
        h("span", null, " = "),
        h("span.var-val", { class: cls }, v.value),
      );
      row.addEventListener("dblclick", () => this.toggleVar(key, v));
      rows.push(row);
      if (open) for (const c of this.childCache.get(key) ?? []) varRow(c, depth + 1, key + "/" + c.name);
    };
    for (const s of this.vars) {
      const key = "scope:" + s.name;
      const open = !this.expanded.has(key + ":closed");
      rows.push(
        h(
          "div.tree-row",
          { style: "padding-left:8px;font-weight:600", onclick: () => (this.expanded.has(key + ":closed") ? this.expanded.delete(key + ":closed") : this.expanded.add(key + ":closed"), this.renderVars()) },
          h("span.twisty", null, icon(open ? "general/chevronDown" : "general/chevronRight")),
          s.name,
        ),
      );
      if (open) for (const v of s.children ?? []) varRow(v, 1, key + "/" + v.name);
    }
    if (!rows.length) rows.push(h("div.dbg-status", null, this.state === "paused" ? "Sem variáveis" : ""));
    this.varsEl.replaceChildren(...rows);
  }
  private childCache = new Map<string, Variable[]>();

  private async toggleVar(key: string, v: Variable) {
    if (!v.variablesReference) return;
    if (this.expanded.has(key)) this.expanded.delete(key);
    else {
      this.expanded.add(key);
      const r = await this.request("variables", { variablesReference: v.variablesReference }).catch(() => ({ variables: [] }));
      this.childCache.set(key, r.variables ?? []);
    }
    this.renderVars();
  }

  private async evaluate(input: HTMLInputElement) {
    const expr = input.value.trim();
    if (!expr || !this.active) return;
    this.log(`> ${expr}\n`, "sys-text");
    try {
      const r = await this.request("evaluate", { expression: expr, frameId: this.frameId ?? undefined, context: "repl" });
      this.log(`${r.result}${r.type ? `  {${r.type}}` : ""}\n`, "");
      if (this.view === "vars") toast(`${expr} = ${r.result}`, "info", 6000);
    } catch (e) {
      this.log(`${(e as Error).message}\n`, "err-text");
      if (this.view === "vars") toast((e as Error).message, "error");
    }
    input.value = "";
  }
}

export { scriptsDir };
