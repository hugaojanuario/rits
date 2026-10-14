import { api, type ConnConfig, type DbKind } from "./api";
import { open } from "@tauri-apps/plugin-dialog";
import { store } from "./state";
import { button, modal, toast } from "./ui";
import { h, uid } from "./util";
import { icon } from "./icons";

const COLORS = ["", "#3fb27f", "#3b82f6", "#e5a50a", "#e5484d", "#a970ff", "#16b3c4"];

const DEFAULTS: Record<DbKind, Partial<ConnConfig>> = {
  postgres: { port: 5432, user: "postgres", database: "postgres" },
  mysql: { port: 3306, user: "root", database: "" },
};

export function openConnectionDialog(existing?: ConnConfig, onSaved?: (c: ConnConfig) => void) {
  const cfg: ConnConfig = existing
    ? { ...existing }
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
      };

  const m = modal(existing ? `Editar conexão — ${existing.name}` : "Nova conexão", { width: 620 });

  const field = (label: string, input: HTMLElement, cls = "") =>
    h("label.field", { class: cls }, h("span", null, label), input);

  const txt = (key: keyof ConnConfig, type = "text", placeholder = "") => {
    const inp = h("input.input", {
      type,
      value: String(cfg[key] ?? ""),
      placeholder,
      spellcheck: false,
      oninput: (e: Event) => {
        const v = (e.target as HTMLInputElement).value;
        (cfg as unknown as Record<string, unknown>)[key] = type === "number" ? Number(v) : v;
        if (key === "host" || key === "database") syncUrl();
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

  // Driver selector, DataGrip-style cards
  const kinds = h("div.kind-cards");
  const renderKinds = () => {
    kinds.replaceChildren(
      ...(["postgres", "mysql"] as DbKind[]).map((k) =>
        h(
          "button.kind-card",
          {
            class: cfg.kind === k ? "active" : "",
            onclick: () => {
              if (cfg.kind === k) return;
              const prevDefaults = DEFAULTS[cfg.kind];
              cfg.kind = k;
              const d = DEFAULTS[k];
              if (cfg.port === prevDefaults.port) cfg.port = d.port!;
              if (cfg.user === prevDefaults.user) cfg.user = d.user!;
              if (cfg.database === prevDefaults.database) cfg.database = d.database!;
              portI.value = String(cfg.port);
              userI.value = cfg.user;
              dbI.value = cfg.database;
              renderKinds();
              syncUrl();
            },
          },
          icon(k),
          k === "postgres" ? "PostgreSQL" : "MySQL / MariaDB",
        ),
      ),
    );
  };

  const nameI = txt("name", "text", "ex.: Produção, Local…");
  const hostI = txt("host");
  const portI = txt("port", "number");
  const userI = txt("user");
  const passI = txt("password", "password");
  const dbI = txt("database", "text", "(opcional)");
  const toolsI = txt("toolsDir", "text", "Detectar automaticamente");
  const url = h("div.conn-url");
  const syncUrl = () => {
    const scheme = cfg.kind === "postgres" ? "postgresql" : "mysql";
    url.textContent = `${scheme}://${cfg.host || "localhost"}:${cfg.port}/${cfg.database}`;
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

  const status = h("div.test-status");

  m.body.append(
    kinds,
    h(
      "div.form-grid",
      null,
      field("Nome", nameI, "span2"),
      field("Host", hostI),
      field("Porta", portI),
      field("Usuário", userI),
      field("Senha", passI),
      field("Database", dbI, "span2"),
      h("div.span2", null, url),
      h("div.span2.checks", null, chk("ssl", "Usar SSL/TLS"), chk("readOnly", "Somente leitura")),
      field(
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
      ),
      field("Cor da conexão", colors, "span2"),
    ),
    status,
  );
  renderKinds();
  renderColors();
  syncUrl();

  const test = async () => {
    status.className = "test-status busy";
    status.textContent = "Testando conexão…";
    try {
      const info = await api.testConnection(cfg);
      status.className = "test-status ok";
      status.replaceChildren(icon("check"), h("span", null, `Conectado — ${info.version.split(",")[0]}`));
    } catch (e) {
      status.className = "test-status err";
      status.replaceChildren(icon("warn"), h("span", null, String(e)));
    }
  };

  const save = async () => {
    if (!cfg.name.trim()) cfg.name = `${cfg.user}@${cfg.host}`;
    await store.save(cfg);
    m.close();
    toast(`Conexão "${cfg.name}" salva`, "ok");
    onSaved?.(cfg);
  };

  m.footer.append(
    h("div.grow", null, button("Testar conexão", test, "", "plug")),
    button("Cancelar", () => m.close()),
    button("Salvar", save, "primary"),
  );
  setTimeout(() => nameI.focus());
}
