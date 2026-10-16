//! Configuration and result models of the Migration Audit (format version 1).
//! Configuration (project.json, mappings.json) is editable; baselines and runs are immutable
//! artifacts that embed the exact rules they were produced with.

use super::canon::{LType, Rules};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const FORMAT: u32 = 1;
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Reference to an IDE connection, without secrets (host and database only, for display).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnRef {
    pub conn_id: String,
    pub name: String,
    pub kind: String,
    pub host: String,
    pub database: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Excluded {
    pub schema: String,
    pub table: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ScopeSide {
    pub schemas: Vec<String>,
    pub include_views: bool,
    /// Objects out of the conversion scope (with justification).
    pub excluded: Vec<Excluded>,
    /// Name patterns of technical/audit/history tables (SQL LIKE syntax: %, _).
    pub technical: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Perf {
    /// quick | volume | identity | fields | deep
    pub mode: String,
    pub concurrency: u32,
    pub per_connection: u32,
    /// Seconds per query (0 = none).
    pub timeout_secs: u64,
    /// Rows kept in memory before spilling a sorted run to disk.
    pub batch_rows: usize,
    pub memory_mb: u64,
    pub disk_mb: u64,
    pub max_examples: usize,
    /// Maximum number of queries per execution (0 = unlimited).
    pub query_budget: u64,
    pub exclude_lobs: bool,
    /// Old executions kept (0 = all).
    pub retention: usize,
}

impl Default for Perf {
    fn default() -> Self {
        Perf { mode: "fields".into(), concurrency: 1, per_connection: 1, timeout_secs: 1800, batch_rows: 200_000, memory_mb: 512, disk_mb: 20_480, max_examples: 50, query_budget: 0, exclude_lobs: true, retention: 0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Project {
    pub format: u32,
    pub id: String,
    pub name: String,
    pub description: String,
    pub created: i64,
    pub updated: i64,
    pub source: ConnRef,
    pub target: ConnRef,
    pub source_scope: ScopeSide,
    pub target_scope: ScopeSide,
    /// frozen | snapshot | watermark | none
    pub consistency: String,
    pub watermark_note: String,
    pub perf: Perf,
    /// basic | identity | fields
    pub evidence_level: String,
    /// Keep canonical values in the evidence (needed for tolerances, re-deriving rules and
    /// showing values; more disk and more sensitive data).
    pub store_values: bool,
    /// User dictionary for mapping suggestions (source name -> target name).
    pub aliases: Vec<(String, String)>,
    pub strip_prefixes: Vec<String>,
}

impl Default for Project {
    fn default() -> Self {
        Project {
            format: FORMAT,
            id: String::new(),
            name: String::new(),
            description: String::new(),
            created: 0,
            updated: 0,
            source: ConnRef::default(),
            target: ConnRef::default(),
            source_scope: ScopeSide::default(),
            target_scope: ScopeSide::default(),
            consistency: "snapshot".into(),
            watermark_note: String::new(),
            perf: Perf::default(),
            evidence_level: "fields".into(),
            store_values: false,
            aliases: vec![],
            strip_prefixes: vec![],
        }
    }
}

/// Structured predicate (column validated against metadata, value always a parameter).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Pred {
    pub column: String,
    /// = | <> | < | <= | > | >= | is null | is not null | in
    pub op: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Dataset {
    /// table | query
    pub kind: String,
    pub schema: String,
    pub table: String,
    /// Read-only query (kind = query); columns must have unique aliases.
    pub sql: String,
    pub filters: Vec<Pred>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct KeyCol {
    pub column: String,
    pub rules: Rules,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct IdMap {
    /// Connection that holds the map: source | target
    pub side: String,
    pub dataset: Dataset,
    pub source_cols: Vec<String>,
    pub target_cols: Vec<String>,
    /// Several source ids may become one target id (consolidation).
    pub allow_dup_target: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Identity {
    /// none | key | map | content
    pub kind: String,
    pub source: Vec<KeyCol>,
    pub target: Vec<KeyCol>,
    pub map: Option<IdMap>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FieldMap {
    pub id: String,
    /// map | concat | split | constant | derived | ignored | target_only
    pub kind: String,
    pub source_cols: Vec<String>,
    pub target_col: String,
    pub sep: String,
    pub index: u32,
    pub constant: String,
    pub rules: Rules,
    pub justification: String,
    pub confirmed: bool,
    pub sensitive: bool,
    /// Criteria of a deterministic suggestion (shown, never used as proof).
    pub suggested_by: Vec<String>,
}

impl FieldMap {
    /// Whether the field takes part in value comparison.
    pub fn comparable(&self) -> bool {
        self.confirmed && matches!(self.kind.as_str(), "map" | "concat" | "split" | "constant") && !self.target_col.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Relationship {
    pub id: String,
    pub name: String,
    pub parent_unit: String,
    /// FK columns in this unit's source / target datasets (same arity as the parent identity).
    pub source_cols: Vec<String>,
    pub target_cols: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Exclusion {
    pub predicate: Vec<Pred>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Unit {
    pub id: String,
    pub name: String,
    pub description: String,
    /// alta | media | baixa
    pub criticality: String,
    pub source: Dataset,
    pub target: Dataset,
    /// 1:1 | 1:N | N:1
    pub cardinality: String,
    /// The datasets were normalized by queries to the same grain (makes 1:N/N:1 comparable).
    pub normalized: bool,
    pub identity: Identity,
    pub fields: Vec<FieldMap>,
    /// Source rows intentionally not converted (justified).
    pub exclusions: Vec<Exclusion>,
    /// Delimitation of the load in the target (batch id, origin marker...).
    pub target_scope: Vec<Pred>,
    /// Ignore target identities that existed before the load (needs a target pre-load baseline).
    pub exclude_preexisting: bool,
    pub relationships: Vec<Relationship>,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Mappings {
    pub format: u32,
    /// Incremented on every save (runs record the exact version they used).
    pub version: u64,
    pub units: Vec<Unit>,
    /// Tables intentionally not converted (side, schema, table, reason).
    pub ignored: Vec<(String, String, String, String)>,
}

// ---------------- discovered structure ----------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Column {
    pub name: String,
    pub position: i32,
    pub native: String,
    pub ltype: Option<LType>,
    pub length: Option<i64>,
    pub precision: Option<i64>,
    pub scale: Option<i64>,
    pub nullable: bool,
    pub default: Option<String>,
    pub generated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Constraint {
    pub name: String,
    /// primary | unique | foreign
    pub kind: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Table {
    pub schema: String,
    pub name: String,
    /// table | view | matview | foreign
    pub kind: String,
    pub columns: Vec<Column>,
    pub constraints: Vec<Constraint>,
    pub indexes: Vec<(String, bool, Vec<String>)>,
    /// Estimated rows from the catalog (None = unknown, never 0 by default).
    pub estimated_rows: Option<i64>,
    pub technical: bool,
    pub excluded: Option<String>,
    /// Error while reading this table's metadata (distinct from "no metadata").
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Structure {
    pub dialect: String,
    pub version: String,
    pub captured_at: i64,
    pub tables: Vec<Table>,
    pub errors: Vec<String>,
}

// ---------------- capture / comparison results ----------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FieldProfile {
    pub nulls: u64,
    pub empty: u64,
    pub blank: u64,
    pub filled: u64,
    pub invalid: u64,
    pub min: Option<String>,
    pub max: Option<String>,
    pub min_len: Option<u64>,
    pub max_len: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EvidenceFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub records: u64,
}

/// One unit captured on one side (baseline or reconciliation).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UnitCapture {
    pub unit_id: String,
    /// complete | partial | error | cancelled | skipped
    pub status: String,
    pub error: String,
    /// exact | estimated | none
    pub count_kind: String,
    pub rows: Option<u64>,
    pub excluded: u64,
    pub null_keys: u64,
    pub distinct_keys: u64,
    pub duplicate_keys: u64,
    pub collisions: u64,
    pub profile: BTreeMap<String, FieldProfile>,
    pub evidence: Option<EvidenceFile>,
    pub excluded_evidence: Option<EvidenceFile>,
    /// Rules digest per field id (to detect rule changes later).
    pub rules_digest: BTreeMap<String, String>,
    /// Digest of the identity configuration of this side.
    pub identity_digest: String,
    /// Order of the field states in the evidence records (field ids).
    pub field_ids: Vec<String>,
    /// Fields left out (BLOB/long text excluded by configuration, unconfirmed...): id -> reason.
    pub fields_skipped: BTreeMap<String, String>,
    /// Number of relationship FK columns in the records.
    pub fk_count: usize,
    pub warnings: Vec<String>,
    pub sorted_runs: u64,
    pub queries: u64,
    pub elapsed_ms: u64,
    pub sql: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Consistency {
    pub requested: String,
    pub obtained: String,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BaselineManifest {
    pub format: u32,
    pub kind: String,
    pub id: String,
    pub project_id: String,
    pub plugin_version: String,
    /// source | target-pre
    pub side: String,
    pub started_at: i64,
    pub finished_at: i64,
    /// complete | partial | cancelled | error
    pub status: String,
    pub connection: ConnRef,
    pub level: String,
    pub store_values: bool,
    pub mappings_version: u64,
    pub units_config: Vec<Unit>,
    pub consistency: Consistency,
    pub structure: Option<Structure>,
    pub units: Vec<UnitCapture>,
    pub errors: Vec<String>,
    pub note: String,
    /// SHA-256 of the manifest without this field (detects accidental changes, not a signature).
    pub digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Counts {
    pub source: Option<u64>,
    pub excluded: u64,
    pub expected: Option<u64>,
    pub target: Option<u64>,
    pub preexisting: u64,
    pub diff: Option<i64>,
    pub kind: String,
    pub rule: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FieldResult {
    pub field_id: String,
    pub label: String,
    pub compared: u64,
    pub equal: u64,
    pub both_empty: u64,
    pub lost: u64,
    pub created: u64,
    pub divergent: u64,
    pub not_compared: u64,
    pub invalid: u64,
    pub derived: bool,
    /// compatible | divergent | inconclusive | not_verified
    pub result: String,
    pub note: String,
    /// Aggregate (no identity) indication: source filled vs target filled.
    pub aggregate: Option<(u64, u64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Dim {
    /// compatible | divergent | inconclusive | not_verified
    pub result: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UnitResult {
    pub unit_id: String,
    pub name: String,
    pub criticality: String,
    /// pending | running | complete | partial | cancelled | error
    pub status: String,
    pub error: String,
    pub counts: Counts,
    pub volume: Dim,
    pub identity: Dim,
    pub fields_dim: Dim,
    pub relations: Dim,
    pub missing: u64,
    pub extra: u64,
    pub multiplicity: u64,
    pub null_keys_source: u64,
    pub null_keys_target: u64,
    pub collisions: u64,
    pub ambiguous: u64,
    pub map_issues: BTreeMap<String, u64>,
    pub fields: Vec<FieldResult>,
    pub unmapped_source: Vec<String>,
    pub unsourced_required_target: Vec<String>,
    pub relation_issues: BTreeMap<String, u64>,
    pub findings: BTreeMap<String, EvidenceFile>,
    pub warnings: Vec<String>,
    pub target_capture: Option<UnitCapture>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RunManifest {
    pub format: u32,
    pub kind: String,
    pub id: String,
    pub project_id: String,
    pub plugin_version: String,
    pub baseline_id: String,
    pub target_pre_baseline_id: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub status: String,
    pub target: ConnRef,
    pub mappings_version: u64,
    pub units_config: Vec<Unit>,
    pub consistency: Consistency,
    pub units: Vec<UnitResult>,
    /// Tables in the source scope without a unit nor a justified exclusion.
    pub uncovered_tables: Vec<String>,
    pub structure_alerts: Vec<Value>,
    pub source_changed: Vec<String>,
    pub coverage: BTreeMap<String, (u64, u64)>,
    pub errors: Vec<String>,
    pub digest: String,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
