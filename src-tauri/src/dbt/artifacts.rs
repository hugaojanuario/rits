//! Reads dbt artifacts (target/manifest.json, target/run_results.json) into a compact summary
//! for the UI: nodes with files and dependencies, last results with timings and failures, and
//! the schema versions, so old or incompatible artifacts are flagged instead of misread.

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

/// Schema versions this plugin was validated against (dbt Core 1.10–1.12 write manifest v12 and
/// run_results v6; v2 also writes manifest v12).
pub const MANIFEST_SUPPORTED: std::ops::RangeInclusive<u32> = 10..=12;
pub const RUN_RESULTS_SUPPORTED: std::ops::RangeInclusive<u32> = 4..=6;

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub unique_id: String,
    pub resource_type: String,
    pub name: String,
    pub package: String,
    /// Path relative to the project (original_file_path).
    pub path: String,
    pub depends_on: Vec<String>,
    pub tags: Vec<String>,
    pub materialized: String,
    pub schema: String,
    pub compiled_path: String,
    /// Tests: the node they test (attached_node).
    pub attached: String,
    /// Sources: source_name.
    pub source_name: String,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NodeResult {
    pub unique_id: String,
    pub status: String,
    pub execution_time: f64,
    pub message: String,
    pub failures: Option<i64>,
    pub relation: String,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactInfo {
    pub present: bool,
    pub schema_version: Option<u32>,
    pub dbt_version: String,
    pub generated_at: String,
    pub invocation_id: String,
    /// "ok" | "old" | "newer" | "unknown" | "invalid"
    pub compat: String,
    pub error: String,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub manifest: ArtifactInfo,
    pub run_results: ArtifactInfo,
    pub project_name: String,
    pub nodes: Vec<Node>,
    pub results: Vec<NodeResult>,
    pub elapsed: f64,
    /// Command of the last run (`args.which`).
    pub command: String,
    /// run_results belongs to another invocation than the manifest (e.g. a later parse).
    pub results_from_other_invocation: bool,
    /// Project files modified after run_results.json was written.
    pub changed_since_results: Vec<String>,
}

/// "https://schemas.getdbt.com/dbt/manifest/v12.json" -> 12
pub fn schema_version(url: &str) -> Option<u32> {
    let file = url.rsplit('/').next()?;
    file.strip_prefix('v')?.strip_suffix(".json")?.parse().ok()
}

fn info(v: &Value, supported: &std::ops::RangeInclusive<u32>) -> ArtifactInfo {
    let m = &v["metadata"];
    let ver = m["dbt_schema_version"].as_str().and_then(schema_version);
    ArtifactInfo {
        present: true,
        schema_version: ver,
        dbt_version: m["dbt_version"].as_str().unwrap_or("").into(),
        generated_at: m["generated_at"].as_str().unwrap_or("").into(),
        invocation_id: m["invocation_id"].as_str().unwrap_or("").into(),
        compat: match ver {
            None => "unknown".into(),
            Some(x) if supported.contains(&x) => "ok".into(),
            Some(x) if x < *supported.start() => "old".into(),
            Some(_) => "newer".into(),
        },
        error: String::new(),
    }
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

pub fn parse_manifest(v: &Value) -> (ArtifactInfo, String, Vec<Node>) {
    let inf = info(v, &MANIFEST_SUPPORTED);
    let project = s(&v["metadata"]["project_name"]);
    let mut nodes = vec![];
    for section in ["nodes", "sources", "exposures", "metrics", "semantic_models", "unit_tests"] {
        let Some(map) = v[section].as_object() else { continue };
        for (id, n) in map {
            let rt = n["resource_type"].as_str().unwrap_or(section.trim_end_matches('s'));
            nodes.push(Node {
                unique_id: id.clone(),
                resource_type: rt.to_string(),
                name: s(&n["name"]),
                package: s(&n["package_name"]),
                path: s(&n["original_file_path"]),
                depends_on: strs(&n["depends_on"]["nodes"]),
                tags: strs(&n["tags"]),
                materialized: s(&n["config"]["materialized"]),
                schema: s(&n["schema"]),
                compiled_path: s(&n["compiled_path"]),
                attached: s(&n["attached_node"]),
                source_name: s(&n["source_name"]),
            });
        }
    }
    nodes.sort_by(|a, b| a.unique_id.cmp(&b.unique_id));
    (inf, project, nodes)
}

pub fn parse_run_results(v: &Value) -> (ArtifactInfo, Vec<NodeResult>, f64, String) {
    let inf = info(v, &RUN_RESULTS_SUPPORTED);
    let results = v["results"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|r| NodeResult {
                    unique_id: s(&r["unique_id"]),
                    status: s(&r["status"]),
                    execution_time: r["execution_time"].as_f64().unwrap_or(0.0),
                    message: s(&r["message"]),
                    failures: r["failures"].as_i64(),
                    relation: s(&r["relation_name"]),
                })
                .collect()
        })
        .unwrap_or_default();
    (inf, results, v["elapsed_time"].as_f64().unwrap_or(0.0), s(&v["args"]["which"]))
}

fn read_json(p: &Path) -> Result<Option<Value>, String> {
    if !p.exists() {
        return Ok(None);
    }
    let f = std::fs::File::open(p).map_err(|e| format!("{}: {e}", p.display()))?;
    serde_json::from_reader(std::io::BufReader::new(f)).map(Some).map_err(|e| format!("{}: JSON inválido ({e}); o arquivo pode estar sendo escrito ou truncado.", p.display()))
}

pub fn summarize(project: &Path) -> Result<Summary, String> {
    let target = project.join("target");
    let mut out = Summary::default();
    let mpath = target.join("manifest.json");
    match read_json(&mpath) {
        Ok(Some(v)) => {
            let (inf, name, nodes) = parse_manifest(&v);
            out.manifest = inf;
            out.project_name = name;
            out.nodes = nodes;
        }
        Ok(None) => {}
        Err(e) => out.manifest = ArtifactInfo { present: true, compat: "invalid".into(), error: e, ..Default::default() },
    }
    let rpath = target.join("run_results.json");
    match read_json(&rpath) {
        Ok(Some(v)) => {
            let (inf, res, el, cmd) = parse_run_results(&v);
            out.run_results = inf;
            out.results = res;
            out.elapsed = el;
            out.command = cmd;
        }
        Ok(None) => {}
        Err(e) => out.run_results = ArtifactInfo { present: true, compat: "invalid".into(), error: e, ..Default::default() },
    }
    out.results_from_other_invocation = out.manifest.present && out.run_results.present && !out.manifest.invocation_id.is_empty() && out.manifest.invocation_id != out.run_results.invocation_id;
    if let Ok(rm) = std::fs::metadata(&rpath).and_then(|m| m.modified()) {
        let mut seen = BTreeMap::new();
        for n in &out.nodes {
            if n.path.is_empty() || n.package != out.project_name {
                continue;
            }
            if let Ok(t) = std::fs::metadata(project.join(&n.path)).and_then(|m| m.modified()) {
                if t > rm {
                    seen.insert(n.path.clone(), ());
                }
            }
        }
        out.changed_since_results = seen.into_keys().take(200).collect();
    }
    Ok(out)
}

/// Compiled SQL of a node: `compiled_path` from the manifest, confined to the project folder.
pub fn compiled_sql(project: &Path, unique_id: &str) -> Result<Option<String>, String> {
    let Some(v) = read_json(&project.join("target").join("manifest.json"))? else { return Ok(None) };
    let n = &v["nodes"][unique_id];
    let rel = n["compiled_path"].as_str().unwrap_or("");
    if rel.is_empty() {
        return Ok(n["compiled_code"].as_str().map(str::to_string));
    }
    if rel.contains("..") || Path::new(rel).is_absolute() {
        return Err("Caminho compilado fora do projeto.".into());
    }
    let p = project.join(rel);
    match std::fs::read_to_string(&p) {
        Ok(t) => Ok(Some(t)),
        Err(_) => Ok(n["compiled_code"].as_str().map(str::to_string)),
    }
}
