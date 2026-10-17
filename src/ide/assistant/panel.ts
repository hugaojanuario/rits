// AI assistant tool window: a chat with the user's Claude Code or Codex, with the IDE as context
// (local MCP server: project, editors, databases, Airflow, dbt, Jupyter, Docker, audits).
// Sensitive actions of Claude Code (editing files, running commands) are approved in the chat.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { h, uid } from "../../util";
import { fileIconName, icon } from "../../icons";
import { button, confirmDialog, contextMenu, promptDialog, toast } from "../../ui";
import { host, IS_WIN, P } from "../host";
import { fuzzyScore, projectFiles } from "../search";
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

/** Claude Code models: aliases follow the newest version; full names pin one. */
const CLAUDE_MODELS: { group: string; items: [string, string][] }[] = [
  { group: "Sempre o mais recente", items: [["fable", "Fable"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]] },
  { group: "Versão fixa", items: [["claude-fable-5-1", "Fable 5.1"], ["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-5-5", "Haiku 5.5"]] },
];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LABEL: Record<string, string> = { none: "nenhum", minimal: "mínimo", low: "baixo", medium: "médio", high: "alto", xhigh: "muito alto", max: "máximo", ultra: "ultra" };
const CUSTOM = "__custom";

const SPEECH_LANGS: [string, string][] = [["pt-BR", "Português (Brasil)"], ["pt-PT", "Português (Portugal)"], ["en-US", "English (US)"], ["en-GB", "English (UK)"], ["es-ES", "Español"]];

interface CodexModel {
  slug: string;
  label: string;
  levels: string[];
  def: string;
}

/** An entry of the "/" menu (assistant_commands + what the CLI reported + local commands). */
interface SlashCmd {
  name: string;
  description: string;
  kind: "command" | "skill" | "prompt" | "builtin" | "local";
  source: string;
  path: string;
}

interface Suggestion {
  label: string;
  detail: string;
  tag?: string;
  icon: string;
  insert: string;
}
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
  private input = h("textarea.ai-input", { rows: 3, placeholder: "Pergunte sobre o projeto, os dados, as DAGs… (/ comandos e skills · @ arquivos · Enter envia)" }) as HTMLTextAreaElement;
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
  /** model reported by the running agent */
  private activeModel = "";
  private codexModels: CodexModel[] = [];
  private cliVia = "";
  private commands: Partial<Record<ProviderId, SlashCmd[]>> = {};
  private sug = h("div.ai-suggest");
  private sugItems: Suggestion[] = [];
  private sugIdx = 0;
  private sugRange: { from: number; to: number } | null = null;
  private micBtn!: HTMLButtonElement;
  private dictation: { base: string; off: Promise<UnlistenFn>; stopping?: boolean } | null = null;

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
      if (this.sugItems.length && this.sugKey(e)) return;
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener("input", () => this.updateSuggest());
    this.input.addEventListener("click", () => this.updateSuggest());
    this.input.addEventListener("blur", () => setTimeout(() => this.closeSuggest(), 150));
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
    await this.stopDictation(true);
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
    this.micBtn = h(
      "button.icon-btn.ai-mic",
      { title: "Ditar: clique e fale; clique de novo para parar (botão direito: idioma)", onclick: () => this.toggleDictation(), oncontextmenu: (e: MouseEvent) => (e.preventDefault(), this.speechMenu(e)) },
      icon("mic"),
    ) as HTMLButtonElement;
    this.body.replaceChildren(this.header, this.status, this.list, h("div.ai-composer", null, this.chips, h("div.ai-inputwrap", null, this.sug, h("div.ai-inputrow", null, this.input, h("div.ai-btns", null, this.micBtn, this.sendBtn)))));
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
    const cur = pref(`model.${p}`, "");
    const model = h("select.input.ai-sel", { title: "Modelo e versão", onchange: (e: Event) => this.pickModel((e.target as HTMLSelectElement).value) }) as HTMLSelectElement;
    const groups = p === "claude" ? CLAUDE_MODELS : this.codexModels.length ? [{ group: "Modelos da conta", items: this.codexModels.map((m) => [m.slug, m.label] as [string, string]) }] : [];
    const known = !cur || groups.some((g) => g.items.some(([v]) => v === cur));
    const opt = ([v, l]: [string, string]) => h("option", { value: v, selected: v === cur }, l);
    model.append(
      opt(["", "Modelo: padrão da conta"]),
      ...groups.map((g) => h("optgroup", { label: g.group }, ...g.items.map(opt))),
      ...(known ? [] : [h("optgroup", { label: "Personalizado" }, opt([cur, cur]))]),
      opt([CUSTOM, "Outro modelo…"]),
    );
    const levels = this.effortLevels(p, cur);
    const effCur = pref(`effort.${p}`, "");
    const def = p === "codex" ? this.codexModels.find((m) => m.slug === cur)?.def : undefined;
    const effort = h(
      "select.input.ai-sel",
      { title: "Esforço de raciocínio: mais esforço pensa mais antes de responder (mais lento e consome mais da sua cota)", onchange: (e: Event) => this.pickEffort((e.target as HTMLSelectElement).value) },
      h("option", { value: "", selected: !effCur }, `Esforço: padrão${def ? ` (${EFFORT_LABEL[def] ?? def})` : ""}`),
      ...levels.map((l) => h("option", { value: l, selected: l === effCur }, `Esforço: ${EFFORT_LABEL[l] ?? l}`)),
    ) as HTMLSelectElement;
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
    this.header.replaceChildren(seg, h("div.ai-opts", null, model, effort, mode));
  }

  /** Effort levels for the model (Codex: from its catalog; account default: every level offered). */
  private effortLevels(p: ProviderId, model: string): string[] {
    if (p === "claude") return CLAUDE_EFFORTS;
    const m = this.codexModels.find((x) => x.slug === model);
    if (m?.levels.length) return m.levels;
    const all = [...new Set(this.codexModels.flatMap((x) => x.levels))];
    return all.length ? all : ["low", "medium", "high"];
  }

  private async pickModel(v: string) {
    const p = this.state.provider;
    if (v === CUSTOM) {
      const id = (await promptDialog("Outro modelo", p === "claude" ? "Nome completo do modelo (ex.: claude-opus-5-5) ou um alias aceito pelo Claude Code" : "Identificador do modelo do Codex", pref(`model.${p}`, "")))?.trim();
      if (!id) return this.renderHeader();
      v = id;
    }
    setPref(`model.${p}`, v);
    // an effort the new model does not support would make the CLI fail
    const eff = pref(`effort.${p}`, "");
    if (eff && !this.effortLevels(p, v).includes(eff)) setPref(`effort.${p}`, "");
    this.activeModel = "";
    await this.restartAgent();
    this.renderStatusLine();
  }

  private async pickEffort(v: string) {
    setPref(`effort.${this.state.provider}`, v);
    await this.restartAgent();
    this.renderStatusLine();
  }

  private async checkCli() {
    const p = this.state.provider;
    const cli = await locate(p);
    if (!cli) {
      this.cliVia = "";
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
    this.cliVia = cli.via;
    this.renderStatusLine();
    if (p === "codex" && !this.codexModels.length) {
      const r = await host.capture(cli.program, [...cli.prefix, "debug", "models"], this.wb.root, undefined, 60).catch(() => null);
      try {
        const cat = JSON.parse(r?.stdout.slice(r.stdout.indexOf("{")) ?? "");
        this.codexModels = (cat.models ?? [])
          .filter((m: any) => m.visibility === "list")
          .map((m: any) => ({ slug: String(m.slug), label: String(m.display_name ?? m.slug), levels: (m.supported_reasoning_levels ?? []).map((l: any) => String(l.effort ?? l)).filter(Boolean), def: String(m.default_reasoning_level ?? "") }));
        this.renderHeader();
      } catch {
        /* older Codex: only the account default */
      }
    }
  }

  /** CLI location, the model and effort in use, and the login shortcut. */
  private renderStatusLine() {
    const p = this.state.provider;
    if (!this.cliVia) return;
    const model = this.activeModel || pref(`model.${p}`, "") || "modelo padrão da conta";
    const eff = pref(`effort.${p}`, "");
    this.status.replaceChildren(
      h(
        "div.ai-cli",
        null,
        h("span.dim", { title: `${this.cliVia}${this.activeModel ? "\nModelo informado pelo agente na última resposta." : ""}` }, `${PROVIDER_LABEL[p]} · ${model}${eff ? ` · esforço ${EFFORT_LABEL[eff] ?? eff}` : ""}`),
        h("span.grow"),
        // Claude Code logs in from its interactive session (/login); Codex has "codex login"
        h("button.link", { onclick: () => locate(p).then((cli) => cli && this.wb.terminals.newTab(this.wb.root, termCommand(cli.program, p === "claude" ? [] : [...cli.prefix, "login"]))) }, "Fazer login…"),
      ),
    );
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
    this.activeModel = "";
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
    const opts = { root: this.wb.root, mcpUrl: this.session.url, token: this.session.token, claudeConfig: this.session.claudeConfig, model: pref(`model.${p}`, ""), effort: pref(`effort.${p}`, ""), mode: pref("mode", "ask") as Mode, sessionId: this.state.sessions[p] ?? null, systemPrompt: systemPrompt(this.wb) };
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
    if (this.dictation) await this.stopDictation(true);
    this.closeSuggest();
    const text = this.input.value.trim();
    if (!text || this.agent?.busy) return;
    if (/^\/(clear|nova)\s*$/.test(text)) {
      this.input.value = "";
      return this.newChat();
    }
    const agent = await this.ensureAgent();
    if (!agent) return;
    this.input.value = "";
    this.push({ role: "user", text });
    this.streaming = null;
    this.setBusy(true);
    try {
      const prompt = await this.expandCommand(text);
      const mentions = await this.mentionBlock(text);
      // a slash command only works at the very start of the message (Claude Code)
      await agent.send(prompt.startsWith("/") ? `${prompt}\n\n${this.contextBlock()}${mentions}`.trim() : this.contextBlock() + mentions + prompt);
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
      case "init":
        this.activeModel = e.model;
        this.renderStatusLine();
        if (e.commands.length) {
          setPref("cliCommands", JSON.stringify(e.commands));
          delete this.commands.claude;
        }
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

  // ---------------- "/" commands and "@" files ----------------

  private async loadCommands(): Promise<SlashCmd[]> {
    const p = this.state.provider;
    const have = this.commands[p];
    if (have) return have;
    const found = await invoke<SlashCmd[]>("assistant_commands", { root: this.wb.root, provider: p }).catch(() => [] as SlashCmd[]);
    const list: SlashCmd[] = [{ name: "clear", description: "Começa uma nova conversa", kind: "local", source: "Rits", path: "" }, ...found];
    if (p === "claude") {
      // what the CLI reported in its last start: built-in commands and plugins we did not scan
      let names: string[] = [];
      try {
        names = JSON.parse(pref("cliCommands", "[]"));
      } catch {
        /* ignore */
      }
      const seen = new Set(list.map((c) => c.name));
      for (const n of names) if (!seen.has(n)) list.push({ name: n, description: "", kind: "builtin", source: "Claude Code", path: "" });
    }
    this.commands[p] = list;
    return list;
  }

  /** Codex has no slash commands in `exec`: skills become "$skill", saved prompts are expanded. */
  private async expandCommand(text: string): Promise<string> {
    const m = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!m || this.state.provider !== "codex") return text;
    const cmd = (await this.loadCommands()).find((c) => c.name === m[1]);
    if (!cmd) return text;
    const args = (m[2] ?? "").trim();
    if (cmd.kind === "skill") return `$${cmd.name}${args ? " " + args : ""}`;
    if (cmd.kind !== "prompt") return text;
    const f = await host.read(cmd.path).catch(() => null);
    if (!f || f.binary) return text;
    const body = f.text.replace(/^\ufeff?---[\s\S]*?\n---\s*\n?/, "");
    const pos = args.split(/\s+/).filter(Boolean);
    const out = body.replace(/\$ARGUMENTS/g, args).replace(/\$([1-9])/g, (_, i) => pos[Number(i) - 1] ?? "");
    return out.includes(args) || !args ? out : `${out}\n\n${args}`;
  }

  /** "@path" mentions: the files' text (unsaved edits included) goes with the message. */
  private async mentionBlock(text: string): Promise<string> {
    const refs = [...text.matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s"]+))/g)].map((m) => (m[1] ?? m[2]).replace(/[.,;:!?)]+$/, ""));
    if (!refs.length) return "";
    const files = await projectFiles(this.wb).catch(() => [] as string[]);
    const byRel = new Map(files.map((f) => [P.rel(this.wb.root, f).toLowerCase(), f]));
    const parts: string[] = [];
    let budget = 150_000;
    for (const ref of [...new Set(refs)]) {
      const rel = ref.replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
      const file = byRel.get(rel);
      if (file) {
        const ed = this.wb.editors.get(file);
        const t = ed?.view ? ed.view.state.doc.toString() : await host.read(file).then((r) => (r.binary || r.tooLarge ? null : r.text)).catch(() => null);
        if (t === null || t === undefined) {
          parts.push(`- ${file} (binário ou grande demais: leia com as ferramentas se precisar)`);
        } else if (t.length > Math.min(budget, 60_000)) {
          parts.push(`- ${file} (${t.split("\n").length} linhas; grande demais para enviar inteiro: leia com as ferramentas)`);
        } else {
          budget -= t.length;
          parts.push(`- ${file}${ed?.dirty ? " (com alterações não salvas)" : ""}:\n\`\`\`\n${t}\n\`\`\``);
        }
        continue;
      }
      const inDir = files.filter((f) => P.rel(this.wb.root, f).toLowerCase().startsWith(rel + "/"));
      if (inDir.length) parts.push(`- pasta ${P.join(this.wb.root, ref.replace(/\/$/, ""))} (${inDir.length} ${inDir.length === 1 ? "arquivo" : "arquivos"}), por exemplo: ${inDir.slice(0, 30).map((f) => P.rel(this.wb.root, f)).join(", ")}`);
    }
    return parts.length ? `[Arquivos mencionados com @]\n${parts.join("\n")}\n\n` : "";
  }

  private async updateSuggest() {
    const el = this.input;
    const pos = el.selectionStart ?? el.value.length;
    if (el.selectionEnd !== pos) return this.closeSuggest();
    const before = el.value.slice(0, pos);
    const cmd = /^\/([^\s]*)$/.exec(before);
    const file = cmd ? null : /(?:^|\s)@([^\s@"]*)$/.exec(before);
    if (!cmd && !file) return this.closeSuggest();
    const q = (cmd ?? file)![1].toLowerCase();
    const from = pos - q.length - 1;
    let items: Suggestion[];
    if (cmd) {
      const list = await this.loadCommands();
      const KIND: Record<SlashCmd["kind"], [string, string]> = { command: ["nodes/function", "comando"], skill: ["actions/lightning", "skill"], prompt: ["nodes/function", "prompt"], builtin: ["ai", "Claude Code"], local: ["general/add", "Rits"] };
      items = list
        .map((c) => ({ c, score: q ? Math.max(fuzzyScore(c.name, q) * 2, fuzzyScore(c.description, q) / 4) : 1 }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 60)
        .map(({ c }) => ({ label: `/${c.name}`, detail: c.description, tag: c.kind === "builtin" || c.kind === "local" ? KIND[c.kind][1] : `${KIND[c.kind][1]} · ${c.source}`, icon: KIND[c.kind][0], insert: `/${c.name} ` }));
      if (!items.length) items = [{ label: "Nenhum comando ou skill", detail: this.state.provider === "claude" ? "Crie em .claude/commands ou .claude/skills (projeto ou ~/.claude)" : "Crie skills em .agents/skills (projeto ou ~/.agents) ou prompts em ~/.codex/prompts", icon: "status/info", insert: "" }];
    } else {
      const files = await projectFiles(this.wb).catch(() => [] as string[]);
      const rels = files.map((f) => P.rel(this.wb.root, f));
      const dirs = new Set<string>();
      for (const r of rels) for (let i = r.indexOf("/"); i > 0; i = r.indexOf("/", i + 1)) dirs.add(r.slice(0, i) + "/");
      const open = new Set(this.wb.editors.all().map((e) => P.rel(this.wb.root, e.path)));
      const quote = (r: string) => (/\s/.test(r) ? `@"${r}" ` : `@${r} `);
      const score = (r: string) => {
        if (!q) return open.has(r) ? 100 : r.startsWith(".") ? 0.5 : r.includes("/") ? 1 : 2;
        const base = r.replace(/\/$/, "").split("/").pop()!;
        return Math.max(fuzzyScore(base, q) * 2, fuzzyScore(r, q)) + (open.has(r) ? 20 : 0);
      };
      items = [...rels, ...dirs]
        .map((r) => ({ r, s: score(r) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.r.length - b.r.length)
        .slice(0, 60)
        .map(({ r }) => {
          const dir = r.endsWith("/");
          const base = r.replace(/\/$/, "").split("/").pop()!;
          return { label: base + (dir ? "/" : ""), detail: r, tag: open.has(r) ? "aberto" : undefined, icon: dir ? "nodes/folder" : fileIconName(base), insert: quote(r) };
        });
      if (!items.length) items = [{ label: "Nenhum arquivo encontrado", detail: q, icon: "status/info", insert: "" }];
    }
    // the input may have changed while the list was loading
    if (el.value.slice(0, pos) !== before) return;
    this.sugItems = items;
    this.sugRange = { from, to: pos };
    this.sugIdx = 0;
    this.renderSuggest();
  }

  private renderSuggest() {
    this.sug.replaceChildren(
      ...this.sugItems.map((it, i) =>
        h(
          "div.ai-sug-item",
          { class: i === this.sugIdx ? "sel" : "", onmousedown: (e: MouseEvent) => (e.preventDefault(), this.acceptSuggest(i)), onmousemove: () => i !== this.sugIdx && ((this.sugIdx = i), this.renderSuggest()) },
          icon(it.icon),
          h("b", null, it.label),
          h("span.dim", null, it.detail),
          it.tag ? h("span.ai-sug-tag", null, it.tag) : "",
        ),
      ),
    );
    this.sug.classList.toggle("open", this.sugItems.length > 0);
    (this.sug.children[this.sugIdx] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }

  private closeSuggest() {
    this.sugItems = [];
    this.sugRange = null;
    this.sug.classList.remove("open");
    this.sug.replaceChildren();
  }

  private sugKey(e: KeyboardEvent): boolean {
    const n = this.sugItems.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      this.sugIdx = (this.sugIdx + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      this.renderSuggest();
    } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      if (!this.sugItems[this.sugIdx]?.insert) return false;
      this.acceptSuggest(this.sugIdx);
    } else if (e.key === "Escape") {
      this.closeSuggest();
    } else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  private acceptSuggest(i: number) {
    const it = this.sugItems[i];
    const r = this.sugRange;
    if (!it?.insert || !r) return;
    const v = this.input.value;
    const rest = v.slice(r.to).replace(/^\S*/, "");
    this.input.value = v.slice(0, r.from) + it.insert + rest.replace(/^ /, "");
    const caret = r.from + it.insert.length;
    this.input.setSelectionRange(caret, caret);
    this.input.focus();
    this.closeSuggest();
    // a folder keeps the menu open on its contents
    if (it.insert.endsWith("/ ")) {
      this.input.value = this.input.value.slice(0, caret - 1) + this.input.value.slice(caret);
      this.input.setSelectionRange(caret - 1, caret - 1);
      this.updateSuggest();
    }
  }

  // ---------------- dictation ----------------

  private async toggleDictation() {
    if (this.dictation && !this.dictation.stopping) return this.stopDictation(false);
    // stopped a moment ago and still waiting for the final text: start over now
    if (this.dictation) this.endDictation();
    const lang = pref("speechLang", "pt-BR");
    const v = this.input.value;
    const base = v && !/\s$/.test(v) ? v + " " : v;
    const off = listen<{ kind: "text" | "end" | "error"; text: string; final: boolean }>("speech", (e) => {
      if (!this.dictation) return;
      const d = e.payload;
      if (d.kind === "text") {
        this.input.value = this.dictation.base + d.text;
        this.input.scrollTop = this.input.scrollHeight;
      } else {
        if (d.kind === "error") toast(d.text, "error", 8000);
        this.endDictation();
      }
    });
    this.dictation = { base, off };
    this.micBtn.classList.add("on");
    this.micBtn.title = "Ouvindo… clique para parar";
    this.input.placeholder = "Ouvindo… fale agora";
    try {
      await invoke("speech_start", { lang });
      this.input.focus();
    } catch (e) {
      this.endDictation();
      toast(String(e), "error", 9000);
    }
  }

  /** cancel: the final text is not awaited (plugin disposed). */
  private async stopDictation(cancel: boolean) {
    if (!this.dictation) return;
    this.dictation.stopping = true;
    this.micBtn.classList.remove("on");
    await invoke("speech_stop").catch(() => {});
    // the final text arrives right after the stop; on cancel (or if it never comes) end now
    if (cancel) this.endDictation();
    else {
      const d = this.dictation;
      setTimeout(() => this.dictation === d && this.endDictation(), 2500);
    }
  }

  private endDictation() {
    const d = this.dictation;
    if (!d) return;
    this.dictation = null;
    d.off.then((f) => f());
    this.micBtn.classList.remove("on");
    this.micBtn.title = "Ditar: clique e fale; clique de novo para parar (botão direito: idioma)";
    this.input.placeholder = "Pergunte sobre o projeto, os dados, as DAGs… (/ comandos e skills · @ arquivos · Enter envia)";
  }

  private speechMenu(e: MouseEvent) {
    const cur = pref("speechLang", "pt-BR");
    contextMenu(e.clientX, e.clientY, [{ label: "Idioma do ditado", disabled: true }, ...SPEECH_LANGS.map(([v, l]) => ({ label: l, icon: v === cur ? "actions/checked" : undefined, action: () => setPref("speechLang", v) }))]);
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
