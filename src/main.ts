import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import { setIconTheme } from "./icons";
import { toast } from "./ui";
import { Workbench } from "./ide/workbench";
import { mountWelcome } from "./ide/welcome";
import { recentProjects } from "./ide/project";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { host, IS_MAC } from "./ide/host";

// Native traffic lights on macOS replace the drawn window buttons (see tauri.macos.conf.json).
if (IS_MAC) document.documentElement.classList.add("mac");

// Liquid Glass (macOS): the window is transparent over the native glass material; the "glass" class
// switches styles.css to translucent tokens. Off → the opaque Rits look over the same window.
function setGlass(on: boolean) {
  document.documentElement.classList.toggle("glass", IS_MAC && on);
  try {
    localStorage.setItem("glass", on ? "1" : "0");
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("rits-theme"));
}
(window as any).__setGlass = setGlass;
(window as any).__glassOn = () => document.documentElement.classList.contains("glass");

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
  // The native glass follows the window appearance, so keep it in step with the app theme.
  if (IS_MAC) getCurrentWindow().setTheme(t === "light" ? "light" : "dark").catch(() => {});
  window.dispatchEvent(new Event("rits-theme"));
}
(window as any).__setTheme = setTheme;
(window as any).__toggleTheme = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
setTheme(getStored("theme") ?? "dark");
setGlass(getStored("glass") !== "0");
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
