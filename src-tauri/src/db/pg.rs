use super::{err_chain, ColumnInfo, CompletionTable, DbObject, DiagramInfo, DiagramTable, ForeignKey, IndexInfo, QueryResult, ServerInfo};
use crate::store::ConnConfig;
use std::time::{Duration, Instant};
use tokio_postgres::{Client, NoTls, SimpleQueryMessage};

pub struct PgConn {
    pub client: Client,
}

fn tls() -> Result<postgres_native_tls::MakeTlsConnector, String> {
    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(postgres_native_tls::MakeTlsConnector::new(connector))
}

pub fn fmt_err(e: &tokio_postgres::Error) -> String {
    if let Some(db) = e.as_db_error() {
        let mut s = format!("{}: {}", db.severity(), db.message());
        if let Some(d) = db.detail() {
            s.push_str(&format!("\nDetalhe: {d}"));
        }
        if let Some(h) = db.hint() {
            s.push_str(&format!("\nDica: {h}"));
        }
        if let Some(tokio_postgres::error::ErrorPosition::Original(p)) = db.position() {
            s.push_str(&format!("\nPosição: {p}"));
        }
        return s;
    }
    err_chain(e)
}

impl PgConn {
    pub async fn open(cfg: &ConnConfig, db: &str) -> Result<PgConn, String> {
        let mut pc = tokio_postgres::Config::new();
        pc.host(&cfg.host)
            .port(cfg.port)
            .user(&cfg.user)
            .dbname(db)
            .application_name("Rits")
            .connect_timeout(Duration::from_secs(10));
        if !cfg.password.is_empty() {
            pc.password(&cfg.password);
        }
        let client = if cfg.ssl {
            pc.ssl_mode(tokio_postgres::config::SslMode::Require);
            let (client, conn) = pc.connect(tls()?).await.map_err(|e| fmt_err(&e))?;
            tokio::spawn(conn);
            client
        } else {
            pc.ssl_mode(tokio_postgres::config::SslMode::Disable);
            let (client, conn) = pc.connect(NoTls).await.map_err(|e| fmt_err(&e))?;
            tokio::spawn(conn);
            client
        };
        if cfg.read_only {
            client
                .batch_execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
                .await
                .map_err(|e| fmt_err(&e))?;
        }
        Ok(PgConn { client })
    }

    pub async fn execute(&self, sql: &str, max_rows: usize) -> Result<Vec<QueryResult>, String> {
        let start = Instant::now();
        let msgs = self.client.simple_query(sql).await.map_err(|e| fmt_err(&e))?;
        let elapsed = start.elapsed().as_millis() as u64;
        let mut out = Vec::new();
        let mut cur: Option<QueryResult> = None;
        for m in msgs {
            match m {
                SimpleQueryMessage::RowDescription(cols) => {
                    cur = Some(QueryResult {
                        columns: cols.iter().map(|c| c.name().to_string()).collect(),
                        has_rows: true,
                        ..Default::default()
                    });
                }
                SimpleQueryMessage::Row(row) => {
                    let r = cur.get_or_insert_with(|| QueryResult {
                        columns: row.columns().iter().map(|c| c.name().to_string()).collect(),
                        has_rows: true,
                        ..Default::default()
                    });
                    if r.rows.len() >= max_rows {
                        r.truncated = true;
                        continue;
                    }
                    r.rows.push((0..row.len()).map(|i| row.get(i).map(str::to_string)).collect());
                }
                SimpleQueryMessage::CommandComplete(n) => {
                    let mut r = cur.take().unwrap_or_default();
                    if !r.has_rows {
                        r.affected = Some(n);
                    }
                    r.elapsed_ms = elapsed;
                    out.push(r);
                }
                _ => {}
            }
        }
        if let Some(mut r) = cur.take() {
            r.elapsed_ms = elapsed;
            out.push(r);
        }
        Ok(out)
    }

    async fn rows(&self, sql: &str, params: &[&str]) -> Result<Vec<tokio_postgres::Row>, String> {
        let p: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
            params.iter().map(|s| s as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
        self.client.query(sql, &p).await.map_err(|e| fmt_err(&e))
    }

    pub async fn server_info(&self) -> Result<ServerInfo, String> {
        let r = self.rows("SELECT version()::text, current_user::text", &[]).await?;
        Ok(ServerInfo { version: r[0].get(0), current_user: r[0].get(1) })
    }

    pub async fn databases(&self) -> Result<Vec<String>, String> {
        let r = self
            .rows("SELECT datname::text FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY 1", &[])
            .await?;
        Ok(r.iter().map(|x| x.get(0)).collect())
    }

    pub async fn schemas(&self) -> Result<Vec<String>, String> {
        let r = self
            .rows(
                "SELECT nspname::text FROM pg_namespace
                 WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%'
                 ORDER BY nspname IN ('pg_catalog','information_schema'), nspname <> 'public', nspname",
                &[],
            )
            .await?;
        Ok(r.iter().map(|x| x.get(0)).collect())
    }

    pub async fn objects(&self, schema: &str) -> Result<Vec<DbObject>, String> {
        let r = self
            .rows(
                "SELECT c.relname::text,
                        CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' WHEN 'S' THEN 'sequence' ELSE 'table' END,
                        obj_description(c.oid, 'pg_class')
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','S','f') AND NOT c.relispartition
                 UNION ALL
                 SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
                        CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
                        obj_description(p.oid, 'pg_proc')
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = $1 AND p.prokind IN ('f','p')
                 UNION ALL
                 SELECT DISTINCT t.tgname::text || ' ON ' || c.relname::text, 'trigger', NULL
                 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND NOT t.tgisinternal
                 ORDER BY 2, 1",
                &[schema],
            )
            .await?;
        Ok(r.iter()
            .map(|x| DbObject { name: x.get(0), kind: x.get(1), comment: x.get(2) })
            .collect())
    }

    pub async fn columns(&self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
        let r = self
            .rows(
                "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                        pg_get_expr(d.adbin, d.adrelid),
                        EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)),
                        col_description(a.attrelid, a.attnum)
                 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE a.attrelid = format('%I.%I', $1::text, $2::text)::regclass AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY a.attnum",
                &[schema, table],
            )
            .await?;
        Ok(r.iter()
            .map(|x| ColumnInfo {
                name: x.get(0),
                data_type: x.get(1),
                nullable: x.get(2),
                default: x.get(3),
                pk: x.get(4),
                comment: x.get(5),
            })
            .collect())
    }

    pub async fn diagram(&self, schema: &str) -> Result<DiagramInfo, String> {
        let cols = self
            .rows(
                "SELECT cl.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                        EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = cl.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)),
                        CASE cl.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' ELSE 'table' END,
                        col_description(cl.oid, a.attnum)
                 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
                 JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum > 0 AND NOT a.attisdropped
                 WHERE n.nspname = $1 AND cl.relkind IN ('r','p','v','m','f') AND NOT cl.relispartition
                 ORDER BY cl.relname, a.attnum",
                &[schema],
            )
            .await?;
        let mut tables: Vec<DiagramTable> = vec![];
        for x in &cols {
            let t: String = x.get(0);
            if tables.last().map(|l| l.name != t).unwrap_or(true) {
                tables.push(DiagramTable { name: t.clone(), kind: x.get(5), columns: vec![] });
            }
            tables.last_mut().unwrap().columns.push(ColumnInfo {
                name: x.get(1),
                data_type: x.get(2),
                nullable: x.get(3),
                default: None,
                pk: x.get(4),
                comment: x.get(6),
            });
        }
        let fks = self
            .rows(
                "SELECT con.conname::text, cl.relname::text, rn.nspname::text, rcl.relname::text,
                        ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
                              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o),
                        ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
                              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o)
                 FROM pg_constraint con
                 JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
                 JOIN pg_class rcl ON rcl.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rcl.relnamespace
                 WHERE con.contype = 'f' AND n.nspname = $1 ORDER BY 2, 1",
                &[schema],
            )
            .await?;
        let fks = fks
            .iter()
            .map(|x| ForeignKey { name: x.get(0), table: x.get(1), ref_schema: x.get(2), ref_table: x.get(3), columns: x.get(4), ref_columns: x.get(5) })
            .collect();
        Ok(DiagramInfo { tables, fks })
    }

    pub async fn indexes(&self, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
        let r = self
            .rows(
                "SELECT i.relname::text,
                        array_to_string(ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true)
                                              FROM generate_subscripts(ix.indkey, 1) k ORDER BY k), ', '),
                        ix.indisunique, ix.indisprimary
                 FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
                 WHERE ix.indrelid = format('%I.%I', $1::text, $2::text)::regclass
                 ORDER BY ix.indisprimary DESC, 1",
                &[schema, table],
            )
            .await?;
        Ok(r.iter()
            .map(|x| IndexInfo { name: x.get(0), columns: x.get(1), unique: x.get(2), primary: x.get(3) })
            .collect())
    }

    pub async fn completion(&self) -> Result<Vec<CompletionTable>, String> {
        let r = self
            .rows(
                "SELECT n.nspname::text, c.relname::text,
                        ARRAY(SELECT a.attname::text FROM pg_attribute a
                              WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum)
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema')
                   AND n.nspname NOT LIKE 'pg\\_toast%' LIMIT 5000",
                &[],
            )
            .await?;
        Ok(r.iter()
            .map(|x| CompletionTable { schema: x.get(0), table: x.get(1), columns: x.get(2) })
            .collect())
    }

    pub async fn ddl(&self, schema: &str, name: &str, kind: &str) -> Result<String, String> {
        let one = |rows: Vec<tokio_postgres::Row>| -> String {
            rows.first().and_then(|r| r.get::<_, Option<String>>(0)).unwrap_or_default()
        };
        match kind {
            "view" => {
                let body = one(self
                    .rows("SELECT pg_get_viewdef(format('%I.%I', $1::text, $2::text)::regclass, true)", &[schema, name])
                    .await?);
                Ok(format!("CREATE OR REPLACE VIEW {}.{} AS\n{}", qi(schema), qi(name), body))
            }
            "matview" => {
                let body = one(self
                    .rows("SELECT pg_get_viewdef(format('%I.%I', $1::text, $2::text)::regclass, true)", &[schema, name])
                    .await?);
                Ok(format!("CREATE MATERIALIZED VIEW {}.{} AS\n{}", qi(schema), qi(name), body))
            }
            "function" | "procedure" => {
                // `name` is "proname(identity args)", exactly as listed by objects().
                Ok(one(self
                    .rows(
                        "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                         WHERE n.nspname = $1 AND p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = $2",
                        &[schema, name],
                    )
                    .await?))
            }
            "trigger" => {
                let (tname, table) = name.split_once(" ON ").unwrap_or((name, ""));
                Ok(one(self
                    .rows(
                        "SELECT pg_get_triggerdef(t.oid, true) || ';' FROM pg_trigger t
                         WHERE t.tgname = $1 AND t.tgrelid = format('%I.%I', $2::text, $3::text)::regclass",
                        &[tname, schema, table],
                    )
                    .await?))
            }
            "sequence" => {
                let r = self
                    .rows(
                        "SELECT format('CREATE SEQUENCE %I.%I\n    AS %s\n    INCREMENT BY %s\n    MINVALUE %s\n    MAXVALUE %s\n    START WITH %s\n    CACHE %s%s;',
                                schemaname, sequencename, data_type, increment_by, min_value, max_value, start_value, cache_size,
                                CASE WHEN cycle THEN '\n    CYCLE' ELSE '' END)
                         FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2",
                        &[schema, name],
                    )
                    .await?;
                Ok(one(r))
            }
            _ => self.table_ddl(schema, name).await,
        }
    }

    async fn table_ddl(&self, schema: &str, table: &str) -> Result<String, String> {
        let cols = self.columns(schema, table).await?;
        let mut lines: Vec<String> = cols
            .iter()
            .map(|c| {
                let mut l = format!("    {} {}", qi(&c.name), c.data_type);
                if let Some(d) = &c.default {
                    l.push_str(&format!(" DEFAULT {d}"));
                }
                if !c.nullable {
                    l.push_str(" NOT NULL");
                }
                l
            })
            .collect();
        let cons = self
            .rows(
                "SELECT conname::text, pg_get_constraintdef(oid, true) FROM pg_constraint
                 WHERE conrelid = format('%I.%I', $1::text, $2::text)::regclass AND contype <> 'n'
                 ORDER BY contype = 'p' DESC, contype, conname",
                &[schema, table],
            )
            .await?;
        for c in &cons {
            let n: String = c.get(0);
            let d: String = c.get(1);
            lines.push(format!("    CONSTRAINT {} {}", qi(&n), d));
        }
        let mut ddl = format!("CREATE TABLE {}.{} (\n{}\n);\n", qi(schema), qi(table), lines.join(",\n"));
        let idx = self
            .rows(
                "SELECT pg_get_indexdef(ix.indexrelid) || ';' FROM pg_index ix
                 WHERE ix.indrelid = format('%I.%I', $1::text, $2::text)::regclass
                   AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid)",
                &[schema, table],
            )
            .await?;
        for i in &idx {
            ddl.push('\n');
            ddl.push_str(&i.get::<_, String>(0));
        }
        let tcomment = self
            .rows("SELECT obj_description(format('%I.%I', $1::text, $2::text)::regclass, 'pg_class')", &[schema, table])
            .await?;
        if let Some(Some(c)) = tcomment.first().map(|r| r.get::<_, Option<String>>(0)) {
            ddl.push_str(&format!("\n\nCOMMENT ON TABLE {}.{} IS {};", qi(schema), qi(table), ql(&c)));
        }
        for c in cols.iter().filter(|c| c.comment.is_some()) {
            ddl.push_str(&format!(
                "\nCOMMENT ON COLUMN {}.{}.{} IS {};",
                qi(schema),
                qi(table),
                qi(&c.name),
                ql(c.comment.as_deref().unwrap_or(""))
            ));
        }
        Ok(ddl)
    }
}

pub async fn cancel(token: tokio_postgres::CancelToken, ssl: bool) -> Result<(), String> {
    if ssl {
        token.cancel_query(tls()?).await.map_err(|e| fmt_err(&e))
    } else {
        token.cancel_query(NoTls).await.map_err(|e| fmt_err(&e))
    }
}

/// Quote identifier.
pub fn qi(s: &str) -> String {
    let simple = !s.is_empty()
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && !s.chars().next().unwrap().is_ascii_digit();
    if simple {
        s.to_string()
    } else {
        format!("\"{}\"", s.replace('"', "\"\""))
    }
}

/// Quote literal.
pub fn ql(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
