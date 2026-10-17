//! Local MCP server of the AI assistant plugin: auth, Host check, initialize, tools/list,
//! tools/call forwarded to the "window" and answered, batch and notifications.
//! `--ignored`: real Claude Code (`claude` on PATH, logged in) calls an IDE tool through it.

use rits_lib::assistant::{ensure_server, register_chat, AssistantState, Forward, ToolCall};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

async fn server() -> (AssistantState, u16, String, Arc<Mutex<Vec<ToolCall>>>) {
    let st = AssistantState::default();
    st.set_tools(vec![json!({ "name": "ide_context", "description": "Contexto", "inputSchema": { "type": "object", "properties": {} }, "annotations": { "readOnlyHint": true } })]).await;
    let seen = Arc::new(Mutex::new(vec![]));
    let (st2, seen2) = (st.clone(), seen.clone());
    let fwd: Forward = Arc::new(move |owner: &str, call: ToolCall| {
        assert_eq!(owner, "main");
        seen2.lock().unwrap().push(call.clone());
        let st = st2.clone();
        tokio::spawn(async move {
            let text = format!("Projeto: /tmp/demo. Banco conectado: pagila. args={}", call.args);
            st.answer(&call.call_id, json!({ "content": [{ "type": "text", "text": text }] })).await;
        });
        true
    });
    let port = ensure_server(&st, fwd).await.unwrap();
    let token = register_chat(&st, "main", "chat1").await;
    (st, port, token, seen)
}

async fn post(port: u16, token: &str, body: Value) -> (u16, String) {
    let r = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/mcp"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json, text/event-stream")
        .body(body.to_string())
        .send()
        .await
        .unwrap();
    (r.status().as_u16(), r.text().await.unwrap())
}

#[tokio::test]
async fn mcp_protocol() {
    let (st, port, token, seen) = server().await;

    // wrong or missing token
    assert_eq!(post(port, "nope", json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" })).await.0, 401);
    // non-local Host header (DNS rebinding)
    let r = reqwest::Client::new().post(format!("http://127.0.0.1:{port}/mcp")).header("Host", "evil.example:80").header("Authorization", format!("Bearer {token}")).body("{}").send().await.unwrap();
    assert_eq!(r.status().as_u16(), 403);

    let (c, b) = post(port, &token, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {} } })).await;
    assert_eq!(c, 200);
    let v: Value = serde_json::from_str(&b).unwrap();
    assert_eq!(v["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(v["result"]["serverInfo"]["name"], "rits");
    // unknown version → server's newest
    let (_, b) = post(port, &token, json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": { "protocolVersion": "1999-01-01" } })).await;
    assert_eq!(serde_json::from_str::<Value>(&b).unwrap()["result"]["protocolVersion"], "2025-06-18");

    // notification → 202 without body
    let (c, b) = post(port, &token, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
    assert_eq!((c, b.as_str()), (202, ""));

    let (_, b) = post(port, &token, json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" })).await;
    assert_eq!(serde_json::from_str::<Value>(&b).unwrap()["result"]["tools"][0]["name"], "ide_context");

    let (_, b) = post(port, &token, json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "ide_context", "arguments": { "x": 1 } } })).await;
    let v: Value = serde_json::from_str(&b).unwrap();
    assert!(v["result"]["content"][0]["text"].as_str().unwrap().contains("pagila"));
    {
        let s = seen.lock().unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].chat, "chat1");
        assert_eq!(s[0].args["x"], 1);
    }

    // batch
    let (_, b) = post(port, &token, json!([{ "jsonrpc": "2.0", "id": 5, "method": "ping" }, { "jsonrpc": "2.0", "method": "notifications/x" }, { "jsonrpc": "2.0", "id": 6, "method": "nada" }])).await;
    let v: Value = serde_json::from_str(&b).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 2);
    assert_eq!(v[1]["error"]["code"], -32601);

    // window closed: its token stops working
    st.drop_owner("main").await;
    assert_eq!(post(port, &token, json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" })).await.0, 401);
}

#[tokio::test]
#[ignore]
async fn real_claude_code_uses_ide_tool() {
    let (_st, port, token, seen) = server().await;
    let dir = std::env::temp_dir().join(format!("rits-ai-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let cfg = dir.join("mcp.json");
    std::fs::write(&cfg, json!({ "mcpServers": { "rits": { "type": "http", "url": format!("http://127.0.0.1:{port}/mcp"), "headers": { "Authorization": format!("Bearer {token}") } } } }).to_string()).unwrap();
    let out = tokio::process::Command::new("claude")
        .args(["-p", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--strict-mcp-config", "--mcp-config"])
        .arg(&cfg)
        .args(["--allowedTools=mcp__rits__ide_context", "Chame a ferramenta mcp__rits__ide_context e responda só o nome do banco conectado."])
        .current_dir(&dir)
        .output()
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    eprintln!("stderr: {}", String::from_utf8_lossy(&out.stderr));
    let result = text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find(|e| e["type"] == "result").expect("sem evento result");
    assert_eq!(seen.lock().unwrap().len(), 1, "o agente não chamou a ferramenta da IDE");
    assert!(result["result"].as_str().unwrap_or("").to_lowercase().contains("pagila"), "{result}");
    let _ = std::fs::remove_dir_all(dir);
}
