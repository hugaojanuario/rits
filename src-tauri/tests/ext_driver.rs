//! On-demand drivers (db::ext): creates the drivers venv in a temp folder and talks to
//! rits_driver.py through ExtConn. Needs Python 3.9+; SQLite needs no download.
use rits_lib::db::ext::{ensure_driver, set_dir, ExtConn};
use rits_lib::store::{ConnConfig, DbKind};

#[tokio::test]
#[ignore]
async fn sqlite_via_driver_process() {
    let dir = std::env::temp_dir().join(format!("rits-ext-test-{}", std::process::id()));
    set_dir(dir.join("drivers"));
    let file = dir.join("t.db");
    std::fs::create_dir_all(&dir).unwrap();
    let cfg = ConnConfig {
        id: "t".into(), name: "t".into(), kind: DbKind::Sqlite, host: String::new(), port: 0, user: String::new(),
        password: String::new(), database: file.to_string_lossy().into(), ssl: false, tools_dir: String::new(),
        color: String::new(), read_only: false, project: String::new(),
    };
    ensure_driver(&cfg.kind).await.expect("venv");
    let mut c = ExtConn::open(&cfg, "main").await.expect("open");
    c.execute("CREATE TABLE autor(id INTEGER PRIMARY KEY, nome TEXT NOT NULL)").await.unwrap();
    c.execute("CREATE TABLE livro(id INTEGER PRIMARY KEY, autor_id INTEGER REFERENCES autor(id), titulo TEXT)").await.unwrap();
    c.execute("INSERT INTO autor(nome) VALUES ('Clarice Lispector')").await.unwrap();
    let r = c.execute("SELECT nome FROM autor").await.unwrap();
    assert_eq!(r[0].rows[0][0].as_deref(), Some("Clarice Lispector"));
    assert!(c.server_info().await.unwrap().version.starts_with("SQLite"));
    let d = c.diagram("main").await.unwrap();
    assert_eq!(d.tables.len(), 2);
    assert_eq!(d.fks.len(), 1);
    assert_eq!(d.fks[0].ref_table, "autor");
    assert!(c.execute("SELEC 1").await.is_err());
    // the session survives an error
    assert_eq!(c.databases().await.unwrap(), vec!["main".to_string()]);
    let _ = std::fs::remove_dir_all(&dir);
}
