// Output and Markdown rendering of notebooks, with Jupyter's trust model:
// - Markdown and untrusted HTML are sanitized (DOMPurify) and rendered inline: no scripts, no
//   event handlers, links open in the system browser;
// - "active" outputs (HTML with scripts, JavaScript) run only for trusted notebooks or outputs
//   produced in this session, inside a sandboxed iframe without same-origin (it cannot reach the
//   IDE nor its commands);
// - images are data: URLs; SVG goes through <img> (scripts in SVG never run there).
import DOMPurify from "dompurify";
import { marked } from "marked";
import { h } from "../../util";
import { renderAnsi } from "../run";
import { host } from "../host";
import type { NbOutput } from "./api";
import { joinSource } from "./api";

marked.setOptions({ gfm: true, breaks: false });

const openExternal = (url: string) => {
  import("../airflow/web").then((w) => w.openExternal(url)).catch(() => {});
};

function wireLinks(el: HTMLElement) {
  el.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) openExternal(href);
  });
}

function sanitize(html: string) {
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["form", "input", "button", "textarea", "select", "iframe", "object", "embed", "base", "meta", "link"], FORBID_ATTR: ["srcset"], ALLOW_DATA_ATTR: false });
}

/** Markdown cell (attachments resolved to data URLs, LaTeX shown as source). */
export function renderMarkdown(src: string, attachments?: Record<string, any>): HTMLElement {
  let md = src;
  if (attachments) {
    md = md.replace(/\(attachment:([^)\s]+)\)/g, (_m, name) => {
      const a = attachments[name];
      const mime = a && Object.keys(a).find((k) => k.startsWith("image/"));
      return mime ? `(data:${mime};base64,${a[mime]})` : `(${name})`;
    });
  }
  const html = sanitize(marked.parse(md, { async: false }) as string);
  const el = h("div.nb-md", { html });
  wireLinks(el);
  return el;
}

const text = (v: unknown) => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : JSON.stringify(v, null, 2));

const MIME_ORDER = [
  "application/vnd.jupyter.widget-view+json",
  "application/javascript",
  "text/html",
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "text/markdown",
  "text/latex",
  "application/json",
  "text/plain",
];

/** Sandboxed iframe for active content; reports its height through postMessage. */
function activeFrame(html: string): HTMLElement {
  const id = Math.random().toString(36).slice(2);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:13px system-ui,sans-serif;color:#222;background:#fff}</style></head><body>${html}<script>(function(){function s(){parent.postMessage({rits:"${id}",h:document.documentElement.scrollHeight},"*")}new ResizeObserver(s).observe(document.body);window.addEventListener("load",s);setTimeout(s,50);document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a");if(a){e.preventDefault();parent.postMessage({rits:"${id}",open:a.href},"*")}})})()</script></body></html>`;
  const f = h("iframe.nb-frame", { sandbox: "allow-scripts", srcdoc: doc, title: "Saída ativa (isolada)" }) as HTMLIFrameElement;
  const onMsg = (e: MessageEvent) => {
    if (e.source !== f.contentWindow || !e.data || e.data.rits !== id) return;
    if (typeof e.data.h === "number") f.style.height = Math.min(Math.max(e.data.h, 20), 1600) + "px";
    if (typeof e.data.open === "string" && /^https?:\/\//.test(e.data.open)) openExternal(e.data.open);
  };
  window.addEventListener("message", onMsg);
  // drop the listener when the frame leaves the document
  new MutationObserver((_m, obs) => {
    if (!f.isConnected) {
      window.removeEventListener("message", onMsg);
      obs.disconnect();
    }
  }).observe(document.body, { childList: true, subtree: true });
  return f;
}

function hasActiveContent(html: string) {
  return /<script|\bon\w+\s*=|javascript:/i.test(html);
}

function renderData(data: Record<string, unknown>, trusted: boolean): HTMLElement {
  const mime = MIME_ORDER.find((m) => m in data) ?? Object.keys(data)[0];
  const v = data[mime];
  switch (mime) {
    case "application/vnd.jupyter.widget-view+json":
      return h("div.nb-out-col", null, h("div.nb-note", null, "Widget interativo (ipywidgets) não é suportado nesta versão; abra no JupyterLab."), data["text/plain"] ? h("pre.nb-text", null, text(data["text/plain"])) : "");
    case "application/javascript":
      return trusted ? activeFrame(`<script>${text(v)}</script>`) : h("div.nb-note", null, "JavaScript de um notebook não confiável não é executado. Use \"Confiar no notebook\" se você conhece a origem.");
    case "text/html": {
      const html = text(v);
      if (trusted && hasActiveContent(html)) return activeFrame(html);
      const el = h("div.nb-html", { html: sanitize(html) });
      wireLinks(el);
      if (!trusted && hasActiveContent(html)) return h("div.nb-out-col", null, h("div.nb-note", null, "Conteúdo ativo removido (notebook não confiável)."), el);
      return el;
    }
    case "image/svg+xml":
      return h("img.nb-img", { src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text(v)) });
    case "image/png":
    case "image/jpeg":
    case "image/gif":
      return h("img.nb-img", { src: `data:${mime};base64,${text(v).replace(/\s/g, "")}` });
    case "text/markdown":
      return renderMarkdown(text(v));
    case "application/json":
      return h("pre.nb-text", null, JSON.stringify(v, null, 2));
    default:
      return h("pre.nb-text", null, ...renderAnsi(text(v), ""));
  }
}

export function renderOutput(o: NbOutput, trusted: boolean): HTMLElement {
  switch (o.output_type) {
    case "stream":
      return h(`pre.nb-text.nb-stream${o.name === "stderr" ? ".err" : ""}` as "pre", null, ...renderAnsi(text(o.text ?? ""), ""));
    case "error":
      return h("pre.nb-text.nb-error", null, ...renderAnsi((o.traceback ?? [`${o.ename}: ${o.evalue}`]).join("\n"), ""));
    case "execute_result":
    case "display_data":
      return renderData(o.data ?? {}, trusted);
    default:
      return h("pre.nb-text", null, JSON.stringify(o));
  }
}

// ---------------- trust ----------------

const TRUST_DOC = "jupyter-trust";
let trustCache: Record<string, string> | null = null;

async function trustMap() {
  trustCache ??= (await host.loadDoc<Record<string, string>>(TRUST_DOC).catch(() => null)) ?? {};
  return trustCache;
}

/** A notebook is trusted when its content digest was trusted (or saved) by the user in this IDE. */
export async function isTrusted(key: string, digest: string) {
  return (await trustMap())[key.toLowerCase()] === digest;
}

export async function setTrusted(key: string, digest: string | null) {
  const m = await trustMap();
  if (digest) m[key.toLowerCase()] = digest;
  else delete m[key.toLowerCase()];
  await host.saveDoc(TRUST_DOC, m).catch(() => {});
}

export { joinSource };
