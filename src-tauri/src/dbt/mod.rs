//! dbt plugin (backend side): command construction with structured arguments (no shell), managed
//! profiles outside the repository (passwords come from the OS store or the linked IDE connection
//! as environment variables), one run at a time per artifact folder, and artifact parsing
//! (manifest.json / run_results.json with schema-version checks).
//!
//! Supported: dbt Core v1 (1.10–1.12) with Python adapters. PostgreSQL is the managed adapter;
//! other adapters run only with a profiles.yml the user maintains.

pub mod artifacts;

use crate::procs::{Procs, SpawnSpec};
use crate::secrets::{OsStore, SecretStore};
use crate::store;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

/// Official dbt Labs image used by the Docker runtime (dbt-postgres; newest tag published).
pub const DBT_IMAGE: &str = "ghcr.io/dbt-labs/dbt-postgres:1.9.0";

/// Commands the plugin runs. `init`, `ls` and `docs-serve` are used by the wizard, the scope
/// preview and the documentation viewer.
pub const COMMANDS: &[&str] = &["debug", "deps", "parse", "compile", "run", "test", "build", "docs-generate", "ls", "init", "docs-serve", "seed", "snapshot"];

/// Commands that change the database (the UI shows target and scope before running them).
pub const WRITES_DB: &[&str] = &["run", "build", "seed", "snapshot"];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    /// "local" (dbt executable of a Python environment) or "docker".
    pub kind: String,
    /// local: path of the `dbt` executable.
    #[serde(default)]
    pub dbt: String,
    /// docker: image (defaults to DBT_IMAGE).
    #[serde(default)]
    pub image: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunSpec {
    pub project_dir: String,
    pub runtime: Runtime,
    pub command: String,
    #[serde(default)]
    pub select: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub full_refresh: bool,
    #[serde(default)]
    pub vars: Option<Value>,
    #[serde(default)]
    pub threads: Option<u32>,
    #[serde(default)]
    pub fail_fast: bool,
    /// Managed profile id ("" = the user's own profiles.yml).
    #[serde(default)]
    pub profile_id: String,
    /// Unmanaged: folder of the user's profiles.yml ("" = dbt's default lookup).
    #[serde(default)]
    pub profiles_dir: String,
    /// init: project name; the run happens in project_dir (the parent folder).
    #[serde(default)]
    pub init_name: String,
    /// docs-serve: local port.
    #[serde(default)]
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub name: String,
    /// IDE connection used for host/port/user/database ("" = typed here).
    #[serde(default)]
    pub conn_id: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub dbname: String,
    pub schema: String,
    #[serde(default)]
    pub threads: u32,
    /// disable | prefer | require | verify-ca | verify-full
    #[serde(default)]
    pub sslmode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub name: String,
    /// Non-secret value (secret values live in the OS store).
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub secret: bool,
}

/// A managed profile (stored in the "dbt-profiles" document, without passwords).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    #[serde(default)]
    pub id: String,
    /// dbt project folder it belongs to.
    pub project_dir: String,
    /// `profile:` of dbt_project.yml.
    pub profile_name: String,
    pub default_target: String,
    pub targets: Vec<Target>,
    #[serde(default)]
    pub env: Vec<EnvVar>,
}

pub fn password_key(profile: &str, target: &str) -> String {
    format!("dbt:{profile}:{target}:password")
}
pub fn env_key(profile: &str, name: &str) -> String {
    format!("dbt:{profile}:env:{name}")
}

fn ident_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Environment variable names the user may define (and that dbt reads with env_var()).
pub fn env_name_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !s.starts_with("RITS_")
}

/// One element of a dbt selection (node selection syntax: methods, graph operators, unions by
/// separate elements, intersections with commas). Whitespace and leading dashes are refused, so
/// a selector can never become another flag.
pub fn selector_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 512
        && !s.starts_with('-')
        && s.chars().all(|c| c.is_alphanumeric() || "_./:+*@,-=".contains(c))
}

/// Folder where the IDE writes a managed profile's profiles.yml (config dir, never the repo).
pub fn profiles_dir(config_dir: &Path, profile_id: &str) -> Result<PathBuf, String> {
    if !ident_ok(profile_id) {
        return Err("Perfil inválido.".into());
    }
    Ok(config_dir.join("dbt-profiles").join(profile_id))
}

fn yq(s: &str) -> String {
    // JSON strings are valid YAML double-quoted scalars.
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// profiles.yml for a managed profile. Passwords are `env_var('RITS_DBT_PASSWORD')`, injected
/// at run time for the selected target only.
pub fn render_profile(p: &Profile, conns: &HashMap<String, store::ConnConfig>) -> Result<String, String> {
    if !ident_ok(&p.profile_name) {
        return Err("Nome de perfil inválido (dbt_project.yml › profile).".into());
    }
    if p.targets.is_empty() {
        return Err("Defina pelo menos um target.".into());
    }
    let mut out = String::from("# Gerado pelo Rits. Não contém senhas: a senha vem da variável de ambiente RITS_DBT_PASSWORD,\n# injetada a partir do cofre do sistema (ou da conexão do Rits) somente durante a execução.\n");
    out.push_str(&format!("{}:\n  target: {}\n  outputs:\n", p.profile_name, yq(if p.default_target.is_empty() { &p.targets[0].name } else { &p.default_target })));
    for t in &p.targets {
        if !ident_ok(&t.name) {
            return Err(format!("Nome de target inválido: {}", t.name));
        }
        let (host, port, user, db) = match conns.get(&t.conn_id).filter(|_| !t.conn_id.is_empty()) {
            Some(c) => {
                if c.kind != store::DbKind::Postgres {
                    return Err(format!("A conexão \"{}\" não é PostgreSQL: o mapeamento para o adapter dbt-postgres não é válido.", c.name));
                }
                (c.host.clone(), c.port, c.user.clone(), if t.dbname.is_empty() { c.default_db() } else { t.dbname.clone() })
            }
            None if !t.conn_id.is_empty() => return Err(format!("Conexão do target \"{}\" não encontrada.", t.name)),
            None => (t.host.clone(), t.port, t.user.clone(), t.dbname.clone()),
        };
        if host.is_empty() || user.is_empty() || db.is_empty() || t.schema.is_empty() {
            return Err(format!("Target \"{}\": host, usuário, banco e schema são obrigatórios.", t.name));
        }
        let ssl = if t.sslmode.is_empty() { "prefer" } else { t.sslmode.as_str() };
        if !["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].contains(&ssl) {
            return Err(format!("sslmode inválido: {ssl}"));
        }
        out.push_str(&format!(
            "    {}:\n      type: postgres\n      host: {}\n      port: {}\n      user: {}\n      password: \"{{{{ env_var('RITS_DBT_PASSWORD') }}}}\"\n      dbname: {}\n      schema: {}\n      threads: {}\n      sslmode: {}\n",
            t.name,
            yq(&host),
            if port == 0 { 5432 } else { port },
            yq(&user),
            yq(&db),
            yq(&t.schema),
            t.threads.clamp(1, 64),
            ssl
        ));
    }
    Ok(out)
}

/// Arguments after the program (`dbt` locally, or after the image in `docker run`).
/// `profiles_dir` and `project_dir` are the paths as the dbt process sees them.
pub fn build_args(spec: &RunSpec, project_dir: &str, profiles_dir: Option<&str>) -> Result<Vec<String>, String> {
    if !COMMANDS.contains(&spec.command.as_str()) {
        return Err(format!("Comando dbt não permitido: {}", spec.command));
    }
    let mut a: Vec<String> = vec![];
    let cmd = spec.command.as_str();
    match cmd {
        "docs-generate" => a.extend(["docs".into(), "generate".into()]),
        "docs-serve" => a.extend(["docs".into(), "serve".into()]),
        c => a.push(c.into()),
    }
    if cmd == "init" {
        let n = spec.init_name.as_str();
        if n.is_empty() || !n.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c == '_') || !n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
            return Err("Nome de projeto inválido: use letras minúsculas, números e _ (começando por letra).".into());
        }
        a.extend([n.to_string(), "--skip-profile-setup".into()]);
        return Ok(a);
    }
    // JSON log lines: the IDE shows the messages and follows node progress.
    if cmd != "docs-serve" && cmd != "ls" {
        a.extend(["--log-format".into(), "json".into()]);
    }
    a.extend(["--project-dir".into(), project_dir.to_string()]);
    if let Some(p) = profiles_dir {
        a.extend(["--profiles-dir".into(), p.to_string()]);
    }
    if !spec.target.is_empty() {
        if !ident_ok(&spec.target) {
            return Err(format!("Target inválido: {}", spec.target));
        }
        a.extend(["--target".into(), spec.target.clone()]);
    }
    let selects = ["compile", "run", "test", "build", "ls", "seed", "snapshot", "docs-generate"].contains(&cmd);
    if selects {
        for (flag, list) in [("--select", &spec.select), ("--exclude", &spec.exclude)] {
            if list.is_empty() {
                continue;
            }
            for s in list {
                if !selector_ok(s) {
                    return Err(format!("Seleção inválida: {s}"));
                }
            }
            a.push(flag.into());
            a.extend(list.iter().cloned());
        }
    } else if !spec.select.is_empty() || !spec.exclude.is_empty() {
        return Err(format!("dbt {cmd} não aceita seleção."));
    }
    if spec.full_refresh {
        if !["run", "build", "seed"].contains(&cmd) {
            return Err(format!("--full-refresh não se aplica a dbt {cmd}."));
        }
        a.push("--full-refresh".into());
    }
    if let Some(v) = &spec.vars {
        if !v.is_object() {
            return Err("--vars precisa ser um objeto JSON.".into());
        }
        if v.as_object().is_some_and(|m| !m.is_empty()) {
            a.extend(["--vars".into(), v.to_string()]);
        }
    }
    if let Some(t) = spec.threads {
        if !(1..=64).contains(&t) {
            return Err("Threads deve ficar entre 1 e 64.".into());
        }
        if cmd != "ls" && cmd != "deps" && cmd != "docs-serve" {
            a.extend(["--threads".into(), t.to_string()]);
        }
    }
    if spec.fail_fast && ["run", "test", "build", "seed", "snapshot"].contains(&cmd) {
        a.push("--fail-fast".into());
    }
    match cmd {
        "ls" => a.extend(["--output".into(), "json".into(), "--quiet".into()]),
        "docs-serve" => {
            if spec.port == 0 {
                return Err("Porta não definida.".into());
            }
            a.extend(["--port".into(), spec.port.to_string(), "--host".into(), "127.0.0.1".into(), "--no-browser".into()]);
        }
        _ => {}
    }
    Ok(a)
}

/// `docker run` arguments for the Docker runtime. Secrets are passed by name (`-e NAME`), so
/// their values come from the docker CLI's environment and never appear in the command line.
pub fn docker_args(spec: &RunSpec, image: &str, name: &str, project_dir: &str, profiles_dir: Option<&str>, env_names: &[String]) -> Result<Vec<String>, String> {
    let mut a: Vec<String> = vec!["run".into(), "--rm".into(), "-i".into(), "--name".into(), name.into(), "--label".into(), "dev.rits.plugin=dbt".into()];
    a.extend(["--add-host".into(), "host.docker.internal:host-gateway".into()]);
    a.extend(["-v".into(), format!("{project_dir}:/usr/app"), "-w".into(), "/usr/app".into()]);
    if let Some(p) = profiles_dir {
        a.extend(["-v".into(), format!("{p}:/rits/profiles:ro")]);
    }
    if spec.command == "docs-serve" {
        a.extend(["-p".into(), format!("127.0.0.1:{}:{}", spec.port, spec.port)]);
    }
    for n in env_names {
        a.extend(["-e".into(), n.clone()]);
    }
    a.push(image.into());
    let mut inner = spec.clone();
    if inner.command == "docs-serve" {
        // inside the container the server must listen on all interfaces; the published port stays on 127.0.0.1
        let mut args = build_args(&inner, "/usr/app", profiles_dir.map(|_| "/rits/profiles"))?;
        if let Some(i) = args.iter().position(|x| x == "127.0.0.1") {
            args[i] = "0.0.0.0".into();
        }
        a.extend(args);
        return Ok(a);
    }
    inner.project_dir = "/usr/app".into();
    a.extend(build_args(&inner, "/usr/app", profiles_dir.map(|_| "/rits/profiles"))?);
    Ok(a)
}

#[derive(Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub core: String,
    pub major: u32,
    pub adapters: Vec<(String, String)>,
    /// dbt v2 (new engine): not supported by this plugin version.
    pub v2: bool,
}

/// Parses `dbt --version` (dbt Core v1 layout: "Core: - installed: X" and "Plugins: - name: X").
pub fn parse_version(out: &str) -> VersionInfo {
    let clean: String = out.chars().filter(|c| *c != '\u{1b}').collect();
    let mut v = VersionInfo::default();
    let mut in_plugins = false;
    for line in clean.lines() {
        let l = line.trim();
        if l.starts_with("Plugins:") {
            in_plugins = true;
            continue;
        }
        if l.starts_with("Core:") {
            in_plugins = false;
            continue;
        }
        if let Some(rest) = l.strip_prefix("- installed:") {
            v.core = rest.trim().split_whitespace().next().unwrap_or("").to_string();
        } else if in_plugins {
            if let Some(rest) = l.strip_prefix("- ") {
                if let Some((name, ver)) = rest.split_once(':') {
                    v.adapters.push((name.trim().to_string(), ver.trim().split_whitespace().next().unwrap_or("").to_string()));
                }
            }
        } else if v.core.is_empty() {
            // other layouts: "dbt-fusion 2.0.1", "dbt 2.1.0"
            let low = l.to_lowercase();
            if let Some(i) = low.find("dbt") {
                if let Some(ver) = low[i..].split_whitespace().nth(1) {
                    if ver.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                        v.core = ver.to_string();
                    }
                }
            }
        }
    }
    v.major = v.core.split('.').next().and_then(|m| m.parse().ok()).unwrap_or(0);
    v.v2 = v.major >= 2;
    v
}

/// `profile:` of dbt_project.yml (a single scalar; quotes allowed).
pub fn project_profile_name(yml: &str) -> Option<String> {
    for line in yml.lines() {
        if let Some(rest) = line.strip_prefix("profile:") {
            let v = rest.split('#').next().unwrap_or("").trim().trim_matches(|c| c == '"' || c == '\'');
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

// ---------------- state and commands ----------------

#[derive(Default)]
pub struct DbtState {
    /// Artifact folders with a run in progress (one at a time: dbt writes target/ in place).
    locks: Mutex<HashSet<String>>,
    /// proc id -> (lock key, docker container name)
    runs: Mutex<HashMap<String, (String, String)>>,
}

fn secrets() -> Arc<dyn SecretStore> {
    Arc::new(OsStore)
}

const DOC: &str = "dbt-profiles";

fn load_profiles(app: &AppHandle) -> Result<Vec<Profile>, String> {
    Ok(serde_json::from_value(store::read_doc(app, DOC)?).unwrap_or_default())
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

fn lock_key(project_dir: &str) -> String {
    let p = std::fs::canonicalize(project_dir).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| project_dir.to_string());
    format!("{}/target", p.replace('\\', "/").trim_end_matches('/').to_lowercase())
}

#[tauri::command]
pub fn dbt_profiles(app: AppHandle) -> Result<Vec<Value>, String> {
    let sec = secrets();
    Ok(load_profiles(&app)?
        .into_iter()
        .map(|p| {
            let mut v = serde_json::to_value(&p).unwrap_or(Value::Null);
            let has: Vec<String> = p.targets.iter().filter(|t| !t.conn_id.is_empty() || sec.get(&password_key(&p.id, &t.name)).ok().flatten().is_some()).map(|t| t.name.clone()).collect();
            v["targetsWithPassword"] = serde_json::json!(has);
            v
        })
        .collect())
}

/// Saves a managed profile and writes its profiles.yml. `passwords` (target -> password) and
/// `secret_env` (name -> value) go to the OS store; empty values keep what is stored.
#[tauri::command]
pub fn dbt_save_profile(app: AppHandle, mut profile: Profile, passwords: HashMap<String, String>, secret_env: HashMap<String, String>) -> Result<Profile, String> {
    if profile.id.is_empty() {
        profile.id = format!("dbt{}", crate::secrets::random_secret(6)?.to_lowercase().replace(['-', '_'], "x"));
    }
    for e in &profile.env {
        if !env_name_ok(&e.name) {
            return Err(format!("Nome de variável inválido: {} (letras, números e _; o prefixo RITS_ é reservado)", e.name));
        }
    }
    let conns: HashMap<String, store::ConnConfig> = store::load(&app)?.into_iter().map(|c| (c.id.clone(), c)).collect();
    let yml = render_profile(&profile, &conns)?;
    let sec = secrets();
    for (t, pw) in passwords.iter().filter(|(_, v)| !v.is_empty()) {
        sec.set(&password_key(&profile.id, t), pw)?;
    }
    for (n, v) in secret_env.iter().filter(|(_, v)| !v.is_empty()) {
        sec.set(&env_key(&profile.id, n), v)?;
    }
    let d = profiles_dir(&config_dir(&app)?, &profile.id)?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let tmp = d.join("profiles.yml.tmp");
    std::fs::write(&tmp, yml).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, d.join("profiles.yml")).map_err(|e| e.to_string())?;
    let mut all = load_profiles(&app)?;
    match all.iter_mut().find(|p| p.id == profile.id) {
        Some(x) => *x = profile.clone(),
        None => all.push(profile.clone()),
    }
    store::write_doc(&app, DOC, &serde_json::to_value(&all).map_err(|e| e.to_string())?)?;
    Ok(profile)
}

#[tauri::command]
pub fn dbt_delete_profile(app: AppHandle, id: String) -> Result<(), String> {
    let mut all = load_profiles(&app)?;
    if let Some(p) = all.iter().find(|p| p.id == id) {
        let sec = secrets();
        for t in &p.targets {
            sec.delete(&password_key(&id, &t.name))?;
        }
        for e in &p.env {
            sec.delete(&env_key(&id, &e.name))?;
        }
    }
    all.retain(|p| p.id != id);
    store::write_doc(&app, DOC, &serde_json::to_value(&all).map_err(|e| e.to_string())?)?;
    if let Ok(d) = profiles_dir(&config_dir(&app)?, &id) {
        let _ = std::fs::remove_dir_all(d);
    }
    Ok(())
}

/// Environment for a run: password of the selected target and the profile's variables.
fn run_env(app: &AppHandle, spec: &RunSpec) -> Result<(HashMap<String, String>, Option<PathBuf>), String> {
    let mut env = HashMap::new();
    if spec.profile_id.is_empty() {
        let pd = if spec.profiles_dir.is_empty() { None } else { Some(PathBuf::from(&spec.profiles_dir)) };
        return Ok((env, pd));
    }
    let p = load_profiles(app)?.into_iter().find(|p| p.id == spec.profile_id).ok_or("Perfil do dbt não encontrado.")?;
    let tname = if spec.target.is_empty() { p.default_target.clone() } else { spec.target.clone() };
    let t = p.targets.iter().find(|t| t.name == tname).ok_or_else(|| format!("Target \"{tname}\" não existe no perfil."))?;
    let sec = secrets();
    let pw = if !t.conn_id.is_empty() {
        store::get(app, &t.conn_id)?.password
    } else {
        sec.get(&password_key(&p.id, &t.name))?.unwrap_or_default()
    };
    env.insert("RITS_DBT_PASSWORD".into(), pw);
    for e in &p.env {
        let v = if e.secret { sec.get(&env_key(&p.id, &e.name))?.unwrap_or_default() } else { e.value.clone() };
        env.insert(e.name.clone(), v);
    }
    Ok((env, Some(profiles_dir(&config_dir(app)?, &p.id)?)))
}

/// Starts a dbt command. Output streams as proc-out/proc-exit (id = proc_id). A second run in
/// the same artifact folder is refused while the first is running.
#[tauri::command]
pub async fn dbt_run(app: AppHandle, window: tauri::Window, st: State<'_, DbtState>, procs: State<'_, Procs>, proc_id: String, spec: RunSpec) -> Result<u32, String> {
    if spec.project_dir.is_empty() || !Path::new(&spec.project_dir).is_dir() {
        return Err("Pasta do projeto dbt não encontrada.".into());
    }
    if spec.command != "init" && !Path::new(&spec.project_dir).join("dbt_project.yml").exists() {
        return Err("dbt_project.yml não encontrado na pasta selecionada.".into());
    }
    let (env, prof_dir) = run_env(&app, &spec)?;
    let key = lock_key(&spec.project_dir);
    let blocks = spec.command != "docs-serve" && spec.command != "init";
    if blocks {
        let mut l = st.locks.lock().await;
        if l.contains(&key) {
            return Err("Já existe uma execução do dbt neste projeto (a pasta target/ está em uso). Aguarde ou cancele a execução atual.".into());
        }
        l.insert(key.clone());
    }
    let prof = prof_dir.as_ref().map(|p| p.to_string_lossy().into_owned());
    let docker_name = format!("rits-dbt-{}", proc_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(24).collect::<String>());
    let built = if spec.runtime.kind == "docker" {
        let image = if spec.runtime.image.is_empty() { DBT_IMAGE.to_string() } else { spec.runtime.image.clone() };
        let names: Vec<String> = env.keys().cloned().collect();
        docker_args(&spec, &image, &docker_name, &spec.project_dir, prof.as_deref(), &names).map(|a| ("docker".to_string(), a))
    } else {
        if spec.runtime.dbt.is_empty() {
            Err("Executável do dbt não configurado (Configurações do plugin dbt).".to_string())
        } else {
            build_args(&spec, &spec.project_dir, prof.as_deref()).map(|a| (spec.runtime.dbt.clone(), a))
        }
    };
    let (program, args) = match built {
        Ok(x) => x,
        Err(e) => {
            st.locks.lock().await.remove(&key);
            return Err(e);
        }
    };
    let mut env = env;
    env.insert("DBT_USE_COLORS".into(), "false".into());
    let spec2 = SpawnSpec { id: proc_id.clone(), program, args, cwd: spec.project_dir.clone(), env, mode: "plain".into() };
    let (tx, rx) = tokio::sync::oneshot::channel();
    match procs.spawn_notify(app.clone(), spec2, window.label(), Some(tx)).await {
        Ok(pid) => {
            st.runs.lock().await.insert(proc_id.clone(), (if blocks { key.clone() } else { String::new() }, if spec.runtime.kind == "docker" { docker_name } else { String::new() }));
            let a = app.clone();
            tokio::spawn(async move {
                let _ = rx.await;
                let st = a.state::<DbtState>();
                let removed = st.runs.lock().await.remove(&proc_id);
                if let Some((k, _)) = removed {
                    st.locks.lock().await.remove(&k);
                }
            });
            Ok(pid)
        }
        Err(e) => {
            st.locks.lock().await.remove(&key);
            Err(e)
        }
    }
}

/// Cancels a run (kills the process tree; for Docker also stops the container).
#[tauri::command]
pub async fn dbt_cancel(st: State<'_, DbtState>, procs: State<'_, Procs>, proc_id: String) -> Result<(), String> {
    let docker = st.runs.lock().await.get(&proc_id).map(|(_, d)| d.clone()).unwrap_or_default();
    procs.kill(&proc_id).await;
    if !docker.is_empty() {
        let _ = crate::procs::capture("docker", &["kill".into(), docker], "", None, 20).await;
    }
    let removed = st.runs.lock().await.remove(&proc_id);
    if let Some((k, _)) = removed {
        st.locks.lock().await.remove(&k);
    }
    Ok(())
}

/// Plugin disabled: stop the plugin's runs (docs server included).
#[tauri::command]
pub async fn dbt_release(st: State<'_, DbtState>, procs: State<'_, Procs>) -> Result<(), String> {
    let runs: Vec<(String, (String, String))> = st.runs.lock().await.drain().collect();
    for (id, (_, docker)) in runs {
        procs.kill(&id).await;
        if !docker.is_empty() {
            let _ = crate::procs::capture("docker", &["kill".into(), docker], "", None, 20).await;
        }
    }
    st.locks.lock().await.clear();
    Ok(())
}

#[tauri::command]
pub async fn dbt_version(runtime: Runtime) -> Result<VersionInfo, String> {
    let out = if runtime.kind == "docker" {
        let image = if runtime.image.is_empty() { DBT_IMAGE.to_string() } else { runtime.image };
        crate::procs::capture("docker", &["run".into(), "--rm".into(), image, "--version".into()], "", None, 300).await?
    } else {
        if runtime.dbt.is_empty() {
            return Err("Executável do dbt não configurado.".into());
        }
        crate::procs::capture(&runtime.dbt, &["--version".into()], "", None, 60).await?
    };
    let v = parse_version(&format!("{}\n{}", out.stdout, out.stderr));
    if v.core.is_empty() {
        return Err(format!("Não foi possível identificar a versão do dbt:\n{}", format!("{}{}", out.stdout, out.stderr).chars().take(400).collect::<String>()));
    }
    Ok(v)
}

#[tauri::command]
pub fn dbt_project_profile(project_dir: String) -> Result<Option<String>, String> {
    let yml = std::fs::read_to_string(Path::new(&project_dir).join("dbt_project.yml")).map_err(|e| e.to_string())?;
    Ok(project_profile_name(&yml))
}

#[tauri::command]
pub fn dbt_artifacts(project_dir: String) -> Result<artifacts::Summary, String> {
    artifacts::summarize(Path::new(&project_dir))
}

/// Compiled SQL of a node (from target/compiled, as written by compile/run/build).
#[tauri::command]
pub fn dbt_compiled(project_dir: String, unique_id: String) -> Result<Option<String>, String> {
    artifacts::compiled_sql(Path::new(&project_dir), &unique_id)
}
