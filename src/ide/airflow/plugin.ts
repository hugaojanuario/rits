// Airflow plugin entry point. Only this small module is loaded with the IDE; the panel, API
// client and environment code are imported on demand when the plugin is enabled (Vite splits
// them into a separate chunk), so the IDE stays light for everyone else.
import type { Workbench } from "../workbench";

const KEY = "plugin.airflow";

export function airflowEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setAirflowEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("rits-plugins"));
}

export interface AirflowHandle {
  dispose(): Promise<void>;
  /** "Nova DAG" from the project tree. */
  newDag(dir?: string): void;
}

/** Loads the plugin's UI (tool window, project integration) for a workbench. */
export async function loadAirflow(wb: Workbench): Promise<AirflowHandle> {
  const { AirflowTools } = await import("./panel");
  return new AirflowTools(wb);
}
