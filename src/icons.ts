// Icons: JetBrains "expui" icon set (Apache-2.0, see assets/icons/LICENSE-intellij-community.txt)
// plus a few Rits icons drawn in the same style. Each icon has light/dark variants.

const raw = import.meta.glob("./assets/icons/**/*.svg", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const files = new Map<string, string>();
for (const [p, svg] of Object.entries(raw)) {
  const key = p.replace("./assets/icons/", "").replace(/\.svg$/, "");
  files.set(key, svg.replace(/<!--[\s\S]*?-->/g, "").trim());
}

// Custom icons use currentColor so they follow the theme's icon color.
const C = (body: string, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const BLUE = "#548AF7";
const custom: Record<string, string> = {
  logo: `<svg viewBox="0 0 32 32" width="20" height="20"><defs><linearGradient id="bgl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2fd4a4"/><stop offset="1" stop-color="#3b7bff"/></linearGradient></defs><rect x="1" y="1" width="30" height="30" rx="8" fill="url(#bgl)"/><ellipse cx="16" cy="10" rx="8" ry="3.2" fill="none" stroke="#fff" stroke-width="2"/><path d="M8 10v11c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V10" fill="none" stroke="#fff" stroke-width="2"/><path d="M12.5 17.5h7M16 14v7" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`,
  branch: C(`<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-2 3.2-4.5 3.6-1.2.2-2.2.6-2.5 1.4"/>`),
  database: C(`<ellipse cx="8" cy="4" rx="5.5" ry="2"/><path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>`),
  databaseTw: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.1"><ellipse cx="10" cy="4.5" rx="6.5" ry="2.5"/><path d="M3.5 4.5v11c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-11M3.5 10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5"/></svg>`,
  postgres: `<svg width="16" height="16" viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="5.5" ry="2" fill="none" stroke="#5B8FD6"/><path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" fill="none" stroke="#5B8FD6"/></svg>`,
  mysql: `<svg width="16" height="16" viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="5.5" ry="2" fill="none" stroke="#E59B3A"/><path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" fill="none" stroke="#E59B3A"/></svg>`,
  schema: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="none" stroke="#A98BE8"/><path d="M2.5 6h11M6 6v7.5" stroke="#A98BE8"/></svg>`,
  table: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor"/><path d="M1.5 6h13" stroke="${BLUE}" stroke-width="1.6"/><path d="M1.5 9.5h13M6 6v7.5" stroke="currentColor" opacity=".7"/></svg>`,
  view: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-dasharray="2 1.5"/><path d="M1.5 6h13" stroke="#57A773" stroke-width="1.6"/></svg>`,
  matview: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor"/><path d="M1.5 6h13" stroke="#57A773" stroke-width="1.6"/><circle cx="10.5" cy="10" r="1.5" fill="#57A773"/></svg>`,
  column: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="5" y="2.5" width="6" height="11" rx="1" fill="none" stroke="currentColor"/><path d="M5 5.5h6" stroke="${BLUE}"/></svg>`,
  key: `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="5.5" cy="10.5" r="3" fill="none" stroke="#E5B14A"/><path d="M7.6 8.4L13.5 2.5M11 5l1.5 1.5" stroke="#E5B14A" stroke-linecap="round"/></svg>`,
  index: C(`<path d="M3 4h10M3 8h7M3 12h4"/>`),
  procedure: `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M4.5 3l8 5-8 5z" fill="none" stroke="#E0A85C"/></svg>`,
  sequence: `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2.5 12.5h2.5v-3h3v-3h3v-3h2.5" fill="none" stroke="#B88BE0"/></svg>`,
  trigger: `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M9 1.5L4 9h4l-1 5.5L12 7H8z" fill="none" stroke="#E6C35C" stroke-linejoin="round"/></svg>`,
  event: C(`<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>`),
  console: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor"/><path d="M4.5 6.5l2 1.5-2 1.5M8 10h3" stroke="${BLUE}" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  ddl: C(`<path d="M4 2.5h5.5l3 3V13.5H4z"/><path d="M6 8h5M6 10.5h3.5"/>`),
  playAll: `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2.5 3.2v9.6l6-4.8zM8.5 3.2v9.6l6-4.8z" fill="#5FB865"/></svg>`,
  backup: `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2v8M5 7l3 3 3-3" stroke="${BLUE}" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 11v2.5h11V11" stroke="currentColor" fill="none" stroke-linecap="round"/></svg>`,
  restore: `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 10V2M5 5l3-3 3 3" stroke="#3FB7A0" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 11v2.5h11V11" stroke="currentColor" fill="none" stroke-linecap="round"/></svg>`,
  commitDb: `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.5" fill="none" stroke="#5FB865"/><path d="M1.5 8h4M10.5 8h4" stroke="#5FB865"/></svg>`,
  rollback: `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M4 6.5L1.5 4 4 1.5" stroke="#E4656E" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M1.5 4h7.5a5 5 0 0 1 0 10H5" stroke="#E4656E" fill="none" stroke-linecap="round"/></svg>`,
  first: C(`<path d="M11 3.5L6.5 8l4.5 4.5M4 3.5v9"/>`),
  last: C(`<path d="M5 3.5L9.5 8 5 12.5M12 3.5v9"/>`),
  sun: C(`<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>`),
  moon: C(`<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z"/>`),
  tasks: C(`<path d="M3 4h1.5M3 8h1.5M3 12h1.5M7 4h6M7 8h6M7 12h6"/>`),
  log: C(`<path d="M3.5 2.5h9v11h-9z"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/>`),
  explain: C(`<path d="M2.5 3h4v3h-4zM9.5 7h4v3h-4zM9.5 12h4v2h-4z"/><path d="M6.5 4.5H8v9h1.5M8 8.5h1.5"/>`),
  plug: C(`<path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3"/>`),
  unplug: C(`<path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3M2 14L14 2"/>`),
  value: C(`<path d="M2.5 3.5h11v9h-11z"/><path d="M5 6.5h6M5 9.5h3.5"/>`),
  goFile: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1" y="3" width="14" height="10" rx="2.5" fill="#00ADD8"/><text x="8" y="10.9" text-anchor="middle" font-family="Inter,Segoe UI,sans-serif" font-weight="800" font-size="7" fill="#fff">GO</text></svg>`,
  goMod: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1" y="3" width="14" height="10" rx="2.5" fill="none" stroke="#00ADD8"/><text x="8" y="10.6" text-anchor="middle" font-family="Inter,Segoe UI,sans-serif" font-weight="800" font-size="6.5" fill="#00ADD8">GO</text></svg>`,
  goSdk: `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="#00ADD8"/><text x="8" y="10.6" text-anchor="middle" font-family="Inter,Segoe UI,sans-serif" font-weight="800" font-size="6.5" fill="#fff">Go</text></svg>`,
  goTw: `<svg width="20" height="20" viewBox="0 0 16 16"><rect x="1" y="3" width="14" height="10" rx="2.5" fill="none" stroke="currentColor"/><text x="8" y="10.6" text-anchor="middle" font-family="Inter,Segoe UI,sans-serif" font-weight="800" font-size="6.5" fill="currentColor">GO</text></svg>`,
  minimize: `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor"/></svg>`,
  maximize: `<svg width="10" height="10" viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor"/></svg>`,
  restoreWin: `<svg width="10" height="10" viewBox="0 0 10 10"><rect x=".5" y="2.5" width="7" height="7" fill="none" stroke="currentColor"/><path d="M2.5 2.5V.5h7v7h-2" fill="none" stroke="currentColor"/></svg>`,
  closeWin: `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor"/></svg>`,
  dot: `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>`,
  plugins: C(`<path d="M6 2.5h4v2a1.5 1.5 0 0 0 3 0V4h0.5v9.5h-11V4H3v.5a1.5 1.5 0 0 0 3 0z"/>`),
  bug: C(`<path d="M5.5 5.5h5v4a2.5 2.5 0 0 1-5 0z"/><path d="M6 5.5a2 2 0 0 1 4 0M2.5 7.5h3M10.5 7.5h3M3 11.5l2.6-1M13 11.5l-2.6-1M4 3.5l1.6 1.6M12 3.5l-1.6 1.6"/>`),
  pkg: C(`<path d="M2.5 5L8 2.5 13.5 5v6L8 13.5 2.5 11z"/><path d="M2.5 5L8 7.5 13.5 5M8 7.5v6"/>`),
};

const alias: Record<string, string> = {
  plus: "general/add",
  minus: "general/remove",
  refresh: "general/refresh",
  collapse: "general/collapseAll",
  expand: "general/expandAll",
  play: "run/run",
  run: "run/run",
  debug: "run/debug",
  stop: "run/stop",
  save: "general/save",
  open: "general/open",
  search: "general/search",
  menu: "general/menu",
  check: "actions/checked",
  undo: "general/undo",
  commit: "commitDb",
  export: "general/export",
  filter: "general/filter",
  close: "general/closeSmall",
  chevronR: "general/chevronRight",
  chevronD: "general/chevronDown",
  chevronU: "general/chevronUp",
  left: "general/chevronLeft",
  right: "general/chevronRight",
  history: "general/history",
  format: "actions/reformatCode",
  copy: "general/copy",
  edit: "general/edit",
  trash: "general/delete",
  warn: "status/warning",
  info: "status/info",
  error: "status/error",
  success: "status/success",
  folder: "nodes/folder",
  function: "nodes/function",
  settings: "general/settings",
  more: "general/moreVertical",
  moreH: "general/moreHorizontal",
  python: "python/python",
  pythonSdk: "python/pythonClosed",
  text: "fileTypes/text",
};

let dark = true;
export function setIconTheme(isDark: boolean) {
  dark = isDark;
  document.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    el.innerHTML = svgFor(el.dataset.icon!);
  });
}

export function svgFor(name: string): string {
  const n = alias[name] ?? name;
  if (custom[n]) return custom[n];
  return (dark ? files.get(n + "_dark") : undefined) ?? files.get(n) ?? custom.dot;
}

export function hasIcon(name: string) {
  const n = alias[name] ?? name;
  return !!custom[n] || files.has(n);
}

export function icon(name: string, cls = ""): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "ic " + cls;
  s.dataset.icon = name;
  s.innerHTML = svgFor(name);
  return s;
}

/** Tool window stripe icons (20x20 variants). */
export function twIcon(name: string): HTMLSpanElement {
  const big = `toolwindows/${name}@20x20`;
  return icon(files.has(big) ? big : name, "ic20");
}

export function objectIcon(kind: string) {
  return icon(hasIcon(kind) ? kind : "table");
}

/** Kept for compatibility with older modules that inline icon markup. */
export const icons = {
  get logo() {
    return custom.logo;
  },
};

// ---------------- file type icons ----------------
const byExt: Record<string, string> = {
  py: "python/python", pyi: "python/python", pyw: "python/python", ipynb: "fileTypes/jupyter",
  go: "goFile", mod: "goMod", sum: "goMod", work: "goMod",
  json: "fileTypes/json", jsonc: "fileTypes/json", yaml: "fileTypes/yaml", yml: "fileTypes/yaml", toml: "fileTypes/toml",
  md: "fileTypes/markdown", markdown: "fileTypes/markdown", rst: "fileTypes/rst", txt: "fileTypes/text", log: "fileTypes/text",
  html: "fileTypes/html", htm: "fileTypes/html", css: "fileTypes/css", scss: "fileTypes/css", js: "fileTypes/javaScript", mjs: "fileTypes/javaScript",
  cjs: "fileTypes/javaScript", jsx: "fileTypes/javaScript", ts: "fileTypes/typeScript", tsx: "fileTypes/typeScript",
  xml: "fileTypes/xml", sh: "fileTypes/shell", bash: "fileTypes/shell", ps1: "fileTypes/shell", bat: "fileTypes/microsoftWindows", cmd: "fileTypes/microsoftWindows",
  sql: "fileTypes/sql", csv: "fileTypes/csv", tsv: "fileTypes/csv", ini: "fileTypes/config", cfg: "fileTypes/config", conf: "fileTypes/config",
  env: "fileTypes/config", properties: "fileTypes/properties", png: "fileTypes/image", jpg: "fileTypes/image", jpeg: "fileTypes/image", gif: "fileTypes/image",
  svg: "fileTypes/image", ico: "fileTypes/image", webp: "fileTypes/image", zip: "fileTypes/archive", gz: "fileTypes/archive", tar: "fileTypes/archive",
  whl: "fileTypes/archive", c: "fileTypes/c", h: "fileTypes/h", cpp: "fileTypes/cpp", java: "fileTypes/java", http: "fileTypes/http", patch: "fileTypes/patch", diff: "fileTypes/patch",
  exe: "fileTypes/binaryData", dll: "fileTypes/binaryData", pyc: "fileTypes/binaryData", lock: "fileTypes/config",
};
const byName: Record<string, string> = {
  ".gitignore": "fileTypes/gitignore", ".dockerignore": "fileTypes/ignored", dockerfile: "fileTypes/docker", "docker-compose.yml": "fileTypes/docker",
  "compose.yaml": "fileTypes/docker", ".editorconfig": "fileTypes/editorConfig", makefile: "fileTypes/config", "requirements.txt": "python/pythonPackages",
  "pyproject.toml": "fileTypes/toml", "go.mod": "goMod", "go.sum": "goMod", license: "fileTypes/text", ".env": "fileTypes/config",
};

export function fileIconName(name: string): string {
  const lower = name.toLowerCase();
  if (byName[lower]) return byName[lower];
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  return byExt[ext] ?? "fileTypes/text";
}

export function fileIcon(name: string) {
  return icon(fileIconName(name));
}
