//! Child processes: run configurations (plain output streaming), language servers and
//! debug adapters (JSON-RPC with Content-Length framing over stdio or TCP), and PTY terminals.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSpec {
    pub id: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// "plain" (stream text), "rpc" (Content-Length framed JSON over stdio)
    #[serde(default)]
    pub mode: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OutEvent {
    id: String,
    stream: &'static str,
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    id: String,
    code: Option<i32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RpcEvent {
    id: String,
    msg: String,
}

enum Sink {
    Stdin(tokio::process::ChildStdin),
    Tcp(tokio::net::tcp::OwnedWriteHalf),
}

struct Proc {
    pid: Option<u32>,
    sink: Option<Sink>,
    rpc: bool,
    /// Label of the window that started it (cleaned up when that page reloads or closes).
    owner: String,
}

#[derive(Default)]
pub struct Procs {
    map: Mutex<HashMap<String, Arc<Mutex<Proc>>>>,
}

pub fn hidden(c: &mut Command) {
    #[cfg(windows)]
    {
        c.creation_flags(0x0800_0000);
    }
    // Own process group, so kill_tree can stop children too (go run, pytest workers...).
    #[cfg(unix)]
    {
        c.process_group(0);
    }
    let _ = c;
}

/// GUI apps on macOS start with a minimal PATH (/usr/bin:/bin:...), without Homebrew, pyenv, Go etc.
/// Adopts the PATH of the user's login shell once at startup, like a terminal would see it.
#[cfg(target_os = "macos")]
pub fn adopt_login_shell_path() {
    const MARK: &str = "__RITS_PATH__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let child = std::process::Command::new(&shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(child) = child else { return };
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    // A broken shell profile must not block the app from starting.
    let Ok(Ok(out)) = rx.recv_timeout(std::time::Duration::from_secs(3)) else { return };
    let text = String::from_utf8_lossy(&out.stdout);
    if let Some(path) = text.split(MARK).nth(1).filter(|p| !p.trim().is_empty()) {
        std::env::set_var("PATH", path);
    }
}

/// Locates an executable on PATH plus well-known tool folders (Go bin, Python Scripts).
pub fn which(name: &str, extra: &[String]) -> Option<String> {
    let exts: Vec<&str> = if cfg!(windows) && !name.contains('.') { vec![".exe", ".cmd", ".bat", ""] } else { vec![""] };
    let p = PathBuf::from(name);
    if p.is_absolute() {
        return if p.exists() { Some(p.to_string_lossy().into()) } else { None };
    }
    let mut dirs: Vec<PathBuf> = extra.iter().map(PathBuf::from).collect();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.extend(default_tool_dirs());
    for d in dirs {
        for e in &exts {
            let c = d.join(format!("{name}{e}"));
            if c.is_file() {
                return Some(c.to_string_lossy().into());
            }
        }
    }
    None
}

pub fn default_tool_dirs() -> Vec<PathBuf> {
    let mut v = vec![];
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = PathBuf::from(home);
        v.push(home.join("go").join("bin"));
        v.push(home.join(".local").join("bin"));
    }
    if cfg!(windows) {
        let programs = PathBuf::from(std::env::var_os("ProgramFiles").unwrap_or_else(|| r"C:\Program Files".into()));
        v.push(programs.join("Go").join("bin"));
        v.push(programs.join("Git").join("cmd"));
        v.push(programs.join("nodejs"));
        v.push(programs.join("Docker").join("Docker").join("resources").join("bin"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            v.push(local.join("Programs").join("DockerDesktop").join("resources").join("bin"));
            v.push(local.join("Programs").join("nodejs"));
            v.push(local.join("Microsoft").join("WinGet").join("Links"));
            v.push(local.join("Microsoft").join("WindowsApps"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            v.push(PathBuf::from(appdata).join("npm"));
        }
    } else {
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            v.push(home.join(".pyenv").join("shims"));
            v.push(home.join(".cargo").join("bin"));
        }
        for d in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/go/bin", "/opt/local/bin"] {
            v.push(PathBuf::from(d));
        }
        v.push(PathBuf::from("/Library/Frameworks/Python.framework/Versions/Current/bin"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let base = PathBuf::from(local).join("Programs").join("Python");
        if let Ok(rd) = std::fs::read_dir(&base) {
            let mut vers: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
            vers.sort();
            for p in vers.into_iter().rev() {
                v.push(p.join("Scripts"));
                v.push(p);
            }
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let base = PathBuf::from(appdata).join("Python");
        if let Ok(rd) = std::fs::read_dir(&base) {
            for e in rd.flatten() {
                v.push(e.path().join("Scripts"));
            }
        }
    }
    v
}

/// PATH with the tool folders appended, so spawned tools find each other (go → gopls etc).
pub fn augmented_path(extra_front: &[String]) -> String {
    let mut parts: Vec<PathBuf> = extra_front.iter().map(PathBuf::from).collect();
    if let Some(path) = std::env::var_os("PATH") {
        parts.extend(std::env::split_paths(&path));
    }
    parts.extend(default_tool_dirs());
    std::env::join_paths(parts).map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn prepare(spec: &SpawnSpec) -> Result<Command, String> {
    let program = which(&spec.program, &[]).unwrap_or_else(|| spec.program.clone());
    let mut c = Command::new(&program);
    c.args(&spec.args);
    if !spec.cwd.is_empty() {
        c.current_dir(&spec.cwd);
    }
    let front: Vec<String> = spec.env.get("RITS_PATH_PREPEND").map(|s| s.split(';').map(str::to_string).collect()).unwrap_or_default();
    c.env("PATH", augmented_path(&front));
    c.env("PYTHONUNBUFFERED", "1").env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8");
    for (k, v) in &spec.env {
        if k != "RITS_PATH_PREPEND" {
            c.env(k, v);
        }
    }
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    c.kill_on_drop(true);
    hidden(&mut c);
    Ok(c)
}

/// Streams a reader as UTF-8 text chunks, carrying incomplete multi-byte sequences.
async fn pump_text<R: AsyncRead + Unpin>(app: AppHandle, id: String, stream: &'static str, r: R) {
    read_text_chunks(r, |data| {
        let _ = app.emit("proc-out", OutEvent { id: id.clone(), stream, data });
    })
    .await;
}

/// Reads text, emitting complete UTF-8 chunks (multi-byte sequences split across reads are carried over).
pub async fn read_text_chunks<R: AsyncRead + Unpin>(mut r: R, mut emit: impl FnMut(String)) {
    let mut buf = vec![0u8; 16384];
    let mut carry: Vec<u8> = vec![];
    loop {
        let n = match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        carry.extend_from_slice(&buf[..n]);
        let valid = match std::str::from_utf8(&carry) {
            Ok(_) => carry.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => carry.len(),
        };
        let chunk: Vec<u8> = carry.drain(..valid).collect();
        let text = String::from_utf8_lossy(&chunk).into_owned();
        if !text.is_empty() {
            emit(text);
        }
    }
    if !carry.is_empty() {
        emit(String::from_utf8_lossy(&carry).into_owned());
    }
}

/// Reads Content-Length framed messages and emits them.
async fn pump_rpc<R: AsyncRead + Unpin>(app: AppHandle, id: String, r: R) {
    read_rpc_messages(r, |msg| {
        let _ = app.emit("rpc-in", RpcEvent { id: id.clone(), msg });
    })
    .await;
}

/// Reads Content-Length framed JSON-RPC messages until EOF.
pub async fn read_rpc_messages<R: AsyncRead + Unpin>(r: R, mut emit: impl FnMut(String)) {
    let mut reader = BufReader::new(r);
    loop {
        let mut len: Option<usize> = None;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let l = line.trim();
            if l.is_empty() {
                if len.is_some() {
                    break;
                }
                continue;
            }
            if let Some(v) = l.strip_prefix("Content-Length:").or_else(|| l.strip_prefix("content-length:")) {
                len = v.trim().parse().ok();
            }
        }
        let n = len.unwrap_or(0);
        let mut body = vec![0u8; n];
        if reader.read_exact(&mut body).await.is_err() {
            return;
        }
        emit(String::from_utf8_lossy(&body).into_owned());
    }
}

impl Procs {
    pub async fn spawn(&self, app: AppHandle, spec: SpawnSpec, owner: &str) -> Result<u32, String> {
        self.spawn_notify(app, spec, owner, None).await
    }

    /// Like `spawn`, and sends the exit code on `done` after proc-exit (used to release locks).
    pub async fn spawn_notify(&self, app: AppHandle, spec: SpawnSpec, owner: &str, done: Option<tokio::sync::oneshot::Sender<Option<i32>>>) -> Result<u32, String> {
        let mut c = prepare(&spec)?;
        let mut child = c.spawn().map_err(|e| format!("Não foi possível iniciar '{}': {e}", spec.program))?;
        let pid = child.id();
        let rpc = spec.mode == "rpc";
        let stdin = child.stdin.take().map(Sink::Stdin);
        let out = child.stdout.take().unwrap();
        let err = child.stderr.take().unwrap();
        let id = spec.id.clone();
        let proc = Arc::new(Mutex::new(Proc { pid, sink: stdin, rpc, owner: owner.to_string() }));
        self.map.lock().await.insert(id.clone(), proc);

        let a1 = app.clone();
        let i1 = id.clone();
        let h1 = if rpc {
            tokio::spawn(async move { pump_rpc(a1, i1, out).await })
        } else {
            tokio::spawn(async move { pump_text(a1, i1, "stdout", out).await })
        };
        let a2 = app.clone();
        let i2 = id.clone();
        let h2 = tokio::spawn(async move { pump_text(a2, i2, "stderr", err).await });
        tokio::spawn(async move {
            let status = child.wait().await.ok();
            let _ = h1.await;
            let _ = h2.await;
            let code = status.and_then(|s| s.code());
            let _ = app.emit("proc-exit", ExitEvent { id, code });
            if let Some(d) = done {
                let _ = d.send(code);
            }
        });
        Ok(pid.unwrap_or(0))
    }

    /// Connects to a TCP debug adapter (e.g. `dlv dap --listen`), retrying while it starts.
    pub async fn connect_tcp(&self, app: AppHandle, id: String, addr: String, owner: &str) -> Result<(), String> {
        let mut last = String::new();
        for _ in 0..60 {
            match tokio::net::TcpStream::connect(&addr).await {
                Ok(s) => {
                    let (r, w) = s.into_split();
                    let proc = Arc::new(Mutex::new(Proc { pid: None, sink: Some(Sink::Tcp(w)), rpc: true, owner: owner.to_string() }));
                    self.map.lock().await.insert(id.clone(), proc);
                    tokio::spawn(async move {
                        pump_rpc(app.clone(), id.clone(), r).await;
                        let _ = app.emit("proc-exit", ExitEvent { id, code: None });
                    });
                    return Ok(());
                }
                Err(e) => last = e.to_string(),
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        Err(format!("Não foi possível conectar em {addr}: {last}"))
    }

    pub async fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let p = self.map.lock().await.get(id).cloned().ok_or("processo não encontrado")?;
        let mut p = p.lock().await;
        let framed = if p.rpc { format!("Content-Length: {}\r\n\r\n{}", data.len(), data) } else { data.to_string() };
        match p.sink.as_mut() {
            Some(Sink::Stdin(s)) => write_all(s, framed.as_bytes()).await,
            Some(Sink::Tcp(s)) => write_all(s, framed.as_bytes()).await,
            None => Err("entrada fechada".into()),
        }
    }

    pub async fn close_stdin(&self, id: &str) {
        if let Some(p) = self.map.lock().await.get(id).cloned() {
            p.lock().await.sink = None;
        }
    }

    pub async fn kill(&self, id: &str) {
        let p = self.map.lock().await.remove(id);
        if let Some(p) = p {
            let mut p = p.lock().await;
            p.sink = None;
            if let Some(pid) = p.pid {
                kill_tree(pid).await;
            }
        }
    }

    pub async fn kill_owner(&self, owner: &str) {
        let mut ids = vec![];
        for (id, p) in self.map.lock().await.iter() {
            if p.lock().await.owner == owner {
                ids.push(id.clone());
            }
        }
        for id in ids {
            self.kill(&id).await;
        }
    }

    pub async fn kill_all(&self) {
        let ids: Vec<String> = self.map.lock().await.keys().cloned().collect();
        for id in ids {
            self.kill(&id).await;
        }
    }
}

async fn write_all<W: AsyncWrite + Unpin>(w: &mut W, data: &[u8]) -> Result<(), String> {
    w.write_all(data).await.map_err(|e| e.to_string())?;
    w.flush().await.map_err(|e| e.to_string())
}

/// Kills a process and all its children (go run, pytest workers...).
pub async fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut c = Command::new("taskkill");
        c.args(["/T", "/F", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null());
        hidden(&mut c);
        let _ = c.status().await;
    }
    #[cfg(not(windows))]
    {
        // Processes are spawned as group leaders (see hidden), so kill the whole group first.
        let quiet = |c: &mut Command| {
            c.stdout(Stdio::null()).stderr(Stdio::null());
        };
        let mut g = Command::new("kill");
        g.args(["-9", "--", &format!("-{pid}")]);
        quiet(&mut g);
        let _ = g.status().await;
        let mut p = Command::new("kill");
        p.args(["-9", &pid.to_string()]);
        quiet(&mut p);
        let _ = p.status().await;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Captured {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

// macOS has no "C.UTF-8" locale before Sonoma; en_US.UTF-8 exists everywhere there.
const UTF8_LOCALE: &str = if cfg!(target_os = "macos") { "en_US.UTF-8" } else { "C.UTF-8" };

/// Runs a command to completion and returns its output (git, go env, python -c ...).
pub async fn capture(program: &str, args: &[String], cwd: &str, input: Option<String>, timeout_s: u64) -> Result<Captured, String> {
    let exe = which(program, &[]).unwrap_or_else(|| program.to_string());
    let mut c = Command::new(&exe);
    c.args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
    if !cwd.is_empty() {
        c.current_dir(cwd);
    }
    c.env("PATH", augmented_path(&[])).env("PYTHONUTF8", "1").env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", UTF8_LOCALE);
    c.kill_on_drop(true);
    hidden(&mut c);
    let mut child = c.spawn().map_err(|e| format!("'{program}' não encontrado ou falhou ao iniciar: {e}"))?;
    if let Some(inp) = input {
        if let Some(mut si) = child.stdin.take() {
            let _ = si.write_all(inp.as_bytes()).await;
        }
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(timeout_s), child.wait_with_output())
        .await
        .map_err(|_| format!("'{program}' excedeu {timeout_s}s"))?
        .map_err(|e| e.to_string())?;
    Ok(Captured {
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

// ---------------- PTY terminals ----------------

struct Term {
    owner: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terms(StdMutex<HashMap<String, Term>>);

#[derive(Serialize, Clone)]
struct PtyEvent {
    id: String,
    data: String,
}

pub fn pty_open(app: AppHandle, terms: &Terms, owner: &str, id: String, shell: String, cwd: String, cols: u16, rows: u16, env: HashMap<String, String>) -> Result<(), String> {
    let pty = native_pty_system();
    let pair = pty.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let mut parts = shell.split_whitespace();
    let prog = parts.next().unwrap_or(if cfg!(windows) { "powershell.exe" } else { "/bin/sh" });
    let mut cmd = CommandBuilder::new(which(prog, &[]).unwrap_or_else(|| prog.to_string()));
    for a in parts {
        cmd.arg(a);
    }
    if !cwd.is_empty() {
        cmd.cwd(&cwd);
    }
    let front: Vec<String> = env.get("RITS_PATH_PREPEND").map(|s| s.split(';').map(str::to_string).collect()).unwrap_or_default();
    cmd.env("PATH", augmented_path(&front));
    cmd.env("TERM", "xterm-256color");
    if !cfg!(windows) {
        cmd.env("LANG", std::env::var("LANG").unwrap_or_else(|_| UTF8_LOCALE.into()));
    }
    for (k, v) in &env {
        if k != "RITS_PATH_PREPEND" {
            cmd.env(k, v);
        }
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let tid = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut carry: Vec<u8> = vec![];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let valid = match std::str::from_utf8(&carry) {
                        Ok(_) => carry.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => carry.len(),
                    };
                    let chunk: Vec<u8> = carry.drain(..valid).collect();
                    let _ = app.emit("pty-data", PtyEvent { id: tid.clone(), data: String::from_utf8_lossy(&chunk).into_owned() });
                }
            }
        }
        let _ = app.emit("pty-exit", PtyEvent { id: tid, data: String::new() });
    });
    terms.0.lock().unwrap().insert(id, Term { owner: owner.to_string(), master: pair.master, writer, child });
    Ok(())
}

pub fn pty_write(terms: &Terms, id: &str, data: &str) -> Result<(), String> {
    let mut m = terms.0.lock().unwrap();
    let t = m.get_mut(id).ok_or("terminal fechado")?;
    t.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    t.writer.flush().map_err(|e| e.to_string())
}

pub fn pty_resize(terms: &Terms, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let m = terms.0.lock().unwrap();
    let t = m.get(id).ok_or("terminal fechado")?;
    t.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

pub fn pty_close(terms: &Terms, id: &str) {
    if let Some(mut t) = terms.0.lock().unwrap().remove(id) {
        let _ = t.child.kill();
    }
}


pub fn pty_close_owner(terms: &Terms, owner: &str) {
    let mut m = terms.0.lock().unwrap();
    let ids: Vec<String> = m.iter().filter(|(_, t)| t.owner == owner).map(|(k, _)| k.clone()).collect();
    for id in ids {
        if let Some(mut t) = m.remove(&id) {
            let _ = t.child.kill();
        }
    }
}
