// Official Airflow web UI, as a complement to the native API views. It opens in a separate IDE
// window (not an iframe, so Airflow's anti-framing protection stays on) whose label is outside the
// IDE capabilities: the remote page cannot call any IDE command. The system browser is the
// alternative (preference "airflow.web").
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { host, IS_MAC, IS_WIN } from "../host";
import { toast } from "../../ui";

export function webMode(): "window" | "browser" {
  try {
    return localStorage.getItem("airflow.web") === "browser" ? "browser" : "window";
  } catch {
    return "window";
  }
}

export function setWebMode(m: "window" | "browser") {
  try {
    localStorage.setItem("airflow.web", m);
  } catch {
    /* ignore */
  }
}

export async function openExternal(url: string) {
  if (!/^https?:\/\//.test(url)) return;
  const [program, args] = IS_MAC ? ["open", [url]] : IS_WIN ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  await host.capture(program, args as string[], "", undefined, 15).catch((e) => toast(String(e), "error"));
}

export async function openWeb(url: string, title: string) {
  if (webMode() === "browser") return openExternal(url);
  const label = "airflow-web-" + Math.abs([...url].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36);
  const existing = await WebviewWindow.getByLabel(label).catch(() => null);
  if (existing) {
    await existing.setFocus().catch(() => {});
    return;
  }
  const w = new WebviewWindow(label, { url, title: `Airflow — ${title}`, width: 1280, height: 860, center: true });
  w.once("tauri://error", () => {
    toast("Não foi possível abrir a janela; abrindo no navegador.", "info");
    openExternal(url);
  });
}
