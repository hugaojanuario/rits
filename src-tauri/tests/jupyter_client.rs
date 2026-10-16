//! Jupyter plugin backend: kernel messaging protocol, REST client (token auth, errors, path
//! checks), local environment compose file and allowed compose commands. The real-server test
//! (`jupyter_live`, `--ignored`) runs against a JupyterLab started from the plugin's compose file:
//!
//!   cargo test --test jupyter_client write_compose -- --ignored   # writes $RITS_JP_DIR/compose.yaml
//!   RITS_JP_TOKEN=... RITS_JP_PORT=18888 RITS_JP_PROJECT=/tmp/x docker compose -f $RITS_JP_DIR/compose.yaml -p rits-jupyter-test up -d
//!   RITS_JUPYTER_URL=http://127.0.0.1:18888 RITS_JUPYTER_TOKEN=... cargo test --test jupyter_client jupyter_live -- --ignored

use futures_util::{SinkExt, StreamExt};
use rits_lib::jupyter::client::{channels_url, check_path, server_key, JupyterClient};
use rits_lib::jupyter::{check_compose_args, compose_for, connect_channels, proto, Server, JUPYTER_IMAGE};
use rits_lib::secrets::{MemoryStore, SecretStore};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

fn server(url: &str) -> Server {
    Server { id: "s1".into(), name: "teste".into(), url: url.into(), auth: "token".into(), timeout_secs: 10, verify_tls: true, local_env: String::new(), local_root: String::new(), remote_root: String::new() }
}

#[test]
fn execute_request_follows_protocol() {
    let m = proto::request("sess-1", "shell", "execute_request", proto::execute_content("print(1)", false), "m-1").unwrap();
    assert_eq!(m["header"]["msg_type"], "execute_request");
    assert_eq!(m["header"]["msg_id"], "m-1");
    assert_eq!(m["header"]["session"], "sess-1");
    assert_eq!(m["header"]["version"], proto::PROTOCOL_VERSION);
    assert_eq!(m["channel"], "shell");
    assert_eq!(m["content"]["code"], "print(1)");
    assert_eq!(m["content"]["store_history"], true);
    assert_eq!(m["content"]["allow_stdin"], false);
    assert!(m["header"]["date"].as_str().unwrap().ends_with('Z'));
    assert!(m["parent_header"].as_object().unwrap().is_empty());
    // only the requests the IDE needs are allowed (no comm messages, no shutdown via WS)
    assert!(proto::request("s", "shell", "comm_open", json!({}), "x").is_err());
    assert!(proto::request("s", "control", "shutdown_request", json!({}), "x").is_err());
    assert!(proto::request("s", "iopub", "execute_request", json!({}), "x").is_err());
    assert!(proto::request("s", "shell", "execute_request", json!("x"), "x").is_err());
}

#[test]
fn replies_are_flattened_with_parent_ids() {
    let raw = json!({
        "header": {"msg_id": "r1", "msg_type": "stream"}, "parent_header": {"msg_id": "m-1"}, "channel": "iopub",
        "content": {"name": "stdout", "text": "olá\n"}, "metadata": {}, "buffers": []
    });
    let m = proto::parse_text(&raw.to_string()).unwrap();
    assert_eq!((m.channel.as_str(), m.msg_type.as_str(), m.parent_id.as_str()), ("iopub", "stream", "m-1"));
    assert_eq!(m.content["text"], "olá\n");
    // legacy binary frame: u32 count, offsets, JSON, buffers
    let js = raw.to_string().into_bytes();
    let buf = b"\x00\x01\x02";
    let mut b = vec![];
    b.extend_from_slice(&2u32.to_be_bytes());
    b.extend_from_slice(&12u32.to_be_bytes());
    b.extend_from_slice(&((12 + js.len()) as u32).to_be_bytes());
    b.extend_from_slice(&js);
    b.extend_from_slice(buf);
    let m2 = proto::parse_binary(&b).unwrap();
    assert_eq!(m2.msg_type, "stream");
    assert_eq!(m2.buffers, 1);
    assert!(proto::parse_binary(b"\x00").is_err());
    assert!(proto::parse_text("not json").is_err());
}

#[test]
fn urls_and_paths() {
    assert!(check_path("/api/contents/a%20b.ipynb").is_ok());
    assert!(check_path("/api/kernels").is_ok());
    assert!(check_path("/lab").is_err());
    assert!(check_path("/files/x").is_err());
    assert!(check_path("/api/contents/../../etc").is_err());
    assert!(check_path("/api/contents?x=1").is_err());
    assert_eq!(channels_url("https://h:8888/user/ana/", "abc-123", "s 1").unwrap(), "wss://h:8888/user/ana/api/kernels/abc-123/channels?session_id=s%201");
    assert!(channels_url("http://h", "../x", "s").is_err());
    // a token pasted in the URL is refused (it would be stored in documents)
    assert!(rits_lib::jupyter::client::base_url("http://127.0.0.1:8888/lab?token=abc").is_err());
}

#[test]
fn local_environment_is_safe_by_default() {
    let c = compose_for("proj-a");
    assert!(c.contains(JUPYTER_IMAGE));
    assert!(!JUPYTER_IMAGE.ends_with(":latest") && JUPYTER_IMAGE.contains(':'));
    assert!(c.contains("\"127.0.0.1:${RITS_JP_PORT"), "porta só em localhost");
    assert!(c.contains("JUPYTER_TOKEN: ${RITS_JP_TOKEN:?"), "token obrigatório");
    assert!(c.contains("/home/jovyan/work"));
    assert!(c.contains("home:/home/jovyan"), "arquivos persistentes");
    assert!(!c.to_lowercase().contains("token=''") && !c.contains("--IdentityProvider.token=''"));
    assert!(check_compose_args(&["up".into(), "-d".into()]).is_ok());
    assert!(check_compose_args(&["config".into()]).is_err(), "config imprimiria o token");
    assert!(check_compose_args(&["exec".into(), "x".into()]).is_err());
    assert!(check_compose_args(&["down".into(), "-v".into()]).is_err());
    assert_eq!(check_compose_args(&["down".into(), "-v".into(), "--rits-confirmed-delete".into()]).unwrap(), vec!["down", "-v"]);
}

/// Minimal fake Jupyter Server: /api (public) and /api/status (token required).
async fn fake(token: &'static str) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let seen = Arc::new(std::sync::Mutex::new(vec![]));
    let s2 = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = l.accept().await else { break };
            let seen = s2.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("").to_string();
                let auth = req.lines().find(|l| l.to_lowercase().starts_with("authorization:")).map(|l| l[14..].trim().to_string()).unwrap_or_default();
                seen.lock().unwrap().push(format!("{path} {auth}"));
                let ok = auth == format!("token {token}");
                let (status, body) = match path.as_str() {
                    "/api" => (200, json!({"version": "2.17.0"}).to_string()),
                    "/api/status" if ok => (200, json!({"started": "x", "kernels": 0}).to_string()),
                    "/api/kernelspecs" if ok => (200, json!({"default": "python3", "kernelspecs": {"python3": {}}}).to_string()),
                    _ if !ok => (403, json!({"message": "Forbidden", "reason": null}).to_string()),
                    _ => (404, "{}".into()),
                };
                let resp = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = sock.write_all(resp.as_bytes()).await;
            });
        }
    });
    (format!("http://{addr}"), seen)
}

#[tokio::test]
async fn token_auth_and_errors() {
    let (url, seen) = fake("segredo").await;
    let store = Arc::new(MemoryStore::default());
    store.set(&server_key("s1"), "segredo").unwrap();
    let c = JupyterClient::new(store.clone());
    let r = c.test(&server(&url), None).await.unwrap();
    assert_eq!(r["version"], "2.17.0");
    assert_eq!(r["kernelspecs"], json!(["python3"]));
    assert!(seen.lock().unwrap().iter().any(|l| l == "/api/status token segredo"));
    // the public /api call does not carry the token
    assert!(seen.lock().unwrap().iter().any(|l| l == "/api "));
    let bad = c.test(&server(&url), Some("errado")).await.unwrap_err();
    assert_eq!(bad.kind, "auth");
    store.delete(&server_key("s1")).unwrap();
    let none = c.request(&server(&url), "GET", "/api/status", &[], None).await.unwrap_err();
    assert_eq!(none.kind, "auth");
    let refused = c.request(&server(&url), "GET", "/lab", &[], None).await.unwrap_err();
    assert_eq!(refused.kind, "invalid");
    let down = JupyterClient::new(Arc::new(MemoryStore::default())).test(&Server { auth: "none".into(), ..server("http://127.0.0.1:9") }, None).await.unwrap_err();
    assert_eq!(down.kind, "unreachable");
}

#[test]
#[ignore]
fn write_compose() {
    let dir = std::env::var("RITS_JP_DIR").expect("RITS_JP_DIR");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(std::path::Path::new(&dir).join("compose.yaml"), compose_for("test")).unwrap();
}

async fn until<F: Fn(&proto::Incoming) -> bool>(ws: &mut rits_lib::jupyter::KernelSocket, parent: &str, done: F, out: &mut Vec<proto::Incoming>) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    loop {
        let m = tokio::time::timeout_at(deadline, ws.next()).await.expect("tempo esgotado esperando o kernel").expect("socket fechado").unwrap();
        let inc = match m {
            Message::Text(t) => proto::parse_text(t.as_str()).unwrap(),
            Message::Binary(b) => proto::parse_binary(&b).unwrap(),
            _ => continue,
        };
        if inc.parent_id != parent {
            continue;
        }
        let stop = done(&inc);
        out.push(inc);
        if stop {
            break;
        }
    }
}

async fn run_cell(ws: &mut rits_lib::jupyter::KernelSocket, session: &str, code: &str) -> Vec<proto::Incoming> {
    let id = rits_lib::secrets::uuid4();
    let m = proto::request(session, "shell", "execute_request", proto::execute_content(code, false), &id).unwrap();
    ws.send(Message::Text(m.to_string().into())).await.unwrap();
    let mut out = vec![];
    // the cell is done when the reply arrived and the kernel went idle for this request
    let mut got_reply = false;
    let mut idle = false;
    while !(got_reply && idle) {
        let mut batch = vec![];
        until(ws, &id, |m| m.msg_type == "execute_reply" || (m.msg_type == "status" && m.content["execution_state"] == "idle"), &mut batch).await;
        for m in &batch {
            if m.msg_type == "execute_reply" {
                got_reply = true;
            }
            if m.msg_type == "status" && m.content["execution_state"] == "idle" {
                idle = true;
            }
        }
        out.extend(batch);
    }
    out
}

#[tokio::test]
#[ignore]
async fn jupyter_live() {
    let url = std::env::var("RITS_JUPYTER_URL").expect("RITS_JUPYTER_URL");
    let token = std::env::var("RITS_JUPYTER_TOKEN").expect("RITS_JUPYTER_TOKEN");
    let store = Arc::new(MemoryStore::default());
    store.set(&server_key("s1"), &token).unwrap();
    let c = JupyterClient::new(store);
    let srv = server(&url);
    let info = c.test(&srv, None).await.unwrap();
    assert!(info["kernelspecs"].as_array().unwrap().iter().any(|k| k == "python3"), "{info}");
    // contents API: create, save and reopen a notebook (cells, metadata and outputs preserved)
    let nb = json!({
        "nbformat": 4, "nbformat_minor": 5, "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3"}, "rits": {"x": 1}},
        "cells": [
            {"cell_type": "markdown", "id": "c1", "metadata": {}, "source": "# Título\n*ok*"},
            {"cell_type": "code", "id": "c2", "metadata": {"tags": ["t"]}, "execution_count": 3, "source": "1+1", "outputs": [{"output_type": "execute_result", "execution_count": 3, "data": {"text/plain": "2"}, "metadata": {}}]}
        ]
    });
    let path = "/api/contents/work/rits_teste.ipynb";
    c.request(&srv, "PUT", path, &[], Some(&json!({"type": "notebook", "format": "json", "content": nb}))).await.unwrap();
    let back = c.request(&srv, "GET", path, &[("content".into(), "1".into())], None).await.unwrap();
    assert_eq!(back["content"]["cells"][1]["outputs"][0]["data"]["text/plain"], "2");
    assert_eq!(back["content"]["metadata"]["rits"]["x"], 1);
    assert_eq!(back["content"]["cells"][1]["metadata"]["tags"][0], "t");
    // session + kernel
    let sess = c.request(&srv, "POST", "/api/sessions", &[], Some(&json!({"path": "work/rits_teste.ipynb", "type": "notebook", "name": "", "kernel": {"name": "python3"}}))).await.unwrap();
    let kid = sess["kernel"]["id"].as_str().unwrap().to_string();
    let sid = rits_lib::secrets::uuid4();
    let mut ws = connect_channels(&srv, Some(&token), &kid, &sid).await.unwrap();
    // wrong token is refused
    assert_eq!(connect_channels(&srv, Some("errado"), &kid, &sid).await.err().unwrap().kind, "auth");
    let out = run_cell(&mut ws, &sid, "import os\nprint('olá', os.getcwd())\n40 + 2").await;
    assert!(out.iter().any(|m| m.msg_type == "stream" && m.content["text"].as_str().unwrap().contains("olá /home/jovyan/work")), "o kernel roda na pasta do projeto montada");
    let res = out.iter().find(|m| m.msg_type == "execute_result").unwrap();
    assert_eq!(res.content["data"]["text/plain"], "42");
    let count = res.content["execution_count"].as_i64().unwrap();
    let out2 = run_cell(&mut ws, &sid, "import pandas as pd\ndf = pd.DataFrame({'a': [1, 2], 'b': ['x', 'y']})\ndf").await;
    let table = out2.iter().find(|m| m.msg_type == "execute_result").unwrap();
    assert!(table.content["data"]["text/html"].as_str().unwrap().contains("<table"));
    assert_eq!(table.content["execution_count"].as_i64().unwrap(), count + 1, "contadores em ordem");
    let out3 = run_cell(&mut ws, &sid, "import matplotlib\nmatplotlib.use('module://matplotlib_inline.backend_inline')\nimport matplotlib.pyplot as plt\nplt.plot([1,2,3])\nplt.show()").await;
    assert!(out3.iter().any(|m| m.msg_type == "display_data" && m.content["data"]["image/png"].is_string()), "gráfico como image/png");
    let err = run_cell(&mut ws, &sid, "1/0").await;
    let e = err.iter().find(|m| m.msg_type == "error").unwrap();
    assert_eq!(e.content["ename"], "ZeroDivisionError");
    let reply = err.iter().find(|m| m.msg_type == "execute_reply").unwrap();
    assert_eq!(reply.content["status"], "error");
    // interrupt a long cell through the REST API
    let id = rits_lib::secrets::uuid4();
    let m = proto::request(&sid, "shell", "execute_request", proto::execute_content("import time\ntime.sleep(60)", false), &id).unwrap();
    ws.send(Message::Text(m.to_string().into())).await.unwrap();
    let mut started = vec![];
    until(&mut ws, &id, |m| m.msg_type == "execute_input", &mut started).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    c.request(&srv, "POST", &format!("/api/kernels/{kid}/interrupt"), &[], None).await.unwrap();
    let mut rest = vec![];
    until(&mut ws, &id, |m| m.msg_type == "execute_reply", &mut rest).await;
    assert!(rest.iter().any(|m| m.msg_type == "error" && m.content["ename"] == "KeyboardInterrupt"));
    // restart: variables are lost and counters start over
    run_cell(&mut ws, &sid, "x = 123").await;
    c.request(&srv, "POST", &format!("/api/kernels/{kid}/restart"), &[], None).await.unwrap();
    drop(ws);
    let mut ws = connect_channels(&srv, Some(&token), &kid, &sid).await.unwrap();
    let after = run_cell(&mut ws, &sid, "'x' in globals()").await;
    assert_eq!(after.iter().find(|m| m.msg_type == "execute_result").unwrap().content["data"]["text/plain"], "False");
    // the real kernel state can be queried after reconnecting (no cell is re-run)
    let k = c.request(&srv, "GET", &format!("/api/kernels/{kid}"), &[], None).await.unwrap();
    assert!(k["execution_state"].is_string());
    c.request(&srv, "DELETE", &format!("/api/sessions/{}", sess["id"].as_str().unwrap()), &[], None).await.unwrap();
    c.request(&srv, "DELETE", path, &[], None).await.unwrap();
    let v: Value = Value::Null;
    let _ = v;
}
