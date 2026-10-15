//! Persistent connection profiles, stored as JSON in the app config directory.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Postgres,
    Mysql,
    Sqlserver,
    Oracle,
    Firebird,
    Sqlite,
    Duckdb,
    Clickhouse,
    Mongodb,
}

impl DbKind {
    /// Compiled-in drivers; the others run through an on-demand driver (db::ext).
    pub fn is_native(&self) -> bool {
        matches!(self, DbKind::Postgres | DbKind::Mysql)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnConfig {
    pub id: String,
    pub name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub password: String,
    /// Default database. For Postgres it is the database used to discover the others.
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub ssl: bool,
    /// Folder with pg_dump/pg_restore/psql or mysqldump/mysql. Empty = auto-detect.
    #[serde(default)]
    pub tools_dir: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub read_only: bool,
    /// Project folder the connection belongs to; empty = shown in every project.
    #[serde(default)]
    pub project: String,
}

impl ConnConfig {
    pub fn default_db(&self) -> String {
        if !self.database.is_empty() {
            return self.database.clone();
        }
        match self.kind {
            DbKind::Postgres => "postgres".into(),
            DbKind::Sqlite | DbKind::Duckdb => "main".into(),
            _ => String::new(),
        }
    }
}

fn file_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

pub fn load(app: &AppHandle) -> Result<Vec<ConnConfig>, String> {
    let path = file_path(app, "connections.json")?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("connections.json inválido: {e}"))
}

pub fn save_all(app: &AppHandle, list: &[ConnConfig]) -> Result<(), String> {
    let path = file_path(app, "connections.json")?;
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

pub fn get(app: &AppHandle, id: &str) -> Result<ConnConfig, String> {
    load(app)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("Conexão '{id}' não encontrada"))
}

/// Generic key/value JSON documents (query history, UI state, settings).
pub fn read_doc(app: &AppHandle, key: &str) -> Result<serde_json::Value, String> {
    let path = file_path(app, &format!("{key}.json"))?;
    if !path.exists() {
        return Ok(serde_json::Value::Null);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub fn write_doc(app: &AppHandle, key: &str, value: &serde_json::Value) -> Result<(), String> {
    let path = file_path(app, &format!("{key}.json"))?;
    std::fs::write(path, serde_json::to_string(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// One-time migration from the app's former name ("Beaver Grip", identifier dev.beavergrip.app):
/// copies connections, history and project settings into the new config folder.
pub fn migrate_legacy(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let Some(parent) = dir.parent() else { return };
    let old = parent.join("dev.beavergrip.app");
    if !old.is_dir() || dir.join("connections.json").exists() {
        return;
    }
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(rd) = std::fs::read_dir(&old) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_file() {
                let _ = std::fs::copy(&p, dir.join(e.file_name()));
            }
        }
    }
}
