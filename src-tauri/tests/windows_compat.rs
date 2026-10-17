//! Windows integration checks for tools installed by the new optional plugins.
#![cfg(windows)]

use rits_lib::airflow::secrets::{OsStore, SecretStore};
use rits_lib::procs::{capture, default_tool_dirs, which};
use std::path::PathBuf;

#[test]
fn plugin_tool_directories() {
    let dirs = default_tool_dirs();
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA"));
    let roaming = PathBuf::from(std::env::var_os("APPDATA").expect("APPDATA"));
    for dir in [
        roaming.join("npm"),
        local.join("Microsoft/WinGet/Links"),
        local.join("Microsoft/WindowsApps"),
        local.join("Programs/DockerDesktop/resources/bin"),
    ] {
        assert!(dirs.contains(&dir), "tool directory missing: {}", dir.display());
    }
}

#[tokio::test]
async fn npm_style_launcher_preserves_arguments() {
    let dir = std::env::temp_dir().join(format!("rits-windows-{} ação", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let node = which("node", &[]).expect("Node.js (development prerequisite)");
    std::fs::write(dir.join("args.cjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))").unwrap();
    std::fs::write(dir.join("server.cmd"), format!("@\"{node}\" \"%~dp0args.cjs\" %*\r\n")).unwrap();
    let args = vec!["--stdio".into(), "D:/projeto com espaços/dag's $dev.yaml".into()];
    let result = capture(&dir.join("server.cmd").to_string_lossy(), &args, "", None, 20).await;
    let _ = std::fs::remove_file(dir.join("server.cmd"));
    let _ = std::fs::remove_file(dir.join("args.cjs"));
    let _ = std::fs::remove_dir(&dir);
    let result = result.unwrap();
    assert_eq!(result.code, Some(0), "{}", result.stderr);
    assert_eq!(serde_json::from_str::<Vec<String>>(&result.stdout).unwrap(), args);
}

/// The AI assistant runs `claude.cmd`/`codex.cmd`/`npx.cmd` (npm launchers) with these argument
/// shapes; the user's text goes through stdin, never the command line.
#[tokio::test]
async fn assistant_cli_arguments_through_npm_launcher() {
    let dir = std::env::temp_dir().join(format!("rits-ai-{} ação", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let node = which("node", &[]).expect("Node.js (development prerequisite)");
    std::fs::write(
        dir.join("echo.cjs"),
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:s})))",
    )
    .unwrap();
    std::fs::write(dir.join("agent.cmd"), format!("@\"{node}\" \"%~dp0echo.cjs\" %*\r\n")).unwrap();
    let args: Vec<String> = vec![
        "-p".into(),
        "--mcp-config".into(),
        "C:/Users/José Silva/AppData/Local/dev.rits.ide/assistant/mcp-c1.json".into(),
        "--append-system-prompt".into(),
        "Você está dentro da IDE Rits (engenharia de dados: Python, Go, bancos). O projeto aberto é C:/Projetos/dag's $dev. Use db_query (somente leitura); para Airflow, dbt e Docker use as ferramentas.".into(),
        "--allowedTools=mcp__rits__ide_context,mcp__rits__db_query,mcp__rits__airflow_runs".into(),
        "-c".into(),
        "mcp_servers.rits.url=http://127.0.0.1:51234/mcp".into(),
        "-c".into(),
        "mcp_servers.rits.bearer_token_env_var=RITS_MCP_TOKEN".into(),
        "-c".into(),
        "sandbox_mode=workspace-write".into(),
        "-".into(),
    ];
    let prompt = "Explique \"isto\" & aquilo | 100% <ok>\nsegunda linha com ação";
    let result = capture(&dir.join("agent.cmd").to_string_lossy(), &args, "", Some(prompt.to_string()), 20).await;
    let _ = std::fs::remove_dir_all(&dir);
    let result = result.unwrap();
    assert_eq!(result.code, Some(0), "{}", result.stderr);
    let v: serde_json::Value = serde_json::from_str(&result.stdout).unwrap();
    assert_eq!(serde_json::from_value::<Vec<String>>(v["args"].clone()).unwrap(), args);
    assert_eq!(v["stdin"], prompt);
}

#[test]
#[ignore = "uses the current user's Windows Credential Manager"]
fn airflow_windows_credential_round_trip() {
    let key = format!("airflow:windows-test-{}", std::process::id());
    let value = "senha de teste com ação e espaços";
    OsStore.set(&key, value).unwrap();
    let read = OsStore.get(&key);
    let deleted = OsStore.delete(&key);
    assert_eq!(read.unwrap().as_deref(), Some(value));
    deleted.unwrap();
    assert_eq!(OsStore.get(&key).unwrap(), None);
}
