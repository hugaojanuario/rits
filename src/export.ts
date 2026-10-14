import { save } from "@tauri-apps/plugin-dialog";
import { api, type DbKind } from "./api";
import { escapeCsv, quoteIdent, quoteLiteral, timestamp } from "./util";
import { dropdown, toast } from "./ui";
import type { Cell } from "./grid";

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "md" | "html";

export function rowsToInsert(kind: DbKind, table: string, columns: string[], rows: Cell[][]) {
  const cols = columns.map((c) => quoteIdent(kind, c)).join(", ");
  return rows
    .map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v) => quoteLiteral(kind, v)).join(", ")});`)
    .join("\n");
}

export function serialize(fmt: ExportFormat, columns: string[], rows: Cell[][], kind: DbKind, table = "tabela") {
  switch (fmt) {
    case "csv":
      return [columns.map(escapeCsv).join(","), ...rows.map((r) => r.map(escapeCsv).join(","))].join("\r\n");
    case "tsv":
      return [columns.join("\t"), ...rows.map((r) => r.map((v) => v ?? "").join("\t"))].join("\n");
    case "json":
      return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2);
    case "sql":
      return rowsToInsert(kind, table, columns, rows);
    case "md":
      return [
        `| ${columns.join(" | ")} |`,
        `| ${columns.map(() => "---").join(" | ")} |`,
        ...rows.map((r) => `| ${r.map((v) => (v ?? "NULL").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`),
      ].join("\n");
    case "html": {
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      return `<table>\n<tr>${columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>\n${rows
        .map((r) => `<tr>${r.map((v) => `<td>${v === null ? "" : esc(v)}</td>`).join("")}</tr>`)
        .join("\n")}\n</table>`;
    }
  }
}

const LABELS: Record<ExportFormat, string> = {
  csv: "CSV",
  tsv: "TSV",
  json: "JSON",
  sql: "SQL INSERT",
  md: "Markdown",
  html: "HTML",
};

export async function exportToFile(
  fmt: ExportFormat,
  columns: string[],
  rows: Cell[][],
  kind: DbKind,
  baseName: string,
  table?: string,
) {
  const path = await save({
    defaultPath: `${baseName}-${timestamp()}.${fmt === "md" ? "md" : fmt}`,
    filters: [{ name: LABELS[fmt], extensions: [fmt] }],
  });
  if (!path) return;
  const text = serialize(fmt, columns, rows, kind, table ?? quoteIdent(kind, baseName));
  await api.writeTextFile(path, fmt === "csv" ? "﻿" + text : text);
  toast(`${rows.length} linha(s) exportadas para ${path}`, "ok", 5000);
}

export function exportMenu(
  anchor: HTMLElement,
  get: () => { columns: string[]; rows: Cell[][] },
  kind: DbKind,
  baseName: string,
  table?: string,
) {
  dropdown(
    anchor,
    (Object.keys(LABELS) as ExportFormat[]).map((f) => ({
      label: `Exportar ${LABELS[f]}…`,
      action: () => {
        const d = get();
        exportToFile(f, d.columns, d.rows, kind, baseName, table).catch((e) => toast(String(e), "error"));
      },
    })),
  );
}
