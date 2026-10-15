// Exercises the generated plugin commands in Windows PowerShell without starting containers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";

assert.equal(process.platform, "win32", "Run this check on Windows.");
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Windows" }, configurable: true });
globalThis.document = { addEventListener() {} };

function powershell(script, expectedStatus = 0) {
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop'; " + script,
  ], { cwd: dir, encoding: "utf8", windowsHide: true, timeout: 20000 });
  assert.ifError(result.error);
  assert.equal(result.status, expectedStatus, result.stderr);
  return result.stdout.trim();
}

const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: { ignored: ["**/src-tauri/**"] } }, appType: "custom" });
const dir = mkdtempSync(path.join(tmpdir(), "rits-powershell-"));
const filename = "compose ação $dev 'teste' [1].yaml";
try {
  const { infraActions } = await server.ssrLoadModule("/src/ide/infra.ts");
  const { DOCKER_COMPONENTS, DockerTools } = await server.ssrLoadModule("/src/ide/docker.ts");
  const { host } = await server.ssrLoadModule("/src/ide/host.ts");
  let command;
  const wb = { show() {}, terminals: { newTab(_cwd, cmd) { command = cmd; } } };
  const file = path.join(dir, filename).replaceAll("\\", "/");
  const actions = infraActions(wb, file, "compose");
  actions.find((a) => a.label === "Status (ps)").action();
  const args = powershell("function docker { ConvertTo-Json -Compress -InputObject @($args) }; " + command);
  assert.deepEqual(JSON.parse(args), ["compose", "-f", filename, "ps"]);

  // The follow-up action must only run when the native command succeeds (PowerShell 5.1).
  actions.find((a) => a.label === "Validar (config)").action();
  const native = `Set-Alias docker '${process.execPath.replaceAll("'", "''")}'; Set-Location -LiteralPath '${dir.replaceAll("'", "''")}'; `;
  writeFileSync(path.join(dir, "compose"), "process.exit(0)");
  assert.match(powershell(native + command), /compose válido/);
  writeFileSync(path.join(dir, "compose"), "process.exit(1)");
  assert.equal(powershell(native + command, 1), "");

  writeFileSync(file, "# ação com acentos\nFROM python:3.13-slim\n", "utf8");
  infraActions(wb, file, "dockerfile").find((a) => a.label === "Analisar com hadolint").action();
  writeFileSync(path.join(dir, "run"), "process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => process.stdout.write(chunk))");
  const content = powershell(native + command);
  assert.equal(content.replaceAll("\r", ""), "# ação com acentos\nFROM python:3.13-slim");

  // Intercept the launcher: resolve the installed Desktop but leave it stopped.
  const launcher = DOCKER_COMPONENTS.find((c) => c.id === "engine").install();
  const script = launcher.args.at(-1);
  const installed = powershell("function Start-Process { param($FilePath, $WindowStyle); if ($WindowStyle -ne 'Hidden') { throw 'Expected hidden launch' }; [Console]::WriteLine($FilePath) }; " + script);
  assert.match(installed, /Docker Desktop\.exe$/);

  const originalCapture = host.capture;
  try {
    for (const failure of ["timeout", "exit"]) {
      host.capture = async (_program, args) => {
        if (args[0] === "version") return { code: 0, stdout: "29.0", stderr: "" };
        if (failure === "timeout") throw new Error("Docker list timeout");
        return { code: 1, stdout: "", stderr: "Docker list failed" };
      };
      const panel = { state: "loading", stopEvents() {}, render() { this.rendered = true; } };
      await DockerTools.prototype.refresh.call(panel);
      assert.equal(panel.state, "no-engine");
      assert.equal(panel.rendered, true);
      assert.match(panel.error, /Docker list/);
    }
  } finally { host.capture = originalCapture; }
  console.log("OK: PowerShell arguments, conditional execution, UTF-8, Docker discovery and list failure recovery.");
} finally {
  await server.close();
  rmSync(path.join(dir, filename), { force: true });
  rmSync(path.join(dir, "compose"), { force: true });
  rmSync(path.join(dir, "run"), { force: true });
  rmdirSync(dir);
}
