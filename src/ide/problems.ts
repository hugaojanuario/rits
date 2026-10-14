// "Problems" tool window: language-server diagnostics plus project inspections (ruff, go vet, staticcheck).
import { h } from "../util";
import { icon, fileIconName } from "../icons";
import { toast } from "../ui";
import { host, P } from "./host";
import { findGo, goTool, pyTool } from "./sdk";
import type { Diag } from "./lsp";
import type { Workbench } from "./workbench";

export class Problems {
  private body = h("div.tree", { tabIndex: 0 });
  private tabsEl = h("div.tw-tabs");
  private view: "file" | "project" | "inspect" = "project";
  private inspected: Diag[] = [];
  private inspecting = false;

  constructor(private wb: Workbench) {
    wb.register({ id: "problems", title: "Problemas", icon: "problems", anchor: "bottom", shortcut: "Alt+6", body: h("div.tw-body", null, this.body), headerTabs: this.tabsEl, onShow: () => this.render() });
    wb.lsp.onDiagnostics(() => {
      this.render();
      wb.editors.refreshTabStates();
      wb.projectView.render();
      const errors = [...wb.lsp.diagnostics.values()].flat().filter((d) => d.severity === 1).length;
      wb.setBadge("problems", errors > 0);
    });
    wb.tabs.bar.addEventListener("mousedown", () => setTimeout(() => this.view === "file" && this.render()));
  }

  private list(): Diag[] {
    if (this.view === "inspect") return this.inspected;
    const all = [...this.wb.lsp.diagnostics.values()].flat();
    if (this.view === "file") {
      const p = this.wb.editors.active()?.path;
      return p ? all.filter((d) => P.same(d.path, p)) : [];
    }
    return all;
  }

  render() {
    const counts = { file: 0, project: [...this.wb.lsp.diagnostics.values()].flat().length, inspect: this.inspected.length };
    const ap = this.wb.editors.active()?.path;
    counts.file = ap ? (this.wb.lsp.diagnostics.get(ap) ?? []).length : 0;
    this.tabsEl.replaceChildren(
      h("div.tw-tab", { class: this.view === "file" ? "active" : "", onclick: () => ((this.view = "file"), this.render()) }, `Arquivo atual ${counts.file || ""}`),
      h("div.tw-tab", { class: this.view === "project" ? "active" : "", onclick: () => ((this.view = "project"), this.render()) }, `Projeto ${counts.project || ""}`),
      h("div.tw-tab", { class: this.view === "inspect" ? "active" : "", onclick: () => ((this.view = "inspect"), this.render()) }, this.inspecting ? "Inspecionando…" : `Inspeção ${counts.inspect || ""}`),
      h("button.icon-btn", { title: "Inspecionar código do projeto", onclick: () => this.inspectProject() }, icon("run/run")),
    );
    if (this.wb.isVisible("problems")) this.wb.refreshHeader("problems");
    const diags = this.list();
    const byFile = new Map<string, Diag[]>();
    for (const d of diags) byFile.set(d.path, [...(byFile.get(d.path) ?? []), d]);
    const rows: HTMLElement[] = [];
    for (const [path, list] of [...byFile.entries()].sort()) {
      list.sort((a, b) => a.severity - b.severity || a.line - b.line);
      rows.push(
        h(
          "div.tree-row",
          { style: "padding-left:8px" },
          h("span.twisty", null, icon("general/chevronDown")),
          icon(fileIconName(P.base(path))),
          h("span.tree-label.problem-file", null, P.base(path)),
          h("span.tree-detail", null, `${P.rel(this.wb.root, P.dir(path))}  ${list.length} problema(s)`),
        ),
      );
      for (const d of list) {
        const row = h(
          "div.tree-row",
          { style: "padding-left:44px", title: d.message },
          icon(d.severity === 1 ? "status/error" : d.severity === 2 ? "status/warning" : "status/info"),
          h("span.tree-label", null, d.message.split("\n")[0]),
          h("span.tree-detail", null, `${d.source ?? ""}${d.code ? ` ${d.code}` : ""} :${d.line}`),
        );
        row.addEventListener("dblclick", () => this.wb.editors.openFile(d.path, { line: d.line, col: d.col }));
        row.addEventListener("click", () => this.wb.editors.openFile(d.path, { line: d.line, col: d.col }));
        rows.push(row);
      }
    }
    if (!rows.length) rows.push(h("div.empty-note", null, this.view === "inspect" ? "Clique em ▶ para inspecionar o projeto (ruff, go vet, staticcheck)." : "Nenhum problema encontrado."));
    this.body.replaceChildren(...rows);
  }

  async inspectProject() {
    if (this.inspecting) return;
    this.inspecting = true;
    this.view = "inspect";
    this.wb.show("problems");
    this.render();
    this.wb.setProgress("inspect", "Inspecionando código");
    const out: Diag[] = [];
    try {
      const ruff = await pyTool("ruff");
      if (ruff) {
        const r = await host.capture(ruff, ["check", "--output-format", "json", "--exit-zero", "."], this.wb.root, undefined, 120);
        try {
          for (const d of JSON.parse(r.stdout || "[]")) {
            const path = P.norm(d.filename);
            out.push({ uri: "", path, line: d.location.row, col: d.location.column, endLine: d.end_location.row, endCol: d.end_location.column, severity: 2, message: d.message, source: "ruff", code: d.code });
          }
        } catch {
          /* no python files */
        }
      }
      const go = await findGo();
      if (go && (await host.exists(P.join(this.wb.root, "go.mod")))) {
        const vet = await host.capture(go.path, ["vet", "./..."], this.wb.root, undefined, 180);
        out.push(...parseGoOutput(vet.stderr, this.wb.root, "go vet", 2));
        const sc = await goTool("staticcheck");
        if (sc) {
          const r = await host.capture(sc, ["./..."], this.wb.root, undefined, 180);
          out.push(...parseGoOutput(r.stdout, this.wb.root, "staticcheck", 2));
        }
      }
      if (!ruff && !go) toast("Instale os plugins (Ruff / Go) em Configurações › Plugins para inspecionar.", "info");
    } finally {
      this.inspected = out;
      this.inspecting = false;
      this.wb.setProgress("inspect", null);
      this.render();
    }
  }
}

function parseGoOutput(text: string, root: string, source: string, severity: number): Diag[] {
  const out: Diag[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(?:vet: )?([^:#][^:]*\.go):(\d+):(\d+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const path = /^[A-Za-z]:/.test(m[1]) ? P.norm(m[1]) : P.join(root, m[1].replace(/^\.\//, ""));
    const codeM = /\((\w+)\)$/.exec(m[4]);
    out.push({ uri: "", path, line: Number(m[2]), col: Number(m[3]), endLine: Number(m[2]), endCol: Number(m[3]), severity, message: m[4].replace(/\s*\(\w+\)$/, ""), source, code: codeM?.[1] });
  }
  return out;
}
