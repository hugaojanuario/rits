//! HTTP client for the Airflow 3 public REST API (/api/v2) with the auth manager's JWT flow.
//!
//! - Only `/api/v2/...` paths are allowed (no internal `/ui` endpoints).
//! - `POST /auth/token` with username/password returns a JWT; it is cached until shortly before
//!   its `exp` claim and refreshed by logging in again.
//! - The only automatic retry is a single re-login after a 401 (the server rejected the request,
//!   so nothing ran). Timeouts and 5xx are never retried: a POST that may have reached the server
//!   (trigger, clear) must not run twice.

use super::secrets::{instance_key, SecretStore};
use super::{AuthKind, Instance};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// Error shown to the user, classified so the UI can tell a failed pipeline from a down server
/// or a bad login.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AfError {
    /// auth | forbidden | notFound | conflict | unreachable | timeout | tls | server | http | incompatible | cancelled | invalid | secret
    pub kind: String,
    pub status: Option<u16>,
    pub message: String,
}

impl AfError {
    pub fn new(kind: &str, status: Option<u16>, message: impl Into<String>) -> Self {
        AfError { kind: kind.into(), status, message: message.into() }
    }
}

impl std::fmt::Display for AfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<String> for AfError {
    fn from(s: String) -> Self {
        AfError::new("secret", None, s)
    }
}

struct CachedToken {
    token: String,
    /// Unix seconds; 0 = unknown (kept until a 401).
    exp: i64,
}

pub struct AirflowClient {
    secrets: Arc<dyn SecretStore>,
    tokens: Mutex<HashMap<String, CachedToken>>,
    http: Mutex<HashMap<String, (String, reqwest::Client)>>,
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// `exp` claim of a JWT (no signature check: the server validates it; we only schedule renewal).
pub fn jwt_exp(token: &str) -> Option<i64> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()?.get("exp")?.as_i64()
}

/// Validates an API path: absolute, under /api/v2/, no traversal, query passed separately.
pub fn check_path(path: &str) -> Result<(), AfError> {
    if !path.starts_with("/api/v2/") || path.contains("..") || path.contains('?') || path.contains('#') {
        return Err(AfError::new("invalid", None, format!("Caminho de API não permitido: {path}")));
    }
    Ok(())
}

/// Normalized base URL ("https://host:8080/prefix", no trailing slash).
pub fn base_url(url: &str) -> Result<String, AfError> {
    let u = url.trim().trim_end_matches('/');
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err(AfError::new("invalid", None, "A URL precisa começar com http:// ou https://"));
    }
    Ok(u.to_string())
}

/// RFC 3986 percent-encoding for query values (unreserved characters stay as they are).
pub fn encode_query(query: &[(String, String)]) -> String {
    let enc = |s: &str| {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect::<String>()
    };
    query.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

/// "detail" of an Airflow error body (string, or FastAPI's list of {msg}).
fn detail(body: &str) -> String {
    match serde_json::from_str::<Value>(body) {
        Ok(v) => match v.get("detail") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(a)) => a.iter().filter_map(|x| x.get("msg").and_then(Value::as_str)).collect::<Vec<_>>().join("; "),
            Some(other) => other.to_string(),
            None => body.chars().take(300).collect(),
        },
        Err(_) => body.chars().take(300).collect(),
    }
}

fn classify_status(status: u16, body: &str) -> AfError {
    let d = detail(body);
    match status {
        401 => AfError::new("auth", Some(status), format!("Não autenticado no Airflow: {d}")),
        403 => AfError::new("forbidden", Some(status), format!("Sem permissão para esta ação no Airflow: {d}")),
        404 => AfError::new("notFound", Some(status), format!("Não encontrado: {d}")),
        409 => AfError::new("conflict", Some(status), format!("Conflito: {d}")),
        s if s >= 500 => AfError::new("server", Some(status), format!("Erro no servidor Airflow ({s}): {d}")),
        s => AfError::new("http", Some(s), format!("Requisição recusada pelo Airflow ({s}): {d}")),
    }
}

fn classify_transport(e: &reqwest::Error, base: &str) -> AfError {
    let chain = {
        let mut s = e.to_string();
        let mut src = std::error::Error::source(e);
        while let Some(x) = src {
            s.push_str(": ");
            s.push_str(&x.to_string());
            src = x.source();
        }
        s
    };
    let low = chain.to_lowercase();
    if e.is_timeout() {
        AfError::new("timeout", None, format!("O Airflow em {base} não respondeu dentro do tempo limite."))
    } else if low.contains("certificate") || low.contains("tls") || low.contains("ssl") || low.contains("handshake") {
        AfError::new("tls", None, format!("Falha na verificação TLS de {base}: {chain}"))
    } else if e.is_connect() || e.is_request() {
        AfError::new("unreachable", None, format!("Não foi possível conectar ao Airflow em {base}: {chain}"))
    } else {
        AfError::new("http", None, chain)
    }
}

impl AirflowClient {
    pub fn new(secrets: Arc<dyn SecretStore>) -> Self {
        AirflowClient { secrets, tokens: Mutex::new(HashMap::new()), http: Mutex::new(HashMap::new()) }
    }

    pub fn secrets(&self) -> &Arc<dyn SecretStore> {
        &self.secrets
    }

    /// Drops cached tokens and HTTP clients (instance edited, plugin disabled).
    pub async fn forget(&self, id: Option<&str>) {
        match id {
            Some(id) => {
                self.tokens.lock().await.remove(id);
                self.http.lock().await.remove(id);
            }
            None => {
                self.tokens.lock().await.clear();
                self.http.lock().await.clear();
            }
        }
    }

    async fn http_for(&self, inst: &Instance) -> Result<reqwest::Client, AfError> {
        let sig = format!("{}|{}|{}", inst.url, inst.timeout_secs, inst.verify_tls);
        let mut m = self.http.lock().await;
        if let Some((s, c)) = m.get(&inst.id) {
            if *s == sig {
                return Ok(c.clone());
            }
        }
        let c = reqwest::Client::builder()
            .timeout(Duration::from_secs(inst.timeout_secs.clamp(3, 600)))
            .connect_timeout(Duration::from_secs(inst.timeout_secs.clamp(3, 30)))
            // TLS validation stays on unless the user explicitly disabled it for this instance.
            .danger_accept_invalid_certs(!inst.verify_tls)
            .user_agent("Rits IDE (Airflow plugin)")
            .build()
            .map_err(|e| AfError::new("http", None, e.to_string()))?;
        m.insert(inst.id.clone(), (sig, c.clone()));
        Ok(c)
    }

    /// Secret for an instance: the one passed in (connection test before saving) or the stored one.
    fn secret_for(&self, inst: &Instance, override_secret: Option<&str>) -> Result<String, AfError> {
        if let Some(s) = override_secret.filter(|s| !s.is_empty()) {
            return Ok(s.to_string());
        }
        self.secrets
            .get(&instance_key(&inst.id))?
            .ok_or_else(|| AfError::new("auth", None, format!("Nenhuma credencial salva para \"{}\". Edite a instância e informe a senha ou o token.", inst.name)))
    }

    /// `POST /auth/token` (the auth manager's login endpoint).
    pub async fn login(&self, inst: &Instance, override_secret: Option<&str>) -> Result<String, AfError> {
        let base = base_url(&inst.url)?;
        let password = self.secret_for(inst, override_secret)?;
        let http = self.http_for(inst).await?;
        let resp = http
            .post(format!("{base}/auth/token"))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .body(json!({ "username": inst.username, "password": password }).to_string())
            .send()
            .await
            .map_err(|e| classify_transport(&e, &base))?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        match status {
            200 | 201 => {
                let token = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|v| v.get("access_token").and_then(Value::as_str).map(str::to_string))
                    .ok_or_else(|| AfError::new("incompatible", Some(status), "Resposta de login sem access_token: este servidor não parece ser um Airflow 3."))?;
                let exp = jwt_exp(&token).unwrap_or(0);
                self.tokens.lock().await.insert(inst.id.clone(), CachedToken { token: token.clone(), exp });
                Ok(token)
            }
            401 | 403 => Err(AfError::new("auth", Some(status), format!("Usuário ou senha inválidos para \"{}\" ({}).", inst.name, detail(&body)))),
            404 | 405 => Err(AfError::new(
                "incompatible",
                Some(status),
                "O endpoint /auth/token não existe nesta URL. Confira a URL (incluindo o prefixo) e se o servidor é Airflow 3 com um auth manager que emite tokens.",
            )),
            _ => Err(classify_status(status, &body)),
        }
    }

    async fn token(&self, inst: &Instance) -> Result<Option<String>, AfError> {
        match inst.auth {
            AuthKind::None => Ok(None),
            AuthKind::Token => Ok(Some(self.secret_for(inst, None)?)),
            AuthKind::Password => {
                if let Some(t) = self.tokens.lock().await.get(&inst.id) {
                    // renew 60 s before expiry; unknown expiry (0) is kept until a 401
                    if t.exp == 0 || t.exp - 60 > now() {
                        return Ok(Some(t.token.clone()));
                    }
                }
                Ok(Some(self.login(inst, None).await?))
            }
        }
    }

    async fn send_once(&self, inst: &Instance, method: &str, path: &str, query: &[(String, String)], body: Option<&Value>, token: Option<&str>) -> Result<(u16, String), AfError> {
        let base = base_url(&inst.url)?;
        let http = self.http_for(inst).await?;
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| AfError::new("invalid", None, format!("Método HTTP inválido: {method}")))?;
        let qs = if query.is_empty() { String::new() } else { format!("?{}", encode_query(query)) };
        let mut req = http.request(m, format!("{base}{path}{qs}")).header("Accept", "application/json");
        if let Some(t) = token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        if let Some(b) = body {
            req = req.header("Content-Type", "application/json").body(b.to_string());
        }
        let resp = req.send().await.map_err(|e| classify_transport(&e, &base))?;
        let status = resp.status().as_u16();
        let text = resp.text().await.map_err(|e| classify_transport(&e, &base))?;
        Ok((status, text))
    }

    /// One API call. Returns the JSON body (Null for empty bodies).
    pub async fn request(&self, inst: &Instance, method: &str, path: &str, query: &[(String, String)], body: Option<&Value>) -> Result<Value, AfError> {
        check_path(path)?;
        let token = self.token(inst).await?;
        let (mut status, mut text) = self.send_once(inst, method, path, query, body, token.as_deref()).await?;
        if status == 401 && inst.auth == AuthKind::Password {
            // Expired or revoked token: the request was rejected, so logging in again and
            // repeating it once cannot run anything twice.
            self.tokens.lock().await.remove(&inst.id);
            let fresh = self.login(inst, None).await?;
            (status, text) = self.send_once(inst, method, path, query, body, Some(&fresh)).await?;
        }
        if !(200..300).contains(&status) {
            return Err(classify_status(status, &text));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|e| AfError::new("incompatible", Some(status), format!("Resposta inesperada do Airflow ({e}).")))
    }

    /// Fetches every page of an offset-paginated collection (`{<key>: [...], total_entries}`).
    pub async fn get_all(&self, inst: &Instance, path: &str, query: &[(String, String)], key: &str, max_items: usize) -> Result<Value, AfError> {
        const PAGE: usize = 100;
        let mut items: Vec<Value> = vec![];
        let mut total: Option<u64> = None;
        loop {
            let mut q: Vec<(String, String)> = query.iter().filter(|(k, _)| k != "limit" && k != "offset").cloned().collect();
            q.push(("limit".into(), PAGE.to_string()));
            q.push(("offset".into(), items.len().to_string()));
            let page = self.request(inst, "GET", path, &q, None).await?;
            let batch = page.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
            total = page.get("total_entries").and_then(Value::as_u64).or(total);
            let got = batch.len();
            items.extend(batch);
            let done = got == 0 || got < PAGE || total.map(|t| items.len() as u64 >= t).unwrap_or(false) || items.len() >= max_items;
            if done {
                break;
            }
        }
        items.truncate(max_items);
        Ok(json!({ key: items, "total_entries": total.unwrap_or(items.len() as u64) }))
    }

    /// Connection test: health (public), version (must be 3.x), and a login when needed.
    pub async fn test(&self, inst: &Instance, override_secret: Option<&str>) -> Result<Value, AfError> {
        let base = base_url(&inst.url)?;
        let health = match self.send_once(inst, "GET", "/api/v2/monitor/health", &[], None, None).await? {
            (200, t) => serde_json::from_str::<Value>(&t).unwrap_or(Value::Null),
            (404, _) => {
                // Airflow 2 exposes /api/v1 only.
                let v1 = self.send_once(inst, "GET", "/api/v1/health", &[], None, None).await.ok().map(|(s, _)| s);
                return Err(if v1 == Some(200) || v1 == Some(401) {
                    AfError::new("incompatible", Some(404), "Este servidor responde /api/v1: é um Airflow 2. O plugin do Rits suporta apenas Airflow 3 (API /api/v2).")
                } else {
                    AfError::new("incompatible", Some(404), format!("{base} não expõe /api/v2/monitor/health. Confira a URL e se é um Airflow 3."))
                });
            }
            (s, t) => return Err(classify_status(s, &t)),
        };
        let (s, t) = self.send_once(inst, "GET", "/api/v2/version", &[], None, None).await?;
        let version = if s == 200 { serde_json::from_str::<Value>(&t).unwrap_or(Value::Null) } else { Value::Null };
        let ver = version.get("version").and_then(Value::as_str).unwrap_or("").to_string();
        let major = ver.split('.').next().and_then(|m| m.parse::<u32>().ok()).unwrap_or(0);
        if !ver.is_empty() && major < 3 {
            return Err(AfError::new("incompatible", None, format!("Airflow {ver} não é suportado: o plugin requer Airflow 3 (API /api/v2).")));
        }
        // Authenticated call proves the credentials (and the token flow) work.
        let token = match inst.auth {
            AuthKind::None => None,
            AuthKind::Token => Some(self.secret_for(inst, override_secret)?),
            AuthKind::Password => Some(self.login(inst, override_secret).await?),
        };
        let (s, t) = self.send_once(inst, "GET", "/api/v2/dags", &[("limit".into(), "1".into())], None, token.as_deref()).await?;
        if !(200..300).contains(&s) {
            return Err(classify_status(s, &t));
        }
        let dags = serde_json::from_str::<Value>(&t).ok().and_then(|v| v.get("total_entries").cloned()).unwrap_or(Value::Null);
        Ok(json!({ "version": ver, "gitVersion": version.get("git_version"), "health": health, "dags": dags }))
    }
}
