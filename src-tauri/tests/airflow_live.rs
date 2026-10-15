//! End-to-end check against a real Airflow 3 (ignored by default):
//!   RITS_AIRFLOW_URL=http://127.0.0.1:8080 RITS_AIRFLOW_USER=airflow RITS_AIRFLOW_PASSWORD=... \
//!   cargo test --test airflow_live -- --ignored --nocapture
//! Expects the DAG files `rits_smoke.py` (valid) and `rits_quebrada.py` (import error) in the
//! instance's dags folder: see the Airflow section of AGENTS.md.

use rits_lib::airflow::client::AirflowClient;
use rits_lib::airflow::secrets::{instance_key, MemoryStore, SecretStore};
use rits_lib::airflow::{AuthKind, Instance};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn setup() -> (AirflowClient, Instance) {
    let url = std::env::var("RITS_AIRFLOW_URL").expect("RITS_AIRFLOW_URL");
    let user = std::env::var("RITS_AIRFLOW_USER").unwrap_or_else(|_| "airflow".into());
    let pw = std::env::var("RITS_AIRFLOW_PASSWORD").expect("RITS_AIRFLOW_PASSWORD");
    let store = MemoryStore::default();
    store.set(&instance_key("live"), &pw).unwrap();
    let inst = Instance { id: "live".into(), name: "live".into(), url, auth: AuthKind::Password, username: user, timeout_secs: 30, verify_tls: true, local_env: String::new() };
    (AirflowClient::new(Arc::new(store)), inst)
}

async fn wait<F: std::future::Future<Output = Option<Value>>>(what: &str, secs: u64, mut f: impl FnMut() -> F) -> Value {
    let t0 = Instant::now();
    loop {
        if let Some(v) = f().await {
            println!("  {what}: ok em {:.0}s", t0.elapsed().as_secs_f32());
            return v;
        }
        assert!(t0.elapsed() < Duration::from_secs(secs), "tempo esgotado esperando: {what}");
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

#[tokio::test]
#[ignore]
async fn full_flow_on_real_airflow() {
    let (c, i) = setup();
    let t = c.test(&i, None).await.expect("teste de conexão");
    println!("versão {}", t["version"]);
    assert!(t["version"].as_str().unwrap().starts_with('3'));

    // 1. the DAG file is processed by the dag-processor and shows up in the API
    let dag = wait("DAG processada", 180, || async {
        c.request(&i, "GET", "/api/v2/dags/rits_smoke", &[], None).await.ok()
    })
    .await;
    assert_eq!(dag["relative_fileloc"], "rits_smoke.py");

    // 2. import errors are reported
    wait("erro de import listado", 180, || async {
        let r = c.request(&i, "GET", "/api/v2/importErrors", &[("filename_pattern".into(), "rits_quebrada".into())], None).await.ok()?;
        (r["total_entries"].as_u64()? > 0).then_some(r)
    })
    .await;

    // 3. list with pagination and tag filter
    let all = c.get_all(&i, "/api/v2/dags", &[("tags".into(), "rits".into())], "dags", 500).await.unwrap();
    assert!(all["dags"].as_array().unwrap().iter().any(|d| d["dag_id"] == "rits_smoke"));

    // 4. unpause, trigger (logical_date null = run now) and follow the run
    let d = c.request(&i, "PATCH", "/api/v2/dags/rits_smoke", &[], Some(&json!({ "is_paused": false }))).await.unwrap();
    assert_eq!(d["is_paused"], false);
    let run = c.request(&i, "POST", "/api/v2/dags/rits_smoke/dagRuns", &[], Some(&json!({ "logical_date": null, "conf": { "origem": "rits" } }))).await.unwrap();
    let run_id = run["dag_run_id"].as_str().unwrap().to_string();
    println!("execução {run_id}");
    let path = format!("/api/v2/dags/rits_smoke/dagRuns/{run_id}");
    let done = wait("execução concluída", 300, || async {
        let r = c.request(&i, "GET", &path, &[], None).await.ok()?;
        matches!(r["state"].as_str(), Some("success") | Some("failed")).then_some(r)
    })
    .await;
    assert_eq!(done["state"], "success", "{done}");
    assert_eq!(done["conf"]["origem"], "rits");

    // 5. task instances and graph
    let tis = c.request(&i, "GET", &format!("{path}/taskInstances"), &[], None).await.unwrap();
    let ids: Vec<&str> = tis["task_instances"].as_array().unwrap().iter().map(|t| t["task_id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"extrair") && ids.contains(&"carregar"), "{ids:?}");
    let tasks = c.request(&i, "GET", "/api/v2/dags/rits_smoke/tasks", &[], None).await.unwrap();
    let ex = tasks["tasks"].as_array().unwrap().iter().find(|t| t["task_id"] == "extrair").unwrap();
    assert_eq!(ex["downstream_task_ids"], json!(["carregar"]));

    // 6. logs of a task try
    let logs = c.request(&i, "GET", &format!("{path}/taskInstances/carregar/logs/1"), &[("full_content".into(), "true".into())], None).await.unwrap();
    assert!(logs["content"].to_string().contains("RITS_CARREGAR soma=6"), "logs: {}", logs["content"].to_string().chars().take(400).collect::<String>());

    // 7. clear: dry run shows the scope, nothing is cleared
    let dry = c
        .request(&i, "POST", "/api/v2/dags/rits_smoke/clearTaskInstances", &[], Some(&json!({ "dry_run": true, "dag_run_id": run_id, "task_ids": ["extrair"], "include_downstream": true, "only_failed": false })))
        .await
        .unwrap();
    let scope: Vec<&str> = dry["task_instances"].as_array().unwrap().iter().map(|t| t["task_id"].as_str().unwrap()).collect();
    assert_eq!(scope.len(), 2, "extrair + downstream carregar: {scope:?}");
    let after = c.request(&i, "GET", &path, &[], None).await.unwrap();
    assert_eq!(after["state"], "success", "dry run must not change the run");

    // 8. pause again
    let d = c.request(&i, "PATCH", "/api/v2/dags/rits_smoke", &[], Some(&json!({ "is_paused": true }))).await.unwrap();
    assert_eq!(d["is_paused"], true);

    // 9. permissions/errors: unknown DAG is a classified 404
    let e = c.request(&i, "GET", "/api/v2/dags/nao_existe_rits", &[], None).await.unwrap_err();
    assert_eq!(e.kind, "notFound");
}
