//! Migration Audit plugin (backend): structural analysis and reconciliation of data conversions
//! between a source and a target database, by deterministic logic only (SQL, metadata, explicit
//! rules and evidence comparison; no AI or inference services).
//!
//! The plugin audits; it never writes to the audited databases nor corrects data.
//! Modules: adapter (databases), canon (canonical values), engine (capture/compare),
//! evidence (sorted evidence files), analysis (suggestions/validation), runner (orchestration),
//! store (versioned atomic storage), report (exports).

pub mod adapter;
pub mod analysis;
pub mod canon;
pub mod engine;
pub mod evidence;
pub mod model;
pub mod report;
pub mod runner;
pub mod store;

use adapter::{Adapter, JobCtl};
use canon::Side;
use model::*;
use runner::{Progress, ProgressFn};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use store::Layout;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct AuditState {
    jobs: Mutex<HashMap<String, (JobCtl, String)>>,
}

impl AuditState {
    /// Page reloaded or window closed: cancel its jobs (partial results are recorded as such).
    pub async fn cancel_owner(&self, owner: &str) {
        for (ctl, o) in self.jobs.lock().await.values() {
            if o == owner {
                ctl.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
    }
}

fn layout(app: &AppHandle) -> Result<Layout, String> {
    Ok(Layout { root: app.path().app_config_dir().map_err(|e| e.to_string())?.join("migration-audit") })
}

fn new_id(prefix: &str) -> String {
    let t = now_ms();
    let r = crate::secrets::random_secret(4).unwrap_or_default().to_lowercase().replace(['-', '_'], "x");
    format!("{prefix}{}{r}", report::fmt_ms(t).replace([' ', ':', '-'], "").replace("UTC", ""))
}

fn conn_ref(app: &AppHandle, id: &str, db: &str) -> Result<(crate::store::ConnConfig, ConnRef), String> {
    let c = crate::store::get(app, id)?;
    adapter::dialect_of(&c.kind)?;
    let kind = serde_json::to_value(&c.kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
    let r = ConnRef { conn_id: c.id.clone(), name: c.name.clone(), kind, host: format!("{}:{}", c.host, c.port), database: if db.is_empty() { c.default_db() } else { db.to_string() }, version: String::new() };
    Ok((c, r))
}

fn emitter(app: &AppHandle, job: &str) -> ProgressFn {
    let a = app.clone();
    let id = job.to_string();
    Arc::new(move |p: Progress| {
        let _ = a.emit("audit-progress", json!({ "id": id, "progress": p }));
    })
}

async fn start_job(st: &AuditState, job: &str, owner: &str, budget: u64) -> Result<JobCtl, String> {
    let mut m = st.jobs.lock().await;
    if m.contains_key(job) {
        return Err("Já existe uma tarefa com este identificador.".into());
    }
    let ctl = JobCtl { budget, ..Default::default() };
    m.insert(job.to_string(), (ctl.clone(), owner.to_string()));
    Ok(ctl)
}

async fn end_job(st: &AuditState, job: &str) {
    st.jobs.lock().await.remove(job);
}

#[tauri::command]
pub fn audit_capabilities() -> Vec<adapter::Capability> {
    adapter::capabilities()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub project: Project,
    pub baselines: usize,
    pub runs: usize,
}

#[tauri::command]
pub fn audit_projects(app: AppHandle) -> Result<Vec<ProjectSummary>, String> {
    let l = layout(&app)?;
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(&l.root) {
        for e in rd.flatten() {
            let p = e.path().join("project.json");
            if let Ok(project) = store::read_json::<Project>(&p) {
                let count = |d: &str| std::fs::read_dir(e.path().join(d)).map(|r| r.count()).unwrap_or(0);
                out.push(ProjectSummary { baselines: count("baselines"), runs: count("runs"), project });
            }
        }
    }
    out.sort_by(|a, b| b.project.updated.cmp(&a.project.updated));
    Ok(out)
}

#[tauri::command]
pub fn audit_load(app: AppHandle, id: String) -> Result<Value, String> {
    let d = layout(&app)?.project(&id)?;
    let p: Project = store::read_json(&d.join("project.json"))?;
    let m: Mappings = store::read_json(&d.join("mappings.json")).unwrap_or(Mappings { format: FORMAT, ..Default::default() });
    let ss: Option<Structure> = store::read_json(&d.join("structure-source.json")).ok();
    let ts: Option<Structure> = store::read_json(&d.join("structure-target.json")).ok();
    Ok(json!({ "project": p, "mappings": m, "sourceStructure": ss, "targetStructure": ts }))
}

/// Saves the project (no credentials: connections are referenced by id).
#[tauri::command]
pub fn audit_save_project(app: AppHandle, mut project: Project) -> Result<Project, String> {
    if project.name.trim().is_empty() {
        return Err("Dê um nome ao projeto de auditoria.".into());
    }
    if project.id.is_empty() {
        project.id = new_id("ma");
        project.created = now_ms();
    }
    let (_, s) = conn_ref(&app, &project.source.conn_id, &project.source.database)?;
    let (_, t) = conn_ref(&app, &project.target.conn_id, &project.target.database)?;
    project.source = ConnRef { version: project.source.version.clone(), ..s };
    project.target = ConnRef { version: project.target.version.clone(), ..t };
    project.format = FORMAT;
    project.updated = now_ms();
    let d = layout(&app)?.project(&project.id)?;
    store::write_json_atomic(&d.join("project.json"), &project)?;
    if !d.join("mappings.json").exists() {
        store::write_json_atomic(&d.join("mappings.json"), &Mappings { format: FORMAT, ..Default::default() })?;
    }
    Ok(project)
}

/// Saves mappings with a new version (runs keep the exact version they used).
#[tauri::command]
pub fn audit_save_mappings(app: AppHandle, id: String, mut mappings: Mappings) -> Result<Mappings, String> {
    let d = layout(&app)?.project(&id)?;
    let old: Mappings = store::read_json(&d.join("mappings.json")).unwrap_or_default();
    mappings.format = FORMAT;
    mappings.version = old.version + 1;
    let mut seen = std::collections::HashSet::new();
    for u in &mappings.units {
        if !store::valid_id(&u.id) || !seen.insert(u.id.clone()) {
            return Err(format!("Identificador de unidade inválido ou repetido: {}", u.id));
        }
    }
    store::write_json_atomic(&d.join("mappings.json"), &mappings)?;
    Ok(mappings)
}

/// Deletes a project with its baselines, runs and exports (explicit action, confirmed in the UI;
/// the folder goes to the system trash).
#[tauri::command]
pub fn audit_delete_project(app: AppHandle, id: String) -> Result<(), String> {
    let d = layout(&app)?.project(&id)?;
    if d.exists() {
        crate::fsx::to_trash(&[&d]).or_else(|_| std::fs::remove_dir_all(&d).map_err(|e| e.to_string())).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn audit_delete_artifact(app: AppHandle, project_id: String, kind: String, id: String) -> Result<(), String> {
    let l = layout(&app)?;
    let d = if kind == "baseline" { l.baseline(&project_id, &id)? } else { l.run(&project_id, &id)? };
    if d.exists() {
        crate::fsx::to_trash(&[&d]).or_else(|_| std::fs::remove_dir_all(&d).map_err(|e| e.to_string())).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn audit_schemas(app: AppHandle, conn_id: String, db: String) -> Result<Vec<String>, String> {
    let (c, _) = conn_ref(&app, &conn_id, &db)?;
    let mut a = Adapter::open(&c, &db, 60).await?;
    let r = a.schemas().await;
    a.close().await;
    r
}

/// Structure discovery of both sides (metadata only; no data is read).
#[tauri::command]
pub async fn audit_discover(app: AppHandle, window: tauri::Window, st: State<'_, AuditState>, job: String, id: String) -> Result<Value, String> {
    let d = layout(&app)?.project(&id)?;
    let mut project: Project = store::read_json(&d.join("project.json"))?;
    let ctl = start_job(&st, &job, window.label(), 0).await?;
    let prog = emitter(&app, &job);
    let mut out = json!({});
    for (side, key) in [("source", "sourceStructure"), ("target", "targetStructure")] {
        let (cref, scope) = if side == "source" { (project.source.clone(), project.source_scope.clone()) } else { (project.target.clone(), project.target_scope.clone()) };
        prog(Progress { phase: "descoberta".into(), unit: cref.name.clone(), message: format!("Lendo metadados de {}…", cref.name), ..Default::default() });
        let r = async {
            let (c, _) = conn_ref(&app, &cref.conn_id, &cref.database)?;
            let mut a = Adapter::open(&c, &cref.database, project.perf.timeout_secs).await?;
            let schemas = if scope.schemas.is_empty() { a.schemas().await? } else { scope.schemas.clone() };
            let s = a.discover(&schemas, &ctl).await;
            let v = a.version.clone();
            a.close().await;
            let mut s = s?;
            analysis::apply_scope(&mut s, &scope);
            Ok::<_, String>((s, v))
        }
        .await;
        match r {
            Ok((s, v)) => {
                store::write_json_atomic(&d.join(format!("structure-{side}.json")), &s)?;
                if side == "source" {
                    project.source.version = v;
                } else {
                    project.target.version = v;
                }
                out[key] = serde_json::to_value(&s).unwrap_or(Value::Null);
            }
            Err(e) => {
                end_job(&st, &job).await;
                return Err(format!("Descoberta da {}: {e}", if side == "source" { "origem" } else { "destino" }));
            }
        }
    }
    project.updated = now_ms();
    store::write_json_atomic(&d.join("project.json"), &project)?;
    end_job(&st, &job).await;
    Ok(out)
}

/// Deterministic suggestions (not saved; the UI shows them for confirmation).
#[tauri::command]
pub fn audit_suggest(app: AppHandle, id: String) -> Result<Vec<Unit>, String> {
    let d = layout(&app)?.project(&id)?;
    let p: Project = store::read_json(&d.join("project.json"))?;
    let m: Mappings = store::read_json(&d.join("mappings.json")).unwrap_or_default();
    let s: Structure = store::read_json(&d.join("structure-source.json")).map_err(|_| "Execute a descoberta estrutural primeiro.".to_string())?;
    let t: Structure = store::read_json(&d.join("structure-target.json")).map_err(|_| "Execute a descoberta estrutural primeiro.".to_string())?;
    Ok(analysis::suggest(&p, &m, &s, &t))
}

/// Validation of the mapping (static checks, plus query contracts on the databases).
#[tauri::command]
pub async fn audit_validate(app: AppHandle, id: String, check_queries: bool) -> Result<Value, String> {
    let d = layout(&app)?.project(&id)?;
    let p: Project = store::read_json(&d.join("project.json"))?;
    let m: Mappings = store::read_json(&d.join("mappings.json")).unwrap_or_default();
    let s: Option<Structure> = store::read_json(&d.join("structure-source.json")).ok();
    let t: Option<Structure> = store::read_json(&d.join("structure-target.json")).ok();
    let mut checks: Vec<analysis::UnitCheck> = m.units.iter().map(|u| analysis::check_unit(u, s.as_ref(), t.as_ref())).collect();
    if check_queries {
        let ctl = JobCtl::default();
        for (side, cref) in [("source", &p.source), ("target", &p.target)] {
            let queries: Vec<(usize, &Dataset)> = m
                .units
                .iter()
                .enumerate()
                .flat_map(|(i, u)| {
                    let mut v = vec![];
                    let ds = if side == "source" { &u.source } else { &u.target };
                    if ds.kind == "query" {
                        v.push((i, ds));
                    }
                    if let Some(mp) = &u.identity.map {
                        if mp.side == side && mp.dataset.kind == "query" {
                            v.push((i, &mp.dataset));
                        }
                    }
                    v
                })
                .collect();
            if queries.is_empty() {
                continue;
            }
            match conn_ref(&app, &cref.conn_id, &cref.database) {
                Ok((c, _)) => match Adapter::open(&c, &cref.database, 60).await {
                    Ok(mut a) => {
                        let _ = a.begin("snapshot", None).await;
                        for (i, ds) in queries {
                            if let Err(e) = a.describe(ds, None, &ctl).await {
                                checks[i].errors.push(format!("Consulta da {}: {e}", if side == "source" { "origem" } else { "destino" }));
                            }
                        }
                        a.end().await;
                        a.close().await;
                    }
                    Err(e) => checks.iter_mut().for_each(|c| c.warnings.push(format!("Consultas não validadas ({e})."))),
                },
                Err(e) => return Err(e),
            }
        }
    }
    let (uncovered, views) = s.as_ref().map(|s| analysis::uncovered(&m, s)).unwrap_or_default();
    Ok(json!({ "units": checks, "uncovered": uncovered, "views": views }))
}

fn evidence_estimate(p: &Project, s: Option<&Structure>, m: &Mappings) -> Value {
    // rough per-record size: key (~40 bytes hex) + digests per field (~35 bytes each)
    let mut rows = 0i64;
    let mut bytes = 0i64;
    for u in m.units.iter().filter(|u| u.confirmed) {
        let est = s.and_then(|s| s.tables.iter().find(|t| t.schema == u.source.schema && t.name == u.source.table)).and_then(|t| t.estimated_rows).unwrap_or(0);
        let nf = if p.evidence_level == "fields" { u.fields.iter().filter(|f| f.comparable()).count() as i64 } else { 0 };
        let per = 60 + nf * if p.store_values { 70 } else { 36 };
        rows += est;
        bytes += est * per;
    }
    json!({ "rows": rows, "bytes": bytes })
}

#[tauri::command]
pub fn audit_estimate(app: AppHandle, id: String) -> Result<Value, String> {
    let d = layout(&app)?.project(&id)?;
    let p: Project = store::read_json(&d.join("project.json"))?;
    let m: Mappings = store::read_json(&d.join("mappings.json")).unwrap_or_default();
    let s: Option<Structure> = store::read_json(&d.join("structure-source.json")).ok();
    Ok(evidence_estimate(&p, s.as_ref(), &m))
}

/// Captures an immutable baseline of the source (or of the target before the load).
#[tauri::command]
pub async fn audit_capture(app: AppHandle, window: tauri::Window, st: State<'_, AuditState>, job: String, id: String, side: String, unit_ids: Option<Vec<String>>, note: Option<String>) -> Result<BaselineManifest, String> {
    let l = layout(&app)?;
    let d = l.project(&id)?;
    let p: Project = store::read_json(&d.join("project.json"))?;
    let m: Mappings = store::read_json(&d.join("mappings.json")).unwrap_or_default();
    let ss: Option<Structure> = store::read_json(&d.join("structure-source.json")).ok();
    let ts: Option<Structure> = store::read_json(&d.join("structure-target.json")).ok();
    let is_source = side == "source";
    let cref = if is_source { &p.source } else { &p.target };
    let (cfg, _) = conn_ref(&app, &cref.conn_id, &cref.database)?;
    let units: Vec<Unit> = m.units.iter().filter(|u| u.confirmed && unit_ids.as_ref().is_none_or(|ids| ids.contains(&u.id))).cloned().collect();
    if units.is_empty() {
        return Err("Nenhuma unidade confirmada para capturar.".into());
    }
    let bid = new_id("bl");
    let dir = l.baseline(&id, &bid)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ctl = start_job(&st, &job, window.label(), p.perf.query_budget).await?;
    let prog = emitter(&app, &job);
    let mut plans = HashMap::new();
    for u in &units {
        let stypes = ss.as_ref().and_then(|s| s.tables.iter().find(|t| t.schema == u.source.schema && t.name == u.source.table)).map(|t| t.columns.iter().map(|c| (c.name.clone(), c.native.clone(), c.ltype.unwrap_or(canon::LType::Other))).collect::<adapter::ColTypes>());
        let ttypes = ts.as_ref().and_then(|s| s.tables.iter().find(|t| t.schema == u.target.schema && t.name == u.target.table)).map(|t| t.columns.iter().map(|c| (c.name.clone(), c.native.clone(), c.ltype.unwrap_or(canon::LType::Other))).collect::<adapter::ColTypes>());
        let (fp, _) = runner::plan_fields(u, stypes.as_ref(), ttypes.as_ref(), &p.perf);
        plans.insert(u.id.clone(), fp);
    }
    let started = now_ms();
    let structure = if is_source { ss.as_ref() } else { ts.as_ref() };
    let level = if is_source { p.evidence_level.as_str() } else { "identity" };
    let (mut caps, cons, errors) = runner::capture_side(&cfg, &cref.database, &units, &m.units, if is_source { Side::Source } else { Side::Target }, &plans, level, p.store_values && is_source, structure, &dir, &p.perf, &p.consistency, &ctl, &prog).await;
    for u in &units {
        if let Some(c) = caps.iter_mut().find(|c| c.unit_id == u.id) {
            let (_, skipped) = runner::plan_fields(u, None, None, &p.perf);
            for (k, v) in skipped {
                c.fields_skipped.entry(k).or_insert(v);
            }
        }
    }
    end_job(&st, &job).await;
    let status = if ctl.cancelled() {
        "cancelled"
    } else if caps.iter().all(|c| c.status == "complete") {
        "complete"
    } else if caps.iter().all(|c| c.status == "error") {
        "error"
    } else {
        "partial"
    };
    let mut man = BaselineManifest {
        format: FORMAT,
        kind: "baseline".into(),
        id: bid.clone(),
        project_id: id.clone(),
        plugin_version: PLUGIN_VERSION.into(),
        side: if is_source { "source".into() } else { "target-pre".into() },
        started_at: started,
        finished_at: now_ms(),
        status: status.into(),
        connection: cref.clone(),
        level: if p.perf.mode == "quick" { "estimated".into() } else { level.into() },
        store_values: p.store_values && is_source,
        mappings_version: m.version,
        units_config: units.clone(),
        consistency: cons,
        structure: structure.cloned(),
        units: caps,
        errors,
        note: note.unwrap_or_default(),
        digest: String::new(),
    };
    man.digest = store::baseline_digest(&man);
    store::write_json_atomic(&dir.join("manifest.json"), &man)?;
    Ok(man)
}

/// Reconciles the target against a baseline. Results are a new immutable run (history is kept).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn audit_reconcile(app: AppHandle, window: tauri::Window, st: State<'_, AuditState>, job: String, id: String, baseline_id: String, pre_baseline_id: Option<String>, unit_ids: Option<Vec<String>>, check_source: bool) -> Result<RunManifest, String> {
    let l = layout(&app)?;
    let d = l.project(&id)?;
    let p: Project = store::read_json(&d.join("project.json"))?;
    let m: Mappings = store::read_json(&d.join("mappings.json")).unwrap_or_default();
    let ts: Option<Structure> = store::read_json(&d.join("structure-target.json")).ok();
    let bdir = l.baseline(&id, &baseline_id)?;
    let (bl, integ) = store::verify_baseline(&bdir);
    let bl = bl.ok_or_else(|| format!("Baseline ilegível: {}", integ.problems.join("; ")))?;
    if !integ.ok {
        return Err(format!("A baseline não pode ser usada: {}", integ.problems.join("; ")));
    }
    if bl.side != "source" {
        return Err("Escolha uma baseline da origem para reconciliar.".into());
    }
    let pre = match &pre_baseline_id {
        Some(pid) if !pid.is_empty() => {
            let pd = l.baseline(&id, pid)?;
            let (pm, pi) = store::verify_baseline(&pd);
            let pm = pm.ok_or("Baseline do destino ilegível")?;
            if !pi.ok {
                return Err(format!("A baseline do destino não pode ser usada: {}", pi.problems.join("; ")));
            }
            Some((pm, pd))
        }
        _ => None,
    };
    let (tcfg, _) = conn_ref(&app, &p.target.conn_id, &p.target.database)?;
    let scfg = if check_source || m.units.iter().any(|u| u.identity.map.as_ref().is_some_and(|mp| mp.side == "source")) { conn_ref(&app, &p.source.conn_id, &p.source.database).ok().map(|x| x.0) } else { None };
    let rid = new_id("run");
    let rdir = l.run(&id, &rid)?;
    std::fs::create_dir_all(&rdir).map_err(|e| e.to_string())?;
    let ctl = start_job(&st, &job, window.label(), p.perf.query_budget).await?;
    let prog = emitter(&app, &job);
    let inp = runner::ReconcileInput {
        project: &p,
        current: &m,
        baseline: &bl,
        baseline_dir: &bdir,
        pre: pre.as_ref().map(|(m, d)| (m, d.as_path())),
        source_cfg: if check_source { scfg.as_ref() } else { None },
        target_cfg: &tcfg,
        target_structure: ts.as_ref(),
        run_dir: &rdir,
        unit_ids: unit_ids.as_deref(),
    };
    let mut run = runner::reconcile(inp, &ctl, &prog).await;
    end_job(&st, &job).await;
    run.id = rid;
    run.digest = store::run_digest(&run);
    store::write_json_atomic(&rdir.join("manifest.json"), &run)?;
    // retention: drop the oldest runs beyond the configured number (explicit setting)
    if p.perf.retention > 0 {
        if let Ok(rd) = std::fs::read_dir(d.join("runs")) {
            let mut all: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
            all.sort();
            while all.len() > p.perf.retention {
                let old = all.remove(0);
                let _ = crate::fsx::to_trash(&[&old]).or_else(|_| std::fs::remove_dir_all(&old).map_err(|e| e.to_string()));
            }
        }
    }
    Ok(run)
}

#[tauri::command]
pub async fn audit_cancel(st: State<'_, AuditState>, job: String) -> Result<(), String> {
    if let Some((ctl, _)) = st.jobs.lock().await.get(&job) {
        ctl.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

/// Plugin disabled: cancel the plugin's jobs (its connections close with them). Projects,
/// baselines and runs stay on disk.
#[tauri::command]
pub async fn audit_release(st: State<'_, AuditState>) -> Result<(), String> {
    for (ctl, _) in st.jobs.lock().await.values() {
        ctl.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

/// Baselines and runs of a project, with their integrity.
#[tauri::command]
pub fn audit_history(app: AppHandle, id: String) -> Result<Value, String> {
    let d = layout(&app)?.project(&id)?;
    let mut baselines = vec![];
    if let Ok(rd) = std::fs::read_dir(d.join("baselines")) {
        for e in rd.flatten() {
            let (m, i) = store::verify_baseline(&e.path());
            baselines.push(match m {
                Some(m) => json!({ "id": m.id, "side": m.side, "status": m.status, "startedAt": m.started_at, "finishedAt": m.finished_at, "level": m.level, "units": m.units.len(), "note": m.note, "mappingsVersion": m.mappings_version, "consistency": m.consistency.obtained, "integrity": i }),
                None => json!({ "id": e.file_name().to_string_lossy(), "status": "invalid", "integrity": i }),
            });
        }
    }
    let mut runs = vec![];
    if let Ok(rd) = std::fs::read_dir(d.join("runs")) {
        for e in rd.flatten() {
            let (m, i) = store::verify_run(&e.path());
            runs.push(match m {
                Some(m) => json!({ "id": m.id, "baselineId": m.baseline_id, "status": m.status, "startedAt": m.started_at, "finishedAt": m.finished_at, "summary": report::summary_line(&m), "integrity": i }),
                None => json!({ "id": e.file_name().to_string_lossy(), "status": "invalid", "integrity": i }),
            });
        }
    }
    let key = |v: &Value| v.get("startedAt").and_then(Value::as_i64).unwrap_or(0);
    baselines.sort_by_key(|v| -key(v));
    runs.sort_by_key(|v| -key(v));
    Ok(json!({ "baselines": baselines, "runs": runs }))
}

#[tauri::command]
pub fn audit_get(app: AppHandle, id: String, kind: String, artifact: String) -> Result<Value, String> {
    let l = layout(&app)?;
    if kind == "baseline" {
        let (m, i) = store::verify_baseline(&l.baseline(&id, &artifact)?);
        Ok(json!({ "manifest": m, "integrity": i }))
    } else {
        let (m, i) = store::verify_run(&l.run(&id, &artifact)?);
        Ok(json!({ "manifest": m, "integrity": i }))
    }
}

fn unit_meta(run: &RunManifest, unit_id: &str) -> (bool, Vec<bool>, Vec<String>) {
    let u = run.units_config.iter().find(|u| u.id == unit_id);
    let mask_key = u.map(report::key_sensitive).unwrap_or(true);
    let ur = run.units.iter().find(|x| x.unit_id == unit_id);
    let labels: Vec<String> = ur.map(|r| r.fields.iter().map(|f| f.label.clone()).collect()).unwrap_or_default();
    let sens: Vec<bool> = ur.map(|r| r.fields.iter().map(|f| u.and_then(|u| u.fields.iter().find(|x| x.id == f.field_id)).map(|x| x.sensitive || analysis::sensitive_name(&x.target_col)).unwrap_or(true)).collect()).unwrap_or_default();
    (mask_key, sens, labels)
}

fn finding_path(rdir: &Path, run: &RunManifest, unit_id: &str, kind: &str) -> Result<PathBuf, String> {
    let ur = run.units.iter().find(|u| u.unit_id == unit_id).ok_or("Unidade não encontrada na execução.")?;
    let ef = ur.findings.get(kind).ok_or("Não há esta lista para a unidade.")?;
    let name = Path::new(&ef.path).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    if name.is_empty() || name.contains("..") {
        return Err("Caminho de evidência inválido.".into());
    }
    let p = rdir.join(unit_id).join(&name);
    if !p.exists() {
        return Err(format!("Arquivo de evidência ausente: {name}"));
    }
    Ok(p)
}

/// A page of findings (paginated: the total is always reported). Values are masked unless
/// `reveal` (explicit user action).
#[tauri::command]
pub fn audit_findings(app: AppHandle, id: String, run_id: String, unit_id: String, kind: String, offset: usize, limit: usize, reveal: bool) -> Result<Value, String> {
    use std::io::BufRead;
    let rdir = layout(&app)?.run(&id, &run_id)?;
    let (run, _) = store::verify_run(&rdir);
    let run = run.ok_or("Execução ilegível.")?;
    let p = finding_path(&rdir, &run, &unit_id, &kind)?;
    let (mask_key, sens, labels) = unit_meta(&run, &unit_id);
    let f = std::fs::File::open(&p).map_err(|e| e.to_string())?;
    let mut rows = vec![];
    let mut total = 0usize;
    for l in std::io::BufReader::new(f).lines() {
        let l = l.map_err(|e| e.to_string())?;
        if total >= offset && rows.len() < limit.min(1000) {
            rows.push(report::render_finding(&kind, &l, mask_key, &sens, &labels, reveal));
        }
        total += 1;
    }
    Ok(json!({ "headers": report::headers(&kind), "rows": rows, "total": total, "masked": !reveal }))
}

/// Exports: manifest (json), report (html), summary (csv) or a findings list (csv).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn audit_export(app: AppHandle, id: String, run_id: String, format: String, unit_id: Option<String>, kind: Option<String>, detailed: bool, path: String) -> Result<u64, String> {
    let l = layout(&app)?;
    let rdir = l.run(&id, &run_id)?;
    let (run, integ) = store::verify_run(&rdir);
    let run = run.ok_or("Execução ilegível.")?;
    if !integ.ok {
        return Err(format!("A execução não pode ser exportada: {}", integ.problems.join("; ")));
    }
    let out = PathBuf::from(&path);
    if path.is_empty() || !out.is_absolute() {
        return Err("Escolha onde salvar o arquivo.".into());
    }
    let project: Project = store::read_json(&l.project(&id)?.join("project.json"))?;
    match format.as_str() {
        "json" => {
            store::write_json_atomic(&out, &report::sanitized_manifest(&run, detailed))?;
            Ok(1)
        }
        "html" => {
            let (bl, _) = store::verify_baseline(&l.baseline(&id, &run.baseline_id)?);
            let bl = bl.unwrap_or_default();
            let mut examples = vec![];
            for u in &run.units {
                let (mask_key, sens, labels) = unit_meta(&run, &u.unit_id);
                for kind in ["missing", "extra", "multiplicity", "fields", "orphans"] {
                    if let Ok(p) = finding_path(&rdir, &run, &u.unit_id, kind) {
                        use std::io::BufRead;
                        let rows: Vec<String> = std::fs::File::open(&p)
                            .map(|f| std::io::BufReader::new(f).lines().map_while(Result::ok).take(project.perf.max_examples.min(50)).map(|l| report::render_finding(kind, &l, mask_key, &sens, &labels, detailed).join(" · ")).collect())
                            .unwrap_or_default();
                        let label = match kind {
                            "missing" => "identidades ausentes no destino",
                            "extra" => "identidades extras no destino",
                            "multiplicity" => "multiplicidade diferente",
                            "fields" => "problemas de campos",
                            _ => "órfãos",
                        };
                        examples.push((u.unit_id.clone(), label.to_string(), rows));
                    }
                }
            }
            let html = report::html(&report::sanitized_manifest(&run, detailed), &bl, &project, &examples);
            std::fs::write(&out, html).map_err(|e| e.to_string())?;
            Ok(1)
        }
        "csv-summary" => {
            std::fs::write(&out, report::summary_csv(&run)).map_err(|e| e.to_string())?;
            Ok(run.units.len() as u64)
        }
        "csv" => {
            let uid = unit_id.ok_or("Escolha a unidade.")?;
            let kind = kind.ok_or("Escolha a lista.")?;
            let p = finding_path(&rdir, &run, &uid, &kind)?;
            let (mask_key, sens, labels) = unit_meta(&run, &uid);
            report::findings_csv(&p, &out, &kind, mask_key, &sens, &labels, detailed)
        }
        _ => Err("Formato de exportação desconhecido.".into()),
    }
}
