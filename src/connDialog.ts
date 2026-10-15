import { api, type ConnConfig, type DbKind } from "./api";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { store } from "./state";
import { button, modal, popupList, toast, type PopupItem } from "./ui";
import { h, uid } from "./util";
import { icon } from "./icons";
import { DIALECTS, PRESETS, dialect } from "./dialects";

const COLORS = ["", "#3fb27f", "#3b82f6", "#e5a50a", "#e5484d", "#a970ff", "#16b3c4"];

type Preset = (typeof PRESETS)[number];

/** Small anchored picker for the database type; the connection dialog opens with it preselected. */
export function pickDbKind(anchor: HTMLElement | { x: number; y: number }, onPick: (kind: DbKind, preset?: Preset) => void) {
  const item = (kind: DbKind, section: string, preset?: Preset): PopupItem => {
    const d = dialect(kind);
    return { label: preset?.label ?? d.label, icon: preset?.icon ?? d.icon, section, action: () => onPick(kind, preset) };
  };
  popupList(
    anchor,
    [
      ...DIALECTS.filter((d) => d.native).map((d) => item(d.kind, "Driver incluído")),
      ...DIALECTS.filter((d) => !d.native).map((d) => item(d.kind, "Driver sob demanda")),
      ...PRESETS.map((p) => item(p.kind, "Compatíveis", p)),
    ],
    { width: 210, placeholder: "Buscar banco…", compact: true },
  );
}

export function openConnectionDialog(existing?: ConnConfig, onSaved?: (c: ConnConfig) => void, init?: { kind: DbKind; preset?: Preset }) {
  const projectRoot = store.projectRoot;
  const cfg: ConnConfig = existing
    ? { ...existing, project: existing.project ?? "" }
    : {
        id: uid(),
        name: "",
        kind: "postgres",
        host: "localhost",
        port: 5432,
        user: "postgres",
        password: "",
        database: "postgres",
        ssl: false,
        toolsDir: "",
        color: "",
        readOnly: false,
        // New connections belong to the current project unless marked as global.
        project: projectRoot,
      };

  const m = modal(existing ? `Editar conexão — ${existing.name}` : "Nova conexão", { width: 680 });

  const field = (label: string | HTMLElement, input: HTMLElement, cls = "") => h("label.field", { class: cls }, h("span", null, label), input);

  const txt = (key: keyof ConnConfig, type = "text", placeholder = "") => {
    const inp = h("input.input", {
      type,
      value: String(cfg[key] ?? ""),
      placeholder,
      spellcheck: false,
      oninput: (e: Event) => {
        const v = (e.target as HTMLInputElement).value;
        (cfg as unknown as Record<string, unknown>)[key] = type === "number" ? Number(v) : v;
        if (key === "host" || key === "database" || key === "port") syncUrl();
      },
    }) as HTMLInputElement;
    return inp;
  };
  const chk = (key: keyof ConnConfig, label: string) => {
    const inp = h("input", {
      type: "checkbox",
      checked: Boolean(cfg[key]),
      onchange: (e: Event) => ((cfg as unknown as Record<string, unknown>)[key] = (e.target as HTMLInputElement).checked),
    });
    return h("label.check", null, inp, label);
  };

  const nameI = txt("name", "text", "ex.: Produção, Local…");
  const hostI = txt("host");
  const portI = txt("port", "number");
  const userI = txt("user");
  const passI = txt("password", "password");
  const dbI = txt("database", "text");
  const toolsI = txt("toolsDir", "text", "Detectar automaticamente");
  const url = h("div.conn-url");
  const dbLabel = h("span");
  const driverInfo = h("div.driver-info");
  const status = h("div.test-status");

  const pickFile = async () => {
    const d = dialect(cfg.kind);
    const filters = [{ name: d.label, extensions: d.kind === "sqlite" ? ["db", "sqlite", "sqlite3", "db3"] : ["duckdb", "db"] }];
    const f = existing || cfg.database ? await open({ multiple: false, filters }) : (await open({ multiple: false, filters })) ?? (await saveDialog({ filters, defaultPath: "novo." + filters[0].extensions[0] }));
    if (typeof f === "string") {
      cfg.database = f;
      dbI.value = f;
      if (!cfg.name) nameI.value = cfg.name = f.split(/[\\/]/).pop() ?? "";
      syncUrl();
    }
  };

  const syncUrl = () => {
    const d = dialect(cfg.kind);
    const scheme: Record<string, string> = { pg: "postgresql", mysql: "mysql", sqlserver: "sqlserver", oracle: "oracle", firebird: "firebird", sqlite: "sqlite", duckdb: "duckdb", clickhouse: "clickhouse", mongo: "mongodb" };
    url.textContent = d.file ? `${scheme[d.family]}:${cfg.database || "…"}` : `${scheme[d.family]}://${cfg.host || "localhost"}:${cfg.port}/${cfg.database}`;
  };

  // ---- database type: chosen in the picker, shown as a header with "Trocar" ----
  const kinds = h("div.kind-head");
  const applyKind = (k: DbKind, preset?: Preset) => {
    const prev = dialect(cfg.kind);
    const d = dialect(k);
    cfg.kind = k;
    const port = preset?.port ?? d.port;
    const user = preset?.user ?? d.user;
    const database = preset?.database ?? d.database;
    if (!existing || cfg.port === prev.port || preset) cfg.port = port;
    if (!existing || cfg.user === prev.user || preset) cfg.user = user;
    if (!existing || cfg.database === prev.database || preset || d.file || prev.file) cfg.database = database;
    if (preset?.ssl) cfg.ssl = true;
    if (d.file) cfg.host = "";
    else if (!cfg.host) cfg.host = "localhost";
    renderForm();
  };
  let presetLabel = init?.preset?.label;
  const renderKinds = () => {
    const d = dialect(cfg.kind);
    const change = h("button.link", { title: "Escolher outro banco" }, "Trocar") as HTMLButtonElement;
    change.onclick = () =>
      pickDbKind(change, (k, p) => {
        presetLabel = p?.label;
        if (p && !cfg.name) nameI.value = cfg.name = p.label;
        applyKind(k, p);
      });
    kinds.replaceChildren(
      h("span.kh-icon", null, icon(presetLabel ? (init?.preset?.icon ?? d.icon) : d.icon)),
      h("div.kh-text", null, h("b", null, presetLabel ?? d.label), h("span.dim", null, d.native ? "Driver incluído no Rits" : "Driver baixado na primeira conexão")),
      h("span.grow"),
      existing ? "" : change,
    );
  };

  const refreshDriver = async () => {
    const d = dialect(cfg.kind);
    if (d.native) return driverInfo.replaceChildren(icon("status/success"), h("span", null, `Driver ${d.label} incluído no Rits.`));
    const st = await api.driverStatus(cfg.kind).catch(() => null);
    if (cfg.kind !== d.kind) return;
    driverInfo.replaceChildren(
      icon(st?.installed ? "status/success" : "general/download"),
      h("span", null, st?.installed ? `Driver ${d.label} instalado (${st.packages.join(", ") || "nativo do Python"}).` : `O driver ${d.label} (${st?.packages.join(", ") || "sqlite3"}) será baixado ao testar ou salvar a conexão.`),
    );
  };

  const form = h("div.form-grid");
  const renderForm = () => {
    const d = dialect(cfg.kind);
    renderKinds();
    hostI.value = cfg.host;
    portI.value = String(cfg.port);
    userI.value = cfg.user;
    dbI.value = cfg.database;
    dbI.placeholder = d.databasePlaceholder ?? "";
    dbLabel.textContent = d.databaseLabel;
    const scope = h("input", {
      type: "checkbox",
      checked: !cfg.project,
      disabled: !projectRoot,
      onchange: (e: Event) => (cfg.project = (e.target as HTMLInputElement).checked ? "" : cfg.project || projectRoot),
    });
    const scopeHint = !projectRoot
      ? "Sem projeto aberto: a conexão fica disponível em todos."
      : cfg.project && cfg.project !== projectRoot
        ? `Pertence a outro projeto: ${cfg.project}`
        : `Desmarcado: aparece só neste projeto (${projectRoot.split("/").pop()}).`;
    form.replaceChildren(
      field("Nome", nameI, "span2"),
      ...(d.file
        ? [field(dbLabel, h("div.input-row", null, dbI, button("…", pickFile)), "span2")]
        : [
            field(d.family === "mongo" ? "Host ou URI (mongodb+srv://…)" : "Host", hostI),
            field("Porta", portI),
            field("Usuário", userI),
            field("Senha", passI),
            field(dbLabel, dbI, "span2"),
          ]),
      h("div.span2", null, url),
      h("div.span2.checks", null, d.file ? "" : chk("ssl", "Usar SSL/TLS"), chk("readOnly", "Somente leitura")),
      h("div.span2.scope-row", null, h("label.check", null, scope, "Mostrar esta conexão em todos os projetos"), h("span.hint", null, scopeHint)),
      d.backup
        ? field(
            "Pasta das ferramentas nativas (pg_dump / mysqldump)",
            h(
              "div.input-row",
              null,
              toolsI,
              button("…", async () => {
                const dir = await open({ directory: true });
                if (typeof dir === "string") {
                  cfg.toolsDir = dir;
                  toolsI.value = dir;
                }
              }),
            ),
            "span2",
          )
        : "",
      field("Cor da conexão", colors, "span2"),
    );
    syncUrl();
    refreshDriver();
  };

  const colors = h("div.color-row");
  const renderColors = () =>
    colors.replaceChildren(
      ...COLORS.map((c) =>
        h("button.swatch", {
          class: cfg.color === c ? "active" : "",
          style: c ? `background:${c}` : "",
          title: c ? c : "Sem cor",
          onclick: () => {
            cfg.color = c;
            renderColors();
          },
        }),
      ),
    );

  m.body.append(kinds, form, driverInfo, status);
  renderColors();
  if (init && !existing) {
    if (init.preset) nameI.value = cfg.name = init.preset.label;
    applyKind(init.kind, init.preset);
  } else renderForm();

  /** Shows pip progress while the backend downloads a driver. */
  const withDriverProgress = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    const d = dialect(cfg.kind);
    const st = d.native ? null : await api.driverStatus(cfg.kind).catch(() => null);
    const off = st && !st.installed ? await api.onDriverProgress((p) => p.kind === cfg.kind && p.line.trim() && (status.lastElementChild!.textContent = p.line.trim().slice(0, 160))) : null;
    status.className = "test-status busy";
    status.replaceChildren(icon("general/refresh", "spin"), h("span", null, st && !st.installed ? `Baixando o driver ${d.label}…` : label));
    try {
      return await fn();
    } finally {
      off?.();
      refreshDriver();
    }
  };

  const test = async () => {
    try {
      const info = await withDriverProgress("Testando conexão…", () => api.testConnection(cfg));
      status.className = "test-status ok";
      status.replaceChildren(icon("check"), h("span", null, `Conectado — ${info.version.split(",")[0]}`));
    } catch (e) {
      status.className = "test-status err";
      status.replaceChildren(icon("warn"), h("span", null, String(e)));
    }
  };

  const save = async () => {
    if (!cfg.name.trim()) cfg.name = dialect(cfg.kind).file ? cfg.database.split(/[\\/]/).pop() || "banco" : `${cfg.user}@${cfg.host}`;
    try {
      await withDriverProgress("Salvando…", () => store.save(cfg));
    } catch (e) {
      status.className = "test-status err";
      status.replaceChildren(icon("warn"), h("span", null, String(e)));
      return;
    }
    m.close();
    toast(`Conexão "${cfg.name}" salva`, "ok");
    onSaved?.(cfg);
  };

  m.footer.append(h("div.grow", null, button("Testar conexão", test, "", "plug")), button("Cancelar", () => m.close()), button("Salvar", save, "primary"));
  setTimeout(() => nameI.focus());
}
