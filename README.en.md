<p align="center">
  <img src="assets/logo.svg" alt="Rits" width="128" height="128">
</p>

<h1 align="center">Rits</h1>

<p align="center">
  <b>The lightweight IDE for data engineering.</b><br>
  Python and Go code, SQL on nine databases (and compatibles), ER diagrams, Docker, Terraform and Kubernetes, in a single window.
</p>

<p align="center">
  <a href="README.md">Português</a> · <b>English</b>
</p>

<p align="center">
  <a href="https://github.com/hugaojanuario/rits/releases/latest/download/Rits-windows-x64-setup.exe">Download Windows x64</a> ·
  <a href="https://github.com/hugaojanuario/rits/releases/latest/download/Rits-macos-arm64.dmg">Download macOS Apple Silicon</a> ·
  <a href="https://github.com/hugaojanuario/rits/releases/latest">Releases</a>
</p>

---

## What is Rits

A data engineering workday usually spans several tools: PyCharm for the Python pipeline, DataGrip or DBeaver to query the database, Docker Desktop to run a local Postgres, one terminal for `terraform plan` and another for `kubectl`.

**Rits** brings that workflow into one fast, lightweight desktop IDE:

- **Write the pipeline** in Python or Go, with completion that actually works, a debugger, tests and Git.
- **Query and explore data** in PostgreSQL, MySQL, SQL Server, Oracle, ClickHouse, DuckDB, SQLite, Firebird, MongoDB and compatibles (CockroachDB, Supabase, Redshift…).
- **Understand the model** with ER diagrams generated from the database: relations, keys and automatic layout.
- **Run the infrastructure** with Docker, Compose, Terraform and Kubernetes straight from the editor.
- **Explore and transform** in Jupyter notebooks and dbt projects, and **audit data migrations** between databases (optional plugins).

All with Rits' own look (the *Blocos* layout: tabs in the title bar, panels as cards and a start page for each project) and, on macOS, native **Liquid Glass**.

> **Actually lightweight:** Rits uses the system WebView (Tauri 2), with no bundled Chromium. The app is about **7 MB**, and database drivers are only downloaded when you use that database.

The user interface is in Brazilian Portuguese.

## Who it is for

- **Data engineers** writing ETL/ELT in Python or Go who spend the day between code and SQL.
- **Analytics engineers** exploring schemas, comparing databases and needing to see the data model.
- **Data platform teams** keeping infrastructure (Postgres in Docker, Terraform, Kubernetes manifests) next to the code.

## Highlights

### Databases

| Database | Driver |
|---|---|
| PostgreSQL, MySQL / MariaDB | built into the app |
| SQL Server, Oracle, Firebird, SQLite, DuckDB, ClickHouse, MongoDB | downloaded on first connection* |
| CockroachDB, TimescaleDB, Supabase / Neon, TiDB, Amazon Redshift | presets of the drivers above |

<sub>* Like DataGrip and DBeaver, the driver is downloaded the first time you test or save a connection to that database, and only once. Drivers run in a private Python environment owned by Rits, so **Python 3.9+** must be installed.</sub>

- **Explorer**: connections → databases → schemas → tables, views, functions, sequences and triggers.
- **SQL console** with table/column completion, multiple statements per run, manual transactions, query cancellation, EXPLAIN and history.
- **Data editor**: paged, with filter and sort, inline editing, a preview of the generated SQL and transactional saves.
- **ER diagram**: table cards with PK/FK and types, links with cardinality, automatic layout, minimap, search, pan/zoom (trackpad pinch), **SVG** export and copy as **Mermaid**.
- **MongoDB** with `mongosh`-style commands (`db.orders.find({status: "paid"}).limit(20)`) and inferred relations in the diagram.
- **DDL**, export (CSV, TSV, JSON, SQL, Markdown, HTML) and **backup/restore** with `pg_dump`/`pg_restore`/`mysqldump`.
- **Per-project connections**: a connection only shows up in the project where it was created, unless you mark it as global.

### Code

- **Python** (basedpyright, Ruff, debugpy, pytest) and **Go** (gopls, Delve, staticcheck), installed with one click in Settings › Plugins.
- **JetBrains-style completion**: language-server relevance, documentation beside the list, **auto-import** on accept, Tab or Enter. Tab accepts the selected suggestion in code and SQL editors; without a suggestion, it keeps indenting. Toggle it in Settings › Editor.
- Go to definition, find usages, rename, quick fixes, reformat and optimize imports.
- Run and debug with breakpoints, variables, stepping and a console; ▶ in the gutter for `main` and tests.
- Full **Git**: commit, push/pull, branches, log, side-by-side diff.
- A real terminal (PTY) with the project venv activated.

### Apache Airflow (plugin)

- Native connection to the **Airflow 3 public API** (`/api/v2`): no embedded web panel or scraping. Several local or remote instances, with connection test and version detection.
- **DAGs** with search, tag and state filters, pause/resume, and trigger with JSON config.
- **Runs**: history, task graph colored by state, **live logs** per try, and task re-run that shows what will be affected first.
- DAG **import errors**, with a shortcut to the local file.
- **One-click local environment with Docker**: Airflow 3.3.2 with Postgres, port on localhost only, user with a random password, registered in the IDE automatically. **Development only**.
- **Project ↔ Airflow**: new DAG from a template, DAG folder mounted in the local environment or published through your Git workflow, and a notice when Airflow has processed the saved file.
- **DAG autocomplete**: the IDE offers to install `apache-airflow-task-sdk` (the Airflow 3.3.2 version) into the project interpreter, preferably a `.venv`, so the editor knows `airflow.sdk`.
- Passwords and tokens live in the **OS secret store** (Keychain / Credential Manager); calls go through the IDE backend with TLS verification.

Limitations: requires Airflow 3 (Airflow 2 is detected and rejected); the local environment needs Docker with about 4 GB of RAM and downloads ~3.2 GB of images the first time; the official web UI opens in a separate window or in the browser.

### Jupyter (plugin)

- `.ipynb` notebooks (nbformat 4) in the **IDE's own editor**: Python and Markdown cells, run cell, run from here and run all, keeping execution counters and output order. Unknown cells, metadata and outputs are preserved on save.
- Outputs: text, tables (pandas), images and charts (matplotlib), errors with colored tracebacks. HTML and JavaScript from **untrusted** notebooks never run; trusted active outputs run isolated in an iframe with no access to the IDE.
- **Kernel**: server and kernel selection, state (idle/busy), interrupt and restart (warning that variables are lost). On reconnect the IDE queries the real state and **never re-runs cells**.
- **Servers**: local or remote Jupyter Server with a token (stored in Keychain / Credential Manager), connection test, server files and running kernels. Or a **local JupyterLab on Docker** with a pinned image (`quay.io/jupyter/scipy-notebook:2026-10-12`, JupyterLab 4.6.4), the project mounted at `/home/jovyan/work`, port on `127.0.0.1` only and a random token.
- Autocomplete comes from the **kernel itself** (the server's environment, which may differ from the IDE's Python); with Ruff installed, syntax errors and undefined names show up in cells.
- **Open in JupyterLab** (separate window or browser) as a complement.

Validated with Jupyter Server 2.21.1 / JupyterLab 4.6.4. Limitations: interactive widgets (ipywidgets) and LaTeX in Markdown are not rendered (use JupyterLab); Jupyter password login is not supported (use a token); disabling the plugin closes the IDE's connections but never stops servers or kernels.

### dbt (plugin)

- Detects projects by `dbt_project.yml` and creates new ones with the official `dbt init`.
- Runs **dbt Core** from a project Python environment or the official Docker image (`ghcr.io/dbt-labs/dbt-postgres:1.9.0`). **Nothing is installed globally**; an explicit button installs dbt into the project's `.venv`.
- `debug`, `deps`, `parse`, `compile`, `run`, `test`, `build`, `docs generate` and the docs viewer, with selection (model, `+model+`, `tag:`, `path:`…), exclusion, target, `--vars`, threads and an explicit `--full-refresh`.
- Before commands that change the database, the IDE shows the **target and scope** (through `dbt ls`) and the full refresh impact. Commands use structured arguments (no shell), one at a time per project, with live logs, per-node state, duration, exit code and cancellation.
- **Managed PostgreSQL profiles**: `profiles.yml` lives in the Rits config folder, outside the repository, with no passwords — they come from the OS secret store or a Rits PostgreSQL connection and are passed as environment variables only during the run. Project environment variables (`env_var()`) can be secret too. Other adapters work with your own `profiles.yml`.
- Reads `manifest.json` and `run_results.json` (schema version checks, stale-result warnings), lists failures that open their files, lineage, compiled SQL, `ref()`/`source()` navigation with Ctrl/⌘+click, Jinja highlighting and file templates (model, sources, tests, unit test, seed, snapshot).

Validated with dbt Core 1.12.6 and dbt-postgres 1.11.0 (manifest v12, run_results v6). dbt v2 is detected and flagged but not validated. The dependency graph is not a scheduler: periodic runs belong to Airflow or another orchestrator.

### Migration Audit (plugin)

Audits **data conversions** between a source and a target database with **deterministic** logic (SQL, metadata, explicit rules and evidence comparison — no AI). It audits only: it never runs or fixes the conversion and never writes to the audited databases.

- Flow: project → scope → structural discovery → mapping (suggestions with their criteria, used only after confirmation) → **immutable source baseline** → external conversion → **reconciliation** → report. Each reconciliation is a new run; history is kept.
- Comparison per **reconciliation unit** (never by the global total), with separate dimensions: **volume, identity, fields and relationships**. Results: compatible within the verified scope, divergent, inconclusive or not verified.
- Identity by preserved, business or composite key, **ID map** (`source_id → target_id`) or content. Finds missing, extra and duplicated records, multiplicity, null keys, collisions introduced by normalization and map problems.
- Fields: tells apart unmapped fields, **lost values**, created values and divergent values; explicit rules (trim, case, Unicode, empty = null, text dates, fixed time zones, precision, scale, tolerance, JSON, booleans, value maps). Nothing is normalized by default, NULL is never zero and decimals never go through floating point.
- Relationships: orphans and **preservation of the original association** (a valid FK may point to the wrong entity).
- Baseline with a JSON manifest and digest, sorted evidence on disk (external sort, bounded memory) with SHA-256; missing, truncated or modified files are detected. Consistent snapshots when the database allows.
- Browsable report (unit → kind → paginated identities, sensitive values masked) and exports: self-contained HTML report, JSON manifest, CSV summary and full CSV lists (protected against spreadsheet formulas).

Databases: PostgreSQL, MySQL, MariaDB, SQL Server and Firebird — all validated by real integration tests (PostgreSQL 17, MySQL 8.4, MariaDB 11.8, SQL Server 2022, Firebird 5). Limitations: MongoDB is out of this version; on SQL Server custom queries do not run in a read-only transaction (use a read-only login) and snapshots need `ALLOW_SNAPSHOT_ISOLATION`; time zones with daylight saving are not supported in rules (fixed offsets only); 1:N and N:1 relations need datasets normalized by queries for a complete comparison.

### AI assistant: Claude Code and Codex (plugin)

A **chat inside the IDE** with your own Claude Code or Codex, like the official VS Code extensions, but with the context of everything open in Rits.

- Uses the **official CLI and your account** (subscription or API key). Rits has no server of its own: nothing goes through it.
- The agent sees the IDE through a **local MCP server** (`127.0.0.1`, one token per chat): project, active file, selection and unsaved changes, LSP problems, Git, **connected databases** (structure and queries in a read-only transaction), **Airflow DAGs, runs and logs**, **dbt** results, **notebook** cells, **Docker** containers and **Migration Audit** runs. Passwords and tokens are never handed over.
- Streaming answers, a card for each tool used, code blocks with **Copy** and **Insert at cursor**, active file and selection attached with one click.
- Permissions: read-only, **edit with approval** (each Claude Code edit or command shows up in the chat with the diff and Allow/Deny buttons) or edit automatically. Each project's chat resumes where it stopped.

Full guide (Portuguese): [docs/assistente-ia.md](docs/assistente-ia.md).

### Infrastructure

- **Docker**: container manager (optional plugin), with containers grouped by Compose project, start/stop/restart, logs, shell into the container, live CPU and memory, images and volumes.
- **Docker Compose, Dockerfile, Terraform and Kubernetes**: highlighting, completion and schema validation, plus an action bar at the top of the file (`compose up/down/logs`, `terraform plan/apply/validate`, `kubectl apply/diff`, `docker build`).
- **Templates** under New › Dockerfile, Compose, Terraform and Kubernetes.

### Experience

- **Blocos** layout: file tabs in the title bar, panels as cards with a tool window switcher, buttons to show or hide each panel, and a quiet status bar.
- **Project start page**: shortcuts, what was found in the project (Compose, Dockerfile, Terraform, tests) with the right action for each, Run, and a command bar that searches everything or runs a command in the terminal (Tab switches).
- Tool windows move between the left, right and bottom panels from the ⋮ menu.
- **VS Code** (default on macOS) and **JetBrains** keymaps, with shortcuts shown as ⌘⌥⇧ on the Mac.
- Rits Dark and Rits Light themes, with the brand lilac as the accent, and **Liquid Glass** on macOS 26 (vibrancy on earlier versions).

## Installation

### macOS (Apple Silicon)

The simplest way is one line in the Terminal: it downloads the latest version, installs it in Applications and clears the quarantine.

```bash
curl -fsSL https://raw.githubusercontent.com/hugaojanuario/rits/main/scripts/install-macos.sh | bash
```

Or [download the DMG for Apple Silicon](https://github.com/hugaojanuario/rits/releases/latest/download/Rits-macos-arm64.dmg), drag Rits to Applications and run in the Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Rits.app
```

Rits is ad-hoc signed and not notarized by Apple; without that command macOS keeps the app quarantined (warnings on launch and execution from a temporary copy, which prevents updates). If you forget, the IDE itself tells you and offers to copy the command. Updates installed by Rits clear the quarantine automatically.

Language and database tools come from Homebrew:

```bash
brew install python go libpq mysql-client
```

### Windows 11

[Download the Windows x64 installer](https://github.com/hugaojanuario/rits/releases/latest/download/Rits-windows-x64-setup.exe) and run it. WebView2 is installed automatically if needed. The [release page](https://github.com/hugaojanuario/rits/releases/latest) also includes `SHA256SUMS.txt` to verify downloads.

Plugins also find tools in the standard npm and WinGet folders, including tools installed after opening the IDE. Docker Desktop may be installed for the current user or in Program Files. Infrastructure actions work in PowerShell 5.1 and 7, including filenames with spaces and special characters. Liquid Glass is exclusive to macOS; Windows uses Rits Dark or Rits Light.

## Getting started

1. **Open a folder** or create a project (Python with `.venv`, Go with `go mod init`, or empty).
2. **Install the plugins** you need in Settings › Plugins: Python, Go, Infrastructure (IaC), Docker, Apache Airflow, Jupyter, dbt or Migration Audit.
3. **Connect a database**: open the Database window (Alt+2, or ⌥2 on the Mac), click **+**, pick the database and fill in the connection.
4. **See the model**: right-click the schema › **Diagrama ER**.
5. **Bring up the infra**: create a `compose.yaml` via New › docker-compose.yml and click **Subir** (up) in the editor bar.

## Main shortcuts

| Action | VS Code (Mac default) | JetBrains |
|---|---|---|
| Command palette | ⌘⇧P | Ctrl+Shift+A |
| Open file | ⌘P | Ctrl+Shift+N |
| Toggle sidebar / panel | ⌘B / ⌘J | Alt+1 (Project) / Shift+Esc (hide) |
| Terminal | ⌃` | Alt+F12 |
| Go to definition / usages | F12 / ⇧F12 | Ctrl+B / Alt+F7 |
| Rename | F2 | Shift+F6 |
| Debug / run | F5 / ⌃F5 | Shift+F9 / Shift+F10 |

Switch the scheme in Settings › Keymap, which also lists every shortcut.

## Architecture

| Layer | Technology |
|---|---|
| Window / runtime | Tauri 2 (WebView2 on Windows, WKWebView on macOS) |
| Backend | Rust: `tokio-postgres`, `mysql_async`, `portable-pty`, `notify`, `ignore` |
| On-demand drivers | private Python process (`python-tds`, `oracledb`, `firebirdsql`, `duckdb`, `clickhouse-connect`, `pymongo`) |
| Frontend | framework-free TypeScript + Vite, CodeMirror 6, xterm.js |
| Languages | LSP servers and DAP adapters (basedpyright, gopls, terraform-ls, yaml-language-server, debugpy, Delve) |

The backend is generic: files, processes (LSP/DAP over JSON-RPC), terminals and databases. The IDE logic lives in the frontend (`src/ide/`). The complete contributor guide is **[AGENTS.md](AGENTS.md)** (in Portuguese).

## Development

Requirements: Node 22+, stable Rust and, on Windows, Visual Studio Build Tools (C++). On macOS, the Xcode Command Line Tools.

```bash
npm install
npm run tauri dev       # development mode with hot reload
npm run tauri build     # release app (.app/.dmg on macOS, NSIS installer on Windows)
npx tsc --noEmit -p .   # type check
cd src-tauri && cargo test
```

Integration tests (`cargo test -- --ignored`) use Postgres and MySQL in Docker plus the language tools; the steps are in [AGENTS.md](AGENTS.md#3-como-rodar-compilar-e-testar).

## Data and privacy

- Connections are stored in `connections.json` in the app config folder (`~/Library/Application Support/dev.rits.ide` on macOS, `%APPDATA%\dev.rits.ide` on Windows). **Passwords are still stored in plain text**; Keychain / Credential Manager integration is pending.
- Downloaded drivers live in `drivers/` in the same folder and can be deleted at any time (they are downloaded again when needed).
- Jupyter tokens, dbt profile passwords and Airflow secrets live in the OS secret store. Migration Audit projects, baselines and evidence live in `migration-audit/` in the config folder (outside repositories) and may contain data from the audited tables; delete them from the plugin.
- Rits sends no telemetry.

## Credits and license

- Code under the [MIT](LICENSE) license.
- Icons in `src/assets/icons` and the editor syntax colors come from [IntelliJ Community](https://github.com/JetBrains/intellij-community) (Apache 2.0; see `src/assets/icons/LICENSE-intellij-community.txt`). The Rits name, logo and remaining icons are original. No code or assets from commercial JetBrains products were used.
- Docker, PostgreSQL, MySQL, SQL Server, Oracle, MongoDB, Terraform and Kubernetes are trademarks of their respective owners; the icons are simplified drawings that identify each integration.
- Figtree and JetBrains Mono fonts (SIL Open Font License).
