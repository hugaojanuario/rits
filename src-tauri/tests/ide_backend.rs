//! Backend tests for the code IDE: framing, UTF-8 streaming, file ops, and real
//! language server / debug adapter handshakes (ignored tests need the tools installed).
use rits_lib::fsx;
use rits_lib::procs::{read_rpc_messages, read_text_chunks, which};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;

fn frame(s: &str) -> Vec<u8> {
    format!("Content-Length: {}\r\n\r\n{}", s.len(), s).into_bytes()
}

#[tokio::test]
async fn rpc_framing_survives_split_writes() {
    let (mut w, r) = tokio::io::duplex(7); // tiny buffer forces many partial reads
    let msgs = vec![
        r#"{"jsonrpc":"2.0","id":1,"result":{"ok":"ção ✓"}}"#.to_string(),
        r#"{"jsonrpc":"2.0","method":"x","params":[]}"#.to_string(),
    ];
    let data: Vec<u8> = msgs.iter().flat_map(|m| frame(m)).collect();
    let writer = tokio::spawn(async move {
        for chunk in data.chunks(5) {
            w.write_all(chunk).await.unwrap();
        }
    });
    let mut got = vec![];
    read_rpc_messages(r, |m| got.push(m)).await;
    writer.await.unwrap();
    assert_eq!(got, msgs);
}

#[tokio::test]
async fn text_chunks_keep_multibyte_chars_intact() {
    let (mut w, r) = tokio::io::duplex(3);
    let text = "Olá, mundo — ação ✓ 日本".to_string();
    let bytes = text.clone().into_bytes();
    let writer = tokio::spawn(async move {
        for b in bytes.chunks(1) {
            w.write_all(b).await.unwrap();
        }
    });
    let mut out = String::new();
    read_text_chunks(r, |s| {
        assert!(!s.contains('\u{FFFD}'), "broken char in chunk {s:?}");
        out.push_str(&s);
    })
    .await;
    writer.await.unwrap();
    assert_eq!(out, text);
}

#[test]
fn file_ops() {
    let dir = std::env::temp_dir().join(format!("bg-fs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    std::fs::create_dir_all(dir.join("build")).unwrap();
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join(".gitignore"), "build/\n*.log\n").unwrap();
    std::fs::write(dir.join("a.log"), "x").unwrap();
    std::fs::write(dir.join("src/main.py"), "\u{FEFF}print('olá')\r\nx = 1\r\n").unwrap();
    std::fs::write(dir.join("bin.dat"), [0u8, 1, 2, 3]).unwrap();
    let root = dir.to_string_lossy().to_string();

    let list = fsx::list_dir(&root).unwrap();
    let names: Vec<_> = list.iter().map(|e| e.name.as_str()).collect();
    assert!(!names.contains(&".git"), "{names:?}");
    assert_eq!(names[0], "build"); // dirs first
    assert!(list.iter().find(|e| e.name == "build").unwrap().ignored);
    assert!(list.iter().find(|e| e.name == "a.log").unwrap().ignored);
    assert!(!list.iter().find(|e| e.name == "src").unwrap().ignored);

    let f = fsx::read_file(&dir.join("src/main.py").to_string_lossy()).unwrap();
    assert!(f.crlf && f.encoding == "UTF-8 BOM");
    assert_eq!(f.text, "print('olá')\nx = 1\n");
    fsx::write_file(&dir.join("src/main.py").to_string_lossy(), &f.text, true).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("src/main.py")).unwrap(), "print('olá')\r\nx = 1\r\n");
    assert!(fsx::read_file(&dir.join("bin.dat").to_string_lossy()).unwrap().binary);

    let hits = fsx::search(&root, r"x\s*=\s*\d", true, false, false, "*.py", 100).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!((hits[0].line, hits[0].col), (2, 1));
    let files = fsx::list_files(&root, 100);
    assert!(files.iter().any(|f| f.ends_with("src/main.py")));
    assert!(!files.iter().any(|f| f.ends_with("a.log")), "gitignored file listed: {files:?}");

    fsx::create(&dir.join("pkg/sub/new.go").to_string_lossy(), false).unwrap();
    assert!(fsx::create(&dir.join("pkg/sub/new.go").to_string_lossy(), false).is_err());
    let src = dir.join("src/main.py").to_string_lossy().to_string();
    let pkg = dir.join("pkg").to_string_lossy().to_string();
    assert!(fsx::copy_into(&src, &pkg).unwrap().ends_with("pkg/main.py"));
    assert!(fsx::copy_into(&src, &pkg).unwrap().ends_with("pkg/main_1.py"));
    let _ = std::fs::remove_dir_all(&dir);
}

/// Sends a request with id/seq 1 to a stdio server and returns the matching response.
async fn handshake(program: &str, args: &[&str], init: &str) -> String {
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap_or_else(|e| panic!("{program}: {e}"));
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(&frame(init)).await.unwrap();
    let out = child.stdout.take().unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(read_rpc_messages(out, move |m| {
        let _ = tx.send(m);
    }));
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let m = tokio::time::timeout_at(deadline, rx.recv()).await.expect("timeout").expect("eof");
        let compact = m.replace(": ", ":");
        if compact.contains("\"id\":1") || compact.contains("\"request_seq\":1") {
            let _ = child.kill().await;
            return m;
        }
    }
}

fn lsp_init(root: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"processId":null,"rootUri":"file:///{}","capabilities":{{}}}}}}"#,
        root.replace('\\', "/")
    )
}

#[tokio::test]
#[ignore]
async fn gopls_initializes() {
    let gopls = which("gopls", &[]).expect("gopls not installed");
    let r = handshake(&gopls, &["serve"], &lsp_init(&std::env::temp_dir().to_string_lossy())).await;
    assert!(r.contains("completionProvider") && r.contains("definitionProvider"), "{r}");
}

#[tokio::test]
#[ignore]
async fn basedpyright_initializes() {
    let venv = std::env::var("RITS_TEST_VENV").expect("RITS_TEST_VENV");
    let exe = format!("{venv}/Scripts/basedpyright-langserver.exe");
    let r = handshake(&exe, &["--stdio"], &lsp_init(&std::env::temp_dir().to_string_lossy())).await;
    assert!(r.contains("completionProvider") && r.contains("renameProvider"), "{r}");
}

#[tokio::test]
#[ignore]
async fn debugpy_adapter_initializes() {
    let venv = std::env::var("RITS_TEST_VENV").expect("RITS_TEST_VENV");
    let py = format!("{venv}/Scripts/python.exe");
    let r = handshake(
        &py,
        &["-m", "debugpy.adapter"],
        r#"{"seq":1,"type":"request","command":"initialize","arguments":{"adapterID":"debugpy","linesStartAt1":true,"columnsStartAt1":true,"pathFormat":"path"}}"#,
    )
    .await;
    assert!(r.contains("\"success\": true") || r.contains("\"success\":true"), "{r}");
}

#[tokio::test]
#[ignore]
async fn delve_dap_initializes_over_tcp() {
    let dlv = which("dlv", &[]).expect("dlv not installed");
    let port = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    let mut child = tokio::process::Command::new(&dlv)
        .args(["dap", &format!("--listen=127.0.0.1:{port}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stream = None;
    for _ in 0..100 {
        if let Ok(s) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            stream = Some(s);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let (r, mut w) = stream.expect("dlv did not listen").into_split();
    w.write_all(&frame(r#"{"seq":1,"type":"request","command":"initialize","arguments":{"adapterID":"go","linesStartAt1":true,"columnsStartAt1":true,"pathFormat":"path"}}"#))
        .await
        .unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(read_rpc_messages(r, move |m| {
        let _ = tx.send(m);
    }));
    let m = tokio::time::timeout(std::time::Duration::from_secs(20), rx.recv()).await.unwrap().unwrap();
    let _ = child.kill().await;
    assert!(m.contains("\"success\":true"), "{m}");
}
