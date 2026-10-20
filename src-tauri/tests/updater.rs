//! Update check: version comparison, asset selection and checksum parsing; `github_latest`
//! (`--ignored`, needs network) asks the real GitHub API.
use rits_lib::updater::{asset_name, expected_sum, info_from_release, is_newer, parse_version};
use serde_json::json;

#[test]
fn versions() {
    assert!(is_newer("v1.1.0", "1.0.0"));
    assert!(is_newer("v0.4.10", "0.4.9"), "numérico, não lexicográfico");
    assert!(is_newer("v1.0.0", "1.0.0-beta.2"));
    assert!(!is_newer("v1.0.0", "1.0.0"));
    assert!(!is_newer("v0.9.9", "1.0.0"));
    assert!(!is_newer("lixo", "1.0.0"));
    assert_eq!(parse_version("V2.3"), Some((2, 3, 0, false)));
}

#[test]
fn release_json_and_checksums() {
    let rel = json!({
        "tag_name": "v9.9.9", "body": "notas", "html_url": "https://x/r", "draft": false, "prerelease": false,
        "assets": [
            {"name": "Rits-macos-arm64.dmg", "browser_download_url": "https://x/mac", "size": 10},
            {"name": "Rits-windows-x64-setup.exe", "browser_download_url": "https://x/win", "size": 20},
            {"name": "SHA256SUMS.txt", "browser_download_url": "https://x/sums", "size": 1}
        ]
    });
    let i = info_from_release("0.4.2", &rel);
    assert!(i.available);
    assert_eq!(i.sums_url, "https://x/sums");
    // Linux has no automatic update: the release is offered, but not installed by the app.
    assert_eq!(i.supported, asset_name().is_some());
    if i.supported {
        assert!(i.asset_url.ends_with(if cfg!(windows) { "/win" } else { "/mac" }));
    }
    let same = info_from_release("9.9.9", &rel);
    assert!(!same.available, "na versão mais nova não oferece atualização");
    let pre = info_from_release("0.1.0", &json!({"tag_name": "v9.9.9", "prerelease": true, "assets": []}));
    assert!(!pre.available);
    let sums = "aa  outro.bin\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789ABCDEF  Rits-macos-arm64.dmg\n";
    assert_eq!(expected_sum(sums, "Rits-macos-arm64.dmg").unwrap(), "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    assert!(expected_sum(sums, "Rits-windows-x64-setup.exe").is_none());
}

#[tokio::test]
#[ignore]
async fn github_latest() {
    let i = rits_lib::updater::update_check().await.unwrap();
    assert!(i.latest.starts_with('v'), "{i:?}");
    assert!(!i.sums_url.is_empty());
    println!("{i:?}");
}

#[tokio::test]
#[ignore]
async fn download_and_verify_real_installer() {
    let mut i = rits_lib::updater::update_check().await.unwrap();
    i.available = true;
    let dir = std::env::temp_dir().join(format!("rits-upd-test-{}", std::process::id()));
    let f = rits_lib::updater::fetch_verified(&i, &dir, &mut |_, _| {}).await.unwrap();
    assert!(std::fs::metadata(&f).unwrap().len() > 1_000_000);
    // a tampered checksum list is refused
    let mut bad = i.clone();
    bad.sums_url = "https://raw.githubusercontent.com/hugaojanuario/rits/main/README.md".into();
    assert!(rits_lib::updater::fetch_verified(&bad, &dir, &mut |_, _| {}).await.is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore]
async fn macos_replaces_bundle_and_clears_quarantine() {
    let mut i = rits_lib::updater::update_check().await.unwrap();
    i.available = true;
    let dir = std::env::temp_dir().join(format!("rits-upd-mac-{}", std::process::id()));
    let dmg = rits_lib::updater::fetch_verified(&i, &dir, &mut |_, _| {}).await.unwrap();
    // an "old" quarantined app in a temporary Applications folder
    let target = dir.join("Rits.app");
    std::fs::create_dir_all(target.join("Contents")).unwrap();
    std::fs::write(target.join("Contents/velho.txt"), "versão antiga").unwrap();
    std::process::Command::new("xattr").args(["-w", "com.apple.quarantine", "0081;00000000;Safari;", &target.to_string_lossy()]).status().unwrap();
    rits_lib::updater::install_dmg(&dmg, &target).await.unwrap();
    assert!(!target.join("Contents/velho.txt").exists());
    assert!(target.join("Contents/MacOS").exists());
    let q = std::process::Command::new("xattr").args(["-lr", &target.to_string_lossy()]).output().unwrap();
    assert!(!String::from_utf8_lossy(&q.stdout).contains("quarantine"));
    let _ = std::fs::remove_dir_all(&dir);
}
