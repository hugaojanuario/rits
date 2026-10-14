import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import { setIconTheme } from "./icons";
import { toast } from "./ui";
import { Workbench } from "./ide/workbench";
import { mountWelcome } from "./ide/welcome";
import { recentProjects } from "./ide/project";
import { host } from "./ide/host";

// ---------------- theme ----------------
function getStored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function setTheme(t: string) {
  document.documentElement.dataset.theme = t === "light" ? "light" : "dark";
  setIconTheme(t !== "light");
  try {
    localStorage.setItem("theme", t);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("rits-theme"));
}
(window as any).__setTheme = setTheme;
(window as any).__toggleTheme = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
setTheme(getStored("theme") ?? "dark");
const ef = getStored("editor-font");
if (ef) document.documentElement.style.setProperty("--editor-font-size", ef + "px");
const uf = getStored("ui-font");
if (uf) document.documentElement.style.setProperty("--ui-font-size", uf + "px");

// ---------------- boot: welcome screen or a project ----------------
async function boot() {
  const app = document.getElementById("app")!;
  // Stop language servers, programs and terminals left behind by a previous load of this window.
  await host.windowReset().catch(() => {});
  const params = new URLSearchParams(location.search);
  let project = params.get("project");
  if (!project && !params.has("welcome")) {
    // Reopen the last project, like JetBrains IDEs do.
    const last = (await recentProjects().catch(() => []))[0];
    if (last && (await host.exists(last.path))) project = last.path;
  }
  if (project && (await host.exists(project))) {
    const wb = new Workbench(project);
    (window as any).__wb = wb;
    await wb.mount(app);
  } else {
    await mountWelcome(app);
  }
}

boot().catch((e) => {
  console.error(e);
  toast(String(e?.message ?? e), "error", 15000);
});
