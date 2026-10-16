//! Migration Audit end to end against real databases (`--ignored`): discovery, baseline with
//! identities and fields, external "conversion", reconciliation, relationships, permission errors,
//! cancellation, source changes after the baseline and estimated counts.
//!
//! Containers (ports chosen not to clash with other local services):
//!   docker run -d --name rits-audit-pg -e POSTGRES_PASSWORD=bgtest -p 127.0.0.1:55433:5432 postgres:17
//!   docker run -d --name rits-audit-my -e MYSQL_ROOT_PASSWORD=bgtest -p 127.0.0.1:33307:3306 mysql:8.4
//!   docker run -d --name rits-audit-maria -e MARIADB_ROOT_PASSWORD=bgtest -p 127.0.0.1:33308:3306 mariadb:11.8
//!   docker run -d --name rits-audit-mssql -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=Bgtest!2026x' -p 127.0.0.1:14330:1433 mcr.microsoft.com/mssql/server:2022-latest
//!   docker run -d --name rits-audit-fb -e FIREBIRD_ROOT_PASSWORD=bgtest -e FIREBIRD_DATABASE=audit.fdb -e FIREBIRD_USER=rits -e FIREBIRD_PASSWORD=bgtest -p 127.0.0.1:30500:3050 firebirdsql/firebird:5
//! cargo test --test audit_db -- --ignored --test-threads=1

use rits_lib::audit::adapter::{Adapter, JobCtl};
use rits_lib::audit::canon::{LType, Side};
use rits_lib::audit::model::*;
use rits_lib::audit::runner::{self, ProgressFn};
use rits_lib::audit::store;
use rits_lib::db::Session;
use rits_lib::store::{ConnConfig, DbKind};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn cfg(kind: DbKind, port: u16, user: &str, pw: &str, db: &str) -> ConnConfig {
    ConnConfig { id: format!("{kind:?}{port}"), name: format!("{kind:?}"), kind, host: "127.0.0.1".into(), port, user: user.into(), password: pw.into(), database: db.into(), ssl: false, tools_dir: String::new(), color: String::new(), read_only: false, project: String::new() }
}

async fn exec(c: &ConnConfig, sql: &str) {
    let mut s = Session::open(c, &c.default_db()).await.expect("conexão de preparação");
    let r = match &mut s {
        Session::Pg(x) => x.execute(sql).await.map(|_| ()),
        Session::My(x) => x.execute(sql).await.map(|_| ()),
        Session::Ext(x) => x.execute(sql).await.map(|_| ()),
    };
    r.unwrap_or_else(|e| panic!("{e}\n--- {}", &sql[..sql.len().min(300)]));
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("rits-audit-db-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

struct Dialect {
    name: &'static str,
    src: &'static str,
    dst: &'static str,
    /// table name prefix (Firebird has no schemas)
    prefix: bool,
    n: u32,
}

fn tname(d: &Dialect, schema: &str, t: &str) -> String {
    if d.prefix {
        format!("{}_{}", schema.to_uppercase(), t.to_uppercase())
    } else {
        format!("{schema}.{t}")
    }
}

fn ident(d: &Dialect, s: &str) -> String {
    if d.prefix {
        s.to_uppercase()
    } else {
        s.to_string()
    }
}

fn birth(i: u32) -> Option<String> {
    if i % 10 == 0 {
        None
    } else {
        Some(format!("1990-{:02}-{:02}", i % 12 + 1, i % 28 + 1))
    }
}

/// Source and target fixtures with known differences:
/// - 1/30 of the clients were not converted (500 of 15,000);
/// - birth date lost for the first 350 converted clients that had one;
/// - name of client 7 changed; pedido 2 points to another (valid) client;
/// - pedidos of clients 30, 60 and 90 are orphans in the target (their clients are missing).
async fn fixtures(c: &ConnConfig, d: &Dialect) {
    let ts = if d.name == "sqlserver" { "DATETIME2(6)" } else if d.name == "mysql" { "DATETIME(6)" } else { "TIMESTAMP" };
    let t = |s: &str, x: &str| tname(d, s, x);
    let mut ddl = vec![];
    for (s, cl, ped) in [(d.src, "clientes", "pedidos"), (d.dst, "pessoas", "pedidos")] {
        let big = if s == d.dst { "BIGINT" } else { "INT" };
        let money = if s == d.dst { "DECIMAL(14,2)" } else { "DECIMAL(12,2)" };
        ddl.push(format!("CREATE TABLE {} (id {big} NOT NULL PRIMARY KEY, nome VARCHAR(100), nascimento DATE, doc VARCHAR(20), saldo {money}, criado {ts})", t(s, cl)));
        ddl.push(format!("CREATE TABLE {} (id INT NOT NULL PRIMARY KEY, cliente_id INT, valor DECIMAL(10,2))", t(s, ped)));
    }
    for q in ddl {
        exec(c, &q).await;
    }
    let lost: std::collections::HashSet<u32> = (1..=d.n).filter(|i| i % 30 != 0 && birth(*i).is_some()).take(350).collect();
    let mut src_rows = vec![];
    let mut dst_rows = vec![];
    let q = |s: Option<String>| s.map(|x| format!("'{x}'")).unwrap_or("NULL".into());
    for i in 1..=d.n {
        // Firebird keeps 1/10000 s
        let frac = if d.name == "firebird" { "1234" } else { "123456" };
        let cr = format!("'2024-01-01 {:02}:{:02}:{:02}.{frac}'", (i / 3600) % 24, (i / 60) % 60, i % 60);
        let doc = format!("'{:011}'", i);
        let saldo = format!("{}.{:02}", i, (i * 25) % 100);
        src_rows.push(format!("({i}, 'nome {i}', {}, {doc}, {saldo}, {cr})", q(birth(i))));
        if i % 30 != 0 {
            let b = if lost.contains(&i) { None } else { birth(i) };
            let nome = if i == 7 { "NOME ERRADO".to_string() } else { format!("nome {i}") };
            dst_rows.push(format!("({i}, '{nome}', {}, {doc}, {saldo}, {cr})", q(b)));
        }
    }
    let insert = |table: String, rows: Vec<String>| {
        let mut out = vec![];
        if d.name == "firebird" {
            for chunk in rows.chunks(200) {
                out.push(format!("EXECUTE BLOCK AS BEGIN {} END", chunk.iter().map(|r| format!("INSERT INTO {table} VALUES {r};")).collect::<String>()));
            }
        } else {
            for chunk in rows.chunks(500) {
                out.push(format!("INSERT INTO {table} VALUES {}", chunk.join(", ")));
            }
        }
        out
    };
    let mut all = insert(t(d.src, "clientes"), src_rows);
    all.extend(insert(t(d.dst, "pessoas"), dst_rows));
    let ped_src: Vec<String> = (1..=100).map(|i| format!("({i}, {i}, {i}.50)")).collect();
    let ped_dst: Vec<String> = (1..=100).map(|i| format!("({i}, {}, {i}.50)", if i == 2 { 1 } else { i })).collect();
    all.extend(insert(t(d.src, "pedidos"), ped_src));
    all.extend(insert(t(d.dst, "pedidos"), ped_dst));
    for s in all {
        exec(c, &s).await;
    }
}

fn kc(d: &Dialect, c: &str) -> KeyCol {
    KeyCol { column: ident(d, c), ..Default::default() }
}

fn fm(d: &Dialect, id: &str, s: &str, t: &str) -> FieldMap {
    FieldMap { id: id.into(), kind: "map".into(), source_cols: vec![ident(d, s)], target_col: ident(d, t), confirmed: true, ..Default::default() }
}

fn ds(d: &Dialect, schema: &str, table: &str) -> Dataset {
    if d.prefix {
        Dataset { kind: "table".into(), schema: String::new(), table: format!("{}_{}", schema.to_uppercase(), table.to_uppercase()), ..Default::default() }
    } else {
        Dataset { kind: "table".into(), schema: schema.into(), table: table.into(), ..Default::default() }
    }
}

fn units(d: &Dialect) -> Vec<Unit> {
    let clientes = Unit {
        id: "clientes".into(),
        name: "Clientes → Pessoas".into(),
        criticality: "alta".into(),
        source: ds(d, d.src, "clientes"),
        target: ds(d, d.dst, "pessoas"),
        cardinality: "1:1".into(),
        identity: Identity { kind: "key".into(), source: vec![kc(d, "id")], target: vec![kc(d, "id")], map: None },
        fields: vec![fm(d, "nome", "nome", "nome"), fm(d, "nasc", "nascimento", "nascimento"), fm(d, "doc", "doc", "doc"), fm(d, "saldo", "saldo", "saldo"), fm(d, "criado", "criado", "criado")],
        confirmed: true,
        ..Default::default()
    };
    let pedidos = Unit {
        id: "pedidos".into(),
        name: "Pedidos".into(),
        criticality: "media".into(),
        source: ds(d, d.src, "pedidos"),
        target: ds(d, d.dst, "pedidos"),
        cardinality: "1:1".into(),
        identity: Identity { kind: "key".into(), source: vec![kc(d, "id")], target: vec![kc(d, "id")], map: None },
        fields: vec![fm(d, "valor", "valor", "valor")],
        relationships: vec![Relationship { id: "r1".into(), name: "pedido → cliente".into(), parent_unit: "clientes".into(), source_cols: vec![ident(d, "cliente_id")], target_cols: vec![ident(d, "cliente_id")] }],
        confirmed: true,
        ..Default::default()
    };
    vec![clientes, pedidos]
}

fn noop() -> ProgressFn {
    Arc::new(|_| {})
}

async fn discover(c: &ConnConfig, schemas: &[&str]) -> Structure {
    let mut a = Adapter::open(c, &c.database, 60).await.expect("adapter");
    let s = a.discover(&schemas.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &JobCtl::default()).await.expect("descoberta");
    a.close().await;
    s
}

fn plans(us: &[Unit], ss: &Structure, ts: &Structure, perf: &Perf) -> HashMap<String, Vec<runner::FieldPlan>> {
    let types = |s: &Structure, x: &Dataset| s.tables.iter().find(|t| t.schema == x.schema && t.name == x.table).map(|t| t.columns.iter().map(|c| (c.name.clone(), c.native.clone(), c.ltype.unwrap_or(LType::Other))).collect::<Vec<_>>());
    us.iter().map(|u| (u.id.clone(), runner::plan_fields(u, types(ss, &u.source).as_ref(), types(ts, &u.target).as_ref(), perf).0)).collect()
}

async fn baseline(c: &ConnConfig, p: &Project, us: &[Unit], ss: &Structure, ts: &Structure, dir: &Path, ctl: &JobCtl) -> BaselineManifest {
    let pl = plans(us, ss, ts, &p.perf);
    let (caps, cons, errors) = runner::capture_side(c, &c.database, us, us, Side::Source, &pl, &p.evidence_level, p.store_values, Some(ss), dir, &p.perf, &p.consistency, ctl, &noop()).await;
    let mut m = BaselineManifest { format: FORMAT, kind: "baseline".into(), id: "b1".into(), side: "source".into(), status: if caps.iter().all(|c| c.status == "complete") { "complete".into() } else { "partial".into() }, level: p.evidence_level.clone(), store_values: p.store_values, units_config: us.to_vec(), consistency: cons, structure: Some(ss.clone()), units: caps, errors, ..Default::default() };
    m.digest = store::baseline_digest(&m);
    store::write_json_atomic(&dir.join("manifest.json"), &m).unwrap();
    m
}

async fn reconcile(src: &ConnConfig, dst: &ConnConfig, p: &Project, us: &[Unit], bl: &BaselineManifest, bdir: &Path, ts: &Structure, rdir: &Path, check_source: bool) -> RunManifest {
    let m = Mappings { format: FORMAT, version: 1, units: us.to_vec(), ignored: vec![] };
    let inp = runner::ReconcileInput { project: p, current: &m, baseline: bl, baseline_dir: bdir, pre: None, source_cfg: if check_source { Some(src) } else { None }, target_cfg: dst, target_structure: Some(ts), run_dir: rdir, unit_ids: None };
    runner::reconcile(inp, &JobCtl::default(), &noop()).await
}

fn project(d: &Dialect, src: &ConnConfig, dst: &ConnConfig) -> Project {
    let mut p = Project { id: "p".into(), name: format!("teste {}", d.name), store_values: true, ..Default::default() };
    p.source.database = src.database.clone();
    p.target.database = dst.database.clone();
    p.perf.batch_rows = (d.n / 7) as usize;
    p
}

fn unit<'a>(r: &'a RunManifest, id: &str) -> &'a UnitResult {
    r.units.iter().find(|u| u.unit_id == id).unwrap()
}

fn field<'a>(u: &'a UnitResult, id: &str) -> &'a FieldResult {
    u.fields.iter().find(|f| f.field_id == id).unwrap()
}

async fn full_flow(d: &Dialect, src: &ConnConfig, dst: &ConnConfig) {
    let ss = discover(src, &[d.src]).await;
    let ts = discover(dst, &[d.dst]).await;
    let cl = ss.tables.iter().find(|t| t.name.eq_ignore_ascii_case(&ds(d, d.src, "clientes").table)).expect("tabela de origem descoberta");
    assert!(cl.constraints.iter().any(|c| c.kind == "primary"), "PK descoberta: {:?}", cl.constraints);
    assert_eq!(cl.columns.len(), 6);
    let us = units(d);
    let p = project(d, src, dst);
    let bdir = tmp(&format!("{}-bl", d.name));
    let bl = baseline(src, &p, &us, &ss, &ts, &bdir, &JobCtl::default()).await;
    for u in &bl.units {
        assert_eq!(u.status, "complete", "{}: {}", u.unit_id, u.error);
    }
    assert_eq!(bl.units[0].rows, Some(d.n as u64));
    assert!(bl.units[0].sorted_runs > 1, "a captura deveria ultrapassar o lote configurado");
    let (_, integ) = store::verify_baseline(&bdir);
    assert!(integ.ok, "{:?}", integ.problems);
    let rdir = tmp(&format!("{}-run", d.name));
    let run = reconcile(src, dst, &p, &us, &bl, &bdir, &ts, &rdir, false).await;
    let c = unit(&run, "clientes");
    assert_eq!(c.status, "complete", "{}", c.error);
    let missing = (d.n / 30) as u64;
    assert_eq!(c.missing, missing);
    assert_eq!(c.extra, 0);
    assert_eq!(c.volume.result, "divergent");
    assert_eq!(c.identity.result, "divergent");
    assert_eq!(field(c, "nasc").lost, 350, "{:?}", field(c, "nasc"));
    assert_eq!(field(c, "nasc").created, 0);
    assert_eq!(field(c, "nome").divergent, 1);
    for f in ["doc", "saldo", "criado"] {
        let fr = field(c, f);
        assert_eq!(fr.result, "compatible", "{f}: {fr:?}");
    }
    let pd = unit(&run, "pedidos");
    assert_eq!(pd.missing, 0);
    assert_eq!(pd.relations.result, "divergent", "{:?}", pd.relations);
    let changed: u64 = pd.relation_issues.iter().filter(|(k, _)| k.contains("associação")).map(|(_, v)| *v).sum();
    let orphans: u64 = pd.relation_issues.iter().filter(|(k, _)| k.contains("órfãos")).map(|(_, v)| *v).sum();
    assert_eq!(changed, 1, "{:?}", pd.relation_issues);
    assert_eq!(orphans, 3, "{:?}", pd.relation_issues);
    // the listing of missing identities is complete on disk
    let n = std::fs::read_to_string(rdir.join("clientes").join("missing.tsv")).unwrap().lines().count() as u64;
    assert_eq!(n, missing);
}

// ---------------- PostgreSQL ----------------

fn pg() -> ConnConfig {
    cfg(DbKind::Postgres, 55433, "postgres", "bgtest", "postgres")
}

async fn pg_reset() {
    exec(&pg(), "DROP SCHEMA IF EXISTS ma_src CASCADE; DROP SCHEMA IF EXISTS ma_dst CASCADE; CREATE SCHEMA ma_src; CREATE SCHEMA ma_dst;").await;
}

const PG: Dialect = Dialect { name: "postgres", src: "ma_src", dst: "ma_dst", prefix: false, n: 15_000 };

#[tokio::test]
#[ignore]
async fn postgres_full_flow() {
    pg_reset().await;
    fixtures(&pg(), &PG).await;
    full_flow(&PG, &pg(), &pg()).await;
}

#[tokio::test]
#[ignore]
async fn postgres_permission_error_is_not_zero() {
    pg_reset().await;
    fixtures(&pg(), &PG).await;
    exec(&pg(), "DROP ROLE IF EXISTS ma_ro; CREATE ROLE ma_ro LOGIN PASSWORD 'ro'; GRANT USAGE ON SCHEMA ma_src TO ma_ro; GRANT SELECT ON ma_src.clientes TO ma_ro;").await;
    let ro = cfg(DbKind::Postgres, 55433, "ma_ro", "ro", "postgres");
    let ss = discover(&pg(), &["ma_src"]).await;
    let ts = discover(&pg(), &["ma_dst"]).await;
    let us = units(&PG);
    let p = project(&PG, &ro, &pg());
    let bdir = tmp("pg-perm");
    let bl = baseline(&ro, &p, &us, &ss, &ts, &bdir, &JobCtl::default()).await;
    let ped = bl.units.iter().find(|u| u.unit_id == "pedidos").unwrap();
    assert_eq!(ped.status, "error");
    assert_eq!(ped.rows, None, "erro de permissão nunca vira contagem zero");
    assert!(ped.error.to_lowercase().contains("permission") || ped.error.contains("permissão"), "{}", ped.error);
    assert_eq!(bl.units.iter().find(|u| u.unit_id == "clientes").unwrap().status, "complete");
    // reconciliation reports the unit as not verified
    let run = reconcile(&ro, &pg(), &p, &us, &bl, &bdir, &ts, &tmp("pg-perm-run"), false).await;
    let pd = unit(&run, "pedidos");
    assert_eq!(pd.volume.result, "not_verified");
    assert_eq!(pd.identity.result, "not_verified");
    exec(&pg(), "REVOKE ALL ON ALL TABLES IN SCHEMA ma_src FROM ma_ro; REVOKE USAGE ON SCHEMA ma_src FROM ma_ro; DROP ROLE ma_ro;").await;
}

#[tokio::test]
#[ignore]
async fn postgres_cancellation_keeps_partial_state() {
    pg_reset().await;
    fixtures(&pg(), &PG).await;
    let ss = discover(&pg(), &["ma_src"]).await;
    let ts = discover(&pg(), &["ma_dst"]).await;
    let mut us = units(&PG);
    // slow read-only query dataset (1 ms per row) so the cancellation lands mid-scan
    us[0].source = Dataset { kind: "query".into(), sql: "SELECT c.id AS id, c.nome AS nome, c.nascimento AS nascimento, c.doc AS doc, c.saldo AS saldo, c.criado AS criado FROM ma_src.clientes c, LATERAL (SELECT pg_sleep(0.001 + c.id * 0)) s".into(), ..Default::default() };
    let p = project(&PG, &pg(), &pg());
    let ctl = JobCtl::default();
    let c2 = ctl.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        c2.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    });
    let started = std::time::Instant::now();
    let bdir = tmp("pg-cancel");
    let bl = baseline(&pg(), &p, &us, &ss, &ts, &bdir, &ctl).await;
    assert!(started.elapsed().as_secs() < 12, "o cancelamento deveria interromper a consulta");
    let c = &bl.units[0];
    assert_eq!(c.status, "cancelled", "{c:?}");
    assert!(c.evidence.is_none(), "evidência incompleta não é usada");
    assert_ne!(bl.status, "complete");
    // the manifest of the partial capture is intact and readable
    let (m, integ) = store::verify_baseline(&bdir);
    assert!(integ.ok && m.is_some());
}

#[tokio::test]
#[ignore]
async fn postgres_source_changed_after_baseline_and_estimates() {
    pg_reset().await;
    fixtures(&pg(), &PG).await;
    let ss = discover(&pg(), &["ma_src"]).await;
    let ts = discover(&pg(), &["ma_dst"]).await;
    let us = units(&PG);
    let p = project(&PG, &pg(), &pg());
    let bdir = tmp("pg-change");
    let bl = baseline(&pg(), &p, &us, &ss, &ts, &bdir, &JobCtl::default()).await;
    exec(&pg(), "INSERT INTO ma_src.clientes (id, nome) VALUES (999999, 'depois da baseline')").await;
    let run = reconcile(&pg(), &pg(), &p, &us, &bl, &bdir, &ts, &tmp("pg-change-run"), true).await;
    assert!(run.source_changed.iter().any(|s| s.contains("agora tem")), "{:?}", run.source_changed);
    // the comparison still uses the frozen baseline
    assert_eq!(unit(&run, "clientes").missing, 500);
    // estimated counts (quick analysis) never approve
    exec(&pg(), "ANALYZE ma_src.clientes; ANALYZE ma_dst.pessoas;").await;
    let ss = discover(&pg(), &["ma_src"]).await;
    let ts = discover(&pg(), &["ma_dst"]).await;
    let mut q = p.clone();
    q.perf.mode = "quick".into();
    let qdir = tmp("pg-quick");
    let bq = baseline(&pg(), &q, &us, &ss, &ts, &qdir, &JobCtl::default()).await;
    assert_eq!(bq.units[0].count_kind, "estimated");
    let rq = reconcile(&pg(), &pg(), &q, &us, &bq, &qdir, &ts, &tmp("pg-quick-run"), false).await;
    assert_eq!(unit(&rq, "clientes").volume.result, "inconclusive", "{:?}", unit(&rq, "clientes").volume);
}

#[tokio::test]
#[ignore]
async fn postgres_recreated_ids_through_map_table() {
    pg_reset().await;
    exec(&pg(), "CREATE TABLE ma_src.c (id int PRIMARY KEY, nome text); CREATE TABLE ma_dst.c (id int PRIMARY KEY, nome text); CREATE TABLE ma_dst.de_para (id_antigo int, id_novo int);
        INSERT INTO ma_src.c SELECT g, 'n' || g FROM generate_series(1, 1000) g;
        INSERT INTO ma_dst.c SELECT g + 100000, 'n' || g FROM generate_series(1, 990) g;
        INSERT INTO ma_dst.de_para SELECT g, g + 100000 FROM generate_series(1, 995) g;").await;
    let ss = discover(&pg(), &["ma_src"]).await;
    let ts = discover(&pg(), &["ma_dst"]).await;
    let u = Unit {
        id: "c".into(),
        name: "c".into(),
        source: Dataset { kind: "table".into(), schema: "ma_src".into(), table: "c".into(), ..Default::default() },
        target: Dataset { kind: "table".into(), schema: "ma_dst".into(), table: "c".into(), ..Default::default() },
        cardinality: "1:1".into(),
        identity: Identity { kind: "map".into(), source: vec![KeyCol { column: "id".into(), ..Default::default() }], target: vec![KeyCol { column: "id".into(), ..Default::default() }], map: Some(IdMap { side: "target".into(), dataset: Dataset { kind: "table".into(), schema: "ma_dst".into(), table: "de_para".into(), ..Default::default() }, source_cols: vec!["id_antigo".into()], target_cols: vec!["id_novo".into()], allow_dup_target: false }) },
        fields: vec![FieldMap { id: "nome".into(), kind: "map".into(), source_cols: vec!["nome".into()], target_col: "nome".into(), confirmed: true, ..Default::default() }],
        confirmed: true,
        ..Default::default()
    };
    let p = project(&PG, &pg(), &pg());
    let bdir = tmp("pg-map");
    let bl = baseline(&pg(), &p, &[u.clone()], &ss, &ts, &bdir, &JobCtl::default()).await;
    let run = reconcile(&pg(), &pg(), &p, &[u], &bl, &bdir, &ts, &tmp("pg-map-run"), false).await;
    let r = unit(&run, "c");
    assert_eq!(r.status, "complete", "{}", r.error);
    assert_eq!(r.map_issues["registros da origem sem correspondência no mapa"], 5);
    assert_eq!(r.missing, 5, "mapeados para registros inexistentes no destino");
    assert_eq!(r.extra, 0);
    assert_eq!(field(r, "nome").equal, 990);
}

// ---------------- MySQL / MariaDB ----------------

const MY: Dialect = Dialect { name: "mysql", src: "ma_src", dst: "ma_dst", prefix: false, n: 15_000 };

async fn my_flow(port: u16) {
    let root = cfg(DbKind::Mysql, port, "root", "bgtest", "");
    exec(&root, "DROP DATABASE IF EXISTS ma_src; DROP DATABASE IF EXISTS ma_dst; CREATE DATABASE ma_src; CREATE DATABASE ma_dst;").await;
    fixtures(&root, &MY).await;
    full_flow(&MY, &root, &root).await;
}

#[tokio::test]
#[ignore]
async fn mysql_full_flow() {
    my_flow(33307).await;
}

#[tokio::test]
#[ignore]
async fn mariadb_full_flow() {
    my_flow(33308).await;
}

// ---------------- SQL Server / Firebird (on-demand drivers) ----------------

fn drivers() {
    rits_lib::db::ext::set_dir(std::env::temp_dir().join("rits-audit-drivers"));
}

const MS: Dialect = Dialect { name: "sqlserver", src: "ma_src", dst: "ma_dst", prefix: false, n: 15_000 };

#[tokio::test]
#[ignore]
async fn sqlserver_full_flow() {
    drivers();
    let master = cfg(DbKind::Sqlserver, 14330, "sa", "Bgtest!2026x", "master");
    rits_lib::db::ext::ensure_driver(&master.kind).await.expect("driver");
    exec(&master, "IF DB_ID('ma_audit') IS NOT NULL BEGIN ALTER DATABASE ma_audit SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ma_audit; END").await;
    exec(&master, "CREATE DATABASE ma_audit").await;
    exec(&master, "ALTER DATABASE ma_audit SET ALLOW_SNAPSHOT_ISOLATION ON").await;
    let c = cfg(DbKind::Sqlserver, 14330, "sa", "Bgtest!2026x", "ma_audit");
    exec(&c, "CREATE SCHEMA ma_src").await;
    exec(&c, "CREATE SCHEMA ma_dst").await;
    fixtures(&c, &MS).await;
    full_flow(&MS, &c, &c).await;
}

const FB: Dialect = Dialect { name: "firebird", src: "src", dst: "dst", prefix: true, n: 1_500 };

#[tokio::test]
#[ignore]
async fn firebird_full_flow() {
    drivers();
    let c = cfg(DbKind::Firebird, 30500, "SYSDBA", "bgtest", "/var/lib/firebird/data/audit.fdb");
    rits_lib::db::ext::ensure_driver(&c.kind).await.expect("driver");
    for t in ["SRC_CLIENTES", "SRC_PEDIDOS", "DST_PESSOAS", "DST_PEDIDOS"] {
        let mut s = Session::open(&c, &c.default_db()).await.unwrap();
        if let Session::Ext(x) = &mut s {
            let _ = x.execute(&format!("DROP TABLE {t}")).await;
        }
    }
    fixtures(&c, &FB).await;
    full_flow(&FB, &c, &c).await;
}
