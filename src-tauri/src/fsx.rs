//! Project file system: listing, reading/writing, file operations, search and watching.

use ignore::WalkBuilder;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub ignored: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub text: String,
    pub binary: bool,
    pub too_large: bool,
    pub crlf: bool,
    pub encoding: String,
}

const MAX_OPEN_BYTES: u64 = 20 * 1024 * 1024;
const HIDDEN_DIRS: &[&str] = &[".git", "node_modules", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".idea", ".vs"];

pub fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

pub fn list_dir(path: &str) -> Result<Vec<Entry>, String> {
    let rd = std::fs::read_dir(path).map_err(|e| format!("{path}: {e}"))?;
    let gitignored = gitignore_for(Path::new(path));
    let mut out: Vec<Entry> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let md = e.metadata().ok()?;
            let name = e.file_name().to_string_lossy().to_string();
            if name == ".git" {
                return None;
            }
            let is_dir = md.is_dir();
            let ignored = HIDDEN_DIRS.contains(&name.as_str())
                || gitignored
                    .as_ref()
                    .map(|g| g.matched_path_or_any_parents(&p, is_dir).is_ignore())
                    .unwrap_or(false);
            Some(Entry { name, path: norm(&p), is_dir, size: md.len(), ignored })
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// Builds a matcher from all .gitignore files between the repo root and `dir`.
fn gitignore_for(dir: &Path) -> Option<ignore::gitignore::Gitignore> {
    let mut root = dir;
    loop {
        if root.join(".git").exists() {
            break;
        }
        root = root.parent()?;
    }
    let mut b = ignore::gitignore::GitignoreBuilder::new(root);
    let mut d = Some(dir);
    while let Some(cur) = d {
        let gi = cur.join(".gitignore");
        if gi.exists() {
            b.add(gi);
        }
        if cur == root {
            break;
        }
        d = cur.parent();
    }
    b.build().ok()
}

pub fn read_file(path: &str) -> Result<FileText, String> {
    let md = std::fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
    if md.len() > MAX_OPEN_BYTES {
        return Ok(FileText { text: String::new(), binary: false, too_large: true, crlf: false, encoding: "UTF-8".into() });
    }
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    let sniff = &bytes[..bytes.len().min(8000)];
    if sniff.contains(&0) {
        return Ok(FileText { text: String::new(), binary: true, too_large: false, crlf: false, encoding: "binary".into() });
    }
    let (text, encoding) = match std::str::from_utf8(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)) {
        Ok(s) => (s.to_string(), if bytes.starts_with(b"\xEF\xBB\xBF") { "UTF-8 BOM" } else { "UTF-8" }),
        Err(_) => {
            let (cow, _, _) = encoding_rs::WINDOWS_1252.decode(&bytes);
            (cow.into_owned(), "windows-1252")
        }
    };
    let crlf = text.contains("\r\n");
    Ok(FileText { text: text.replace("\r\n", "\n"), binary: false, too_large: false, crlf, encoding: encoding.into() })
}

pub fn write_file(path: &str, text: &str, crlf: bool) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = if crlf { text.replace('\n', "\r\n") } else { text.to_string() };
    std::fs::write(path, data).map_err(|e| format!("{path}: {e}"))
}

pub fn create(path: &str, dir: bool) -> Result<(), String> {
    let p = Path::new(path);
    if p.exists() {
        return Err(format!("'{}' já existe", p.file_name().unwrap_or_default().to_string_lossy()));
    }
    if dir {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())
    } else {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(p, "").map_err(|e| e.to_string())
    }
}

pub fn rename(from: &str, to: &str) -> Result<(), String> {
    if !Path::new(from).exists() {
        return Err(format!("{from} não existe mais"));
    }
    // On case-insensitive file systems (macOS, Windows) "a.txt" -> "A.txt" points to the same
    // file: that is a rename, not a collision.
    let same = match (std::fs::canonicalize(from), std::fs::canonicalize(to)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if Path::new(to).exists() && !same {
        return Err("Já existe um arquivo com esse nome".into());
    }
    std::fs::rename(from, to).map_err(|e| e.to_string())
}

/// Moves to the recycle bin instead of deleting permanently. On macOS the file manager API is
/// used: the default (asking Finder through AppleScript) needs an automation permission that an
/// ad-hoc signed app may never get, and then nothing is deleted.
pub fn to_trash<P: AsRef<Path>>(paths: &[P]) -> Result<(), String> {
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete_all(paths).map_err(|e| format!("Não foi possível mover para a Lixeira: {e}"))
}

pub fn delete(paths: &[String]) -> Result<(), String> {
    to_trash(paths)
}

pub fn copy_into(src: &str, dest_dir: &str) -> Result<String, String> {
    let s = Path::new(src);
    let name = s.file_name().ok_or("caminho inválido")?.to_string_lossy().to_string();
    let mut dest = Path::new(dest_dir).join(&name);
    let mut n = 1;
    while dest.exists() {
        let stem = s.file_stem().unwrap_or_default().to_string_lossy();
        let ext = s.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        dest = Path::new(dest_dir).join(format!("{stem}_{n}{ext}"));
        n += 1;
    }
    if s.is_dir() {
        copy_dir(s, &dest)?;
    } else {
        std::fs::copy(s, &dest).map_err(|e| e.to_string())?;
    }
    Ok(norm(&dest))
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        let t = to.join(e.file_name());
        if p.is_dir() {
            copy_dir(&p, &t)?;
        } else {
            std::fs::copy(&p, &t).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// All project files (gitignore-aware) for "Go to file".
pub fn list_files(root: &str, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    for e in WalkBuilder::new(root).hidden(false).filter_entry(|e| !HIDDEN_DIRS.contains(&e.file_name().to_string_lossy().as_ref())).build().flatten() {
        if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            out.push(norm(e.path()));
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub line: usize,
    pub col: usize,
    pub len: usize,
    pub text: String,
}

pub fn search(root: &str, query: &str, regex: bool, case: bool, word: bool, mask: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let mut pat = if regex { query.to_string() } else { regex::escape(query) };
    if word {
        pat = format!(r"\b{pat}\b");
    }
    let re = regex::RegexBuilder::new(&pat).case_insensitive(!case).build().map_err(|e| e.to_string())?;
    let masks: Vec<glob_lite::Glob> = mask.split(',').map(str::trim).filter(|s| !s.is_empty()).map(glob_lite::Glob::new).collect();
    let mut hits = Vec::new();
    for e in WalkBuilder::new(root).hidden(false).filter_entry(|e| !HIDDEN_DIRS.contains(&e.file_name().to_string_lossy().as_ref())).build().flatten() {
        if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = e.file_name().to_string_lossy();
        if !masks.is_empty() && !masks.iter().any(|g| g.matches(&name)) {
            continue;
        }
        if e.metadata().map(|m| m.len() > 4 * 1024 * 1024).unwrap_or(true) {
            continue;
        }
        let Ok(bytes) = std::fs::read(e.path()) else { continue };
        if bytes[..bytes.len().min(4000)].contains(&0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            for m in re.find_iter(line) {
                let col = line[..m.start()].chars().count();
                let trimmed: String = line.chars().take(400).collect();
                hits.push(SearchHit { path: norm(e.path()), line: i + 1, col: col + 1, len: m.as_str().chars().count(), text: trimmed });
                if hits.len() >= limit {
                    return Ok(hits);
                }
            }
        }
    }
    Ok(hits)
}

mod glob_lite {
    /// Minimal "*.py" style file mask matcher.
    pub struct Glob(regex::Regex);
    impl Glob {
        pub fn new(p: &str) -> Glob {
            let re = format!("(?i)^{}$", regex::escape(p).replace(r"\*", ".*").replace(r"\?", "."));
            Glob(regex::Regex::new(&re).unwrap_or_else(|_| regex::Regex::new("^$").unwrap()))
        }
        pub fn matches(&self, name: &str) -> bool {
            self.0.is_match(name)
        }
    }
}

// ---------------- watcher ----------------

#[derive(Default)]
pub struct Watchers(Mutex<HashMap<String, RecommendedWatcher>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FsEvent {
    root: String,
    paths: Vec<String>,
}

pub fn watch(app: AppHandle, w: &Watchers, root: &str) -> Result<(), String> {
    let mut map = w.0.lock().unwrap();
    if map.contains_key(root) {
        return Ok(());
    }
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    watcher.watch(Path::new(root), RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    let root_s = root.to_string();
    std::thread::spawn(move || {
        // Debounce: collect events for 250 ms and emit the changed paths once.
        loop {
            let Ok(first) = rx.recv() else { break };
            let mut paths: Vec<PathBuf> = vec![];
            let mut push = |ev: notify::Result<notify::Event>| {
                if let Ok(ev) = ev {
                    if matches!(ev.kind, notify::EventKind::Access(_)) {
                        return;
                    }
                    for p in ev.paths {
                        let s = p.to_string_lossy();
                        if s.contains("\\.git\\") && !s.ends_with("HEAD") && !s.ends_with("index") {
                            continue;
                        }
                        if !paths.contains(&p) {
                            paths.push(p);
                        }
                    }
                }
            };
            push(first);
            while let Ok(ev) = rx.recv_timeout(Duration::from_millis(250)) {
                push(ev);
            }
            if !paths.is_empty() {
                let _ = app.emit("fs-change", FsEvent { root: root_s.clone(), paths: paths.iter().map(|p| norm(p)).collect() });
            }
        }
    });
    map.insert(root.to_string(), watcher);
    Ok(())
}

pub fn unwatch(w: &Watchers, root: &str) {
    w.0.lock().unwrap().remove(root);
}
