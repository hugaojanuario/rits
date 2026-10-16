//! Tauri commands for the code IDE: files, search, processes, language servers, terminals.

use crate::fsx::{self, Entry, FileText, SearchHit, Watchers};
use crate::procs::{self, Captured, Procs, SpawnSpec, Terms};
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn fs_list(path: String) -> Result<Vec<Entry>, String> {
    fsx::list_dir(&path)
}

#[tauri::command]
pub fn fs_read(path: String) -> Result<FileText, String> {
    fsx::read_file(&path)
}

#[tauri::command]
pub fn fs_write(path: String, text: String, crlf: bool) -> Result<(), String> {
    fsx::write_file(&path, &text, crlf)
}

#[tauri::command]
pub fn fs_create(path: String, dir: bool) -> Result<(), String> {
    fsx::create(&path, dir)
}

#[tauri::command]
pub fn fs_rename(from: String, to: String) -> Result<(), String> {
    fsx::rename(&from, &to)
}

#[tauri::command]
pub fn fs_delete(paths: Vec<String>) -> Result<(), String> {
    fsx::delete(&paths)
}

#[tauri::command]
pub fn fs_delete_permanently(paths: Vec<String>) -> Result<(), String> {
    fsx::delete_permanently(&paths)
}

#[tauri::command]
pub fn fs_copy(src: String, dest_dir: String) -> Result<String, String> {
    fsx::copy_into(&src, &dest_dir)
}

#[tauri::command]
pub fn fs_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
pub async fn fs_files(root: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || fsx::list_files(&root, 60_000)).await.map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fs_search(
    root: String,
    query: String,
    regex: bool,
    case: bool,
    word: bool,
    mask: String,
) -> Result<Vec<SearchHit>, String> {
    tokio::task::spawn_blocking(move || fsx::search(&root, &query, regex, case, word, &mask, 2000))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn fs_watch(app: AppHandle, w: State<'_, Watchers>, root: String) -> Result<(), String> {
    fsx::watch(app, &w, &root)
}

#[tauri::command]
pub fn fs_unwatch(w: State<'_, Watchers>, root: String) {
    fsx::unwatch(&w, &root)
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let is_dir = std::path::Path::new(&path).is_dir();
    #[cfg(windows)]
    let mut c = {
        let mut c = std::process::Command::new("explorer.exe");
        if is_dir {
            c.arg(&path);
        } else {
            c.arg(format!("/select,{}", path.replace('/', "\\")));
        }
        c
    };
    #[cfg(target_os = "macos")]
    let mut c = {
        let mut c = std::process::Command::new("open");
        if !is_dir {
            c.arg("-R");
        }
        c.arg(&path);
        c
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let mut c = {
        let mut c = std::process::Command::new("xdg-open");
        let p = std::path::Path::new(&path);
        c.arg(if is_dir { p } else { p.parent().unwrap_or(p) });
        c
    };
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---------------- processes ----------------

#[tauri::command]
pub async fn proc_spawn(app: AppHandle, window: tauri::Window, p: State<'_, Procs>, spec: SpawnSpec) -> Result<u32, String> {
    p.spawn(app, spec, window.label()).await
}

#[tauri::command]
pub async fn proc_connect(app: AppHandle, window: tauri::Window, p: State<'_, Procs>, id: String, addr: String) -> Result<(), String> {
    p.connect_tcp(app, id, addr, window.label()).await
}

#[tauri::command]
pub async fn proc_write(p: State<'_, Procs>, id: String, data: String) -> Result<(), String> {
    p.write(&id, &data).await
}

#[tauri::command]
pub async fn proc_close_stdin(p: State<'_, Procs>, id: String) -> Result<(), String> {
    p.close_stdin(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn proc_kill(p: State<'_, Procs>, id: String) -> Result<(), String> {
    p.kill(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn run_capture(
    program: String,
    args: Vec<String>,
    cwd: String,
    input: Option<String>,
    timeout: Option<u64>,
) -> Result<Captured, String> {
    procs::capture(&program, &args, &cwd, input, timeout.unwrap_or(60)).await
}

#[tauri::command]
pub fn which(name: String, extra: Vec<String>) -> Option<String> {
    procs::which(&name, &extra)
}

#[tauri::command]
pub async fn free_port() -> Result<u16, String> {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvInfo {
    home: String,
    sep: String,
    os: String,
    default_shell: String,
    username: String,
}

#[tauri::command]
pub fn env_info() -> EnvInfo {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default().replace('\\', "/");
    let pwsh = procs::which("pwsh", &[]).is_some();
    EnvInfo {
        home,
        sep: std::path::MAIN_SEPARATOR.to_string(),
        os: std::env::consts::OS.into(),
        default_shell: if cfg!(windows) {
            if pwsh { "pwsh.exe -NoLogo".into() } else { "powershell.exe -NoLogo".into() }
        } else {
            // Login shell, so it reads the user's profile (Homebrew, pyenv...).
            format!("{} -l", std::env::var("SHELL").unwrap_or_else(|_| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() }))
        },
        username: std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default(),
    }
}

// ---------------- terminals ----------------

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_open(
    app: AppHandle,
    window: tauri::Window,
    t: State<'_, Terms>,
    id: String,
    shell: String,
    cwd: String,
    cols: u16,
    rows: u16,
    env: HashMap<String, String>,
) -> Result<(), String> {
    procs::pty_open(app, &t, window.label(), id, shell, cwd, cols, rows, env)
}

#[tauri::command]
pub fn pty_write(t: State<'_, Terms>, id: String, data: String) -> Result<(), String> {
    procs::pty_write(&t, &id, &data)
}

#[tauri::command]
pub fn pty_resize(t: State<'_, Terms>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    procs::pty_resize(&t, &id, cols, rows)
}

#[tauri::command]
pub fn pty_close(t: State<'_, Terms>, id: String) {
    procs::pty_close(&t, &id)
}

/// Called when a page (re)loads: stops servers, programs and terminals left by its previous instance.
#[tauri::command]
pub async fn window_reset(window: tauri::Window, p: State<'_, Procs>, t: State<'_, Terms>, jp: State<'_, crate::jupyter::JupyterState>, au: State<'_, crate::audit::AuditState>) -> Result<(), String> {
    p.kill_owner(window.label()).await;
    jp.close_owner(window.label()).await;
    au.cancel_owner(window.label()).await;
    procs::pty_close_owner(&t, window.label());
    Ok(())
}
