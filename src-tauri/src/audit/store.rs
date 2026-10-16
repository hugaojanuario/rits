//! Versioned, atomic storage of audit projects, baselines and runs (config folder, outside any
//! repository: evidence contains data). A digest of each manifest and the SHA-256 of each evidence
//! file detect accidental changes, truncation and missing files; they are not signatures.

use super::evidence::file_sha256;
use super::model::*;
use serde::{de::DeserializeOwned, Serialize};
use std::path::{Path, PathBuf};

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn write_json_atomic<T: Serialize>(path: &Path, v: &T) -> Result<(), String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let t = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&t).map_err(|e| format!("{}: arquivo inválido ou truncado ({e})", path.display()))
}

pub fn baseline_digest(m: &BaselineManifest) -> String {
    let mut c = m.clone();
    c.digest = String::new();
    super::canon::sha256_hex(&serde_json::to_vec(&c).unwrap_or_default())
}

pub fn run_digest(m: &RunManifest) -> String {
    let mut c = m.clone();
    c.digest = String::new();
    super::canon::sha256_hex(&serde_json::to_vec(&c).unwrap_or_default())
}

pub struct Layout {
    pub root: PathBuf,
}

impl Layout {
    pub fn project(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_id(id) {
            return Err("Identificador de projeto inválido.".into());
        }
        Ok(self.root.join(id))
    }
    pub fn baseline(&self, pid: &str, bid: &str) -> Result<PathBuf, String> {
        if !valid_id(bid) {
            return Err("Identificador de baseline inválido.".into());
        }
        Ok(self.project(pid)?.join("baselines").join(bid))
    }
    pub fn run(&self, pid: &str, rid: &str) -> Result<PathBuf, String> {
        if !valid_id(rid) {
            return Err("Identificador de execução inválido.".into());
        }
        Ok(self.project(pid)?.join("runs").join(rid))
    }
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Integrity {
    pub ok: bool,
    pub problems: Vec<String>,
}

/// Loads a baseline and checks format, digest and every evidence file.
pub fn verify_baseline(dir: &Path) -> (Option<BaselineManifest>, Integrity) {
    let mut it = Integrity::default();
    let m: BaselineManifest = match read_json(&dir.join("manifest.json")) {
        Ok(m) => m,
        Err(e) => {
            it.problems.push(format!("Manifesto ilegível: {e}"));
            return (None, it);
        }
    };
    if m.format != FORMAT || m.kind != "baseline" {
        it.problems.push(format!("Formato incompatível (versão {} / tipo \"{}\"; esperado {FORMAT} / baseline).", m.format, m.kind));
    }
    if baseline_digest(&m) != m.digest {
        it.problems.push("O manifesto foi alterado depois da gravação (digest diferente).".into());
    }
    for u in &m.units {
        for ef in [&u.evidence, &u.excluded_evidence].into_iter().flatten() {
            let p = dir.join(&ef.path);
            if ef.path.contains("..") || ef.path.contains('/') || ef.path.contains('\\') {
                it.problems.push(format!("Caminho de evidência inválido: {}", ef.path));
                continue;
            }
            match file_sha256(&p) {
                Ok((sha, n)) => {
                    if n != ef.bytes {
                        it.problems.push(format!("{}: tamanho {n} bytes, esperado {} (arquivo truncado ou alterado).", ef.path, ef.bytes));
                    } else if sha != ef.sha256 {
                        it.problems.push(format!("{}: conteúdo alterado (SHA-256 diferente).", ef.path));
                    }
                }
                Err(_) => it.problems.push(format!("{}: arquivo de evidência ausente.", ef.path)),
            }
        }
    }
    it.ok = it.problems.is_empty();
    (Some(m), it)
}

pub fn verify_run(dir: &Path) -> (Option<RunManifest>, Integrity) {
    let mut it = Integrity::default();
    let m: RunManifest = match read_json(&dir.join("manifest.json")) {
        Ok(m) => m,
        Err(e) => {
            it.problems.push(format!("Manifesto ilegível: {e}"));
            return (None, it);
        }
    };
    if m.format != FORMAT || m.kind != "run" {
        it.problems.push("Formato de execução incompatível.".into());
    }
    if run_digest(&m) != m.digest {
        it.problems.push("O manifesto foi alterado depois da gravação (digest diferente).".into());
    }
    it.ok = it.problems.is_empty();
    (Some(m), it)
}
