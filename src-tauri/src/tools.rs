//! Backup / restore through the native client tools (pg_dump, pg_restore, psql,
//! mysqldump, mysql), streaming their output to the UI as events.

use crate::store::{ConnConfig, DbKind};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskSpec {
    pub task_id: String,
    pub conn_id: String,
    /// "backup" | "restore"
    pub action: String,
    pub database: String,
    /// Output file/folder for backup, input file for restore.
    pub path: String,
    /// Postgres: custom | plain | tar | directory. MySQL: always plain SQL.
    pub format: String,
    pub schemas: Vec<String>,
    pub tables: Vec<String>,
    pub exclude_tables: Vec<String>,
    pub compression: Option<u8>,
    pub data_only: bool,
    pub schema_only: bool,
    pub no_owner: bool,
    pub no_privileges: bool,
    pub clean: bool,
    pub if_exists: bool,
    pub create: bool,
    pub inserts: bool,
    pub column_inserts: bool,
    pub encoding: String,
    pub jobs: Option<u8>,
    pub single_transaction: bool,
    // MySQL only
    pub routines: bool,
    pub triggers: bool,
    pub events: bool,
    pub add_drop_table: bool,
    pub extended_insert: bool,
    pub lock_tables: bool,
    pub extra_args: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub task_id: String,
    pub kind: String,
    pub line: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub name: String,
    pub path: Option<String>,
    pub version: Option<String>,
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Candidate folders, best first: configured folder, PATH, standard installs.
fn candidate_dirs(kind: &DbKind, custom: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if !custom.is_empty() {
        dirs.push(PathBuf::from(custom));
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    if !cfg!(windows) {
        unix_candidate_dirs(kind, &mut dirs);
        return dirs;
    }
    let roots = [r"C:\Program Files", r"C:\Program Files (x86)"];
    let patterns: &[&str] = match kind {
        DbKind::Postgres => &["PostgreSQL", "pgAdmin 4"],
        DbKind::Mysql => &["MySQL", "MariaDB"],
        _ => &[],
    };
    for root in roots {
        for p in patterns {
            let base = Path::new(root).join(p);
            let mut found = vec![];
            collect_bins(&base, 3, &mut found);
            // Newest version first ("17" > "16", "MySQL Server 8.4" > "8.0").
            found.sort_by(|a, b| natural_cmp(&b.to_string_lossy(), &a.to_string_lossy()));
            dirs.extend(found);
        }
    }
    dirs
}

/// Homebrew kegs (often keg-only, so not on PATH), Postgres.app, the official installers and the Linux packages.
fn unix_candidate_dirs(kind: &DbKind, dirs: &mut Vec<PathBuf>) {
    let prefixes: &[&str] = match kind {
        DbKind::Postgres => &["postgresql", "libpq"],
        DbKind::Mysql => &["mysql", "mariadb"],
        _ => return,
    };
    for root in ["/opt/homebrew/opt", "/usr/local/opt"] {
        let Ok(rd) = std::fs::read_dir(root) else { continue };
        let mut found: Vec<PathBuf> = rd
            .flatten()
            .filter(|e| prefixes.iter().any(|p| e.file_name().to_string_lossy().starts_with(p)))
            .map(|e| e.path().join("bin"))
            .collect();
        // Newest first ("postgresql@17" > "postgresql@16"); unversioned formulas last.
        found.sort_by(|a, b| natural_cmp(&b.to_string_lossy(), &a.to_string_lossy()));
        dirs.extend(found);
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    match kind {
        DbKind::Postgres => {
            let mut found = vec![];
            collect_bins(Path::new("/Applications/Postgres.app/Contents/Versions"), 1, &mut found);
            found.sort_by(|a, b| natural_cmp(&b.to_string_lossy(), &a.to_string_lossy()));
            dirs.extend(found);
            dirs.push(PathBuf::from("/Library/PostgreSQL/bin"));
            let mut found = vec![];
            collect_bins(Path::new("/Library/PostgreSQL"), 1, &mut found);
            found.sort_by(|a, b| natural_cmp(&b.to_string_lossy(), &a.to_string_lossy()));
            dirs.extend(found);
            // Debian/Ubuntu (/usr/lib/postgresql/17/bin) and the PGDG RPMs (/usr/pgsql-17/bin).
            let mut found = vec![];
            collect_bins(Path::new("/usr/lib/postgresql"), 1, &mut found);
            if let Ok(rd) = std::fs::read_dir("/usr") {
                found.extend(rd.flatten().map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("pgsql-"))).map(|p| p.join("bin")));
            }
            found.sort_by(|a, b| natural_cmp(&b.to_string_lossy(), &a.to_string_lossy()));
            dirs.extend(found);
        }
        DbKind::Mysql => dirs.push(PathBuf::from("/usr/local/mysql/bin")),
        _ => {}
    }
}

fn collect_bins(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if p.file_name().map(|n| n.eq_ignore_ascii_case("bin")).unwrap_or(false) {
                out.push(p.clone());
            }
            if depth > 0 {
                collect_bins(&p, depth - 1, out);
            }
        }
    }
}

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let key = |s: &str| -> Vec<u64> {
        s.split(|c: char| !c.is_ascii_digit()).filter_map(|x| x.parse().ok()).collect()
    };
    key(a).cmp(&key(b))
}

pub fn find_tool(kind: &DbKind, custom: &str, name: &str) -> Option<PathBuf> {
    candidate_dirs(kind, custom).into_iter().map(|d| d.join(exe(name))).find(|p| p.is_file())
}

pub async fn detect(cfg: &ConnConfig) -> Vec<ToolStatus> {
    let names: &[&str] = match cfg.kind {
        DbKind::Postgres => &["pg_dump", "pg_restore", "psql"],
        DbKind::Mysql => &["mysqldump", "mysql"],
        _ => &[],
    };
    let mut out = vec![];
    for n in names {
        let path = find_tool(&cfg.kind, &cfg.tools_dir, n);
        let mut version = None;
        if let Some(p) = &path {
            if let Ok(o) = hidden(Command::new(p)).arg("--version").output().await {
                version = Some(String::from_utf8_lossy(&o.stdout).trim().to_string());
            }
        }
        out.push(ToolStatus { name: n.to_string(), path: path.map(|p| p.display().to_string()), version });
    }
    out
}

#[cfg_attr(not(windows), allow(unused_mut))]
fn hidden(mut c: Command) -> Command {
    #[cfg(windows)]
    {
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

/// Splits user-provided extra arguments, honouring double quotes.
fn split_args(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut q = false;
    for ch in s.chars() {
        match ch {
            '"' => q = !q,
            c if c.is_whitespace() && !q => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

pub struct Plan {
    pub tool: &'static str,
    pub args: Vec<String>,
    pub stdin_file: Option<PathBuf>,
}

fn require(cfg: &ConnConfig, name: &str) -> Result<PathBuf, String> {
    find_tool(&cfg.kind, &cfg.tools_dir, name).ok_or_else(|| {
        format!(
            "'{name}' não foi encontrado. Instale o cliente do {} ou informe a pasta das ferramentas nas propriedades da conexão.",
            match cfg.kind {
                DbKind::Postgres => "PostgreSQL",
                DbKind::Mysql => "MySQL/MariaDB",
                _ => "banco",
            }
        )
    })
}

pub fn pg_plan(cfg: &ConnConfig, t: &TaskSpec) -> Result<Plan, String> {
    let mut a: Vec<String> = vec![
        "--host".into(),
        cfg.host.clone(),
        "--port".into(),
        cfg.port.to_string(),
        "--username".into(),
        cfg.user.clone(),
        "--no-password".into(),
        "--verbose".into(),
    ];
    if t.action == "backup" {
        let fmt = match t.format.as_str() {
            "plain" => "p",
            "tar" => "t",
            "directory" => "d",
            _ => "c",
        };
        a.extend(["--format".into(), fmt.into(), "--file".into(), t.path.clone()]);
        for s in &t.schemas {
            a.extend(["--schema".into(), s.clone()]);
        }
        for s in &t.tables {
            a.extend(["--table".into(), s.clone()]);
        }
        for s in &t.exclude_tables {
            a.extend(["--exclude-table".into(), s.clone()]);
        }
        if let Some(c) = t.compression {
            if fmt != "t" {
                a.extend(["--compress".into(), c.to_string()]);
            }
        }
        if let Some(j) = t.jobs.filter(|j| *j > 1 && fmt == "d") {
            a.extend(["--jobs".into(), j.to_string()]);
        }
        if !t.encoding.is_empty() {
            a.extend(["--encoding".into(), t.encoding.clone()]);
        }
        let flags = [
            (t.data_only, "--data-only"),
            (t.schema_only, "--schema-only"),
            (t.no_owner, "--no-owner"),
            (t.no_privileges, "--no-privileges"),
            (t.clean, "--clean"),
            (t.clean && t.if_exists, "--if-exists"),
            (t.create, "--create"),
            (t.inserts && !t.column_inserts, "--inserts"),
            (t.column_inserts, "--column-inserts"),
        ];
        a.extend(flags.iter().filter(|f| f.0).map(|f| f.1.to_string()));
        a.extend(split_args(&t.extra_args));
        a.push(t.database.clone());
        return Ok(Plan { tool: "pg_dump", args: a, stdin_file: None });
    }

    // Restore: plain SQL goes through psql, archives through pg_restore.
    let is_plain = t.format == "plain"
        || (t.format.is_empty()
            && Path::new(&t.path)
                .extension()
                .map(|e| e.eq_ignore_ascii_case("sql"))
                .unwrap_or(false));
    if is_plain {
        a.retain(|x| x != "--verbose");
        a.extend(["--dbname".into(), t.database.clone(), "--file".into(), t.path.clone(), "--echo-errors".into()]);
        if t.single_transaction {
            a.extend(["--single-transaction".into(), "--set".into(), "ON_ERROR_STOP=1".into()]);
        }
        a.extend(split_args(&t.extra_args));
        return Ok(Plan { tool: "psql", args: a, stdin_file: None });
    }
    a.extend(["--dbname".into(), t.database.clone()]);
    for s in &t.schemas {
        a.extend(["--schema".into(), s.clone()]);
    }
    for s in &t.tables {
        a.extend(["--table".into(), s.clone()]);
    }
    if let Some(j) = t.jobs.filter(|j| *j > 1 && !t.single_transaction) {
        a.extend(["--jobs".into(), j.to_string()]);
    }
    let flags = [
        (t.data_only, "--data-only"),
        (t.schema_only, "--schema-only"),
        (t.no_owner, "--no-owner"),
        (t.no_privileges, "--no-privileges"),
        (t.clean, "--clean"),
        (t.clean && t.if_exists, "--if-exists"),
        (t.create, "--create"),
        (t.single_transaction, "--single-transaction"),
    ];
    a.extend(flags.iter().filter(|f| f.0).map(|f| f.1.to_string()));
    a.extend(split_args(&t.extra_args));
    a.push(t.path.clone());
    Ok(Plan { tool: "pg_restore", args: a, stdin_file: None })
}

pub fn my_plan(cfg: &ConnConfig, t: &TaskSpec) -> Result<Plan, String> {
    let mut a: Vec<String> = vec![
        format!("--host={}", cfg.host),
        format!("--port={}", cfg.port),
        format!("--user={}", cfg.user),
        "--protocol=TCP".into(),
    ];
    if !t.encoding.is_empty() {
        a.push(format!("--default-character-set={}", t.encoding));
    }
    if t.action == "backup" {
        a.extend(["--verbose".into(), format!("--result-file={}", t.path)]);
        let flags = [
            (t.single_transaction, "--single-transaction"),
            (t.routines, "--routines"),
            (t.triggers, "--triggers"),
            (!t.triggers, "--skip-triggers"),
            (t.events, "--events"),
            (t.add_drop_table, "--add-drop-table"),
            (!t.add_drop_table, "--skip-add-drop-table"),
            (t.extended_insert, "--extended-insert"),
            (!t.extended_insert, "--skip-extended-insert"),
            (t.lock_tables && !t.single_transaction, "--lock-tables"),
            (!t.lock_tables || t.single_transaction, "--skip-lock-tables"),
            (t.schema_only, "--no-data"),
            (t.data_only, "--no-create-info"),
            (t.column_inserts, "--complete-insert"),
            (t.create, "--add-drop-database"),
        ];
        a.extend(flags.iter().filter(|f| f.0).map(|f| f.1.to_string()));
        for x in &t.exclude_tables {
            a.push(format!("--ignore-table={}.{}", t.database, x));
        }
        a.extend(split_args(&t.extra_args));
        if t.create {
            a.extend(["--databases".into(), t.database.clone()]);
        } else {
            a.push(t.database.clone());
            a.extend(t.tables.iter().cloned());
        }
        return Ok(Plan { tool: "mysqldump", args: a, stdin_file: None });
    }
    a.extend(["--verbose".into()]);
    a.extend(split_args(&t.extra_args));
    if !t.database.is_empty() {
        a.push(t.database.clone());
    }
    Ok(Plan { tool: "mysql", args: a, stdin_file: Some(PathBuf::from(&t.path)) })
}

pub async fn run(app: AppHandle, cfg: ConnConfig, t: TaskSpec) -> Result<i32, String> {
    let plan = match cfg.kind {
        DbKind::Postgres => pg_plan(&cfg, &t)?,
        DbKind::Mysql => my_plan(&cfg, &t)?,
        _ => return Err("Backup e restauração só estão disponíveis para PostgreSQL e MySQL/MariaDB.".into()),
    };
    let program = require(&cfg, plan.tool)?;
    let emit = |kind: &str, line: String| {
        let _ = app.emit("task-event", TaskEvent { task_id: t.task_id.clone(), kind: kind.into(), line });
    };
    emit("cmd", format!("{} {}", program.display(), plan.args.join(" ")));

    let mut cmd = hidden(Command::new(&program));
    cmd.args(&plan.args).stdout(Stdio::piped()).stderr(Stdio::piped());
    match cfg.kind {
        DbKind::Postgres => {
            cmd.env("PGPASSWORD", &cfg.password);
            if cfg.ssl {
                cmd.env("PGSSLMODE", "require");
            }
        }
        DbKind::Mysql => {
            cmd.env("MYSQL_PWD", &cfg.password);
        }
        _ => {}
    }
    cmd.stdin(if plan.stdin_file.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = cmd.spawn().map_err(|e| format!("Falha ao iniciar {}: {e}", program.display()))?;

    if let Some(f) = plan.stdin_file {
        let mut stdin = child.stdin.take().unwrap();
        let mut file = tokio::fs::File::open(&f).await.map_err(|e| format!("{}: {e}", f.display()))?;
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut file, &mut stdin).await;
        });
    }

    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let app1 = app.clone();
    let id1 = t.task_id.clone();
    let h1 = tokio::spawn(async move {
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            let _ = app1.emit("task-event", TaskEvent { task_id: id1.clone(), kind: "out".into(), line: l });
        }
    });
    let app2 = app.clone();
    let id2 = t.task_id.clone();
    let h2 = tokio::spawn(async move {
        let mut lines = BufReader::new(err).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            let _ = app2.emit("task-event", TaskEvent { task_id: id2.clone(), kind: "err".into(), line: l });
        }
    });
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = h1.await;
    let _ = h2.await;
    let code = status.code().unwrap_or(-1);
    emit("done", code.to_string());
    Ok(code)
}
