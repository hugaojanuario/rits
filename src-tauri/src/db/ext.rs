//! Databases without a compiled-in driver (SQL Server, Oracle, Firebird, SQLite, DuckDB, ClickHouse,
//! MongoDB). Like DataGrip/DBeaver download JDBC drivers, Rits downloads the driver the first time a
//! connection of that kind is tested or saved: a private Python venv in the config folder gets the
//! driver packages, and `rits_driver.py` serves requests as JSON lines over stdio (one process per
//! session, so cancelling a query = killing the process).

use super::{ColumnInfo, CompletionTable, DbObject, DiagramInfo, IndexInfo, QueryResult, ServerInfo};
use crate::procs::{augmented_path, hidden, which};
use crate::store::{ConnConfig, DbKind};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

const SCRIPT: &str = include_str!("drivers/rits_driver.py");

static DIR: OnceLock<PathBuf> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
/// Serializes installs (two connections of the same kind tested at once must not race pip).
static INSTALL: OnceLock<Mutex<()>> = OnceLock::new();

/// Called once at startup with the app config folder.
pub fn init(app: AppHandle, config_dir: PathBuf) {
    set_dir(config_dir.join("drivers"));
    let _ = APP.set(app);
}

/// Folder of the drivers venv (tests use a temporary one).
pub fn set_dir(dir: PathBuf) {
    let _ = DIR.set(dir);
}

fn dir() -> Result<&'static PathBuf, String> {
    DIR.get().ok_or_else(|| "drivers não inicializados".to_string())
}

/// Python packages per database (pure Python where possible, so no native client is needed).
pub fn packages(kind: &DbKind) -> &'static [&'static str] {
    match kind {
        DbKind::Sqlserver => &["python-tds", "pyOpenSSL", "certifi"],
        DbKind::Oracle => &["oracledb"],
        DbKind::Firebird => &["firebirdsql"],
        DbKind::Sqlite => &[],
        DbKind::Duckdb => &["duckdb"],
        DbKind::Clickhouse => &["clickhouse-connect"],
        DbKind::Mongodb => &["pymongo", "json5"],
        DbKind::Postgres | DbKind::Mysql => &[],
    }
}

fn kind_id(kind: &DbKind) -> String {
    serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn venv_python(d: &Path) -> PathBuf {
    if cfg!(windows) {
        d.join("venv").join("Scripts").join("python.exe")
    } else {
        d.join("venv").join("bin").join("python")
    }
}

fn marker(d: &Path, kind: &DbKind) -> PathBuf {
    d.join(format!("{}.installed", kind_id(kind)))
}

#[derive(Serialize, Clone)]
struct Progress {
    kind: String,
    line: String,
    done: bool,
}

fn progress(kind: &DbKind, line: &str, done: bool) {
    if let Some(app) = APP.get() {
        let _ = app.emit("driver-progress", Progress { kind: kind_id(kind), line: line.to_string(), done });
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverStatus {
    pub native: bool,
    pub installed: bool,
    pub packages: Vec<String>,
}

pub fn status(kind: &DbKind) -> DriverStatus {
    let installed = kind.is_native() || dir().map(|d| marker(d, kind).exists() && venv_python(d).exists()).unwrap_or(false);
    DriverStatus { native: kind.is_native(), installed, packages: packages(kind).iter().map(|s| s.to_string()).collect() }
}

/// A Python 3.9+ to create the drivers venv.
async fn base_python() -> Result<String, String> {
    let candidates: &[(&str, &[&str])] = if cfg!(windows) { &[("py", &["-3"]), ("python", &[]), ("python3", &[])] } else { &[("python3", &[]), ("python", &[])] };
    for (name, pre) in candidates {
        let Some(exe) = which(name, &[]) else { continue };
        if exe.contains("WindowsApps") {
            continue;
        }
        let mut c = Command::new(&exe);
        c.args(*pre).args(["-c", "import sys;print(sys.version_info>=(3,9))"]).stdout(Stdio::piped()).stderr(Stdio::null());
        hidden(&mut c);
        if let Ok(o) = c.output().await {
            if String::from_utf8_lossy(&o.stdout).trim() == "True" {
                return Ok(if pre.is_empty() { exe } else { format!("{exe}\u{1f}{}", pre.join("\u{1f}")) });
            }
        }
    }
    Err("Python 3.9 ou mais novo não encontrado. Ele é necessário para baixar o driver deste banco (instale com brew install python ou winget install Python.Python.3.13).".into())
}

async fn run_logged(kind: &DbKind, program: &str, args: &[String]) -> Result<(), String> {
    let mut parts = program.split('\u{1f}');
    let exe = parts.next().unwrap_or(program);
    let mut c = Command::new(exe);
    c.args(parts).args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).env("PATH", augmented_path(&[])).env("PIP_DISABLE_PIP_VERSION_CHECK", "1");
    hidden(&mut c);
    let mut child = c.spawn().map_err(|e| format!("{program}: {e}"))?;
    let out = child.stdout.take();
    let err = child.stderr.take();
    let k1 = kind.clone();
    let t1 = tokio::spawn(async move {
        if let Some(o) = out {
            let mut lines = BufReader::new(o).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                progress(&k1, &l, false);
            }
        }
    });
    let tail = Arc::new(Mutex::new(String::new()));
    let tail2 = tail.clone();
    let k2 = kind.clone();
    let t2 = tokio::spawn(async move {
        if let Some(e) = err {
            let mut lines = BufReader::new(e).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                progress(&k2, &l, false);
                let mut t = tail2.lock().await;
                t.push_str(&l);
                t.push('\n');
                if t.len() > 4000 {
                    let cut = t.len() - 4000;
                    t.drain(..cut);
                }
            }
        }
    });
    let st = child.wait().await.map_err(|e| e.to_string())?;
    let _ = (t1.await, t2.await);
    if st.success() {
        Ok(())
    } else {
        Err(tail.lock().await.trim().lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
    }
}

/// Downloads the driver for `kind` if it is not installed yet (no-op for native drivers).
pub async fn ensure_driver(kind: &DbKind) -> Result<(), String> {
    if kind.is_native() {
        return Ok(());
    }
    let d = dir()?;
    let _guard = INSTALL.get_or_init(|| Mutex::new(())).lock().await;
    let py = venv_python(d);
    let mk = marker(d, kind);
    if mk.exists() && py.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    if !py.exists() {
        progress(kind, "Criando o ambiente dos drivers…", false);
        let base = base_python().await?;
        run_logged(kind, &base, &["-m".into(), "venv".into(), d.join("venv").to_string_lossy().into()]).await.map_err(|e| format!("Falha ao criar o ambiente dos drivers:\n{e}"))?;
    }
    let pkgs = packages(kind);
    if !pkgs.is_empty() {
        progress(kind, &format!("Baixando o driver ({})…", pkgs.join(", ")), false);
        let mut args: Vec<String> = vec!["-m".into(), "pip".into(), "install".into(), "--upgrade".into()];
        args.extend(pkgs.iter().map(|s| s.to_string()));
        run_logged(kind, &py.to_string_lossy(), &args).await.map_err(|e| format!("Falha ao baixar o driver:\n{e}"))?;
    }
    std::fs::write(&mk, pkgs.join("\n")).map_err(|e| e.to_string())?;
    progress(kind, "Driver pronto", true);
    Ok(())
}

/// Removes a downloaded driver (it is downloaded again on the next test/save).
pub fn remove_driver(kind: &DbKind) -> Result<(), String> {
    let d = dir()?;
    let _ = std::fs::remove_file(marker(d, kind));
    Ok(())
}

fn script_path() -> Result<PathBuf, String> {
    let d = dir()?;
    std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    let p = d.join("rits_driver.py");
    if std::fs::read_to_string(&p).map(|s| s != SCRIPT).unwrap_or(true) {
        std::fs::write(&p, SCRIPT).map_err(|e| e.to_string())?;
    }
    Ok(p)
}

pub struct ExtConn {
    child: Child,
    stdin: ChildStdin,
    out: BufReader<ChildStdout>,
    stderr: Arc<Mutex<String>>,
    next: u64,
    pub pid: u32,
}

impl ExtConn {
    pub async fn open(cfg: &ConnConfig, db: &str) -> Result<ExtConn, String> {
        ensure_driver(&cfg.kind).await?;
        let d = dir()?;
        let mut c = Command::new(venv_python(d));
        c.arg("-u").arg(script_path()?).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        c.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1").kill_on_drop(true);
        hidden(&mut c);
        let mut child = c.spawn().map_err(|e| format!("Falha ao iniciar o driver: {e}"))?;
        let pid = child.id().unwrap_or(0);
        let stdin = child.stdin.take().ok_or("stdin")?;
        let out = BufReader::new(child.stdout.take().ok_or("stdout")?);
        let stderr = Arc::new(Mutex::new(String::new()));
        if let Some(mut e) = child.stderr.take() {
            let buf = stderr.clone();
            tokio::spawn(async move {
                let mut b = vec![0u8; 4096];
                while let Ok(n) = e.read(&mut b).await {
                    if n == 0 {
                        break;
                    }
                    let mut s = buf.lock().await;
                    s.push_str(&String::from_utf8_lossy(&b[..n]));
                    if s.len() > 8000 {
                        let cut = s.len() - 8000;
                        s.drain(..cut);
                    }
                }
            });
        }
        let mut conn = ExtConn { child, stdin, out, stderr, next: 0, pid };
        conn.call::<Value>("open", json!({ "cfg": cfg, "db": db })).await?;
        Ok(conn)
    }

    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Generic request (used by the Migration Audit: audit_discover, audit_begin, audit_describe).
    pub async fn call_json(&mut self, op: &str, args: Value) -> Result<Value, String> {
        self.call(op, args).await
    }

    /// Streams the rows of a query in batches (`audit_stream`): one `{"id", "rows"}` line per batch,
    /// then the final reply with the row count. `f` returning an error stops reading (the caller
    /// then kills the process to cancel the query).
    pub async fn stream(&mut self, sql: &str, params: &[String], batch: usize, f: &mut (dyn FnMut(Vec<Option<String>>) -> Result<(), String> + Send)) -> Result<u64, String> {
        self.next += 1;
        let req = json!({ "id": self.next, "op": "audit_stream", "sql": sql, "params": params, "batch": batch });
        let line = format!("{req}\n");
        if self.stdin.write_all(line.as_bytes()).await.is_err() || self.stdin.flush().await.is_err() {
            return Err("O driver foi encerrado".into());
        }
        let mut resp = String::new();
        loop {
            resp.clear();
            match self.out.read_line(&mut resp).await {
                Ok(0) | Err(_) => {
                    let e = self.stderr.lock().await.clone();
                    return Err(if e.trim().is_empty() { "O driver foi encerrado".into() } else { format!("O driver foi encerrado:\n{}", e.trim()) });
                }
                Ok(_) => {}
            }
            let Ok(v) = serde_json::from_str::<Value>(resp.trim()) else { continue };
            if v.get("id").and_then(Value::as_u64) != Some(self.next) {
                continue;
            }
            if let Some(rows) = v.get("rows").and_then(Value::as_array) {
                for r in rows {
                    let row: Vec<Option<String>> = r.as_array().map(|a| a.iter().map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                    f(row)?;
                }
                continue;
            }
            if v.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(v.get("result").and_then(Value::as_u64).unwrap_or(0));
            }
            return Err(v.get("error").and_then(Value::as_str).unwrap_or("erro desconhecido").to_string());
        }
    }

    async fn call<T: DeserializeOwned>(&mut self, op: &str, args: Value) -> Result<T, String> {
        self.next += 1;
        let mut req = json!({ "id": self.next, "op": op });
        if let (Some(r), Some(a)) = (req.as_object_mut(), args.as_object()) {
            r.extend(a.clone());
        }
        let line = format!("{req}\n");
        let dead = |s: &str| if s.trim().is_empty() { "O driver foi encerrado (consulta cancelada?)".to_string() } else { format!("O driver foi encerrado:\n{}", s.trim()) };
        if self.stdin.write_all(line.as_bytes()).await.is_err() || self.stdin.flush().await.is_err() {
            return Err(dead(&self.stderr.lock().await));
        }
        let mut resp = String::new();
        loop {
            resp.clear();
            match self.out.read_line(&mut resp).await {
                Ok(0) | Err(_) => return Err(dead(&self.stderr.lock().await)),
                Ok(_) => {}
            }
            // Drivers may print noise; only lines that are our JSON replies count.
            if let Ok(v) = serde_json::from_str::<Value>(resp.trim()) {
                if v.get("id").and_then(Value::as_u64) == Some(self.next) {
                    if v.get("ok").and_then(Value::as_bool) == Some(true) {
                        return serde_json::from_value(v.get("result").cloned().unwrap_or(Value::Null)).map_err(|e| format!("resposta inválida do driver: {e}"));
                    }
                    return Err(v.get("error").and_then(Value::as_str).unwrap_or("erro desconhecido").to_string());
                }
            }
        }
    }

    pub async fn server_info(&mut self) -> Result<ServerInfo, String> {
        self.call("server_info", json!({})).await
    }
    pub async fn databases(&mut self) -> Result<Vec<String>, String> {
        self.call("databases", json!({})).await
    }
    pub async fn schemas(&mut self) -> Result<Vec<String>, String> {
        self.call("schemas", json!({})).await
    }
    pub async fn objects(&mut self, schema: &str) -> Result<Vec<DbObject>, String> {
        self.call("objects", json!({ "schema": schema })).await
    }
    pub async fn columns(&mut self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
        self.call("columns", json!({ "schema": schema, "table": table })).await
    }
    pub async fn indexes(&mut self, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
        self.call("indexes", json!({ "schema": schema, "table": table })).await
    }
    pub async fn completion(&mut self, schema: &str) -> Result<Vec<CompletionTable>, String> {
        self.call("completion", json!({ "schema": schema })).await
    }
    pub async fn ddl(&mut self, schema: &str, name: &str, kind: &str) -> Result<String, String> {
        self.call("ddl", json!({ "schema": schema, "name": name, "kind": kind })).await
    }
    pub async fn execute(&mut self, sql: &str, max_rows: usize) -> Result<Vec<QueryResult>, String> {
        self.call("execute", json!({ "sql": sql, "maxRows": max_rows })).await
    }
    /// Console transactions: "manual", "auto", "commit" or "rollback".
    pub async fn tx(&mut self, action: &str) -> Result<(), String> {
        self.call::<Value>("tx", json!({ "action": action })).await.map(|_| ())
    }
    pub async fn diagram(&mut self, schema: &str) -> Result<DiagramInfo, String> {
        self.call("diagram", json!({ "schema": schema })).await
    }
}
