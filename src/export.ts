import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, type DbKind } from "./api";
import { escapeCsv, h, quoteIdent, quoteLiteral, timestamp, uid } from "./util";
import { contextMenu, notify, toast, type MenuItem } from "./ui";
import type { Cell } from "./grid";

export type ExportFormat = "csv" | "tsv" | "json" | "jsonl" | "xml" | "xlsx" | "sql" | "md" | "html";

export function rowsToInsert(kind: DbKind, table: string, columns: string[], rows: Cell[][]) {
  const cols = columns.map((c) => quoteIdent(kind, c)).join(", ");
  return rows
    .map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v) => quoteLiteral(kind, v)).join(", ")});`)
    .join("\n");
}

const xmlEsc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // characters XML 1.0 does not allow
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "�");

export function serialize(fmt: Exclude<ExportFormat, "xlsx">, columns: string[], rows: Cell[][], kind: DbKind, table = "tabela") {
  switch (fmt) {
    case "csv":
      return [columns.map(escapeCsv).join(","), ...rows.map((r) => r.map(escapeCsv).join(","))].join("\r\n");
    case "tsv":
      return [columns.join("\t"), ...rows.map((r) => r.map((v) => (v ?? "").replace(/[\t\r\n]/g, " ")).join("\t"))].join("\n");
    case "json":
      return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2);
    case "jsonl":
      return rows.map((r) => JSON.stringify(Object.fromEntries(columns.map((c, i) => [c, r[i]])))).join("\n") + "\n";
    case "xml":
      return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<resultado>\n' +
        rows
          .map((r) => "  <linha>\n" + columns.map((c, i) => (r[i] === null ? `    <campo nome="${xmlEsc(c)}" nulo="true"/>` : `    <campo nome="${xmlEsc(c)}">${xmlEsc(r[i]!)}</campo>`)).join("\n") + "\n  </linha>")
          .join("\n") +
        "\n</resultado>\n"
      );
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

// ---------------- XLSX (Office Open XML, zip without compression) ----------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal zip (stored entries) — enough for an .xlsx package. */
export function zipStore(files: [string, string][]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = enc.encode(text);
    const nm = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(local.buffer), nm, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nm.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nm);
    offset += 30 + nm.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

const colName = (i: number) => {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};

/** One-sheet workbook: header in bold, numbers as numbers, everything else as inline text. */
export function toXlsx(columns: string[], rows: Cell[][]): Uint8Array {
  const num = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;
  const cell = (v: Cell, r: number, c: number, header = false) => {
    const ref = `${colName(c)}${r}`;
    if (v === null) return "";
    if (!header && num.test(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ""}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  };
  const sheetRows = [`<row r="1">${columns.map((c, i) => cell(c, 1, i, true)).join("")}</row>`, ...rows.map((r, ri) => `<row r="${ri + 2}">${r.map((v, ci) => cell(v, ri + 2, ci)).join("")}</row>`)];
  return zipStore([
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Resultado" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ["xl/styles.xml", '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${sheetRows.join("")}</sheetData></worksheet>`],
  ]);
}

function toBase64(b: Uint8Array) {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

const LABELS: Record<ExportFormat, string> = {
  csv: "CSV",
  tsv: "TSV",
  json: "JSON",
  jsonl: "JSON Lines",
  xml: "XML",
  xlsx: "Excel (.xlsx)",
  sql: "SQL INSERT",
  md: "Markdown",
  html: "HTML",
};
const EXT: Record<ExportFormat, string> = { csv: "csv", tsv: "tsv", json: "json", jsonl: "jsonl", xml: "xml", xlsx: "xlsx", sql: "sql", md: "md", html: "html" };

export async function exportToFile(fmt: ExportFormat, columns: string[], rows: Cell[][], kind: DbKind, baseName: string, table?: string) {
  const path = await save({ defaultPath: `${baseName}-${timestamp()}.${EXT[fmt]}`, filters: [{ name: LABELS[fmt], extensions: [EXT[fmt]] }] });
  if (!path) return;
  if (fmt === "xlsx") {
    if (rows.length > 1_048_575) return toast("O Excel aceita no máximo 1.048.576 linhas por planilha.", "error");
    await invoke("write_base64_file", { path, data: toBase64(toXlsx(columns, rows)) });
  } else {
    const text = serialize(fmt, columns, rows, kind, table ?? quoteIdent(kind, baseName));
    await api.writeTextFile(path, fmt === "csv" ? "﻿" + text : text);
  }
  toast(`${rows.length.toLocaleString("pt-BR")} linha(s) exportadas para ${path}`, "ok", 5000);
}

/** Full result of a query, streamed by the backend (no grid limit). */
export async function exportFullQuery(fmt: Exclude<ExportFormat, "xlsx" | "md" | "html">, connId: string, db: string, sql: string, kind: DbKind, baseName: string, table: string) {
  const path = await save({ defaultPath: `${baseName}-${timestamp()}.${EXT[fmt]}`, filters: [{ name: LABELS[fmt], extensions: [EXT[fmt]] }] });
  if (!path) return;
  const requestId = "exp-" + uid();
  const status = h("span", null, "iniciando…");
  const box = h("div.export-progress", null, h("b", null, `Exportando ${LABELS[fmt]}`), status, h("button.btn", { onclick: () => invoke("export_cancel", { requestId }) }, "Cancelar"));
  document.body.append(box);
  const off = await listen<{ id: string; rows: number }>("export-progress", (e) => {
    if (e.payload.id === requestId) status.textContent = `${e.payload.rows.toLocaleString("pt-BR")} linhas`;
  });
  try {
    const n = await invoke<number>("export_query", { requestId, connId, db, sql, format: fmt, path, table });
    notify("Exportação concluída", `${n.toLocaleString("pt-BR")} linha(s) em ${path}. A consulta foi executada de novo, somente leitura.`, "ok", [], 8000);
  } catch (e) {
    notify("Falha na exportação", String(e), "error");
  } finally {
    off();
    box.remove();
    void kind;
  }
}

export interface ExportOptions {
  /** Re-run the query to export every row (shown when the grid holds only part of the result). */
  full?: { connId: string; db: string; sql: string; truncated: boolean };
}

export function exportMenu(anchor: HTMLElement, get: () => { columns: string[]; rows: Cell[][] }, kind: DbKind, baseName: string, table?: string, opts: ExportOptions = {}) {
  const fmts: ExportFormat[] = ["csv", "xlsx", "json", "jsonl", "xml", "tsv", "sql", "md", "html"];
  const copy = (f: Exclude<ExportFormat, "xlsx">) => () => {
    const d = get();
    navigator.clipboard.writeText(serialize(f, d.columns, d.rows, kind, table ?? quoteIdent(kind, baseName)));
    toast(`${d.rows.length.toLocaleString("pt-BR")} linha(s) copiadas como ${LABELS[f]}`, "ok");
  };
  const items: MenuItem[] = [
    ...fmts.map((f) => ({
      label: `${LABELS[f]}…`,
      action: () => {
        const d = get();
        exportToFile(f, d.columns, d.rows, kind, baseName, table).catch((e) => toast(String(e), "error"));
      },
    })),
    { separator: true },
    { label: "Copiar", icon: "general/copy", submenu: (["csv", "tsv", "md", "json"] as const).map((f) => ({ label: LABELS[f], action: copy(f) })) },
  ];
  const full = opts.full;
  if (full) {
    items.push(
      { separator: true },
      {
        label: full.truncated ? "Resultado completo (todas as linhas)" : "Reexecutar e exportar tudo",
        icon: "general/export",
        submenu: (["csv", "json", "jsonl", "xml", "tsv", "sql"] as const).map((f) => ({ label: `${LABELS[f]}…`, action: () => exportFullQuery(f, full.connId, full.db, full.sql, kind, baseName, table ?? quoteIdent(kind, baseName)) })),
      },
    );
  }
  const r = anchor.getBoundingClientRect();
  contextMenu(r.left, r.bottom + 2, items);
}
