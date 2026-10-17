// New version check: asks GitHub for the latest release (backend: updater.rs) and shows an
// "Atualizar" button in the title bar only when it is newer than the running app. Installing
// downloads the platform's installer, checks its SHA-256 and restarts the app.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { h } from "../util";
import { icon } from "../icons";
import { button, modal, notify, toast } from "../ui";

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  notes: string;
  page: string;
  asset: string;
  size: number;
  supported: boolean;
}

const AUTO = "update.auto";
const NOTIFIED = "update.notified";
const EVERY = 6 * 60 * 60 * 1000;

export function autoCheck(): boolean {
  try {
    return localStorage.getItem(AUTO) !== "0";
  } catch {
    return true;
  }
}

export function setAutoCheck(on: boolean) {
  try {
    localStorage.setItem(AUTO, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

let latest: UpdateInfo | null = null;
const listeners = new Set<(i: UpdateInfo | null) => void>();

export function onUpdate(fn: (i: UpdateInfo | null) => void) {
  listeners.add(fn);
  fn(latest);
  return () => listeners.delete(fn);
}

export async function checkNow(manual = false): Promise<UpdateInfo | null> {
  try {
    const i = await invoke<UpdateInfo>("update_check");
    latest = i.available ? i : null;
    listeners.forEach((f) => f(latest));
    if (manual) toast(i.available ? `Nova versão disponível: ${i.latest}` : `Você já está na versão mais recente (${i.current}).`, i.available ? "info" : "ok", 5000);
    if (i.available && !manual) {
      let seen = "";
      try {
        seen = localStorage.getItem(NOTIFIED) ?? "";
      } catch {
        /* ignore */
      }
      if (seen !== i.latest) {
        try {
          localStorage.setItem(NOTIFIED, i.latest);
        } catch {
          /* ignore */
        }
        notify(`Rits ${i.latest} disponível`, `Você está na ${i.current}.`, "info", [{ label: "Ver e atualizar", run: () => openUpdateDialog(i) }], 12000);
      }
    }
    return i;
  } catch (e) {
    if (manual) notify("Não foi possível verificar atualizações", String(e), "error");
    return null;
  }
}

let timer: number | undefined;

/** Starts the periodic check (once per window; off when the user disabled it). */
export function startUpdateChecks() {
  if (timer !== undefined) return;
  const tick = () => autoCheck() && checkNow(false);
  setTimeout(tick, 5000);
  timer = window.setInterval(tick, EVERY);
}

const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export function openUpdateDialog(i: UpdateInfo) {
  const m = modal(`Atualizar o Rits para ${i.latest}`, { width: 620 });
  const status = h("div.dim");
  const bar = h("div.upd-bar", null, h("i"));
  m.body.append(
    h("div", null, `Versão atual: ${i.current} → nova: `, h("b", null, i.latest), i.size ? h("span.dim", null, ` · ${fmtSize(i.size)}`) : ""),
    i.notes ? h("pre.upd-notes", null, i.notes.replace(/\r/g, "")) : "",
    h("div.hint", null, i.supported ? "O instalador é baixado do GitHub, conferido com o SHA256SUMS.txt da release e instalado; o Rits fecha e abre de novo na nova versão. Salve seu trabalho antes." : "Não há instalador automático para este sistema: baixe pela página da release."),
    bar,
    status,
  );
  bar.style.display = "none";
  const go = button("Atualizar agora", async () => {
    go.disabled = true;
    bar.style.display = "";
    const fill = bar.firstElementChild as HTMLElement;
    const off = await listen<{ phase: string; done: number; total: number }>("update-progress", (e) => {
      const p = e.payload;
      if (p.phase === "install") {
        status.textContent = "Instalando… o Rits vai reiniciar.";
        fill.style.width = "100%";
      } else {
        status.textContent = `Baixando ${fmtSize(p.done)}${p.total ? ` de ${fmtSize(p.total)}` : ""}`;
        if (p.total) fill.style.width = `${Math.min(100, (p.done / p.total) * 100)}%`;
      }
    });
    try {
      await invoke("update_install");
    } catch (e) {
      notify("A atualização falhou", String(e), "error", [{ label: "Abrir a página da release", run: () => import("./airflow/web").then((w) => w.openExternal(i.page)) }], 15000);
      go.disabled = false;
    } finally {
      off();
    }
  }, "primary", "actions/install") as HTMLButtonElement;
  m.footer.append(
    button("Página da release", () => import("./airflow/web").then((w) => w.openExternal(i.page))),
    button("Depois", () => m.close()),
    ...(i.supported ? [go] : []),
  );
}

/** Title bar button, visible only while a newer version exists. */
export function updateButton(): HTMLElement {
  const b = h("button.tb-btn.upd-btn.hidden", { title: "Nova versão disponível" }, icon("actions/install"), h("span", null, "Atualizar")) as HTMLButtonElement;
  onUpdate((i) => {
    b.classList.toggle("hidden", !i);
    if (i) {
      b.title = `Atualizar para ${i.latest} (você está na ${i.current})`;
      (b.lastChild as HTMLElement).textContent = `Atualizar para ${i.latest}`;
      b.onclick = () => openUpdateDialog(i);
    }
  });
  return b;
}
