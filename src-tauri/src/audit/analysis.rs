//! Structural analysis of the Migration Audit: deterministic mapping suggestions (always shown
//! with their criteria and never used before the user confirms them), validation of units and
//! structural compatibility alerts (risks, not proven losses).

use super::canon::LType;
use super::model::{Column, FieldMap, Identity, KeyCol, Mappings, Project, Structure, Table, Unit};
use serde::Serialize;
use serde_json::{json, Value};

pub fn norm_name(s: &str, prefixes: &[String]) -> String {
    let mut n = s.to_lowercase();
    for p in prefixes {
        let p = p.to_lowercase();
        if !p.is_empty() && n.starts_with(&p) && n.len() > p.len() {
            n = n[p.len()..].to_string();
            break;
        }
    }
    let n: String = n.chars().filter(|c| c.is_alphanumeric()).collect();
    super::canon::canon(LType::Text, Some(&n), &super::canon::Rules { remove_accents: true, ..Default::default() }, super::canon::Side::Both).text()
}

fn compatible(a: Option<LType>, b: Option<LType>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => x == y || x.is_numeric() && y.is_numeric() || x.is_textual() && y.is_textual() || x.is_temporal() && y.is_temporal(),
        _ => false,
    }
}

/// Name match criteria between a source and a target name, or None.
fn name_match(src: &str, dst: &str, p: &Project) -> Option<String> {
    if src == dst {
        return Some("nome exato".into());
    }
    if p.aliases.iter().any(|(a, b)| a.eq_ignore_ascii_case(src) && b.eq_ignore_ascii_case(dst)) {
        return Some("dicionário de aliases".into());
    }
    if src.eq_ignore_ascii_case(dst) {
        return Some("nome igual sem diferenciar maiúsculas".into());
    }
    if norm_name(src, &p.strip_prefixes) == norm_name(dst, &p.strip_prefixes) {
        return Some(if p.strip_prefixes.is_empty() { "nome normalizado".into() } else { "nome normalizado (prefixos removidos)".into() });
    }
    None
}

fn pk(t: &Table) -> Vec<String> {
    t.constraints.iter().find(|c| c.kind == "primary").map(|c| c.columns.clone()).unwrap_or_default()
}

fn in_scope(t: &Table) -> bool {
    t.kind == "table" && !t.technical && t.excluded.is_none()
}

/// Suggested units for source tables without a unit: table name match, then field matches.
pub fn suggest(p: &Project, m: &Mappings, src: &Structure, dst: &Structure) -> Vec<Unit> {
    let mut out = vec![];
    let covered: Vec<(String, String)> = m.units.iter().map(|u| (u.source.schema.clone(), u.source.table.clone())).collect();
    for st in src.tables.iter().filter(|t| in_scope(t)) {
        if covered.contains(&(st.schema.clone(), st.name.clone())) {
            continue;
        }
        let mut best: Option<(&Table, String)> = None;
        for dt in dst.tables.iter().filter(|t| t.kind == "table" && !t.technical) {
            if let Some(c) = name_match(&st.name, &dt.name, p) {
                best = Some((dt, c));
                if dt.name == st.name {
                    break;
                }
            }
        }
        let Some((dt, crit)) = best else { continue };
        let mut fields = vec![];
        let spk = pk(st);
        let dpk = pk(dt);
        for sc in &st.columns {
            let m = dt.columns.iter().find_map(|dc| name_match(&sc.name, &dc.name, p).map(|c| (dc, c)));
            match m {
                Some((dc, c)) => {
                    let mut by = vec![c];
                    by.push(if compatible(sc.ltype, dc.ltype) { "tipos compatíveis".into() } else { format!("tipos diferentes ({} → {})", sc.native, dc.native) });
                    if spk.contains(&sc.name) && dpk.contains(&dc.name) {
                        by.push("ambos na chave primária".into());
                    }
                    fields.push(FieldMap { id: format!("f{}", fields.len() + 1), kind: "map".into(), source_cols: vec![sc.name.clone()], target_col: dc.name.clone(), confirmed: false, sensitive: sensitive_name(&sc.name), suggested_by: by, ..Default::default() });
                }
                None => fields.push(FieldMap { id: format!("f{}", fields.len() + 1), kind: "unmapped".into(), source_cols: vec![sc.name.clone()], sensitive: sensitive_name(&sc.name), ..Default::default() }),
            }
        }
        // identity suggestion: both primary keys with matched names and same arity
        let identity = if !spk.is_empty() && spk.len() == dpk.len() && spk.iter().zip(&dpk).all(|(a, b)| name_match(a, b, p).is_some()) {
            Identity { kind: "key".into(), source: spk.iter().map(|c| KeyCol { column: c.clone(), ..Default::default() }).collect(), target: dpk.iter().map(|c| KeyCol { column: c.clone(), ..Default::default() }).collect(), map: None }
        } else {
            Identity { kind: "none".into(), ..Default::default() }
        };
        out.push(Unit {
            id: format!("u{}", out.len() + m.units.len() + 1),
            name: st.name.clone(),
            description: format!("Sugestão: {} ({crit}). Confirme antes de usar.", dt.name),
            criticality: "media".into(),
            source: super::model::Dataset { kind: "table".into(), schema: st.schema.clone(), table: st.name.clone(), ..Default::default() },
            target: super::model::Dataset { kind: "table".into(), schema: dt.schema.clone(), table: dt.name.clone(), ..Default::default() },
            cardinality: "1:1".into(),
            identity,
            fields,
            confirmed: false,
            ..Default::default()
        });
    }
    out
}

/// Name-based (deterministic) guess of sensitive data, to mask by default.
pub fn sensitive_name(n: &str) -> bool {
    let l = norm_name(n, &[]);
    ["cpf", "cnpj", "rg", "email", "senha", "password", "passwd", "telefone", "celular", "phone", "cartao", "card", "token", "secret", "nascimento", "birth", "salario", "salary", "endereco", "address", "pis", "nis", "passaporte", "iban", "conta"].iter().any(|k| l.contains(k))
}

fn table<'a>(s: &'a Structure, schema: &str, name: &str) -> Option<&'a Table> {
    s.tables.iter().find(|t| t.schema == schema && t.name == name)
}

fn col<'a>(t: &'a Table, n: &str) -> Option<&'a Column> {
    t.columns.iter().find(|c| c.name == n)
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UnitCheck {
    pub unit_id: String,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub alerts: Vec<Value>,
    pub unmapped_source: Vec<String>,
    pub unsourced_required: Vec<String>,
}

fn alert(kind: &str, field: &str, msg: String) -> Value {
    json!({ "kind": kind, "field": field, "message": msg, "nature": "risco estrutural (não é perda comprovada)" })
}

/// Static checks of a unit against the discovered structures (queries are checked on run).
pub fn check_unit(u: &Unit, src: Option<&Structure>, dst: Option<&Structure>) -> UnitCheck {
    let mut r = UnitCheck { unit_id: u.id.clone(), ..Default::default() };
    if !u.confirmed {
        r.warnings.push("Unidade não confirmada: não participa da baseline nem da reconciliação.".into());
    }
    let st = if u.source.kind == "table" { src.and_then(|s| table(s, &u.source.schema, &u.source.table)) } else { None };
    let dt = if u.target.kind == "table" { dst.and_then(|s| table(s, &u.target.schema, &u.target.table)) } else { None };
    if u.source.kind == "table" && src.is_some() && st.is_none() {
        r.errors.push(format!("Tabela de origem não encontrada: {}.{}", u.source.schema, u.source.table));
    }
    if u.target.kind == "table" && dst.is_some() && dt.is_none() {
        r.errors.push(format!("Tabela de destino não encontrada: {}.{}", u.target.schema, u.target.table));
    }
    for (side, ds) in [("origem", &u.source), ("destino", &u.target)] {
        if ds.kind == "query" {
            if let Err(e) = super::adapter::single_statement(&ds.sql) {
                r.errors.push(format!("Consulta da {side}: {e}"));
            }
        }
    }
    let has = |t: Option<&Table>, c: &str| t.is_none() || col(t.unwrap(), c).is_some();
    match u.identity.kind.as_str() {
        "key" => {
            if u.identity.source.is_empty() || u.identity.source.len() != u.identity.target.len() {
                r.errors.push("A identidade precisa do mesmo número de colunas na origem e no destino.".into());
            }
            for k in &u.identity.source {
                if !has(st, &k.column) {
                    r.errors.push(format!("Coluna de identidade da origem não existe: {}", k.column));
                }
            }
            for k in &u.identity.target {
                if !has(dt, &k.column) {
                    r.errors.push(format!("Coluna de identidade do destino não existe: {}", k.column));
                }
            }
            if let Some(t) = st {
                let pkc = pk(t);
                let cols: Vec<String> = u.identity.source.iter().map(|k| k.column.clone()).collect();
                let uniq = t.constraints.iter().any(|c| (c.kind == "primary" || c.kind == "unique") && c.columns == cols);
                if !uniq && !pkc.is_empty() {
                    r.warnings.push("A identidade da origem não é a chave primária nem uma restrição única: duplicidades serão apontadas, não escolhidas.".into());
                }
            }
        }
        "map" => match &u.identity.map {
            None => r.errors.push("Mapa de IDs não configurado.".into()),
            Some(m) => {
                if m.source_cols.len() != u.identity.source.len() || m.target_cols.len() != u.identity.target.len() || u.identity.source.is_empty() || u.identity.target.is_empty() {
                    r.errors.push("O mapa de IDs precisa ter as mesmas colunas (quantidade) das identidades de origem e destino.".into());
                }
            }
        },
        "content" => r.warnings.push("Identidade por conteúdo: um registro alterado aparece como ausente e extra; não indica qual campo mudou.".into()),
        _ => r.warnings.push("Sem identidade comparável: só volume e preenchimento agregado (indícios) poderão ser verificados.".into()),
    }
    if u.cardinality != "1:1" && !u.normalized {
        r.warnings.push(format!("Cardinalidade {}: sem conjuntos normalizados por consulta, volume e identidade ficam inconclusivos.", u.cardinality));
    }
    if u.normalized && u.source.kind != "query" && u.target.kind != "query" {
        r.errors.push("\"Normalizado\" exige uma consulta que leve origem ou destino ao mesmo grão.".into());
    }
    let mut referenced: Vec<String> = u.identity.source.iter().map(|k| k.column.clone()).collect();
    let mut target_referenced: Vec<String> = u.identity.target.iter().map(|k| k.column.clone()).collect();
    for f in &u.fields {
        referenced.extend(f.source_cols.iter().cloned());
        if !f.target_col.is_empty() {
            target_referenced.push(f.target_col.clone());
        }
        let label = if f.target_col.is_empty() { f.source_cols.join("+") } else { f.target_col.clone() };
        match f.kind.as_str() {
            "map" | "concat" | "split" | "constant" => {
                if f.target_col.is_empty() {
                    r.errors.push(format!("Campo {label}: coluna de destino não definida."));
                }
                if f.kind != "constant" && f.source_cols.is_empty() {
                    r.errors.push(format!("Campo {label}: coluna de origem não definida."));
                }
                if (f.kind == "concat" || f.kind == "split") && f.sep.is_empty() {
                    r.errors.push(format!("Campo {label}: informe o separador da regra."));
                }
                for c in &f.source_cols {
                    if !has(st, c) {
                        r.errors.push(format!("Campo {label}: coluna de origem não existe: {c}"));
                    }
                }
                if !has(dt, &f.target_col) {
                    r.errors.push(format!("Campo {label}: coluna de destino não existe: {}", f.target_col));
                }
                if !f.confirmed {
                    r.warnings.push(format!("Campo {label}: mapeamento sugerido ainda não confirmado (não será comparado)."));
                }
                if let (Some(s), Some(d)) = (st, dt) {
                    if let (Some(sc), Some(dc)) = (f.source_cols.first().and_then(|c| col(s, c)), col(d, &f.target_col)) {
                        if f.kind == "map" {
                            compat(sc, dc, f, &mut r.alerts);
                        }
                    }
                }
            }
            "ignored" => {
                if f.justification.trim().is_empty() {
                    r.errors.push(format!("Campo {label}: descarte intencional exige justificativa."));
                }
            }
            "derived" => r.warnings.push(format!("Campo {label}: derivado sem regra verificável — fica como \"não verificável\".")),
            _ => {}
        }
    }
    for e in &u.exclusions {
        if e.reason.trim().is_empty() {
            r.errors.push("Toda exclusão precisa de justificativa.".into());
        }
    }
    if let Some(t) = st {
        for c in &t.columns {
            if !referenced.contains(&c.name) {
                r.unmapped_source.push(c.name.clone());
            }
        }
    }
    if let Some(t) = dt {
        for c in &t.columns {
            if !c.nullable && c.default.is_none() && !c.generated && !target_referenced.contains(&c.name) {
                r.unsourced_required.push(c.name.clone());
                r.alerts.push(alert("required_without_source", &c.name, format!("Campo obrigatório do destino sem fonte nem regra: {}", c.name)));
            }
        }
    }
    r
}

/// Structural risks of mapping `s` into `d`.
pub fn compat(s: &Column, d: &Column, f: &FieldMap, out: &mut Vec<Value>) {
    let (sl, dl) = (s.ltype.unwrap_or(LType::Other), d.ltype.unwrap_or(LType::Other));
    let name = &d.name;
    if sl.is_textual() && dl.is_textual() {
        if let (Some(a), Some(b)) = (s.length, d.length) {
            if a > b {
                out.push(alert("text_length", name, format!("{}: texto de até {a} caracteres na origem para {b} no destino (pode ser truncado).", s.name)));
            }
        } else if s.length.is_none() && d.length.is_some() {
            out.push(alert("text_length", name, format!("{}: texto sem limite na origem para {} caracteres no destino.", s.name, d.length.unwrap_or(0))));
        }
    }
    if sl.is_numeric() && dl.is_numeric() {
        if let (Some(sp), Some(dp)) = (s.precision, d.precision) {
            let (ss, ds) = (s.scale.unwrap_or(0), d.scale.unwrap_or(0));
            if ds < ss {
                out.push(alert("decimal_scale", name, format!("{}: escala {ss} na origem para {ds} no destino (casas decimais podem ser perdidas).", s.name)));
            }
            if dp - ds < sp - ss {
                out.push(alert("numeric_range", name, format!("{}: parte inteira de até {} dígitos na origem para {} no destino (valores podem ficar fora da faixa).", s.name, sp - ss, dp - ds)));
            }
        }
        if sl == LType::Decimal && dl == LType::Float {
            out.push(alert("decimal_to_float", name, format!("{}: decimal exato na origem para ponto flutuante no destino.", s.name)));
        }
    }
    if sl == LType::Timestamptz && dl == LType::Timestamp && f.rules.naive_offset_target.is_empty() {
        out.push(alert("timezone_loss", name, format!("{}: data/hora com fuso na origem para data/hora sem fuso no destino (o fuso pode se perder). Configure o fuso do destino na regra.", s.name)));
    }
    if (sl == LType::Timestamp || sl == LType::Timestamptz) && dl == LType::Date && !f.rules.date_only {
        out.push(alert("time_loss", name, format!("{}: data/hora na origem para data no destino (a hora se perde; autorize \"somente a data\" se for intencional).", s.name)));
    }
    if sl.is_textual() && dl.is_temporal() && f.rules.date_format.is_empty() {
        out.push(alert("text_to_date", name, format!("{}: texto na origem para data no destino. Informe o formato da data na regra.", s.name)));
    }
    if s.nullable && !d.nullable {
        out.push(alert("null_to_required", name, format!("{}: anulável na origem para obrigatório no destino.", s.name)));
    }
    if sl != dl && !(sl.is_numeric() && dl.is_numeric()) && !(sl.is_textual() && dl.is_textual()) && f.rules.compare_as.is_empty() && f.rules.date_format.is_empty() && !(sl.is_temporal() && dl.is_temporal()) {
        out.push(alert("type_change", name, format!("{}: tipo {} na origem e {} no destino; a comparação apontará divergência sem uma regra de conversão.", s.name, s.native, d.native)));
    }
}

/// Source tables in scope without a unit nor a justified exclusion.
pub fn uncovered(m: &Mappings, src: &Structure) -> (Vec<String>, Vec<String>) {
    let mut tables = vec![];
    let mut views = vec![];
    for t in &src.tables {
        if t.technical || t.excluded.is_some() {
            continue;
        }
        let covered = m.units.iter().any(|u| u.source.kind == "table" && u.source.schema == t.schema && u.source.table == t.name)
            || m.ignored.iter().any(|(side, s, n, _)| side == "source" && *s == t.schema && *n == t.name);
        if covered {
            continue;
        }
        let name = if t.schema.is_empty() { t.name.clone() } else { format!("{}.{}", t.schema, t.name) };
        if t.kind == "table" {
            tables.push(name);
        } else {
            views.push(name);
        }
    }
    (tables, views)
}

/// SQL LIKE pattern (% and _) match, case-insensitive.
pub fn like(pattern: &str, s: &str) -> bool {
    fn go(p: &[char], s: &[char]) -> bool {
        match p.first() {
            None => s.is_empty(),
            Some('%') => (0..=s.len()).any(|i| go(&p[1..], &s[i..])),
            Some('_') => !s.is_empty() && go(&p[1..], &s[1..]),
            Some(c) => s.first().is_some_and(|x| x.to_lowercase().eq(c.to_lowercase())) && go(&p[1..], &s[1..]),
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let s: Vec<char> = s.chars().collect();
    go(&p, &s)
}

/// Marks technical and excluded tables according to the scope.
pub fn apply_scope(s: &mut Structure, scope: &super::model::ScopeSide) {
    for t in s.tables.iter_mut() {
        t.technical = scope.technical.iter().any(|p| like(p, &t.name));
        t.excluded = scope.excluded.iter().find(|e| e.table == t.name && (e.schema.is_empty() || e.schema == t.schema)).map(|e| e.reason.clone());
        if !scope.include_views && t.kind != "table" && t.excluded.is_none() {
            t.excluded = Some("view (fora do escopo: evita contar o mesmo conjunto duas vezes)".into());
        }
    }
}
