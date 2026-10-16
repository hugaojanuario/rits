//! dbt plugin backend: command construction (structured arguments, selection validation, Docker
//! runtime without secrets on the command line), managed profiles, version detection and artifact
//! reading. `dbt_live` (`--ignored`) runs a real dbt Core against PostgreSQL:
//!
//!   RITS_DBT=/path/to/venv/bin/dbt RITS_DBT_PG_PORT=55433 cargo test --test dbt_plugin dbt_live -- --ignored

use rits_lib::dbt::artifacts::{self, schema_version};
use rits_lib::dbt::{build_args, docker_args, env_name_ok, parse_version, project_profile_name, render_profile, selector_ok, Profile, RunSpec, Target};
use rits_lib::store::{ConnConfig, DbKind};
use serde_json::json;
use std::collections::HashMap;

fn spec(cmd: &str) -> RunSpec {
    RunSpec { project_dir: "/p".into(), command: cmd.into(), ..Default::default() }
}

#[test]
fn commands_are_structured_arguments() {
    let mut s = spec("build");
    s.select = vec!["tag:diario".into(), "stg_clientes+".into(), "path:models/marts".into(), "@fct_vendas".into(), "1+dim_x,tag:a".into()];
    s.exclude = vec!["source:legado.*".into()];
    s.target = "dev".into();
    s.full_refresh = true;
    s.vars = Some(json!({"data_ref": "2024-01-01; rm -rf /"}));
    s.threads = Some(4);
    let a = build_args(&s, "/p", Some("/cfg/prof")).unwrap();
    assert_eq!(&a[..3], &["build", "--log-format", "json"]);
    let pos = |x: &str| a.iter().position(|y| y == x).unwrap();
    assert_eq!(a[pos("--project-dir") + 1], "/p");
    assert_eq!(a[pos("--profiles-dir") + 1], "/cfg/prof");
    assert_eq!(a[pos("--target") + 1], "dev");
    assert_eq!(&a[pos("--select") + 1..pos("--select") + 6], &s.select[..]);
    assert_eq!(a[pos("--exclude") + 1], "source:legado.*");
    assert!(a.contains(&"--full-refresh".to_string()));
    // vars travel as one JSON argument (no shell is involved)
    assert_eq!(a[pos("--vars") + 1], r#"{"data_ref":"2024-01-01; rm -rf /"}"#);
    assert_eq!(a[pos("--threads") + 1], "4");
    assert_eq!(build_args(&spec("docs-generate"), "/p", None).unwrap()[..2], ["docs", "generate"]);
}

#[test]
fn invalid_input_is_refused() {
    assert!(build_args(&spec("clean"), "/p", None).is_err(), "comando fora da lista");
    assert!(build_args(&spec("run-operation"), "/p", None).is_err());
    let mut s = spec("run");
    s.select = vec!["--profiles-dir".into()];
    assert!(build_args(&s, "/p", None).is_err(), "seleção não pode virar flag");
    s.select = vec!["a b".into()];
    assert!(build_args(&s, "/p", None).is_err());
    s.select = vec!["x;y".into()];
    assert!(build_args(&s, "/p", None).is_err());
    let mut t = spec("debug");
    t.select = vec!["x".into()];
    assert!(build_args(&t, "/p", None).is_err(), "debug não aceita seleção");
    let mut f = spec("test");
    f.full_refresh = true;
    assert!(build_args(&f, "/p", None).is_err(), "--full-refresh só em run/build/seed");
    let mut g = spec("run");
    g.target = "dev --debug".into();
    assert!(build_args(&g, "/p", None).is_err());
    let mut v = spec("run");
    v.vars = Some(json!([1]));
    assert!(build_args(&v, "/p", None).is_err());
    assert!(selector_ok("state:modified+") && selector_ok("config.materialized:incremental"));
    assert!(!selector_ok("-s") && !selector_ok(""));
    assert!(env_name_ok("DBT_SCHEMA_SUFFIX") && !env_name_ok("RITS_DBT_PASSWORD") && !env_name_ok("1X") && !env_name_ok("A-B"));
    let mut i = spec("init");
    i.init_name = "Meu Projeto".into();
    assert!(build_args(&i, "/p", None).is_err());
    i.init_name = "meu_projeto".into();
    assert_eq!(build_args(&i, "/p", None).unwrap(), vec!["init", "meu_projeto", "--skip-profile-setup"]);
}

#[test]
fn docker_runtime_keeps_secrets_out_of_arguments() {
    let mut s = spec("run");
    s.select = vec!["stg".into()];
    let a = docker_args(&s, "ghcr.io/dbt-labs/dbt-postgres:1.9.0", "rits-dbt-1", "/home/u/proj", Some("/cfg/prof"), &["RITS_DBT_PASSWORD".into()]).unwrap();
    let joined = a.join(" ");
    assert!(joined.contains("-v /home/u/proj:/usr/app"));
    assert!(joined.contains("-v /cfg/prof:/rits/profiles:ro"));
    assert!(joined.contains("-e RITS_DBT_PASSWORD"));
    assert!(!a.iter().any(|x| x.starts_with("RITS_DBT_PASSWORD=")), "valor da senha nunca na linha de comando");
    assert!(joined.contains("--project-dir /usr/app") && joined.contains("--profiles-dir /rits/profiles"));
    let mut d = spec("docs-serve");
    d.port = 8123;
    let a = docker_args(&d, "img", "n", "/p", None, &[]).unwrap();
    assert!(a.join(" ").contains("-p 127.0.0.1:8123:8123"), "porta publicada só em localhost");
}

#[test]
fn managed_profile_has_no_password() {
    let mut conns = HashMap::new();
    conns.insert("c1".to_string(), ConnConfig { id: "c1".into(), name: "dev".into(), kind: DbKind::Postgres, host: "db.local".into(), port: 5433, user: "ana".into(), password: "S3gr3d0!".into(), database: "dw".into(), ssl: false, tools_dir: String::new(), color: String::new(), read_only: false, project: String::new() });
    conns.insert("m1".to_string(), ConnConfig { kind: DbKind::Mysql, ..conns["c1"].clone() });
    let p = Profile { id: "p1".into(), project_dir: "/p".into(), profile_name: "loja".into(), default_target: "dev".into(), targets: vec![Target { name: "dev".into(), conn_id: "c1".into(), schema: "analytics".into(), threads: 4, ..Default::default() }, Target { name: "ci".into(), host: "ci\"db".into(), port: 5432, user: "ci".into(), dbname: "dw".into(), schema: "ci".into(), threads: 2, sslmode: "require".into(), ..Default::default() }], env: vec![] };
    let y = render_profile(&p, &conns).unwrap();
    assert!(!y.contains("S3gr3d0!"));
    assert!(y.contains("password: \"{{ env_var('RITS_DBT_PASSWORD') }}\""));
    assert!(y.contains("host: \"db.local\"") && y.contains("port: 5433") && y.contains("dbname: \"dw\""));
    assert!(y.contains("host: \"ci\\\"db\""), "valores escapados");
    assert!(y.starts_with("# Gerado pelo Rits"));
    // only PostgreSQL connections map to the managed adapter
    let bad = Profile { targets: vec![Target { name: "dev".into(), conn_id: "m1".into(), schema: "x".into(), ..Default::default() }], ..p.clone() };
    assert!(render_profile(&bad, &conns).unwrap_err().contains("não é PostgreSQL"));
}

#[test]
fn version_detection() {
    let out = "\u{1b}[0m15:56:51  Running with dbt=1.12.6\nCore:\n  - installed: 1.12.6\n  - latest:    1.12.6 - Up to date!\n\nPlugins:\n  - postgres: 1.11.0 - Up to date!\n  - duckdb:   1.9.1 - Update available!\n";
    let v = parse_version(out);
    assert_eq!(v.core, "1.12.6");
    assert_eq!(v.adapters, vec![("postgres".into(), "1.11.0".into()), ("duckdb".into(), "1.9.1".into())]);
    assert!(!v.v2);
    let v2 = parse_version("dbt-fusion 2.0.3\n");
    assert!(v2.v2 && v2.core == "2.0.3");
    assert_eq!(project_profile_name("name: 'loja'\nversion: '1.0'\nprofile: 'loja_dw'  # perfil\n"), Some("loja_dw".into()));
}

#[test]
fn artifact_schema_versions() {
    assert_eq!(schema_version("https://schemas.getdbt.com/dbt/manifest/v12.json"), Some(12));
    assert_eq!(schema_version("https://schemas.getdbt.com/dbt/run-results/v6.json"), Some(6));
    let m = json!({"metadata": {"dbt_schema_version": "https://schemas.getdbt.com/dbt/manifest/v9.json", "project_name": "x"}, "nodes": {}});
    assert_eq!(artifacts::parse_manifest(&m).0.compat, "old");
    let m = json!({"metadata": {"dbt_schema_version": "https://schemas.getdbt.com/dbt/manifest/v14.json"}, "nodes": {}});
    assert_eq!(artifacts::parse_manifest(&m).0.compat, "newer");
    let r = json!({"metadata": {"dbt_schema_version": "https://schemas.getdbt.com/dbt/run-results/v6.json", "invocation_id": "i"}, "results": [{"unique_id": "test.x.not_null", "status": "fail", "failures": 3, "execution_time": 0.2, "message": "Got 3 results"}], "elapsed_time": 1.5, "args": {"which": "build"}});
    let (inf, res, el, cmd) = artifacts::parse_run_results(&r);
    assert_eq!(inf.compat, "ok");
    assert_eq!((res[0].status.as_str(), res[0].failures, el, cmd.as_str()), ("fail", Some(3), 1.5, "build"));
}

fn sh(cmd: &str, args: &[String], cwd: &str, env: &[(&str, &str)]) -> (i32, String) {
    let mut c = std::process::Command::new(cmd);
    c.args(args).current_dir(cwd);
    for (k, v) in env {
        c.env(k, v);
    }
    let o = c.output().unwrap();
    (o.status.code().unwrap_or(-1), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)))
}

#[test]
#[ignore]
fn dbt_live() {
    let dbt = std::env::var("RITS_DBT").expect("RITS_DBT");
    let port: u16 = std::env::var("RITS_DBT_PG_PORT").unwrap_or("55433".into()).parse().unwrap();
    let base = std::env::temp_dir().join(format!("rits-dbt-live-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let b = base.to_string_lossy().to_string();
    // version and adapters
    let (_, out) = sh(&dbt, &["--version".into()], &b, &[]);
    let v = parse_version(&out);
    assert!(v.core.starts_with("1."), "{out}");
    assert!(v.adapters.iter().any(|(a, _)| a == "postgres"));
    // official project creation
    let mut init = spec("init");
    init.init_name = "rits_live".into();
    let (code, out) = sh(&dbt, &build_args(&init, &b, None).unwrap(), &b, &[]);
    assert_eq!(code, 0, "{out}");
    let proj = base.join("rits_live");
    let p = proj.to_string_lossy().to_string();
    assert_eq!(project_profile_name(&std::fs::read_to_string(proj.join("dbt_project.yml")).unwrap()).as_deref(), Some("rits_live"));
    // managed profile (password through the environment only)
    let prof = Profile { id: "live".into(), project_dir: p.clone(), profile_name: "rits_live".into(), default_target: "dev".into(), targets: vec![Target { name: "dev".into(), host: "127.0.0.1".into(), port, user: "postgres".into(), dbname: "postgres".into(), schema: "rits_dbt_live".into(), threads: 2, sslmode: "disable".into(), ..Default::default() }], env: vec![] };
    let pd = base.join("profiles");
    std::fs::create_dir_all(&pd).unwrap();
    std::fs::write(pd.join("profiles.yml"), render_profile(&prof, &HashMap::new()).unwrap()).unwrap();
    let pds = pd.to_string_lossy().to_string();
    let env = [("RITS_DBT_PASSWORD", "bgtest"), ("DBT_USE_COLORS", "false")];
    let run = |cmd: &str, sel: &[&str]| {
        let mut s = spec(cmd);
        s.project_dir = p.clone();
        s.select = sel.iter().map(|x| x.to_string()).collect();
        sh(&dbt, &build_args(&s, &p, Some(&pds)).unwrap(), &p, &env)
    };
    let (code, out) = run("debug", &[]);
    assert_eq!(code, 0, "dbt debug: {out}");
    assert!(out.contains("\"All checks passed!\"") || out.contains("All checks passed"), "{out}");
    // replace the starter models with a model and tests (one of them fails)
    let _ = std::fs::remove_dir_all(proj.join("models").join("example"));
    std::fs::write(proj.join("models").join("clientes_ativos.sql"), "select 1 as id, 'ana' as nome union all select 2, null\n").unwrap();
    std::fs::write(proj.join("models").join("pedidos.sql"), "select 10 as id, 1 as cliente_id from {{ ref('clientes_ativos') }} limit 1\n").unwrap();
    std::fs::write(proj.join("models").join("schema.yml"), "version: 2\nmodels:\n  - name: clientes_ativos\n    columns:\n      - name: id\n        data_tests: [unique, not_null]\n      - name: nome\n        data_tests: [not_null]\n").unwrap();
    let (code, out) = run("build", &[]);
    assert_ne!(code, 0, "um teste deveria falhar: {out}");
    // JSON log lines carry node events
    assert!(out.lines().any(|l| l.trim_start().starts_with('{') && l.contains("\"node_info\"")), "{out}");
    let s = artifacts::summarize(&proj).unwrap();
    assert_eq!(s.manifest.compat, "ok", "{:?}", s.manifest);
    assert_eq!(s.run_results.compat, "ok", "{:?}", s.run_results);
    assert_eq!(s.command, "build");
    let failed = s.results.iter().find(|r| r.status == "fail").expect("teste com falha");
    assert!(failed.unique_id.contains("not_null_clientes_ativos_nome"));
    let node = s.nodes.iter().find(|n| n.unique_id == failed.unique_id).unwrap();
    assert_eq!(node.path, "models/schema.yml", "a falha aponta para o arquivo do teste");
    let model = s.nodes.iter().find(|n| n.name == "pedidos" && n.resource_type == "model").unwrap();
    assert_eq!(model.path, "models/pedidos.sql");
    assert_eq!(model.depends_on, vec!["model.rits_live.clientes_ativos"]);
    // pedidos was skipped (its upstream test failed): the result says so
    assert!(s.results.iter().any(|r| r.unique_id == model.unique_id && r.status == "skipped"), "{:?}", s.results);
    assert!(s.results.iter().any(|r| r.unique_id == "model.rits_live.clientes_ativos" && r.status == "success"));
    // files changed after the run are flagged as stale
    std::thread::sleep(std::time::Duration::from_millis(1100));
    std::fs::write(proj.join("models").join("pedidos.sql"), "select 11 as id, 1 as cliente_id from {{ ref('clientes_ativos') }} limit 1\n").unwrap();
    assert!(artifacts::summarize(&proj).unwrap().changed_since_results.contains(&"models/pedidos.sql".to_string()));
    // fix the data and build again with a selection
    std::fs::write(proj.join("models").join("clientes_ativos.sql"), "select 1 as id, 'ana' as nome union all select 2, 'bia'\n").unwrap();
    let (code, out) = run("build", &["clientes_ativos+"]);
    assert_eq!(code, 0, "{out}");
    let sql = artifacts::compiled_sql(&proj, "model.rits_live.pedidos").unwrap().unwrap();
    assert!(sql.contains("\"postgres\".\"rits_dbt_live\".\"clientes_ativos\""), "{sql}");
    let (code, out) = run("docs-generate", &[]);
    assert_eq!(code, 0, "{out}");
    assert!(proj.join("target").join("index.html").exists() && proj.join("target").join("catalog.json").exists());
    let mut ls = spec("ls");
    ls.project_dir = p.clone();
    ls.select = vec!["clientes_ativos+".into()];
    let (code, out) = sh(&dbt, &build_args(&ls, &p, Some(&pds)).unwrap(), &p, &env);
    assert_eq!(code, 0, "{out}");
    assert!(out.lines().filter(|l| l.starts_with('{')).count() >= 2, "{out}");
    let _ = std::fs::remove_dir_all(&base);
}
