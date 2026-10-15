//! Apache Airflow plugin (backend side). The frontend (src/ide/airflow/) never sees credentials:
//! every API call goes through these commands, which add the bearer token kept in memory and the
//! password/token kept in the OS secret store. Instance settings (no secrets) live in the
//! "airflow-instances" document in the app config folder.

pub mod client;
pub mod secrets;

use crate::procs::{Procs, SpawnSpec};
use crate::store;
use client::{AfError, AirflowClient};
use secrets::{env_key, instance_key, OsStore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    /// Username + password exchanged for a JWT at /auth/token (FAB / Simple auth manager).
    #[default]
    Password,
    /// A token the user pasted (cannot be renewed by the IDE).
    Token,
    /// No credentials (only for instances that really allow it).
    None,
}

fn default_timeout() -> u64 {
    30
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub auth: AuthKind,
    #[serde(default)]
    pub username: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    #[serde(default = "yes")]
    pub verify_tls: bool,
    /// Slug of the local Docker environment that created this instance ("" = external).
    #[serde(default)]
    pub local_env: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceView {
    #[serde(flatten)]
    pub inst: Instance,
    pub has_secret: bool,
}

pub struct AirflowState {
    pub client: AirflowClient,
    inflight: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl Default for AirflowState {
    fn default() -> Self {
        AirflowState { client: AirflowClient::new(Arc::new(OsStore)), inflight: Mutex::new(HashMap::new()) }
    }
}

const DOC: &str = "airflow-instances";

fn load(app: &AppHandle) -> Result<Vec<Instance>, AfError> {
    let v = store::read_doc(app, DOC).map_err(|e| AfError::new("invalid", None, e))?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

fn save_all(app: &AppHandle, all: &[Instance]) -> Result<(), AfError> {
    store::write_doc(app, DOC, &serde_json::to_value(all).unwrap_or(Value::Null)).map_err(|e| AfError::new("invalid", None, e))
}

fn get(app: &AppHandle, id: &str) -> Result<Instance, AfError> {
    load(app)?.into_iter().find(|i| i.id == id).ok_or_else(|| AfError::new("notFound", None, "Instância do Airflow não encontrada."))
}

#[tauri::command]
pub fn airflow_instances(app: AppHandle, st: State<'_, AirflowState>) -> Result<Vec<InstanceView>, AfError> {
    let secrets = st.client.secrets();
    Ok(load(&app)?
        .into_iter()
        .map(|i| {
            let has_secret = secrets.get(&instance_key(&i.id)).ok().flatten().is_some();
            InstanceView { inst: i, has_secret }
        })
        .collect())
}

/// Saves an instance; `secret` (password or token) goes to the OS store, never to the document.
#[tauri::command]
pub async fn airflow_save_instance(app: AppHandle, st: State<'_, AirflowState>, mut inst: Instance, secret: Option<String>) -> Result<Instance, AfError> {
    client::base_url(&inst.url)?;
    if inst.name.trim().is_empty() {
        inst.name = inst.url.clone();
    }
    if inst.id.is_empty() {
        inst.id = format!("af{}", secrets::random_secret(6)?.to_lowercase().replace(['-', '_'], "x"));
    }
    if let Some(s) = secret.filter(|s| !s.is_empty()) {
        st.client.secrets().set(&instance_key(&inst.id), &s)?;
    }
    let mut all = load(&app)?;
    match all.iter_mut().find(|i| i.id == inst.id) {
        Some(x) => *x = inst.clone(),
        None => all.push(inst.clone()),
    }
    save_all(&app, &all)?;
    st.client.forget(Some(&inst.id)).await;
    Ok(inst)
}

#[tauri::command]
pub async fn airflow_delete_instance(app: AppHandle, st: State<'_, AirflowState>, id: String) -> Result<(), AfError> {
    let mut all = load(&app)?;
    all.retain(|i| i.id != id);
    save_all(&app, &all)?;
    st.client.secrets().delete(&instance_key(&id))?;
    st.client.forget(Some(&id)).await;
    Ok(())
}

/// Tests an instance (saved or not) with an optional secret typed in the dialog.
#[tauri::command]
pub async fn airflow_test(st: State<'_, AirflowState>, inst: Instance, secret: Option<String>) -> Result<Value, AfError> {
    let mut i = inst;
    if i.id.is_empty() {
        i.id = "__test".into();
    }
    let r = st.client.test(&i, secret.as_deref()).await;
    if i.id == "__test" {
        st.client.forget(Some("__test")).await;
    }
    r
}

/// Runs `fut` under a cancellable request id.
async fn cancellable<T: Send + 'static>(st: &AirflowState, request_id: Option<String>, fut: impl std::future::Future<Output = Result<T, AfError>> + Send + 'static) -> Result<T, AfError> {
    let task = tokio::spawn(fut);
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
pub async fn airflow_request(
    app: AppHandle,
    st: State<'_, AirflowState>,
    id: String,
    method: String,
    path: String,
    query: Option<Vec<(String, String)>>,
    body: Option<Value>,
    request_id: Option<String>,
) -> Result<Value, AfError> {
    let inst = get(&app, &id)?;
    let handle = app.clone();
    cancellable(&st, request_id, async move {
        let st = handle.state::<AirflowState>();
        st.client.request(&inst, &method, &path, &query.unwrap_or_default(), body.as_ref()).await
    })
    .await
}

#[tauri::command]
pub async fn airflow_get_all(
    app: AppHandle,
    st: State<'_, AirflowState>,
    id: String,
    path: String,
    query: Option<Vec<(String, String)>>,
    key: String,
    max: Option<usize>,
    request_id: Option<String>,
) -> Result<Value, AfError> {
    let inst = get(&app, &id)?;
    let handle = app.clone();
    cancellable(&st, request_id, async move {
        let st = handle.state::<AirflowState>();
        st.client.get_all(&inst, &path, &query.unwrap_or_default(), &key, max.unwrap_or(1000)).await
    })
    .await
}

#[tauri::command]
pub async fn airflow_cancel(st: State<'_, AirflowState>, request_id: String) -> Result<(), AfError> {
    if let Some(h) = st.inflight.lock().await.remove(&request_id) {
        h.abort();
    }
    Ok(())
}

/// Plugin disabled: cancel in-flight requests and drop tokens and HTTP clients.
#[tauri::command]
pub async fn airflow_release(st: State<'_, AirflowState>) -> Result<(), AfError> {
    for (_, h) in st.inflight.lock().await.drain() {
        h.abort();
    }
    st.client.forget(None).await;
    Ok(())
}

// ---------------- local Docker environment ----------------

fn env_dir(app: &AppHandle, slug: &str) -> Result<std::path::PathBuf, AfError> {
    if slug.is_empty() || !slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(AfError::new("invalid", None, "Nome do ambiente inválido (use letras minúsculas, números e hífen)."));
    }
    let d = app.path().app_config_dir().map_err(|e| AfError::new("invalid", None, e.to_string()))?.join("airflow-envs").join(slug);
    std::fs::create_dir_all(&d).map_err(|e| AfError::new("invalid", None, e.to_string()))?;
    Ok(d)
}

/// Folder where the IDE writes the environment's compose.yaml (outside the project and Git).
#[tauri::command]
pub fn airflow_env_dir(app: AppHandle, slug: String) -> Result<String, AfError> {
    Ok(env_dir(&app, &slug)?.to_string_lossy().replace('\\', "/"))
}

fn env_secret(st: &AirflowState, slug: &str, what: &str, make: fn() -> Result<String, String>) -> Result<String, AfError> {
    let k = env_key(slug, what);
    if let Some(v) = st.client.secrets().get(&k)? {
        return Ok(v);
    }
    let v = make()?;
    st.client.secrets().set(&k, &v)?;
    Ok(v)
}

/// docker compose subcommands the plugin may run (never `config`, which would print the secrets).
const COMPOSE_ALLOWED: &[&str] = &["up", "down", "stop", "start", "restart", "ps", "logs", "pull"];

/// Runs `docker compose` for a local environment, with its secrets injected as environment
/// variables from the OS store (they never touch disk). Output streams as proc-out/proc-exit.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn airflow_env_compose(
    app: AppHandle,
    window: tauri::Window,
    st: State<'_, AirflowState>,
    procs: State<'_, Procs>,
    proc_id: String,
    slug: String,
    args: Vec<String>,
    dags_dir: String,
    port: u16,
) -> Result<u32, AfError> {
    let sub = args.first().map(String::as_str).unwrap_or("");
    if !COMPOSE_ALLOWED.contains(&sub) {
        return Err(AfError::new("invalid", None, format!("Comando não permitido: docker compose {sub}")));
    }
    if sub == "down" && args.iter().any(|a| a == "-v" || a == "--volumes") && !args.iter().any(|a| a == "--rits-confirmed-delete") {
        return Err(AfError::new("invalid", None, "Excluir os volumes exige confirmação explícita."));
    }
    let dir = env_dir(&app, &slug)?;
    let compose = dir.join("compose.yaml");
    if !compose.exists() {
        return Err(AfError::new("notFound", None, "Ambiente não encontrado (compose.yaml ausente)."));
    }
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("RITS_AF_ADMIN_PASSWORD".into(), env_secret(&st, &slug, "admin", || secrets::random_secret(18))?);
    env.insert("RITS_AF_JWT_SECRET".into(), env_secret(&st, &slug, "jwt", || secrets::random_secret(48))?);
    env.insert("RITS_AF_FERNET_KEY".into(), env_secret(&st, &slug, "fernet", secrets::fernet_key)?);
    env.insert("RITS_AF_DAGS".into(), dags_dir);
    env.insert("RITS_AF_PORT".into(), port.to_string());
    #[cfg(target_os = "linux")]
    if let Ok(o) = std::process::Command::new("id").arg("-u").output() {
        env.insert("AIRFLOW_UID".into(), String::from_utf8_lossy(&o.stdout).trim().to_string());
    }
    let mut full: Vec<String> = vec!["compose".into(), "-f".into(), compose.to_string_lossy().into(), "-p".into(), format!("rits-airflow-{slug}")];
    full.extend(args.into_iter().filter(|a| a != "--rits-confirmed-delete"));
    let spec = SpawnSpec { id: proc_id, program: "docker".into(), args: full, cwd: dir.to_string_lossy().into(), env, mode: "plain".into() };
    procs.spawn(app.clone(), spec, window.label()).await.map_err(|e| AfError::new("invalid", None, e))
}

/// Creates (or updates) the IDE instance for a local environment, using its admin secret.
#[tauri::command]
pub async fn airflow_env_register(app: AppHandle, st: State<'_, AirflowState>, slug: String, name: String, port: u16) -> Result<Instance, AfError> {
    let pw = st.client.secrets().get(&env_key(&slug, "admin"))?.ok_or_else(|| AfError::new("secret", None, "Senha do ambiente local não encontrada no cofre do sistema."))?;
    let mut all = load(&app)?;
    let existing = all.iter().find(|i| i.local_env == slug).map(|i| i.id.clone());
    let inst = Instance {
        id: existing.unwrap_or_else(|| format!("local-{slug}")),
        name,
        url: format!("http://127.0.0.1:{port}"),
        auth: AuthKind::Password,
        username: "airflow".into(),
        timeout_secs: 30,
        verify_tls: true,
        local_env: slug,
    };
    st.client.secrets().set(&instance_key(&inst.id), &pw)?;
    match all.iter_mut().find(|i| i.id == inst.id) {
        Some(x) => *x = inst.clone(),
        None => all.push(inst.clone()),
    }
    save_all(&app, &all)?;
    st.client.forget(Some(&inst.id)).await;
    Ok(inst)
}

/// Public health endpoint of a local environment (used to wait until it is ready).
#[tauri::command]
pub async fn airflow_env_health(port: u16) -> Result<Value, AfError> {
    let url = format!("http://127.0.0.1:{port}/api/v2/monitor/health");
    let c = reqwest::Client::builder().timeout(std::time::Duration::from_secs(5)).build().map_err(|e| AfError::new("http", None, e.to_string()))?;
    let r = c.get(&url).send().await.map_err(|e| AfError::new("unreachable", None, e.to_string()))?;
    let status = r.status().as_u16();
    let text = r.text().await.unwrap_or_default();
    if status != 200 {
        return Err(AfError::new("server", Some(status), text.chars().take(200).collect::<String>()));
    }
    serde_json::from_str(&text).map_err(|e| AfError::new("incompatible", None, e.to_string()))
}

/// After the data was deleted: forget the environment's secrets and its compose folder.
#[tauri::command]
pub fn airflow_env_forget(app: AppHandle, st: State<'_, AirflowState>, slug: String) -> Result<(), AfError> {
    for what in ["admin", "jwt", "fernet"] {
        st.client.secrets().delete(&env_key(&slug, what))?;
    }
    let d = env_dir(&app, &slug)?;
    let _ = std::fs::remove_dir_all(d);
    Ok(())
}
