//! Reports and exports: self-contained HTML (escaped, no scripts, no remote resources), CSV with
//! protection against spreadsheet formulas, and the run manifest. Sensitive values are masked
//! unless the user explicitly asks for a detailed export.

use super::engine::{render_key, render_value};
use super::model::*;
use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

pub fn html_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            c => o.push(c),
        }
    }
    o
}

/// CSV cell: always quoted; cells that a spreadsheet would run as a formula get a leading quote.
pub fn csv_cell(s: &str) -> String {
    let t = if s.starts_with(['=', '+', '-', '@', '\t', '\r', '|', '%']) { format!("'{s}") } else { s.to_string() };
    format!("\"{}\"", t.replace('"', "\"\""))
}

pub fn csv_row(cells: &[String]) -> String {
    cells.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(",")
}

/// Partial mask for UI and summaries ("12•••89").
pub fn mask(s: &str) -> String {
    let ch: Vec<char> = s.chars().collect();
    if ch.len() <= 4 {
        "•••".into()
    } else if ch.len() <= 8 {
        format!("{}•••", ch[0])
    } else {
        format!("{}{}•••{}{}", ch[0], ch[1], ch[ch.len() - 2], ch[ch.len() - 1])
    }
}

pub fn key_sensitive(u: &Unit) -> bool {
    u.identity.source.iter().chain(u.identity.target.iter()).any(|k| super::analysis::sensitive_name(&k.column) || u.fields.iter().any(|f| f.sensitive && f.source_cols.contains(&k.column)))
}

fn res_label(r: &str) -> &'static str {
    match r {
        "compatible" => "Compatível no escopo verificado",
        "divergent" => "Divergente",
        "inconclusive" => "Inconclusivo",
        _ => "Não verificado",
    }
}

fn status_label(s: &str) -> &'static str {
    match s {
        "complete" => "Concluída",
        "partial" => "Parcial",
        "cancelled" => "Cancelada",
        "error" => "Erro",
        "running" => "Em execução",
        _ => "Pendente",
    }
}

pub fn fmt_ms(ms: i64) -> String {
    let secs = ms / 1000;
    let (y, m, d) = crate::jupyter::proto::civil_from_days(secs.div_euclid(86_400));
    let r = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC", r / 3600, (r % 3600) / 60, r % 60)
}

pub fn summary_line(run: &RunManifest) -> String {
    let c = |k: &str| run.coverage.get(k).copied().unwrap_or((0, 0));
    let (v, t) = c("volume");
    let (i, _) = c("identity");
    let (f, _) = c("fields");
    let nokey = run.units.iter().filter(|u| u.units_identity_none()).count();
    let vol_ok = run.units.iter().filter(|u| u.volume.result == "compatible").count();
    format!("{t} unidades: volume compatível em {vol_ok} (verificado em {v}); identidade verificada em {i}; campos verificados em {f}; {nokey} sem identidade comparável configurada.")
}

trait UnitExt {
    fn units_identity_none(&self) -> bool;
}
impl UnitExt for UnitResult {
    fn units_identity_none(&self) -> bool {
        self.identity.note.contains("não há uma identidade comparável") || self.identity.note.starts_with("Sem identidade comparável")
    }
}

/// Self-contained HTML report (inline CSS only).
pub fn html(run: &RunManifest, baseline: &BaselineManifest, project: &Project, examples: &[(String, String, Vec<String>)]) -> String {
    let mut h = String::new();
    let e = html_escape;
    let _ = write!(
        h,
        "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Migration Audit — {}</title><style>
body{{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;color:#1b1b1f;background:#fff}}h1{{font-size:22px}}h2{{font-size:17px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}}
table{{border-collapse:collapse;width:100%;margin:8px 0}}td,th{{border:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}}th{{background:#f4f4f6}}
.compatible{{color:#17723b}}.divergent{{color:#b3261e;font-weight:600}}.inconclusive{{color:#8a5a00}}.not_verified{{color:#555}}.muted{{color:#666}}code{{font-family:ui-monospace,Menlo,monospace;font-size:12px}}
</style></head><body>",
        e(&project.name)
    );
    let _ = write!(h, "<h1>Migration Audit — {}</h1>", e(&project.name));
    let _ = write!(h, "<p class=\"muted\">Relatório gerado pelo Rits (plugin Migration Audit {}). Análise determinística por regras explícitas; sem inferência estatística ou IA.</p>", e(&run.plugin_version));
    let _ = write!(h, "<p><b>{}</b></p>", e(&summary_line(run)));
    h.push_str("<table>");
    for (k, v) in [
        ("Execução", format!("{} — {} ({})", run.id, status_label(&run.status), fmt_ms(run.started_at))),
        ("Baseline", format!("{} — capturada em {} ({})", baseline.id, fmt_ms(baseline.started_at), status_label(&baseline.status))),
        ("Origem", format!("{} ({}, {})", project.source.name, project.source.kind, project.source.database)),
        ("Destino", format!("{} ({}, {})", project.target.name, project.target.kind, project.target.database)),
        ("Consistência", run.consistency.obtained.clone()),
        ("Nível de evidência", baseline.level.clone()),
        ("Versão do mapeamento", format!("baseline v{} · execução v{}", baseline.mappings_version, run.mappings_version)),
    ] {
        let _ = write!(h, "<tr><th>{}</th><td>{}</td></tr>", e(k), e(&v));
    }
    h.push_str("</table>");
    for n in &run.consistency.notes {
        let _ = write!(h, "<p class=\"muted\">{}</p>", e(n));
    }
    if !run.source_changed.is_empty() {
        h.push_str("<h2>Origem alterada desde a baseline</h2><ul>");
        for s in &run.source_changed {
            let _ = write!(h, "<li>{}</li>", e(s));
        }
        h.push_str("</ul>");
    }
    h.push_str("<h2>Cobertura por dimensão</h2><table><tr><th>Dimensão</th><th>Unidades verificadas</th></tr>");
    for (k, label) in [("volume", "Volume"), ("identity", "Identidade"), ("fields", "Campos"), ("relations", "Relacionamentos")] {
        let (a, b) = run.coverage.get(k).copied().unwrap_or((0, 0));
        let _ = write!(h, "<tr><td>{label}</td><td>{a} de {b}</td></tr>");
    }
    h.push_str("</table>");
    if !run.uncovered_tables.is_empty() {
        let _ = write!(h, "<h2>Tabelas sem cobertura (possivelmente esquecidas)</h2><p>{} tabelas da origem no escopo não têm unidade de reconciliação nem exclusão justificada:</p><p><code>{}</code></p>", run.uncovered_tables.len(), e(&run.uncovered_tables.join(", ")));
    }
    h.push_str("<h2>Unidades</h2><table><tr><th>Unidade</th><th>Execução</th><th>Volume</th><th>Identidade</th><th>Campos</th><th>Relacionamentos</th><th>Origem</th><th>Esperado</th><th>Destino</th><th>Ausentes</th><th>Extras</th><th>Multiplicidade</th></tr>");
    for u in &run.units {
        let n = |x: Option<u64>| x.map(|v| v.to_string()).unwrap_or("—".into());
        let _ = write!(
            h,
            "<tr><td>{}</td><td>{}</td><td class=\"{}\">{}</td><td class=\"{}\">{}</td><td class=\"{}\">{}</td><td class=\"{}\">{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            e(&u.name),
            status_label(&u.status),
            u.volume.result, res_label(&u.volume.result),
            u.identity.result, res_label(&u.identity.result),
            u.fields_dim.result, res_label(&u.fields_dim.result),
            u.relations.result, res_label(&u.relations.result),
            n(u.counts.source), n(u.counts.expected), n(u.counts.target), u.missing, u.extra, u.multiplicity
        );
    }
    h.push_str("</table>");
    for u in &run.units {
        let _ = write!(h, "<h2>{}</h2>", e(&u.name));
        if !u.error.is_empty() {
            let _ = write!(h, "<p class=\"divergent\">{}</p>", e(&u.error));
        }
        h.push_str("<table>");
        for (label, d) in [("Volume", &u.volume), ("Identidade", &u.identity), ("Campos", &u.fields_dim), ("Relacionamentos", &u.relations)] {
            let _ = write!(h, "<tr><th>{label}</th><td class=\"{}\">{}</td><td>{}</td></tr>", d.result, res_label(&d.result), e(&d.note));
        }
        let _ = write!(h, "<tr><th>Regra de volume</th><td colspan=\"2\">{}</td></tr>", e(&u.counts.rule));
        h.push_str("</table>");
        if !u.fields.is_empty() {
            h.push_str("<table><tr><th>Campo</th><th>Resultado</th><th>Comparados</th><th>Iguais</th><th>Vazios nos dois</th><th>Perdidos no destino</th><th>Criados no destino</th><th>Divergentes</th><th>Inválidos</th><th>Não comparados</th><th>Preenchidos (origem/destino, agregado)</th><th>Observação</th></tr>");
            for f in &u.fields {
                let agg = f.aggregate.map(|(a, b)| format!("{a} / {b}")).unwrap_or("—".into());
                let _ = write!(h, "<tr><td>{}</td><td class=\"{}\">{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>", e(&f.label), f.result, res_label(&f.result), f.compared, f.equal, f.both_empty, f.lost, f.created, f.divergent, f.invalid, f.not_compared, agg, e(&f.note));
            }
            h.push_str("</table>");
        }
        if !u.unmapped_source.is_empty() {
            let _ = write!(h, "<p><b>Campos da origem sem mapeamento:</b> <code>{}</code></p>", e(&u.unmapped_source.join(", ")));
        }
        if !u.unsourced_required_target.is_empty() {
            let _ = write!(h, "<p><b>Campos obrigatórios do destino sem fonte:</b> <code>{}</code></p>", e(&u.unsourced_required_target.join(", ")));
        }
        let issues: Vec<String> = u.map_issues.iter().chain(u.relation_issues.iter()).filter(|(_, v)| **v > 0).map(|(k, v)| format!("{k}: {v}")).collect();
        if !issues.is_empty() {
            let _ = write!(h, "<ul>{}</ul>", issues.iter().map(|i| format!("<li>{}</li>", e(i))).collect::<String>());
        }
        for w in &u.warnings {
            let _ = write!(h, "<p class=\"muted\">⚠ {}</p>", e(w));
        }
        for (uid, kind, rows) in examples {
            if *uid == u.unit_id && !rows.is_empty() {
                let _ = write!(h, "<p><b>Exemplos — {}</b> (lista completa na exportação CSV)</p><ul>", e(kind));
                for r in rows {
                    let _ = write!(h, "<li><code>{}</code></li>", e(r));
                }
                h.push_str("</ul>");
            }
        }
    }
    if !run.structure_alerts.is_empty() {
        h.push_str("<h2>Alertas estruturais (riscos, não perdas comprovadas)</h2><ul>");
        for a in &run.structure_alerts {
            let unit = a.get("unit").and_then(|x| x.as_str()).unwrap_or("");
            let msg = a.get("message").and_then(|x| x.as_str()).unwrap_or("");
            let _ = write!(h, "<li>{}{}</li>", if unit.is_empty() { String::new() } else { format!("<b>{}</b>: ", e(unit)) }, e(msg));
        }
        h.push_str("</ul>");
    }
    h.push_str("<h2>Limitações</h2><ul><li>Volume compatível não prova que os registros são os mesmos; identidade e campos são dimensões separadas.</li><li>Unidades sem identidade comparável só têm indícios agregados.</li><li>Digests (SHA-256 truncado) detectam diferenças; não são assinatura nem anonimização.</li><li>Verificações marcadas como \"não verificado\" ou \"inconclusivo\" não sustentam aprovação.</li></ul>");
    h.push_str("</body></html>");
    h
}

/// Renders one findings line for display/export. `reveal` shows values in full.
pub fn render_finding(kind: &str, line: &str, mask_key: bool, sensitive_fields: &[bool], field_labels: &[String], reveal: bool) -> Vec<String> {
    let parts: Vec<&str> = line.split('\t').collect();
    let key = render_key(parts.first().copied().unwrap_or(""));
    let key = if mask_key && !reveal { mask(&key) } else { key };
    match kind {
        "fields" => {
            let i: usize = parts.get(1).and_then(|x| x.parse().ok()).unwrap_or(0);
            let label = field_labels.get(i).cloned().unwrap_or_else(|| format!("campo {i}"));
            let hide = !reveal && sensitive_fields.get(i).copied().unwrap_or(false);
            let val = |x: Option<&&str>| {
                let v = render_value(x.copied().unwrap_or(""));
                if v.is_empty() {
                    "(valor não guardado)".to_string()
                } else if hide {
                    mask(&v)
                } else {
                    v
                }
            };
            let cat = match parts.get(2).copied().unwrap_or("") {
                "lost" => "perdido no destino",
                "created" => "criado no destino",
                "divergent" => "valor divergente",
                "invalid" => "valor inválido",
                o => o,
            };
            vec![key, label, cat.into(), val(parts.get(3)), val(parts.get(4))]
        }
        "multiplicity" => vec![key, parts.get(1).unwrap_or(&"").to_string(), parts.get(2).unwrap_or(&"").to_string()],
        "relations" | "relations_map" | "orphans" => vec![key, parts.get(1).unwrap_or(&"").to_string(), match parts.get(2).copied().unwrap_or("") {
            "changed" => "associação alterada".into(),
            "orphan" => "órfão".into(),
            "unmapped_fk" => "FK sem correspondência no mapa".into(),
            "created" => "relação criada no destino".into(),
            o => o.to_string(),
        }],
        "ambiguous" => vec![key, match parts.get(1).copied().unwrap_or("") {
            "preexisting" => "já existia no destino antes da carga".into(),
            "duplicate" => "chave duplicada: campos não comparados".into(),
            o => o.into(),
        }],
        _ => vec![key, parts.get(1).unwrap_or(&"").to_string()],
    }
}

pub fn headers(kind: &str) -> Vec<&'static str> {
    match kind {
        "fields" => vec!["identidade", "campo", "problema", "valor na origem", "valor no destino"],
        "multiplicity" => vec!["identidade", "ocorrências na origem", "ocorrências no destino"],
        "relations" | "relations_map" | "orphans" => vec!["identidade", "relacionamento", "problema"],
        "ambiguous" => vec!["identidade", "motivo"],
        _ => vec!["identidade", "ocorrências"],
    }
}

/// Streams a findings file to CSV.
pub fn findings_csv(src: &Path, out: &Path, kind: &str, mask_key: bool, sens: &[bool], labels: &[String], reveal: bool) -> Result<u64, String> {
    let f = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let tmp = out.with_extension("csv.tmp");
    let mut w = std::io::BufWriter::new(std::fs::File::create(&tmp).map_err(|e| e.to_string())?);
    w.write_all("\u{feff}".as_bytes()).map_err(|e| e.to_string())?;
    writeln!(w, "{}", csv_row(&headers(kind).iter().map(|s| s.to_string()).collect::<Vec<_>>())).map_err(|e| e.to_string())?;
    let mut n = 0;
    for l in BufReader::new(f).lines() {
        let l = l.map_err(|e| e.to_string())?;
        writeln!(w, "{}", csv_row(&render_finding(kind, &l, mask_key, sens, labels, reveal))).map_err(|e| e.to_string())?;
        n += 1;
    }
    w.flush().map_err(|e| e.to_string())?;
    drop(w);
    std::fs::rename(&tmp, out).map_err(|e| e.to_string())?;
    Ok(n)
}

pub fn summary_csv(run: &RunManifest) -> String {
    let mut s = String::from("\u{feff}");
    s.push_str(&csv_row(&["unidade", "execução", "volume", "identidade", "campos", "relacionamentos", "origem", "excluídos", "esperado", "destino", "diferença", "tipo de contagem", "ausentes", "extras", "multiplicidade", "chaves nulas origem", "chaves nulas destino", "colisões", "campos com perda", "campos divergentes", "erro"].map(String::from)));
    s.push('\n');
    for u in &run.units {
        let n = |x: Option<u64>| x.map(|v| v.to_string()).unwrap_or_default();
        s.push_str(&csv_row(&[
            u.name.clone(),
            status_label(&u.status).into(),
            res_label(&u.volume.result).into(),
            res_label(&u.identity.result).into(),
            res_label(&u.fields_dim.result).into(),
            res_label(&u.relations.result).into(),
            n(u.counts.source),
            u.counts.excluded.to_string(),
            n(u.counts.expected),
            n(u.counts.target),
            u.counts.diff.map(|d| d.to_string()).unwrap_or_default(),
            u.counts.kind.clone(),
            u.missing.to_string(),
            u.extra.to_string(),
            u.multiplicity.to_string(),
            u.null_keys_source.to_string(),
            u.null_keys_target.to_string(),
            u.collisions.to_string(),
            u.fields.iter().filter(|f| f.lost > 0).count().to_string(),
            u.fields.iter().filter(|f| f.divergent > 0).count().to_string(),
            u.error.clone(),
        ]));
        s.push('\n');
    }
    s
}

/// Manifest for export: profile min/max of sensitive fields masked unless detailed.
pub fn sanitized_manifest(run: &RunManifest, detailed: bool) -> RunManifest {
    let mut r = run.clone();
    if detailed {
        return r;
    }
    for u in r.units.iter_mut() {
        let sens: Vec<String> = run.units_config.iter().find(|x| x.id == u.unit_id).map(|x| x.fields.iter().filter(|f| f.sensitive).map(|f| f.id.clone()).collect()).unwrap_or_default();
        if let Some(tc) = u.target_capture.as_mut() {
            for (k, p) in tc.profile.iter_mut() {
                if sens.contains(k) {
                    p.min = p.min.as_deref().map(mask);
                    p.max = p.max.as_deref().map(mask);
                }
            }
        }
    }
    r
}
