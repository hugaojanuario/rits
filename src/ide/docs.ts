// Plugin documentation (docs/*.md in the repository) shown inside the IDE: each plugin tool window
// gets a "?" button in its header that opens its guide in an editor tab. The Markdown files are
// bundled by Vite (lazy, one chunk each) and rendered with the sanitized notebook renderer.
import { h } from "../util";
import { icon } from "../icons";
import type { Workbench } from "./workbench";

const FILES = import.meta.glob("../../docs/*.md", { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;

/** Tool window id → guide (file name without .md) and tab title. */
export const PLUGIN_DOCS: Record<string, { file: string; title: string }> = {
  audit: { file: "migration-audit", title: "Migration Audit" },
  jupyter: { file: "jupyter", title: "Jupyter" },
  dbt: { file: "dbt", title: "dbt" },
  airflow: { file: "airflow", title: "Apache Airflow" },
  docker: { file: "docker", title: "Docker" },
  assistant: { file: "assistente-ia", title: "Assistente IA" },
};

const loader = (file: string) => FILES[`../../docs/${file}.md`];

export function hasDoc(toolWindow: string) {
  const d = PLUGIN_DOCS[toolWindow];
  return !!d && !!loader(d.file);
}

/** "?" button for a tool window header (null when the window has no guide). */
export function docButton(wb: Workbench, toolWindow: string): HTMLElement | null {
  if (!hasDoc(toolWindow)) return null;
  const d = PLUGIN_DOCS[toolWindow];
  return h("button.icon-btn", { title: `Documentação: ${d.title}`, "aria-label": `Documentação: ${d.title}`, onclick: () => openDoc(wb, d.file) }, icon("general/help"));
}

/** Opens a guide (file name without .md) in an editor tab; links to other guides open in place. */
export async function openDoc(wb: Workbench, file: string, anchor?: string) {
  const load = loader(file);
  if (!load) return;
  const id = `doc:${file}`;
  const existing = wb.tabs.find(id);
  if (existing) {
    wb.tabs.activate(existing);
    return;
  }
  const [{ renderMarkdown }, text] = await Promise.all([import("./jupyter/render"), load()]);
  const title = Object.values(PLUGIN_DOCS).find((d) => d.file === file)?.title ?? file;
  const md = renderMarkdown(text);
  md.classList.add("doc-md");
  // headings get ids for in-page links (#…)
  for (const hd of md.querySelectorAll("h1, h2, h3")) hd.id = slug(hd.textContent ?? "");
  md.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href") ?? "";
    const other = href.match(/^(?:\.\/|docs\/)?([\w-]+)\.md(?:#(.*))?$/);
    if (other) openDoc(wb, other[1], other[2]);
    else if (href.startsWith("#")) md.querySelector(`#${CSS.escape(href.slice(1))}`)?.scrollIntoView({ block: "start" });
  });
  const el = h("div.doc-view", null, md);
  wb.tabs.open({ id, title, icon: "fileTypes/markdown", tooltip: `Documentação do plugin ${title}`, el });
  if (anchor) setTimeout(() => md.querySelector(`#${CSS.escape(anchor)}`)?.scrollIntoView({ block: "start" }));
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
