//! Full export of a query result to a file, streamed (no row limit and no grid in memory).
//! The query runs again in a read-only transaction; values use each database's text form, like
//! the console. Formats: CSV, TSV, JSON, JSON Lines, XML and SQL INSERT.

use crate::db::{ext::ExtConn, my, pg};
use crate::store::{self, ConnConfig, DbKind};
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Fmt {
    Csv,
    Tsv,
    Json,
    Jsonl,
    Xml,
    Sql,
}

impl Fmt {
    pub fn parse(s: &str) -> Result<Fmt, String> {
        Ok(match s {
            "csv" => Fmt::Csv,
            "tsv" => Fmt::Tsv,
            "json" => Fmt::Json,
            "jsonl" => Fmt::Jsonl,
            "xml" => Fmt::Xml,
            "sql" => Fmt::Sql,
            o => return Err(format!("Formato de exportação não suportado: {o}")),
        })
    }
}

fn csv_cell(v: &str, sep: char) -> String {
    if v.contains(sep) || v.contains('"') || v.contains('\n') || v.contains('\r') {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

fn xml_text(v: &str) -> String {
    let mut o = String::with_capacity(v.len());
    for c in v.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            // characters XML 1.0 does not allow
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => o.push('\u{FFFD}'),
            c => o.push(c),
        }
    }
    o
}

pub fn quote_ident(kind: &DbKind, s: &str) -> String {
    match kind {
        DbKind::Mysql | DbKind::Clickhouse => format!("`{}`", s.replace('`', "``")),
        DbKind::Sqlserver => format!("[{}]", s.replace(']', "]]")),
        _ => format!("\"{}\"", s.replace('"', "\"\"")),
    }
}

/// Streaming writer of one result set.
pub struct Writer<W: Write> {
    w: W,
    fmt: Fmt,
    cols: Vec<String>,
    pub rows: u64,
    table: String,
    kind: DbKind,
}

impl<W: Write> Writer<W> {
    pub fn new(w: W, fmt: Fmt, cols: Vec<String>, table: &str, kind: DbKind) -> std::io::Result<Self> {
        let mut x = Writer { w, fmt, cols, rows: 0, table: table.to_string(), kind };
        match fmt {
            Fmt::Csv => {
                // BOM so spreadsheet apps read UTF-8 accents correctly
                x.w.write_all("\u{feff}".as_bytes())?;
                let line = x.cols.iter().map(|c| csv_cell(c, ',')).collect::<Vec<_>>().join(",");
                writeln!(x.w, "{line}")?;
            }
            Fmt::Tsv => writeln!(x.w, "{}", x.cols.iter().map(|c| c.replace(['\t', '\n'], " ")).collect::<Vec<_>>().join("\t"))?,
            Fmt::Json => x.w.write_all(b"[")?,
            Fmt::Xml => x.w.write_all(b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<resultado>\n")?,
            Fmt::Jsonl | Fmt::Sql => {}
        }
        Ok(x)
    }

    pub fn row(&mut self, vals: &[Option<String>]) -> std::io::Result<()> {
        let first = self.rows == 0;
        self.rows += 1;
        match self.fmt {
            Fmt::Csv => {
                let line = vals.iter().map(|v| v.as_deref().map(|s| csv_cell(s, ',')).unwrap_or_default()).collect::<Vec<_>>().join(",");
                writeln!(self.w, "{line}")
            }
            Fmt::Tsv => writeln!(self.w, "{}", vals.iter().map(|v| v.as_deref().unwrap_or("").replace(['\t', '\n', '\r'], " ")).collect::<Vec<_>>().join("\t")),
            Fmt::Json | Fmt::Jsonl => {
                let mut m = serde_json::Map::new();
                for (c, v) in self.cols.iter().zip(vals) {
                    m.insert(c.clone(), v.clone().map(serde_json::Value::String).unwrap_or(serde_json::Value::Null));
                }
                let obj = serde_json::Value::Object(m).to_string();
                if self.fmt == Fmt::Json {
                    write!(self.w, "{}\n  {obj}", if first { "" } else { "," })
                } else {
                    writeln!(self.w, "{obj}")
                }
            }
            Fmt::Xml => {
                self.w.write_all(b"  <linha>\n")?;
                for (c, v) in self.cols.iter().zip(vals) {
                    match v {
                        Some(s) => writeln!(self.w, "    <campo nome=\"{}\">{}</campo>", xml_text(c), xml_text(s))?,
                        None => writeln!(self.w, "    <campo nome=\"{}\" nulo=\"true\"/>", xml_text(c))?,
                    }
                }
                self.w.write_all(b"  </linha>\n")
            }
            Fmt::Sql => {
                let cols = self.cols.iter().map(|c| quote_ident(&self.kind, c)).collect::<Vec<_>>().join(", ");
                let vals = vals.iter().map(|v| v.as_deref().map(|s| format!("'{}'", s.replace('\'', "''"))).unwrap_or_else(|| "NULL".into())).collect::<Vec<_>>().join(", ");
                writeln!(self.w, "INSERT INTO {} ({cols}) VALUES ({vals});", self.table)
            }
        }
    }

    pub fn finish(mut self) -> std::io::Result<W> {
        match self.fmt {
            Fmt::Json => self.w.write_all(if self.rows == 0 { b"]\n" } else { b"\n]\n" })?,
            Fmt::Xml => self.w.write_all(b"</resultado>\n")?,
            _ => {}
        }
        self.w.flush()?;
        Ok(self.w)
    }
}

#[derive(Default)]
pub struct ExportState {
    jobs: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

#[derive(Serialize, Clone)]
struct ExportProgress {
    id: String,
    rows: u64,
}

type RowSink<'a> = dyn FnMut(Option<Vec<String>>, Vec<Option<String>>) -> Result<(), String> + Send + 'a;

/// Runs the query read-only and calls `sink(Some(columns), [])` once, then `sink(None, row)`.
async fn stream_query(cfg: &ConnConfig, db: &str, sql: &str, sink: &mut RowSink<'_>) -> Result<(), String> {
    let db = if db.is_empty() { cfg.default_db() } else { db.to_string() };
    match cfg.kind {
        DbKind::Postgres => {
            let c = pg::PgConn::open(cfg, &db).await?;
            c.client.batch_execute("BEGIN READ ONLY").await.map_err(|e| pg::fmt_err(&e))?;
            let st = c.client.simple_query_raw(sql).await.map_err(|e| pg::fmt_err(&e))?;
            futures_util::pin_mut!(st);
            let mut sent = false;
            while let Some(m) = st.next().await {
                match m.map_err(|e| pg::fmt_err(&e))? {
                    tokio_postgres::SimpleQueryMessage::RowDescription(cols) if !sent => {
                        sent = true;
                        sink(Some(cols.iter().map(|c| c.name().to_string()).collect()), vec![])?;
                    }
                    tokio_postgres::SimpleQueryMessage::Row(r) => {
                        if !sent {
                            sent = true;
                            sink(Some(r.columns().iter().map(|c| c.name().to_string()).collect()), vec![])?;
                        }
                        sink(None, (0..r.len()).map(|i| r.get(i).map(str::to_string)).collect())?;
                    }
                    _ => {}
                }
            }
            if !sent {
                return Err("A consulta não retornou um conjunto de resultados.".into());
            }
            let _ = c.client.batch_execute("ROLLBACK").await;
            Ok(())
        }
        DbKind::Mysql => {
            use mysql_async::prelude::*;
            let mut c = mysql_async::Conn::new(my::opts(cfg, &db)).await.map_err(|e| my::fmt_err(&e))?;
            c.query_drop("START TRANSACTION READ ONLY").await.map_err(|e| my::fmt_err(&e))?;
            {
                let mut res = c.query_iter(sql).await.map_err(|e| my::fmt_err(&e))?;
                let cols: Vec<String> = res.columns_ref().iter().map(|c| c.name_str().into_owned()).collect();
                if cols.is_empty() {
                    return Err("A consulta não retornou um conjunto de resultados.".into());
                }
                let binary: Vec<bool> = res.columns_ref().iter().map(|c| c.character_set() == 63 && !matches!(c.column_type(), mysql_async::consts::ColumnType::MYSQL_TYPE_NEWDECIMAL | mysql_async::consts::ColumnType::MYSQL_TYPE_DECIMAL)).collect();
                sink(Some(cols), vec![])?;
                let mut stream = res.stream::<mysql_async::Row>().await.map_err(|e| my::fmt_err(&e))?;
                if let Some(s) = stream.as_mut() {
                    while let Some(row) = s.next().await {
                        let row = row.map_err(|e| my::fmt_err(&e))?;
                        let vals = row
                            .unwrap()
                            .into_iter()
                            .enumerate()
                            .map(|(i, v)| match v {
                                mysql_async::Value::Bytes(b) if binary.get(i).copied().unwrap_or(false) && String::from_utf8(b.clone()).is_err() => Some(format!("0x{}", b.iter().map(|x| format!("{x:02X}")).collect::<String>())),
                                other => crate::audit::adapter::my_text(other, (false, false)),
                            })
                            .collect();
                        sink(None, vals)?;
                    }
                }
            }
            let _ = c.query_drop("ROLLBACK").await;
            let _ = c.disconnect().await;
            Ok(())
        }
        _ => {
            let mut c = ExtConn::open(cfg, &db).await?;
            let _ = c.call_json("audit_begin", serde_json::json!({ "consistency": "snapshot" })).await;
            let probe = format!("SELECT * FROM ({}) rits_q WHERE 1 = 0", crate::audit::adapter::single_statement(sql)?);
            let cols: Vec<(String, String)> = serde_json::from_value(c.call_json("audit_describe", serde_json::json!({ "sql": probe })).await?).map_err(|e| e.to_string())?;
            sink(Some(cols.into_iter().map(|c| c.0).collect()), vec![])?;
            let mut f = |row: Vec<Option<String>>| sink(None, row);
            c.stream(sql, &[], 2000, &mut f).await?;
            let _ = c.call_json("audit_end", serde_json::json!({})).await;
            Ok(())
        }
    }
}

/// Streams the full result of `sql` into `path` (atomic: a temporary file renamed at the end).
pub async fn export_to_path(cfg: ConnConfig, db: String, sql: String, fmt: Fmt, table: String, target: PathBuf, mut progress: impl FnMut(u64) + Send) -> Result<u64, String> {
    let tmp = target.with_extension("rits-export.tmp");
    let r = async {
        let file = BufWriter::with_capacity(1 << 16, File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?);
        let mut writer: Option<Writer<BufWriter<File>>> = None;
        let mut pending = Some(file);
        let mut last = std::time::Instant::now();
        let kind = cfg.kind.clone();
        let tbl = if table.trim().is_empty() { "resultado".to_string() } else { table };
        {
            let mut sink = |cols: Option<Vec<String>>, row: Vec<Option<String>>| -> Result<(), String> {
                if let Some(cols) = cols {
                    writer = Some(Writer::new(pending.take().ok_or("arquivo")?, fmt, cols, &tbl, kind.clone()).map_err(|e| e.to_string())?);
                    return Ok(());
                }
                let w = writer.as_mut().ok_or("cabeçalho ausente")?;
                w.row(&row).map_err(|e| e.to_string())?;
                if last.elapsed().as_millis() > 500 {
                    last = std::time::Instant::now();
                    progress(w.rows);
                }
                Ok(())
            };
            stream_query(&cfg, &db, &sql, &mut sink).await?;
        }
        let w = writer.ok_or("A consulta não retornou um conjunto de resultados.")?;
        let n = w.rows;
        w.finish().map_err(|e| e.to_string())?;
        Ok::<u64, String>(n)
    }
    .await;
    match r {
        Ok(n) => {
            std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
            Ok(n)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Exports the full result of `sql` to `path`. Returns the number of rows.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_query(app: AppHandle, st: State<'_, ExportState>, request_id: String, conn_id: String, db: String, sql: String, format: String, path: String, table: String) -> Result<u64, String> {
    let cfg = store::get(&app, &conn_id)?;
    let fmt = Fmt::parse(&format)?;
    let target = PathBuf::from(&path);
    if !target.is_absolute() {
        return Err("Escolha onde salvar o arquivo.".into());
    }
    let a = app.clone();
    let id = request_id.clone();
    let task = tokio::spawn(export_to_path(cfg, db, sql, fmt, table, target.clone(), move |rows| {
        let _ = a.emit("export-progress", ExportProgress { id: id.clone(), rows });
    }));
    st.jobs.lock().await.insert(request_id.clone(), task.abort_handle());
    let r = task.await;
    st.jobs.lock().await.remove(&request_id);
    match r {
        Ok(v) => v,
        Err(e) if e.is_cancelled() => {
            let _ = std::fs::remove_file(target.with_extension("rits-export.tmp"));
            Err("Exportação cancelada.".into())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn export_cancel(st: State<'_, ExportState>, request_id: String) -> Result<(), String> {
    if let Some(h) = st.jobs.lock().await.remove(&request_id) {
        h.abort();
    }
    Ok(())
}

/// Writes binary content (base64) chosen by the user, e.g. an .xlsx export of the grid.
#[tauri::command]
pub fn write_base64_file(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    let p = Path::new(&path);
    let tmp = p.with_extension("rits-export.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("{path}: {e}"))?;
    std::fs::rename(&tmp, p).map_err(|e| format!("{path}: {e}"))
}
