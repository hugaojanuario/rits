// Dev-only stand-in for the IDE commands, so the window (title bar, cards, project home, welcome screen)
// can be previewed in a normal browser: `npm run dev` and open /dev/ide-mock.html.
// ?os=mac simulates macOS (traffic-light inset, Liquid Glass over a sample wallpaper); ?theme=light;
// ?welcome=1 shows the welcome screen; ?glass=0 turns the glass off. Files, Git and processes are fake.
const params = new URLSearchParams(location.search);
const mac = params.get("os") === "mac";
const ua = mac ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15" : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
Object.defineProperty(navigator, "userAgent", { get: () => ua });
try {
  localStorage.setItem("theme", params.get("theme") === "light" ? "light" : "dark");
  localStorage.setItem("glass", params.get("glass") === "0" ? "0" : "1");
  localStorage.removeItem("toolLayout");
} catch {
  /* ignore */
}
// The native glass sits behind a transparent window; a wallpaper stands in for it here.
if (mac && params.get("glass") !== "0")
  document.documentElement.style.background =
    params.get("theme") === "light"
      ? "radial-gradient(1200px 700px at 15% 10%, #f3d9e8, transparent), radial-gradient(1000px 800px at 90% 90%, #cfe3f7, transparent), #e9e6f0"
      : "radial-gradient(1200px 700px at 15% 10%, #3b2a5c, transparent), radial-gradient(1000px 800px at 90% 90%, #12384a, transparent), #121018";

const HOME = mac ? "/Users/hugo" : "C:/Users/hugo";
const ROOT = mac ? `${HOME}/Projetos/DominiCart - Orion REG` : `${HOME}/OneDrive - Siplan/DominiCart - Orion REG`;
type E = { name: string; isDir: boolean; ignored?: boolean; children?: E[] };
const d = (name: string, children: E[] = [], ignored = false): E => ({ name, isDir: true, children, ignored });
const f = (name: string, ignored = false): E => ({ name, isDir: false, ignored });
const tree: E[] = [
  d(".idea", [], true), d(".pytest_cache", [], true), d(".ruff_cache", [], true), d(".venv", [], true),
  d("cmd", [f("main.py")]), d("contracts", [f("pedido.json")]), d("docs", [f("arquitetura.md")]), d("internal", [f("__init__.py")]),
  d("notebooks", [f("exploracao.ipynb")]), d("output", [], true), d("scripts", [f("carga.sh")]), d("sql", [f("consultas.sql")]),
  d("src", [f("pipeline.py"), f("__init__.py")]), d("tests", [f("test_pipeline.py")]), d("tmp", [], true),
  f(".dockerignore"), f(".editorconfig"), f(".env", true), f(".env.example"), f(".gitignore"), f("compose.yaml"), f("Dockerfile"),
  f("MEMORIAL_COMPLETO_DOMINICART_ORION_REG.md"), f("pyproject.toml"), f("README.md"),
];
const find = (path: string): E[] | null => {
  if (path === ROOT) return tree;
  const rel = path.slice(ROOT.length + 1).split("/");
  let cur: E[] = tree;
  for (const part of rel) {
    const e = cur.find((x) => x.name === part);
    if (!e?.isDir) return null;
    cur = e.children ?? [];
  }
  return cur;
};
const exists = (path: string) => {
  if (path === ROOT || path.startsWith(ROOT + "/.venv")) return true;
  const i = path.lastIndexOf("/");
  return !!find(path.slice(0, i))?.some((e) => e.name === path.slice(i + 1));
};
const status = ["# branch.oid 8f195bc", "# branch.head main", "1 .M N... 100644 100644 100644 a b sql/consultas.sql", "? tests/test_pipeline.py", ""].join("\0");

const handlers: Record<string, (a: any) => unknown> = {
  env_info: () => ({ home: HOME, sep: mac ? "/" : "\\", os: mac ? "macos" : "windows", defaultShell: mac ? "/bin/zsh" : "powershell.exe", username: "hugo" }),
  window_reset: () => null,
  load_doc: (a) =>
    a.key === "recentProjects"
      ? [
          { path: ROOT, name: "DominiCart - Orion REG", opened: Date.now(), branch: "main" },
          { path: `${HOME}/Projetos/rits`, name: "rits", opened: Date.now() - 864e5, branch: "layout-blocos" },
          { path: `${HOME}/Projetos/sentinel`, name: "sentinel", opened: Date.now() - 3 * 864e5, branch: "main" },
        ]
      : null,
  save_doc: () => null,
  fs_exists: (a) => exists(a.path),
  fs_list: (a) => (find(a.path) ?? []).map((e) => ({ name: e.name, path: `${a.path}/${e.name}`, isDir: e.isDir, size: 0, ignored: !!e.ignored })),
  fs_read: (a) => ({
    text: /\.py$/.test(a.path)
      ? 'import pandas as pd\n\n\ndef carregar(caminho: str) -> pd.DataFrame:\n    """Lê o arquivo de pedidos e normaliza as colunas."""\n    df = pd.read_csv(caminho, sep=";")\n    return df.rename(columns=str.lower)\n\n\nif __name__ == "__main__":\n    print(carregar("output/pedidos.csv").head())\n'
      : "# DominiCart - Orion REG\n\nPipeline de dados de exemplo (mock da IDE).\n",
    binary: false,
    tooLarge: false,
    crlf: false,
    encoding: "UTF-8",
  }),
  fs_watch: () => null,
  fs_unwatch: () => null,
  fs_files: () => [],
  which: () => null,
  list_connections: () => [],
  run_capture: (a) => {
    const args: string[] = a.args ?? [];
    if (a.program === "git" || args.includes("rev-parse") || args.includes("status")) {
      if (args.includes("rev-parse")) return { code: 0, stdout: ROOT + "\n", stderr: "" };
      if (args.includes("status")) return { code: 0, stdout: status, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }
    if (/python/i.test(a.program)) return { code: 0, stdout: "Python 3.12.4\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "mock" };
  },
  "plugin:window|is_maximized": () => false,
  "plugin:event|listen": () => 1,
  "plugin:event|unlisten": () => null,
};
let cb = 0;
(window as any).__TAURI_INTERNALS__ = {
  transformCallback: () => ++cb,
  unregisterCallback: () => {},
  invoke: async (cmd: string, args: any) => {
    await new Promise((r) => setTimeout(r, 10));
    const h = handlers[cmd];
    return h ? h(args ?? {}) : null;
  },
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
if (!params.has("welcome")) history.replaceState(null, "", `${location.pathname}?${params}&project=${encodeURIComponent(ROOT)}`);
