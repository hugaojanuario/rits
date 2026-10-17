// Agents behind the chat: the user's own Claude Code and Codex CLIs (their accounts, their
// subscriptions), like the official VS Code extensions. The IDE context reaches them through the
// local MCP server "rits" (assistant.rs + tools.ts).
//
// - Claude Code: one long-lived process per chat (`-p --input-format stream-json
//   --output-format stream-json`), partial text, permission prompts routed to the chat through
//   `--permission-prompt-tool mcp__rits__approve`; resumed with `--resume <session>`.
// - Codex: one `codex exec --json` per message, continued with `codex exec resume <thread>`.
import { host, on, IS_WIN, type ProcExit, type ProcOut } from "../host";
import { uid } from "../../util";
import { TOOLS } from "./tools";

export type ProviderId = "claude" | "codex";
export type Mode = "readonly" | "ask" | "auto";

export type AgentEvent =
  | { kind: "session"; id: string }
  | { kind: "init"; model: string; commands: string[] }
  | { kind: "delta"; text: string }
  | { kind: "text"; text: string }
  | { kind: "thinking" }
  | { kind: "tool"; id: string; name: string; input: unknown; status: "running" | "done" | "error"; output?: string }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string }
  | { kind: "end"; cost?: number; error?: string };

export interface StartOpts {
  root: string;
  mcpUrl: string;
  token: string;
  claudeConfig: string;
  model: string;
  /** reasoning effort ("" = the CLI default) */
  effort: string;
  mode: Mode;
  sessionId: string | null;
  systemPrompt: string;
}

export interface Agent {
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  busy: boolean;
}

/** Locates a CLI (PATH, the usual install folders) — returns [program, prefixArgs]. */
export async function locate(id: ProviderId): Promise<{ program: string; prefix: string[]; via: string } | null> {
  const env = await host.env();
  const home = env.home;
  const extra = id === "claude" ? [`${home}/.local/bin`, `${home}/.claude/local`, `${home}/AppData/Roaming/npm`] : [`${home}/.local/bin`, `${home}/AppData/Roaming/npm`];
  const exe = await host.which(id, extra);
  if (exe) return { program: exe, prefix: [], via: exe };
  if (id === "codex") {
    // without a global install, the official npm package through npx (nothing installed globally)
    const npx = await host.which(IS_WIN ? "npx.cmd" : "npx");
    if (npx) return { program: npx, prefix: ["-y", "@openai/codex@latest"], via: "npx @openai/codex" };
  }
  return null;
}

class LineReader {
  private buf = "";
  constructor(private onLine: (l: string) => void) {}
  push(data: string) {
    this.buf += data;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const l = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (l) this.onLine(l);
    }
  }
}

const shortInput = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 4000 ? s.slice(0, 4000) + "…" : s;
};

// ---------------- Claude Code ----------------

export class ClaudeAgent implements Agent {
  busy = false;
  private procId: string | null = null;
  private offs: (() => void)[] = [];
  private stderr = "";

  constructor(
    private cli: { program: string; prefix: string[] },
    private o: StartOpts,
    private emit: (e: AgentEvent) => void,
  ) {}

  private args() {
    const a = [...this.cli.prefix, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--mcp-config", this.o.claudeConfig, "--append-system-prompt", this.o.systemPrompt];
    // one value: the flag is variadic and would swallow the following arguments
    a.push(`--allowedTools=${TOOLS.map((t) => `mcp__rits__${t.name}`).join(",")}`);
    if (this.o.mode === "readonly") a.push("--permission-mode", "plan");
    else {
      a.push("--permission-prompt-tool", "mcp__rits__approve");
      if (this.o.mode === "auto") a.push("--permission-mode", "acceptEdits");
    }
    if (this.o.model) a.push("--model", this.o.model);
    if (this.o.effort) a.push("--effort", this.o.effort);
    if (this.o.sessionId) a.push("--resume", this.o.sessionId);
    return a;
  }

  private async start() {
    const id = "ai-claude-" + uid();
    this.procId = id;
    this.stderr = "";
    const lines = new LineReader((l) => this.line(l));
    this.offs.push(
      on<ProcOut>("proc-out", id, (e) => (e.stream === "stdout" ? lines.push(e.data) : (this.stderr = (this.stderr + e.data).slice(-4000)))),
      on<ProcExit>("proc-exit", id, (e) => {
        this.offs.forEach((f) => f());
        this.offs = [];
        this.procId = null;
        if (this.busy) {
          this.busy = false;
          const err = this.stderr.trim().split("\n").slice(-6).join("\n");
          this.emit({ kind: "end", error: e.code === 0 ? undefined : err || `O Claude Code terminou com código ${e.code}.` });
        }
      }),
    );
    await host.spawn({ id, program: this.cli.program, args: this.args(), cwd: this.o.root, env: { NO_COLOR: "1" } });
  }

  private line(l: string) {
    let e: any;
    try {
      e = JSON.parse(l);
    } catch {
      return;
    }
    switch (e.type) {
      case "system":
        if (e.subtype === "init") {
          if (e.session_id) {
            this.o.sessionId = e.session_id;
            this.emit({ kind: "session", id: e.session_id });
          }
          this.emit({ kind: "init", model: String(e.model ?? ""), commands: Array.isArray(e.slash_commands) ? e.slash_commands.map(String) : [] });
          const rits = (e.mcp_servers ?? []).find((s: any) => s.name === "rits");
          if (rits && rits.status !== "connected") this.emit({ kind: "info", text: `Contexto da IDE indisponível para o agente (MCP: ${rits.status}).` });
        }
        break;
      case "stream_event": {
        const ev = e.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          this.emit({ kind: "delta", text: ev.delta.text });
        }
        break;
      }
      case "assistant":
        for (const c of e.message?.content ?? []) {
          if (c.type === "text") this.emit({ kind: "text", text: c.text });
          else if (c.type === "thinking") this.emit({ kind: "thinking" });
          else if (c.type === "tool_use" && c.name !== "ToolSearch") this.emit({ kind: "tool", id: c.id, name: c.name, input: c.input, status: "running" });
        }
        break;
      case "user":
        for (const c of e.message?.content ?? []) {
          if (c.type !== "tool_result") continue;
          const text = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? (x.type === "tool_reference" ? "" : `[${x.type}]`)).join("\n") : String(c.content ?? "");
          this.emit({ kind: "tool", id: c.tool_use_id, name: "", input: null, status: c.is_error ? "error" : "done", output: shortInput(text) });
        }
        break;
      case "result":
        this.busy = false;
        this.emit({ kind: "end", cost: e.total_cost_usd, error: e.is_error ? String(e.result ?? e.subtype ?? "erro") : undefined });
        break;
    }
  }

  async send(text: string) {
    if (!this.procId) await this.start();
    this.busy = true;
    const msg = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
    await host.write_(this.procId!, JSON.stringify(msg) + "\n");
  }

  async stop() {
    // the session continues later with --resume
    if (this.procId) await host.kill(this.procId).catch(() => {});
  }

  async dispose() {
    this.busy = false;
    await this.stop();
  }
}

// ---------------- Codex ----------------

export class CodexAgent implements Agent {
  busy = false;
  private procId: string | null = null;
  private first = true;

  constructor(
    private cli: { program: string; prefix: string[] },
    private o: StartOpts,
    private emit: (e: AgentEvent) => void,
  ) {}

  async send(text: string) {
    const id = "ai-codex-" + uid();
    this.procId = id;
    this.busy = true;
    // values without quotes (TOML falls back to the literal string): safe through .cmd launchers
    const common = ["--json", "--skip-git-repo-check", "-c", `mcp_servers.rits.url=${this.o.mcpUrl}`, "-c", "mcp_servers.rits.bearer_token_env_var=RITS_MCP_TOKEN", "-c", `sandbox_mode=${this.o.mode === "readonly" ? "read-only" : "workspace-write"}`];
    if (this.o.model) common.push("-m", this.o.model);
    if (this.o.effort) common.push("-c", `model_reasoning_effort=${this.o.effort}`);
    // Codex has no system-prompt flag: the IDE instructions go with the first message
    const prompt = this.first && !this.o.sessionId ? `${this.o.systemPrompt}\n\n---\n\n${text}` : text;
    // the prompt goes through stdin ("-"), never the command line (quotes and newlines on Windows)
    const args = this.o.sessionId ? [...this.cli.prefix, "exec", "resume", ...common, this.o.sessionId, "-"] : [...this.cli.prefix, "exec", "-C", this.o.root, ...common, "-"];
    this.first = false;
    let stderr = "";
    let failed: string | null = null;
    const lines = new LineReader((l) => {
      let e: any;
      try {
        e = JSON.parse(l);
      } catch {
        return;
      }
      const it = e.item ?? {};
      if (e.type === "thread.started" && e.thread_id) {
        this.o.sessionId = e.thread_id;
        this.emit({ kind: "session", id: e.thread_id });
      } else if (e.type === "item.started" && ["mcp_tool_call", "command_execution", "web_search"].includes(it.type)) {
        this.emit({ kind: "tool", id: it.id, name: it.type === "mcp_tool_call" ? `mcp__${it.server}__${it.tool}` : it.type === "command_execution" ? "Bash" : "WebSearch", input: it.type === "mcp_tool_call" ? it.arguments : it.type === "command_execution" ? { command: it.command } : { query: it.query }, status: "running" });
      } else if (e.type === "item.completed") {
        if (it.type === "agent_message") this.emit({ kind: "text", text: it.text });
        else if (it.type === "reasoning") this.emit({ kind: "thinking" });
        else if (it.type === "mcp_tool_call") this.emit({ kind: "tool", id: it.id, name: `mcp__${it.server}__${it.tool}`, input: it.arguments, status: it.error ? "error" : "done", output: it.error ? it.error.message : shortInput((it.result?.content ?? []).map((c: any) => c.text ?? "").join("\n")) });
        else if (it.type === "command_execution") this.emit({ kind: "tool", id: it.id, name: "Bash", input: { command: it.command }, status: it.exit_code === 0 || it.status === "completed" ? "done" : "error", output: shortInput(it.aggregated_output ?? "") });
        else if (it.type === "file_change") this.emit({ kind: "tool", id: it.id, name: "Edit", input: it.changes, status: it.status === "failed" ? "error" : "done", output: (it.changes ?? []).map((c: any) => `${c.kind} ${c.path}`).join("\n") });
        else if (it.type === "error") this.emit({ kind: "info", text: it.message });
      } else if (e.type === "turn.failed" || e.type === "error") {
        failed = e.error?.message ?? e.message ?? "erro";
      }
    });
    const offOut = on<ProcOut>("proc-out", id, (e) => (e.stream === "stdout" ? lines.push(e.data) : (stderr = (stderr + e.data).slice(-4000))));
    const offExit = on<ProcExit>("proc-exit", id, (e) => {
      offOut();
      offExit();
      this.procId = null;
      this.busy = false;
      let err = failed as string | null;
      if (err) {
        try {
          err = JSON.parse(err).error?.message ?? err;
        } catch {
          /* plain text */
        }
      } else if (e.code !== 0 && e.code !== null) err = stderr.trim().split("\n").filter((x) => !/ERROR codex_core::session/.test(x)).slice(-6).join("\n") || `O Codex terminou com código ${e.code}.`;
      this.emit({ kind: "end", error: err ?? undefined });
    });
    await host.spawn({ id, program: this.cli.program, args, cwd: this.o.root, env: { RITS_MCP_TOKEN: this.o.token, NO_COLOR: "1" } });
    await host.write_(id, prompt);
    await host.closeStdin(id);
  }

  async stop() {
    if (this.procId) await host.kill(this.procId).catch(() => {});
  }

  async dispose() {
    await this.stop();
  }
}
