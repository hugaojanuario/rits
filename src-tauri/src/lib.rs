pub mod airflow;
pub mod assistant;
pub mod audit;
pub mod jupyter;
pub mod dbt;
pub mod export;
pub mod updater;
pub mod secrets;
pub mod speech;
pub mod db;
pub mod store;
pub mod tools;
pub mod fsx;
pub mod procs;
mod ide;

use db::{ColumnInfo, CompletionTable, DbObject, DiagramInfo, IndexInfo, QueryResult, ServerInfo, Session, Sessions};
use store::ConnConfig;
use tauri::{AppHandle, Manager, State};

const META: &str = "meta";

async fn session(
    app: &AppHandle,
    st: &Sessions,
    conn_id: &str,
    db: &str,
    channel: &str,
) -> Result<std::sync::Arc<tokio::sync::Mutex<Session>>, String> {
    let cfg = store::get(app, conn_id)?;
    st.get(&cfg, db, channel).await
}

// ---------- connection profiles ----------

#[tauri::command]
fn list_connections(app: AppHandle) -> Result<Vec<ConnConfig>, String> {
    store::load(&app)
}

#[tauri::command]
async fn save_connection(app: AppHandle, st: State<'_, Sessions>, cfg: ConnConfig) -> Result<(), String> {
    db::ext::ensure_driver(&cfg.kind).await?;
    let mut all = store::load(&app)?;
    match all.iter_mut().find(|c| c.id == cfg.id) {
        Some(c) => *c = cfg.clone(),
        None => all.push(cfg.clone()),
    }
    store::save_all(&app, &all)?;
    st.drop_conn(&cfg.id).await;
    Ok(())
}

#[tauri::command]
async fn delete_connection(app: AppHandle, st: State<'_, Sessions>, id: String) -> Result<(), String> {
    let mut all = store::load(&app)?;
    all.retain(|c| c.id != id);
    store::save_all(&app, &all)?;
    st.drop_conn(&id).await;
    Ok(())
}

#[tauri::command]
async fn test_connection(cfg: ConnConfig) -> Result<ServerInfo, String> {
    // Downloads the driver on first use (SQL Server, Oracle, MongoDB...), like DataGrip does.
    db::ext::ensure_driver(&cfg.kind).await?;
    let mut s = Session::open(&cfg, &cfg.default_db()).await?;
    match &mut s {
        Session::Pg(c) => c.server_info().await,
        Session::My(c) => c.server_info().await,
        Session::Ext(c) => c.server_info().await,
    }
}

#[tauri::command]
fn driver_status(kind: store::DbKind) -> db::ext::DriverStatus {
    db::ext::status(&kind)
}

#[tauri::command]
async fn install_driver(kind: store::DbKind) -> Result<(), String> {
    db::ext::ensure_driver(&kind).await
}

#[tauri::command]
fn remove_driver(kind: store::DbKind) -> Result<(), String> {
    db::ext::remove_driver(&kind)
}

#[tauri::command]
async fn diagram_info(app: AppHandle, st: State<'_, Sessions>, conn_id: String, db: String, schema: String) -> Result<DiagramInfo, String> {
    let s = session(&app, &st, &conn_id, &db, "diagram").await?;
    let mut s = s.lock().await;
    match &mut *s {
        Session::Pg(c) => c.diagram(&schema).await,
        Session::My(c) => c.diagram(&schema).await,
        Session::Ext(c) => c.diagram(&schema).await,
    }
}

#[tauri::command]
async fn connect(app: AppHandle, st: State<'_, Sessions>, conn_id: String) -> Result<ServerInfo, String> {
    let s = session(&app, &st, &conn_id, "", META).await?;
    let mut s = s.lock().await;
    match &mut *s {
        Session::Pg(c) => c.server_info().await,
        Session::My(c) => c.server_info().await,
        Session::Ext(c) => c.server_info().await,
    }
}

#[tauri::command]
async fn disconnect(st: State<'_, Sessions>, conn_id: String) -> Result<(), String> {
    st.drop_conn(&conn_id).await;
    Ok(())
}

// ---------- metadata ----------

#[tauri::command]
async fn list_databases(app: AppHandle, st: State<'_, Sessions>, conn_id: String) -> Result<Vec<String>, String> {
    let s = session(&app, &st, &conn_id, "", META).await?;
    let mut s = s.lock().await;
    match &mut *s {
        Session::Pg(c) => c.databases().await,
        Session::My(c) => c.databases().await,
        Session::Ext(c) => c.databases().await,
    }
}

#[tauri::command]
async fn list_schemas(app: AppHandle, st: State<'_, Sessions>, conn_id: String, db: String) -> Result<Vec<String>, String> {
    let s = session(&app, &st, &conn_id, &db, META).await?;
    let mut s = s.lock().await;
    match &mut *s {
        Session::Pg(c) => c.schemas().await,
        Session::My(_) => Ok(vec![db]),
        Session::Ext(c) => c.schemas().await,
    }
}

#[tauri::command]
async fn list_objects(
    app: AppHandle,
    st: State<'_, Sessions>,
    conn_id: String,
    db: String,
    schema: String,
) -> Result<Vec<DbObject>, String> {
    let s = session(&app, &st, &conn_id, &db, META).await?;
    let mut s = s.lock().await;
    match &mut *s {
        Session::Pg(c) => c.objects(&schema).await,
        Session::My(c) => c.objects(&schema).await,
        Session::Ext(c) => c.objects(&schema).await,
    }
}

#[tauri::command]
async fn list_columns(
    app: AppHandle,
    st: State<'_, Sessions>,
    conn_id: String,
    db: String,
    schema: String,
    table: String,
) -> Result<Vec<ColumnInfo>, String> {
    let s = session(&app, &st, &conn_id, &db, META).await?;
    let mut s = s.lock().await;
    match &mut *s {
        Session::Pg(c) => c.columns(&schema, &table).await,
        Session::My(c) => c.columns(&schema, &table).await,
        Session::Ext(c) => c.columns(&schema, &table).await,
    }
}

#[tauri::command]
async fn list_indexes(
    app: AppHandle,
    st: State<'_, Sessions>,
    conn_id: String,
    db: String,
    schema: String,
    table: String,
) -> Result<Vec<IndexInfo>, String> {
    let s = session(&app, &st, &conn_id, &db, META).await?;
    let mut s = s.lock().await;
    match &mut *s {
        Session::Pg(c) => c.indexes(&schema, &table).await,
        Session::My(c) => c.indexes(&schema, &table).await,
        Session::Ext(c) => c.indexes(&schema, &table).await,
    }
}

#[tauri::command]
async fn get_ddl(
    app: AppHandle,
    st: State<'_, Sessions>,
    conn_id: String,
    db: String,
    schema: String,
    name: String,
    kind: String,
) -> Result<String, String> {
    let s = session(&app, &st, &conn_id, &db, META).await?;
    let mut s = s.lock().await;
    match &mut *s {
        Session::Pg(c) => c.ddl(&schema, &name, &kind).await,
        Session::My(c) => c.ddl(&schema, &name, &kind).await,
        Session::Ext(c) => c.ddl(&schema, &name, &kind).await,
    }
}

#[tauri::command]
async fn completion_info(
    app: AppHandle,
    st: State<'_, Sessions>,
    conn_id: String,
    db: String,
) -> Result<Vec<CompletionTable>, String> {
    let s = session(&app, &st, &conn_id, &db, META).await?;
    let mut s = s.lock().await;
    match &mut *s {
        Session::Pg(c) => c.completion().await,
        Session::My(c) => c.completion(&db).await,
        Session::Ext(c) => c.completion(&db).await,
    }
}

// ---------- execution ----------

#[tauri::command]
async fn execute(
    app: AppHandle,
    st: State<'_, Sessions>,
    conn_id: String,
    db: String,
    channel: String,
    sql: String,
) -> Result<Vec<QueryResult>, String> {
    let s = session(&app, &st, &conn_id, &db, &channel).await?;
    let mut s = s.lock().await;
    match &mut *s {
        Session::Pg(c) => c.execute(&sql).await,
        Session::My(c) => c.execute(&sql).await,
        Session::Ext(c) => c.execute(&sql).await,
    }
}

#[tauri::command]
async fn cancel_query(st: State<'_, Sessions>, conn_id: String, db: String, channel: String) -> Result<(), String> {
    st.cancel(&conn_id, &db, &channel).await
}

#[tauri::command]
async fn close_channel(st: State<'_, Sessions>, conn_id: String, db: String, channel: String) -> Result<(), String> {
    st.drop_channel(&conn_id, &db, &channel).await;
    Ok(())
}

// ---------- backup / restore ----------

#[tauri::command]
async fn detect_tools(app: AppHandle, conn_id: String) -> Result<Vec<tools::ToolStatus>, String> {
    let cfg = store::get(&app, &conn_id)?;
    Ok(tools::detect(&cfg).await)
}

#[tauri::command]
async fn run_task(app: AppHandle, spec: tools::TaskSpec) -> Result<i32, String> {
    let cfg = store::get(&app, &spec.conn_id)?;
    tools::run(app, cfg, spec).await
}

// ---------- files & documents ----------

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn load_doc(app: AppHandle, key: String) -> Result<serde_json::Value, String> {
    store::read_doc(&app, &key)
}

#[tauri::command]
fn save_doc(app: AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    store::write_doc(&app, &key, &value)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    procs::adopt_login_shell_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            store::migrate_legacy(app.handle());
            if let Ok(dir) = app.path().app_config_dir() {
                db::ext::init(app.handle().clone(), dir);
            }
            Ok(())
        })
        .manage(Sessions::default())
        .manage(fsx::Watchers::default())
        .manage(procs::Procs::default())
        .manage(procs::Terms::default())
        .manage(airflow::AirflowState::default())
        .manage(jupyter::JupyterState::default())
        .manage(dbt::DbtState::default())
        .manage(audit::AuditState::default())
        .manage(export::ExportState::default())
        .manage(assistant::AssistantState::default())
        .invoke_handler(tauri::generate_handler![
            list_connections,
            save_connection,
            delete_connection,
            test_connection,
            driver_status,
            install_driver,
            remove_driver,
            diagram_info,
            connect,
            disconnect,
            list_databases,
            list_schemas,
            list_objects,
            list_columns,
            list_indexes,
            get_ddl,
            completion_info,
            execute,
            cancel_query,
            close_channel,
            detect_tools,
            run_task,
            read_text_file,
            write_text_file,
            load_doc,
            save_doc,
            ide::fs_list,
            ide::fs_read,
            ide::fs_write,
            ide::fs_create,
            ide::fs_rename,
            ide::fs_delete,
            ide::fs_delete_permanently,
            ide::fs_copy,
            ide::fs_exists,
            ide::fs_files,
            ide::fs_search,
            ide::fs_watch,
            ide::fs_unwatch,
            ide::reveal_in_explorer,
            ide::proc_spawn,
            ide::proc_connect,
            ide::proc_write,
            ide::proc_close_stdin,
            ide::proc_kill,
            ide::run_capture,
            ide::which,
            ide::free_port,
            ide::env_info,
            ide::pty_open,
            ide::pty_write,
            ide::pty_resize,
            ide::pty_close,
            ide::window_reset,
            ide::macos_quarantine_status,
            airflow::airflow_instances,
            airflow::airflow_save_instance,
            airflow::airflow_delete_instance,
            airflow::airflow_test,
            airflow::airflow_request,
            airflow::airflow_get_all,
            airflow::airflow_cancel,
            airflow::airflow_release,
            airflow::airflow_env_dir,
            airflow::airflow_env_compose,
            airflow::airflow_env_register,
            airflow::airflow_env_health,
            airflow::airflow_env_forget,
            jupyter::jupyter_servers,
            jupyter::jupyter_save_server,
            jupyter::jupyter_delete_server,
            jupyter::jupyter_test,
            jupyter::jupyter_request,
            jupyter::jupyter_cancel,
            jupyter::jupyter_ws_open,
            jupyter::jupyter_ws_send,
            jupyter::jupyter_ws_close,
            jupyter::jupyter_release,
            jupyter::jupyter_env_create,
            jupyter::jupyter_env_compose,
            jupyter::jupyter_env_register,
            jupyter::jupyter_env_health,
            jupyter::jupyter_env_forget,
            jupyter::jupyter_open_lab,
            dbt::dbt_profiles,
            dbt::dbt_save_profile,
            dbt::dbt_delete_profile,
            dbt::dbt_run,
            dbt::dbt_cancel,
            dbt::dbt_release,
            dbt::dbt_version,
            dbt::dbt_project_profile,
            dbt::dbt_artifacts,
            dbt::dbt_compiled,
            assistant::assistant_open,
            assistant::assistant_close,
            assistant::assistant_tool_result,
            assistant::assistant_release,
            assistant::assistant_commands,
            speech::speech_start,
            speech::speech_stop,
            assistant::assistant_db_query,
            updater::update_check,
            updater::update_install,
            updater::app_version,
            export::export_query,
            export::export_cancel,
            export::write_base64_file,
            audit::audit_capabilities,
            audit::audit_projects,
            audit::audit_load,
            audit::audit_save_project,
            audit::audit_save_mappings,
            audit::audit_delete_project,
            audit::audit_delete_artifact,
            audit::audit_schemas,
            audit::audit_discover,
            audit::audit_suggest,
            audit::audit_validate,
            audit::audit_estimate,
            audit::audit_capture,
            audit::audit_reconcile,
            audit::audit_cancel,
            audit::audit_release,
            audit::audit_history,
            audit::audit_get,
            audit::audit_findings,
            audit::audit_export
        ])
        .build(tauri::generate_context!())
        .expect("error while building Rits")
        .run(|app, event| {
            if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = &event {
                let procs = app.state::<procs::Procs>();
                tauri::async_runtime::block_on(procs.kill_owner(label));
                procs::pty_close_owner(&app.state::<procs::Terms>(), label);
                tauri::async_runtime::block_on(app.state::<jupyter::JupyterState>().close_owner(label));
                tauri::async_runtime::block_on(app.state::<audit::AuditState>().cancel_owner(label));
                tauri::async_runtime::block_on(app.state::<assistant::AssistantState>().drop_owner(label));
                speech::cancel_owner(app, label);
            }
            if let tauri::RunEvent::Exit = event {
                // Do not leave language servers, debuggers or programs running.
                let procs = app.state::<procs::Procs>();
                tauri::async_runtime::block_on(procs.kill_all());
            }
        });
}
