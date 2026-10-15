//! Airflow client against a fake HTTP server: auth (login, cache, expiry, 401 renewal), pagination,
//! error classification, no automatic retry of actions, Airflow 2 detection and path checks.
//! Runs with plain `cargo test` (no Airflow needed). The real-server test is airflow_live.rs.

use base64::Engine;
use rits_lib::airflow::client::{check_path, encode_query, jwt_exp, AirflowClient};
use rits_lib::airflow::secrets::{instance_key, MemoryStore, SecretStore};
use rits_lib::airflow::{AuthKind, Instance};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Default)]
struct Fake {
    logins: AtomicUsize,
    posts: AtomicUsize,
    /// Tokens the server accepts (revoking = removing).
    valid: Mutex<Vec<String>>,
    /// exp claim for the next issued token (0 = one hour ahead).
    next_exp: Mutex<i64>,
    /// path -> forced (status, body)
    forced: Mutex<HashMap<String, (u16, String)>>,
    /// POST that never answers (to test timeouts)
    hang_post: Mutex<bool>,
    seen_auth: Mutex<Vec<String>>,
}

fn jwt(exp: i64, n: usize) -> String {
    let e = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    format!("{}.{}.sig{n}", e.encode(r#"{"alg":"HS512"}"#), e.encode(json!({ "exp": exp, "sub": "1" }).to_string()))
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
}

async fn serve(fake: Arc<Fake>) -> String {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { break };
            let fake = fake.clone();
            tokio::spawn(async move {
                let mut buf = vec![];
                let mut tmp = [0u8; 4096];
                let (head, body) = loop {
                    let n = s.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_string();
                        let len = head.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        while buf.len() < i + 4 + len {
                            let n = s.read(&mut tmp).await.unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            buf.extend_from_slice(&tmp[..n]);
                        }
                        break (head, String::from_utf8_lossy(&buf[i + 4..]).to_string());
                    }
                };
                let first = head.lines().next().unwrap_or("").to_string();
                let mut parts = first.split(' ');
                let method = parts.next().unwrap_or("").to_string();
                let target = parts.next().unwrap_or("").to_string();
                let (path, qs) = target.split_once('?').unwrap_or((&target, ""));
                let q: HashMap<String, String> = qs.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect();
                let auth = head.lines().find_map(|l| l.strip_prefix("Authorization: Bearer ").or_else(|| l.strip_prefix("authorization: Bearer ")).map(str::to_string));
                if let Some(a) = &auth {
                    fake.seen_auth.lock().unwrap().push(a.clone());
                }
                let authed = auth.map(|a| fake.valid.lock().unwrap().contains(&a)).unwrap_or(false);
                let forced = fake.forced.lock().unwrap().get(path).cloned();
                let (status, out): (u16, String) = if let Some(f) = forced {
                    if method == "POST" {
                        fake.posts.fetch_add(1, Ordering::SeqCst);
                    }
                    f
                } else {
                    match (method.as_str(), path) {
                        ("POST", "/auth/token") => {
                            let n = fake.logins.fetch_add(1, Ordering::SeqCst) + 1;
                            let b: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                            if b["username"] == "airflow" && b["password"] == "s3cret" {
                                let exp = { let e = *fake.next_exp.lock().unwrap(); if e == 0 { now() + 3600 } else { e } };
                                let t = jwt(exp, n);
                                fake.valid.lock().unwrap().push(t.clone());
                                (201, json!({ "access_token": t }).to_string())
                            } else {
                                (401, json!({ "detail": "Invalid credentials" }).to_string())
                            }
                        }
                        ("GET", "/api/v2/monitor/health") => (200, json!({ "metadatabase": { "status": "healthy" } }).to_string()),
                        ("GET", "/api/v2/version") => (200, json!({ "version": "3.3.2", "git_version": "x" }).to_string()),
                        _ if !authed => (401, json!({ "detail": "Not authenticated" }).to_string()),
                        ("GET", "/api/v2/dags") => {
                            let limit: usize = q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50);
                            let offset: usize = q.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0);
                            let total = 250;
                            let dags: Vec<Value> = (offset..(offset + limit).min(total)).map(|i| json!({ "dag_id": format!("dag_{i:03}") })).collect();
                            (200, json!({ "dags": dags, "total_entries": total }).to_string())
                        }
                        ("POST", p) if p.ends_with("/dagRuns") => {
                            fake.posts.fetch_add(1, Ordering::SeqCst);
                            let hang = *fake.hang_post.lock().unwrap();
                            if hang {
                                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                            }
                            (200, json!({ "dag_run_id": "manual__1", "state": "queued" }).to_string())
                        }
                        _ => (404, json!({ "detail": "Not Found" }).to_string()),
                    }
                };
                let reason = if status < 300 { "OK" } else { "ERR" };
                let resp = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
                let _ = s.write_all(resp.as_bytes()).await;
            });
        }
    });
    format!("http://{addr}")
}

fn inst(url: &str) -> Instance {
    Instance { id: "i1".into(), name: "fake".into(), url: url.into(), auth: AuthKind::Password, username: "airflow".into(), timeout_secs: 3, verify_tls: true, local_env: String::new() }
}

fn client(password: &str) -> AirflowClient {
    let store = MemoryStore::default();
    store.set(&instance_key("i1"), password).unwrap();
    AirflowClient::new(Arc::new(store))
}

#[tokio::test]
async fn login_once_and_reuse_token() {
    let fake = Arc::new(Fake::default());
    let url = serve(fake.clone()).await;
    let c = client("s3cret");
    for _ in 0..3 {
        c.request(&inst(&url), "GET", "/api/v2/dags", &[("limit".into(), "1".into())], None).await.unwrap();
    }
    assert_eq!(fake.logins.load(Ordering::SeqCst), 1, "token must be cached");
}

#[tokio::test]
async fn expired_token_is_renewed_before_use() {
    let fake = Arc::new(Fake::default());
    *fake.next_exp.lock().unwrap() = now() + 30; // expires within the 60 s safety margin
    let url = serve(fake.clone()).await;
    let c = client("s3cret");
    c.request(&inst(&url), "GET", "/api/v2/dags", &[], None).await.unwrap();
    c.request(&inst(&url), "GET", "/api/v2/dags", &[], None).await.unwrap();
    // 1st request logs in; the 2nd finds the token inside the 60 s margin and renews it.
    assert_eq!(fake.logins.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn revoked_token_gets_one_relogin() {
    let fake = Arc::new(Fake::default());
    let url = serve(fake.clone()).await;
    let c = client("s3cret");
    c.request(&inst(&url), "GET", "/api/v2/dags", &[], None).await.unwrap();
    fake.valid.lock().unwrap().clear(); // server restarted with a new JWT secret
    let r = c.request(&inst(&url), "GET", "/api/v2/dags", &[("limit".into(), "2".into())], None).await.unwrap();
    assert_eq!(r["dags"].as_array().unwrap().len(), 2);
    assert_eq!(fake.logins.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn wrong_password_is_an_auth_error() {
    let fake = Arc::new(Fake::default());
    let url = serve(fake.clone()).await;
    let e = client("errada").request(&inst(&url), "GET", "/api/v2/dags", &[], None).await.unwrap_err();
    assert_eq!(e.kind, "auth");
    let e = client("errada").test(&inst(&url), None).await.unwrap_err();
    assert_eq!(e.kind, "auth");
}

#[tokio::test]
async fn pagination_collects_every_page() {
    let fake = Arc::new(Fake::default());
    let url = serve(fake.clone()).await;
    let c = client("s3cret");
    let all = c.get_all(&inst(&url), "/api/v2/dags", &[], "dags", 10_000).await.unwrap();
    let dags = all["dags"].as_array().unwrap();
    assert_eq!(dags.len(), 250);
    assert_eq!(all["total_entries"], 250);
    assert_eq!(dags[0]["dag_id"], "dag_000");
    assert_eq!(dags[249]["dag_id"], "dag_249");
    let capped = c.get_all(&inst(&url), "/api/v2/dags", &[], "dags", 120).await.unwrap();
    assert_eq!(capped["dags"].as_array().unwrap().len(), 120);
}

#[tokio::test]
async fn forbidden_and_server_errors_are_classified_and_not_retried() {
    let fake = Arc::new(Fake::default());
    let url = serve(fake.clone()).await;
    let c = client("s3cret");
    fake.forced.lock().unwrap().insert("/api/v2/dags/x".into(), (403, json!({ "detail": "Forbidden" }).to_string()));
    let e = c.request(&inst(&url), "PATCH", "/api/v2/dags/x", &[], Some(&json!({ "is_paused": true }))).await.unwrap_err();
    assert_eq!((e.kind.as_str(), e.status), ("forbidden", Some(403)));

    fake.forced.lock().unwrap().insert("/api/v2/dags/x/dagRuns".into(), (500, json!({ "detail": "boom" }).to_string()));
    let e = c.request(&inst(&url), "POST", "/api/v2/dags/x/dagRuns", &[], Some(&json!({ "logical_date": null }))).await.unwrap_err();
    assert_eq!(e.kind, "server");
    assert_eq!(fake.posts.load(Ordering::SeqCst), 1, "a failed trigger must not be sent twice");
}

#[tokio::test]
async fn trigger_timeout_is_not_retried() {
    let fake = Arc::new(Fake::default());
    *fake.hang_post.lock().unwrap() = true;
    let url = serve(fake.clone()).await;
    let c = client("s3cret");
    let e = c.request(&inst(&url), "POST", "/api/v2/dags/x/dagRuns", &[], Some(&json!({ "logical_date": null }))).await.unwrap_err();
    assert_eq!(e.kind, "timeout");
    assert_eq!(fake.posts.load(Ordering::SeqCst), 1, "a trigger that may have run must not be repeated");
}

#[tokio::test]
async fn airflow2_is_reported_as_incompatible() {
    let fake = Arc::new(Fake::default());
    fake.forced.lock().unwrap().insert("/api/v2/monitor/health".into(), (404, "{}".into()));
    fake.forced.lock().unwrap().insert("/api/v1/health".into(), (200, json!({ "metadatabase": {} }).to_string()));
    let url = serve(fake.clone()).await;
    let e = client("s3cret").test(&inst(&url), None).await.unwrap_err();
    assert_eq!(e.kind, "incompatible");
    assert!(e.message.contains("Airflow 2"), "{}", e.message);
}

#[tokio::test]
async fn test_reports_version_and_counts() {
    let fake = Arc::new(Fake::default());
    let url = serve(fake.clone()).await;
    let r = client("ignored").test(&inst(&url), Some("s3cret")).await.unwrap();
    assert_eq!(r["version"], "3.3.2");
    assert_eq!(r["dags"], 250);
}

#[tokio::test]
async fn unreachable_server() {
    let e = client("s3cret").request(&inst("http://127.0.0.1:9"), "GET", "/api/v2/dags", &[], None).await.unwrap_err();
    assert_eq!(e.kind, "unreachable", "{e:?}");
}

#[test]
fn only_public_api_paths() {
    assert!(check_path("/api/v2/dags").is_ok());
    for bad in ["/ui/dags", "/api/v2/../ui/x", "/api/v1/dags", "/api/v2/dags?x=1", "http://evil/api/v2/dags"] {
        assert!(check_path(bad).is_err(), "{bad}");
    }
}

#[test]
fn helpers() {
    assert_eq!(jwt_exp(&jwt(1234, 1)), Some(1234));
    assert_eq!(jwt_exp("not-a-jwt"), None);
    assert_eq!(encode_query(&[("dag_id_pattern".into(), "etl %_x".into()), ("tags".into(), "a&b".into())]), "dag_id_pattern=etl%20%25_x&tags=a%26b");
}
