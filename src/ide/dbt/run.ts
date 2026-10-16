// A dbt execution as an editor tab: live log (dbt's JSON log lines rendered as messages), node
// states, duration, result and exit code, and cancellation. One run at a time per project (the
// backend refuses a second one while target/ is in use).
import { h, uid } from "../../util";
import { icon } from "../../icons";
import { toast } from "../../ui";
import type { Tab } from "../../tabs";
import { on, type ProcExit, type ProcOut } from "../host";
import type { Workbench } from "../workbench";
import { dbt, errText, type RunSpec } from "./api";

interface NodeLive {
  id: string;
  name: string;
  type: string;
  status: string;
  started?: number;
  time?: number;
  path?: string;
}

const STATUS_CLS: Record<string, string> = { success: "success", pass: "success", fail: "failed", error: "failed", "runtime error": "failed", skipped: "skipped", warn: "queued", started: "running", executing: "running", compiling: "running" };

export class DbtRunTab {
  readonly procId = "dbt-" + uid();
  tab: Tab;
  private el = h("div.afd.dbt-run");
  private head = h("div.afd-head");
  private nodesEl = h("div.dbt-nodes");
  private log = h("pre.afd-log.dbt-log");
  private nodes = new Map<string, NodeLive>();
  private started = Date.now();
  private timer = 0;
  private running = true;
  private code: number | null = null;
  private off: (() => void)[] = [];
  private buf = "";
  private textMode: boolean;

  constructor(
    private wb: Workbench,
    private spec: RunSpec,
    private display: string,
    private onDone: (code: number | null) => void,
  ) {
    this.textMode = spec.command === "docs-serve" || spec.command === "init" || spec.command === "ls";
    this.tab = {
      id: "dbt-run:" + this.procId,
      title: `dbt ${spec.command.replace("-", " ")}`,
      icon: "dbt",
      el: this.el,
      canClose: async () => {
        if (this.running) await this.cancel();
        return true;
      },
      onClose: () => this.off.forEach((f) => f()),
    };
    this.el.append(this.head, h("div.dbt-run-body", null, this.nodesEl, this.log));
    this.renderHead();
  }

  async start(): Promise<boolean> {
    this.off.push(
      on<ProcOut>("proc-out", this.procId, (e) => this.onOut(e.data)),
      on<ProcExit>("proc-exit", this.procId, (e) => this.finish(e.code)),
    );
    this.wb.tabs.open(this.tab);
    this.timer = window.setInterval(() => this.renderHead(), 1000);
    try {
      await dbt.run(this.procId, this.spec);
      return true;
    } catch (e) {
      this.line(errText(e), "error");
      this.finish(null, errText(e));
      return false;
    }
  }

  async cancel() {
    if (!this.running) return;
    await dbt.cancel(this.procId).catch(() => {});
    this.line("Execução cancelada pelo usuário. Alterações já aplicadas no banco por nós concluídos não são desfeitas.", "warn");
    this.finish(null, "cancelada");
  }

  get isRunning() {
    return this.running;
  }

  private finish(code: number | null, why?: string) {
    if (!this.running) return;
    this.running = false;
    this.code = code;
    clearInterval(this.timer);
    this.renderHead(why);
    this.onDone(code);
  }

  private onOut(data: string) {
    this.buf += data;
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop() ?? "";
    for (const l of lines) this.handle(l);
  }

  private handle(l: string) {
    if (!l.trim()) return;
    if (!this.textMode && l.trimStart().startsWith("{")) {
      try {
        const j = JSON.parse(l);
        const info = j.info ?? {};
        const ni = j.data?.node_info;
        if (ni?.unique_id) {
          const n: NodeLive = this.nodes.get(ni.unique_id) ?? { id: ni.unique_id, name: ni.node_name ?? ni.unique_id, type: ni.resource_type ?? "", status: "" };
          n.status = ni.node_status && ni.node_status !== "None" ? ni.node_status : n.status;
          // result events (LogTestResult, LogModelResult...) carry the final status
          if (typeof j.data?.status === "string" && /Result$/.test(info.name ?? "")) n.status = j.data.status.toLowerCase();
          if (ni.node_started_at && !n.started) n.started = Date.parse(ni.node_started_at);
          if (ni.node_finished_at && n.started) n.time = (Date.parse(ni.node_finished_at) - n.started) / 1000;
          n.path = ni.node_path ?? n.path;
          this.nodes.set(n.id, n);
          this.renderNodes();
        }
        const msg = (info.msg ?? "").replace(/\x1b\[[0-9;]*m/g, "");
        if (msg) this.line(msg, info.level ?? "info");
        return;
      } catch {
        /* plain line */
      }
    }
    this.line(l.replace(/\x1b\[[0-9;]*m/g, ""), /error|erro/i.test(l) ? "error" : "info");
  }

  private line(t: string, level: string) {
    const atEnd = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 30;
    this.log.append(h(`span.afl-${level}` as "span", null, t + "\n"));
    if (this.log.childElementCount > 20000) this.log.firstElementChild?.remove();
    if (atEnd) this.log.scrollTop = this.log.scrollHeight;
  }

  private renderNodes() {
    const rows = [...this.nodes.values()];
    this.nodesEl.replaceChildren(
      ...rows.map((n) =>
        h(
          "div.dbt-node",
          { title: n.id, onclick: () => this.openNode(n) },
          h(`span.af-dot.${STATUS_CLS[n.status] ?? ""}` as "span"),
          h("span.dbt-node-name", null, n.name),
          h("span.dim", null, n.type),
          h("span.grow"),
          h(`span.af-state.${STATUS_CLS[n.status] ?? ""}` as "span", null, n.status || "…"),
          h("span.dim.dbt-time", null, n.time != null ? `${n.time.toFixed(1)}s` : ""),
        ),
      ),
    );
  }

  /** The panel resolves the node's file from the manifest. */
  private openNode(n: NodeLive) {
    window.dispatchEvent(new CustomEvent("rits-dbt-open-node", { detail: n.id }));
  }

  private renderHead(why?: string) {
    const secs = Math.round((Date.now() - this.started) / 1000);
    const dur = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
    const ok = !this.running && this.code === 0;
    const state = this.running ? "em execução" : ok ? "concluída" : why === "cancelada" ? "cancelada" : "falhou";
    const counts = [...this.nodes.values()].reduce<Record<string, number>>((a, n) => ((a[n.status] = (a[n.status] ?? 0) + 1), a), {});
    this.head.replaceChildren(
      h("div.afd-title", null, icon("dbt"), h("b", null, this.display), h(`span.af-state.${this.running ? "running" : ok ? "success" : "failed"}` as "span", null, state), h("span.grow"), this.running ? h("button.btn", { onclick: () => this.cancel() }, icon("run/stop"), "Cancelar") : ""),
      h(
        "div.afd-meta",
        null,
        h("span.afd-kv", null, h("span.dim", null, "duração"), dur),
        h("span.afd-kv", null, h("span.dim", null, "target"), this.spec.target || "padrão do perfil"),
        h("span.afd-kv", null, h("span.dim", null, "seleção"), this.spec.select?.length ? this.spec.select.join(" ") : "projeto inteiro"),
        this.spec.fullRefresh ? h("span.af-badge.err", null, "--full-refresh") : "",
        !this.running ? h("span.afd-kv", null, h("span.dim", null, "código de saída"), this.code === null ? "—" : String(this.code)) : "",
        ...Object.entries(counts).map(([k, v]) => h("span.afd-kv", null, h("span.dim", null, k || "?"), String(v))),
      ),
    );
    if (!this.running && this.code !== 0 && why !== "cancelada") toast(`dbt ${this.spec.command} terminou com falhas (código ${this.code ?? "?"})`, "error");
  }
}
