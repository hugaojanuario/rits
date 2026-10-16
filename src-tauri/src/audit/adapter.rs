//! Database adapters of the Migration Audit. Each adapter opens its own connections (never the
//! explorer's shared sessions), reads in read-only transactions, streams rows with bounded memory
//! and builds SQL with quoted identifiers and bound parameters.
//!
//! Capability matrix (see `capabilities`): what each database really offers, so the UI never
//! promises more than was implemented and validated.

use super::canon::{logical_type, LType};
use super::model::{Column, Constraint, Dataset, Pred, Structure, Table};
use crate::db::{ext::ExtConn, my, pg};
use crate::store::{ConnConfig, DbKind};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub kind: String,
    pub label: String,
    /// full | partial | none
    pub support: String,
    pub items: Vec<(String, String, String)>,
    pub validated: String,
}

fn caps(kind: &str, label: &str, support: &str, validated: &str, items: &[(&str, &str, &str)]) -> Capability {
    Capability { kind: kind.into(), label: label.into(), support: support.into(), validated: validated.into(), items: items.iter().map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string())).collect() }
}

/// What each adapter implements (sim/parcial/não) and how it was validated.
pub fn capabilities() -> Vec<Capability> {
    vec![
        caps("postgres", "PostgreSQL", "full", "Testes de integração com PostgreSQL 17 (Docker).", &[
            ("Descoberta de schemas e tabelas", "sim", "pg_class/pg_namespace; partições filhas não são contadas em dobro"),
            ("Metadados de colunas", "sim", "information_schema.columns + colunas geradas"),
            ("Chaves primárias e estrangeiras", "sim", "pg_constraint"),
            ("Índices e unicidade", "sim", "pg_index"),
            ("Contagem exata", "sim", "COUNT(*) no snapshot"),
            ("Contagem estimada", "sim", "pg_class.reltuples (marcada como estimativa; -1 = desconhecida)"),
            ("Leitura incremental", "sim", "streaming com backpressure do protocolo"),
            ("Consulta parametrizada", "sim", "$n com CAST para o tipo da coluna"),
            ("Consistência de snapshot", "sim", "REPEATABLE READ READ ONLY; pg_export_snapshot entre conexões"),
            ("Normalização de tipos", "sim", "texto canônico com TimeZone=UTC, DateStyle=ISO, bytea hex"),
            ("Perfilamento", "sim", "na própria leitura, sem consultas extras"),
            ("Cancelamento", "sim", "CancelToken do protocolo"),
        ]),
        caps("mysql", "MySQL / MariaDB", "full", "Testes de integração com MySQL 8.4 e MariaDB 11.8 (Docker).", &[
            ("Descoberta de schemas e tabelas", "sim", "information_schema (o banco faz o papel de schema)"),
            ("Metadados de colunas", "sim", "information_schema.COLUMNS (EXTRA = colunas geradas)"),
            ("Chaves primárias e estrangeiras", "sim", "TABLE_CONSTRAINTS/KEY_COLUMN_USAGE (FKs só em InnoDB)"),
            ("Índices e unicidade", "sim", "STATISTICS"),
            ("Contagem exata", "sim", "COUNT(*) no snapshot"),
            ("Contagem estimada", "sim", "TABLE_ROWS (aproximada no InnoDB)"),
            ("Leitura incremental", "sim", "linha a linha pelo protocolo binário"),
            ("Consulta parametrizada", "sim", "prepared statements"),
            ("Consistência de snapshot", "parcial", "START TRANSACTION WITH CONSISTENT SNAPSHOT por conexão; com concorrência > 1 cada conexão tem o seu"),
            ("Normalização de tipos", "sim", "time_zone=+00:00; DECIMAL exato; datas zero viram inválidas, nunca nulas"),
            ("Perfilamento", "sim", "na própria leitura"),
            ("Cancelamento", "sim", "KILL QUERY"),
        ]),
        caps("sqlserver", "SQL Server", "partial", "Testes de integração com SQL Server 2022 (Docker, imagem amd64 emulada) pelo driver python-tds.", &[
            ("Descoberta de schemas e tabelas", "sim", "INFORMATION_SCHEMA + sys"),
            ("Metadados de colunas", "sim", "INFORMATION_SCHEMA.COLUMNS"),
            ("Chaves primárias e estrangeiras", "sim", "INFORMATION_SCHEMA constraints"),
            ("Índices e unicidade", "parcial", "somente via constraints"),
            ("Contagem exata", "sim", "COUNT_BIG(*)"),
            ("Contagem estimada", "sim", "sys.partitions"),
            ("Leitura incremental", "sim", "fetchmany no processo do driver"),
            ("Consulta parametrizada", "sim", "parâmetros do driver"),
            ("Consistência de snapshot", "parcial", "SNAPSHOT só se ALLOW_SNAPSHOT_ISOLATION estiver ligado; senão leitura sem garantia (registrado)"),
            ("Normalização de tipos", "sim", "datetimeoffset convertido para UTC"),
            ("Consultas personalizadas", "parcial", "sem transação somente leitura no SQL Server: use um login somente leitura"),
            ("Cancelamento", "sim", "encerrando o processo do driver"),
        ]),
        caps("firebird", "Firebird", "partial", "Testes de integração com Firebird 5 (Docker) pelo driver firebirdsql.", &[
            ("Descoberta de tabelas", "sim", "RDB$RELATIONS (sem schemas)"),
            ("Metadados de colunas", "sim", "RDB$RELATION_FIELDS/RDB$FIELDS"),
            ("Chaves primárias e estrangeiras", "sim", "RDB$RELATION_CONSTRAINTS"),
            ("Contagem exata", "sim", "COUNT(*)"),
            ("Contagem estimada", "não", "o Firebird não mantém estimativa de linhas"),
            ("Leitura incremental", "sim", "fetchmany no processo do driver"),
            ("Consistência de snapshot", "sim", "transação SNAPSHOT READ ONLY"),
            ("Cancelamento", "sim", "encerrando o processo do driver"),
        ]),
        caps("mongodb", "MongoDB", "none", "Fora da primeira versão.", &[("Documentos, arrays e identidade", "não", "exigem regras próprias (aninhamento, arrays, _id); não suportado nesta versão")]),
    ]
}

pub fn dialect_of(kind: &DbKind) -> Result<&'static str, String> {
    match kind {
        DbKind::Postgres => Ok("postgres"),
        DbKind::Mysql => Ok("mysql"),
        DbKind::Sqlserver => Ok("sqlserver"),
        DbKind::Firebird => Ok("firebird"),
        DbKind::Mongodb => Err("MongoDB não é suportado pelo Migration Audit nesta versão (documentos, arrays e identidade exigem regras próprias).".into()),
        _ => Err("Este banco não é suportado pelo Migration Audit nesta versão (bancos relacionais: PostgreSQL, MySQL, MariaDB, SQL Server, Firebird).".into()),
    }
}

pub fn quote(dialect: &str, s: &str) -> String {
    match dialect {
        "mysql" => format!("`{}`", s.replace('`', "``")),
        "sqlserver" => format!("[{}]", s.replace(']', "]]")),
        _ => format!("\"{}\"", s.replace('"', "\"\"")),
    }
}

pub fn table_ref(dialect: &str, schema: &str, table: &str) -> String {
    if dialect == "firebird" || schema.is_empty() {
        quote(dialect, table)
    } else {
        format!("{}.{}", quote(dialect, schema), quote(dialect, table))
    }
}

/// Placeholder for the n-th parameter (1-based), cast to the column's native type when needed.
fn placeholder(dialect: &str, n: usize, native: Option<&str>) -> String {
    match dialect {
        "postgres" => match native {
            Some(t) if !t.is_empty() => format!("CAST(${n}::text AS {t})"),
            _ => format!("${n}::text"),
        },
        "sqlserver" => "%s".into(),
        _ => "?".into(),
    }
}

/// Rejects anything but a single statement (no `;` outside quotes and comments).
pub fn single_statement(sql: &str) -> Result<String, String> {
    let b = sql.as_bytes();
    let mut i = 0;
    let mut last_semicolon = None;
    while i < b.len() {
        match b[i] {
            b'\'' | b'"' | b'`' => {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
            }
            b'-' if b.get(i + 1) == Some(&b'-') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 1;
            }
            b';' => {
                if last_semicolon.is_some() {
                    return Err("A consulta deve ter uma única instrução.".into());
                }
                last_semicolon = Some(i);
            }
            c if last_semicolon.is_some() && !(c as char).is_whitespace() => return Err("A consulta deve ter uma única instrução.".into()),
            _ => {}
        }
        i += 1;
    }
    let s = match last_semicolon {
        Some(p) => &sql[..p],
        None => sql,
    };
    let t = s.trim();
    let low = t.to_lowercase();
    if !(low.starts_with("select") || low.starts_with("with") || low.starts_with("(")) {
        return Err("A consulta precisa ser um SELECT (ou WITH … SELECT) somente leitura.".into());
    }
    Ok(t.to_string())
}

pub const OPS: &[&str] = &["=", "<>", "<", "<=", ">", ">=", "is null", "is not null", "in"];

/// Column catalog of a dataset: name -> (native type, logical type).
pub type ColTypes = Vec<(String, String, LType)>;

pub struct Built {
    pub sql: String,
    pub params: Vec<String>,
}

fn find_col<'a>(cols: &'a ColTypes, name: &str) -> Result<&'a (String, String, LType), String> {
    cols.iter().find(|c| c.0 == name).ok_or_else(|| format!("Coluna \"{name}\" não existe no conjunto de dados."))
}

fn preds_sql(dialect: &str, cols: &ColTypes, preds: &[Pred], prefix: &str, params: &mut Vec<String>) -> Result<Vec<String>, String> {
    let mut out = vec![];
    for p in preds {
        let c = find_col(cols, &p.column)?;
        let qc = format!("{prefix}{}", quote(dialect, &c.0));
        let op = p.op.to_lowercase();
        if !OPS.contains(&op.as_str()) {
            return Err(format!("Operador não permitido: {}", p.op));
        }
        let native = if dialect == "postgres" { Some(c.1.as_str()) } else { None };
        match op.as_str() {
            "is null" => out.push(format!("{qc} IS NULL")),
            "is not null" => out.push(format!("{qc} IS NOT NULL")),
            "in" => {
                if p.values.is_empty() {
                    return Err(format!("Filtro IN sem valores em \"{}\".", p.column));
                }
                let mut ph = vec![];
                for v in &p.values {
                    params.push(v.clone());
                    ph.push(placeholder(dialect, params.len(), native));
                }
                out.push(format!("{qc} IN ({})", ph.join(", ")));
            }
            o => {
                let v = p.values.first().ok_or_else(|| format!("Filtro sem valor em \"{}\".", p.column))?;
                params.push(v.clone());
                out.push(format!("{qc} {o} {}", placeholder(dialect, params.len(), native)));
            }
        }
    }
    Ok(out)
}

/// FROM clause of a dataset (table or validated read-only query).
pub fn from_sql(dialect: &str, ds: &Dataset) -> Result<String, String> {
    match ds.kind.as_str() {
        "query" => Ok(format!("({}) {}rits_q", single_statement(&ds.sql)?, if dialect == "firebird" { "" } else { "AS " })),
        _ => {
            if ds.table.is_empty() {
                return Err("Tabela não definida.".into());
            }
            Ok(format!("{} {}rits_q", table_ref(dialect, &ds.schema, &ds.table), if dialect == "firebird" { "" } else { "AS " }))
        }
    }
}

fn select_expr(dialect: &str, c: &(String, String, LType)) -> String {
    let q = format!("rits_q.{}", quote(dialect, &c.0));
    match dialect {
        // text output of PostgreSQL is canonical under the session settings (UTC, ISO, hex)
        "postgres" => format!("CAST({q} AS text)"),
        _ => q,
    }
}

/// SELECT of the given columns, plus an exclusion flag column ("1"/"0") when there are exclusions.
pub fn select_sql(dialect: &str, ds: &Dataset, cols: &ColTypes, wanted: &[String], exclusions: &[Vec<Pred>], extra_filters: &[Pred]) -> Result<Built, String> {
    let mut params = vec![];
    let mut list = vec![];
    for w in wanted {
        list.push(select_expr(dialect, find_col(cols, w)?));
    }
    if !exclusions.is_empty() {
        let mut ors = vec![];
        for e in exclusions {
            let parts = preds_sql(dialect, cols, e, "rits_q.", &mut params)?;
            if parts.is_empty() {
                return Err("Exclusão sem condição.".into());
            }
            ors.push(format!("({})", parts.join(" AND ")));
        }
        list.push(format!("CASE WHEN {} THEN '1' ELSE '0' END", ors.join(" OR ")));
    }
    if list.is_empty() {
        list.push("1".into());
    }
    let mut wh = preds_sql(dialect, cols, &ds.filters, "rits_q.", &mut params)?;
    wh.extend(preds_sql(dialect, cols, extra_filters, "rits_q.", &mut params)?);
    let mut sql = format!("SELECT {} FROM {}", list.join(", "), from_sql(dialect, ds)?);
    if !wh.is_empty() {
        sql.push_str(&format!(" WHERE {}", wh.join(" AND ")));
    }
    Ok(Built { sql, params })
}

pub fn count_sql(dialect: &str, ds: &Dataset, cols: &ColTypes, extra_filters: &[Pred]) -> Result<Built, String> {
    let mut params = vec![];
    let mut wh = preds_sql(dialect, cols, &ds.filters, "rits_q.", &mut params)?;
    wh.extend(preds_sql(dialect, cols, extra_filters, "rits_q.", &mut params)?);
    let cnt = match dialect {
        "postgres" => "CAST(COUNT(*) AS text)",
        "sqlserver" => "COUNT_BIG(*)",
        _ => "COUNT(*)",
    };
    let mut sql = format!("SELECT {cnt} FROM {}", from_sql(dialect, ds)?);
    if !wh.is_empty() {
        sql.push_str(&format!(" WHERE {}", wh.join(" AND ")));
    }
    Ok(Built { sql, params })
}

/// Shared cancellation flag and query counter of a job.
#[derive(Clone, Default)]
pub struct JobCtl {
    pub cancel: Arc<AtomicBool>,
    pub queries: Arc<AtomicU64>,
    pub budget: u64,
    pub processed: Arc<AtomicU64>,
}

impl JobCtl {
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
    pub fn charge(&self) -> Result<(), String> {
        let n = self.queries.fetch_add(1, Ordering::Relaxed) + 1;
        if self.budget > 0 && n > self.budget {
            return Err(format!("Orçamento de consultas esgotado ({} consultas). A verificação ficou incompleta.", self.budget));
        }
        Ok(())
    }
}

pub const CANCELLED: &str = "Cancelado pelo usuário.";

pub enum AConn {
    Pg { c: pg::PgConn, ssl: bool },
    My { c: mysql_async::Conn, cfg: ConnConfig, mariadb: bool },
    Ext(Box<ExtConn>),
}

pub struct Adapter {
    pub dialect: &'static str,
    pub conn: AConn,
    pub version: String,
    pub timeout: u64,
}

fn dur(secs: u64) -> Duration {
    if secs == 0 {
        Duration::from_secs(60 * 60 * 24 * 7)
    } else {
        Duration::from_secs(secs)
    }
}

impl Adapter {
    pub async fn open(cfg: &ConnConfig, db: &str, timeout: u64) -> Result<Adapter, String> {
        let dialect = dialect_of(&cfg.kind)?;
        let db = if db.is_empty() { cfg.default_db() } else { db.to_string() };
        match cfg.kind {
            DbKind::Postgres => {
                let c = pg::PgConn::open(cfg, &db).await?;
                c.client
                    .batch_execute("SET TIME ZONE 'UTC'; SET DateStyle = 'ISO, YMD'; SET IntervalStyle = 'iso_8601'; SET bytea_output = 'hex'; SET extra_float_digits = 3; SET application_name = 'Rits Migration Audit'")
                    .await
                    .map_err(|e| pg::fmt_err(&e))?;
                if timeout > 0 {
                    c.client.batch_execute(&format!("SET statement_timeout = {}", timeout * 1000)).await.map_err(|e| pg::fmt_err(&e))?;
                }
                let v: String = c.client.query_one("SELECT version()", &[]).await.map_err(|e| pg::fmt_err(&e))?.get(0);
                Ok(Adapter { dialect, conn: AConn::Pg { c, ssl: cfg.ssl }, version: v, timeout })
            }
            DbKind::Mysql => {
                use mysql_async::prelude::*;
                let mut c = tokio::time::timeout(Duration::from_secs(15), mysql_async::Conn::new(my::opts(cfg, &db)))
                    .await
                    .map_err(|_| "Tempo de conexão esgotado".to_string())?
                    .map_err(|e| my::fmt_err(&e))?;
                let v: String = c.query_first("SELECT VERSION()").await.map_err(|e| my::fmt_err(&e))?.unwrap_or_default();
                let mariadb = v.to_lowercase().contains("mariadb");
                c.query_drop("SET SESSION time_zone = '+00:00'").await.map_err(|e| my::fmt_err(&e))?;
                if timeout > 0 {
                    let q = if mariadb { format!("SET SESSION max_statement_time = {timeout}") } else { format!("SET SESSION max_execution_time = {}", timeout * 1000) };
                    c.query_drop(q).await.map_err(|e| my::fmt_err(&e))?;
                }
                Ok(Adapter { dialect, conn: AConn::My { c, cfg: cfg.clone(), mariadb }, version: v, timeout })
            }
            _ => {
                let mut c = ExtConn::open(cfg, &db).await?;
                let info = c.server_info().await?;
                Ok(Adapter { dialect, conn: AConn::Ext(Box::new(c)), version: info.version, timeout })
            }
        }
    }

    /// Starts the read transaction. Returns (obtained description, notes).
    pub async fn begin(&mut self, consistency: &str, snapshot: Option<&str>) -> Result<(String, Option<String>), String> {
        match &mut self.conn {
            AConn::Pg { c, .. } => {
                if consistency == "none" {
                    c.client.batch_execute("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY").await.map_err(|e| pg::fmt_err(&e))?;
                    return Ok(("leitura sem garantia de snapshot (READ COMMITTED)".into(), None));
                }
                c.client.batch_execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY").await.map_err(|e| pg::fmt_err(&e))?;
                if let Some(id) = snapshot {
                    // the id comes from pg_export_snapshot of the coordinator connection
                    if !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                        return Err("identificador de snapshot inválido".into());
                    }
                    c.client.batch_execute(&format!("SET TRANSACTION SNAPSHOT '{id}'")).await.map_err(|e| pg::fmt_err(&e))?;
                    return Ok(("snapshot compartilhado (pg_export_snapshot), REPEATABLE READ READ ONLY".into(), None));
                }
                let id: Option<String> = c.client.query_one("SELECT pg_export_snapshot()", &[]).await.ok().map(|r| r.get(0));
                Ok(("snapshot consistente (REPEATABLE READ READ ONLY)".into(), id))
            }
            AConn::My { c, .. } => {
                use mysql_async::prelude::*;
                if consistency == "none" {
                    c.query_drop("START TRANSACTION READ ONLY").await.map_err(|e| my::fmt_err(&e))?;
                    return Ok(("leitura sem garantia de snapshot".into(), None));
                }
                c.query_drop("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ").await.map_err(|e| my::fmt_err(&e))?;
                c.query_drop("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY").await.map_err(|e| my::fmt_err(&e))?;
                Ok(("snapshot consistente nesta conexão (InnoDB, REPEATABLE READ READ ONLY)".into(), None))
            }
            AConn::Ext(c) => {
                let r = c.call_json("audit_begin", json!({ "consistency": consistency })).await?;
                Ok((r.as_str().unwrap_or("transação do driver").to_string(), None))
            }
        }
    }

    pub async fn end(&mut self) {
        match &mut self.conn {
            AConn::Pg { c, .. } => {
                let _ = c.client.batch_execute("ROLLBACK").await;
            }
            AConn::My { c, .. } => {
                use mysql_async::prelude::*;
                let _ = c.query_drop("ROLLBACK").await;
            }
            AConn::Ext(c) => {
                let _ = c.call_json("audit_end", json!({})).await;
            }
        }
    }

    pub async fn close(self) {
        match self.conn {
            AConn::Pg { .. } => {}
            AConn::My { c, .. } => {
                let _ = c.disconnect().await;
            }
            AConn::Ext(c) => drop(c),
        }
    }

    /// Catalog of a dataset's columns (tables from the structure, queries by describing them).
    pub async fn describe(&mut self, ds: &Dataset, structure: Option<&Structure>, ctl: &JobCtl) -> Result<ColTypes, String> {
        if ds.kind != "query" {
            if let Some(t) = structure.and_then(|s| s.tables.iter().find(|t| t.schema == ds.schema && t.name == ds.table)) {
                if !t.error.is_empty() {
                    return Err(t.error.clone());
                }
                return Ok(t.columns.iter().map(|c| (c.name.clone(), c.native.clone(), c.ltype.unwrap_or(LType::Other))).collect());
            }
        }
        ctl.charge()?;
        let dialect = self.dialect;
        let probe = format!("SELECT * FROM {} WHERE 1 = 0", from_sql(dialect, ds)?);
        let cols: Vec<(String, String)> = match &mut self.conn {
            AConn::Pg { c, .. } => {
                let st = c.client.prepare(&probe).await.map_err(|e| pg::fmt_err(&e))?;
                st.columns().iter().map(|c| (c.name().to_string(), c.type_().name().to_string())).collect()
            }
            AConn::My { c, .. } => {
                use mysql_async::prelude::*;
                let st = c.prep(&probe).await.map_err(|e| my::fmt_err(&e))?;
                let out = st.columns().iter().map(|c| (c.name_str().into_owned(), my_type_name(c))).collect();
                let _ = c.close(st).await;
                out
            }
            AConn::Ext(c) => {
                let v = c.call_json("audit_describe", json!({ "sql": probe })).await?;
                serde_json::from_value(v).map_err(|e| e.to_string())?
            }
        };
        let mut seen = std::collections::HashSet::new();
        for (n, _) in &cols {
            if n.is_empty() || n == "?column?" {
                return Err("Toda coluna da consulta precisa de um alias (AS nome).".into());
            }
            if !seen.insert(n.to_lowercase()) {
                return Err(format!("Alias de coluna repetido na consulta: {n}"));
            }
        }
        Ok(cols.into_iter().map(|(n, t)| {
            let lt = logical_type(dialect, &t);
            (n, t, lt)
        }).collect())
    }

    pub async fn count(&mut self, b: &Built, ctl: &JobCtl) -> Result<u64, String> {
        let mut n: Option<u64> = None;
        self.stream(b, 1, ctl, &mut |row| {
            n = row.first().cloned().flatten().and_then(|v| v.trim().parse().ok());
            Ok(())
        })
        .await?;
        n.ok_or_else(|| "contagem sem resultado".to_string())
    }

    /// Streams rows (all values as text). `f` returning an error stops the scan; the query is
    /// cancelled on the server.
    pub async fn stream(&mut self, b: &Built, batch: usize, ctl: &JobCtl, f: &mut (dyn FnMut(Vec<Option<String>>) -> Result<(), String> + Send)) -> Result<u64, String> {
        ctl.charge()?;
        let timeout = dur(self.timeout);
        match &mut self.conn {
            AConn::Pg { c, ssl } => {
                let st = c.client.prepare(&b.sql).await.map_err(|e| pg::fmt_err(&e))?;
                let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = b.params.iter().map(|s| s as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
                let rs = tokio::time::timeout(timeout, c.client.query_raw(&st, params)).await.map_err(|_| "Tempo limite da consulta esgotado.".to_string())?.map_err(|e| pg::fmt_err(&e))?;
                futures_util::pin_mut!(rs);
                let mut n = 0u64;
                loop {
                    let next = match tokio::time::timeout(timeout, rs.next()).await {
                        Ok(x) => x,
                        Err(_) => {
                            let _ = pg::cancel(c.client.cancel_token(), *ssl).await;
                            return Err("Tempo limite da consulta esgotado.".into());
                        }
                    };
                    let Some(row) = next else { break };
                    let row = row.map_err(|e| pg::fmt_err(&e))?;
                    let vals: Vec<Option<String>> = (0..row.len()).map(|i| row.try_get::<_, Option<String>>(i).unwrap_or(None)).collect();
                    n += 1;
                    let r = if ctl.cancelled() { Err(CANCELLED.to_string()) } else { f(vals) };
                    if let Err(e) = r {
                        let _ = pg::cancel(c.client.cancel_token(), *ssl).await;
                        return Err(e);
                    }
                }
                Ok(n)
            }
            AConn::My { c, cfg, .. } => {
                use mysql_async::prelude::*;
                let id = c.id();
                let params: Vec<mysql_async::Value> = b.params.iter().map(|s| mysql_async::Value::Bytes(s.clone().into_bytes())).collect();
                let mut res = c.exec_iter(b.sql.as_str(), params).await.map_err(|e| my::fmt_err(&e))?;
                let types: Vec<(bool, bool)> = res.columns_ref().iter().map(|col| (is_binary(col), is_bit(col))).collect();
                let mut n = 0u64;
                let mut failure: Option<String> = None;
                {
                    let mut stream = res.stream::<mysql_async::Row>().await.map_err(|e| my::fmt_err(&e))?;
                    if let Some(st) = stream.as_mut() {
                        loop {
                            let next = match tokio::time::timeout(timeout, st.next()).await {
                                Ok(x) => x,
                                Err(_) => {
                                    failure = Some("Tempo limite da consulta esgotado.".into());
                                    break;
                                }
                            };
                            let Some(row) = next else { break };
                            let row = row.map_err(|e| my::fmt_err(&e))?;
                            let vals: Vec<Option<String>> = row.unwrap().into_iter().enumerate().map(|(i, v)| my_text(v, types.get(i).copied().unwrap_or((false, false)))).collect();
                            n += 1;
                            let r = if ctl.cancelled() { Err(CANCELLED.to_string()) } else { f(vals) };
                            if let Err(e) = r {
                                failure = Some(e);
                                break;
                            }
                        }
                    }
                }
                if let Some(e) = failure {
                    let _ = my::kill_query(cfg, id).await;
                    return Err(e);
                }
                Ok(n)
            }
            AConn::Ext(c) => {
                let pid = c.pid;
                let ctl2 = ctl.clone();
                let mut wrapped = |row: Vec<Option<String>>| if ctl2.cancelled() { Err(CANCELLED.to_string()) } else { f(row) };
                match tokio::time::timeout(timeout, c.stream(&b.sql, &b.params, batch.clamp(100, 10_000), &mut wrapped)).await {
                    Ok(Ok(n)) => Ok(n),
                    Ok(Err(e)) => {
                        crate::procs::kill_tree(pid).await;
                        Err(e)
                    }
                    Err(_) => {
                        crate::procs::kill_tree(pid).await;
                        Err("Tempo limite da consulta esgotado.".into())
                    }
                }
            }
        }
    }

    /// Structure discovery of the given schemas (databases on MySQL).
    pub async fn discover(&mut self, schemas: &[String], ctl: &JobCtl) -> Result<Structure, String> {
        ctl.charge()?;
        let mut s = Structure { dialect: self.dialect.into(), version: self.version.clone(), captured_at: super::model::now_ms(), ..Default::default() };
        match &mut self.conn {
            AConn::Pg { c, .. } => s.tables = pg_discover(&c.client, schemas).await?,
            AConn::My { c, .. } => s.tables = my_discover(c, schemas).await?,
            AConn::Ext(c) => {
                let v = c.call_json("audit_discover", json!({ "schemas": schemas })).await?;
                s.tables = serde_json::from_value(v).map_err(|e| format!("resposta inválida do driver: {e}"))?;
            }
        }
        let d = self.dialect;
        for t in s.tables.iter_mut() {
            for c in t.columns.iter_mut() {
                if c.ltype.is_none() {
                    c.ltype = Some(logical_type(d, &c.native));
                }
            }
        }
        Ok(s)
    }

    pub async fn schemas(&mut self) -> Result<Vec<String>, String> {
        match &mut self.conn {
            AConn::Pg { c, .. } => Ok(c
                .client
                .query("SELECT nspname::text FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1", &[])
                .await
                .map_err(|e| pg::fmt_err(&e))?
                .iter()
                .map(|r| r.get(0))
                .collect()),
            AConn::My { c, .. } => {
                use mysql_async::prelude::*;
                let v: Vec<String> = c
                    .query("SELECT CAST(SCHEMA_NAME AS CHAR) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY 1")
                    .await
                    .map_err(|e| my::fmt_err(&e))?;
                Ok(v)
            }
            AConn::Ext(c) => Ok(serde_json::from_value(c.call_json("schemas", json!({})).await?).unwrap_or_default()),
        }
    }
}

fn my_type_name(c: &mysql_async::Column) -> String {
    use mysql_async::consts::ColumnType::*;
    match c.column_type() {
        MYSQL_TYPE_TINY => "tinyint",
        MYSQL_TYPE_SHORT | MYSQL_TYPE_INT24 | MYSQL_TYPE_LONG | MYSQL_TYPE_LONGLONG | MYSQL_TYPE_YEAR => "bigint",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "decimal",
        MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE => "double",
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "date",
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "datetime",
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "timestamp",
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "time",
        MYSQL_TYPE_JSON => "json",
        MYSQL_TYPE_BIT => "bit",
        _ if is_binary(c) => "varbinary",
        _ => "varchar",
    }
    .into()
}

fn is_binary(c: &mysql_async::Column) -> bool {
    use mysql_async::consts::ColumnType::*;
    // charset 63 = binary
    matches!(c.column_type(), MYSQL_TYPE_BLOB | MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_STRING | MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR) && c.character_set() == 63
}

fn is_bit(c: &mysql_async::Column) -> bool {
    matches!(c.column_type(), mysql_async::consts::ColumnType::MYSQL_TYPE_BIT)
}

/// Text form of a MySQL binary-protocol value (dates in ISO with microseconds).
pub fn my_text(v: mysql_async::Value, (binary, bit): (bool, bool)) -> Option<String> {
    use mysql_async::Value::*;
    match v {
        NULL => None,
        Bytes(b) if bit => Some(b.iter().fold(0u64, |a, x| (a << 8) | *x as u64).to_string()),
        Bytes(b) if binary => Some(format!("\\x{}", super::canon::hex(&b))),
        Bytes(b) => Some(String::from_utf8_lossy(&b).into_owned()),
        Int(i) => Some(i.to_string()),
        UInt(u) => Some(u.to_string()),
        Float(f) => Some(f.to_string()),
        Double(d) => Some(d.to_string()),
        Date(y, m, d, h, mi, s, us) => Some(format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}")),
        Time(neg, d, h, m, s, us) => Some(format!("{}{:02}:{m:02}:{s:02}.{us:06}", if neg { "-" } else { "" }, d * 24 + h as u32)),
    }
}

async fn pg_discover(client: &tokio_postgres::Client, schemas: &[String]) -> Result<Vec<Table>, String> {
    let sch: Vec<String> = schemas.to_vec();
    let rows = client
        .query(
            "SELECT n.nspname::text, c.relname::text, c.relkind::text, c.reltuples::float8
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND n.nspname = ANY($1)
             ORDER BY 1, 2",
            &[&sch],
        )
        .await
        .map_err(|e| pg::fmt_err(&e))?;
    let mut tables: Vec<Table> = rows
        .iter()
        .map(|r| {
            let kind: String = r.get(2);
            let est: f64 = r.get(3);
            Table {
                schema: r.get(0),
                name: r.get(1),
                kind: match kind.as_str() {
                    "v" => "view",
                    "m" => "matview",
                    "f" => "foreign",
                    _ => "table",
                }
                .into(),
                estimated_rows: if est < 0.0 { None } else { Some(est as i64) },
                ..Default::default()
            }
        })
        .collect();
    let cols = client
        .query(
            "SELECT table_schema::text, table_name::text, column_name::text, ordinal_position::int4,
                    CASE WHEN data_type IN ('USER-DEFINED','ARRAY') THEN udt_name::text ELSE data_type::text END,
                    character_maximum_length::int8, numeric_precision::int8, numeric_scale::int8,
                    is_nullable = 'YES', column_default::text, (is_generated = 'ALWAYS' OR is_identity = 'YES' AND identity_generation = 'ALWAYS')
             FROM information_schema.columns WHERE table_schema = ANY($1) ORDER BY 1, 2, 4",
            &[&sch],
        )
        .await
        .map_err(|e| pg::fmt_err(&e))?;
    for r in &cols {
        let (s, t): (String, String) = (r.get(0), r.get(1));
        if let Some(tb) = tables.iter_mut().find(|x| x.schema == s && x.name == t) {
            let native: String = r.get(4);
            tb.columns.push(Column {
                name: r.get(2),
                position: r.get(3),
                ltype: Some(logical_type("postgres", &native)),
                native,
                length: r.get(5),
                precision: r.get(6),
                scale: r.get(7),
                nullable: r.get(8),
                default: r.get(9),
                generated: r.get::<_, Option<bool>>(10).unwrap_or(false),
            });
        }
    }
    let cons = client
        .query(
            "SELECT n.nspname::text, c.relname::text, con.conname::text, con.contype::text,
               array_to_string(ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o), chr(31)),
               coalesce(fn.nspname::text, ''), coalesce(fc.relname::text, ''),
               coalesce(array_to_string(ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o), chr(31)), '')
             FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_class fc ON fc.oid = con.confrelid LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
             WHERE con.contype IN ('p','u','f') AND n.nspname = ANY($1) ORDER BY 1, 2, 3",
            &[&sch],
        )
        .await
        .map_err(|e| pg::fmt_err(&e))?;
    let split = |s: String| if s.is_empty() { vec![] } else { s.split('\u{1f}').map(str::to_string).collect::<Vec<_>>() };
    for r in &cons {
        let (s, t): (String, String) = (r.get(0), r.get(1));
        if let Some(tb) = tables.iter_mut().find(|x| x.schema == s && x.name == t) {
            let k: String = r.get(3);
            tb.constraints.push(Constraint {
                name: r.get(2),
                kind: match k.as_str() {
                    "p" => "primary",
                    "u" => "unique",
                    _ => "foreign",
                }
                .into(),
                columns: split(r.get(4)),
                ref_schema: r.get(5),
                ref_table: r.get(6),
                ref_columns: split(r.get(7)),
            });
        }
    }
    let idx = client
        .query(
            "SELECT n.nspname::text, c.relname::text, ic.relname::text, i.indisunique, pg_get_indexdef(i.indexrelid)
             FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = ANY($1)",
            &[&sch],
        )
        .await
        .map_err(|e| pg::fmt_err(&e))?;
    for r in &idx {
        let (s, t): (String, String) = (r.get(0), r.get(1));
        if let Some(tb) = tables.iter_mut().find(|x| x.schema == s && x.name == t) {
            tb.indexes.push((r.get(2), r.get(3), vec![r.get(4)]));
        }
    }
    Ok(tables)
}

async fn my_discover(c: &mut mysql_async::Conn, schemas: &[String]) -> Result<Vec<Table>, String> {
    use mysql_async::prelude::*;
    if schemas.is_empty() {
        return Ok(vec![]);
    }
    let ph = vec!["?"; schemas.len()].join(",");
    let p: Vec<mysql_async::Value> = schemas.iter().map(|s| mysql_async::Value::from(s.as_str())).collect();
    let rows: Vec<(String, String, String, Option<i64>)> = c
        .exec(format!("SELECT CAST(TABLE_SCHEMA AS CHAR), CAST(TABLE_NAME AS CHAR), CAST(TABLE_TYPE AS CHAR), CAST(TABLE_ROWS AS SIGNED) FROM information_schema.TABLES WHERE TABLE_SCHEMA IN ({ph}) ORDER BY 1, 2"), p.clone())
        .await
        .map_err(|e| my::fmt_err(&e))?;
    let mut tables: Vec<Table> = rows
        .into_iter()
        .map(|(s, n, t, est)| Table { schema: s, name: n, kind: if t.contains("VIEW") { "view".into() } else { "table".into() }, estimated_rows: if t.contains("VIEW") { None } else { est }, ..Default::default() })
        .collect();
    let cols: Vec<mysql_async::Row> = c
        .exec(
            format!(
                "SELECT CAST(TABLE_SCHEMA AS CHAR), CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), CAST(ORDINAL_POSITION AS SIGNED), CAST(COLUMN_TYPE AS CHAR),
                        CAST(CHARACTER_MAXIMUM_LENGTH AS SIGNED), CAST(NUMERIC_PRECISION AS SIGNED), CAST(NUMERIC_SCALE AS SIGNED), CAST(IS_NULLABLE AS CHAR), CAST(COLUMN_DEFAULT AS CHAR), CAST(EXTRA AS CHAR)
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN ({ph}) ORDER BY 1, 2, 4"
            ),
            p.clone(),
        )
        .await
        .map_err(|e| my::fmt_err(&e))?;
    for r in cols {
        let g = |i: usize| r.get_opt::<Option<String>, _>(i).and_then(|x| x.ok()).flatten();
        let gi = |i: usize| r.get_opt::<Option<i64>, _>(i).and_then(|x| x.ok()).flatten();
        let (s, t) = (g(0).unwrap_or_default(), g(1).unwrap_or_default());
        if let Some(tb) = tables.iter_mut().find(|x| x.schema == s && x.name == t) {
            let native = g(4).unwrap_or_default();
            let extra = g(10).unwrap_or_default().to_lowercase();
            tb.columns.push(Column {
                name: g(2).unwrap_or_default(),
                position: gi(3).unwrap_or(0) as i32,
                ltype: Some(logical_type("mysql", &native)),
                native,
                length: gi(5),
                precision: gi(6),
                scale: gi(7),
                nullable: g(8).as_deref() == Some("YES"),
                default: g(9).filter(|d| d != "NULL"),
                generated: extra.contains("generated"),
            });
        }
    }
    let cons: Vec<mysql_async::Row> = c
        .exec(
            format!(
                "SELECT CAST(k.TABLE_SCHEMA AS CHAR), CAST(k.TABLE_NAME AS CHAR), CAST(k.CONSTRAINT_NAME AS CHAR), CAST(tc.CONSTRAINT_TYPE AS CHAR), CAST(k.COLUMN_NAME AS CHAR),
                        CAST(k.REFERENCED_TABLE_SCHEMA AS CHAR), CAST(k.REFERENCED_TABLE_NAME AS CHAR), CAST(k.REFERENCED_COLUMN_NAME AS CHAR)
                 FROM information_schema.KEY_COLUMN_USAGE k
                 JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND tc.TABLE_NAME = k.TABLE_NAME
                 WHERE k.TABLE_SCHEMA IN ({ph}) ORDER BY 1, 2, 3, k.ORDINAL_POSITION"
            ),
            p.clone(),
        )
        .await
        .map_err(|e| my::fmt_err(&e))?;
    for r in cons {
        let g = |i: usize| r.get_opt::<Option<String>, _>(i).and_then(|x| x.ok()).flatten().unwrap_or_default();
        let (s, t, name, kind) = (g(0), g(1), g(2), g(3));
        if let Some(tb) = tables.iter_mut().find(|x| x.schema == s && x.name == t) {
            let kind = match kind.as_str() {
                "PRIMARY KEY" => "primary",
                "UNIQUE" => "unique",
                _ => "foreign",
            };
            match tb.constraints.iter_mut().find(|x| x.name == name && x.kind == kind) {
                Some(x) => {
                    x.columns.push(g(4));
                    if kind == "foreign" {
                        x.ref_columns.push(g(7));
                    }
                }
                None => tb.constraints.push(Constraint { name, kind: kind.into(), columns: vec![g(4)], ref_schema: g(5), ref_table: g(6), ref_columns: if kind == "foreign" { vec![g(7)] } else { vec![] } }),
            }
        }
    }
    let idx: Vec<(String, String, String, i64, String)> = c
        .exec(format!("SELECT CAST(TABLE_SCHEMA AS CHAR), CAST(TABLE_NAME AS CHAR), CAST(INDEX_NAME AS CHAR), CAST(NON_UNIQUE AS SIGNED), CAST(COLUMN_NAME AS CHAR) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA IN ({ph}) ORDER BY 1, 2, 3, SEQ_IN_INDEX"), p)
        .await
        .map_err(|e| my::fmt_err(&e))?;
    for (s, t, n, nu, col) in idx {
        if let Some(tb) = tables.iter_mut().find(|x| x.schema == s && x.name == t) {
            match tb.indexes.iter_mut().find(|x| x.0 == n) {
                Some(x) => x.2.push(col),
                None => tb.indexes.push((n, nu == 0, vec![col])),
            }
        }
    }
    Ok(tables)
}

pub fn value_json(v: &Value) -> String {
    v.to_string()
}
