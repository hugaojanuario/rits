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
  // Rits mark (assets/logo.svg): a solid, slanted "R" in lilac on the dark rounded square.
  logo: `<svg viewBox="0 0 32 32" width="20" height="20"><rect width="32" height="32" rx="8" fill="#111214"/><path transform="translate(16 16) scale(0.088) translate(-193 -184.5)" d="M111 74L275 100V218L229 211L268 295L229 289L188.5 201.8L158 197V275L111 268ZM159 126L217 135V170L159 161Z" fill="#A08CFF" fill-rule="evenodd"/></svg>`,
  // Rits mark on the accent (Blocos title bar and welcome screen): follows the theme through CSS variables.
  logoAccent: `<svg viewBox="0 0 32 32" width="22" height="22"><rect width="32" height="32" rx="9" fill="var(--accent)"/><path transform="translate(16 16) scale(0.082) translate(-193 -184.5)" d="M111 74L275 100V218L229 211L268 295L229 289L188.5 201.8L158 197V275L111 268ZM159 126L217 135V170L159 161Z" fill="var(--on-accent)" fill-rule="evenodd"/></svg>`,
  // Layout toggles (title bar): left card, bottom card, right card.
  panelLeft: C(`<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M6 2.5v11"/><path d="M3.3 5.2h1M3.3 7.2h1"/>`),
  panelBottom: C(`<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M1.5 9.5h13"/>`),
  panelRight: C(`<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M10 2.5v11"/><path d="M11.7 5.2h1M11.7 7.2h1"/>`),
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
  goFile: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1" y="3" width="14" height="10" rx="2.5" fill="#00ADD8"/><text x="8" y="10.9" text-anchor="middle" font-family="Figtree,Segoe UI,sans-serif" font-weight="800" font-size="7" fill="#fff">GO</text></svg>`,
  goMod: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1" y="3" width="14" height="10" rx="2.5" fill="none" stroke="#00ADD8"/><text x="8" y="10.6" text-anchor="middle" font-family="Figtree,Segoe UI,sans-serif" font-weight="800" font-size="6.5" fill="#00ADD8">GO</text></svg>`,
  goSdk: `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="#00ADD8"/><text x="8" y="10.6" text-anchor="middle" font-family="Figtree,Segoe UI,sans-serif" font-weight="800" font-size="6.5" fill="#fff">Go</text></svg>`,
  goTw: `<svg width="20" height="20" viewBox="0 0 16 16"><rect x="1" y="3" width="14" height="10" rx="2.5" fill="none" stroke="currentColor"/><text x="8" y="10.6" text-anchor="middle" font-family="Figtree,Segoe UI,sans-serif" font-weight="800" font-size="6.5" fill="currentColor">GO</text></svg>`,
  minimize: `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor"/></svg>`,
  maximize: `<svg width="10" height="10" viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor"/></svg>`,
  restoreWin: `<svg width="10" height="10" viewBox="0 0 10 10"><rect x=".5" y="2.5" width="7" height="7" fill="none" stroke="currentColor"/><path d="M2.5 2.5V.5h7v7h-2" fill="none" stroke="currentColor"/></svg>`,
  closeWin: `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor"/></svg>`,
  dot: `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>`,
  plugins: C(`<path d="M6 2.5h4v2a1.5 1.5 0 0 0 3 0V4h0.5v9.5h-11V4H3v.5a1.5 1.5 0 0 0 3 0z"/>`),
  bug: C(`<path d="M5.5 5.5h5v4a2.5 2.5 0 0 1-5 0z"/><path d="M6 5.5a2 2 0 0 1 4 0M2.5 7.5h3M10.5 7.5h3M3 11.5l2.6-1M13 11.5l-2.6-1M4 3.5l1.6 1.6M12 3.5l-1.6 1.6"/>`),
  // Docker whale (container stack on the back), in the stroke style of the other icons.
  dockerTw: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round"><path d="M1.8 10.2h14.6c.9-.1 1.6-.6 2-1.4.5.3 1 .2 1.3-.1-.3-.4-.8-.6-1.4-.5-.2-.8-.7-1.3-1.3-1.6-.4.7-.4 1.5-.1 2.1M1.8 10.2c.3 3.6 3.4 6 7.4 6 4.2 0 7.3-2.4 8.2-6"/><path d="M3.8 7.8h2.6v2.4H3.8zM6.4 7.8H9v2.4H6.4zM9 7.8h2.6v2.4H9zM6.4 5.4H9v2.4H6.4zM9 5.4h2.6v2.4H9zM9 3h2.6v2.4H9zM11.6 7.8h2.6v2.4h-2.6z"/><circle cx="6" cy="13" r=".5" fill="currentColor" stroke="none"/></svg>`,
  docker: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke-linejoin="round"><path d="M.8 8.2h12.3c.8-.1 1.4-.5 1.7-1.2.4.2.8.2 1.1-.1-.3-.3-.7-.5-1.2-.4-.1-.7-.6-1.1-1.1-1.3-.3.6-.3 1.2-.1 1.7M.8 8.2c.2 3 2.8 5 6.2 5 3.5 0 6.1-2 6.9-5" fill="#2496ED" fill-opacity=".18" stroke="#2496ED"/><g fill="#2496ED"><rect x="2.4" y="6.2" width="1.9" height="1.7" rx=".2"/><rect x="4.6" y="6.2" width="1.9" height="1.7" rx=".2"/><rect x="6.8" y="6.2" width="1.9" height="1.7" rx=".2"/><rect x="9" y="6.2" width="1.9" height="1.7" rx=".2"/><rect x="4.6" y="4.2" width="1.9" height="1.7" rx=".2"/><rect x="6.8" y="4.2" width="1.9" height="1.7" rx=".2"/><rect x="6.8" y="2.2" width="1.9" height="1.7" rx=".2"/></g><circle cx="4.2" cy="10.4" r=".55" fill="#2496ED"/></svg>`,
  container: C(`<rect x="1.5" y="5" width="13" height="7.5" rx="1.5"/><path d="M4.5 5v7.5M8 5v7.5M11.5 5v7.5"/>`),
  containerStack: C(`<rect x="1.5" y="8.5" width="6" height="5" rx="1"/><rect x="8.5" y="8.5" width="6" height="5" rx="1"/><rect x="5" y="2.5" width="6" height="5" rx="1"/>`),
  // databases with on-demand drivers (simplified marks, own drawings)
  dbSqlserver: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#D9534F" stroke-linejoin="round"><path d="M3 13.5c3-1 7-1.2 10.5.3M4.5 11c.8-4 3-7.5 6.5-9-1 2.6-1 5.6.5 8.6"/><path d="M5.5 7.5c2-.6 4.4-.5 6.5.3"/></svg>`,
  dbOracle: `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1.5" y="4.5" width="13" height="7" rx="3.5" fill="none" stroke="#E0533D" stroke-width="1.8"/></svg>`,
  dbFirebird: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#F08A24" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14.5c-3 0-5-2-5-4.6 0-2.4 1.6-3.6 2.4-5.4.6 1.3.4 2.4 1.4 3 .3-2.3 1.6-4.2 3.7-5.5-.4 2 .3 3.3 1.3 4.6.8 1 1.2 2.1 1.2 3.3 0 2.6-2 4.6-5 4.6z" fill="#F08A24" fill-opacity=".15"/><path d="M8 14.5c-1.3 0-2.2-.9-2.2-2.1 0-1.2 1-1.8 1.5-2.9.5 1 1.7 1.6 2 2.6.3 1.3-.4 2.4-1.3 2.4z"/></svg>`,
  dbSqlite: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#3D8FD1" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 13.5c1.5-4.5 4.5-9 10.5-11.5-1 3.6-3.6 8.8-8.4 10.4"/><path d="M5.6 9.8l3.2-.4M7.4 7.2l2.8-.6" opacity=".8"/></svg>`,
  dbDuckdb: `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="#F6D33C" fill-opacity=".2" stroke="#E5B92A"/><circle cx="6.6" cy="8" r="2.4" fill="none" stroke="#E5B92A"/><path d="M9.2 7.4h3.4l-.6 1.4H9.2z" fill="#F08A24"/></svg>`,
  dbClickhouse: `<svg width="16" height="16" viewBox="0 0 16 16" fill="#E8C33A"><rect x="2" y="2.5" width="1.6" height="11" rx=".4"/><rect x="4.8" y="2.5" width="1.6" height="11" rx=".4"/><rect x="7.6" y="2.5" width="1.6" height="11" rx=".4"/><rect x="10.4" y="2.5" width="1.6" height="11" rx=".4"/><rect x="13.2" y="6.6" width="1.6" height="2.8" rx=".4"/></svg>`,
  dbMongo: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#3FA45B" stroke-linejoin="round"><path d="M8 1.5c2.6 2.6 3.9 5 3.6 7.5-.3 2.4-1.7 3.8-3.6 4.6-1.9-.8-3.3-2.2-3.6-4.6C4.1 6.5 5.4 4.1 8 1.5z" fill="#3FA45B" fill-opacity=".15"/><path d="M8 4.5v10" stroke-linecap="round"/></svg>`,
  // Airflow: a four-blade pinwheel (own drawing in the style of the other icons)
  airflow: `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 8C8 5 9 2.2 11.6 1.6 12.4 4 10.6 6.6 8 8z" fill="#2B83F6"/><path d="M8 8c3 0 5.8 1 6.4 3.6C12 12.4 9.4 10.6 8 8z" fill="#E9493B"/><path d="M8 8c0 3-1 5.8-3.6 6.4C3.6 12 5.4 9.4 8 8z" fill="#21B464"/><path d="M8 8C5 8 2.2 7 1.6 4.4 4 3.6 6.6 5.4 8 8z" fill="#08C7D9"/><circle cx="8" cy="8" r="1" fill="#fff" opacity=".9"/></svg>`,
  // Plugin icons drawn for Rits (generic shapes, not the projects' logos).
  jupyter: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="3" y="1.5" width="10" height="13" rx="1.5" stroke="#F37726"/><path d="M5.5 5h5M5.5 7.5h5M5.5 10h3" stroke="#F37726" stroke-linecap="round"/><circle cx="3" cy="4.5" r=".9" fill="#F37726"/><circle cx="3" cy="8" r=".9" fill="#F37726"/><circle cx="3" cy="11.5" r=".9" fill="#F37726"/></svg>`,
  jupyterTw: C(`<rect x="3.5" y="2" width="9" height="12" rx="1.5"/><path d="M6 5.5h4M6 8h4M6 10.5h2.5M2.5 5h2M2.5 8h2M2.5 11h2"/>`, 20),
  notebook: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="3" y="1.5" width="10" height="13" rx="1.5" stroke="#F37726"/><path d="M5.5 5h5M5.5 7.5h5M5.5 10h3" stroke="#F37726" stroke-linecap="round"/></svg>`,
  dbt: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#FF694A" stroke-linejoin="round" stroke-linecap="round"><path d="M8 1.8l5.6 3.1L8 8 2.4 4.9z" fill="#FF694A" fill-opacity=".2"/><path d="M2.4 8L8 11.1 13.6 8M2.4 11.1L8 14.2l5.6-3.1"/></svg>`,
  dbtTw: C(`<path d="M8 1.8l5.6 3.1L8 8 2.4 4.9zM2.4 8L8 11.1 13.6 8M2.4 11.1L8 14.2l5.6-3.1"/>`, 20),
  audit: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#548AF7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.8" cy="6.8" r="4.6"/><path d="M10.2 10.2l4 4M4.8 6.9l1.4 1.4 2.6-2.8"/></svg>`,
  auditTw: C(`<circle cx="6.8" cy="6.8" r="4.6"/><path d="M10.2 10.2l4 4M4.8 6.9l1.4 1.4 2.6-2.8"/>`, 20),
  // AI assistant: a chat balloon with a spark (own drawing)
  ai: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#A08CFF" stroke-linejoin="round" stroke-linecap="round"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 3v-3h-.5A1.5 1.5 0 0 1 2 9.5z" fill="#A08CFF" fill-opacity=".15"/><path d="M8 4.2l.7 1.8 1.8.7-1.8.7L8 9.2l-.7-1.8-1.8-.7 1.8-.7z" fill="#A08CFF"/></svg>`,
  aiTw: C(`<path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 3v-3h-.5A1.5 1.5 0 0 1 2 9.5z"/><path d="M8 4.2l.7 1.8 1.8.7-1.8.7L8 9.2l-.7-1.8-1.8-.7 1.8-.7z"/>`, 20),
  airflowTw: C(`<path d="M10 10c0-3.6 1.2-6.9 4.3-7.6.9 2.8-1.2 5.9-4.3 7.6zM10 10c3.6 0 6.9 1.2 7.6 4.3-2.8.9-5.9-1.2-7.6-4.3zM10 10c0 3.6-1.2 6.9-4.3 7.6-.9-2.8 1.2-5.9 4.3-7.6zM10 10c-3.6 0-6.9-1.2-7.6-4.3 2.8-.9 5.9 1.2 7.6 4.3z" transform="scale(.8)"/>`, 20),
  terraform: `<svg width="16" height="16" viewBox="0 0 16 16" fill="#8A6CE8"><path d="M5.6 2.6l4.2 2.4v4.8L5.6 7.4z"/><path d="M10.4 5v4.8l4.2-2.4V2.6z" opacity=".7"/><path d="M1.2.2l4 2.3v4.8l-4-2.3zM5.6 8.2l4.2 2.4v4.8l-4.2-2.4z"/></svg>`,
  k8s: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke-linecap="round"><path d="M8 1.2l5.6 2.7 1.4 6-3.9 4.8H4.9L1 9.9l1.4-6z" fill="#3970E4" fill-opacity=".18" stroke="#3970E4" stroke-linejoin="round"/><circle cx="8" cy="8.2" r="2.1" stroke="#3970E4"/><path d="M8 3.6v2.5M8 10.3v2.4M3.7 6.6l2.3 1M10 8.8l2.3 1M4.4 11.4l2-1.8M9.6 6.8l2-1.8" stroke="#3970E4"/></svg>`,
  diagram: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke-linejoin="round"><rect x="1.5" y="2" width="5.5" height="5" rx="1.2" stroke="currentColor"/><rect x="9" y="9" width="5.5" height="5" rx="1.2" stroke="currentColor"/><path d="M1.5 4h5.5M9 11h5.5" stroke="${BLUE}"/><path d="M7 4.5c2.5 0 1.5 6.5 2 6.5" stroke="${BLUE}" stroke-linecap="round"/></svg>`,
  dgLink: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="${BLUE}" stroke-linecap="round"><path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1"/></svg>`,
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
  tf: "terraform", tfvars: "terraform", hcl: "terraform", nomad: "terraform",
  sql: "fileTypes/sql", csv: "fileTypes/csv", tsv: "fileTypes/csv", ini: "fileTypes/config", cfg: "fileTypes/config", conf: "fileTypes/config",
  env: "fileTypes/config", properties: "fileTypes/properties", png: "fileTypes/image", jpg: "fileTypes/image", jpeg: "fileTypes/image", gif: "fileTypes/image",
  svg: "fileTypes/image", ico: "fileTypes/image", webp: "fileTypes/image", zip: "fileTypes/archive", gz: "fileTypes/archive", tar: "fileTypes/archive",
  whl: "fileTypes/archive", c: "fileTypes/c", h: "fileTypes/h", cpp: "fileTypes/cpp", java: "fileTypes/java", http: "fileTypes/http", patch: "fileTypes/patch", diff: "fileTypes/patch",
  exe: "fileTypes/binaryData", dll: "fileTypes/binaryData", pyc: "fileTypes/binaryData", lock: "fileTypes/config",
};
const byName: Record<string, string> = {
  ".gitignore": "fileTypes/gitignore", ".dockerignore": "fileTypes/ignored", dockerfile: "docker", containerfile: "docker",
  "docker-compose.yml": "containerStack", "docker-compose.yaml": "containerStack", "compose.yaml": "containerStack", "compose.yml": "containerStack", ".editorconfig": "fileTypes/editorConfig", makefile: "fileTypes/config", "requirements.txt": "python/pythonPackages",
  "dbt_project.yml": "dbt", "profiles.yml": "dbt", "pyproject.toml": "fileTypes/toml", "go.mod": "goMod", "go.sum": "goMod", license: "fileTypes/text", ".env": "fileTypes/config",
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
