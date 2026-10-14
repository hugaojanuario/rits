//! Runs against the docker test databases (rits-pg on 55432, rits-my on 33306).
//! cargo test -- --ignored --nocapture
use rits_lib::db::Session;
use rits_lib::store::{ConnConfig, DbKind};

fn cfg(kind: DbKind) -> ConnConfig {
    let pg = kind == DbKind::Postgres;
    ConnConfig {
        id: "t".into(),
        name: "t".into(),
        kind,
        host: "127.0.0.1".into(),
        port: if pg { 55432 } else { 33306 },
        user: if pg { "postgres".into() } else { "root".into() },
        password: "bgtest".into(),
        database: "loja".into(),
        ssl: false,
        tools_dir: String::new(),
        color: String::new(),
        read_only: false,
    }
}

#[tokio::test]
#[ignore]
async fn postgres_roundtrip() {
    let c = cfg(DbKind::Postgres);
    let Session::Pg(s) = Session::open(&c, "loja").await.unwrap() else { panic!() };
    println!("{:?}", s.server_info().await.unwrap().version);
    let dbs = s.databases().await.unwrap();
    assert!(dbs.contains(&"loja".to_string()));
    let schemas = s.schemas().await.unwrap();
    assert_eq!(schemas[0], "public");
    let objs = s.objects("vendas").await.unwrap();
    let kinds: Vec<_> = objs.iter().map(|o| format!("{}:{}", o.kind, o.name)).collect();
    println!("{kinds:?}");
    assert!(kinds.contains(&"table:clientes".into()) && kinds.contains(&"view:resumo".into()));
    assert!(kinds.iter().any(|k| k.starts_with("function:total_cliente(")));
    let cols = s.columns("vendas", "clientes").await.unwrap();
    assert!(cols[0].pk && cols[0].name == "id");
    let idx = s.indexes("vendas", "pedidos").await.unwrap();
    assert!(idx.iter().any(|i| i.primary));
    for (n, k) in [("clientes", "table"), ("resumo", "view")] {
        let d = s.ddl("vendas", n, k).await.unwrap();
        println!("--- {n}\n{d}");
        assert!(d.contains(n));
    }
    let f = objs.iter().find(|o| o.kind == "function").unwrap();
    assert!(s.ddl("vendas", &f.name, "function").await.unwrap().contains("CREATE OR REPLACE FUNCTION"));
    let comp = s.completion().await.unwrap();
    assert!(comp.iter().any(|t| t.table == "pedidos" && t.columns.contains(&"total".into())));
    // multi statement, mixed results
    let r = s.execute("SELECT 1 AS a, NULL AS b; UPDATE vendas.pedidos SET status = status WHERE id < 4; SELECT count(*) FROM vendas.clientes").await.unwrap();
    assert_eq!(r.len(), 3);
    assert_eq!(r[0].rows[0], vec![Some("1".into()), None]);
    assert_eq!(r[1].affected, Some(3));
    assert_eq!(r[2].rows[0][0].as_deref(), Some("1500"));
    // empty result keeps columns
    let r = s.execute("SELECT id, nome FROM vendas.clientes WHERE false").await.unwrap();
    assert_eq!(r[0].columns, vec!["id", "nome"]);
    assert!(r[0].has_rows);
    // error formatting
    let e = s.execute("SELECT * FROM nao_existe").await.unwrap_err();
    println!("err: {e}");
    assert!(e.contains("nao_existe"));
}

#[tokio::test]
#[ignore]
async fn mysql_roundtrip() {
    let c = cfg(DbKind::Mysql);
    let Session::My(s) = Session::open(&c, "loja").await.unwrap() else { panic!() };
    println!("{:?}", s.server_info().await.unwrap().version);
    assert!(s.databases().await.unwrap().contains(&"loja".to_string()));
    let objs = s.objects("loja").await.unwrap();
    let kinds: Vec<_> = objs.iter().map(|o| format!("{}:{}", o.kind, o.name)).collect();
    println!("{kinds:?}");
    assert!(kinds.contains(&"table:produtos".into()) && kinds.contains(&"view:caros".into()) && kinds.contains(&"procedure:reajuste".into()));
    let cols = s.columns("loja", "produtos").await.unwrap();
    assert!(cols[0].pk);
    assert!(s.ddl("loja", "produtos", "table").await.unwrap().starts_with("CREATE TABLE"));
    assert!(s.ddl("loja", "reajuste", "procedure").await.unwrap().contains("PROCEDURE"));
    assert!(s.indexes("loja", "produtos").await.unwrap()[0].primary);
    assert!(!s.completion("loja").await.unwrap().is_empty());
    let r = s.execute("SELECT nome, preco, NULL n FROM produtos ORDER BY id; UPDATE produtos SET preco = preco WHERE id = 1; SELECT 'ç' AS x").await.unwrap();
    assert_eq!(r.len(), 3, "{r:?}");
    assert_eq!(r[0].rows[0][0].as_deref(), Some("Café"));
    assert_eq!(r[0].rows[0][2], None);
    assert!(r[1].affected.is_some());
    assert_eq!(r[2].rows[0][0].as_deref(), Some("ç"));
    let e = s.execute("SELEC 1").await.unwrap_err();
    println!("err: {e}");
}

#[tokio::test]
#[ignore]
async fn pg_cancel() {
    let c = cfg(DbKind::Postgres);
    let st = rits_lib::db::Sessions::default();
    let s = st.get(&c, "loja", "console").await.unwrap();
    let h = tokio::spawn(async move {
        let s = s.lock().await;
        let Session::Pg(p) = &*s else { panic!() };
        p.execute("SELECT pg_sleep(10)").await
    });
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    st.cancel("t", "loja", "console").await.unwrap();
    let r = tokio::time::timeout(std::time::Duration::from_secs(3), h).await.expect("cancel did not stop query").unwrap();
    println!("cancel -> {:?}", r.as_ref().err());
    assert!(r.is_err());
}
