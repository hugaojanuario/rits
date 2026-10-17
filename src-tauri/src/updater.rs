//! Update check and installation from the GitHub releases of Rits.
//!
//! - Check: `GET /repos/<repo>/releases/latest` (public API, no token), semantic version compare
//!   with the running app. No request is made when the user turns the check off.
//! - Install: downloads this platform's asset, checks it against `SHA256SUMS.txt` of the same
//!   release, then Windows runs the NSIS installer in passive update mode and relaunches the app
//!   (`/P /UPDATE /R`); macOS mounts the DMG, replaces the bundle, clears the quarantine attribute
//!   (ad-hoc signed app) and reopens it.

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::{AppHandle, Emitter};

pub const REPO: &str = "hugaojanuario/rits";

pub fn asset_name() -> Option<&'static str> {
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        Some("Rits-macos-arm64.dmg")
    } else if cfg!(windows) && cfg!(target_arch = "x86_64") {
        Some("Rits-windows-x64-setup.exe")
    } else {
        None
    }
}

/// "v1.2.3" / "1.2.3-beta" -> (1, 2, 3, prerelease?)
pub fn parse_version(v: &str) -> Option<(u64, u64, u64, bool)> {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let (core, pre) = match v.split_once(['-', '+']) {
        Some((c, rest)) => (c, !rest.is_empty() && v.contains('-')),
        None => (v, false),
    };
    let mut it = core.split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next().unwrap_or("0").parse().ok()?;
    let c = it.next().unwrap_or("0").parse().ok()?;
    Some((a, b, c, pre))
}

/// Whether `latest` is newer than `current` (a release is newer than its own prerelease).
pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some((a1, b1, c1, p1)), Some((a2, b2, c2, p2))) => (a1, b1, c1) > (a2, b2, c2) || ((a1, b1, c1) == (a2, b2, c2) && p2 && !p1),
        _ => false,
    }
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub notes: String,
    pub page: String,
    pub asset: String,
    pub asset_url: String,
    pub size: u64,
    pub sums_url: String,
    pub supported: bool,
}

/// Picks this platform's asset from a release JSON.
pub fn info_from_release(current: &str, rel: &Value) -> UpdateInfo {
    let latest = rel["tag_name"].as_str().unwrap_or("").to_string();
    let assets = rel["assets"].as_array().cloned().unwrap_or_default();
    let find = |name: &str| assets.iter().find(|a| a["name"].as_str() == Some(name)).cloned();
    let name = asset_name();
    let asset = name.and_then(find);
    let sums = find("SHA256SUMS.txt");
    UpdateInfo {
        current: current.to_string(),
        available: is_newer(&latest, current) && !rel["draft"].as_bool().unwrap_or(false) && !rel["prerelease"].as_bool().unwrap_or(false),
        latest,
        notes: rel["body"].as_str().unwrap_or("").to_string(),
        page: rel["html_url"].as_str().unwrap_or("").to_string(),
        asset: name.unwrap_or("").to_string(),
        asset_url: asset.as_ref().and_then(|a| a["browser_download_url"].as_str()).unwrap_or("").to_string(),
        size: asset.as_ref().and_then(|a| a["size"].as_u64()).unwrap_or(0),
        sums_url: sums.as_ref().and_then(|a| a["browser_download_url"].as_str()).unwrap_or("").to_string(),
        supported: asset.is_some(),
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("Rits/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_check() -> Result<UpdateInfo, String> {
    let r = client()?
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Não foi possível verificar atualizações: {e}"))?;
    let status = r.status().as_u16();
    let text = r.text().await.map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(format!("O GitHub respondeu {status} ao verificar atualizações."));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(info_from_release(env!("CARGO_PKG_VERSION"), &v))
}

#[derive(Serialize, Clone)]
struct Progress {
    phase: String,
    done: u64,
    total: u64,
}

/// Expected SHA-256 of `asset` in a SHA256SUMS.txt ("<hex>  <name>" or "<hex> *<name>").
pub fn expected_sum(sums: &str, asset: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let h = it.next()?;
        let n = it.next()?.trim_start_matches('*');
        (n == asset && h.len() == 64).then(|| h.to_lowercase())
    })
}

async fn download(url: &str, to: &Path, total: u64, progress: &mut (dyn FnMut(u64, u64) + Send)) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::io::Write;
    let r = client()?.get(url).send().await.map_err(|e| format!("Falha no download: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("Falha no download ({}).", r.status()));
    }
    let mut f = std::io::BufWriter::new(std::fs::File::create(to).map_err(|e| e.to_string())?);
    let mut h = Sha256::new();
    let mut done = 0u64;
    let mut last = std::time::Instant::now();
    let mut s = r.bytes_stream();
    while let Some(chunk) = s.next().await {
        let chunk = chunk.map_err(|e| format!("Falha no download: {e}"))?;
        h.update(&chunk);
        f.write_all(&chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if last.elapsed().as_millis() > 250 {
            last = std::time::Instant::now();
            progress(done, total);
        }
    }
    f.flush().map_err(|e| e.to_string())?;
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Downloads this platform's installer into `dir` and checks it against SHA256SUMS.txt.
pub async fn fetch_verified(info: &UpdateInfo, dir: &Path, progress: &mut (dyn FnMut(u64, u64) + Send)) -> Result<std::path::PathBuf, String> {
    if !info.supported || info.asset_url.is_empty() {
        return Err("Não há instalador desta versão para este sistema. Baixe pela página da release.".into());
    }
    if info.sums_url.is_empty() {
        return Err("A release não publica SHA256SUMS.txt: atualização recusada.".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = dir.join(&info.asset);
    let sum = download(&info.asset_url, &file, info.size, progress).await?;
    let sums = client()?.get(&info.sums_url).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
    match expected_sum(&sums, &info.asset) {
        Some(exp) if exp == sum => Ok(file),
        Some(_) => {
            let _ = std::fs::remove_file(&file);
            Err("O arquivo baixado não confere com o SHA256SUMS.txt da release: atualização cancelada.".into())
        }
        None => Err("O instalador não consta no SHA256SUMS.txt: atualização recusada.".into()),
    }
}

/// Downloads, verifies and installs the latest release, then restarts the app.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let info = update_check().await?;
    if !info.available {
        return Err("Você já está na versão mais recente.".into());
    }
    let dir = std::env::temp_dir().join(format!("rits-update-{}", info.latest.trim_start_matches('v')));
    let a = app.clone();
    let file = fetch_verified(&info, &dir, &mut |done, total| {
        let _ = a.emit("update-progress", Progress { phase: "download".into(), done, total });
    })
    .await?;
    let _ = app.emit("update-progress", Progress { phase: "install".into(), done: 0, total: 0 });
    install(&app, &file).await
}

#[cfg(windows)]
async fn install(app: &AppHandle, file: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // passive update: progress window only, keeps settings, relaunches the app when done
    std::process::Command::new(file)
        .args(["/P", "/UPDATE", "/R"])
        .creation_flags(0x0000_0008) // DETACHED_PROCESS
        .spawn()
        .map_err(|e| format!("Não foi possível iniciar o instalador: {e}"))?;
    app.exit(0);
    Ok(())
}

/// macOS: replaces `target` (an .app bundle) with the app inside the DMG, clearing the quarantine
/// attribute. The old bundle is kept until the new one is in place (rolled back on failure).
#[cfg(target_os = "macos")]
pub async fn install_dmg(file: &Path, target: &Path) -> Result<(), String> {
    use crate::procs::capture;
    let mnt = file.with_extension("mnt");
    let _ = std::fs::create_dir_all(&mnt);
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let r = capture("hdiutil", &["attach".into(), s(file), "-nobrowse".into(), "-readonly".into(), "-quiet".into(), "-mountpoint".into(), s(&mnt)], "", None, 120).await?;
    if r.code != Some(0) {
        return Err(format!("Não foi possível abrir o DMG: {}", r.stderr.trim()));
    }
    let result = async {
        let staged = target.with_extension("app.new");
        let _ = std::fs::remove_dir_all(&staged);
        let c = capture("ditto", &[s(&mnt.join("Rits.app")), s(&staged)], "", None, 300).await?;
        if c.code != Some(0) {
            return Err(format!("Sem permissão para atualizar {}: {}. Use o script de instalação.", target.display(), c.stderr.trim()));
        }
        let _ = capture("xattr", &["-dr".into(), "com.apple.quarantine".into(), s(&staged)], "", None, 60).await;
        let old = target.with_extension("app.old");
        let _ = std::fs::remove_dir_all(&old);
        if target.exists() {
            std::fs::rename(target, &old).map_err(|e| format!("{}: {e}", target.display()))?;
        }
        if let Err(e) = std::fs::rename(&staged, target) {
            let _ = std::fs::rename(&old, target);
            return Err(format!("{}: {e}", target.display()));
        }
        let _ = std::fs::remove_dir_all(&old);
        Ok::<(), String>(())
    }
    .await;
    let _ = capture("hdiutil", &["detach".into(), s(&mnt), "-quiet".into()], "", None, 60).await;
    let _ = std::fs::remove_dir(&mnt);
    result
}

#[cfg(target_os = "macos")]
async fn install(app: &AppHandle, file: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let running = exe.ancestors().nth(3).map(Path::to_path_buf).unwrap_or_default();
    // a quarantined app runs from a random read-only copy: install to /Applications instead
    let target = if running.to_string_lossy().contains("/AppTranslocation/") || !running.to_string_lossy().ends_with(".app") { std::path::PathBuf::from("/Applications/Rits.app") } else { running };
    install_dmg(file, &target).await?;
    // reopen the new version once this process has exited
    std::process::Command::new("/bin/sh")
        .args(["-c", &format!("sleep 1; open \"{}\"", target.display())])
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
async fn install(_app: &AppHandle, _file: &Path) -> Result<(), String> {
    Err("Atualização automática disponível só no Windows e no macOS.".into())
}

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
