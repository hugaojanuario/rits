//! Executes the exact argument lists Rits builds with the real client tools
//! inside the docker test containers. cargo test --test tools_docker -- --ignored
use rits_lib::store::{ConnConfig, DbKind};
use rits_lib::tools::{my_plan, pg_plan, Plan, TaskSpec};
use std::process::Command;

fn cfg(kind: DbKind) -> ConnConfig {
    let pg = kind == DbKind::Postgres;
    ConnConfig {
        id: "t".into(), name: "t".into(), kind,
        host: "127.0.0.1".into(), port: if pg { 5432 } else { 3306 },
        user: if pg { "postgres".into() } else { "root".into() },
        password: "bgtest".into(), database: "loja".into(),
        ssl: false, tools_dir: String::new(), color: String::new(), read_only: false,
    }
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\''"))
}

fn run_in(container: &str, env: &str, plan: &Plan) -> (bool, String) {
    let mut cmdline = format!("{} {}", plan.tool, plan.args.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" "));
    if let Some(f) = &plan.stdin_file {
        cmdline.push_str(&format!(" < {}", sh_quote(&f.to_string_lossy())));
    }
    let out = Command::new("docker")
        .args(["exec", "-e", env, container, "sh", "-c", &cmdline])
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    println!("$ {cmdline}\n  -> {} ({} bytes of output)", out.status, text.len());
    if !out.status.success() {
        println!("{text}");
    }
    (out.status.success(), text)
}

fn psql(sql: &str) -> String {
    let o = Command::new("docker").args(["exec", "rits-pg", "psql", "-U", "postgres", "-tAc", sql]).output().unwrap();
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

fn mysql(sql: &str) -> String {
    let o = Command::new("docker")
        .args(["exec", "rits-my", "mysql", "-uroot", "-pbgtest", "--default-character-set=utf8mb4", "-N", "-e", sql])
        .output()
        .unwrap();
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

fn spec(action: &str, db: &str, path: &str) -> TaskSpec {
    TaskSpec { task_id: "x".into(), conn_id: "t".into(), action: action.into(), database: db.into(), path: path.into(), ..Default::default() }
}

#[test]
#[ignore]
fn postgres_backup_restore() {
    let c = cfg(DbKind::Postgres);
    let env = "PGPASSWORD=bgtest";
    for db in ["loja_custom", "loja_plain", "loja_dir"] {
        psql(&format!("DROP DATABASE IF EXISTS {db}"));
        psql(&format!("CREATE DATABASE {db}"));
    }

    // custom format, compressed, no owner
    let mut s = spec("backup", "loja", "/tmp/loja.backup");
    s.format = "custom".into();
    s.compression = Some(6);
    s.no_owner = true;
    assert!(run_in("rits-pg", env, &pg_plan(&c, &s).unwrap()).0);
    let mut r = spec("restore", "loja_custom", "/tmp/loja.backup");
    r.no_owner = true;
    r.single_transaction = true;
    r.clean = true;
    r.if_exists = true;
    assert!(run_in("rits-pg", env, &pg_plan(&c, &r).unwrap()).0);
    let n = Command::new("docker").args(["exec", "rits-pg", "psql", "-U", "postgres", "-d", "loja_custom", "-tAc", "SELECT count(*) FROM vendas.pedidos"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&n.stdout).trim(), "5000");

    // plain SQL with INSERTs, restored through psql in a single transaction
    let mut s = spec("backup", "loja", "/tmp/loja.sql");
    s.format = "plain".into();
    s.inserts = true;
    s.schemas = vec!["vendas".into()];
    assert!(run_in("rits-pg", env, &pg_plan(&c, &s).unwrap()).0);
    let mut r = spec("restore", "loja_plain", "/tmp/loja.sql");
    r.single_transaction = true;
    let p = pg_plan(&c, &r).unwrap();
    assert_eq!(p.tool, "psql");
    assert!(run_in("rits-pg", env, &p).0);
    let n = Command::new("docker").args(["exec", "rits-pg", "psql", "-U", "postgres", "-d", "loja_plain", "-tAc", "SELECT count(*) FROM vendas.clientes"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&n.stdout).trim(), "1500");

    // directory format with parallel jobs, single table, then parallel restore
    let mut s = spec("backup", "loja", "/tmp/loja_dir");
    s.format = "directory".into();
    s.jobs = Some(2);
    s.tables = vec!["vendas.clientes".into()];
    Command::new("docker").args(["exec", "rits-pg", "rm", "-rf", "/tmp/loja_dir"]).output().unwrap();
    assert!(run_in("rits-pg", env, &pg_plan(&c, &s).unwrap()).0);
    Command::new("docker").args(["exec", "rits-pg", "psql", "-U", "postgres", "-d", "loja_dir", "-c", "CREATE SCHEMA vendas"]).output().unwrap();
    let mut r = spec("restore", "loja_dir", "/tmp/loja_dir");
    r.jobs = Some(2);
    assert!(run_in("rits-pg", env, &pg_plan(&c, &r).unwrap()).0);

    // schema only + tar
    let mut s = spec("backup", "loja", "/tmp/loja_schema.tar");
    s.format = "tar".into();
    s.schema_only = true;
    s.compression = Some(5); // ignored for tar
    assert!(run_in("rits-pg", env, &pg_plan(&c, &s).unwrap()).0);

    // failure surfaces a non-zero exit code
    let r = spec("restore", "loja_custom", "/tmp/nao_existe.backup");
    assert!(!run_in("rits-pg", env, &pg_plan(&c, &r).unwrap()).0);
}

#[test]
#[ignore]
fn mysql_backup_restore() {
    let c = cfg(DbKind::Mysql);
    let env = "MYSQL_PWD=bgtest";
    mysql("DROP DATABASE IF EXISTS loja_restore; CREATE DATABASE loja_restore");

    let mut s = spec("backup", "loja", "/tmp/loja.sql");
    s.single_transaction = true;
    s.routines = true;
    s.triggers = true;
    s.add_drop_table = true;
    s.extended_insert = true;
    s.encoding = "utf8mb4".into();
    let (ok, _) = run_in("rits-my", env, &my_plan(&c, &s).unwrap());
    assert!(ok);

    let mut r = spec("restore", "loja_restore", "/tmp/loja.sql");
    r.encoding = "utf8mb4".into();
    let p = my_plan(&c, &r).unwrap();
    assert!(p.stdin_file.is_some());
    assert!(run_in("rits-my", env, &p).0);
    assert_eq!(mysql("SELECT nome FROM loja_restore.produtos WHERE id = 1"), "Café");
    assert_eq!(mysql("SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='loja_restore'"), "1");

    // single table, data only, complete inserts
    let mut s = spec("backup", "loja", "/tmp/produtos.sql");
    s.tables = vec!["produtos".into()];
    s.data_only = true;
    s.column_inserts = true;
    assert!(run_in("rits-my", env, &my_plan(&c, &s).unwrap()).0);
    let out = Command::new("docker").args(["exec", "rits-my", "cat", "/tmp/produtos.sql"]).output().unwrap();
    let dump = String::from_utf8_lossy(&out.stdout);
    assert!(dump.contains("INSERT INTO `produtos` (`id`, `nome`, `preco`, `criado`)"));
    assert!(!dump.contains("CREATE TABLE"));
}
