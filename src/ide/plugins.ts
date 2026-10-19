// Optional plugins loaded on demand (Jupyter, dbt, Migration Audit, AI assistant; Airflow keeps its own entry).
// Each plugin has a tiny entry module (enabled flag + loader); everything else is imported only
// when the plugin is enabled, so Vite puts it in a separate chunk and the IDE stays light.
import type { Extension } from "@codemirror/state";
import type { MenuItem } from "../ui";
import type { Workbench } from "./workbench";

export interface PluginHandle {
  /** Stops timers, processes, requests and connections owned by the plugin. Files and data stay. */
  dispose(): Promise<void>;
  /** Items of the project tree "Novo" menu. */
  newItems?(dir: string): MenuItem[];
}

export function pluginEnabled(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function setPluginEnabled(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("rits-plugins"));
}

export interface LazyPlugin {
  id: string;
  key: string;
  load: (wb: Workbench) => Promise<PluginHandle>;
}

export const LAZY_PLUGINS: LazyPlugin[] = [
  { id: "jupyter", key: "plugin.jupyter", load: async (wb) => new (await import("./jupyter/panel")).JupyterTools(wb) },
  { id: "dbt", key: "plugin.dbt", load: async (wb) => new (await import("./dbt/panel")).DbtTools(wb) },
  { id: "audit", key: "plugin.audit", load: async (wb) => new (await import("./audit/panel")).AuditTools(wb) },
  { id: "assistant", key: "plugin.assistant", load: async (wb) => new (await import("./assistant/panel")).AssistantTools(wb) },
];

// ---------------- editor extension points ----------------

/** What a plugin can add to code editors (registered while the plugin is loaded). */
export interface EditorContribution {
  id: string;
  /** Opens the file itself instead of the text editor (e.g. notebooks). Return true when handled. */
  open?(path: string, opts: { background?: boolean; line?: number }): Promise<boolean> | boolean;
  /** CodeMirror extensions for a file (e.g. Jinja highlighting in dbt models). */
  extensions?(path: string): Extension[];
  /** Go to definition at an offset; return true when handled (before the language server). */
  definition?(path: string, text: string, pos: number): Promise<boolean>;
  /** Buttons of the plugin action bar above the editor. */
  actions?(path: string, text: string): { label: string; icon: string; title?: string; run: () => void }[];
}

const contributions: EditorContribution[] = [];

export function contribute(c: EditorContribution): () => void {
  contributions.push(c);
  window.dispatchEvent(new Event("rits-editor-contrib"));
  return () => {
    const i = contributions.indexOf(c);
    if (i >= 0) contributions.splice(i, 1);
    window.dispatchEvent(new Event("rits-editor-contrib"));
  };
}

export function editorContributions(): readonly EditorContribution[] {
  return contributions;
}
