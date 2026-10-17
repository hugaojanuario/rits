//! AI assistant plugin (backend side): a local MCP server (Streamable HTTP, JSON responses) that
//! Claude Code and Codex connect to, so the agent sees what the IDE sees — project, editors,
//! databases, Airflow, dbt, Jupyter, Docker, Migration Audit.
//!
//! - Listens on 127.0.0.1 only; every request needs the bearer token of a registered chat.
//! - Each token belongs to one chat of one window: a `tools/call` is forwarded to that window as
//!   the `assistant-tool-call` event and answered by `assistant_tool_result`. The tools themselves
//!   live in the frontend (src/ide/assistant/tools.ts), reusing the IDE's own APIs.
//! - Database access for the agent goes through `assistant_db_query`: read-only transaction, row cap.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};

pub const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

#[derive(Default)]
struct Inner {
    port: u16,
    /// token -> (window label, chat id)
    chats: HashMap<String, (String, String)>,
    /// tool definitions published by the frontend (JSON Schema)
    tools: Vec<Value>,
    pending: HashMap<String, oneshot::Sender<Value>>,
}

#[derive(Default, Clone)]
pub struct AssistantState {
    inner: Arc<Mutex<Inner>>,
}

/// Delivers a tool call to the window that owns the chat (the Tauri event in the app, a closure
/// in tests). Returns false when the window is gone.
pub type Forward = Arc<dyn Fn(&str, ToolCall) -> bool + Send + Sync>;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub call_id: String,
    pub chat: String,
    pub name: String,
    pub args: Value,
}

impl AssistantState {
    /// Window closed or page reloaded: forget its chats (their tokens stop working).
    pub async fn drop_owner(&self, owner: &str) {
        let mut g = self.inner.lock().await;
        g.chats.retain(|_, (w, _)| w != owner);
    }

    async fn handle_rpc(&self, fwd: &Forward, token: &str, req: &Value) -> Option<Value> {
        let id = req.get("id").cloned();
        let method = req.get("method").and_then(Value::as_str).unwrap_or("");
        let id = id?; // notifications get no response body
        let result = match method {
            "initialize" => {
                let asked = req["params"]["protocolVersion"].as_str().unwrap_or("");
                let v = if PROTOCOL_VERSIONS.contains(&asked) { asked } else { PROTOCOL_VERSIONS[0] };
                Ok(json!({
                    "protocolVersion": v,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "rits", "title": "Rits IDE", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "Ferramentas da IDE Rits: contexto do projeto e dos editores abertos, bancos de dados (somente leitura), Airflow, dbt, Jupyter, Docker e Migration Audit. Use-as para entender o que o usuário está vendo antes de responder."
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": self.inner.lock().await.tools.clone() })),
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("").to_string();
                let args = req["params"].get("arguments").cloned().unwrap_or(json!({}));
                Ok(self.call_tool(fwd, token, &name, args).await)
            }
            m => Err(json!({ "code": -32601, "message": format!("Método não suportado: {m}") })),
        };
        Some(match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
        })
    }

    async fn call_tool(&self, fwd: &Forward, token: &str, name: &str, args: Value) -> Value {
        let err = |m: String| json!({ "content": [{ "type": "text", "text": m }], "isError": true });
        let (owner, chat) = match self.inner.lock().await.chats.get(token).cloned() {
            Some(x) => x,
            None => return err("Conversa encerrada na IDE.".into()),
        };
        let call_id = crate::secrets::uuid4();
        let (tx, rx) = oneshot::channel();
        self.inner.lock().await.pending.insert(call_id.clone(), tx);
        if !fwd(&owner, ToolCall { call_id: call_id.clone(), chat, name: name.to_string(), args }) {
            self.inner.lock().await.pending.remove(&call_id);
            return err("Janela da IDE indisponível.".into());
        }
        // approvals wait for the user; other tools answer quickly
        let wait = if name == "approve" { Duration::from_secs(1800) } else { Duration::from_secs(180) };
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(v)) => v,
            _ => {
                self.inner.lock().await.pending.remove(&call_id);
                err(format!("A ferramenta {name} não respondeu a tempo."))
            }
        }
    }

    /// Answer of the frontend to a forwarded tool call.
    pub async fn answer(&self, call_id: &str, result: Value) {
        if let Some(tx) = self.inner.lock().await.pending.remove(call_id) {
            let _ = tx.send(result);
        }
    }

    pub async fn set_tools(&self, tools: Vec<Value>) {
        self.inner.lock().await.tools = tools;
    }
}

fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK",
        202 => "Accepted",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        _ => "Bad Request",
    }
}

async fn respond(s: &mut TcpStream, code: u16, body: &str, keep: bool) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {code} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: {}\r\n\r\n",
        status_text(code),
        body.len(),
        if keep { "keep-alive" } else { "close" }
    );
    s.write_all(head.as_bytes()).await?;
    s.write_all(body.as_bytes()).await?;
    s.flush().await
}

async fn serve_conn(st: AssistantState, fwd: Forward, stream: TcpStream) {
    let (r, mut w) = stream.into_split();
    let mut r = BufReader::new(r);
    loop {
        // request line + headers
        let mut line = String::new();
        if r.read_line(&mut line).await.unwrap_or(0) == 0 {
            return;
        }
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let path = parts.next().unwrap_or("").to_string();
        let mut headers: HashMap<String, String> = HashMap::new();
        loop {
            let mut h = String::new();
            if r.read_line(&mut h).await.unwrap_or(0) == 0 {
                return;
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                headers.insert(k.trim().to_lowercase(), v.trim().to_string());
            }
        }
        let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
        if len > 8 * 1024 * 1024 {
            let mut s = w.reunite(r.into_inner()).unwrap();
            let _ = respond(&mut s, 413, "{}", false).await;
            return;
        }
        let mut body = vec![0u8; len];
        if r.read_exact(&mut body).await.is_err() {
            return;
        }
        let keep = headers.get("connection").map(|c| !c.eq_ignore_ascii_case("close")).unwrap_or(true);
        let token = headers.get("authorization").and_then(|a| a.strip_prefix("Bearer ")).unwrap_or("").to_string();
        let authorized = !token.is_empty() && st.inner.lock().await.chats.contains_key(&token);
        // DNS rebinding protection: only local Host headers
        let host_ok = headers.get("host").map(|h| h.starts_with("127.0.0.1:") || h.starts_with("localhost:")).unwrap_or(false);
        let (code, out) = if path.split('?').next() != Some("/mcp") {
            (404, json!({ "error": "not found" }).to_string())
        } else if !host_ok || !authorized {
            (if host_ok { 401 } else { 403 }, json!({ "error": "unauthorized" }).to_string())
        } else if method == "GET" {
            // no server-initiated stream
            (405, String::new())
        } else if method == "DELETE" {
            (200, String::new())
        } else if method != "POST" {
            (405, String::new())
        } else {
            match serde_json::from_slice::<Value>(&body) {
                Ok(Value::Array(batch)) => {
                    let mut outs = vec![];
                    for req in &batch {
                        if let Some(r) = st.handle_rpc(&fwd, &token, req).await {
                            outs.push(r);
                        }
                    }
                    if outs.is_empty() { (202, String::new()) } else { (200, Value::Array(outs).to_string()) }
                }
                Ok(req) => match st.handle_rpc(&fwd, &token, &req).await {
                    Some(r) => (200, r.to_string()),
                    None => (202, String::new()),
                },
                Err(e) => (400, json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": e.to_string() } }).to_string()),
            }
        };
        let head = format!(
            "HTTP/1.1 {code} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: {}\r\n\r\n",
            status_text(code),
            out.len(),
            if keep { "keep-alive" } else { "close" }
        );
        if w.write_all(head.as_bytes()).await.is_err() || w.write_all(out.as_bytes()).await.is_err() || w.flush().await.is_err() || !keep {
            return;
        }
    }
}

/// Starts the server (once) and returns its port.
pub async fn ensure_server(st: &AssistantState, fwd: Forward) -> Result<u16, String> {
    let mut g = st.inner.lock().await;
    if g.port != 0 {
        return Ok(g.port);
    }
    let l = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    g.port = port;
    let st2 = st.clone();
    tokio::spawn(async move {
        while let Ok((s, _)) = l.accept().await {
            tokio::spawn(serve_conn(st2.clone(), fwd.clone(), s));
        }
    });
    Ok(port)
}

/// New chat of a window: returns its bearer token.
pub async fn register_chat(st: &AssistantState, owner: &str, chat: &str) -> String {
    let token = crate::secrets::random_secret(24).unwrap_or_else(|_| crate::secrets::uuid4());
    st.inner.lock().await.chats.insert(token.clone(), (owner.to_string(), chat.to_string()));
    token
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub port: u16,
    pub token: String,
    pub url: String,
    /// Claude Code: --mcp-config file (0600, removed when the chat ends)
    pub claude_config: String,
}

/// Registers a chat: tools, token and the MCP config file for Claude Code.
#[tauri::command]
pub async fn assistant_open(app: AppHandle, window: tauri::Window, st: State<'_, AssistantState>, chat: String, tools: Vec<Value>) -> Result<Session, String> {
    let app2 = app.clone();
    let fwd: Forward = Arc::new(move |owner: &str, call: ToolCall| app2.emit_to(owner, "assistant-tool-call", call).is_ok());
    let port = ensure_server(&st, fwd).await?;
    st.set_tools(tools).await;
    let token = register_chat(&st, window.label(), &chat).await;
    let url = format!("http://127.0.0.1:{port}/mcp");
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("assistant");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("mcp-{}.json", chat.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>()));
    let cfg = json!({ "mcpServers": { "rits": { "type": "http", "url": url, "headers": { "Authorization": format!("Bearer {token}") } } } });
    std::fs::write(&file, cfg.to_string()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
    }
    Ok(Session { port, token, url, claude_config: file.to_string_lossy().into_owned() })
}

#[tauri::command]
pub async fn assistant_close(st: State<'_, AssistantState>, token: String, claude_config: String) -> Result<(), String> {
    st.inner.lock().await.chats.remove(&token);
    if !claude_config.is_empty() && claude_config.contains("assistant") {
        let _ = std::fs::remove_file(claude_config);
    }
    Ok(())
}

#[tauri::command]
pub async fn assistant_tool_result(st: State<'_, AssistantState>, call_id: String, result: Value) -> Result<(), String> {
    st.answer(&call_id, result).await;
    Ok(())
}

/// Plugin disabled: forget every chat (their CLI processes are killed by the frontend).
#[tauri::command]
pub async fn assistant_release(st: State<'_, AssistantState>) -> Result<(), String> {
    let mut g = st.inner.lock().await;
    g.chats.clear();
    g.pending.clear();
    Ok(())
}

#[derive(Serialize)]
pub struct QueryOut {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub truncated: bool,
}

/// Read-only query for the agent (read-only transaction, at most `max_rows` rows, 60 s).
#[tauri::command]
pub async fn assistant_db_query(app: AppHandle, conn_id: String, db: String, sql: String, max_rows: Option<usize>) -> Result<QueryOut, String> {
    let cfg = crate::store::get(&app, &conn_id)?;
    db_query(cfg, db, sql, max_rows.unwrap_or(200).clamp(1, 2000)).await
}

pub async fn db_query(cfg: crate::store::ConnConfig, db: String, sql: String, max: usize) -> Result<QueryOut, String> {
    let mut out = QueryOut { columns: vec![], rows: vec![], truncated: false };
    let r = tokio::time::timeout(Duration::from_secs(60), async {
        let mut sink = |cols: Option<Vec<String>>, row: Vec<Option<String>>| -> Result<(), String> {
            if let Some(c) = cols {
                out.columns = c;
                return Ok(());
            }
            if out.rows.len() >= max {
                out.truncated = true;
                return Err("__limit".into());
            }
            out.rows.push(row.into_iter().map(|v| v.map(|s| if s.chars().count() > 2000 { format!("{}…", s.chars().take(2000).collect::<String>()) } else { s })).collect());
            Ok(())
        };
        crate::export::stream_query(&cfg, &db, &sql, &mut sink).await
    })
    .await
    .map_err(|_| "A consulta passou de 60 s e foi interrompida.".to_string())?;
    match r {
        Ok(()) => Ok(out),
        Err(e) if e == "__limit" => Ok(out),
        Err(e) => Err(e),
    }
}
