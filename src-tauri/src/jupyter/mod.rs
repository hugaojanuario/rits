//! Jupyter plugin (backend side). REST calls and kernel WebSockets go through these commands:
//! the token stays in the OS secret store, Jupyter's origin checks are satisfied (no browser
//! origin), and every kernel message is built and parsed in `proto`.
//!
//! Disabling the plugin (`jupyter_release`) closes the IDE's WebSockets and HTTP clients only:
//! kernels and servers keep running (external servers are never stopped by the IDE).

pub mod client;
pub mod proto;

use crate::airflow::client::AfError;
use crate::procs::{Procs, SpawnSpec};
use crate::secrets::{self, OsStore};
use crate::store;
use client::{env_token_key, server_key, JupyterClient};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

/// Pinned image of the local environment (Jupyter Docker Stacks, multi-arch, JupyterLab 4.6.4).
pub const JUPYTER_IMAGE: &str = "quay.io/jupyter/scipy-notebook:2026-10-12";

fn default_timeout() -> u64 {
    30
}
fn yes() -> bool {
    true
}
fn token_auth() -> String {
    "token".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub url: String,
    /// "token" (Authorization: token ...) or "none" (servers explicitly started without auth).
    #[serde(default = "token_auth")]
    pub auth: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    #[serde(default = "yes")]
    pub verify_tls: bool,
    /// Slug of the local Docker environment that created it ("" = external server).
    #[serde(default)]
    pub local_env: String,
    /// Local project folder that the server sees, and its path relative to the server root
    /// (e.g. "/Users/me/proj" ↔ "work"). Empty = the server does not see the project files.
    #[serde(default)]
    pub local_root: String,
    #[serde(default)]
    pub remote_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    #[serde(flatten)]
    pub srv: Server,
    pub has_secret: bool,
}

struct Chan {
    tx: mpsc::UnboundedSender<Message>,
    owner: String,
    session: String,
    task: tokio::task::AbortHandle,
}

pub struct JupyterState {
    pub client: JupyterClient,
    chans: Mutex<HashMap<String, Chan>>,
    inflight: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl Default for JupyterState {
    fn default() -> Self {
        JupyterState { client: JupyterClient::new(Arc::new(OsStore)), chans: Mutex::new(HashMap::new()), inflight: Mutex::new(HashMap::new()) }
    }
}

impl JupyterState {
    /// Page reloaded or window closed: drop its kernel connections (kernels keep running).
    pub async fn close_owner(&self, owner: &str) {
        let mut m = self.chans.lock().await;
        m.retain(|_, c| {
            if c.owner == owner {
                c.task.abort();
                false
            } else {
                true
            }
        });
    }
}

const DOC: &str = "jupyter-servers";

fn load(app: &AppHandle) -> Result<Vec<Server>, AfError> {
    let v = store::read_doc(app, DOC).map_err(|e| AfError::new("invalid", None, e))?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

fn save_all(app: &AppHandle, all: &[Server]) -> Result<(), AfError> {
    store::write_doc(app, DOC, &serde_json::to_value(all).unwrap_or(Value::Null)).map_err(|e| AfError::new("invalid", None, e))
}

fn get(app: &AppHandle, id: &str) -> Result<Server, AfError> {
    load(app)?.into_iter().find(|s| s.id == id).ok_or_else(|| AfError::new("notFound", None, "Servidor Jupyter não encontrado."))
}

#[tauri::command]
pub fn jupyter_servers(app: AppHandle, st: State<'_, JupyterState>) -> Result<Vec<ServerView>, AfError> {
    let sec = st.client.secrets();
    Ok(load(&app)?
        .into_iter()
        .map(|s| {
            let has_secret = sec.get(&server_key(&s.id)).ok().flatten().is_some();
            ServerView { srv: s, has_secret }
        })
        .collect())
}

#[tauri::command]
pub async fn jupyter_save_server(app: AppHandle, st: State<'_, JupyterState>, mut srv: Server, secret: Option<String>) -> Result<Server, AfError> {
    srv.url = client::base_url(&srv.url)?;
    if srv.auth != "none" {
        srv.auth = "token".into();
    }
    if srv.name.trim().is_empty() {
        srv.name = srv.url.clone();
    }
    if srv.id.is_empty() {
        srv.id = format!("jp{}", secrets::random_secret(6)?.to_lowercase().replace(['-', '_'], "x"));
    }
    if let Some(s) = secret.filter(|s| !s.is_empty()) {
        st.client.secrets().set(&server_key(&srv.id), &s)?;
    }
    let mut all = load(&app)?;
    match all.iter_mut().find(|x| x.id == srv.id) {
        Some(x) => *x = srv.clone(),
        None => all.push(srv.clone()),
    }
    save_all(&app, &all)?;
    st.client.forget(Some(&srv.id)).await;
    Ok(srv)
}

#[tauri::command]
pub async fn jupyter_delete_server(app: AppHandle, st: State<'_, JupyterState>, id: String) -> Result<(), AfError> {
    let mut all = load(&app)?;
    all.retain(|s| s.id != id);
    save_all(&app, &all)?;
    st.client.secrets().delete(&server_key(&id))?;
    st.client.forget(Some(&id)).await;
    Ok(())
}

#[tauri::command]
pub async fn jupyter_test(st: State<'_, JupyterState>, srv: Server, secret: Option<String>) -> Result<Value, AfError> {
    let mut s = srv;
    if s.id.is_empty() {
        s.id = "__test".into();
    }
    let r = st.client.test(&s, secret.as_deref()).await;
    if s.id == "__test" {
        st.client.forget(Some("__test")).await;
    }
    r
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn jupyter_request(
    app: AppHandle,
    st: State<'_, JupyterState>,
    id: String,
    method: String,
    path: String,
    query: Option<Vec<(String, String)>>,
    body: Option<Value>,
    request_id: Option<String>,
) -> Result<Value, AfError> {
    let srv = get(&app, &id)?;
    let handle = app.clone();
    let task = tokio::spawn(async move {
        let st = handle.state::<JupyterState>();
        st.client.request(&srv, &method, &path, &query.unwrap_or_default(), body.as_ref()).await
    });
    if let Some(rid) = &request_id {
        st.inflight.lock().await.insert(rid.clone(), task.abort_handle());
    }
    let r = task.await;
    if let Some(rid) = &request_id {
        st.inflight.lock().await.remove(rid);
    }
    match r {
        Ok(v) => v,
        Err(e) if e.is_cancelled() => Err(AfError::new("cancelled", None, "Requisição cancelada.")),
        Err(e) => Err(AfError::new("http", None, e.to_string())),
    }
}

#[tauri::command]
pub async fn jupyter_cancel(st: State<'_, JupyterState>, request_id: String) -> Result<(), AfError> {
    if let Some(h) = st.inflight.lock().await.remove(&request_id) {
        h.abort();
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MsgEvent {
    id: String,
    #[serde(flatten)]
    msg: proto::Incoming,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClosedEvent {
    id: String,
    reason: String,
}

/// Opens the channels WebSocket of a kernel. Messages arrive as `jupyter-msg {id: chan, ...}`;
/// when the socket closes (server stopped, kernel deleted, network) `jupyter-closed` is emitted.
/// Reconnecting is the frontend's decision and never re-runs cells.
#[tauri::command]
pub async fn jupyter_ws_open(
    app: AppHandle,
    window: tauri::Window,
    st: State<'_, JupyterState>,
    chan: String,
    id: String,
    kernel_id: String,
    session_id: String,
) -> Result<(), AfError> {
    let srv = get(&app, &id)?;
    let token = st.client.token(&srv, None)?;
    let ws = connect_channels(&srv, token.as_deref(), &kernel_id, &session_id).await?;
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let a = app.clone();
    let c = chan.clone();
    let task = tokio::spawn(async move {
        let reason = loop {
            tokio::select! {
                out = rx.recv() => match out {
                    Some(m) => if let Err(e) = sink.send(m).await { break e.to_string(); },
                    None => { let _ = sink.send(Message::Close(None)).await; break "closed".into(); }
                },
                inc = stream.next() => match inc {
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(msg) = proto::parse_text(t.as_str()) { let _ = a.emit("jupyter-msg", MsgEvent { id: c.clone(), msg }); }
                    }
                    Some(Ok(Message::Binary(b))) => {
                        if let Ok(msg) = proto::parse_binary(&b) { let _ = a.emit("jupyter-msg", MsgEvent { id: c.clone(), msg }); }
                    }
                    Some(Ok(Message::Close(f))) => break f.map(|f| f.reason.to_string()).unwrap_or_else(|| "o servidor encerrou a conexão".into()),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break e.to_string(),
                    None => break "conexão encerrada".into(),
                }
            }
        };
        let _ = a.emit("jupyter-closed", ClosedEvent { id: c.clone(), reason });
        a.state::<JupyterState>().chans.lock().await.remove(&c);
    });
    let mut m = st.chans.lock().await;
    if let Some(old) = m.remove(&chan) {
        old.task.abort();
    }
    m.insert(chan, Chan { tx, owner: window.label().to_string(), session: session_id, task: task.abort_handle() });
    Ok(())
}

pub type KernelSocket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connects to `/api/kernels/<id>/channels` with the token header (no browser Origin is sent,
/// so Jupyter's origin check accepts the IDE).
pub async fn connect_channels(srv: &Server, token: Option<&str>, kernel_id: &str, session_id: &str) -> Result<KernelSocket, AfError> {
    let url = client::channels_url(&srv.url, kernel_id, session_id)?;
    let mut req = url.as_str().into_client_request().map_err(|e| AfError::new("invalid", None, e.to_string()))?;
    if let Some(t) = token {
        req.headers_mut().insert("Authorization", format!("token {t}").parse().map_err(|_| AfError::new("invalid", None, "token inválido"))?);
    }
    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(!srv.verify_tls)
        .build()
        .map_err(|e| AfError::new("tls", None, e.to_string()))?;
    let fut = tokio_tungstenite::connect_async_tls_with_config(req, None, false, Some(tokio_tungstenite::Connector::NativeTls(tls)));
    let (ws, _) = tokio::time::timeout(std::time::Duration::from_secs(srv.timeout_secs.clamp(3, 60)), fut)
        .await
        .map_err(|_| AfError::new("timeout", None, "O kernel não respondeu à conexão WebSocket dentro do tempo limite."))?
        .map_err(|e| {
            let s = e.to_string();
            if s.contains("401") || s.contains("403") {
                AfError::new("auth", None, format!("O Jupyter Server recusou a conexão com o kernel: {s}"))
            } else if s.contains("404") {
                AfError::new("notFound", None, "Kernel não encontrado no servidor (foi encerrado?).")
            } else {
                AfError::new("unreachable", None, format!("Falha ao conectar ao kernel: {s}"))
            }
        })?;
    Ok(ws)
}

/// Sends a request on a kernel channel; returns its msg_id (parent of the replies).
#[tauri::command]
pub async fn jupyter_ws_send(st: State<'_, JupyterState>, chan: String, channel: String, msg_type: String, content: Value) -> Result<String, AfError> {
    let m = st.chans.lock().await;
    let c = m.get(&chan).ok_or_else(|| AfError::new("unreachable", None, "Sem conexão com o kernel. Reconecte antes de executar."))?;
    let msg_id = secrets::uuid4();
    let msg = proto::request(&c.session, &channel, &msg_type, content, &msg_id).map_err(|e| AfError::new("invalid", None, e))?;
    c.tx.send(Message::Text(msg.to_string().into())).map_err(|_| AfError::new("unreachable", None, "A conexão com o kernel foi encerrada."))?;
    Ok(msg_id)
}

#[tauri::command]
pub async fn jupyter_ws_close(st: State<'_, JupyterState>, chan: String) -> Result<(), AfError> {
    if let Some(c) = st.chans.lock().await.remove(&chan) {
        c.task.abort();
    }
    Ok(())
}

/// Plugin disabled: close the IDE's kernel connections and HTTP clients. Kernels and servers
/// keep running.
#[tauri::command]
pub async fn jupyter_release(st: State<'_, JupyterState>) -> Result<(), AfError> {
    for (_, c) in st.chans.lock().await.drain() {
        c.task.abort();
    }
    for (_, h) in st.inflight.lock().await.drain() {
        h.abort();
    }
    st.client.forget(None).await;
    Ok(())
}

// ---------------- local Docker environment ----------------

pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty() && slug.len() <= 40 && slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn env_dir(app: &AppHandle, slug: &str) -> Result<std::path::PathBuf, AfError> {
    if !valid_slug(slug) {
        return Err(AfError::new("invalid", None, "Nome do ambiente inválido (use letras minúsculas, números e hífen)."));
    }
    let d = app.path().app_config_dir().map_err(|e| AfError::new("invalid", None, e.to_string()))?.join("jupyter-envs").join(slug);
    std::fs::create_dir_all(&d).map_err(|e| AfError::new("invalid", None, e.to_string()))?;
    Ok(d)
}

/// compose.yaml of a local JupyterLab: pinned image, port on 127.0.0.1 only, token required
/// (injected from the OS store at run time, never written here), project bind-mounted at
/// /home/jovyan/work and a named volume for the home folder (settings, user packages).
pub fn compose_for(slug: &str) -> String {
    format!(
        r#"# Ambiente LOCAL do JupyterLab criado pelo Rits (desenvolvimento).
# Imagem fixada: {JUPYTER_IMAGE}
# O token vem do Keychain / Credential Manager no momento do "docker compose" (variável
# RITS_JP_TOKEN): nada sensível fica gravado neste arquivo. Gerencie pelo Rits (janela Jupyter).
name: rits-jupyter-{slug}

services:
  jupyterlab:
    image: {JUPYTER_IMAGE}
    labels:
      dev.rits.plugin: jupyter
      dev.rits.env: "{slug}"
      dev.rits.purpose: development
    environment:
      JUPYTER_TOKEN: ${{RITS_JP_TOKEN:?defina pelo Rits}}
      JUPYTER_PORT: "8888"
    command: ["start-notebook.py", "--ServerApp.allow_remote_access=False", "--ServerApp.root_dir=/home/jovyan"]
    ports:
      - "127.0.0.1:${{RITS_JP_PORT:?defina pelo Rits}}:8888"
    volumes:
      - ${{RITS_JP_PROJECT:?defina pelo Rits}}:/home/jovyan/work
      - home:/home/jovyan
    restart: unless-stopped

volumes:
  home:
    labels:
      dev.rits.plugin: jupyter
      dev.rits.env: "{slug}"
"#
    )
}

/// Creates (or rewrites) the environment's compose.yaml; returns its folder.
#[tauri::command]
pub fn jupyter_env_create(app: AppHandle, slug: String) -> Result<String, AfError> {
    let d = env_dir(&app, &slug)?;
    let tmp = d.join("compose.yaml.tmp");
    std::fs::write(&tmp, compose_for(&slug)).map_err(|e| AfError::new("invalid", None, e.to_string()))?;
    std::fs::rename(&tmp, d.join("compose.yaml")).map_err(|e| AfError::new("invalid", None, e.to_string()))?;
    Ok(d.to_string_lossy().replace('\\', "/"))
}

pub const COMPOSE_ALLOWED: &[&str] = &["up", "down", "stop", "start", "restart", "ps", "logs", "pull"];

/// Validates compose arguments (subcommand allow-list; `down -v` needs the confirmation flag).
pub fn check_compose_args(args: &[String]) -> Result<Vec<String>, String> {
    let sub = args.first().map(String::as_str).unwrap_or("");
    if !COMPOSE_ALLOWED.contains(&sub) {
        return Err(format!("Comando não permitido: docker compose {sub}"));
    }
    if sub == "down" && args.iter().any(|a| a == "-v" || a == "--volumes") && !args.iter().any(|a| a == "--rits-confirmed-delete") {
        return Err("Excluir os volumes exige confirmação explícita.".into());
    }
    Ok(args.iter().filter(|a| *a != "--rits-confirmed-delete").cloned().collect())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn jupyter_env_compose(
    app: AppHandle,
    window: tauri::Window,
    st: State<'_, JupyterState>,
    procs: State<'_, Procs>,
    proc_id: String,
    slug: String,
    args: Vec<String>,
    project_dir: String,
    port: u16,
) -> Result<u32, AfError> {
    let args = check_compose_args(&args).map_err(|e| AfError::new("invalid", None, e))?;
    let dir = env_dir(&app, &slug)?;
    let compose = dir.join("compose.yaml");
    if !compose.exists() {
        return Err(AfError::new("notFound", None, "Ambiente não encontrado (compose.yaml ausente)."));
    }
    let k = env_token_key(&slug);
    let token = match st.client.secrets().get(&k)? {
        Some(t) => t,
        None => {
            let t = secrets::random_secret(24)?;
            st.client.secrets().set(&k, &t)?;
            t
        }
    };
    let mut env = HashMap::new();
    env.insert("RITS_JP_TOKEN".to_string(), token);
    env.insert("RITS_JP_PROJECT".to_string(), project_dir);
    env.insert("RITS_JP_PORT".to_string(), port.to_string());
    let mut full: Vec<String> = vec!["compose".into(), "-f".into(), compose.to_string_lossy().into(), "-p".into(), format!("rits-jupyter-{slug}")];
    full.extend(args);
    let spec = SpawnSpec { id: proc_id, program: "docker".into(), args: full, cwd: dir.to_string_lossy().into(), env, mode: "plain".into() };
    procs.spawn(app.clone(), spec, window.label()).await.map_err(|e| AfError::new("invalid", None, e))
}

/// Registers the server of a local environment with its token (project mounted at "work").
#[tauri::command]
pub async fn jupyter_env_register(app: AppHandle, st: State<'_, JupyterState>, slug: String, name: String, port: u16, project_dir: String) -> Result<Server, AfError> {
    let token = st.client.secrets().get(&env_token_key(&slug))?.ok_or_else(|| AfError::new("secret", None, "Token do ambiente local não encontrado no cofre do sistema."))?;
    let mut all = load(&app)?;
    let existing = all.iter().find(|s| s.local_env == slug).map(|s| s.id.clone());
    let srv = Server {
        id: existing.unwrap_or_else(|| format!("local-{slug}")),
        name,
        url: format!("http://127.0.0.1:{port}"),
        auth: "token".into(),
        timeout_secs: 30,
        verify_tls: true,
        local_env: slug,
        local_root: project_dir.replace('\\', "/"),
        remote_root: "work".into(),
    };
    st.client.secrets().set(&server_key(&srv.id), &token)?;
    match all.iter_mut().find(|x| x.id == srv.id) {
        Some(x) => *x = srv.clone(),
        None => all.push(srv.clone()),
    }
    save_all(&app, &all)?;
    st.client.forget(Some(&srv.id)).await;
    Ok(srv)
}

/// Public `/api` of a local environment (used to wait until it is ready).
#[tauri::command]
pub async fn jupyter_env_health(port: u16) -> Result<Value, AfError> {
    let c = reqwest::Client::builder().timeout(std::time::Duration::from_secs(5)).build().map_err(|e| AfError::new("http", None, e.to_string()))?;
    let r = c.get(format!("http://127.0.0.1:{port}/api")).send().await.map_err(|e| AfError::new("unreachable", None, e.to_string()))?;
    let status = r.status().as_u16();
    let text = r.text().await.unwrap_or_default();
    if status != 200 {
        return Err(AfError::new("server", Some(status), text.chars().take(200).collect::<String>()));
    }
    serde_json::from_str(&text).map_err(|e| AfError::new("incompatible", None, e.to_string()))
}

/// After the volume was deleted (explicit action): forget the token and the compose folder.
#[tauri::command]
pub fn jupyter_env_forget(app: AppHandle, st: State<'_, JupyterState>, slug: String) -> Result<(), AfError> {
    st.client.secrets().delete(&env_token_key(&slug))?;
    let _ = std::fs::remove_dir_all(env_dir(&app, &slug)?);
    Ok(())
}

/// Opens JupyterLab (complement to the native notebook editor) in a separate IDE window, whose
/// label is outside the IDE capabilities, or in the system browser. The URL carries the token for
/// the login and is built here, so the frontend never sees it.
#[tauri::command]
pub async fn jupyter_open_lab(app: AppHandle, st: State<'_, JupyterState>, id: String, path: Option<String>, external: bool) -> Result<(), AfError> {
    let srv = get(&app, &id)?;
    let base = client::base_url(&srv.url)?;
    let token = st.client.token(&srv, None)?;
    let enc = |s: &str| crate::airflow::client::encode_query(&[(String::new(), s.to_string())])[1..].to_string();
    let p = path.unwrap_or_default();
    let tail = if p.is_empty() { String::new() } else { format!("/tree/{}", p.split('/').filter(|s| !s.is_empty()).map(enc).collect::<Vec<_>>().join("/")) };
    let url = match token {
        Some(t) => format!("{base}/lab{tail}?token={}", enc(&t)),
        None => format!("{base}/lab{tail}"),
    };
    if external {
        let (prog, args): (&str, Vec<String>) = if cfg!(target_os = "macos") {
            ("open", vec![url])
        } else if cfg!(windows) {
            ("rundll32", vec!["url.dll,FileProtocolHandler".into(), url])
        } else {
            ("xdg-open", vec![url])
        };
        let mut c = std::process::Command::new(prog);
        c.args(args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        c.spawn().map_err(|e| AfError::new("invalid", None, e.to_string()))?;
        return Ok(());
    }
    let label = format!("jupyter-web-{}", srv.id.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>());
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    let u: tauri::Url = url.parse().map_err(|_| AfError::new("invalid", None, "URL inválida"))?;
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(u))
        .title(format!("JupyterLab — {}", srv.name))
        .inner_size(1280.0, 860.0)
        .center()
        .build()
        .map_err(|e| AfError::new("invalid", None, e.to_string()))?;
    Ok(())
}
