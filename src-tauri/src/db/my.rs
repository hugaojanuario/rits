use super::{err_chain, ColumnInfo, CompletionTable, DbObject, IndexInfo, QueryResult, ServerInfo, MAX_ROWS};
use crate::store::ConnConfig;
use mysql_async::prelude::*;
use mysql_async::{Conn, OptsBuilder, Row, SslOpts, Value};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub struct MyConn {
    conn: Mutex<Conn>,
    id: u32,
}

fn fmt_err(e: &mysql_async::Error) -> String {
    match e {
        mysql_async::Error::Server(s) => format!("ERRO {} ({}): {}", s.code, s.state, s.message),
        other => err_chain(other),
    }
}

fn opts(cfg: &ConnConfig, db: &str) -> OptsBuilder {
    let mut o = OptsBuilder::default()
        .ip_or_hostname(cfg.host.clone())
        .tcp_port(cfg.port)
        .user(Some(cfg.user.clone()))
        .pass(if cfg.password.is_empty() { None } else { Some(cfg.password.clone()) })
        .db_name(if db.is_empty() { None } else { Some(db.to_string()) })
        .conn_ttl(None::<Duration>)
        .prefer_socket(false);
    if cfg.ssl {
        o = o.ssl_opts(Some(
            SslOpts::default()
                .with_danger_accept_invalid_certs(true)
                .with_danger_skip_domain_validation(true),
        ));
    }
    o
}

fn val_to_string(v: Value) -> Option<String> {
    match v {
        Value::NULL => None,
        Value::Bytes(b) => Some(match String::from_utf8(b) {
            Ok(s) => s,
            Err(e) => {
                let b = e.into_bytes();
                let hex: String = b.iter().take(256).map(|x| format!("{x:02X}")).collect();
                format!("0x{hex}{}", if b.len() > 256 { "…" } else { "" })
            }
        }),
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(d) => Some(d.to_string()),
        Value::Date(y, m, d, h, mi, s, us) => Some(if h == 0 && mi == 0 && s == 0 && us == 0 {
            format!("{y:04}-{m:02}-{d:02}")
        } else {
            format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}")
        }),
        Value::Time(neg, d, h, m, s, _) => {
            Some(format!("{}{:02}:{m:02}:{s:02}", if neg { "-" } else { "" }, d * 24 + h as u32))
        }
    }
}

fn s(row: &Row, i: usize) -> String {
    row.as_ref(i).cloned().and_then(val_to_string).unwrap_or_default()
}

fn os(row: &Row, i: usize) -> Option<String> {
    row.as_ref(i).cloned().and_then(val_to_string).filter(|x| !x.is_empty())
}

impl MyConn {
    pub async fn open(cfg: &ConnConfig, db: &str) -> Result<MyConn, String> {
        let fut = Conn::new(opts(cfg, db));
        let mut conn = tokio::time::timeout(Duration::from_secs(10), fut)
            .await
            .map_err(|_| "Tempo de conexão esgotado (10s)".to_string())?
            .map_err(|e| fmt_err(&e))?;
        if cfg.read_only {
            conn.query_drop("SET SESSION TRANSACTION READ ONLY").await.map_err(|e| fmt_err(&e))?;
        }
        let id = conn.id();
        Ok(MyConn { conn: Mutex::new(conn), id })
    }

    pub fn id(&self) -> u32 {
        self.id
    }

    pub async fn execute(&self, sql: &str) -> Result<Vec<QueryResult>, String> {
        let mut conn = self.conn.lock().await;
        let start = Instant::now();
        let mut result = conn.query_iter(sql).await.map_err(|e| fmt_err(&e))?;
        let mut out = Vec::new();
        loop {
            let cols = result.columns();
            match cols {
                Some(cols) if !cols.is_empty() => {
                    let mut qr = QueryResult {
                        columns: cols.iter().map(|c| c.name_str().into_owned()).collect(),
                        has_rows: true,
                        ..Default::default()
                    };
                    let mut stream = result.stream::<Row>().await.map_err(|e| fmt_err(&e))?;
                    if let Some(st) = stream.as_mut() {
                        use futures_util::StreamExt;
                        while let Some(row) = st.next().await {
                            let row = row.map_err(|e| fmt_err(&e))?;
                            if qr.rows.len() >= MAX_ROWS {
                                qr.truncated = true;
                                continue;
                            }
                            qr.rows.push(row.unwrap().into_iter().map(val_to_string).collect());
                        }
                    }
                    qr.elapsed_ms = start.elapsed().as_millis() as u64;
                    out.push(qr);
                }
                _ => {
                    let affected = result.affected_rows();
                    let _: Vec<Row> = result.collect().await.map_err(|e| fmt_err(&e))?;
                    out.push(QueryResult {
                        affected: Some(affected),
                        elapsed_ms: start.elapsed().as_millis() as u64,
                        ..Default::default()
                    });
                }
            }
            if result.is_empty() {
                break;
            }
        }
        drop(result);
        Ok(out)
    }

    async fn rows(&self, sql: &str, params: Vec<Value>) -> Result<Vec<Row>, String> {
        let mut conn = self.conn.lock().await;
        conn.exec(sql, params).await.map_err(|e| fmt_err(&e))
    }

    pub async fn server_info(&self) -> Result<ServerInfo, String> {
        let r = self.rows("SELECT CONCAT(@@version_comment, ' ', VERSION()), CURRENT_USER()", vec![]).await?;
        Ok(ServerInfo { version: s(&r[0], 0), current_user: s(&r[0], 1) })
    }

    pub async fn databases(&self) -> Result<Vec<String>, String> {
        let r = self
            .rows(
                "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA
                 ORDER BY SCHEMA_NAME IN ('mysql','information_schema','performance_schema','sys'), SCHEMA_NAME",
                vec![],
            )
            .await?;
        Ok(r.iter().map(|x| s(x, 0)).collect())
    }

    pub async fn objects(&self, schema: &str) -> Result<Vec<DbObject>, String> {
        let p = || Value::from(schema);
        let r = self
            .rows(
                "SELECT TABLE_NAME, IF(TABLE_TYPE = 'VIEW', 'view', 'table'), TABLE_COMMENT
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
                 UNION ALL
                 SELECT ROUTINE_NAME, LOWER(ROUTINE_TYPE), ROUTINE_COMMENT
                 FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
                 UNION ALL
                 SELECT TRIGGER_NAME, 'trigger', NULL FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
                 UNION ALL
                 SELECT EVENT_NAME, 'event', EVENT_COMMENT FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?
                 ORDER BY 2, 1",
                vec![p(), p(), p(), p()],
            )
            .await?;
        Ok(r.iter().map(|x| DbObject { name: s(x, 0), kind: s(x, 1), comment: os(x, 2) }).collect())
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
        let r = self
            .rows(
                "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE = 'YES', COLUMN_DEFAULT, COLUMN_KEY = 'PRI', COLUMN_COMMENT, EXTRA
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
                vec![schema.into(), table.into()],
            )
            .await?;
        Ok(r.iter()
            .map(|x| {
                let extra = s(x, 6);
                let mut ty = s(x, 1);
                if !extra.is_empty() {
                    ty = format!("{ty} {extra}");
                }
                ColumnInfo {
                    name: s(x, 0),
                    data_type: ty,
                    nullable: s(x, 2) == "1",
                    default: os(x, 3),
                    pk: s(x, 4) == "1",
                    comment: os(x, 5),
                }
            })
            .collect())
    }

    pub async fn indexes(&self, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
        let r = self
            .rows(
                "SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', '), MIN(NON_UNIQUE) = 0
                 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                 GROUP BY INDEX_NAME ORDER BY INDEX_NAME <> 'PRIMARY', INDEX_NAME",
                vec![schema.into(), table.into()],
            )
            .await?;
        Ok(r.iter()
            .map(|x| {
                let name = s(x, 0);
                IndexInfo { primary: name == "PRIMARY", columns: s(x, 1), unique: s(x, 2) == "1", name }
            })
            .collect())
    }

    pub async fn completion(&self, schema: &str) -> Result<Vec<CompletionTable>, String> {
        let r = self
            .rows(
                "SELECT TABLE_SCHEMA, TABLE_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR '\\n')
                 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = ? OR (? = '' AND TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys'))
                 GROUP BY TABLE_SCHEMA, TABLE_NAME LIMIT 5000",
                vec![schema.into(), schema.into()],
            )
            .await?;
        Ok(r.iter()
            .map(|x| CompletionTable {
                schema: s(x, 0),
                table: s(x, 1),
                columns: s(x, 2).split('\n').map(str::to_string).collect(),
            })
            .collect())
    }

    pub async fn ddl(&self, schema: &str, name: &str, kind: &str) -> Result<String, String> {
        let (stmt, col) = match kind {
            "view" => ("VIEW", 1),
            "function" => ("FUNCTION", 2),
            "procedure" => ("PROCEDURE", 2),
            "trigger" => ("TRIGGER", 2),
            "event" => ("EVENT", 3),
            _ => ("TABLE", 1),
        };
        let sql = format!("SHOW CREATE {stmt} {}.{}", qi(schema), qi(name));
        let r = self.rows(&sql, vec![]).await?;
        let mut ddl = r.first().map(|x| s(x, col)).unwrap_or_default();
        if !ddl.ends_with(';') {
            ddl.push(';');
        }
        Ok(ddl)
    }
}

pub async fn kill_query(cfg: &ConnConfig, id: u32) -> Result<(), String> {
    let mut c = Conn::new(opts(cfg, "")).await.map_err(|e| fmt_err(&e))?;
    c.query_drop(format!("KILL QUERY {id}")).await.map_err(|e| fmt_err(&e))?;
    c.disconnect().await.ok();
    Ok(())
}

pub fn qi(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}
