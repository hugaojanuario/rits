//! Capture (rows -> sorted evidence) and reconciliation (merge-join of sorted evidence) of the
//! Migration Audit. Pure file-based logic, independent of the database adapters, so every rule
//! is tested with small fixtures.

use super::canon::{self, canon, encode_all, fill, CVal, Fill, LType, Rules, Side};
use super::evidence::{file_sha256, Findings, PairReader, Reader, Rec, Sorter};
use super::model::{EvidenceFile, FieldProfile, FieldResult};
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Where a compared field's value comes from on one side.
#[derive(Debug, Clone)]
pub enum FieldSrc {
    Col(usize),
    /// Values joined with a separator (NULL parts count as empty; all NULL = NULL).
    Concat(Vec<usize>, String),
    /// Part `index` (0-based) of the value split by the separator (missing part = NULL).
    Split(usize, String, u32),
    Const(String),
}

#[derive(Debug, Clone)]
pub struct FieldSpec {
    pub id: String,
    pub src: FieldSrc,
    pub lt: LType,
    pub rules: Rules,
}

#[derive(Debug, Clone, Default)]
pub struct KeySpec {
    pub cols: Vec<(usize, LType, Rules)>,
}

#[derive(Debug, Clone)]
pub struct CaptureSpec {
    pub side: Side,
    pub key: KeySpec,
    /// Identity by content (digest of the compared fields) instead of a key.
    pub content_identity: bool,
    pub fields: Vec<FieldSpec>,
    pub fks: Vec<KeySpec>,
    /// Column with "1" for rows matching a justified exclusion.
    pub excl_idx: Option<usize>,
    pub store_values: bool,
    /// Write evidence records (false = basic level: counts and profile only).
    pub records: bool,
    /// Write field states (fields level); otherwise only identities and multiplicities.
    pub write_fields: bool,
}

fn key_hex(cols: &[(usize, LType, Rules)], row: &[Option<String>], side: Side) -> (Option<String>, String) {
    let mut vals = Vec::with_capacity(cols.len());
    let mut raw = Vec::with_capacity(cols.len());
    for (i, lt, r) in cols {
        let v = row.get(*i).cloned().flatten();
        raw.push(match &v {
            Some(s) => CVal::Text(s.clone()),
            None => CVal::Null,
        });
        let c = canon(*lt, v.as_deref(), r, side);
        if c.is_null() {
            return (None, String::new());
        }
        vals.push(c);
    }
    (Some(canon::hex(&encode_all(&vals))), canon::digest(&encode_all(&raw)))
}

fn field_value(f: &FieldSpec, row: &[Option<String>], side: Side) -> CVal {
    let get = |i: usize| row.get(i).cloned().flatten();
    match &f.src {
        FieldSrc::Col(i) => canon(f.lt, get(*i).as_deref(), &f.rules, side),
        FieldSrc::Const(v) => canon(f.lt, Some(v), &f.rules, side),
        FieldSrc::Concat(cols, sep) => {
            let parts: Vec<Option<String>> = cols.iter().map(|i| get(*i)).collect();
            if parts.iter().all(Option::is_none) {
                return CVal::Null;
            }
            let joined = parts.into_iter().map(|p| p.unwrap_or_default()).collect::<Vec<_>>().join(sep);
            canon(LType::Text, Some(&joined), &f.rules, side)
        }
        FieldSrc::Split(i, sep, idx) => match get(*i) {
            None => CVal::Null,
            Some(v) => match v.split(sep.as_str()).nth(*idx as usize) {
                Some(p) => canon(f.lt, Some(p), &f.rules, side),
                None => CVal::Null,
            },
        },
    }
}

/// Evidence state of a field value.
pub fn state(v: &CVal, store: bool) -> String {
    let enc = {
        let mut b = vec![];
        v.encode(&mut b);
        b
    };
    let base = match fill(v) {
        Fill::Null => "N".to_string(),
        Fill::Empty => "E".to_string(),
        Fill::Blank => format!("W:{}", canon::digest(&enc)),
        Fill::Invalid => format!("I:{}", canon::digest(&enc)),
        Fill::Filled => format!("V:{}", canon::digest(&enc)),
    };
    if store && !matches!(v, CVal::Null) {
        format!("{base}|{}", canon::hex(&enc))
    } else {
        base
    }
}

fn cmp_cval(a: &CVal, b: &CVal) -> Ordering {
    match (a, b) {
        (CVal::Num(x), CVal::Num(y)) => cmp_dec(x, y),
        (CVal::Float(x), CVal::Float(y)) => x.parse::<f64>().unwrap_or(0.0).partial_cmp(&y.parse::<f64>().unwrap_or(0.0)).unwrap_or(Ordering::Equal),
        _ => a.text().cmp(&b.text()),
    }
}

/// Exact comparison of normalized decimal strings.
pub fn cmp_dec(a: &str, b: &str) -> Ordering {
    let (na, aa) = a.strip_prefix('-').map(|x| (true, x)).unwrap_or((false, a));
    let (nb, bb) = b.strip_prefix('-').map(|x| (true, x)).unwrap_or((false, b));
    if na != nb {
        return if na { Ordering::Less } else { Ordering::Greater };
    }
    let (ia, fa) = aa.split_once('.').unwrap_or((aa, ""));
    let (ib, fb) = bb.split_once('.').unwrap_or((bb, ""));
    let mag = ia.len().cmp(&ib.len()).then_with(|| ia.cmp(ib)).then_with(|| {
        let w = fa.len().max(fb.len());
        format!("{fa:0<w$}").cmp(&format!("{fb:0<w$}"))
    });
    if na {
        mag.reverse()
    } else {
        mag
    }
}

fn profile_add(p: &mut FieldProfile, v: &CVal) {
    match fill(v) {
        Fill::Null => p.nulls += 1,
        Fill::Empty => p.empty += 1,
        Fill::Blank => p.blank += 1,
        Fill::Invalid => p.invalid += 1,
        Fill::Filled => {
            p.filled += 1;
            let t = v.text();
            let len = t.chars().count() as u64;
            p.min_len = Some(p.min_len.map_or(len, |m| m.min(len)));
            p.max_len = Some(p.max_len.map_or(len, |m| m.max(len)));
            // min/max kept as canonical text, compared by type
            let tag = v.tag();
            let parse = |s: &Option<String>| s.as_ref().map(|s| match tag {
                b'n' => CVal::Num(s.clone()),
                b'f' => CVal::Float(s.clone()),
                _ => CVal::Text(s.clone()),
            });
            if parse(&p.min).is_none_or(|m| cmp_cval(v, &m) == Ordering::Less) {
                p.min = Some(t.clone());
            }
            if parse(&p.max).is_none_or(|m| cmp_cval(v, &m) == Ordering::Greater) {
                p.max = Some(t);
            }
        }
    }
}

pub struct CaptureOut {
    pub rows: u64,
    pub excluded: u64,
    pub null_keys: u64,
    pub distinct_keys: u64,
    pub duplicate_keys: u64,
    pub collisions: u64,
    pub runs: u64,
    pub profile: BTreeMap<String, FieldProfile>,
    pub evidence: Option<EvidenceFile>,
    pub excluded_evidence: Option<EvidenceFile>,
}

/// Turns rows into evidence. Rows are pushed one by one by the adapter's stream.
pub struct Capturer {
    spec: CaptureSpec,
    dir: PathBuf,
    name: String,
    sorter: Option<Sorter>,
    excl: Option<Sorter>,
    pub rows: u64,
    pub excluded: u64,
    pub null_keys: u64,
    profile: Vec<FieldProfile>,
}

impl Capturer {
    pub fn new(spec: CaptureSpec, dir: &Path, name: &str, batch_rows: usize, disk_limit: u64) -> Result<Capturer, String> {
        let sorter = if spec.records { Some(Sorter::new(dir, &format!("{name}.ev"), batch_rows, disk_limit)?) } else { None };
        let excl = if spec.records && spec.excl_idx.is_some() { Some(Sorter::new(dir, &format!("{name}.excl"), batch_rows, disk_limit)?) } else { None };
        let n = spec.fields.len();
        Ok(Capturer { spec, dir: dir.to_path_buf(), name: name.into(), sorter, excl, rows: 0, excluded: 0, null_keys: 0, profile: vec![FieldProfile::default(); n] })
    }

    pub fn push(&mut self, row: &[Option<String>]) -> Result<(), String> {
        let side = self.spec.side;
        let excluded = self.spec.excl_idx.is_some_and(|i| row.get(i).cloned().flatten().as_deref() == Some("1"));
        let vals: Vec<CVal> = self.spec.fields.iter().map(|f| field_value(f, row, side)).collect();
        if excluded {
            self.excluded += 1;
            if let (Some(s), (Some(k), raw)) = (self.excl.as_mut(), key_hex(&self.spec.key.cols, row, side)) {
                s.push(format!("{k}\t1\t{raw}\t*"))?;
            }
            return Ok(());
        }
        self.rows += 1;
        for (p, v) in self.profile.iter_mut().zip(&vals) {
            profile_add(p, v);
        }
        let Some(sorter) = self.sorter.as_mut() else { return Ok(()) };
        let row_digest = if self.spec.write_fields || self.spec.content_identity { canon::digest(&encode_all(&vals)) } else { "-".to_string() };
        let (key, raw) = if self.spec.content_identity {
            (Some(row_digest.clone()), row_digest.clone())
        } else {
            key_hex(&self.spec.key.cols, row, side)
        };
        let Some(key) = key else {
            self.null_keys += 1;
            return Ok(());
        };
        let mut line = format!("{key}\t1\t{raw}\t{row_digest}");
        for fk in &self.spec.fks {
            line.push('\t');
            if let (Some(k), _) = key_hex(&fk.cols, row, side) {
                line.push_str(&k);
            }
        }
        if self.spec.write_fields {
            for v in &vals {
                line.push('\t');
                line.push_str(&state(v, self.spec.store_values));
            }
        }
        sorter.push(line)
    }

    pub fn abort(self) {
        if let Some(s) = self.sorter {
            s.abort();
        }
        if let Some(s) = self.excl {
            s.abort();
        }
    }

    pub fn finish(self) -> Result<CaptureOut, String> {
        let nfk = self.spec.fks.len();
        let mut out = CaptureOut {
            rows: self.rows,
            excluded: self.excluded,
            null_keys: self.null_keys,
            distinct_keys: 0,
            duplicate_keys: 0,
            collisions: 0,
            runs: 0,
            profile: self.spec.fields.iter().map(|f| f.id.clone()).zip(self.profile).collect(),
            evidence: None,
            excluded_evidence: None,
        };
        if let Some(s) = self.sorter {
            let p = self.dir.join(format!("{}.ev", self.name));
            let st = s.finish(&p, Some(nfk))?;
            out.runs = st.runs;
            let mut r = Reader::open(Some(&p), nfk)?;
            while let Some(rec) = r.advance()? {
                out.distinct_keys += 1;
                if rec.n > 1 {
                    out.duplicate_keys += 1;
                }
                if rec.raw == "*" {
                    out.collisions += 1;
                }
            }
            out.evidence = Some(evidence_file(&p, out.distinct_keys)?);
        }
        if let Some(s) = self.excl {
            let p = self.dir.join(format!("{}.excl.ev", self.name));
            let st = s.finish(&p, Some(0))?;
            out.excluded_evidence = Some(evidence_file(&p, st.records)?);
        }
        Ok(out)
    }
}

pub fn evidence_file(p: &Path, records: u64) -> Result<EvidenceFile, String> {
    let (sha, bytes) = file_sha256(p)?;
    Ok(EvidenceFile { path: p.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(), bytes, sha256: sha, records })
}

// ---------------- identity maps ----------------

#[derive(Debug, Default, Clone)]
pub struct MapOut {
    pub pairs: u64,
    pub null_pairs: u64,
    pub dup_source: u64,
    pub dup_target: u64,
    pub unmapped: u64,
    pub map_without_source: u64,
    pub ambiguous_source: u64,
    pub translated_records: u64,
}

/// Captures an id map: pushes "src_key\tdst_key".
pub struct MapCapturer {
    src: KeySpec,
    dst: KeySpec,
    sorter: Sorter,
    pub nulls: u64,
}

impl MapCapturer {
    pub fn new(src: KeySpec, dst: KeySpec, dir: &Path, name: &str, batch: usize, disk: u64) -> Result<Self, String> {
        Ok(MapCapturer { src, dst, sorter: Sorter::new(dir, name, batch, disk)?, nulls: 0 })
    }
    pub fn push(&mut self, row: &[Option<String>]) -> Result<(), String> {
        match (key_hex(&self.src.cols, row, Side::Source).0, key_hex(&self.dst.cols, row, Side::Target).0) {
            (Some(a), Some(b)) => self.sorter.push(format!("{a}\t{b}")),
            _ => {
                self.nulls += 1;
                Ok(())
            }
        }
    }
    /// Writes the map sorted by source key (`<name>.bysrc`) and validates both directions.
    pub fn finish(self, dir: &Path, name: &str, batch: usize, disk: u64, allow_dup_target: bool, f_dup_src: &mut Findings, f_dup_dst: &mut Findings) -> Result<(PathBuf, MapOut), String> {
        let by_src = dir.join(format!("{name}.bysrc"));
        let mut out = MapOut { null_pairs: self.nulls, ..Default::default() };
        self.sorter.finish(&by_src, None)?;
        let mut by_dst = Sorter::new(dir, &format!("{name}.dst"), batch, disk)?;
        let mut r = PairReader::open(&by_src)?;
        let mut last: Option<String> = None;
        let mut last_dup = false;
        while let Some((a, b)) = r.advance()? {
            out.pairs += 1;
            if last.as_deref() == Some(a.as_str()) {
                if !last_dup {
                    out.dup_source += 1;
                    f_dup_src.add(&a)?;
                }
                last_dup = true;
            } else {
                last_dup = false;
            }
            last = Some(a.clone());
            by_dst.push(format!("{b}\t{a}"))?;
        }
        let dst_path = dir.join(format!("{name}.bydst"));
        by_dst.finish(&dst_path, None)?;
        let mut r = PairReader::open(&dst_path)?;
        let mut last: Option<String> = None;
        let mut last_dup = false;
        while let Some((b, _)) = r.advance()? {
            if last.as_deref() == Some(b.as_str()) {
                if !last_dup {
                    out.dup_target += 1;
                    if !allow_dup_target {
                        f_dup_dst.add(&b)?;
                    }
                }
                last_dup = true;
            } else {
                last_dup = false;
            }
            last = Some(b);
        }
        let _ = std::fs::remove_file(&dst_path);
        Ok((by_src, out))
    }
}

/// Re-keys source evidence through a map sorted by source key. Source keys mapped to several
/// targets are ambiguous (not compared); keys without a mapping are reported.
#[allow(clippy::too_many_arguments)]
pub fn translate(src: &Path, nfk: usize, map_by_src: &Path, out: &Path, dir: &Path, batch: usize, disk: u64, f_unmapped: &mut Findings, f_ambiguous: &mut Findings, f_orphan_map: &mut Findings) -> Result<MapOut, String> {
    let mut stats = MapOut::default();
    let mut ev = Reader::open(Some(src), nfk)?;
    let mut map = PairReader::open(map_by_src)?;
    let mut sorter = Sorter::new(dir, "translate", batch, disk)?;
    loop {
        let ek = ev.key().map(str::to_string);
        let mk = map.peeked.as_ref().map(|p| p.0.clone());
        match (ek, mk) {
            (None, None) => break,
            (Some(_), None) => {
                let r = ev.advance()?.unwrap();
                stats.unmapped += 1;
                f_unmapped.add(&r.key)?;
            }
            (None, Some(_)) => {
                let (a, _) = map.advance()?.unwrap();
                stats.map_without_source += 1;
                f_orphan_map.add(&a)?;
                while map.peeked.as_ref().is_some_and(|p| p.0 == a) {
                    map.advance()?;
                }
            }
            (Some(e), Some(m)) => match e.cmp(&m) {
                Ordering::Less => {
                    let r = ev.advance()?.unwrap();
                    stats.unmapped += 1;
                    f_unmapped.add(&r.key)?;
                }
                Ordering::Greater => {
                    let (a, _) = map.advance()?.unwrap();
                    stats.map_without_source += 1;
                    f_orphan_map.add(&a)?;
                    while map.peeked.as_ref().is_some_and(|p| p.0 == a) {
                        map.advance()?;
                    }
                }
                Ordering::Equal => {
                    let r = ev.advance()?.unwrap();
                    let mut targets = vec![];
                    while map.peeked.as_ref().is_some_and(|p| p.0 == e) {
                        targets.push(map.advance()?.unwrap().1);
                    }
                    if targets.len() > 1 {
                        stats.ambiguous_source += 1;
                        f_ambiguous.add(&r.key)?;
                        continue;
                    }
                    let mut t = r;
                    t.key = targets.pop().unwrap_or_default();
                    sorter.push(t.line())?;
                    stats.translated_records += 1;
                }
            },
        }
    }
    sorter.finish(out, Some(nfk))?;
    Ok(stats)
}

// ---------------- comparison ----------------

#[derive(Debug, Clone)]
pub struct FieldCmp {
    pub id: String,
    pub label: String,
    pub rules: Rules,
    /// Rules changed after the baseline and the values were not stored: not compared.
    pub blocked: Option<String>,
}

pub struct CompareSpec {
    pub fields: Vec<FieldCmp>,
    /// Relationships whose parent has no id map (FK keys compared directly).
    pub direct_fk: Vec<bool>,
    pub nfk: usize,
    pub exclude_preexisting: bool,
    pub max_examples: usize,
}

#[derive(Debug, Default)]
pub struct CompareOut {
    pub source_records: u64,
    pub target_records: u64,
    pub missing: u64,
    pub extra: u64,
    pub multiplicity: u64,
    pub preexisting: u64,
    pub preexisting_matched: u64,
    pub excluded_present: u64,
    pub ambiguous: u64,
    pub matched: u64,
    pub source_rows: u64,
    pub target_rows: u64,
    pub fields: Vec<FieldResult>,
    pub rel_changed: Vec<u64>,
    pub files: BTreeMap<String, PathBuf>,
    pub counts: BTreeMap<String, u64>,
    pub fk_pending: Vec<Option<PathBuf>>,
}

fn split_state(s: &str) -> (&str, Option<&str>) {
    match s.split_once('|') {
        Some((a, b)) => (a, Some(b)),
        None => (s, None),
    }
}

fn empty_class(s: &str) -> Option<char> {
    match s.as_bytes().first() {
        Some(b'N') => Some('N'),
        Some(b'E') => Some('E'),
        Some(b'W') => Some('W'),
        _ => None,
    }
}

fn decoded_num(hexv: Option<&str>) -> Option<String> {
    let b = canon::unhex(hexv?).ok()?;
    match CVal::decode(&b).ok()?.0 {
        CVal::Num(n) => Some(n),
        _ => None,
    }
}

/// Classifies a field pair. Returns (category, counts as compared).
pub fn classify(sf: &str, df: &str, rules: &Rules) -> &'static str {
    if sf == "*" || df == "*" {
        return "not_compared";
    }
    let (sa, sv) = split_state(sf);
    let (da, dv) = split_state(df);
    if sa.starts_with('I') || da.starts_with('I') {
        return if sa == da { "equal" } else { "invalid" };
    }
    match (empty_class(sa), empty_class(da)) {
        (Some(a), Some(b)) => {
            if a == b && sa == da {
                "both_empty"
            } else {
                // e.g. "" vs NULL without the empty=null rule: not silently equal
                "divergent"
            }
        }
        (None, Some(_)) => "lost",
        (Some(_), None) => "created",
        (None, None) => {
            if sa == da {
                return "equal";
            }
            if !rules.tol_abs.is_empty() || !rules.tol_rel.is_empty() {
                if let (Some(a), Some(b)) = (decoded_num(sv), decoded_num(dv)) {
                    if canon::within_tolerance(&a, &b, &rules.tol_abs, &rules.tol_rel) == Some(true) {
                        return "equal_tolerance";
                    }
                }
            }
            "divergent"
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn compare(src: &Path, excl: Option<&Path>, dst: &Path, pre: Option<&Path>, spec: &CompareSpec, out_dir: &Path, batch: usize, disk: u64) -> Result<CompareOut, String> {
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let mx = spec.max_examples;
    let mut f_missing = Findings::create(out_dir.join("missing.tsv"), mx)?;
    let mut f_extra = Findings::create(out_dir.join("extra.tsv"), mx)?;
    let mut f_mult = Findings::create(out_dir.join("multiplicity.tsv"), mx)?;
    let mut f_fields = Findings::create(out_dir.join("fields.tsv"), mx)?;
    let mut f_rel = Findings::create(out_dir.join("relations.tsv"), mx)?;
    let mut f_amb = Findings::create(out_dir.join("ambiguous.tsv"), mx)?;
    let mut s = Reader::open(Some(src), spec.nfk)?;
    let mut d = Reader::open(Some(dst), spec.nfk)?;
    let mut x = Reader::open(excl, 0)?;
    let mut p = Reader::open(pre, spec.nfk)?;
    let mut out = CompareOut { fields: spec.fields.iter().map(|f| FieldResult { field_id: f.id.clone(), label: f.label.clone(), ..Default::default() }).collect(), rel_changed: vec![0; spec.nfk], ..Default::default() };
    let mut fk_sorters: Vec<Option<Sorter>> = (0..spec.nfk).map(|i| if spec.direct_fk.get(i).copied().unwrap_or(true) { None } else { Sorter::new(out_dir, &format!("fk{i}"), batch, disk).ok() }).collect();
    loop {
        let (sk, dk) = (s.key().map(str::to_string), d.key().map(str::to_string));
        let ord = match (&sk, &dk) {
            (None, None) => break,
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (Some(a), Some(b)) => a.cmp(b),
        };
        match ord {
            Ordering::Less => {
                let r = s.advance()?.unwrap();
                out.source_records += 1;
                out.source_rows += r.n;
                out.missing += 1;
                f_missing.add(&format!("{}\t{}", r.key, r.n))?;
            }
            Ordering::Greater => {
                let r = d.advance()?.unwrap();
                out.target_records += 1;
                out.target_rows += r.n;
                if x.seek(&r.key)?.is_some() {
                    out.excluded_present += 1;
                } else if p.seek(&r.key)?.is_some() {
                    out.preexisting += 1;
                } else {
                    out.extra += 1;
                    f_extra.add(&format!("{}\t{}", r.key, r.n))?;
                }
            }
            Ordering::Equal => {
                let a = s.advance()?.unwrap();
                let b = d.advance()?.unwrap();
                out.source_records += 1;
                out.target_records += 1;
                out.source_rows += a.n;
                out.target_rows += b.n;
                if spec.exclude_preexisting && p.seek(&a.key)?.is_some() {
                    // the identity already existed in the target before the load: cannot be
                    // attributed to the conversion
                    out.preexisting_matched += 1;
                    f_amb.add(&format!("{}\tpreexisting", a.key))?;
                    continue;
                }
                out.matched += 1;
                if a.n != b.n {
                    out.multiplicity += 1;
                    f_mult.add(&format!("{}\t{}\t{}", a.key, a.n, b.n))?;
                }
                if a.n != 1 || b.n != 1 {
                    out.ambiguous += 1;
                    f_amb.add(&format!("{}\tduplicate", a.key))?;
                    for fr in out.fields.iter_mut() {
                        fr.not_compared += 1;
                    }
                    continue;
                }
                compare_fields(&a, &b, spec, &mut out, &mut f_fields)?;
                for i in 0..spec.nfk {
                    let (sf, df) = (&a.fks[i], &b.fks[i]);
                    match fk_sorters[i].as_mut() {
                        None => {
                            if sf != df {
                                out.rel_changed[i] += 1;
                                f_rel.add(&format!("{}\t{i}\tchanged", a.key))?;
                            }
                        }
                        Some(st) => {
                            if !sf.is_empty() || !df.is_empty() {
                                st.push(format!("{}\t{}\t{}", if sf.is_empty() { "-" } else { sf }, a.key, df))?;
                            } else {
                                // both NULL: relationship preserved as absent
                            }
                        }
                    }
                }
            }
        }
    }
    for (i, st) in fk_sorters.into_iter().enumerate() {
        out.fk_pending.push(match st {
            Some(st) => {
                let p = out_dir.join(format!("fk{i}.pending"));
                st.finish(&p, None)?;
                Some(p)
            }
            None => None,
        });
    }
    for (name, f) in [("missing", f_missing), ("extra", f_extra), ("multiplicity", f_mult), ("fields", f_fields), ("relations", f_rel), ("ambiguous", f_amb)] {
        let (path, count, _) = f.close()?;
        out.counts.insert(name.into(), count);
        out.files.insert(name.into(), path);
    }
    Ok(out)
}

fn compare_fields(a: &Rec, b: &Rec, spec: &CompareSpec, out: &mut CompareOut, f: &mut Findings) -> Result<(), String> {
    for (i, fc) in spec.fields.iter().enumerate() {
        let fr = &mut out.fields[i];
        if fc.blocked.is_some() {
            fr.not_compared += 1;
            continue;
        }
        let (sf, df) = (a.fields.get(i).map(String::as_str).unwrap_or("*"), b.fields.get(i).map(String::as_str).unwrap_or("*"));
        let cat = classify(sf, df, &fc.rules);
        if cat != "not_compared" {
            fr.compared += 1;
        }
        match cat {
            "equal" | "equal_tolerance" => fr.equal += 1,
            "both_empty" => fr.both_empty += 1,
            "lost" => fr.lost += 1,
            "created" => fr.created += 1,
            "divergent" => fr.divergent += 1,
            "invalid" => fr.invalid += 1,
            _ => fr.not_compared += 1,
        }
        if matches!(cat, "lost" | "created" | "divergent" | "invalid") {
            let sv = split_state(sf).1.unwrap_or("");
            let dv = split_state(df).1.unwrap_or("");
            f.add(&format!("{}\t{i}\t{cat}\t{sv}\t{dv}", a.key))?;
        }
    }
    Ok(())
}

/// Relationship through the parent's id map: translates each child's source FK and compares it
/// with the target FK (a valid FK may still point to the wrong entity).
pub fn check_fk_via_map(pending: &Path, parent_map_by_src: &Path, rel_index: usize, f_rel: &mut Findings) -> Result<(u64, u64), String> {
    let mut changed = 0;
    let mut unmapped = 0;
    let mut map = PairReader::open(parent_map_by_src)?;
    let mut r = PairReader::open(pending)?;
    while let Some((sfk, rest)) = r.advance()? {
        let (child, dfk) = rest.split_once('\t').unwrap_or((rest.as_str(), ""));
        if sfk == "-" {
            if !dfk.is_empty() {
                changed += 1;
                f_rel.add(&format!("{child}\t{rel_index}\tcreated"))?;
            }
            continue;
        }
        while map.peeked.as_ref().is_some_and(|p| p.0.as_str() < sfk.as_str()) {
            map.advance()?;
        }
        let expected = map.peeked.as_ref().filter(|p| p.0 == sfk).map(|p| p.1.clone());
        match expected {
            None => {
                unmapped += 1;
                f_rel.add(&format!("{child}\t{rel_index}\tunmapped_fk"))?;
            }
            Some(e) if e != dfk => {
                changed += 1;
                f_rel.add(&format!("{child}\t{rel_index}\tchanged"))?;
            }
            _ => {}
        }
    }
    Ok((changed, unmapped))
}

/// Orphans: FK values of `child` evidence that are not keys of `parent` evidence.
pub fn orphans(child: &Path, nfk: usize, fk: usize, parent: &Path, parent_nfk: usize, dir: &Path, batch: usize, disk: u64, f: &mut Findings) -> Result<u64, String> {
    let mut st = Sorter::new(dir, &format!("orph{fk}"), batch, disk)?;
    let mut r = Reader::open(Some(child), nfk)?;
    while let Some(rec) = r.advance()? {
        let v = &rec.fks[fk];
        if !v.is_empty() && v != "*" {
            st.push(format!("{v}\t{}", rec.key))?;
        }
    }
    let p = dir.join(format!("orph{fk}.sorted"));
    st.finish(&p, None)?;
    let mut list = PairReader::open(&p)?;
    let mut par = Reader::open(Some(parent), parent_nfk)?;
    let mut n = 0;
    while let Some((fkv, childk)) = list.advance()? {
        // advance without consuming the equal record (several children share a parent)
        while par.key().is_some_and(|k| k < fkv.as_str()) {
            par.advance()?;
        }
        let present = par.key() == Some(fkv.as_str());
        if !present {
            n += 1;
            f.add(&format!("{childk}\t{fk}\torphan\t{fkv}"))?;
        }
    }
    let _ = std::fs::remove_file(&p);
    Ok(n)
}

/// Human-readable rendering of a key hex (typed values joined by " | ").
pub fn render_key(hex: &str) -> String {
    match canon::unhex(hex).and_then(|b| canon::decode_all(&b)) {
        Ok(v) => v.iter().map(|x| match x {
            CVal::Null => "NULL".to_string(),
            o => o.text(),
        }).collect::<Vec<_>>().join(" | "),
        Err(_) => hex.to_string(),
    }
}

pub fn render_value(hex: &str) -> String {
    if hex.is_empty() {
        return String::new();
    }
    match canon::unhex(hex).and_then(|b| CVal::decode(&b).map(|x| x.0)) {
        Ok(CVal::Null) => "NULL".into(),
        Ok(v) => v.text(),
        Err(_) => hex.into(),
    }
}
