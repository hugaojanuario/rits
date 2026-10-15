//! Database sessions. Each (connection, database, channel) gets its own physical
//! connection so a long console query never blocks the explorer.

pub mod ext;
pub mod my;
pub mod pg;

use crate::store::{ConnConfig, DbKind};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Hard cap on rows sent to the UI for a single result set.
pub const MAX_ROWS: usize = 50_000;

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Set for statements that don't return rows (INSERT/UPDATE/DDL...).
    pub affected: Option<u64>,
    pub has_rows: bool,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    pub name: String,
    /// table | view | matview | function | procedure | sequence | trigger | event
    pub kind: String,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub pk: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: String,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionTable {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub version: String,
    pub current_user: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub name: String,
    pub table: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramTable {
    pub name: String,
    pub kind: String,
    pub columns: Vec<ColumnInfo>,
}

/// Everything the ER diagram needs for one schema, in a single round trip.
#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiagramInfo {
    pub tables: Vec<DiagramTable>,
    pub fks: Vec<ForeignKey>,
}

pub enum Session {
    Pg(pg::PgConn),
    My(my::MyConn),
    /// SQL Server, Oracle, Firebird, SQLite, DuckDB, ClickHouse, MongoDB: on-demand driver process.
    Ext(ext::ExtConn),
}

impl Session {
    pub async fn open(cfg: &ConnConfig, db: &str) -> Result<Session, String> {
        match cfg.kind {
            DbKind::Postgres => Ok(Session::Pg(pg::PgConn::open(cfg, db).await?)),
            DbKind::Mysql => Ok(Session::My(my::MyConn::open(cfg, db).await?)),
            _ => Ok(Session::Ext(ext::ExtConn::open(cfg, db).await?)),
        }
    }
}

type Key = (String, String, String);

#[derive(Default)]
pub struct Sessions {
    map: Mutex<HashMap<Key, Arc<Mutex<Session>>>>,
    /// Cancel handles for the console channel, keyed by (conn, db, channel).
    cancels: Mutex<HashMap<Key, Canceller>>,
}

#[derive(Clone)]
pub enum Canceller {
    Pg(tokio_postgres::CancelToken, bool),
    My(ConnConfig, u32),
    /// Driver process: cancelling kills it (the session reopens on the next query).
    Ext(u32),
}

impl Sessions {
    pub async fn get(
        &self,
        cfg: &ConnConfig,
        db: &str,
        channel: &str,
    ) -> Result<Arc<Mutex<Session>>, String> {
        let db = if db.is_empty() { cfg.default_db() } else { db.to_string() };
        let key = (cfg.id.clone(), db.clone(), channel.to_string());
        if let Some(s) = self.map.lock().await.get(&key) {
            let alive = match &mut *s.lock().await {
                Session::Pg(c) => !c.client.is_closed(),
                Session::My(_) => true,
                Session::Ext(c) => c.alive(),
            };
            if alive {
                return Ok(s.clone());
            }
        }
        let session = Session::open(cfg, &db).await?;
        let canceller = match &session {
            Session::Pg(c) => Canceller::Pg(c.client.cancel_token(), cfg.ssl),
            Session::My(c) => Canceller::My(cfg.clone(), c.id()),
            Session::Ext(c) => Canceller::Ext(c.pid),
        };
        let arc = Arc::new(Mutex::new(session));
        self.map.lock().await.insert(key.clone(), arc.clone());
        self.cancels.lock().await.insert(key, canceller);
        Ok(arc)
    }

    pub async fn cancel(&self, conn_id: &str, db: &str, channel: &str) -> Result<(), String> {
        let found = {
            let cancels = self.cancels.lock().await;
            cancels
                .iter()
                .find(|((c, d, ch), _)| c == conn_id && (db.is_empty() || d == db) && ch == channel)
                .map(|(_, v)| v.clone())
        };
        match found {
            Some(Canceller::Pg(token, ssl)) => pg::cancel(token, ssl).await,
            Some(Canceller::My(cfg, id)) => my::kill_query(&cfg, id).await,
            Some(Canceller::Ext(pid)) => {
                crate::procs::kill_tree(pid).await;
                Ok(())
            }
            None => Ok(()),
        }
    }

    pub async fn drop_conn(&self, conn_id: &str) {
        self.map.lock().await.retain(|(c, _, _), _| c != conn_id);
        self.cancels.lock().await.retain(|(c, _, _), _| c != conn_id);
    }

    pub async fn drop_channel(&self, conn_id: &str, db: &str, channel: &str) {
        let k = (conn_id.to_string(), db.to_string(), channel.to_string());
        self.map.lock().await.remove(&k);
        self.cancels.lock().await.remove(&k);
    }
}

/// Splits an error chain into a single readable message.
pub fn err_chain(e: &dyn std::error::Error) -> String {
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        let s_msg = s.to_string();
        if !msg.contains(&s_msg) {
            msg.push_str(": ");
            msg.push_str(&s_msg);
        }
        src = s.source();
    }
    msg
}
