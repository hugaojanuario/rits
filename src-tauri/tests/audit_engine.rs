//! Migration Audit: deterministic engine against small fixtures with known results (the scenarios
//! of the specification that do not need a database). Database scenarios (permission error,
//! cancellation, source changed after the baseline, estimated counts in a real run) are in
//! audit_db.rs.

use rits_lib::audit::analysis;
use rits_lib::audit::canon::{self, canon, CVal, LType, Rules, Side};
use rits_lib::audit::engine::{self, CaptureOut, CaptureSpec, Capturer, CompareOut, CompareSpec, FieldCmp, FieldSpec, FieldSrc, KeySpec, MapCapturer};
use rits_lib::audit::evidence::Findings;
use rits_lib::audit::model::*;
use rits_lib::audit::{report, runner, store};
use std::path::{Path, PathBuf};

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("rits-audit-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

type Row = Vec<Option<String>>;

fn row(v: &[Option<&str>]) -> Row {
    v.iter().map(|x| x.map(str::to_string)).collect()
}

fn key(cols: &[usize], lt: LType) -> KeySpec {
    KeySpec { cols: cols.iter().map(|i| (*i, lt, Rules::default())).collect() }
}

fn field(id: &str, col: usize, lt: LType) -> FieldSpec {
    FieldSpec { id: id.into(), src: FieldSrc::Col(col), lt, rules: Rules::default() }
}

fn spec(side: Side, key: KeySpec, fields: Vec<FieldSpec>) -> CaptureSpec {
    CaptureSpec { side, key, content_identity: false, fields, fks: vec![], excl_idx: None, store_values: true, records: true, write_fields: true }
}

fn capture(dir: &Path, name: &str, s: CaptureSpec, rows: &[Row], batch: usize) -> CaptureOut {
    let mut c = Capturer::new(s, dir, name, batch, 0).unwrap();
    for r in rows {
        c.push(r).unwrap();
    }
    c.finish().unwrap()
}

fn cmp_spec(fields: &[&str]) -> CompareSpec {
    CompareSpec { fields: fields.iter().map(|f| FieldCmp { id: f.to_string(), label: f.to_string(), rules: Rules::default(), blocked: None }).collect(), direct_fk: vec![], nfk: 0, exclude_preexisting: false, max_examples: 10 }
}

fn compare(dir: &Path, a: &CaptureOut, b: &CaptureOut, s: &CompareSpec) -> CompareOut {
    let src = dir.join(&a.evidence.as_ref().unwrap().path);
    let dst = dir.join(&b.evidence.as_ref().unwrap().path);
    let excl = a.excluded_evidence.as_ref().map(|e| dir.join(&e.path));
    engine::compare(&src, excl.as_deref(), &dst, None, s, &dir.join("out"), 1000, 0).unwrap()
}

fn ids(range: std::ops::RangeInclusive<u32>) -> Vec<Row> {
    range.map(|i| vec![Some(i.to_string()), Some(format!("nome {i}"))]).collect()
}

fn lines(p: &Path) -> Vec<String> {
    std::fs::read_to_string(p).unwrap_or_default().lines().map(str::to_string).collect()
}

fn missing_keys(dir: &Path) -> Vec<String> {
    lines(&dir.join("out").join("missing.tsv")).iter().map(|l| engine::render_key(l.split('\t').next().unwrap())).collect()
}

// 1. one-to-one correct migration
#[test]
fn s01_one_to_one_correct() {
    let d = tmp("s01");
    let rows = ids(1..=200);
    let a = capture(&d, "a", spec(Side::Source, key(&[0], LType::Int), vec![field("nome", 1, LType::Text)]), &rows, 1000);
    let b = capture(&d, "b", spec(Side::Target, key(&[0], LType::Int), vec![field("nome", 1, LType::Text)]), &rows, 1000);
    let c = compare(&d, &a, &b, &cmp_spec(&["nome"]));
    assert_eq!((c.missing, c.extra, c.multiplicity, c.matched), (0, 0, 0, 200));
    assert_eq!(c.fields[0].equal, 200);
    assert_eq!(c.fields[0].divergent + c.fields[0].lost + c.fields[0].created, 0);
}

// 2. 15,000 source vs 14,500 target: the exact 500 missing identities
// 23. processing larger than the batch (runs spilled to disk)
#[test]
fn s02_s23_missing_500_with_small_batches() {
    let d = tmp("s02");
    let src = ids(1..=15_000);
    let dst: Vec<Row> = src.iter().filter(|r| r[0].as_deref().unwrap().parse::<u32>().unwrap() % 30 != 0).cloned().collect();
    assert_eq!(dst.len(), 14_500);
    let a = capture(&d, "a", spec(Side::Source, key(&[0], LType::Int), vec![]), &src, 1000);
    assert!(a.runs >= 15, "deveria gravar vários blocos ordenados, gravou {}", a.runs);
    let b = capture(&d, "b", spec(Side::Target, key(&[0], LType::Int), vec![]), &dst, 777);
    let c = compare(&d, &a, &b, &cmp_spec(&[]));
    assert_eq!(c.missing, 500);
    assert_eq!(c.extra, 0);
    let mut got: Vec<u32> = missing_keys(&d).iter().map(|k| k.parse().unwrap()).collect();
    got.sort();
    let want: Vec<u32> = (1..=15_000).filter(|i| i % 30 == 0).collect();
    assert_eq!(got, want);
}

// 3. same count, different identities
#[test]
fn s03_same_count_different_identities() {
    let d = tmp("s03");
    let a = capture(&d, "a", spec(Side::Source, key(&[0], LType::Int), vec![]), &ids(1..=1000), 1000);
    let b = capture(&d, "b", spec(Side::Target, key(&[0], LType::Int), vec![]), &ids(11..=1010), 1000);
    assert_eq!(a.rows, b.rows);
    let c = compare(&d, &a, &b, &cmp_spec(&[]));
    assert_eq!((c.missing, c.extra), (10, 10));
}

// 4. loss compensated by duplication
#[test]
fn s04_loss_compensated_by_duplication() {
    let d = tmp("s04");
    let src = ids(1..=100);
    let mut dst = ids(1..=99);
    dst.push(vec![Some("50".into()), Some("nome 50".into())]);
    assert_eq!(src.len(), dst.len());
    let a = capture(&d, "a", spec(Side::Source, key(&[0], LType::Int), vec![field("nome", 1, LType::Text)]), &src, 1000);
    let b = capture(&d, "b", spec(Side::Target, key(&[0], LType::Int), vec![field("nome", 1, LType::Text)]), &dst, 1000);
    assert_eq!(b.duplicate_keys, 1);
    let c = compare(&d, &a, &b, &cmp_spec(&["nome"]));
    assert_eq!(c.missing, 1);
    assert_eq!(c.multiplicity, 1);
    assert_eq!(c.ambiguous, 1);
    // the duplicated key is not compared field by field (no arbitrary row is picked)
    assert_eq!(c.fields[0].not_compared, 1);
    let v = runner::volume_result("1:1", true, true, false, Some(0));
    assert_eq!(v.result, "compatible", "volume isolado parece correto, mas a identidade revela a perda");
}

// 5. whole table not converted + tables without coverage
#[test]
fn s05_table_not_converted_and_uncovered() {
    let d = tmp("s05");
    let a = capture(&d, "a", spec(Side::Source, key(&[0], LType::Int), vec![]), &ids(1..=50), 1000);
    let b = capture(&d, "b", spec(Side::Target, key(&[0], LType::Int), vec![]), &[], 1000);
    let c = compare(&d, &a, &b, &cmp_spec(&[]));
    assert_eq!(c.missing, 50);
    let st = Structure { tables: vec![Table { schema: "public".into(), name: "clientes".into(), kind: "table".into(), ..Default::default() }, Table { schema: "public".into(), name: "pedidos".into(), kind: "table".into(), ..Default::default() }, Table { schema: "public".into(), name: "v_clientes".into(), kind: "view".into(), ..Default::default() }], ..Default::default() };
    let m = Mappings { units: vec![Unit { id: "u1".into(), source: Dataset { kind: "table".into(), schema: "public".into(), table: "clientes".into(), ..Default::default() }, ..Default::default() }], ..Default::default() };
    let (tables, views) = analysis::uncovered(&m, &st);
    assert_eq!(tables, vec!["public.pedidos"]);
    assert_eq!(views, vec!["public.v_clientes"]);
}

fn col(name: &str, native: &str, lt: LType, nullable: bool) -> Column {
    Column { name: name.into(), native: native.into(), ltype: Some(lt), nullable, ..Default::default() }
}

// 6. field not mapped
#[test]
fn s06_unmapped_field() {
    let src = Structure { tables: vec![Table { schema: "s".into(), name: "c".into(), kind: "table".into(), columns: vec![col("id", "int", LType::Int, false), col("nome", "text", LType::Text, true), col("nascimento", "date", LType::Date, true)], ..Default::default() }], ..Default::default() };
    let dst = Structure { tables: vec![Table { schema: "s".into(), name: "c".into(), kind: "table".into(), columns: vec![col("id", "int", LType::Int, false), col("nome", "text", LType::Text, true), col("obrigatorio", "text", LType::Text, false)], ..Default::default() }], ..Default::default() };
    let u = Unit {
        id: "u".into(),
        source: Dataset { kind: "table".into(), schema: "s".into(), table: "c".into(), ..Default::default() },
        target: Dataset { kind: "table".into(), schema: "s".into(), table: "c".into(), ..Default::default() },
        cardinality: "1:1".into(),
        identity: Identity { kind: "key".into(), source: vec![KeyCol { column: "id".into(), ..Default::default() }], target: vec![KeyCol { column: "id".into(), ..Default::default() }], map: None },
        fields: vec![FieldMap { id: "f1".into(), kind: "map".into(), source_cols: vec!["nome".into()], target_col: "nome".into(), confirmed: true, ..Default::default() }],
        confirmed: true,
        ..Default::default()
    };
    let r = analysis::check_unit(&u, Some(&src), Some(&dst));
    assert_eq!(r.unmapped_source, vec!["nascimento"]);
    assert_eq!(r.unsourced_required, vec!["obrigatorio"]);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
}

// 7. date mapped but partially NULL in the target; 8. dates already NULL in the source
#[test]
fn s07_s08_fill_losses_without_false_positives() {
    let d = tmp("s07");
    let src: Vec<Row> = (1..=8000).map(|i| vec![Some(i.to_string()), if i % 10 == 0 { None } else { Some(format!("1990-01-{:02}", i % 28 + 1)) }]).collect();
    let dst: Vec<Row> = src.iter().enumerate().map(|(i, r)| if i < 350 && r[1].is_some() { vec![r[0].clone(), None] } else { r.clone() }).collect();
    let lost_expected = src.iter().take(350).filter(|r| r[1].is_some()).count() as u64;
    let a = capture(&d, "a", spec(Side::Source, key(&[0], LType::Int), vec![field("nasc", 1, LType::Date)]), &src, 3000);
    let b = capture(&d, "b", spec(Side::Target, key(&[0], LType::Int), vec![field("nasc", 1, LType::Date)]), &dst, 3000);
    let c = compare(&d, &a, &b, &cmp_spec(&["nasc"]));
    assert_eq!(c.fields[0].lost, lost_expected);
    assert_eq!(c.fields[0].both_empty, 800, "nulos na origem não são perdas");
    assert_eq!(c.fields[0].created, 0);
    assert_eq!(c.fields[0].divergent, 0);
    assert_eq!(a.profile["nasc"].nulls, 800);
    assert_eq!(b.profile["nasc"].nulls, 800 + lost_expected);
}

fn map_capture(d: &Path, pairs: &[(&str, &str)], allow_dup: bool) -> (PathBuf, engine::MapOut, Findings, Findings) {
    let mut mc = MapCapturer::new(key(&[0], LType::Int), key(&[1], LType::Int), d, "map", 1000, 0).unwrap();
    for (a, b) in pairs {
        mc.push(&row(&[Some(a), Some(b)])).unwrap();
    }
    let mut f1 = Findings::create(d.join("dup_src.tsv"), 10).unwrap();
    let mut f2 = Findings::create(d.join("dup_dst.tsv"), 10).unwrap();
    let (p, s) = mc.finish(d, "map", 1000, 0, allow_dup, &mut f1, &mut f2).unwrap();
    (p, s, f1, f2)
}

// 9. ids recreated with a valid map
#[test]
fn s09_recreated_ids_with_valid_map() {
    let d = tmp("s09");
    let src: Vec<Row> = (1..=100).map(|i| vec![Some(i.to_string()), Some(format!("x{i}"))]).collect();
    let dst: Vec<Row> = (1..=100).map(|i| vec![Some((i + 5000).to_string()), Some(format!("x{i}"))]).collect();
    let pairs: Vec<(String, String)> = (1..=100).map(|i| (i.to_string(), (i + 5000).to_string())).collect();
    let pr: Vec<(&str, &str)> = pairs.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    let a = capture(&d, "a", spec(Side::Source, key(&[0], LType::Int), vec![field("v", 1, LType::Text)]), &src, 1000);
    let b = capture(&d, "b", spec(Side::Target, key(&[0], LType::Int), vec![field("v", 1, LType::Text)]), &dst, 1000);
    // without the map, equal numeric ids are NOT assumed to be the same entity
    let raw = compare(&d, &a, &b, &cmp_spec(&["v"]));
    assert_eq!((raw.missing, raw.extra), (100, 100));
    let (mp, stats, _, _) = map_capture(&d, &pr, false);
    assert_eq!((stats.dup_source, stats.dup_target), (0, 0));
    let mut f = [Findings::create(d.join("u.tsv"), 5).unwrap(), Findings::create(d.join("a.tsv"), 5).unwrap(), Findings::create(d.join("o.tsv"), 5).unwrap()];
    let [f1, f2, f3] = &mut f;
    let tr = d.join("tr.ev");
    let t = engine::translate(&d.join(&a.evidence.as_ref().unwrap().path), 0, &mp, &tr, &d, 1000, 0, f1, f2, f3).unwrap();
    assert_eq!((t.unmapped, t.map_without_source, t.ambiguous_source), (0, 0, 0));
    let c = engine::compare(&tr, None, &d.join(&b.evidence.as_ref().unwrap().path), None, &cmp_spec(&["v"]), &d.join("out2"), 1000, 0).unwrap();
    assert_eq!((c.missing, c.extra), (0, 0));
    assert_eq!(c.fields[0].equal, 100);
}

// 10. incomplete or ambiguous map
#[test]
fn s10_incomplete_and_ambiguous_map() {
    let d = tmp("s10");
    let src: Vec<Row> = (1..=10).map(|i| vec![Some(i.to_string())]).collect();
    let a = capture(&d, "a", spec(Side::Source, key(&[0], LType::Int), vec![]), &src, 1000);
    // 1..7 mapped, 8 mapped twice (ambiguous), 9 and 10 without mapping, 99 maps a missing source,
    // 1 and 2 collapse into the same target id
    let (mp, stats, _, _) = map_capture(&d, &[("1", "100"), ("2", "100"), ("3", "103"), ("4", "104"), ("5", "105"), ("6", "106"), ("7", "107"), ("8", "108"), ("8", "118"), ("99", "199")], false);
    assert_eq!(stats.dup_source, 1);
    assert_eq!(stats.dup_target, 1);
    let mut f = [Findings::create(d.join("u.tsv"), 5).unwrap(), Findings::create(d.join("a.tsv"), 5).unwrap(), Findings::create(d.join("o.tsv"), 5).unwrap()];
    let [f1, f2, f3] = &mut f;
    let tr = d.join("tr.ev");
    let t = engine::translate(&d.join(&a.evidence.as_ref().unwrap().path), 0, &mp, &tr, &d, 1000, 0, f1, f2, f3).unwrap();
    assert_eq!(t.unmapped, 2);
    assert_eq!(t.ambiguous_source, 1);
    assert_eq!(t.map_without_source, 1);
    // 1 and 2 became the same target identity: multiplicity 2 after translation
    let dst: Vec<Row> = ["100", "103", "104", "105", "106", "107"].iter().map(|x| vec![Some(x.to_string())]).collect();
    let b = capture(&d, "b", spec(Side::Target, key(&[0], LType::Int), vec![]), &dst, 1000);
    let c = engine::compare(&tr, None, &d.join(&b.evidence.as_ref().unwrap().path), None, &cmp_spec(&[]), &d.join("out"), 1000, 0).unwrap();
    assert_eq!(c.multiplicity, 1);
    assert_eq!(c.missing, 0);
}

// 11. composite keys
#[test]
fn s11_composite_keys() {
    let d = tmp("s11");
    let src: Vec<Row> = (1..=20).flat_map(|i| (1..=3).map(move |j| vec![Some(i.to_string()), Some(j.to_string())])).collect();
    let dst: Vec<Row> = src.iter().filter(|r| !(r[0].as_deref() == Some("7") && r[1].as_deref() == Some("2"))).cloned().collect();
    let a = capture(&d, "a", spec(Side::Source, key(&[0, 1], LType::Int), vec![]), &src, 1000);
    let b = capture(&d, "b", spec(Side::Target, key(&[0, 1], LType::Int), vec![]), &dst, 1000);
    let c = compare(&d, &a, &b, &cmp_spec(&[]));
    assert_eq!(c.missing, 1);
    assert_eq!(missing_keys(&d), vec!["7 | 2"]);
}

// 12. duplicated keys; 13. collision introduced by normalization
#[test]
fn s12_s13_duplicates_and_normalization_collisions() {
    let d = tmp("s12");
    let rows = vec![row(&[Some("A1"), Some("x")]), row(&[Some("A1"), Some("y")]), row(&[Some("b2"), Some("z")]), row(&[Some(" B2 "), Some("w")])];
    let a = capture(&d, "a", spec(Side::Source, KeySpec { cols: vec![(0, LType::Text, Rules::default())] }, vec![]), &rows, 1000);
    assert_eq!(a.duplicate_keys, 1, "A1 repetido");
    assert_eq!(a.collisions, 0, "sem normalização, b2 e ' B2 ' são chaves diferentes");
    let norm = Rules { trim: true, case_insensitive: true, ..Default::default() };
    let b = capture(&d, "b", spec(Side::Source, KeySpec { cols: vec![(0, LType::Text, norm)] }, vec![]), &rows, 1000);
    assert_eq!(b.collisions, 1, "b2 e ' B2 ' colidem depois de trim + minúsculas");
    assert_eq!(b.duplicate_keys, 2);
}

// 14. target with data from before the conversion
#[test]
fn s14_target_with_preexisting_data() {
    let d = tmp("s14");
    let a = capture(&d, "a", spec(Side::Source, key(&[0], LType::Int), vec![]), &ids(1..=100), 1000);
    let pre = capture(&d, "pre", spec(Side::Target, key(&[0], LType::Int), vec![]), &ids(9001..=9020), 1000);
    let mut after = ids(9001..=9020);
    after.extend(ids(1..=100));
    let b = capture(&d, "b", spec(Side::Target, key(&[0], LType::Int), vec![]), &after, 1000);
    let without = compare(&d, &a, &b, &cmp_spec(&[]));
    assert_eq!(without.extra, 20, "sem a baseline do destino, os antigos parecem extras");
    let s = CompareSpec { exclude_preexisting: true, ..cmp_spec(&[]) };
    let c = engine::compare(&d.join(&a.evidence.as_ref().unwrap().path), None, &d.join(&b.evidence.as_ref().unwrap().path), Some(&d.join(&pre.evidence.as_ref().unwrap().path)), &s, &d.join("out2"), 1000, 0).unwrap();
    assert_eq!((c.extra, c.preexisting, c.missing), (0, 20, 0));
    // the volume must not be inferred from count differences without a delimitation
    assert_eq!(runner::volume_result("1:1", true, true, true, Some(20)).result, "inconclusive");
}

// 15. filters and justified exclusions
#[test]
fn s15_exclusions_are_not_missing() {
    let d = tmp("s15");
    // column 2 = exclusion flag computed by the adapter from the justified predicate
    let src: Vec<Row> = (1..=100).map(|i| vec![Some(i.to_string()), Some("x".into()), Some(if i > 90 { "1".into() } else { "0".into() })]).collect();
    let mut s = spec(Side::Source, key(&[0], LType::Int), vec![]);
    s.excl_idx = Some(2);
    let a = capture(&d, "a", s, &src, 1000);
    assert_eq!((a.rows, a.excluded), (90, 10));
    let mut dst = ids(1..=90);
    dst.push(vec![Some("95".into()), Some("x".into())]);
    let b = capture(&d, "b", spec(Side::Target, key(&[0], LType::Int), vec![]), &dst, 1000);
    let c = compare(&d, &a, &b, &cmp_spec(&[]));
    assert_eq!(c.missing, 0);
    assert_eq!(c.extra, 0);
    assert_eq!(c.excluded_present, 1, "excluído intencionalmente mas presente no destino é informado");
}

// 16. one-to-many without a sufficient rule; 24. estimated counts never approve
#[test]
fn s16_s24_inconclusive_volume() {
    assert_eq!(runner::volume_result("1:N", false, true, false, Some(0)).result, "inconclusive");
    assert_eq!(runner::volume_result("1:1", true, false, false, Some(0)).result, "inconclusive");
    assert_eq!(runner::volume_result("1:1", true, true, false, Some(-500)).result, "divergent");
    let u = Unit { cardinality: "1:N".into(), identity: Identity { kind: "none".into(), ..Default::default() }, confirmed: true, ..Default::default() };
    let r = analysis::check_unit(&u, None, None);
    assert!(r.warnings.iter().any(|w| w.contains("inconclusivos")));
}

// 17. decimal precision and leading zeros
#[test]
fn s17_decimals_and_leading_zeros() {
    let r = Rules::default();
    assert_eq!(canon(LType::Decimal, Some("10.50"), &r, Side::Source), canon(LType::Decimal, Some("10.5"), &r, Side::Target));
    assert_eq!(canon::norm_decimal("-0.000"), Some("0".into()));
    assert_eq!(canon::norm_decimal("1.5E+3"), Some("1500".into()));
    assert_eq!(canon::norm_decimal("000123.4500"), Some("123.45".into()));
    assert_ne!(canon(LType::Decimal, Some("10.501"), &r, Side::Source), canon(LType::Decimal, Some("10.5"), &r, Side::Target));
    // documents and codes keep leading zeros (text)
    assert_ne!(canon(LType::Text, Some("00123"), &r, Side::Source), canon(LType::Text, Some("123"), &r, Side::Target));
    // a document with punctuation only matches with the explicit rule
    let p = Rules { strip_punct: true, ..Default::default() };
    assert_eq!(canon(LType::Text, Some("012.345.678-90"), &p, Side::Source), canon(LType::Text, Some("01234567890"), &p, Side::Target));
    assert_eq!(canon::round_decimal("2.345", 2), "2.35");
    assert_eq!(canon::round_decimal("-2.345", 2), "-2.35");
    assert_eq!(canon::round_decimal("9.995", 2), "10");
    assert_eq!(canon::within_tolerance("100.00", "100.009", "0.01", ""), Some(true));
    assert_eq!(canon::within_tolerance("100.00", "100.02", "0.01", ""), Some(false));
    assert_eq!(canon::within_tolerance("200", "201", "", "0.005"), Some(true));
    assert_eq!(canon::within_tolerance("200", "202", "", "0.005"), Some(false));
    // tolerance applied in the comparison only when both values are stored
    let tol = Rules { tol_abs: "0.01".into(), ..Default::default() };
    let va = engine::state(&canon(LType::Decimal, Some("100.00"), &tol, Side::Source), true);
    let vb = engine::state(&canon(LType::Decimal, Some("100.005"), &tol, Side::Target), true);
    assert_eq!(engine::classify(&va, &vb, &tol), "equal_tolerance");
    let da = engine::state(&canon(LType::Decimal, Some("100.00"), &tol, Side::Source), false);
    let db = engine::state(&canon(LType::Decimal, Some("100.005"), &tol, Side::Target), false);
    assert_eq!(engine::classify(&da, &db, &tol), "divergent", "sem valores guardados a tolerância não pode ser aplicada");
    // NULL is never 0 nor ""
    assert_ne!(canon(LType::Decimal, None, &r, Side::Source), canon(LType::Decimal, Some("0"), &r, Side::Target));
    assert_ne!(canon(LType::Text, None, &r, Side::Source), canon(LType::Text, Some(""), &r, Side::Target));
    let en = Rules { empty_is_null: true, ..Default::default() };
    assert_eq!(canon(LType::Text, None, &en, Side::Source), canon(LType::Text, Some(""), &en, Side::Target));
    // accents are not ignored by default; Unicode normalization is explicit
    assert_ne!(canon(LType::Text, Some("José"), &r, Side::Source), canon(LType::Text, Some("Jose"), &r, Side::Target));
    let nfc = Rules { unicode_nfc: true, ..Default::default() };
    assert_eq!(canon(LType::Text, Some("Jose\u{301}"), &nfc, Side::Source), canon(LType::Text, Some("José"), &nfc, Side::Target));
    assert_ne!(canon(LType::Text, Some("Jose\u{301}"), &r, Side::Source), canon(LType::Text, Some("José"), &r, Side::Target));
}

// 18. time zone and timestamp precision
#[test]
fn s18_time_zones_and_precision() {
    let r = Rules::default();
    let a = canon(LType::Timestamptz, Some("2024-03-10 12:00:00-03:00"), &r, Side::Source);
    let b = canon(LType::Timestamptz, Some("2024-03-10 15:00:00+00"), &r, Side::Target);
    assert_eq!(a, b);
    assert_eq!(a, CVal::TsTz("2024-03-10T15:00:00.000000000Z".into()));
    // naive vs zoned only compare with an explicit offset
    let naive = canon(LType::Timestamp, Some("2024-03-10 12:00:00"), &r, Side::Source);
    assert_ne!(naive, b);
    let off = Rules { naive_offset_source: "-03:00".into(), ..Default::default() };
    assert_eq!(canon(LType::Timestamp, Some("2024-03-10 12:00:00"), &off, Side::Source), canon(LType::Timestamptz, Some("2024-03-10 15:00:00Z"), &off, Side::Target));
    // precision: microseconds lost in the target are a divergence unless a precision rule exists
    let x = canon(LType::Timestamp, Some("2024-01-01 10:00:00.123456"), &r, Side::Source);
    let y = canon(LType::Timestamp, Some("2024-01-01 10:00:00.123"), &r, Side::Target);
    assert_ne!(x, y);
    let p3 = Rules { ts_precision: Some(3), ..Default::default() };
    assert_eq!(canon(LType::Timestamp, Some("2024-01-01 10:00:00.123456"), &p3, Side::Source), canon(LType::Timestamp, Some("2024-01-01 10:00:00.123"), &p3, Side::Target));
    // "10:00:00" and "10:00:00.000" are the same instant
    assert_eq!(canon(LType::Timestamp, Some("2024-01-01 10:00:00"), &r, Side::Source), canon(LType::Timestamp, Some("2024-01-01T10:00:00.000"), &r, Side::Target));
    // date-only comparison must be authorized
    let d_only = Rules { date_only: true, ..Default::default() };
    assert_eq!(canon(LType::Timestamp, Some("2024-01-01 10:00:00"), &d_only, Side::Source), canon(LType::Date, Some("2024-01-01"), &d_only, Side::Target));
    assert_ne!(canon(LType::Timestamp, Some("2024-01-01 10:00:00"), &r, Side::Source), canon(LType::Date, Some("2024-01-01"), &r, Side::Target));
    // dates stored as text with a known format; invalid values are reported, not converted
    let f = Rules { date_format: "DD/MM/YYYY".into(), date_format_side: Side::Source, ..Default::default() };
    assert_eq!(canon(LType::Text, Some("31/12/1999"), &f, Side::Source), canon(LType::Date, Some("1999-12-31"), &f, Side::Target));
    assert!(matches!(canon(LType::Text, Some("31/02/1999"), &f, Side::Source), CVal::Invalid(..)));
    assert!(matches!(canon(LType::Date, Some("0000-00-00"), &r, Side::Source), CVal::Invalid(..)), "data zero não vira nulo");
    // sentinels only with an explicit rule
    assert!(!canon(LType::Date, Some("1900-01-01"), &r, Side::Source).is_null());
    let s = Rules { null_sentinels: vec!["1900-01-01".into()], ..Default::default() };
    assert!(canon(LType::Date, Some("1900-01-01"), &s, Side::Source).is_null());
}

// 21. corrupted or incompatible baseline
#[test]
fn s21_corrupted_baseline_is_detected() {
    let d = tmp("s21");
    let a = capture(&d, "u1.src", spec(Side::Source, key(&[0], LType::Int), vec![]), &ids(1..=10), 1000);
    let mut m = BaselineManifest { format: FORMAT, kind: "baseline".into(), id: "b1".into(), side: "source".into(), units: vec![UnitCapture { unit_id: "u1".into(), status: "complete".into(), evidence: a.evidence.clone(), ..Default::default() }], ..Default::default() };
    m.digest = store::baseline_digest(&m);
    store::write_json_atomic(&d.join("manifest.json"), &m).unwrap();
    let (_, ok) = store::verify_baseline(&d);
    assert!(ok.ok, "{:?}", ok.problems);
    // truncated evidence
    let ev = d.join(&a.evidence.as_ref().unwrap().path);
    let text = std::fs::read_to_string(&ev).unwrap();
    std::fs::write(&ev, &text[..text.len() / 2]).unwrap();
    let (_, bad) = store::verify_baseline(&d);
    assert!(!bad.ok && bad.problems.iter().any(|p| p.contains("truncado")), "{:?}", bad.problems);
    // missing evidence
    std::fs::remove_file(&ev).unwrap();
    let (_, bad) = store::verify_baseline(&d);
    assert!(bad.problems.iter().any(|p| p.contains("ausente")));
    // edited manifest and incompatible version
    let mut edited = m.clone();
    edited.units[0].rows = Some(999);
    store::write_json_atomic(&d.join("manifest.json"), &edited).unwrap();
    let (_, bad) = store::verify_baseline(&d);
    assert!(bad.problems.iter().any(|p| p.contains("digest")));
    let mut newer = m.clone();
    newer.format = 99;
    newer.digest = store::baseline_digest(&newer);
    store::write_json_atomic(&d.join("manifest.json"), &newer).unwrap();
    let (_, bad) = store::verify_baseline(&d);
    assert!(bad.problems.iter().any(|p| p.contains("incompatível")));
    std::fs::write(d.join("manifest.json"), "{\"format\": 1, \"kind\": \"base").unwrap();
    let (none, bad) = store::verify_baseline(&d);
    assert!(none.is_none() && !bad.ok);
}

// 25. valid FK pointing to the wrong entity
#[test]
fn s25_fk_valid_but_wrong_entity() {
    let d = tmp("s25");
    // children: id, cliente_id (parent key)
    let src: Vec<Row> = vec![row(&[Some("1"), Some("10")]), row(&[Some("2"), Some("20")]), row(&[Some("3"), Some("10")])];
    let dst: Vec<Row> = vec![row(&[Some("1"), Some("10")]), row(&[Some("2"), Some("10")]), row(&[Some("3"), Some("10")])];
    let mk = |side| CaptureSpec { fks: vec![key(&[1], LType::Int)], ..spec(side, key(&[0], LType::Int), vec![]) };
    let a = capture(&d, "a", mk(Side::Source), &src, 1000);
    let b = capture(&d, "b", mk(Side::Target), &dst, 1000);
    let s = CompareSpec { direct_fk: vec![true], nfk: 1, ..cmp_spec(&[]) };
    let c = engine::compare(&d.join(&a.evidence.as_ref().unwrap().path), None, &d.join(&b.evidence.as_ref().unwrap().path), None, &s, &d.join("out"), 1000, 0).unwrap();
    assert_eq!(c.rel_changed, vec![1], "pedido 2 aponta para um cliente válido, mas não o original");
    // parents exist in the target: no orphans, yet the association is wrong
    let parents = capture(&d, "p", spec(Side::Target, key(&[0], LType::Int), vec![]), &[row(&[Some("10")]), row(&[Some("20")])], 1000);
    let mut f = Findings::create(d.join("orph.tsv"), 10).unwrap();
    let n = engine::orphans(&d.join(&b.evidence.as_ref().unwrap().path), 1, 0, &d.join(&parents.evidence.as_ref().unwrap().path), 0, &d, 1000, 0, &mut f).unwrap();
    assert_eq!(n, 0);
    // with ids recreated: translated through the parent's map
    let dst2: Vec<Row> = vec![row(&[Some("1"), Some("110")]), row(&[Some("2"), Some("110")]), row(&[Some("3"), Some("110")])];
    let b2 = capture(&d, "b2", mk(Side::Target), &dst2, 1000);
    let s2 = CompareSpec { direct_fk: vec![false], nfk: 1, ..cmp_spec(&[]) };
    let c2 = engine::compare(&d.join(&a.evidence.as_ref().unwrap().path), None, &d.join(&b2.evidence.as_ref().unwrap().path), None, &s2, &d.join("out2"), 1000, 0).unwrap();
    let (pm, _, _, _) = map_capture(&d, &[("10", "110"), ("20", "120")], false);
    let mut fr = Findings::create(d.join("rel.tsv"), 10).unwrap();
    let (changed, unmapped) = engine::check_fk_via_map(c2.fk_pending[0].as_ref().unwrap(), &pm, 0, &mut fr).unwrap();
    assert_eq!((changed, unmapped), (1, 0));
    // orphan detection
    let orphan_dst: Vec<Row> = vec![row(&[Some("1"), Some("10")]), row(&[Some("2"), Some("30")])];
    let b3 = capture(&d, "b3", mk(Side::Target), &orphan_dst, 1000);
    let mut f3 = Findings::create(d.join("orph3.tsv"), 10).unwrap();
    let n = engine::orphans(&d.join(&b3.evidence.as_ref().unwrap().path), 1, 0, &d.join(&parents.evidence.as_ref().unwrap().path), 0, &d, 1000, 0, &mut f3).unwrap();
    assert_eq!(n, 1);
}

// 26. aggregate fill difference without a key is only an indication
#[test]
fn s26_aggregate_fill_without_key() {
    let d = tmp("s26");
    let src: Vec<Row> = (1..=100).map(|i| vec![Some(i.to_string()), if i <= 80 { Some("x".into()) } else { None }]).collect();
    let dst: Vec<Row> = (1..=100).map(|i| vec![Some(i.to_string()), if i <= 70 { Some("x".into()) } else { None }]).collect();
    let no_records = |side| CaptureSpec { records: false, write_fields: false, ..spec(side, KeySpec::default(), vec![field("f", 1, LType::Text)]) };
    let a = capture(&d, "a", no_records(Side::Source), &src, 1000);
    let b = capture(&d, "b", no_records(Side::Target), &dst, 1000);
    assert!(a.evidence.is_none(), "sem identidade não há evidência por registro");
    assert_eq!((a.profile["f"].filled, b.profile["f"].filled), (80, 70));
}

// blank vs empty vs null are told apart
#[test]
fn blank_empty_and_null_states() {
    let r = Rules::default();
    assert_eq!(engine::state(&canon(LType::Text, None, &r, Side::Source), false), "N");
    assert_eq!(engine::state(&canon(LType::Text, Some(""), &r, Side::Source), false), "E");
    assert!(engine::state(&canon(LType::Text, Some("   "), &r, Side::Source), false).starts_with("W:"));
    assert_eq!(engine::classify("E", "N", &r), "divergent", "texto vazio não é nulo sem regra");
    assert_eq!(engine::classify("N", "N", &r), "both_empty");
}

// canonical encoding never collides by concatenation
#[test]
fn canonical_encoding_has_boundaries() {
    let a = canon::encode_all(&[CVal::Text("ab".into()), CVal::Text("c".into())]);
    let b = canon::encode_all(&[CVal::Text("a".into()), CVal::Text("bc".into())]);
    assert_ne!(a, b);
    assert_ne!(canon::encode_all(&[CVal::Null]), canon::encode_all(&[CVal::Text("".into())]));
    assert_ne!(canon::encode_all(&[CVal::Num("1".into())]), canon::encode_all(&[CVal::Text("1".into())]));
    let back = canon::decode_all(&a).unwrap();
    assert_eq!(back, vec![CVal::Text("ab".into()), CVal::Text("c".into())]);
}

#[test]
fn json_canonicalization_keeps_exact_numbers() {
    assert_eq!(canon::canonical_json(r#"{ "b": 1.10, "a": [true, null, "x"] }"#).unwrap(), r#"{"a":[true,null,"x"],"b":1.1}"#);
    assert_eq!(canon::canonical_json("123456789012345678901234567890.5").unwrap(), "123456789012345678901234567890.5");
    assert!(canon::canonical_json("{\"a\":}").is_none());
}

#[test]
fn logical_types_per_dialect() {
    assert_eq!(canon::logical_type("mysql", "tinyint(1)"), LType::Bool);
    assert_eq!(canon::logical_type("mysql", "tinyint(4)"), LType::Int);
    assert_eq!(canon::logical_type("postgres", "timestamp with time zone"), LType::Timestamptz);
    assert_eq!(canon::logical_type("postgres", "character varying"), LType::Text);
    assert_eq!(canon::logical_type("postgres", "character"), LType::Char);
    assert_eq!(canon::logical_type("sqlserver", "datetimeoffset"), LType::Timestamptz);
    assert_eq!(canon::logical_type("sqlserver", "bit"), LType::Bool);
    assert_eq!(canon::logical_type("firebird", "BLOB SUB_TYPE TEXT"), LType::Text);
    assert_eq!(canon::logical_type("firebird", "BLOB"), LType::Binary);
    assert_eq!(canon::logical_type("postgres", "numeric(12,2)"), LType::Decimal);
}

#[test]
fn single_statement_guard() {
    use rits_lib::audit::adapter::single_statement;
    assert!(single_statement("SELECT 1 AS a").is_ok());
    assert!(single_statement("select ';' as a;").is_ok());
    assert!(single_statement("SELECT 1; DELETE FROM t").is_err());
    assert!(single_statement("DELETE FROM t").is_err());
    assert!(single_statement("WITH x AS (SELECT 1 AS a) SELECT a FROM x -- ; drop").is_ok());
}

#[test]
fn sql_is_parameterized_and_quoted() {
    use rits_lib::audit::adapter::{select_sql, ColTypes};
    let cols: ColTypes = vec![("id".into(), "integer".into(), LType::Int), ("we\"ird".into(), "text".into(), LType::Text)];
    let ds = Dataset { kind: "table".into(), schema: "pub\"lic".into(), table: "t".into(), filters: vec![Pred { column: "id".into(), op: ">".into(), values: vec!["5; DROP TABLE t".into()] }], ..Default::default() };
    let b = select_sql("postgres", &ds, &cols, &["id".into(), "we\"ird".into()], &[], &[]).unwrap();
    assert!(b.sql.contains("\"pub\"\"lic\".\"t\""));
    assert!(b.sql.contains("\"we\"\"ird\""));
    assert!(!b.sql.contains("DROP"));
    assert_eq!(b.params, vec!["5; DROP TABLE t"]);
    let bad = Dataset { filters: vec![Pred { column: "nope".into(), op: "=".into(), values: vec!["1".into()] }], ..ds.clone() };
    assert!(select_sql("postgres", &bad, &cols, &["id".into()], &[], &[]).is_err());
    let badop = Dataset { filters: vec![Pred { column: "id".into(), op: "; --".into(), values: vec!["1".into()] }], ..ds };
    assert!(select_sql("postgres", &badop, &cols, &["id".into()], &[], &[]).is_err());
    let my = select_sql("mysql", &Dataset { kind: "table".into(), schema: "db".into(), table: "t`x".into(), ..Default::default() }, &cols, &["id".into()], &[], &[]).unwrap();
    assert!(my.sql.contains("`db`.`t``x`"));
}

// 27. export with HTML content and spreadsheet formulas
#[test]
fn s27_exports_escape_html_and_formulas() {
    assert_eq!(report::csv_cell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
    assert_eq!(report::csv_cell("+1"), "\"'+1\"");
    assert_eq!(report::csv_cell("-2"), "\"'-2\"");
    assert_eq!(report::csv_cell("@SUM(A1)"), "\"'@SUM(A1)\"");
    assert_eq!(report::csv_cell("normal, \"aspas\""), "\"normal, \"\"aspas\"\"\"");
    assert_eq!(report::html_escape("<script>alert('x')</script>&"), "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;");
    let run = RunManifest { id: "r1".into(), units: vec![UnitResult { unit_id: "u".into(), name: "<img src=x onerror=alert(1)>".into(), error: "</td><script>".into(), ..Default::default() }], ..Default::default() };
    let p = Project { name: "<b>proj</b>".into(), ..Default::default() };
    let html = report::html(&run, &BaselineManifest::default(), &p, &[("u".into(), "ausentes".into(), vec!["=1+1 <i>".into()])]);
    assert!(!html.contains("<script"));
    assert!(!html.contains("<img"));
    assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;"));
    assert!(!html.contains("http://") && !html.contains("https://"), "relatório autocontido, sem recursos remotos");
    // findings export streams the full list with masking by default
    let d = tmp("s27");
    let k = canon::hex(&canon::encode_all(&[CVal::Text("=cmd|' /C calc'!A0".into())]));
    std::fs::write(d.join("missing.tsv"), format!("{k}\t1\n")).unwrap();
    let n = report::findings_csv(&d.join("missing.tsv"), &d.join("m.csv"), "missing", false, &[], &[], false).unwrap();
    assert_eq!(n, 1);
    let csv = std::fs::read_to_string(d.join("m.csv")).unwrap();
    assert!(csv.contains("\"'=cmd|"), "{csv}");
    let masked = report::findings_csv(&d.join("missing.tsv"), &d.join("m2.csv"), "missing", true, &[], &[], false).unwrap();
    assert_eq!(masked, 1);
    assert!(!std::fs::read_to_string(d.join("m2.csv")).unwrap().contains("calc"));
}

#[test]
fn suggestions_show_criteria_and_need_confirmation() {
    let src = Structure { tables: vec![Table { schema: "s".into(), name: "tb_cliente".into(), kind: "table".into(), columns: vec![col("id", "int", LType::Int, false), col("Nome", "text", LType::Text, true), col("data", "date", LType::Date, true)], constraints: vec![Constraint { name: "pk".into(), kind: "primary".into(), columns: vec!["id".into()], ..Default::default() }], ..Default::default() }], ..Default::default() };
    let dst = Structure { tables: vec![Table { schema: "d".into(), name: "cliente".into(), kind: "table".into(), columns: vec![col("id", "bigint", LType::Int, false), col("nome", "varchar", LType::Text, true), col("dt_cadastro", "date", LType::Date, true)], constraints: vec![Constraint { name: "pk".into(), kind: "primary".into(), columns: vec!["id".into()], ..Default::default() }], ..Default::default() }], ..Default::default() };
    let p = Project { strip_prefixes: vec!["tb_".into()], ..Default::default() };
    let s = analysis::suggest(&p, &Mappings::default(), &src, &dst);
    assert_eq!(s.len(), 1);
    let u = &s[0];
    assert!(!u.confirmed);
    assert_eq!(u.identity.kind, "key");
    let nome = u.fields.iter().find(|f| f.source_cols == ["Nome"]).unwrap();
    assert!(!nome.confirmed && nome.suggested_by.iter().any(|c| c.contains("maiúsculas")));
    // "data" is not guessed to be "dt_cadastro"
    let data = u.fields.iter().find(|f| f.source_cols == ["data"]).unwrap();
    assert_eq!(data.kind, "unmapped");
}
