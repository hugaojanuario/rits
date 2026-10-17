//! Query export: writers (escaping, NULL, formats) and full streamed export against real
//! databases (`--ignored`, containers of audit_db.rs: PostgreSQL 55433, MySQL 33307).
use rits_lib::export::{export_to_path, Fmt, Writer};
use rits_lib::store::{ConnConfig, DbKind};

fn write(fmt: Fmt) -> String {
    let mut w = Writer::new(Vec::new(), fmt, vec!["id".into(), "nome, \"apelido\"".into()], "\"t\"", DbKind::Postgres).unwrap();
    w.row(&[Some("1".into()), Some("Ana <&> 'x'\nlinha".into())]).unwrap();
    w.row(&[Some("2".into()), None]).unwrap();
    String::from_utf8(w.finish().unwrap()).unwrap()
}

#[test]
fn formats_escape_and_keep_null() {
    let csv = write(Fmt::Csv);
    assert!(csv.starts_with('\u{feff}'));
    assert!(csv.contains("\"nome, \"\"apelido\"\"\""));
    assert!(csv.contains("1,\"Ana <&> 'x'\nlinha\""));
    assert!(csv.contains("\n2,\n"));
    let json: serde_json::Value = serde_json::from_str(&write(Fmt::Json)).unwrap();
    assert_eq!(json[1]["nome, \"apelido\""], serde_json::Value::Null);
    assert_eq!(json.as_array().unwrap().len(), 2);
    let jl = write(Fmt::Jsonl);
    assert_eq!(jl.lines().count(), 2);
    assert!(jl.lines().all(|l| serde_json::from_str::<serde_json::Value>(l).is_ok()));
    let xml = write(Fmt::Xml);
    assert!(xml.contains("Ana &lt;&amp;&gt; &apos;x&apos;"));
    assert!(xml.contains("nulo=\"true\""));
    let sql = write(Fmt::Sql);
    assert!(sql.contains("INSERT INTO \"t\" (\"id\", \"nome, \"\"apelido\"\"\") VALUES ('1', 'Ana <&> ''x''"));
    assert!(sql.contains("VALUES ('2', NULL);"));
    let tsv = write(Fmt::Tsv);
    assert!(tsv.contains("Ana <&> 'x' linha"));
    let empty = Writer::new(Vec::new(), Fmt::Json, vec!["a".into()], "t", DbKind::Postgres).unwrap().finish().unwrap();
    assert_eq!(String::from_utf8(empty).unwrap(), "[]\n");
}

fn cfg(kind: DbKind, port: u16, user: &str, db: &str) -> ConnConfig {
    ConnConfig { id: "x".into(), name: "x".into(), kind, host: "127.0.0.1".into(), port, user: user.into(), password: "bgtest".into(), database: db.into(), ssl: false, tools_dir: String::new(), color: String::new(), read_only: false, project: String::new() }
}

async fn full(c: ConnConfig, sql: &str, rows: u64) {
    let dir = std::env::temp_dir().join(format!("rits-export-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join(format!("{:?}.jsonl", c.kind));
    let n = export_to_path(c.clone(), String::new(), sql.into(), Fmt::Jsonl, "t".into(), p.clone(), |_| {}).await.unwrap();
    assert_eq!(n, rows);
    let text = std::fs::read_to_string(&p).unwrap();
    assert_eq!(text.lines().count() as u64, rows);
    let first: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert!(first.get("n").is_some() && first.get("nome").is_some(), "{first}");
    // a statement that writes is refused by the read-only transaction; no file is left behind
    let bad = dir.join("bad.csv");
    let write = if c.kind == DbKind::Postgres { "CREATE TABLE rits_export_should_fail (a int)" } else { "CREATE TABLE IF NOT EXISTS mysql.rits_export_should_fail (a int)" };
    assert!(export_to_path(c, String::new(), write.into(), Fmt::Csv, "t".into(), bad.clone(), |_| {}).await.is_err());
    assert!(!bad.exists());
}

#[tokio::test]
#[ignore]
async fn postgres_full_export_beyond_grid_limit() {
    full(cfg(DbKind::Postgres, 55433, "postgres", "postgres"), "SELECT g AS n, 'nome ' || g AS nome, now() AS quando FROM generate_series(1, 120000) g", 120_000).await;
}

#[tokio::test]
#[ignore]
async fn mysql_full_export() {
    full(cfg(DbKind::Mysql, 33307, "root", ""), "WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 900) SELECT n, CONCAT('nome ', n) AS nome, CAST(n * 1.5 AS DECIMAL(10,2)) AS v FROM s", 900).await;
}
