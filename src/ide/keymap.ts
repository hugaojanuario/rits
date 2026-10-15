// Keymaps: "jetbrains" (the original, JetBrains for Windows) and "vscode". Menus are written with
// JetBrains labels ("Ctrl" = Cmd on macOS); displayShortcut() translates them for the active keymap
// and renders them with ⌃⌥⇧⌘ on macOS.
import { IS_MAC } from "./host";

export type KeymapId = "jetbrains" | "vscode";
const KEY = "keymap";

export function keymapId(): KeymapId {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "jetbrains" || v === "vscode") return v;
  } catch {
    /* ignore */
  }
  return IS_MAC ? "vscode" : "jetbrains";
}

export function setKeymap(id: KeymapId) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("rits-keymap"));
}

/** "Mod" is Cmd on macOS and Ctrl elsewhere; "Ctrl" is always the Control key. */
const VS: Record<string, string> = {
  "Ctrl+Shift+N": "Mod+P",
  "Ctrl+Shift+A": "Mod+Shift+P",
  "Ctrl+N": "Mod+T",
  "Ctrl+Alt+Shift+N": "Mod+T",
  "Ctrl+N / Ctrl+Alt+Shift+N": "Mod+T",
  "Ctrl+F12": "Mod+Shift+O",
  "Ctrl+G": "Ctrl+G",
  "Ctrl+B": "F12",
  "Ctrl+B / Ctrl+Clique": "F12 / Mod+Clique",
  "Ctrl+Alt+B": "Mod+F12",
  "Alt+F7": "Shift+F12",
  "Shift+F6": "F2",
  "Alt+Enter": "Mod+.",
  "Ctrl+P": "Mod+Shift+Espaço",
  "Ctrl+Q": "Mod+K Mod+I",
  "Ctrl+Alt+L": "Shift+Alt+F",
  "Ctrl+Alt+O": "Shift+Alt+O",
  "Ctrl+D": "Shift+Alt+↓",
  "Ctrl+Y": "Mod+Shift+K",
  "Ctrl+W": IS_MAC ? "Ctrl+Shift+Mod+→" : "Shift+Alt+→",
  "Alt+Shift+↑/↓": "Alt+↑/↓",
  "Shift+F10": "Ctrl+F5",
  "Shift+F9": "F5",
  "Shift+F10 / Shift+F9": "Ctrl+F5 / F5",
  "Ctrl+F2": "Shift+F5",
  "Ctrl+F8": "F9",
  "F8 / F7 / Shift+F8": "F10 / F11 / Shift+F11",
  F9: "F5",
  "Ctrl+K": "Ctrl+Shift+G",
  "Ctrl+Shift+K": "",
  "Ctrl+T": "",
  "Ctrl+K / Ctrl+Shift+K / Ctrl+T": "Ctrl+Shift+G",
  "Ctrl+F4": "Mod+W",
  "Ctrl+Alt+S": "Mod+,",
  "Ctrl+R": IS_MAC ? "Alt+Mod+F" : "Ctrl+H",
  "Ctrl+F / Ctrl+R": IS_MAC ? "Mod+F / Alt+Mod+F" : "Ctrl+F / Ctrl+H",
  "Ctrl+Shift+T": "Ctrl+Shift+`",
  "Alt+F12": "Ctrl+`",
  "Alt+1": "Mod+Shift+E",
  "Alt+4": "Mod+Shift+U",
  "Alt+5": "Mod+Shift+D",
  "Alt+6": "Mod+Shift+M",
  "Alt+0": "Ctrl+Shift+G",
  "Shift Shift": "Mod+P",
};

/** JetBrains labels whose "Ctrl" is the real Control key on macOS too. */
const LITERAL_CTRL = new Set(["Ctrl+Espaço", "Ctrl+Tab"]);

const MAC_GLYPH: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘" };
const MAC_ORDER = ["Ctrl", "Alt", "Shift", "Mod"];

function formatCombo(combo: string): string {
  if (!combo.includes("+") || combo === "+") return combo;
  const parts = combo.split("+");
  const key = parts.pop()!;
  if (!IS_MAC) return [...parts.map((p) => (p === "Mod" ? "Ctrl" : p)), key].join("+");
  const mods = MAC_ORDER.filter((m) => parts.includes(m)).map((m) => MAC_GLYPH[m]).join("");
  return mods + (key === "Espaço" ? " Espaço" : key);
}

/** Shortcut label for menus and tooltips, in the active keymap and the platform's notation. */
export function displayShortcut(jb: string | undefined): string {
  if (!jb) return "";
  let s: string;
  if (keymapId() === "vscode" && jb in VS) s = VS[jb];
  else s = LITERAL_CTRL.has(jb) ? jb : jb.replace(/\bCtrl\b/g, "Mod");
  if (!s) return "";
  // "A / B" alternatives, "Mod+K Mod+I" chords
  return s
    .split(" / ")
    .map((alt) => alt.split(" ").map(formatCombo).join(" "))
    .join(" / ");
}

/** Reference tables for Settings › Keymap. */
export function keymapTable(): [string, string][] {
  if (keymapId() === "jetbrains") {
    return [
      ["Buscar em tudo", "Shift Shift"], ["Ir para arquivo", "Ctrl+Shift+N"], ["Ir para símbolo", "Ctrl+N / Ctrl+Alt+Shift+N"], ["Buscar ação", "Ctrl+Shift+A"],
      ["Arquivos recentes", "Ctrl+E"], ["Estrutura do arquivo", "Ctrl+F12"], ["Ir para linha", "Ctrl+G"], ["Localizar / Substituir", "Ctrl+F / Ctrl+R"],
      ["Localizar nos arquivos", "Ctrl+Shift+F"], ["Ir para declaração", "Ctrl+B / Ctrl+Clique"], ["Ir para implementação", "Ctrl+Alt+B"], ["Encontrar usos", "Alt+F7"],
      ["Renomear", "Shift+F6"], ["Ações de contexto / quick fix", "Alt+Enter"], ["Informação de parâmetros", "Ctrl+P"], ["Documentação rápida", "Ctrl+Q"],
      ["Completar código", "Ctrl+Espaço"], ["Reformatar código", "Ctrl+Alt+L"], ["Otimizar imports", "Ctrl+Alt+O"], ["Duplicar linha", "Ctrl+D"],
      ["Excluir linha", "Ctrl+Y"], ["Comentar", "Ctrl+/"], ["Estender seleção", "Ctrl+W"], ["Mover linha", "Alt+Shift+↑/↓"],
      ["Executar / Depurar", "Shift+F10 / Shift+F9"], ["Executar arquivo atual", "Ctrl+Shift+F10"], ["Parar", "Ctrl+F2"], ["Breakpoint", "Ctrl+F8"],
      ["Step over / into / out", "F8 / F7 / Shift+F8"], ["Continuar", "F9"], ["Commit / Push / Pull", "Ctrl+K / Ctrl+Shift+K / Ctrl+T"],
      ["Projeto / Database / Run / Debug", "Alt+1 / Alt+2 / Alt+4 / Alt+5"], ["Problemas / Estrutura / Git / Commit", "Alt+6 / Alt+7 / Alt+9 / Alt+0"],
      ["Terminal", "Alt+F12"], ["Fechar aba", "Ctrl+F4"], ["Ocultar janela ativa / todas", "Shift+Esc / Ctrl+Shift+F12"], ["Configurações", "Ctrl+Alt+S"],
    ].map(([a, b]) => [a, displayShortcut(b)]);
  }
  const W = IS_MAC;
  const raw: [string, string][] = [
    ["Paleta de comandos", "Mod+Shift+P / F1"], ["Abrir arquivo (Quick Open)", "Mod+P"], ["Ir para símbolo no projeto", "Mod+T"], ["Ir para símbolo no arquivo", "Mod+Shift+O"],
    ["Ir para linha", "Ctrl+G"], ["Localizar / Substituir", W ? "Mod+F / Alt+Mod+F" : "Ctrl+F / Ctrl+H"], ["Localizar nos arquivos", "Mod+Shift+F"], ["Arquivos recentes", "Mod+E"],
    ["Mostrar/ocultar barra lateral", "Mod+B"], ["Mostrar/ocultar barra secundária (direita)", "Alt+Mod+B"], ["Mostrar/ocultar painel inferior", "Mod+J"], ["Ocultar todas as janelas (Zen)", "Mod+K Z"],
    ["Explorer (Projeto)", "Mod+Shift+E"], ["Controle de versão (Commit)", "Ctrl+Shift+G"], ["Run and Debug", "Mod+Shift+D"], ["Plugins (Extensões)", "Mod+Shift+X"],
    ["Problemas", "Mod+Shift+M"], ["Saída (Run)", "Mod+Shift+U"], ["Terminal / Novo terminal", "Ctrl+` / Ctrl+Shift+`"], ["Focar no editor", "Mod+1"],
    ["Ir para definição / implementação", "F12 / Mod+F12"], ["Encontrar usos", "Shift+F12"], ["Renomear símbolo", "F2"], ["Quick fix", "Mod+."],
    ["Informação de parâmetros", "Mod+Shift+Espaço"], ["Documentação (hover)", "Mod+K Mod+I"], ["Completar código", "Ctrl+Espaço"], ["Formatar documento", "Shift+Alt+F"],
    ["Organizar imports", "Shift+Alt+O"], ["Próxima ocorrência / selecionar linha", "Mod+D / Mod+L"], ["Copiar linha abaixo / mover linha", "Shift+Alt+↓ / Alt+↑/↓"], ["Excluir linha / comentar", "Mod+Shift+K / Mod+/"],
    ["Expandir seleção", W ? "Ctrl+Shift+Mod+→" : "Shift+Alt+→"], ["Depurar / continuar", "F5"], ["Executar sem depurar / parar", "Ctrl+F5 / Shift+F5"], ["Breakpoint", "F9"],
    ["Step over / into / out", "F10 / F11 / Shift+F11"], ["Fechar aba / próxima aba", "Mod+W / Ctrl+Tab"], ["Salvar tudo", "Mod+S"], ["Configurações / Keymap", "Mod+, / Mod+K Mod+S"],
  ];
  return raw.map(([a, b]) => [a, b.split(" / ").map((x) => x.split(" ").map(formatCombo).join(" ")).join(" / ")]);
}
