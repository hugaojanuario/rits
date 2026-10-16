//! HTTP client for the Jupyter Server REST API (`/api/...`): status, kernelspecs, contents,
//! sessions and kernels. Authentication is the server token in the `Authorization: token <t>`
//! header (header-authenticated requests are exempt from Jupyter's XSRF check). The token comes
//! from the OS secret store and never reaches the frontend.
//!
//! Policy (same as the Airflow client): no automatic retry. A POST that timed out (e.g. a kernel
//! restart) may have run on the server; the user decides whether to repeat it.

use super::Server;
use crate::airflow::client::{encode_query, AfError};
use crate::secrets::SecretStore;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

pub fn server_key(id: &str) -> String {
    format!("jupyter:{id}")
}

pub fn env_token_key(slug: &str) -> String {
    format!("jupyter-env:{slug}:token")
}

/// Only the REST API under /api/ (no /lab pages, /files downloads or traversal).
pub fn check_path(path: &str) -> Result<(), AfError> {
    if !(path == "/api" || path.starts_with("/api/")) || path.contains("..") || path.contains('?') || path.contains('#') || path.contains('\\') {
        return Err(AfError::new("invalid", None, format!("Caminho de API não permitido: {path}")));
    }
    Ok(())
}

pub fn base_url(url: &str) -> Result<String, AfError> {
    let u = url.trim().trim_end_matches('/');
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err(AfError::new("invalid", None, "A URL precisa começar com http:// ou https://"));
    }
    // A token pasted in the URL (".../lab?token=...") would end up in documents and logs.
    if u.contains('?') || u.contains('#') {
        return Err(AfError::new("invalid", None, "Informe a URL sem parâmetros (o token vai no campo próprio, guardado no cofre do sistema)."));
    }
    Ok(u.to_string())
}

/// ws:// or wss:// URL of a kernel's channels.
pub fn channels_url(base: &str, kernel_id: &str, session_id: &str) -> Result<String, AfError> {
    if kernel_id.is_empty() || !kernel_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(AfError::new("invalid", None, "Identificador de kernel inválido."));
    }
    let b = base_url(base)?;
    let ws = if let Some(r) = b.strip_prefix("https://") { format!("wss://{r}") } else { format!("ws://{}", &b["http://".len()..]) };
    Ok(format!("{ws}/api/kernels/{kernel_id}/channels?{}", encode_query(&[("session_id".into(), session_id.into())])))
}

fn detail(body: &str) -> String {
    match serde_json::from_str::<Value>(body) {
        Ok(v) => v.get("message").or_else(|| v.get("reason")).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| body.chars().take(300).collect()),
        Err(_) => {
            // HTML error pages: keep it short and readable.
            let t: String = body.chars().take(300).collect();
            if t.contains("<html") { "resposta HTML do servidor".into() } else { t }
        }
    }
}

pub fn classify_status(status: u16, body: &str) -> AfError {
    let d = detail(body);
    match status {
        401 | 403 => AfError::new("auth", Some(status), format!("O Jupyter Server recusou a autenticação ({status}): confira o token. {d}")),
        404 => AfError::new("notFound", Some(status), format!("Não encontrado no Jupyter Server: {d}")),
        409 => AfError::new("conflict", Some(status), format!("Conflito: {d}")),
        s if s >= 500 => AfError::new("server", Some(status), format!("Erro no Jupyter Server ({s}): {d}")),
        s => AfError::new("http", Some(s), format!("Requisição recusada pelo Jupyter Server ({s}): {d}")),
    }
}

fn classify_transport(e: &reqwest::Error, base: &str) -> AfError {
    let mut chain = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(x) = src {
        chain.push_str(": ");
        chain.push_str(&x.to_string());
        src = x.source();
    }
    let low = chain.to_lowercase();
    if e.is_timeout() {
        AfError::new("timeout", None, format!("O Jupyter Server em {base} não respondeu dentro do tempo limite."))
    } else if low.contains("certificate") || low.contains("tls") || low.contains("ssl") || low.contains("handshake") {
        AfError::new("tls", None, format!("Falha na verificação TLS de {base}: {chain}"))
    } else if e.is_connect() || e.is_request() {
        AfError::new("unreachable", None, format!("Não foi possível conectar ao Jupyter Server em {base}: {chain}"))
    } else {
        AfError::new("http", None, chain)
    }
}

pub struct JupyterClient {
    secrets: Arc<dyn SecretStore>,
    http: Mutex<HashMap<String, (String, reqwest::Client)>>,
}

impl JupyterClient {
    pub fn new(secrets: Arc<dyn SecretStore>) -> Self {
        JupyterClient { secrets, http: Mutex::new(HashMap::new()) }
    }

    pub fn secrets(&self) -> &Arc<dyn SecretStore> {
        &self.secrets
    }

    pub async fn forget(&self, id: Option<&str>) {
        match id {
            Some(id) => {
                self.http.lock().await.remove(id);
            }
            None => self.http.lock().await.clear(),
        }
    }

    async fn http_for(&self, srv: &Server) -> Result<reqwest::Client, AfError> {
        let sig = format!("{}|{}|{}", srv.url, srv.timeout_secs, srv.verify_tls);
        let mut m = self.http.lock().await;
        if let Some((s, c)) = m.get(&srv.id) {
            if *s == sig {
                return Ok(c.clone());
            }
        }
        let c = reqwest::Client::builder()
            .timeout(Duration::from_secs(srv.timeout_secs.clamp(3, 600)))
            .connect_timeout(Duration::from_secs(srv.timeout_secs.clamp(3, 30)))
            .danger_accept_invalid_certs(!srv.verify_tls)
            .user_agent("Rits IDE (Jupyter plugin)")
            .build()
            .map_err(|e| AfError::new("http", None, e.to_string()))?;
        m.insert(srv.id.clone(), (sig, c.clone()));
        Ok(c)
    }

    /// Token: the one typed in the dialog (test before saving) or the stored one.
    pub fn token(&self, srv: &Server, override_secret: Option<&str>) -> Result<Option<String>, AfError> {
        if srv.auth == "none" {
            return Ok(None);
        }
        if let Some(s) = override_secret.filter(|s| !s.is_empty()) {
            return Ok(Some(s.to_string()));
        }
        self.secrets
            .get(&server_key(&srv.id))?
            .map(Some)
            .ok_or_else(|| AfError::new("auth", None, format!("Nenhum token salvo para \"{}\". Edite o servidor e informe o token.", srv.name)))
    }

    async fn send(&self, srv: &Server, method: &str, path: &str, query: &[(String, String)], body: Option<&Value>, token: Option<&str>) -> Result<(u16, String), AfError> {
        let base = base_url(&srv.url)?;
        let http = self.http_for(srv).await?;
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| AfError::new("invalid", None, format!("Método HTTP inválido: {method}")))?;
        let qs = if query.is_empty() { String::new() } else { format!("?{}", encode_query(query)) };
        let mut req = http.request(m, format!("{base}{path}{qs}")).header("Accept", "application/json");
        if let Some(t) = token {
            req = req.header("Authorization", format!("token {t}"));
        }
        if let Some(b) = body {
            req = req.header("Content-Type", "application/json").body(b.to_string());
        }
        let resp = req.send().await.map_err(|e| classify_transport(&e, &base))?;
        let status = resp.status().as_u16();
        let text = resp.text().await.map_err(|e| classify_transport(&e, &base))?;
        Ok((status, text))
    }

    pub async fn request(&self, srv: &Server, method: &str, path: &str, query: &[(String, String)], body: Option<&Value>) -> Result<Value, AfError> {
        check_path(path)?;
        let token = self.token(srv, None)?;
        let (status, text) = self.send(srv, method, path, query, body, token.as_deref()).await?;
        if !(200..300).contains(&status) {
            return Err(classify_status(status, &text));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|e| AfError::new("incompatible", Some(status), format!("Resposta inesperada do Jupyter Server ({e}).")))
    }

    /// Connection test: `/api` (version, public), `/api/status` (needs auth), kernelspecs.
    pub async fn test(&self, srv: &Server, override_secret: Option<&str>) -> Result<Value, AfError> {
        let base = base_url(&srv.url)?;
        let token = self.token(srv, override_secret)?;
        let (s, t) = self.send(srv, "GET", "/api", &[], None, None).await?;
        if s == 404 {
            return Err(AfError::new("incompatible", Some(404), format!("{base} não expõe /api: confira a URL (incluindo o prefixo, por exemplo /user/<nome> no JupyterHub).")));
        }
        let version = serde_json::from_str::<Value>(&t).ok().and_then(|v| v.get("version").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
        if s != 200 || version.is_empty() {
            return Err(AfError::new("incompatible", Some(s), format!("{base} não respondeu como um Jupyter Server.")));
        }
        let (s, t) = self.send(srv, "GET", "/api/status", &[], None, token.as_deref()).await?;
        if !(200..300).contains(&s) {
            return Err(classify_status(s, &t));
        }
        let status: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
        let (s, t) = self.send(srv, "GET", "/api/kernelspecs", &[], None, token.as_deref()).await?;
        if !(200..300).contains(&s) {
            return Err(classify_status(s, &t));
        }
        let specs: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
        let names: Vec<String> = specs.get("kernelspecs").and_then(Value::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default();
        Ok(json!({ "version": version, "status": status, "default": specs.get("default"), "kernelspecs": names }))
    }
}
