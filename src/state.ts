import { api, type CompletionTable, type ConnConfig, type ServerInfo } from "./api";

type Listener = () => void;

export interface LogEntry {
  time: number;
  connName: string;
  db: string;
  sql: string;
  ok: boolean;
  message: string;
  elapsedMs: number;
}

export interface HistoryEntry {
  time: number;
  connId: string;
  db: string;
  sql: string;
}

class Store {
  connections: ConnConfig[] = [];
  connected = new Map<string, ServerInfo>();
  connecting = new Set<string>();
  log: LogEntry[] = [];
  history: HistoryEntry[] = [];
  private completion = new Map<string, Promise<CompletionTable[]>>();
  private listeners = new Map<string, Set<Listener>>();

  on(evt: string, fn: Listener) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt)!.add(fn);
    return () => this.listeners.get(evt)!.delete(fn);
  }

  emit(evt: string) {
    this.listeners.get(evt)?.forEach((f) => f());
  }

  async load() {
    this.connections = await api.listConnections();
    this.history = (await api.loadDoc<HistoryEntry[]>("history")) ?? [];
    this.emit("connections");
  }

  conn(id: string) {
    return this.connections.find((c) => c.id === id);
  }

  async save(cfg: ConnConfig) {
    await api.saveConnection(cfg);
    this.connected.delete(cfg.id);
    this.invalidateCompletion(cfg.id);
    await this.load();
  }

  async remove(id: string) {
    await api.deleteConnection(id);
    this.connected.delete(id);
    await this.load();
  }

  async connect(id: string): Promise<ServerInfo> {
    const existing = this.connected.get(id);
    if (existing) return existing;
    this.connecting.add(id);
    this.emit("status");
    try {
      const info = await api.connect(id);
      this.connected.set(id, info);
      return info;
    } finally {
      this.connecting.delete(id);
      this.emit("status");
    }
  }

  async disconnect(id: string) {
    await api.disconnect(id);
    this.connected.delete(id);
    this.invalidateCompletion(id);
    this.emit("status");
  }

  completionFor(connId: string, db: string): Promise<CompletionTable[]> {
    const key = connId + "\u0000" + db;
    let p = this.completion.get(key);
    if (!p) {
      p = api.completion(connId, db).catch(() => []);
      this.completion.set(key, p);
    }
    return p;
  }

  invalidateCompletion(connId: string) {
    for (const k of [...this.completion.keys()]) if (k.startsWith(connId + "\u0000")) this.completion.delete(k);
  }

  addLog(e: LogEntry) {
    this.log.push(e);
    if (this.log.length > 2000) this.log.splice(0, this.log.length - 2000);
    this.emit("log");
  }

  addHistory(e: HistoryEntry) {
    const last = this.history[this.history.length - 1];
    if (last && last.sql === e.sql && last.connId === e.connId) return;
    this.history.push(e);
    if (this.history.length > 1000) this.history.splice(0, this.history.length - 1000);
    this.emit("history");
    saveHistory(this.history);
  }
}

let historyTimer: number | undefined;
function saveHistory(h: HistoryEntry[]) {
  clearTimeout(historyTimer);
  historyTimer = window.setTimeout(() => api.saveDoc("history", h).catch(() => {}), 800);
}

export const store = new Store();
