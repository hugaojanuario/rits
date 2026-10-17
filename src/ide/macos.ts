// macOS: the app is ad-hoc signed (not notarized). Downloaded by a browser, it keeps the
// quarantine attribute and macOS may run it from a random read-only copy (App Translocation),
// which breaks updates and reopens with warnings. Tell the user the one command that frees it.
import { invoke } from "@tauri-apps/api/core";
import { notify, toast } from "../ui";
import { IS_MAC } from "./host";

export const FREE_COMMAND = "xattr -dr com.apple.quarantine /Applications/Rits.app";
export const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/hugaojanuario/rits/main/scripts/install-macos.sh | bash";

export async function checkQuarantine() {
  if (!IS_MAC) return;
  const st = await invoke<{ bundle: string; translocated: boolean; quarantined: boolean }>("macos_quarantine_status").catch(() => null);
  if (!st || (!st.translocated && !st.quarantined)) return;
  const inApps = st.bundle.startsWith("/Applications/");
  notify(
    "Libere o Rits no macOS",
    `O Rits não é notarizado pela Apple e o macOS o mantém em quarentena${st.translocated ? " (rodando de uma cópia temporária)" : ""}. ${inApps ? "" : "Mova o app para Aplicativos e "}rode no Terminal:\n${FREE_COMMAND}\nDepois, abra o Rits de novo.`,
    "info",
    [{ label: "Copiar comando", run: () => (navigator.clipboard.writeText(FREE_COMMAND), toast("Comando copiado", "ok")) }],
    30000,
  );
}
