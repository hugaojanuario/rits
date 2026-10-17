// AI assistant tool window: a chat with the user's Claude Code or Codex, with the IDE as context
// (local MCP server: project, editors, databases, Airflow, dbt, Jupyter, Docker, audits).
// Sensitive actions of Claude Code (editing files, running commands) are approved in the chat.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { h, uid } from "../../util";
import { icon } from "../../icons";
import { button, confirmDialog, toast } from "../../ui";
import { host, IS_WIN, P } from "../host";
import type { PluginHandle } from "../plugins";
import type { Workbench } from "../workbench";
import { APPROVE_TOOL, runTool, TOOLS } from "./tools";
import { ClaudeAgent, CodexAgent, locate, type Agent, type AgentEvent, type Mode, type ProviderId } from "./providers";

interface Msg {
  role: "user" | "assistant" | "tool" | "info" | "error";
  text: string;
  tool?: { id: string; name: string; input: unknown; status: string; output?: string };
}

interface ChatState {
  provider: ProviderId;
  sessions: Partial<Record<ProviderId, string>>;
  messages: Msg[];
}

const PREF = "assistant.";
const pref = (k: string, d: string) => {
  try {
    return localStorage.getItem(PREF + k) ?? d;
  } catch {
    return d;
  }
};
const setPref = (k: string, v: string) => {
  try {
    localStorage.setItem(PREF + k, v);
  } catch {
    /* ignore */
  }
};

const CLAUDE_MODELS: [string, string][] = [["", "padrão da conta"], ["sonnet", "Sonnet"], ["opus", "Opus"], ["haiku", "Haiku"]];
/** A command line for the integrated terminal (PowerShell on Windows needs "&" to run a quoted path). */
function termCommand(program: string, args: string[]) {
  const q = (x: string) => (/^[\w./:@=-]+$/.test(x) ? x : IS_WIN ? `'${x.replace(/'/g, "''")}'` : `'${x.replace(/'/g, "'\\''")}'`);
  const line = [program, ...args].map(q).join(" ");
  return IS_WIN ? `& ${line}` : line;
}

const PROVIDER_LABEL: Record<ProviderId, string> = { claude: "Claude Code", codex: "Codex" };

const TOOL_LABEL: Record<string, string> = Object.fromEntries([...TOOLS.map((t) => [`mcp__rits__${t.name}`, t.title]), ["Read", "Ler arquivo"], ["Write", "Criar arquivo"], ["Edit", "Editar arquivo"], ["MultiEdit", "Editar arquivo"], ["Bash", "Comando"], ["Glob", "Buscar arquivos"], ["Grep", "Buscar texto"], ["WebFetch", "Web"], ["WebSearch", "Busca na web"], ["TodoWrite", "Tarefas"], ["Task", "Subagente"]]);

function systemPrompt(wb: Workbench) {
  return [
    "Você está dentro da IDE Rits (engenharia de dados: Python, Go, bancos, Airflow, dbt, Jupyter, Docker).",
    `O projeto aberto é ${wb.root}.`,
    "O servidor MCP rits dá acesso ao que o usuário vê na IDE: comece por mcp__rits__ide_context. Para bancos use db_connections, db_schema e db_query (somente leitura); para Airflow, dbt, notebooks, Docker e auditorias use as ferramentas correspondentes.",
    "Responda em português do Brasil, de forma direta. Ao propor mudanças em arquivos, explique o que muda.",
  ].join(" ");
}

export class AssistantTools implements PluginHandle {
  private body = h("div.tw-body.ai");
  private list = h("div.ai-list");
  private input = h("textarea.ai-input", { rows: 3, placeholder: "Pergunte sobre o projeto, os dados, as DAGs… (Enter envia, Shift+Enter quebra a linha)" }) as HTMLTextAreaElement;
  private status = h("div.ai-status");
  private chips = h("div.ai-chips");
  private sendBtn!: HTMLButtonElement;
  private state: ChatState;
  private agent: Agent | null = null;
  private session: { token: string; url: string; claudeConfig: string } | null = null;
  private chatId = "c" + uid();
  private streaming: { el: HTMLElement; text: string } | null = null;
  private approvals = new Map<string, (r: unknown) => void>();
  private allowAlways = new Set<string>();
  private off: Promise<UnlistenFn>;
  private ctxFile = true;
  private ctxSel = true;
  private chipTimer = 0;

  constructor(readonly wb: Workbench) {
    this.state = { provider: (pref("provider", "claude") as ProviderId) || "claude", sessions: {}, messages: [] };
    wb.register({
      id: "assistant",
      title: "Assistente IA",
      icon: "aiTw",
      anchor: "right",
      body: this.body,
      actions: () => [
        h("button.icon-btn", { title: "Nova conversa", onclick: () => this.newChat() }, icon("general/add")),
      ],
      onShow: () => setTimeout(() => this.input.focus()),
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.off = listen<{ callId: string; chat: string; name: string; args: Record<string, unknown> }>("assistant-tool-call", (e) => this.onToolCall(e.payload));
    // follows the active editor and selection for the context chips
    this.chipTimer = window.setInterval(() => this.renderChips(), 1500);
    this.render();
    this.load();
  }

  private key() {
    return "assistant-chat-" + P.norm(this.wb.root).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(-100);
  }

  private async load() {
    const saved = await host.loadDoc<ChatState>(this.key()).catch(() => null);
    if (saved?.messages) this.state = { ...saved, provider: saved.provider ?? "claude" };
    this.renderMessages();
    this.renderHeader();
    this.checkCli();
  }

  private save() {
    const s = { ...this.state, messages: this.state.messages.slice(-200) };
    host.saveDoc(this.key(), s).catch(() => {});
  }

  async dispose() {
    await this.agent?.dispose();
    for (const r of this.approvals.values()) r({ behavior: "deny", message: "O plugin foi desativado." });
    if (this.session) await invoke("assistant_close", { token: this.session.token, claudeConfig: this.session.claudeConfig }).catch(() => {});
    await invoke("assistant_release").catch(() => {});
    (await this.off)();
    clearInterval(this.chipTimer);
    this.wb.unregister("assistant");
  }

  // ---------------- UI ----------------

  private header = h("div.ai-head");

  private render() {
    this.sendBtn = h("button.btn.primary.ai-send", { title: "Enviar (Enter)", onclick: () => (this.agent?.busy ? this.stop() : this.submit()) }, icon("general/up")) as HTMLButtonElement;
    this.body.replaceChildren(this.header, this.status, this.list, h("div.ai-composer", null, this.chips, h("div.ai-inputrow", null, this.input, this.sendBtn)));
    this.renderHeader();
    this.renderChips();
  }

  private renderHeader() {
    const p = this.state.provider;
    const seg = h(
      "div.ai-seg",
      null,
      ...(["claude", "codex"] as ProviderId[]).map((id) => h("button", { class: id === p ? "active" : "", onclick: () => this.switchProvider(id) }, PROVIDER_LABEL[id])),
    );
    const model = h("select.input.ai-sel", { title: "Modelo", onchange: (e: Event) => (setPref(`model.${p}`, (e.target as HTMLSelectElement).value), this.restartAgent()) }) as HTMLSelectElement;
    const cur = pref(`model.${p}`, "");
    const opts = p === "claude" ? CLAUDE_MODELS : this.codexModels;
    model.append(...opts.map(([v, l]) => h("option", { value: v, selected: v === cur }, l)));
    const mode = h(
      "select.input.ai-sel",
      { title: "O que o agente pode fazer", onchange: (e: Event) => (setPref("mode", (e.target as HTMLSelectElement).value), this.restartAgent()) },
      ...([
        ["readonly", "Somente leitura"],
        ["ask", p === "claude" ? "Editar com aprovação" : "Editar no projeto"],
        ["auto", p === "claude" ? "Editar automaticamente" : "Editar no projeto"],
      ] as [Mode, string][])
        .filter(([m]) => p === "claude" || m !== "auto")
        .map(([v, l]) => h("option", { value: v, selected: v === pref("mode", "ask") }, l)),
    ) as HTMLSelectElement;
    this.header.replaceChildren(seg, h("div.ai-opts", null, model, mode));
  }

  private codexModels: [string, string][] = [["", "padrão da conta"]];

  private async checkCli() {
    const p = this.state.provider;
    const cli = await locate(p);
    if (!cli) {
      const cmd = p === "claude" ? "npm install -g @anthropic-ai/claude-code" : "npm install -g @openai/codex";
      this.status.replaceChildren(
        h(
          "div.af-warn",
          null,
          icon("status/warning"),
          h(
            "div",
            null,
            `${PROVIDER_LABEL[p]} não foi encontrado. Instale o CLI oficial (usa a sua conta) e faça login: `,
            h("code", null, cmd),
            h("div.ai-acts", null, button("Instalar no terminal", () => this.wb.terminals.newTab(this.wb.root, cmd)), button("Verificar de novo", () => this.checkCli())),
          ),
        ),
      );
      return;
    }
    this.status.replaceChildren(
      h(
        "div.ai-cli",
        null,
        h("span.dim", null, `${PROVIDER_LABEL[p]}: ${cli.via}`),
        h("span.grow"),
        // Claude Code logs in from its interactive session (/login); Codex has "codex login"
        h("button.link", { onclick: () => this.wb.terminals.newTab(this.wb.root, termCommand(cli.program, p === "claude" ? [] : [...cli.prefix, "login"])) }, "Fazer login…"),
      ),
    );
    if (p === "codex" && this.codexModels.length === 1) {
      const r = await host.capture(cli.program, [...cli.prefix, "debug", "models"], this.wb.root, undefined, 60).catch(() => null);
      try {
        const cat = JSON.parse(r?.stdout.slice(r.stdout.indexOf("{")) ?? "");
        const list = (cat.models ?? []).filter((m: any) => m.visibility === "list").map((m: any) => [m.slug, m.display_name ?? m.slug] as [string, string]);
        if (list.length) {
          this.codexModels = [["", "padrão da conta"], ...list];
          this.renderHeader();
        }
      } catch {
        /* older Codex: free text default only */
      }
    }
  }

  private renderChips = () => {
    const ed = this.wb.editors?.active();
    const sel = ed?.view ? ed.view.state.sliceDoc(ed.view.state.selection.main.from, ed.view.state.selection.main.to) : "";
    const chip = (on: boolean, label: string, title: string, toggle: () => void) => h("button.ai-chip", { class: on ? "on" : "", title, onclick: () => (toggle(), this.renderChips()) }, icon(on ? "actions/checked" : "general/add"), label);
    this.chips.replaceChildren(
      ...(ed ? [chip(this.ctxFile, P.base(ed.path), "Enviar o arquivo ativo como contexto", () => (this.ctxFile = !this.ctxFile))] : []),
      ...(sel ? [chip(this.ctxSel, `seleção (${sel.split("\n").length} linhas)`, "Enviar o trecho selecionado", () => (this.ctxSel = !this.ctxSel))] : []),
      h("span.ai-hint", null, "a IDE inteira fica acessível ao agente pelas ferramentas do Rits"),
    );
  };

  private bubble(m: Msg): HTMLElement {
    if (m.role === "tool" && m.tool) {
      const t = m.tool;
      const label = TOOL_LABEL[t.name] ?? t.name.replace(/^mcp__\w+__/, "");
      const inputText = typeof t.input === "string" ? t.input : t.input ? JSON.stringify(t.input, null, 1) : "";
      const brief = (t.input as any)?.file_path ?? (t.input as any)?.command ?? (t.input as any)?.sql ?? (t.input as any)?.path ?? (t.input as any)?.pattern ?? "";
      const det = h("details.ai-tool", { class: t.status }, h("summary", null, h(`span.af-dot.${t.status === "done" ? "success" : t.status === "error" ? "failed" : "running"}` as "span"), h("b", null, label), brief ? h("span.dim.ai-brief", null, String(brief).slice(0, 120)) : ""));
      if (inputText && inputText !== "{}") det.append(h("pre.ai-pre", null, inputText.slice(0, 4000)));
      if (t.output) det.append(h("pre.ai-pre.out", null, t.output));
      return det;
    }
    if (m.role === "user") return h("div.ai-msg.user", null, m.text);
    if (m.role === "info") return h("div.ai-msg.info", null, icon("status/info"), m.text);
    if (m.role === "error") return h("div.ai-msg.error", null, icon("status/error"), h("div", null, m.text));
    const el = h("div.ai-msg.assistant");
    this.renderMarkdown(el, m.text);
    return el;
  }

  private async renderMarkdown(el: HTMLElement, text: string) {
    const { renderMarkdown } = await import("../jupyter/render");
    const md = renderMarkdown(text);
    // code blocks: copy and insert into the active editor
    for (const pre of md.querySelectorAll("pre")) {
      const code = pre.textContent ?? "";
      pre.classList.add("ai-code");
      pre.append(
        h(
          "div.ai-code-acts",
          null,
          h("button.icon-btn", { title: "Copiar", onclick: () => (navigator.clipboard.writeText(code), toast("Copiado", "ok", 1200)) }, icon("general/copy")),
          h("button.icon-btn", { title: "Inserir no cursor do editor ativo", onclick: () => this.insert(code) }, icon("general/add")),
        ),
      );
    }
    el.replaceChildren(md);
  }

  private insert(code: string) {
    const v = this.wb.editors.active()?.view;
    if (!v) return toast("Abra um arquivo no editor para inserir.", "info");
    const s = v.state.selection.main;
    v.dispatch({ changes: { from: s.from, to: s.to, insert: code } });
    v.focus();
  }

  private renderMessages() {
    this.list.replaceChildren(
      ...(this.state.messages.length
        ? this.state.messages.map((m) => this.bubble(m))
        : [
            h(
              "div.ai-empty",
              null,
              icon("ai"),
              h("b", null, "Assistente com o contexto da IDE"),
              h("div.dim", null, `Converse com o seu ${PROVIDER_LABEL[this.state.provider]}. Ele enxerga o projeto, os arquivos abertos, os bancos conectados (somente leitura), as DAGs do Airflow, o dbt, os notebooks, o Docker e as auditorias.`),
              h("div.ai-sugs", null, ...["O que este projeto faz?", "Explique o arquivo aberto", "Quais tabelas existem no banco conectado?", "Por que a última execução do dbt falhou?", "Resuma o estado das DAGs do Airflow"].map((s) => h("button.ai-sug", { onclick: () => ((this.input.value = s), this.submit()) }, s))),
            ),
          ]),
    );
    this.list.scrollTop = this.list.scrollHeight;
  }

  private push(m: Msg) {
    if (!this.state.messages.length) this.list.replaceChildren();
    this.state.messages.push(m);
    const el = this.bubble(m);
    this.list.append(el);
    this.list.scrollTop = this.list.scrollHeight;
    return el;
  }

  private setBusy(on: boolean) {
    this.sendBtn.replaceChildren(icon(on ? "run/stop" : "general/up"));
    this.sendBtn.title = on ? "Parar" : "Enviar (Enter)";
    this.body.classList.toggle("busy", on);
  }

  // ---------------- conversation ----------------

  private switchProvider(p: ProviderId) {
    if (p === this.state.provider) return;
    this.state.provider = p;
    setPref("provider", p);
    this.restartAgent();
    this.renderHeader();
    this.checkCli();
    this.push({ role: "info", text: `Agora com ${PROVIDER_LABEL[p]}. A conversa anterior continua no outro agente.` });
  }

  private async restartAgent() {
    await this.agent?.dispose();
    this.agent = null;
    this.renderHeader();
  }

  private async newChat() {
    if (this.agent?.busy && !(await confirmDialog("Nova conversa", "Parar a resposta em andamento e começar outra conversa?", "Nova conversa"))) return;
    await this.restartAgent();
    this.state = { provider: this.state.provider, sessions: {}, messages: [] };
    this.save();
    this.renderMessages();
  }

  private async ensureAgent(): Promise<Agent | null> {
    if (this.agent) return this.agent;
    const p = this.state.provider;
    const cli = await locate(p);
    if (!cli) {
      this.checkCli();
      return null;
    }
    if (!this.session) {
      const tools = [...TOOLS, APPROVE_TOOL].map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }));
      this.session = await invoke<{ token: string; url: string; claudeConfig: string }>("assistant_open", { chat: this.chatId, tools });
    }
    const opts = { root: this.wb.root, mcpUrl: this.session.url, token: this.session.token, claudeConfig: this.session.claudeConfig, model: pref(`model.${p}`, ""), mode: pref("mode", "ask") as Mode, sessionId: this.state.sessions[p] ?? null, systemPrompt: systemPrompt(this.wb) };
    const emit = (e: AgentEvent) => this.onEvent(e);
    this.agent = p === "claude" ? new ClaudeAgent(cli, opts, emit) : new CodexAgent(cli, opts, emit);
    return this.agent;
  }

  private contextBlock(): string {
    const ed = this.wb.editors.active();
    if (!ed?.view) return "";
    const parts: string[] = [];
    const s = ed.view.state.selection.main;
    const line = ed.view.state.doc.lineAt(s.head).number;
    if (this.ctxFile) parts.push(`Arquivo ativo: ${ed.path} (linha ${line}${ed.dirty ? ", com alterações não salvas" : ""})`);
    const sel = ed.view.state.sliceDoc(s.from, s.to);
    if (sel && this.ctxSel) parts.push(`Trecho selecionado:\n\`\`\`\n${sel.slice(0, 20000)}\n\`\`\``);
    return parts.length ? `[Contexto da IDE]\n${parts.join("\n")}\n\n` : "";
  }

  private async submit() {
    const text = this.input.value.trim();
    if (!text || this.agent?.busy) return;
    const agent = await this.ensureAgent();
    if (!agent) return;
    this.input.value = "";
    this.push({ role: "user", text });
    this.streaming = null;
    this.setBusy(true);
    try {
      await agent.send(this.contextBlock() + text);
    } catch (e) {
      this.setBusy(false);
      this.push({ role: "error", text: String(e) });
    }
    this.save();
  }

  private async stop() {
    await this.agent?.stop();
    for (const r of this.approvals.values()) r({ behavior: "deny", message: "O usuário interrompeu." });
    this.approvals.clear();
  }

  private onEvent(e: AgentEvent) {
    const p = this.state.provider;
    switch (e.kind) {
      case "session":
        this.state.sessions[p] = e.id;
        break;
      case "delta":
        if (!this.streaming) {
          const el = h("div.ai-msg.assistant.streaming");
          if (!this.state.messages.length) this.list.replaceChildren();
          this.list.append(el);
          this.streaming = { el, text: "" };
        }
        this.streaming.text += e.text;
        this.streaming.el.textContent = this.streaming.text;
        this.list.scrollTop = this.list.scrollHeight;
        break;
      case "text":
        if (this.streaming) {
          this.streaming.el.remove();
          this.streaming = null;
        }
        this.push({ role: "assistant", text: e.text });
        break;
      case "thinking":
        break;
      case "tool": {
        const existing = [...this.state.messages].reverse().find((m) => m.tool?.id === e.id);
        if (existing?.tool) {
          existing.tool.status = e.status;
          if (e.output !== undefined) existing.tool.output = e.output;
          if (e.name) existing.tool.name = e.name;
          this.renderMessages();
        } else if (e.name) this.push({ role: "tool", text: "", tool: { id: e.id, name: e.name, input: e.input, status: e.status, output: e.output } });
        break;
      }
      case "info":
        this.push({ role: "info", text: e.text });
        break;
      case "error":
        this.push({ role: "error", text: e.text });
        break;
      case "end":
        if (this.streaming) {
          const t = this.streaming.text;
          this.streaming.el.remove();
          this.streaming = null;
          if (t.trim()) this.push({ role: "assistant", text: t });
        }
        if (e.error) this.push({ role: "error", text: this.explain(e.error) });
        this.setBusy(false);
        this.save();
        break;
    }
  }

  /** Common failures with an action. */
  private explain(err: string) {
    if (/not logged in|login|authenticat|401|invalid api key/i.test(err)) return `${err}\n\nFaça login no CLI (botão "Fazer login…" acima).`;
    if (/model .* not supported|model metadata/i.test(err)) return `${err}\n\nEscolha outro modelo no seletor acima.`;
    return err;
  }

  // ---------------- MCP tool calls ----------------

  private async onToolCall(c: { callId: string; chat: string; name: string; args: Record<string, unknown> }) {
    if (c.chat !== this.chatId) return;
    let result: unknown;
    if (c.name === "approve") {
      const decision = await this.ask(c.args);
      result = { content: [{ type: "text", text: JSON.stringify(decision) }] };
    } else {
      try {
        result = { content: [{ type: "text", text: await runTool(this.wb, c.name, c.args as Record<string, any>) }] };
      } catch (e) {
        result = { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }
    await invoke("assistant_tool_result", { callId: c.callId, result }).catch(() => {});
  }

  /** Permission prompt of Claude Code: shown in the chat; allow / allow for this chat / deny. */
  private ask(a: Record<string, unknown>): Promise<unknown> {
    const tool = String(a.tool_name ?? "");
    const input = (a.input ?? {}) as Record<string, any>;
    if (this.allowAlways.has(tool)) return Promise.resolve({ behavior: "allow", updatedInput: input });
    return new Promise((resolve) => {
      const id = uid();
      const what = TOOL_LABEL[tool] ?? tool;
      const detail = input.command ?? input.file_path ?? input.url ?? input.path ?? "";
      const preview =
        tool === "Edit" && input.old_string !== undefined
          ? h("div.ai-diff", null, h("pre.del", null, String(input.old_string).slice(0, 3000)), h("pre.add", null, String(input.new_string ?? "").slice(0, 3000)))
          : tool === "Write"
            ? h("pre.ai-pre", null, String(input.content ?? "").slice(0, 3000))
            : h("pre.ai-pre", null, JSON.stringify(input, null, 1).slice(0, 3000));
      const done = (r: unknown) => {
        this.approvals.delete(id);
        card.classList.add("answered");
        acts.replaceChildren(h("span.dim", null, (r as { behavior: string }).behavior === "allow" ? "permitido" : "negado"));
        resolve(r);
      };
      const acts = h(
        "div.ai-acts",
        null,
        button("Permitir", () => done({ behavior: "allow", updatedInput: input }), "primary"),
        button(`Sempre permitir ${what} nesta conversa`, () => (this.allowAlways.add(tool), done({ behavior: "allow", updatedInput: input }))),
        button("Negar", () => done({ behavior: "deny", message: "O usuário negou esta ação na IDE." }), "danger"),
      );
      const card = h("div.ai-approve", null, h("div", null, icon("status/warning"), h("b", null, ` ${PROVIDER_LABEL[this.state.provider]} quer: ${what}`), detail ? h("code", null, String(detail).slice(0, 200)) : ""), preview, acts);
      if (!this.state.messages.length) this.list.replaceChildren();
      this.list.append(card);
      this.list.scrollTop = this.list.scrollHeight;
      this.approvals.set(id, done);
      this.wb.show("assistant");
    });
  }
}
