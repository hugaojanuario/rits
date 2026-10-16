//! Orchestration of captures (baselines) and reconciliations: opens the plugin's own read-only
//! connections, applies the consistency policy, runs units with bounded concurrency, and turns
//! comparison counters into per-dimension results without condensing them into a single score.

use super::adapter::{count_sql, select_sql, Adapter, ColTypes, JobCtl, CANCELLED};
use super::canon::{self, LType, Rules, Side};
use super::engine::{self, CaptureSpec, Capturer, CompareSpec, FieldCmp, FieldSpec, FieldSrc, KeySpec, MapCapturer};
use super::evidence::Findings;
use super::model::*;
use crate::store::ConnConfig;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: String,
    pub unit: String,
    pub processed: u64,
    pub total: Option<u64>,
    pub elapsed_ms: u64,
    pub message: String,
    pub queries: u64,
    pub disk_bytes: u64,
}

pub type ProgressFn = Arc<dyn Fn(Progress) + Send + Sync>;

/// One compared field, resolved against both structures.
#[derive(Debug, Clone)]
pub struct FieldPlan {
    pub fm: FieldMap,
    pub src_lt: LType,
    pub dst_lt: LType,
}

pub fn rules_digest(fm: &FieldMap) -> String {
    // tolerances are applied at comparison time and do not change the evidence
    let mut r = fm.rules.clone();
    r.tol_abs.clear();
    r.tol_rel.clear();
    let v = serde_json::json!({ "kind": fm.kind, "src": fm.source_cols, "sep": fm.sep, "index": fm.index, "constant": fm.constant, "rules": r });
    canon::digest(v.to_string().as_bytes())
}

pub fn identity_digest(id: &Identity, side: Side) -> String {
    let cols = if side == Side::Source { &id.source } else { &id.target };
    canon::digest(serde_json::json!({ "kind": id.kind, "cols": cols }).to_string().as_bytes())
}

fn lt_of(cols: &ColTypes, name: &str) -> LType {
    cols.iter().find(|c| c.0 == name).map(|c| c.2).unwrap_or(LType::Other)
}

fn table_types(s: Option<&Structure>, ds: &Dataset) -> Option<ColTypes> {
    let t = s?.tables.iter().find(|t| t.schema == ds.schema && t.name == ds.table)?;
    Some(t.columns.iter().map(|c| (c.name.clone(), c.native.clone(), c.ltype.unwrap_or(LType::Other))).collect())
}

/// Compared fields of a unit and the ones left out (with the reason).
pub fn plan_fields(u: &Unit, src: Option<&ColTypes>, dst: Option<&ColTypes>, perf: &Perf) -> (Vec<FieldPlan>, BTreeMap<String, String>) {
    let mut plans = vec![];
    let mut skipped = BTreeMap::new();
    for f in &u.fields {
        if !f.comparable() {
            if !f.confirmed && matches!(f.kind.as_str(), "map" | "concat" | "split" | "constant") {
                skipped.insert(f.id.clone(), "mapeamento não confirmado".into());
            }
            continue;
        }
        let dst_lt = dst.map(|d| lt_of(d, &f.target_col)).unwrap_or(LType::Other);
        let src_lt = match f.kind.as_str() {
            "map" => src.map(|s| lt_of(s, &f.source_cols[0])).unwrap_or(LType::Other),
            "concat" => LType::Text,
            _ => dst_lt,
        };
        if perf.exclude_lobs && (src_lt == LType::Binary || dst_lt == LType::Binary) {
            skipped.insert(f.id.clone(), "campo binário excluído pela configuração de desempenho".into());
            continue;
        }
        plans.push(FieldPlan { fm: f.clone(), src_lt, dst_lt });
    }
    (plans, skipped)
}

struct Wanted {
    cols: Vec<String>,
}

impl Wanted {
    fn idx(&mut self, c: &str) -> usize {
        match self.cols.iter().position(|x| x == c) {
            Some(i) => i,
            None => {
                self.cols.push(c.to_string());
                self.cols.len() - 1
            }
        }
    }
}

pub struct CaptureJob<'a> {
    pub unit: &'a Unit,
    pub all_units: &'a [Unit],
    pub side: Side,
    pub fields: &'a [FieldPlan],
    /// Key rules per relationship (from the parent unit's identity).
    pub level: &'a str,
    pub store_values: bool,
    pub structure: Option<&'a Structure>,
    pub dir: &'a Path,
    pub perf: &'a Perf,
    pub consistency: &'a str,
}

fn fail(u: &Unit, status: &str, e: String) -> UnitCapture {
    UnitCapture { unit_id: u.id.clone(), status: status.into(), error: e, count_kind: "none".into(), ..Default::default() }
}

/// Captures one unit on one side.
pub async fn capture_unit(ad: &mut Adapter, job: &CaptureJob<'_>, ctl: &JobCtl, progress: &ProgressFn) -> UnitCapture {
    let started = std::time::Instant::now();
    let u = job.unit;
    let (ds, keys) = if job.side == Side::Source { (&u.source, &u.identity.source) } else { (&u.target, &u.identity.target) };
    let mode = job.perf.mode.as_str();
    let q0 = ctl.queries.load(Ordering::Relaxed);
    let cols = match ad.describe(ds, job.structure, ctl).await {
        Ok(c) => c,
        Err(e) => return fail(u, if ctl.cancelled() { "cancelled" } else { "error" }, format!("Não foi possível ler a estrutura do conjunto de dados: {e}")),
    };
    let mut uc = UnitCapture { unit_id: u.id.clone(), identity_digest: identity_digest(&u.identity, job.side), ..Default::default() };
    // quick analysis: catalog estimates only, flagged as such
    if mode == "quick" {
        uc.status = "complete".into();
        uc.count_kind = "estimated".into();
        uc.rows = job.structure.and_then(|s| s.tables.iter().find(|t| t.schema == ds.schema && t.name == ds.table)).and_then(|t| t.estimated_rows).map(|n| n.max(0) as u64);
        if ds.kind == "query" || uc.rows.is_none() {
            uc.count_kind = "none".into();
            uc.warnings.push("Sem estimativa disponível para este conjunto de dados.".into());
        }
        return uc;
    }
    let identity_on = matches!(u.identity.kind.as_str(), "key" | "map" | "content");
    let records = identity_on && job.level != "basic" && mode != "volume";
    let write_fields = records && job.level == "fields" && (mode == "fields" || mode == "deep");
    let mut w = Wanted { cols: vec![] };
    let key = KeySpec { cols: if matches!(u.identity.kind.as_str(), "key" | "map") { keys.iter().map(|k| (w.idx(&k.column), lt_of(&cols, &k.column), k.rules.clone())).collect() } else { vec![] } };
    let fields: Vec<FieldSpec> = job
        .fields
        .iter()
        .map(|p| {
            let f = &p.fm;
            let src = if job.side == Side::Target && f.target_col.is_empty() {
                FieldSrc::Const(String::new())
            } else if job.side == Side::Target {
                FieldSrc::Col(w.idx(&f.target_col))
            } else {
                match f.kind.as_str() {
                    "concat" => FieldSrc::Concat(f.source_cols.iter().map(|c| w.idx(c)).collect(), f.sep.clone()),
                    "split" => FieldSrc::Split(w.idx(&f.source_cols[0]), f.sep.clone(), f.index),
                    "constant" => FieldSrc::Const(f.constant.clone()),
                    _ => FieldSrc::Col(w.idx(&f.source_cols[0])),
                }
            };
            let lt = if job.side == Side::Target { lt_of(&cols, &f.target_col) } else if f.kind == "map" { lt_of(&cols, &f.source_cols[0]) } else { p.src_lt };
            FieldSpec { id: f.id.clone(), src, lt, rules: f.rules.clone() }
        })
        .collect();
    let mut fks = vec![];
    for r in &u.relationships {
        let parent = job.all_units.iter().find(|x| x.id == r.parent_unit);
        let pk = parent.map(|p| if job.side == Side::Source { &p.identity.source } else { &p.identity.target });
        let rcols = if job.side == Side::Source { &r.source_cols } else { &r.target_cols };
        let cols_spec: Vec<(usize, LType, Rules)> = rcols
            .iter()
            .enumerate()
            .map(|(i, c)| (w.idx(c), lt_of(&cols, c), pk.and_then(|k| k.get(i)).map(|k| k.rules.clone()).unwrap_or_default()))
            .collect();
        fks.push(KeySpec { cols: cols_spec });
    }
    let exclusions: Vec<Vec<Pred>> = if job.side == Side::Source { u.exclusions.iter().map(|e| e.predicate.clone()).collect() } else { vec![] };
    let extra = if job.side == Side::Target { u.target_scope.clone() } else { vec![] };
    let excl_idx = if exclusions.is_empty() { None } else { Some(w.cols.len()) };
    let built = match select_sql(ad.dialect, ds, &cols, &w.cols, &exclusions, &extra) {
        Ok(b) => b,
        Err(e) => return fail(u, "error", e),
    };
    uc.sql.push(built.sql.clone());
    uc.fk_count = fks.len();
    uc.field_ids = if write_fields { job.fields.iter().map(|p| p.fm.id.clone()).collect() } else { vec![] };
    for p in job.fields {
        uc.rules_digest.insert(p.fm.id.clone(), rules_digest(&p.fm));
    }
    let spec = CaptureSpec { side: job.side, key, content_identity: u.identity.kind == "content", fields, fks, excl_idx, store_values: job.store_values, records, write_fields };
    let name = if job.side == Side::Source { format!("{}.src", u.id) } else { format!("{}.dst", u.id) };
    let mut cap = match Capturer::new(spec, job.dir, &name, job.perf.batch_rows.max(1), job.perf.disk_mb * 1_048_576) {
        Ok(c) => c,
        Err(e) => return fail(u, "error", e),
    };
    // without a snapshot, detect changes during the capture by counting before and after
    let before = if job.consistency == "none" {
        match count_sql(ad.dialect, ds, &cols, &extra) {
            Ok(b) => ad.count(&b, ctl).await.ok(),
            Err(_) => None,
        }
    } else {
        None
    };
    let unit_name = u.name.clone();
    let p2 = progress.clone();
    let ctl2 = ctl.clone();
    let mut last = std::time::Instant::now();
    let mut n = 0u64;
    let total_hint = job.structure.and_then(|s| s.tables.iter().find(|t| t.schema == ds.schema && t.name == ds.table)).and_then(|t| t.estimated_rows).map(|x| x.max(0) as u64);
    let phase = if job.side == Side::Source { "baseline" } else { "destino" };
    let r = ad
        .stream(&built, job.perf.batch_rows.clamp(100, 10_000), ctl, &mut |row| {
            n += 1;
            ctl2.processed.fetch_add(1, Ordering::Relaxed);
            if last.elapsed().as_millis() > 300 {
                last = std::time::Instant::now();
                p2(Progress { phase: phase.into(), unit: unit_name.clone(), processed: n, total: total_hint.map(|_| 0).and(None), elapsed_ms: started.elapsed().as_millis() as u64, message: String::new(), queries: ctl2.queries.load(Ordering::Relaxed), disk_bytes: 0 });
            }
            cap.push(&row)
        })
        .await;
    uc.queries = ctl.queries.load(Ordering::Relaxed) - q0;
    uc.elapsed_ms = started.elapsed().as_millis() as u64;
    if let Err(e) = r {
        let partial_rows = cap.rows;
        cap.abort();
        let cancelled = e == CANCELLED || ctl.cancelled();
        uc.status = if cancelled { "cancelled".into() } else { "error".into() };
        uc.error = if cancelled { "Captura cancelada: esta unidade não foi verificada.".into() } else { e };
        uc.count_kind = "none".into();
        uc.warnings.push(format!("{partial_rows} linhas lidas antes da interrupção (descartadas: evidência incompleta não é usada)."));
        return uc;
    }
    match cap.finish() {
        Ok(out) => {
            uc.status = "complete".into();
            uc.count_kind = "exact".into();
            uc.rows = Some(out.rows);
            uc.excluded = out.excluded;
            uc.null_keys = out.null_keys;
            uc.distinct_keys = out.distinct_keys;
            uc.duplicate_keys = out.duplicate_keys;
            uc.collisions = out.collisions;
            uc.profile = out.profile;
            uc.evidence = out.evidence;
            uc.excluded_evidence = out.excluded_evidence;
            uc.sorted_runs = out.runs;
        }
        Err(e) => {
            uc.status = "partial".into();
            uc.error = e;
            uc.count_kind = "none".into();
        }
    }
    if let Some(b) = before {
        let after = match count_sql(ad.dialect, ds, &cols, &extra) {
            Ok(q) => ad.count(&q, ctl).await.ok(),
            Err(_) => None,
        };
        let seen = uc.rows.unwrap_or(0) + uc.excluded;
        if after != Some(b) || seen != b {
            uc.warnings.push(format!("Os dados mudaram durante a captura sem snapshot (antes: {b}, lidos: {seen}, depois: {}). Resultado potencialmente inconsistente.", after.map(|x| x.to_string()).unwrap_or("?".into())));
        }
    }
    uc
}

/// Opens the connections of a side and runs the units with bounded concurrency. PostgreSQL
/// workers import the coordinator's snapshot; MySQL workers have their own snapshots; driver-based
/// databases run sequentially in a single transaction.
#[allow(clippy::too_many_arguments)]
pub async fn capture_side(cfg: &ConnConfig, db: &str, units: &[Unit], all_units: &[Unit], side: Side, plans: &HashMap<String, Vec<FieldPlan>>, level: &str, store_values: bool, structure: Option<&Structure>, dir: &Path, perf: &Perf, consistency: &str, ctl: &JobCtl, progress: &ProgressFn) -> (Vec<UnitCapture>, Consistency, Vec<String>) {
    let mut cons = Consistency { requested: consistency.into(), ..Default::default() };
    let mut errors = vec![];
    let mut coord = match Adapter::open(cfg, db, perf.timeout_secs).await {
        Ok(a) => a,
        Err(e) => {
            errors.push(format!("Não foi possível conectar a \"{}\": {e}", cfg.name));
            return (units.iter().map(|u| fail(u, "error", format!("Sem conexão: {e}"))).collect(), cons, errors);
        }
    };
    let begin_mode = if consistency == "none" { "none" } else { "snapshot" };
    let (obtained, snap) = match coord.begin(begin_mode, None).await {
        Ok(x) => x,
        Err(e) => {
            errors.push(format!("Não foi possível iniciar a transação de leitura: {e}"));
            coord.close().await;
            return (units.iter().map(|u| fail(u, "error", e.clone())).collect(), cons, errors);
        }
    };
    cons.obtained = obtained;
    if consistency == "frozen" {
        cons.notes.push("Base declarada congelada pelo usuário durante a captura (não verificável pelo plugin).".into());
    }
    if consistency == "watermark" {
        cons.notes.push("Recorte por lote/watermark definido pelos filtros das unidades.".into());
    }
    let mut workers = (perf.concurrency.max(1).min(perf.per_connection.max(1)) as usize).min(units.len().max(1));
    if coord.dialect != "postgres" && coord.dialect != "mysql" {
        workers = 1;
    }
    let mut adapters = vec![coord];
    for _ in 1..workers {
        match Adapter::open(cfg, db, perf.timeout_secs).await {
            Ok(mut a) => {
                let r = if a.dialect == "postgres" && snap.is_some() { a.begin(begin_mode, snap.as_deref()).await } else { a.begin(begin_mode, None).await };
                match r {
                    Ok(_) => adapters.push(a),
                    Err(e) => {
                        cons.notes.push(format!("Conexão extra recusada ({e}); usando menos conexões."));
                        a.close().await;
                        break;
                    }
                }
            }
            Err(e) => {
                cons.notes.push(format!("Conexão extra recusada ({e}); usando menos conexões."));
                break;
            }
        }
    }
    if adapters.len() > 1 {
        if adapters[0].dialect == "postgres" && snap.is_some() {
            cons.notes.push(format!("{} conexões compartilham o mesmo snapshot (pg_export_snapshot).", adapters.len()));
        } else if consistency != "none" {
            cons.obtained = "snapshot por conexão (as unidades em conexões diferentes podem ver instantes diferentes)".into();
            cons.notes.push(format!("{} conexões paralelas, cada uma com o seu snapshot: unidades não foram lidas no mesmo instante.", adapters.len()));
        }
    }
    let queue = Mutex::new(units.iter().collect::<std::collections::VecDeque<_>>());
    let results: Mutex<Vec<UnitCapture>> = Mutex::new(vec![]);
    let futs = adapters.iter_mut().map(|ad| {
        let queue = &queue;
        let results = &results;
        async move {
            loop {
                let next = queue.lock().await.pop_front();
                let Some(u) = next else { break };
                if ctl.cancelled() {
                    results.lock().await.push(fail(u, "cancelled", "Cancelada antes de iniciar: não verificada.".into()));
                    continue;
                }
                let fields = plans.get(&u.id).cloned().unwrap_or_default();
                let job = CaptureJob { unit: u, all_units, side, fields: &fields, level, store_values, structure, dir, perf, consistency };
                let uc = capture_unit(ad, &job, ctl, progress).await;
                results.lock().await.push(uc);
            }
        }
    });
    futures_util::future::join_all(futs).await;
    for a in adapters {
        let mut a = a;
        a.end().await;
        a.close().await;
    }
    let mut res = results.into_inner();
    res.sort_by_key(|r| units.iter().position(|u| u.id == r.unit_id).unwrap_or(usize::MAX));
    (res, cons, errors)
}

// ---------------- reconciliation ----------------

fn dim(result: &str, note: impl Into<String>) -> Dim {
    Dim { result: result.into(), note: note.into() }
}

pub struct ReconcileInput<'a> {
    pub project: &'a Project,
    pub current: &'a Mappings,
    pub baseline: &'a BaselineManifest,
    pub baseline_dir: &'a Path,
    pub pre: Option<(&'a BaselineManifest, &'a Path)>,
    pub source_cfg: Option<&'a ConnConfig>,
    pub target_cfg: &'a ConnConfig,
    pub target_structure: Option<&'a Structure>,
    pub run_dir: &'a Path,
    pub unit_ids: Option<&'a [String]>,
}

fn topo(units: Vec<Unit>) -> Vec<Unit> {
    let mut out: Vec<Unit> = vec![];
    let mut rest = units;
    while !rest.is_empty() {
        let before = rest.len();
        let mut i = 0;
        while i < rest.len() {
            let ready = rest[i].relationships.iter().all(|r| r.parent_unit == rest[i].id || out.iter().any(|o| o.id == r.parent_unit) || !rest.iter().any(|x| x.id == r.parent_unit));
            if ready {
                out.push(rest.remove(i));
            } else {
                i += 1;
            }
        }
        if rest.len() == before {
            out.append(&mut rest);
        }
    }
    out
}

pub async fn reconcile(inp: ReconcileInput<'_>, ctl: &JobCtl, progress: &ProgressFn) -> RunManifest {
    let p = inp.project;
    let bl = inp.baseline;
    let mut run = RunManifest { format: FORMAT, kind: "run".into(), project_id: p.id.clone(), plugin_version: PLUGIN_VERSION.into(), baseline_id: bl.id.clone(), started_at: now_ms(), target: p.target.clone(), mappings_version: inp.current.version, units_config: inp.current.units.clone(), ..Default::default() };
    if let Some((pre, _)) = inp.pre {
        run.target_pre_baseline_id = pre.id.clone();
    }
    let perf = &p.perf;
    // units: those of the baseline that still exist (frozen source config + current target config)
    let mut todo: Vec<Unit> = vec![];
    for bu in &bl.units_config {
        if inp.unit_ids.is_some_and(|ids| !ids.contains(&bu.id)) {
            continue;
        }
        match inp.current.units.iter().find(|u| u.id == bu.id) {
            Some(cu) if cu.confirmed => todo.push(cu.clone()),
            _ => {}
        }
    }
    let todo = topo(todo);
    let all_units = inp.current.units.clone();
    // target capture
    let mut plans: HashMap<String, Vec<FieldPlan>> = HashMap::new();
    let mut blocked: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut unit_errors: HashMap<String, String> = HashMap::new();
    for cu in &todo {
        let bu = bl.units_config.iter().find(|x| x.id == cu.id).unwrap();
        let bc = bl.units.iter().find(|x| x.unit_id == cu.id);
        let Some(bc) = bc.filter(|b| b.status == "complete") else {
            unit_errors.insert(cu.id.clone(), "A baseline não tem evidência completa desta unidade (não verificada na captura).".into());
            continue;
        };
        if identity_digest(&cu.identity, Side::Source) != bc.identity_digest || cu.identity.kind != bu.identity.kind {
            unit_errors.insert(cu.id.clone(), "A identidade da origem mudou desde a baseline: capture uma nova baseline para usar a nova regra.".into());
            continue;
        }
        let tt = if cu.target.kind == "table" { table_types(inp.target_structure, &cu.target) } else { None };
        let mut list = vec![];
        let mut bl_list = vec![];
        for fid in &bc.field_ids {
            let bf = bu.fields.iter().find(|f| &f.id == fid);
            let cf = cu.fields.iter().find(|f| &f.id == fid);
            match (bf, cf) {
                (Some(bf), Some(cf)) if cf.comparable() && rules_digest(cf) == bc.rules_digest.get(fid).cloned().unwrap_or_default() => {
                    let mut fm = bf.clone();
                    fm.target_col = cf.target_col.clone();
                    fm.rules.tol_abs = cf.rules.tol_abs.clone();
                    fm.rules.tol_rel = cf.rules.tol_rel.clone();
                    let dst_lt = tt.as_ref().map(|t| lt_of(t, &fm.target_col)).unwrap_or(LType::Other);
                    list.push(FieldPlan { fm, src_lt: LType::Other, dst_lt });
                    bl_list.push((fid.clone(), String::new()));
                }
                (Some(bf), Some(_)) => {
                    let mut fm = bf.clone();
                    fm.target_col = String::new();
                    list.push(FieldPlan { fm, src_lt: LType::Other, dst_lt: LType::Other });
                    bl_list.push((fid.clone(), "As regras ou as colunas de origem mudaram desde a baseline e a evidência não pode ser derivada: capture uma nova baseline.".into()));
                }
                (Some(bf), None) => {
                    let mut fm = bf.clone();
                    fm.target_col = String::new();
                    list.push(FieldPlan { fm, src_lt: LType::Other, dst_lt: LType::Other });
                    bl_list.push((fid.clone(), "Campo removido do mapeamento atual.".into()));
                }
                _ => {}
            }
        }
        plans.insert(cu.id.clone(), list);
        blocked.insert(cu.id.clone(), bl_list);
    }
    // a blocked field keeps its slot (alignment): its target_col is empty and the target side
    // writes an empty constant that is never compared (FieldCmp::blocked)
    let runnable: Vec<Unit> = todo.iter().filter(|u| !unit_errors.contains_key(&u.id)).cloned().collect();
    progress(Progress { phase: "destino".into(), message: "Lendo o destino…".into(), ..Default::default() });
    let target_dir = inp.run_dir.join("target");
    let _ = std::fs::create_dir_all(&target_dir);
    let level_bl = bl.level.clone();
    let tlevel = if bl.units.iter().any(|u| !u.field_ids.is_empty()) { "fields" } else { level_bl.as_str() };
    let mut perf_t = perf.clone();
    if perf_t.mode == "quick" && bl.units.iter().any(|u| u.count_kind == "exact") {
        perf_t.mode = "volume".into();
    }
    let (tcaps, tcons, terrs) = capture_side(inp.target_cfg, &p.target.database, &runnable, &all_units, Side::Target, &plans, tlevel, p.store_values, inp.target_structure, &target_dir, &perf_t, &p.consistency, ctl, progress).await;
    run.consistency = Consistency { requested: p.consistency.clone(), obtained: format!("origem: {} · destino: {}", bl.consistency.obtained, tcons.obtained), notes: [bl.consistency.notes.clone(), tcons.notes.clone(), vec!["Origem e destino foram lidos em momentos diferentes: a comparação usa a baseline congelada da origem.".into()]].concat() };
    run.errors.extend(terrs);
    // id maps (captured now: they are produced by the conversion)
    let mut maps: HashMap<String, PathBuf> = HashMap::new();
    let mut results: Vec<UnitResult> = vec![];
    for cu in &todo {
        if ctl.cancelled() {
            results.push(UnitResult { unit_id: cu.id.clone(), name: cu.name.clone(), criticality: cu.criticality.clone(), status: "cancelled".into(), error: "Cancelada: não verificada.".into(), volume: dim("not_verified", "cancelada"), identity: dim("not_verified", "cancelada"), fields_dim: dim("not_verified", "cancelada"), relations: dim("not_verified", "cancelada"), ..Default::default() });
            continue;
        }
        progress(Progress { phase: "comparação".into(), unit: cu.name.clone(), message: "Comparando com a baseline…".into(), ..Default::default() });
        let r = reconcile_unit(&inp, cu, &all_units, &plans, &blocked, &unit_errors, &tcaps, &mut maps, ctl, progress).await;
        results.push(r);
    }
    // relationships of children whose parents are processed
    run.units = results;
    // coverage
    let mut cov: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    let total = run.units.len() as u64;
    for (k, f) in [
        ("volume", Box::new(|u: &UnitResult| u.volume.result == "compatible" || u.volume.result == "divergent") as Box<dyn Fn(&UnitResult) -> bool>),
        ("identity", Box::new(|u: &UnitResult| u.identity.result == "compatible" || u.identity.result == "divergent")),
        ("fields", Box::new(|u: &UnitResult| u.fields_dim.result == "compatible" || u.fields_dim.result == "divergent")),
        ("relations", Box::new(|u: &UnitResult| u.relations.result == "compatible" || u.relations.result == "divergent")),
    ] {
        cov.insert(k.into(), (run.units.iter().filter(|u| f(u)).count() as u64, total));
    }
    run.coverage = cov;
    // uncovered tables and structural alerts
    if let Some(ss) = &bl.structure {
        let (tables, views) = super::analysis::uncovered(inp.current, ss);
        run.uncovered_tables = tables;
        if !views.is_empty() {
            run.structure_alerts.push(serde_json::json!({ "kind": "views_out_of_scope", "message": format!("{} views fora da contagem (evita contar o mesmo conjunto duas vezes): {}", views.len(), views.iter().take(20).cloned().collect::<Vec<_>>().join(", ")) }));
        }
        for u in &todo {
            let chk = super::analysis::check_unit(u, Some(ss), inp.target_structure);
            for a in chk.alerts {
                let mut a = a;
                a["unit"] = serde_json::Value::String(u.name.clone());
                run.structure_alerts.push(a);
            }
        }
    }
    // has the source changed since the baseline? (informational; the comparison uses the baseline)
    if let Some(scfg) = inp.source_cfg {
        run.source_changed = source_changes(scfg, &p.source.database, bl, &todo, perf, ctl).await;
    }
    run.finished_at = now_ms();
    run.status = if ctl.cancelled() {
        "cancelled".into()
    } else if run.units.iter().all(|u| u.status == "complete") && !run.units.is_empty() {
        "complete".into()
    } else if run.units.iter().all(|u| u.status == "error") {
        "error".into()
    } else {
        "partial".into()
    };
    run
}

#[allow(clippy::too_many_arguments)]
async fn reconcile_unit(inp: &ReconcileInput<'_>, cu: &Unit, all: &[Unit], plans: &HashMap<String, Vec<FieldPlan>>, blocked: &HashMap<String, Vec<(String, String)>>, unit_errors: &HashMap<String, String>, tcaps: &[UnitCapture], maps: &mut HashMap<String, PathBuf>, ctl: &JobCtl, progress: &ProgressFn) -> UnitResult {
    let p = inp.project;
    let perf = &p.perf;
    let bl = inp.baseline;
    let mut r = UnitResult { unit_id: cu.id.clone(), name: cu.name.clone(), criticality: cu.criticality.clone(), status: "complete".into(), ..Default::default() };
    let nv = |n: &str| dim("not_verified", n);
    if let Some(e) = unit_errors.get(&cu.id) {
        r.status = "error".into();
        r.error = e.clone();
        r.volume = nv(e);
        r.identity = nv(e);
        r.fields_dim = nv(e);
        r.relations = nv(e);
        return r;
    }
    let bc = bl.units.iter().find(|x| x.unit_id == cu.id).cloned().unwrap_or_default();
    let tc = tcaps.iter().find(|x| x.unit_id == cu.id).cloned().unwrap_or_default();
    r.null_keys_source = bc.null_keys;
    r.null_keys_target = tc.null_keys;
    r.collisions = bc.collisions + tc.collisions;
    r.warnings.extend(bc.warnings.iter().map(|w| format!("baseline: {w}")));
    r.warnings.extend(tc.warnings.iter().map(|w| format!("destino: {w}")));
    r.target_capture = Some(tc.clone());
    if tc.status != "complete" {
        r.status = if tc.status == "cancelled" { "cancelled".into() } else { "error".into() };
        r.error = format!("Destino não verificado: {}", tc.error);
        let n = format!("destino não lido ({})", tc.error);
        r.volume = nv(&n);
        r.identity = nv(&n);
        r.fields_dim = nv(&n);
        r.relations = nv(&n);
        return r;
    }
    let one_to_one = cu.cardinality == "1:1" || cu.normalized;
    let pre = inp.pre.and_then(|(m, d)| m.units.iter().find(|x| x.unit_id == cu.id && x.status == "complete").map(|x| (x.clone(), d)));
    // ---- volume ----
    let exact = bc.count_kind == "exact" && tc.count_kind == "exact";
    r.counts = Counts { source: bc.rows.map(|n| n + bc.excluded), excluded: bc.excluded, expected: if one_to_one { bc.rows } else { None }, target: tc.rows, kind: if exact { "exact".into() } else if bc.count_kind == "estimated" || tc.count_kind == "estimated" { "estimated".into() } else { "none".into() }, rule: if one_to_one { "1:1 — cada registro elegível da origem (menos exclusões justificadas) deve gerar um registro no destino, no escopo da carga".into() } else { format!("cardinalidade {} sem normalização: não há contagem esperada", cu.cardinality) }, ..Default::default() };
    // ---- identity ----
    let ev_dir = inp.run_dir.join(&cu.id);
    let _ = std::fs::create_dir_all(&ev_dir);
    let mx = perf.max_examples;
    let batch = perf.batch_rows.max(1);
    let disk = perf.disk_mb * 1_048_576;
    let identity_on = matches!(cu.identity.kind.as_str(), "key" | "map" | "content");
    let have_records = bc.evidence.is_some() && tc.evidence.is_some();
    let mut compared: Option<engine::CompareOut> = None;
    let mut src_ev: Option<PathBuf> = bc.evidence.as_ref().map(|e| inp.baseline_dir.join(&e.path));
    let mut excl_ev: Option<PathBuf> = bc.excluded_evidence.as_ref().map(|e| inp.baseline_dir.join(&e.path));
    if identity_on && have_records && cu.identity.kind == "map" {
        match capture_map(inp, cu, &ev_dir, ctl).await {
            Ok((map_path, stats, mut files)) => {
                let mut f_unm = Findings::create(ev_dir.join("map_unmapped.tsv"), mx).unwrap();
                let mut f_amb = Findings::create(ev_dir.join("map_ambiguous_source.tsv"), mx).unwrap();
                let mut f_orph = Findings::create(ev_dir.join("map_without_source.tsv"), mx).unwrap();
                let tr_path = ev_dir.join("translated.ev");
                match engine::translate(src_ev.as_ref().unwrap(), bc.fk_count, &map_path, &tr_path, &ev_dir, batch, disk, &mut f_unm, &mut f_amb, &mut f_orph) {
                    Ok(t) => {
                        r.map_issues.insert("pares no mapa".into(), stats.pairs);
                        r.map_issues.insert("pares com ID nulo".into(), stats.null_pairs);
                        r.map_issues.insert("IDs de origem repetidos no mapa".into(), stats.dup_source);
                        r.map_issues.insert(if cu.identity.map.as_ref().is_some_and(|m| m.allow_dup_target) { "IDs de destino repetidos (consolidação permitida)".into() } else { "IDs de destino repetidos no mapa".into() }, stats.dup_target);
                        r.map_issues.insert("registros da origem sem correspondência no mapa".into(), t.unmapped);
                        r.map_issues.insert("correspondências para registros inexistentes na origem".into(), t.map_without_source);
                        r.map_issues.insert("registros com correspondência ambígua".into(), t.ambiguous_source);
                        for (name, f) in [("map_unmapped", f_unm), ("map_ambiguous_source", f_amb), ("map_without_source", f_orph)] {
                            if let Ok((path, count, _)) = f.close() {
                                files.insert(name.into(), (path, count));
                            }
                        }
                        for (k, (path, count)) in files {
                            if let Ok(ef) = engine::evidence_file(&path, count) {
                                r.findings.insert(k, ef);
                            }
                        }
                        src_ev = Some(tr_path);
                        // excluded identities translated too, so they are recognized in the target
                        if let Some(x) = excl_ev.clone() {
                            let xp = ev_dir.join("translated.excl.ev");
                            let mut a = Findings::create(ev_dir.join(".x1"), 0).unwrap();
                            let mut b = Findings::create(ev_dir.join(".x2"), 0).unwrap();
                            let mut c = Findings::create(ev_dir.join(".x3"), 0).unwrap();
                            if engine::translate(&x, 0, &map_path, &xp, &ev_dir, batch, disk, &mut a, &mut b, &mut c).is_ok() {
                                excl_ev = Some(xp);
                            }
                            for f in [a, b, c] {
                                if let Ok((pth, _, _)) = f.close() {
                                    let _ = std::fs::remove_file(pth);
                                }
                            }
                        }
                        maps.insert(cu.id.clone(), map_path);
                    }
                    Err(e) => {
                        r.status = "error".into();
                        r.error = format!("Falha ao aplicar o mapa de IDs: {e}");
                    }
                }
            }
            Err(e) => {
                r.status = "error".into();
                r.error = format!("Mapa de IDs não verificado: {e}");
            }
        }
    }
    let fields_plan = plans.get(&cu.id).cloned().unwrap_or_default();
    let bl_list = blocked.get(&cu.id).cloned().unwrap_or_default();
    if identity_on && have_records && r.status == "complete" {
        let spec = CompareSpec {
            fields: fields_plan
                .iter()
                .zip(&bl_list)
                .map(|(fp, (_, b))| FieldCmp { id: fp.fm.id.clone(), label: field_label(&fp.fm), rules: fp.fm.rules.clone(), blocked: if b.is_empty() { None } else { Some(b.clone()) } })
                .collect(),
            direct_fk: cu.relationships.iter().map(|rel| !all.iter().find(|u| u.id == rel.parent_unit).is_some_and(|pu| pu.identity.kind == "map")).collect(),
            nfk: bc.fk_count,
            exclude_preexisting: cu.exclude_preexisting,
            max_examples: mx,
        };
        let pre_ev = pre.as_ref().and_then(|(pc, d)| pc.evidence.as_ref().map(|e| d.join(&e.path)));
        if cu.exclude_preexisting && pre_ev.is_none() {
            r.warnings.push("\"Ignorar pré-existentes\" exige uma baseline do destino antes da carga: sem ela, registros antigos do destino aparecem como extras.".into());
        }
        let dst_ev = inp.run_dir.join("target").join(&tc.evidence.as_ref().unwrap().path);
        if bc.fk_count != tc.fk_count {
            r.status = "error".into();
            r.error = "Os relacionamentos mudaram desde a baseline: capture uma nova baseline.".into();
        } else {
            match engine::compare(src_ev.as_ref().unwrap(), excl_ev.as_deref(), &dst_ev, pre_ev.as_deref(), &spec, &ev_dir, batch, disk) {
                Ok(c) => compared = Some(c),
                Err(e) => {
                    r.status = "partial".into();
                    r.error = format!("Comparação interrompida: {e}");
                }
            }
        }
    }
    let _ = progress;
    let _ = ctl;
    // ---- volume result ----
    let preexisting = compared.as_ref().map(|c| c.preexisting + c.preexisting_matched).unwrap_or(0);
    r.counts.preexisting = preexisting;
    let observed = tc.rows.map(|n| n.saturating_sub(if cu.exclude_preexisting { preexisting } else { 0 }));
    r.counts.target = observed;
    r.counts.diff = match (r.counts.expected, observed) {
        (Some(e), Some(o)) => Some(o as i64 - e as i64),
        _ => None,
    };
    r.volume = volume_result(&cu.cardinality, one_to_one, exact, cu.exclude_preexisting && pre.is_none() && compared.is_none(), r.counts.diff);
    // ---- identity result ----
    match &compared {
        Some(c) => {
            r.missing = c.missing;
            r.extra = c.extra;
            r.multiplicity = c.multiplicity;
            r.ambiguous = c.ambiguous + c.preexisting_matched;
            for (k, path) in &c.files {
                if let Ok(ef) = engine::evidence_file(path, *c.counts.get(k).unwrap_or(&0)) {
                    r.findings.insert(k.clone(), ef);
                }
            }
            let map_problems: u64 = r.map_issues.iter().filter(|(k, _)| !k.starts_with("pares no mapa") && !k.contains("permitida")).map(|(_, v)| *v).sum();
            let bad = c.missing + c.extra + c.multiplicity + bc.null_keys + tc.null_keys + bc.collisions + tc.collisions + map_problems;
            let note = if cu.identity.kind == "content" { " Identidade por conteúdo: um registro alterado aparece como ausente e extra." } else { "" };
            r.identity = if bad == 0 && c.preexisting_matched == 0 {
                dim("compatible", format!("Identidades verificadas: {} correspondências, nenhuma ausente, extra ou duplicada.{note}", c.matched))
            } else {
                dim("divergent", format!("{} ausentes, {} extras, {} com multiplicidade diferente, {} chaves nulas, {} colisões de normalização.{note}", c.missing, c.extra, c.multiplicity, bc.null_keys + tc.null_keys, bc.collisions + tc.collisions))
            };
            if c.excluded_present > 0 {
                r.warnings.push(format!("{} registros excluídos intencionalmente da origem estão presentes no destino.", c.excluded_present));
            }
        }
        None if !identity_on => {
            r.identity = dim("not_verified", if r.volume.result == "divergent" { "Diferença de volume detectada. Não foi possível identificar os registros ausentes porque não há uma identidade comparável configurada." } else { "Sem identidade comparável configurada: não é possível saber se os registros são os mesmos." });
        }
        None => {
            r.identity = dim("not_verified", if r.error.is_empty() { "A baseline não guarda identidades (nível básico ou análise de volume)." .to_string() } else { r.error.clone() });
        }
    }
    // ---- fields ----
    r.unmapped_source = super::analysis::check_unit(cu, bl.structure.as_ref(), inp.target_structure).unmapped_source;
    r.unsourced_required_target = super::analysis::check_unit(cu, bl.structure.as_ref(), inp.target_structure).unsourced_required;
    let mut frs: Vec<FieldResult> = vec![];
    for (i, fp) in fields_plan.iter().enumerate() {
        let mut fr = compared.as_ref().and_then(|c| c.fields.get(i).cloned()).unwrap_or(FieldResult { field_id: fp.fm.id.clone(), label: field_label(&fp.fm), ..Default::default() });
        let blocked_reason = bl_list.get(i).map(|b| b.1.clone()).unwrap_or_default();
        fr.derived = matches!(fp.fm.kind.as_str(), "concat" | "split" | "constant");
        let sp = bc.profile.get(&fp.fm.id);
        let tp = tc.profile.get(&fp.fm.id);
        if let (Some(s), Some(t)) = (sp, tp) {
            fr.aggregate = Some((s.filled, t.filled));
        }
        if !blocked_reason.is_empty() {
            fr.result = "not_verified".into();
            fr.note = blocked_reason;
        } else if compared.is_none() || bc.field_ids.is_empty() {
            fr.result = "not_verified".into();
            fr.note = if bc.field_ids.is_empty() { "A baseline não guarda evidência por campo (nível de evidência).".into() } else { "Sem identidade comparável: preenchimento agregado é apenas um indício, não uma lista de perdas.".into() };
        } else if fr.lost + fr.created + fr.divergent + fr.invalid > 0 {
            fr.result = "divergent".into();
        } else if fr.not_compared > 0 {
            fr.result = "inconclusive".into();
            fr.note = format!("{} identidades não comparadas (duplicadas ou ambíguas).", fr.not_compared);
        } else {
            fr.result = "compatible".into();
            fr.note = if fp.fm.rules.is_default() { "Igual nas identidades correspondentes.".into() } else { format!("Igual após as regras: {}.", fp.fm.rules.describe().join("; ")) };
        }
        frs.push(fr);
    }
    let skipped_fields: Vec<&FieldMap> = cu.fields.iter().filter(|f| f.kind == "derived").collect();
    for f in skipped_fields {
        frs.push(FieldResult { field_id: f.id.clone(), label: field_label(f), result: "not_verified".into(), note: "Campo derivado sem regra verificável.".into(), derived: true, ..Default::default() });
    }
    r.fields_dim = if frs.is_empty() {
        dim("not_verified", "Nenhum campo confirmado para comparação.")
    } else if frs.iter().any(|f| f.result == "divergent") {
        dim("divergent", format!("{} de {} campos com problemas.", frs.iter().filter(|f| f.result == "divergent").count(), frs.len()))
    } else if frs.iter().all(|f| f.result == "compatible") {
        dim("compatible", format!("{} campos verificados nas identidades correspondentes.", frs.len()))
    } else if frs.iter().any(|f| f.result == "compatible") {
        dim("inconclusive", "Parte dos campos não pôde ser verificada.")
    } else {
        dim("not_verified", frs.first().map(|f| f.note.clone()).unwrap_or_default())
    };
    r.fields = frs;
    // ---- relationships ----
    if cu.relationships.is_empty() {
        r.relations = dim("not_verified", "Nenhum relacionamento configurado.");
    } else if let Some(c) = &compared {
        let mut changed_total = 0u64;
        let mut f_rel = Findings::create(ev_dir.join("relations_map.tsv"), mx).unwrap();
        let mut f_orph = Findings::create(ev_dir.join("orphans.tsv"), mx).unwrap();
        let mut notes = vec![];
        let dst_ev = inp.run_dir.join("target").join(&tc.evidence.as_ref().unwrap().path);
        for (i, rel) in cu.relationships.iter().enumerate() {
            let parent = all.iter().find(|u| u.id == rel.parent_unit);
            changed_total += c.rel_changed.get(i).copied().unwrap_or(0);
            if let (Some(Some(pending)), Some(pu)) = (c.fk_pending.get(i), parent) {
                match maps.get(&pu.id) {
                    Some(pm) => match engine::check_fk_via_map(pending, pm, i, &mut f_rel) {
                        Ok((ch, un)) => {
                            changed_total += ch;
                            r.relation_issues.insert(format!("{}: chave estrangeira sem correspondência no mapa do pai", rel.name), un);
                            changed_total += un;
                        }
                        Err(e) => notes.push(format!("{}: {e}", rel.name)),
                    },
                    None => notes.push(format!("{}: o mapa de IDs do pai não foi lido nesta execução", rel.name)),
                }
            }
            r.relation_issues.insert(format!("{}: associação alterada (aponta para outra entidade)", rel.name), c.rel_changed.get(i).copied().unwrap_or(0));
            // orphans in the target
            match parent.and_then(|pu| tcaps.iter().find(|t| t.unit_id == pu.id)).and_then(|t| t.evidence.as_ref()) {
                Some(pe) => {
                    let pnfk = parent.and_then(|pu| tcaps.iter().find(|t| t.unit_id == pu.id)).map(|t| t.fk_count).unwrap_or(0);
                    match engine::orphans(&dst_ev, tc.fk_count, i, &inp.run_dir.join("target").join(&pe.path), pnfk, &ev_dir, batch, disk, &mut f_orph) {
                        Ok(n) => {
                            r.relation_issues.insert(format!("{}: órfãos no destino", rel.name), n);
                            changed_total += n;
                        }
                        Err(e) => notes.push(format!("{}: {e}", rel.name)),
                    }
                }
                None => notes.push(format!("{}: a unidade pai não foi lida no destino nesta execução (órfãos não verificados)", rel.name)),
            }
        }
        for (name, f) in [("relations_map", f_rel), ("orphans", f_orph)] {
            if let Ok((path, count, _)) = f.close() {
                if let Ok(ef) = engine::evidence_file(&path, count) {
                    r.findings.insert(name.into(), ef);
                }
            }
        }
        r.relations = if !notes.is_empty() && changed_total == 0 {
            dim("inconclusive", notes.join("; "))
        } else if changed_total == 0 {
            dim("compatible", "Relacionamentos preservados nas identidades correspondentes (validade referencial e associação original).")
        } else {
            dim("divergent", format!("{changed_total} problemas de relacionamento. {}", notes.join("; ")))
        };
    } else {
        r.relations = dim("not_verified", "Relacionamentos exigem identidades comparáveis.");
    }
    if r.status == "complete" && !r.error.is_empty() {
        r.status = "partial".into();
    }
    r
}

/// Volume decision: estimates never approve; other cardinalities need normalized datasets.
pub fn volume_result(cardinality: &str, one_to_one: bool, exact: bool, undelimited_target: bool, diff: Option<i64>) -> Dim {
    if !one_to_one {
        dim("inconclusive", format!("Cardinalidade {cardinality} sem conjuntos normalizados: a regra contagem origem = destino não se aplica."))
    } else if !exact {
        dim("inconclusive", "Contagens estimadas ou indisponíveis não aprovam o volume.")
    } else if undelimited_target {
        dim("inconclusive", "O destino pode ter dados anteriores à carga e não há delimitação confiável.")
    } else if diff == Some(0) {
        dim("compatible", "Volume compatível no escopo verificado (contagem exata). Isso não prova que os registros são os mesmos.")
    } else {
        dim("divergent", format!("Diferença de {} registros no escopo verificado.", diff.unwrap_or(0)))
    }
}

pub fn field_label(f: &FieldMap) -> String {
    let src = match f.kind.as_str() {
        "constant" => format!("constante \"{}\"", f.constant),
        "concat" => format!("{} (concatenação)", f.source_cols.join(" + ")),
        "split" => format!("{} (parte {})", f.source_cols.join(""), f.index + 1),
        _ => f.source_cols.join(", "),
    };
    if f.target_col.is_empty() {
        src
    } else {
        format!("{src} → {}", f.target_col)
    }
}

async fn capture_map(inp: &ReconcileInput<'_>, cu: &Unit, dir: &Path, ctl: &JobCtl) -> Result<(PathBuf, engine::MapOut, BTreeMap<String, (PathBuf, u64)>), String> {
    let m = cu.identity.map.as_ref().ok_or("mapa não configurado")?;
    let p = inp.project;
    let (cfg, db) = if m.side == "source" { (inp.source_cfg.ok_or("conexão de origem indisponível para ler o mapa")?, &p.source.database) } else { (inp.target_cfg, &p.target.database) };
    let ctl2 = ctl.clone();
    let mut ad = Adapter::open(cfg, db, p.perf.timeout_secs).await?;
    let res = async {
        ad.begin(if p.consistency == "none" { "none" } else { "snapshot" }, None).await?;
        let cols = ad.describe(&m.dataset, None, &ctl2).await?;
        let mut w = Wanted { cols: vec![] };
        let src = KeySpec { cols: m.source_cols.iter().enumerate().map(|(i, c)| (w.idx(c), lt_of(&cols, c), cu.identity.source.get(i).map(|k| k.rules.clone()).unwrap_or_default())).collect() };
        let dst = KeySpec { cols: m.target_cols.iter().enumerate().map(|(i, c)| (w.idx(c), lt_of(&cols, c), cu.identity.target.get(i).map(|k| k.rules.clone()).unwrap_or_default())).collect() };
        let b = select_sql(ad.dialect, &m.dataset, &cols, &w.cols, &[], &[])?;
        let mut mc = MapCapturer::new(src, dst, dir, "map", p.perf.batch_rows.max(1), p.perf.disk_mb * 1_048_576)?;
        ad.stream(&b, p.perf.batch_rows.clamp(100, 10_000), &ctl2, &mut |row| mc.push(&row)).await?;
        let mut f1 = Findings::create(dir.join("map_dup_source.tsv"), p.perf.max_examples)?;
        let mut f2 = Findings::create(dir.join("map_dup_target.tsv"), p.perf.max_examples)?;
        let (path, stats) = mc.finish(dir, "map", p.perf.batch_rows.max(1), p.perf.disk_mb * 1_048_576, m.allow_dup_target, &mut f1, &mut f2)?;
        let mut files = BTreeMap::new();
        for (name, f) in [("map_dup_source", f1), ("map_dup_target", f2)] {
            let (pth, c, _) = f.close()?;
            files.insert(name.to_string(), (pth, c));
        }
        Ok::<_, String>((path, stats, files))
    }
    .await;
    ad.end().await;
    ad.close().await;
    res
}

async fn source_changes(cfg: &ConnConfig, db: &str, bl: &BaselineManifest, units: &[Unit], perf: &Perf, ctl: &JobCtl) -> Vec<String> {
    let mut out = vec![];
    let mut ad = match Adapter::open(cfg, db, perf.timeout_secs).await {
        Ok(a) => a,
        Err(e) => return vec![format!("Não foi possível verificar alterações na origem: {e}")],
    };
    for u in units {
        let Some(bu) = bl.units_config.iter().find(|x| x.id == u.id) else { continue };
        let Some(bc) = bl.units.iter().find(|x| x.unit_id == u.id && x.count_kind == "exact") else { continue };
        let cols = match ad.describe(&bu.source, bl.structure.as_ref(), ctl).await {
            Ok(c) => c,
            Err(e) => {
                out.push(format!("{}: não verificado ({e})", u.name));
                continue;
            }
        };
        if let Ok(b) = count_sql(ad.dialect, &bu.source, &cols, &[]) {
            match ad.count(&b, ctl).await {
                Ok(n) => {
                    let was = bc.rows.unwrap_or(0) + bc.excluded;
                    if n != was {
                        out.push(format!("{}: a origem tinha {was} registros na baseline e agora tem {n}. A comparação usa a baseline; para atualizar a origem, crie uma nova baseline.", u.name));
                    }
                }
                Err(e) => out.push(format!("{}: contagem atual não verificada ({e})", u.name)),
            }
        }
    }
    // structure drift of the unit tables
    if let Some(bs) = &bl.structure {
        let schemas: Vec<String> = units.iter().map(|u| u.source.schema.clone()).filter(|s| !s.is_empty()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        if let Ok(now) = ad.discover(&schemas, ctl).await {
            for u in units.iter().filter(|u| u.source.kind == "table") {
                let a = bs.tables.iter().find(|t| t.schema == u.source.schema && t.name == u.source.table);
                let b = now.tables.iter().find(|t| t.schema == u.source.schema && t.name == u.source.table);
                if let (Some(a), Some(b)) = (a, b) {
                    let fa: Vec<(String, String)> = a.columns.iter().map(|c| (c.name.clone(), c.native.clone())).collect();
                    let fb: Vec<(String, String)> = b.columns.iter().map(|c| (c.name.clone(), c.native.clone())).collect();
                    if fa != fb {
                        out.push(format!("{}: a estrutura da tabela de origem mudou desde a baseline.", u.name));
                    }
                }
            }
        }
    }
    ad.close().await;
    out
}
