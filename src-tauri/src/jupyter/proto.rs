//! Jupyter messaging protocol (v5.x) as used by Jupyter Server's kernel WebSocket
//! (`/api/kernels/<id>/channels`, the default JSON serialization with a "channel" field).
//!
//! The IDE builds every request here (header, session, version) and parses every reply into a
//! flat event, so the frontend never assembles protocol messages by hand.

use serde::Serialize;
use serde_json::{json, Map, Value};

/// Protocol version we speak (Jupyter Server 2 / ipykernel 6+ accept 5.x).
pub const PROTOCOL_VERSION: &str = "5.3";

/// Channels a client may write to.
pub const CLIENT_CHANNELS: &[&str] = &["shell", "control", "stdin"];

/// Request types the IDE sends. Anything else is refused (the frontend cannot send arbitrary
/// messages, e.g. comm messages that would drive widgets on the kernel).
pub const ALLOWED_REQUESTS: &[(&str, &str)] = &[
    ("shell", "execute_request"),
    ("shell", "complete_request"),
    ("shell", "inspect_request"),
    ("shell", "kernel_info_request"),
    ("shell", "is_complete_request"),
    ("control", "interrupt_request"),
    ("control", "kernel_info_request"),
    ("stdin", "input_reply"),
];

fn now_iso() -> String {
    // RFC 3339 / ISO 8601 in UTC without pulling a date crate.
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    let s = secs as i64;
    let (days, rem) = (s.div_euclid(86_400), s.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    let micros = ((secs - s as f64) * 1_000_000.0) as u32;
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{micros:06}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Days since 1970-01-01 -> (year, month, day) (Howard Hinnant's algorithm).
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Builds a request. Returns (msg_id, message).
pub fn request(session: &str, channel: &str, msg_type: &str, content: Value, msg_id: &str) -> Result<Value, String> {
    if !ALLOWED_REQUESTS.iter().any(|(c, t)| *c == channel && *t == msg_type) {
        return Err(format!("Mensagem não permitida: {channel}/{msg_type}"));
    }
    if !content.is_object() {
        return Err("O conteúdo da mensagem precisa ser um objeto JSON.".into());
    }
    Ok(json!({
        "header": {
            "msg_id": msg_id,
            "msg_type": msg_type,
            "username": "rits",
            "session": session,
            "date": now_iso(),
            "version": PROTOCOL_VERSION,
        },
        "parent_header": {},
        "metadata": {},
        "content": content,
        "channel": channel,
        "buffers": [],
    }))
}

/// The usual execute_request content. `store_history` keeps execution counters like JupyterLab.
pub fn execute_content(code: &str, silent: bool) -> Value {
    json!({
        "code": code,
        "silent": silent,
        "store_history": !silent,
        "user_expressions": {},
        "allow_stdin": false,
        "stop_on_error": true,
    })
}

/// A message received from the kernel, flattened for the UI.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Incoming {
    pub channel: String,
    pub msg_type: String,
    pub msg_id: String,
    /// msg_id of the request that caused it ("" for unsolicited messages such as status at start).
    pub parent_id: String,
    pub content: Value,
    pub metadata: Value,
    /// Binary buffers are not forwarded (widgets); only their count.
    pub buffers: usize,
}

fn str_at(v: &Value, a: &str, b: &str) -> String {
    v.get(a).and_then(|x| x.get(b)).and_then(Value::as_str).unwrap_or("").to_string()
}

fn from_value(v: Value, buffers: usize) -> Result<Incoming, String> {
    let channel = v.get("channel").and_then(Value::as_str).unwrap_or("").to_string();
    let msg_type = v.get("msg_type").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| str_at(&v, "header", "msg_type"));
    if msg_type.is_empty() {
        return Err("mensagem sem msg_type".into());
    }
    Ok(Incoming {
        channel,
        msg_type,
        msg_id: str_at(&v, "header", "msg_id"),
        parent_id: str_at(&v, "parent_header", "msg_id"),
        content: v.get("content").cloned().unwrap_or(Value::Object(Map::new())),
        metadata: v.get("metadata").cloned().unwrap_or(Value::Object(Map::new())),
        buffers,
    })
}

/// Parses a text frame.
pub fn parse_text(text: &str) -> Result<Incoming, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("JSON inválido do kernel: {e}"))?;
    from_value(v, 0)
}

/// Parses a binary frame of the legacy serialization: u32 BE count, u32 BE offsets, then the JSON
/// message followed by the buffers.
pub fn parse_binary(b: &[u8]) -> Result<Incoming, String> {
    let rd = |i: usize| -> Option<usize> { b.get(i..i + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]) as usize) };
    let n = rd(0).ok_or("quadro binário curto")?;
    if n == 0 || n > 1024 {
        return Err("quadro binário inválido".into());
    }
    let start = rd(4).ok_or("quadro binário curto")?;
    let end = if n > 1 { rd(8).ok_or("quadro binário curto")? } else { b.len() };
    let json = b.get(start..end).ok_or("deslocamento inválido no quadro binário")?;
    let v: Value = serde_json::from_slice(json).map_err(|e| format!("JSON inválido do kernel: {e}"))?;
    from_value(v, n - 1)
}

/// Kernel status values the UI shows (others are passed through as they are).
pub fn is_terminal_status(state: &str) -> bool {
    matches!(state, "dead")
}
