// Add / edit an Airflow instance. The password or token is sent once to the backend, which stores
// it in the OS secret store; it is never written to files nor kept in the frontend.
import { h } from "../../util";
import { icon } from "../../icons";
import { button, modal, toast } from "../../ui";
import { errorText, instances, isAfError, type AfInstance, type AuthKind } from "./api";

export function openInstanceDialog(existing: AfInstance | undefined, onSaved: (i: AfInstance) => void) {
  const inst: AfInstance = existing
    ? { ...existing }
    : { id: "", name: "", url: "http://localhost:8080", auth: "password", username: "airflow", timeoutSecs: 30, verifyTls: true, localEnv: "" };
  const m = modal(existing ? `Editar instância — ${existing.name}` : "Conectar ao Airflow", { width: 560 });
  const inp = (v: string, ph = "", type = "text") => h("input.input", { value: v, placeholder: ph, type, spellcheck: false }) as HTMLInputElement;
  const name = inp(inst.name, "ex.: Produção, Homologação");
  const url = inp(inst.url, "https://airflow.empresa.com");
  const user = inp(inst.username, "usuário");
  const secret = inp("", existing?.hasSecret ? "•••••• (salvo no cofre do sistema — deixe em branco para manter)" : "", "password");
  const timeout = inp(String(inst.timeoutSecs), "", "number");
  timeout.style.width = "90px";
  const tls = h("input", { type: "checkbox", checked: inst.verifyTls }) as HTMLInputElement;
  const auth = h(
    "select.select",
    null,
    ...([
      ["password", "Usuário e senha (token JWT via /auth/token)"],
      ["token", "Token de API (Bearer)"],
      ["none", "Sem autenticação"],
    ] as [AuthKind, string][]).map(([v, l]) => h("option", { value: v, selected: inst.auth === v }, l)),
  ) as HTMLSelectElement;
  const userRow = h("label.field", null, h("span", null, "Usuário"), user);
  const secretLabel = h("span", null, "Senha");
  const secretRow = h("label.field", null, secretLabel, secret);
  const syncAuth = () => {
    userRow.classList.toggle("hidden", auth.value !== "password");
    secretRow.classList.toggle("hidden", auth.value === "none");
    secretLabel.textContent = auth.value === "token" ? "Token" : "Senha";
  };
  auth.onchange = syncAuth;
  syncAuth();
  const tlsWarn = h("div.af-warn.hidden", null, icon("status/warning"), "A verificação TLS desligada aceita certificados inválidos: use só em ambientes de teste que você controla.");
  tls.onchange = () => tlsWarn.classList.toggle("hidden", tls.checked);
  tlsWarn.classList.toggle("hidden", tls.checked);
  const status = h("div.test-status");

  const read = (): AfInstance => ({
    ...inst,
    name: name.value.trim(),
    url: url.value.trim(),
    auth: auth.value as AuthKind,
    username: user.value.trim(),
    timeoutSecs: Math.max(3, Number(timeout.value) || 30),
    verifyTls: tls.checked,
  });

  const test = async () => {
    status.className = "test-status busy";
    status.replaceChildren(icon("general/refresh", "spin"), h("span", null, "Testando…"));
    try {
      const r = await instances.test(read(), secret.value || null);
      const comps = Object.entries(r.health ?? {}).map(([k, v]) => `${k}: ${v?.status ?? "?"}`).join(" · ");
      status.className = "test-status ok";
      status.replaceChildren(icon("check"), h("span", null, `Conectado — Airflow ${r.version}${r.dags != null ? ` · ${r.dags} DAG(s)` : ""}${comps ? `\n${comps}` : ""}`));
    } catch (e) {
      status.className = "test-status err";
      status.replaceChildren(icon("warn"), h("span", null, errorText(e)));
    }
  };

  const save = async () => {
    const i = read();
    if (!/^https?:\/\//.test(i.url)) return toast("A URL precisa começar com http:// ou https://", "error");
    if (!existing && i.auth !== "none" && !secret.value) return toast(i.auth === "token" ? "Informe o token." : "Informe a senha.", "error");
    try {
      const saved = await instances.save(i, secret.value || null);
      m.close();
      toast(`Instância "${saved.name}" salva`, "ok");
      onSaved(saved);
    } catch (e) {
      status.className = "test-status err";
      status.replaceChildren(icon("warn"), h("span", null, isAfError(e) ? e.message : String(e)));
    }
  };

  m.body.append(
    h(
      "div.form-grid",
      null,
      h("label.field.span2", null, h("span", null, "Nome"), name),
      h("label.field.span2", null, h("span", null, "URL do Airflow (sem /api/v2)"), url),
      h("label.field.span2", null, h("span", null, "Autenticação"), auth),
      userRow,
      secretRow,
      h("label.field", null, h("span", null, "Tempo limite (s)"), timeout),
      h("label.check", { style: "align-self:end;padding-bottom:6px" }, tls, "Verificar certificado TLS"),
    ),
    tlsWarn,
    h("div.hint", { style: "margin-top:10px" }, "Requer Airflow 3 (API pública /api/v2). A senha ou token é guardado no cofre do sistema (Keychain / Credential Manager), nunca em arquivos de configuração."),
    status,
  );
  m.footer.append(h("div.grow", null, button("Testar conexão", test, "", "plug")), button("Cancelar", () => m.close()), button("Salvar", save, "primary"));
  setTimeout(() => (existing ? secret : name).focus());
}
