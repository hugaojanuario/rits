# AGENTS.md — guia para quem (humano ou IA) for programar no Rits

Este arquivo explica **o que é o projeto, como ele está organizado, como rodar, testar e mudar cada parte** sem quebrar nada. Leia inteiro antes da primeira alteração. Quando mudar algo estrutural (um módulo novo, um comando Tauri novo, uma convenção), **atualize este arquivo no mesmo commit**.

---

## 1. O que é o Rits

Rits é uma IDE desktop leve **para engenharia de dados**: **Python**, **Go**, **bancos de dados**, infraestrutura (Docker, Terraform, Kubernetes) e orquestração (Apache Airflow, como plugin). Roda no Windows 11 e no macOS (Apple Silicon). Veja a seção 3.1 para o que muda no macOS.

- **Visual**: layout próprio **Blocos** (temas Rits Escuro/Claro): barra de título com o logo (menu principal), as abas do editor, o widget de execução e botões de layout; tool windows em **cartões** arredondados (esquerdo, direito e inferior) com um seletor segmentado; uma aba fixa "Início" com a tela de início do projeto e a barra de comando; barra de status discreta. O acento é o lilás do logo (`#A08CFF`; `#6B55E0` no tema claro).
- **Código**: editor CodeMirror 6 com servidores de linguagem (LSP), execução, testes, depuração (DAP), terminal real (PTY), Git e navegação no estilo IntelliJ.
- **Banco de dados**: explorador de conexões, console SQL, editor de dados, DDL, diagrama ER, exportação e backup/restore com as ferramentas nativas (`pg_dump`, `pg_restore`, `psql`, `mysqldump`, `mysql`), no estilo do DBeaver. PostgreSQL e MySQL/MariaDB têm driver embutido; SQL Server, Oracle, Firebird, SQLite, DuckDB, ClickHouse e MongoDB baixam o driver na primeira conexão (seção 5.7).
- **Leve**: Tauri 2 com o WebView do sistema (WebView2 no Windows, WKWebView no macOS), sem Chromium embutido. O instalador NSIS tem cerca de 3,5 MB, o exe cerca de 7 MB, o `Rits.app` cerca de 7,6 MB, e o processo principal usa cerca de 30 MB de RAM.
- **Plugins opcionais**: Docker, Apache Airflow, Jupyter, dbt e Migration Audit são ativados em Configurações › Plugins. Desativados, não carregam código nem fazem requisições (Airflow, Jupyter, dbt e Migration Audit ficam em chunks carregados por `import()`).

A interface é **inteiramente em português (pt-BR)**. Mantenha todos os textos visíveis ao usuário em pt-BR, e comentários de código e identificadores em inglês, como no resto do código.

### Restrições legais (importante)
- Os ícones em `src/assets/icons/` e as cores de sintaxe (`--syn-*`) vêm do **IntelliJ Community** (Apache 2.0). Mantenha `LICENSE-intellij-community.txt` e `NOTICE-intellij-community.txt` nessa pasta. Para ícones novos, use **somente** os do repositório `JetBrains/intellij-community` (pasta `platform/icons/src/expui` e afins) ou desenhe um próprio no mesmo estilo.
- **Nunca** copie código, binários, ícones de produto ou logos do DataGrip, PyCharm, GoLand ou de outros produtos JetBrains (são proprietários e marcas registradas). O nome e o logo do Rits são próprios: não imite o estilo de logo dos produtos JetBrains (quadrado preto com letras sobre degradê).
- Fontes: Figtree (interface) e JetBrains Mono (código), SIL OFL, via `@fontsource`.

---

## 2. Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Tauri 2 (janela **sem moldura**: `decorations: false`; a barra de título é desenhada pelo app) |
| Backend | Rust 2021: `tokio`, `tokio-postgres` (+ `postgres-native-tls`), `mysql_async`, `portable-pty` (ConPTY), `notify`, `ignore`, `regex`, `trash`, `encoding_rs`, `reqwest` (`native-tls`, clientes do Airflow e do Jupyter), `keyring` (cofre do sistema), `getrandom`/`base64` (segredos), `tokio-tungstenite` (WebSocket dos kernels Jupyter), `sha2` e `unicode-normalization` (Migration Audit) |
| Frontend | TypeScript **sem framework** (nada de React/Vue), Vite, DOM puro com o helper `h()` |
| Editor | CodeMirror 6 (`@codemirror/*`), `@codemirror/lsp-client`, `@codemirror/merge` (diff), `@codemirror/legacy-modes` |
| Notebooks | `marked` (Markdown) + `DOMPurify` (sanitização), só no chunk do plugin Jupyter |
| Terminal | `@xterm/xterm` + `@xterm/addon-fit` |
| Linguagens (instaladas pelo usuário via Plugins) | Python: basedpyright, Ruff, debugpy, pytest · Go: gopls, Delve (`dlv`), staticcheck |

---

## 3. Como rodar, compilar e testar

Pré-requisitos (Windows): Node 22+ (o projeto usa Node 24), Rust stable (`rustup`), Visual Studio Build Tools com C++ (MSVC) e WebView2 (já vem no Windows 11). Para os recursos de linguagem, Python 3.11+ e Go 1.23+.

```bash
npm install
npm run tauri dev          # Vite em :1420 + app em modo debug, com hot reload
npm run tauri build        # release: src-tauri/target/release/rits.exe e o instalador NSIS
npx tsc --noEmit -p .      # checagem de tipos do frontend (rode antes de todo commit)
cd src-tauri && cargo test # testes rápidos do backend
```

O `cargo` fica em `%USERPROFILE%\.cargo\bin`. No Git Bash, se ele não estiver no PATH, rode `export PATH="$HOME/.cargo/bin:$PATH"`.

No Windows, a busca de ferramentas e o PATH dos processos incluem também `%APPDATA%\npm`, os links do WinGet, WindowsApps e as pastas padrão do Node.js e Docker Desktop (instalação por usuário ou em Program Files). O botão de iniciar Docker Desktop procura as duas instalações e usa `Start-Process`, sem esperar o aplicativo terminar. Os comandos de infraestrutura enviados ao terminal usam aspas literais do PowerShell, inclusive para nomes com espaços, apóstrofos ou `$`.

Depois de usar a CLI Tauri no Windows, confira o diff de `Cargo.toml`: ela pode remover `macos-private-api` também da dependência específica do macOS. Preserve essa feature no bloco `target.'cfg(target_os = "macos")'.dependencies`, para manter o suporte ao Liquid Glass no Mac.

`node dev/windows-smoke.mjs` valida os comandos gerados no PowerShell 5.1 (argumentos literais, execução condicional, leitura UTF-8 e localização do Docker Desktop) e a recuperação do painel após erro ou timeout na listagem, sem iniciar containers. Requer Windows com Docker Desktop instalado. Para testar o cofre real: `cd src-tauri` e `cargo test --test windows_compat -- --ignored`.

### 3.1 macOS (Apple Silicon)
Pré-requisitos: Xcode Command Line Tools, Rust e Node (Homebrew serve). `npm run tauri build` gera `bundle/macos/Rits.app` e `bundle/dmg/Rits_<versão>_aarch64.dmg` com assinatura ad-hoc (`signingIdentity: "-"`), sem notarização.

O que é específico do macOS:
- **`src-tauri/tauri.macos.conf.json`** é mesclado pelo Tauri sobre o `tauri.conf.json`. Ele troca o alvo para `app`/`dmg` e usa a janela **com** decorações e `titleBarStyle: Overlay`: os botões nativos (semáforo) ficam sobre a barra do app. O `main.ts` põe a classe `mac` no `<html>`, que esconde os `.win-controls` e reserva 78 px à esquerda da `.main-toolbar`. Ao mudar a janela principal, mude **os dois** arquivos (no merge, o array `windows` é substituído inteiro), e também o `openProjectWindow()`.
- **PATH de app gráfico**: no macOS, apps abertos pelo Finder recebem um PATH mínimo. `procs::adopt_login_shell_path()` lê o PATH do shell de login (`$SHELL -ilc`, timeout de 3 s) ao iniciar. `default_tool_dirs()` ainda acrescenta `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/local/go/bin`, `~/.pyenv/shims` e afins.
- **Processos**: no Unix, `hidden()` põe cada filho no próprio grupo (`process_group(0)`), e `kill_tree` mata o grupo (`kill -9 -- -<pid>`).
- **Frontend**: `IS_WIN`/`IS_MAC`/`EXE`/`INSTALL`/`REVEAL_LABEL` em `host.ts`. `P.win()` só converte para `\` no Windows (no resto devolve o caminho igual), então continue usando-o para caminhos passados a processos. Use `P.isAbs()` em vez de testar `C:/`. O venv usa `bin/python` (e `scriptsDir()` é a própria pasta `bin`).
- **Atalhos**: os atalhos globais aceitam Ctrl **ou** Cmd, e o keymap do editor usa `Mod-` (Cmd no macOS). Os rótulos dos menus ainda mostram "Ctrl".
- **Liquid Glass**: a janela é transparente (`transparent`, `macOSPrivateApi` e a feature `macos-private-api` do `tauri`, só no alvo macOS no `Cargo.toml`) e usa `windowEffects` `liquidGlassRegular` (macOS 26), com fallback para `underWindowBackground`. Com a classe `glass` no `<html>` (padrão no Mac; interruptor em Configurações › Aparência; `localStorage` `glass`), a seção "Liquid Glass" no fim do `styles.css` redefine os tokens com cores translúcidas: superfícies de "frame" transparentes, cartões com `--rim`/`--sheen` e popups com `backdrop-filter`. Rótulos e separadores seguem as cores de sistema da Apple; o acento é o mesmo lilás dos temas opacos, e o texto sobre ele usa `--on-accent`. O `setTheme()` do `main.ts` também chama `getCurrentWindow().setTheme()` para o vidro nativo acompanhar o tema (permissão `core:window:allow-set-theme`). Componente novo: use os tokens e confira com o vidro ligado e desligado.
- **Banco**: `tools.rs` procura `pg_dump`/`mysqldump` em `/opt/homebrew/opt/{postgresql@*,libpq,mysql*,mariadb*}/bin`, no Postgres.app e em `/Library/PostgreSQL`.

### Releases no GitHub
A versão deve coincidir em `package.json`, nas duas entradas do `package-lock.json`, em `src-tauri/Cargo.toml`, no pacote `rits` do `Cargo.lock` e no `tauri.conf.json`. Depois de commitar na `main`, crie e envie uma tag `v<versão>` (ex.: `git tag -a v0.3.0 -m "Rits 0.3.0"` e `git push origin main v0.3.0`).

`.github/workflows/release.yml` valida a tag com `scripts/release.mjs validate`, exige que o commit pertença à `main`, roda o build TypeScript e os testes Rust e gera instaladores em runners nativos Windows x64 e macOS Apple Silicon. `scripts/release.mjs collect` copia os bundles para os nomes estáveis `Rits-windows-x64-setup.exe` e `Rits-macos-arm64.dmg`. Somente depois de ambos passarem, o job de publicação envia os arquivos e `SHA256SUMS.txt` para um rascunho e publica a release. O token recebe escrita apenas nesse job. Os READMEs usam os links `releases/latest/download/<nome>`.

As notas ficam em `.github/release-notes.md`: atualize para cada versão. Para repetir uma execução que falhou, use Re-run jobs ou o `workflow_dispatch` com a mesma tag existente; uma release já publicada não é sobrescrita. O Mac continua com assinatura ad-hoc, sem notarização. Saídas locais de staging ficam em `release-assets/` (ignorado pelo Git).

No CI, execute o Tauri CLI antes dos testes Cargo: o `tauri-build` confere as features da dependência comum, e o CLI sincroniza `macos-private-api` com a configuração da plataforma. Os testes rodam depois do empacotamento e antes do upload/publicação. O teste de comandos Windows usa `shell: powershell`, preparando o PowerShell 5.1 antes dos subprocessos com timeout. Como o runner não tem Docker Desktop, esse passo cria um arquivo fictício em `RUNNER_TEMP` e aponta seu `LOCALAPPDATA` para a fixture; o teste intercepta `Start-Process`, sem executar esse arquivo. As etapas seguintes recebem o ambiente original.

### Testes de integração (`--ignored`)
Ficam em `src-tauri/tests/` e precisam de infraestrutura:

```bash
docker run -d --name rits-pg -e POSTGRES_PASSWORD=bgtest -p 55432:5432 postgres:17
docker run -d --name rits-my -e MYSQL_ROOT_PASSWORD=bgtest -e MYSQL_DATABASE=loja -p 33306:3306 mysql:8.4
docker exec -i rits-pg psql -U postgres -v ON_ERROR_STOP=1 < src-tauri/tests/fixtures/seed_pg.sql
docker exec -i rits-my mysql -uroot -pbgtest --default-character-set=utf8mb4 loja < src-tauri/tests/fixtures/seed_mysql.sql
export RITS_TEST_VENV="C:/caminho/para/um/.venv"   # venv com basedpyright, debugpy
cd src-tauri && cargo test -- --ignored --test-threads=1
```

| Arquivo | O que cobre |
|---|---|
| `tests/db_integration.rs` | metadados, DDL, várias instruções por execução, erros, acentos e cancelamento de query (Postgres/MySQL) |
| `tests/tools_docker.rs` | os argumentos exatos que o app monta para `pg_dump`/`pg_restore`/`psql`/`mysqldump`/`mysql`, executados de verdade dentro dos containers |
| `tests/airflow_client.rs` | cliente Airflow contra um servidor HTTP falso: login, cache e renovação do JWT, 401 → um novo login, paginação, 403/500, POST que falha ou estoura o tempo **não** é repetido, detecção de Airflow 2, caminhos permitidos (roda no `cargo test` normal) |
| `tests/airflow_live.rs` | fluxo completo num Airflow 3 real (`--ignored`; veja 5.9) |
| `tests/ext_driver.rs` | drivers sob demanda: cria o venv dos drivers numa pasta temporária e conversa com o `rits_driver.py` via `ExtConn` (SQLite, sem download) |
| `tests/windows_compat.rs` | pastas das ferramentas dos plugins e execução de launchers `.cmd` com caminhos e argumentos acentuados; round-trip no Credential Manager com `--ignored` |
| `tests/audit_engine.rs` | Migration Audit sem banco: os cenários da especificação (ausentes com chave, mesma contagem com identidades diferentes, perda compensada por duplicação, mapa de IDs, chaves compostas/duplicadas/colisões, fusos, decimais, zeros à esquerda, baseline corrompida, exportação com HTML e fórmulas…) — roda no `cargo test` normal |
| `tests/audit_db.rs` | Migration Audit ponta a ponta em PostgreSQL, MySQL, MariaDB, SQL Server e Firebird (`--ignored`; containers e portas no cabeçalho do arquivo): baseline, reconciliação, relacionamentos, erro de permissão, cancelamento, origem alterada, estimativas, mapa de IDs |
| `tests/jupyter_client.rs` | protocolo de mensagens, autenticação por token contra servidor falso, caminhos, compose do ambiente local; `jupyter_live` (`--ignored`) roda contra um JupyterLab real (instruções no cabeçalho) |
| `tests/dbt_plugin.rs` | argumentos estruturados, seleção, Docker sem segredos na linha de comando, perfis sem senha, versão, artefatos; `dbt_live` (`--ignored`) roda dbt Core real contra PostgreSQL (`RITS_DBT`, `RITS_DBT_PG_PORT`) |
| `tests/assistant_mcp.rs` | servidor MCP do Assistente IA: token, Host, initialize, tools/list, tools/call encaminhado à janela, lote e notificações; com `--ignored`, o Claude Code real (`claude` no PATH, logado) chama uma ferramenta da IDE |
| `tests/ide_backend.rs` | framing JSON-RPC com escritas picotadas, UTF-8 dividido entre leituras, operações de arquivo (CRLF, BOM, binário, .gitignore, busca), e handshake real com gopls, basedpyright, debugpy e Delve via TCP |

> No MySQL de teste, sempre use `--default-character-set=utf8mb4` ao popular dados pelo `docker exec`. Sem isso o texto acentuado fica com dupla codificação e parece um bug do app, mas não é.

### Testando a interface de verdade
O app real só roda dentro do Tauri, porque o `invoke` não existe num navegador comum. Para automatizar ou inspecionar a interface:

1. Inicie com a depuração remota do WebView2:
   ```bash
   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" npm run tauri dev
   ```
2. Conecte via Chrome DevTools Protocol (`http://127.0.0.1:9222/json`, depois `Runtime.evaluate`) e use `window.__wb`, que é a instância do `Workbench` exposta pelo `main.ts`. Exemplos: `__wb.editors.openFile(path)`, `__wb.runner.runCurrentFile(false)`, `__wb.lsp.diagnostics`, `__wb.debugger.state`.
3. Para capturar a tela, use `PrintWindow` (user32), que funciona mesmo quando o shell não tem acesso ao desktop. `CopyFromScreen` falha nesse caso.

**No macOS** o WKWebView não fala o Chrome DevTools Protocol. Há três caminhos:
- **Inspeção manual**: no `tauri dev`, clique com o botão direito › Inspecionar (Web Inspector do Safari).
- **Roteiro temporário dentro do app real**: um módulo de teste carregado por `import()` no `main.ts` só quando uma variável `VITE_*` estiver definida, que recebe o `Workbench`, executa o fluxo e grava o resultado num arquivo com `host.write`. É o único jeito de exercitar Keychain, processos e janelas Tauri de verdade. **Apague o módulo e o gancho no `main.ts` antes de commitar.**
- **Interface num navegador headless** (Chrome/Brave com `--remote-debugging-port`) servida pelo Vite, com o `invoke` substituído por chamadas a um serviço real (por exemplo, um proxy para o Airflow). Serve para validar telas contra dados reais, não o backend Rust.

`dev/mock.html` com `dev/tauri-mock.ts` simula **só a parte de banco** num navegador comum, para mexer em CSS. `dev/ide-mock.html` com `dev/ide-mock.ts` simula a **janela da IDE** (projeto, árvore, Git e leitura de arquivos fictícios; sem processos, LSP nem terminal), em Windows ou macOS (`?os=mac`).

---

## 4. Estrutura do repositório

```
index.html                 ponto de entrada do Vite (carrega src/main.ts e src/styles.css)
src/
  main.ts                  boot: tema, fontes, window_reset, tela de boas-vindas ou Workbench
  styles.css               TODO o CSS (tokens dos temas Rits Escuro/Claro no topo, depois componentes; Liquid Glass no fim)
  icons.ts                 ícones: SVGs do expui (import.meta.glob) + ícones próprios; ícones por tipo de arquivo
  ui.ts                    primitivas: modal, confirm/prompt, contextMenu, dropdown, popupList, toast, notify, splitter
  util.ts                  h() (hyperscript), uid, debounce, quoteIdent/quoteLiteral, splitSql, formatação
  tabs.ts                  TabManager: abas do editor (arquivo, console SQL, tabela, diff…)
  vite-env.d.ts
  # ---- Database Tools (código anterior à IDE, reaproveitado) ----
  api.ts                   wrappers tipados dos comandos de banco (invoke)
  state.ts                 store global de conexões, status, histórico e log SQL
  explorer.ts              árvore de conexões → databases → schemas → objetos → colunas
  console.ts               console SQL (CodeMirror + resultados, transação manual, cancelamento)
  editor.ts                fábrica de editor SQL e formatador de SQL
  grid.ts                  DataGrid virtualizado e editável
  tableView.ts             aba de tabela: dados paginados, filtros, DML, colunas, índices, DDL
  connDialog.ts            diálogo de conexão
  backup.ts                wizards de backup/restore e painel de tarefas
  export.ts                exportação CSV/TSV/JSON/SQL/Markdown/HTML
  dialects.ts              comportamento por banco (aspas, paginação, EXPLAIN, schemas, arquivo, presets compatíveis)
  diagram.ts               aba de diagrama ER (canvas, layout automático, minimapa, exportar SVG/Mermaid)
  # ---- IDE de código ----
  ide/
    host.ts                wrappers dos comandos da IDE, fan-out de eventos (on), helpers de caminho (P)
    workbench.ts           a janela: barra de título com as abas, cartões com seletor de tool windows, tela de início do projeto e barra de comando, status bar, atalhos globais, troca de projeto
    project.ts             projetos recentes, cor e iniciais do badge, ProjectSettings e RunConfig
    editors.ts             CodeEditor (CodeMirror + LSP + breakpoints + marcadores de execução + gutter do Git + auto-save) e o gerenciador Editors
    lang.ts                tema e highlight do editor (cores de sintaxe do Islands) e mapa extensão → linguagem
    lsp.ts                 LspManager: um cliente LSP por linguagem; intercepta pedidos servidor→cliente; diagnósticos
    sdk.ts                 detecção de interpretadores Python e do Go; PLUGINS (componentes e instaladores); runBackground
    projectView.ts         tool window Projeto (árvore de arquivos)
    git.ts                 Git: status, popup de branches, tool windows Commit e Git (log), diff, clone
    run.ts                 configurações de execução, widget de execução, tool window Run, ANSI e links clicáveis
    debug.ts               cliente DAP (debugpy via stdio, Delve via TCP) e tool window Debug
    terminal.ts            tool window Terminal (xterm.js + PTY)
    problems.ts            tool window Problemas (diagnósticos LSP + inspeção com ruff, go vet e staticcheck)
    structure.ts           tool window Estrutura e documentSymbols()
    search.ts              Buscar em tudo, Localizar nos arquivos, arquivos recentes, ir para linha, estrutura do arquivo, tool window Find
    settings.ts            diálogo de Configurações (Aparência, Editor, Python, Go, Plugins, Keymap, Sobre)
    welcome.ts             tela de boas-vindas, Novo projeto e Clonar repositório
    dbtools.ts             integra o Database Tools na IDE (tool windows Database e Services)
    docker.ts              plugin opcional Docker: tool window Docker (containers, imagens, volumes) via CLI docker
    keymap.ts              keymaps JetBrains e VS Code: displayShortcut(), tabelas do Keymap
    completion.ts          autocomplete (LSP com resolve/auto-import, relevância, ícones por tipo; palavras do arquivo sem LSP)
    infra.ts               Dockerfile, Compose, Terraform e Kubernetes: detecção, ações (CLIs no Terminal) e modelos
    airflow/               plugin opcional Apache Airflow (seção 5.9): plugin.ts (entrada leve), api.ts, panel.ts,
                           dagTab.ts, instanceDialog.ts, env.ts (ambiente Docker), project.ts, web.ts
    plugins.ts             plugins carregados sob demanda (LAZY_PLUGINS) e pontos de extensão do editor (contribute)
    jupyter/               plugin Jupyter (5.10): api.ts, panel.ts (servidores, ambiente Docker), notebook.ts, render.ts
    dbt/                   plugin dbt (5.11): api.ts, panel.ts, run.ts (aba de execução), editor.ts (Jinja, ref/source, modelos)
    audit/                 plugin Migration Audit (5.12): api.ts, panel.ts, projectTab.ts (assistente, mapeamento, relatórios)
    assistant/             plugin Assistente IA (5.13): panel.ts (chat), providers.ts (Claude Code e Codex), tools.ts (ferramentas MCP)
  assets/icons/            SVGs do expui (Apache 2.0) com variantes _dark e @20x20
src-tauri/
  tauri.conf.json          productName "Rits", identifier "dev.rits.ide", janela sem moldura
  tauri.macos.conf.json    sobreposição do macOS: app/dmg, barra Overlay, Liquid Glass (seção 3.1)
  capabilities/default.json permissões (janelas "main" e "project-*"; window controls; criar webview; dialog)
  src/main.rs              chama rits_lib::run()
  src/lib.rs               comandos de banco + registro de TODOS os comandos + setup (migração) + limpeza ao fechar
  src/store.rs             conexões e documentos JSON na pasta de configuração; migração do nome antigo
  src/db/{mod,pg,my}.rs    sessões de banco (Postgres/MySQL), metadados, DDL, diagrama, execução, cancelamento
  src/airflow/             plugin Airflow: client.rs (HTTP /api/v2, JWT, erros, paginação), secrets.rs (chaves do Airflow), mod.rs (comandos)
  src/secrets.rs           cofre do sistema compartilhado pelos plugins (keyring), segredos aleatórios, uuid4
  src/jupyter/             plugin Jupyter: client.rs (REST /api, token), proto.rs (mensagens 5.3), mod.rs (comandos, WebSocket, ambiente Docker)
  src/dbt/                 plugin dbt: mod.rs (argumentos, perfis, execução com lock), artifacts.rs (manifest/run_results)
  src/assistant.rs         Assistente IA: servidor MCP local (HTTP em 127.0.0.1, token por conversa) e consulta somente leitura
  src/audit/               Migration Audit: canon, engine, evidence, adapter, analysis, runner, store, report, model, mod (comandos)
  src/db/ext.rs            drivers sob demanda: venv privado, pip install no primeiro uso, ExtConn (JSON por linha via stdio)
  src/db/drivers/rits_driver.py  o "driver host" Python (SQL Server, Oracle, Firebird, SQLite, DuckDB, ClickHouse, MongoDB)
  src/tools.rs             backup/restore: monta argumentos, localiza binários, transmite o log
  src/ide.rs               comandos Tauri da IDE (arquivos, processos, PTY, which, env…)
  src/fsx.rs               sistema de arquivos: listagem com .gitignore, leitura/escrita, busca, watcher
  src/procs.rs             processos (texto ou JSON-RPC), TCP para DAP, PTY, capture, which, PATH aumentado
  tests/                   veja a seção 3
assets/logo.svg            ícone do app: a marca sobre o quadrado escuro arredondado (grade de ícone do macOS)
assets/logo-mark.svg       só a marca, sem fundo: um "R" sólido e inclinado, lilás #A08CFF (fundo do ícone #111214)
                           gere os ícones com: npx tauri icon assets/logo.svg -o src-tauri/icons
                           e apague as pastas android/ e ios/ que o comando cria (o app é só desktop);
                           a versão de 20 px usada na interface é o "logo" em src/icons.ts
README.md / README.en.md   documentação para o usuário em pt-BR (principal) e em inglês: mantenha as duas em sincronia
docs/                      guias de uso dos plugins (pt-BR), um .md por plugin; abertos na IDE pelo botão "?" (src/ide/docs.ts)
dev/                       mocks de navegador: banco (mock.html) e janela da IDE (ide-mock.html)
```

---

## 5. Arquitetura

### 5.1 Princípio: backend genérico, lógica no frontend
O Rust **não sabe** o que é Python, Go, Git ou LSP. Ele oferece primitivas genéricas:

- **Arquivos** (`fsx.rs`): `fs_list` (ordena pastas primeiro, marca `ignored` pelo .gitignore e oculta `.git`), `fs_read` (detecta binário, BOM e CRLF, e **devolve o texto sempre com LF** junto com `crlf`/`encoding`), `fs_write(path, text, crlf)` (reconverte para CRLF quando necessário), `fs_create`, `fs_rename`, `fs_delete` (**manda para a Lixeira**; no macOS via NSFileManager, sem permissão de automação), `fs_delete_permanently` (só depois de o usuário confirmar, quando o volume não tem Lixeira, como pastas do OneDrive), `fs_copy`, `fs_files` (lista para "Ir para arquivo"), `fs_search` (regex, maiúsculas, palavra inteira, máscara, até 2000 resultados) e `fs_watch`, que emite o evento `fs-change {root, paths}` com debounce de 250 ms.
- **Processos** (`procs.rs`): `proc_spawn(spec)` com `mode: "plain"` (emite `proc-out {id, stream, data}` e `proc-exit {id, code}`) ou `mode: "rpc"` (stdout com framing `Content-Length`; cada mensagem vira `rpc-in {id, msg}`). `proc_connect(id, addr)` faz o mesmo via TCP (usado pelo Delve). `proc_write` envia dados (e acrescenta o cabeçalho `Content-Length` no modo rpc), e `proc_kill` mata a **árvore** de processos (`taskkill /T /F`). `run_capture` executa até o fim e devolve stdout/stderr (usado pelo Git e pelas detecções).
- **Terminais**: `pty_open/write/resize/close` emitem `pty-data` e `pty-exit`.
- **Ambiente**: `which(name)` procura no PATH e também em `%USERPROFILE%\go\bin`, `C:\Program Files\Go\bin`, `%LOCALAPPDATA%\Programs\Python\*\Scripts` e afins. Todo processo iniciado recebe esse **PATH aumentado** e mais `PYTHONUNBUFFERED=1`, `PYTHONUTF8=1` e `PYTHONIOENCODING=utf-8`. A variável especial `RITS_PATH_PREPEND` (separada por `;`) coloca pastas na frente do PATH; é assim que o venv do projeto é ativado para programas, servidores e terminal.
- **Dono dos processos**: cada processo e PTY guarda o *label* da janela que o criou. Ao carregar, a página chama `window_reset` e mata o que sobrou da carga anterior; quando a janela é destruída, ou na saída do app, tudo é encerrado. **Não remova isso**: sem essa limpeza, recarregar a página deixa servidores de linguagem órfãos.

Toda a inteligência (qual comando rodar, como interpretar a saída, LSP, DAP, Git) fica em `src/ide/*.ts`. A exceção são os drivers de banco sob demanda (`db/ext.rs`), que precisam ser chamados pelos mesmos comandos de banco do explorador. Para um recurso novo, **prefira compor essas primitivas no frontend** a criar um comando Rust específico.

### 5.2 Eventos do backend → frontend
O `host.ts` registra **um** listener Tauri por evento e distribui por `id` com `on<T>(evento, id, handler)`, que devolve a função de unsubscribe. Sempre chame o unsubscribe quando o processo terminar, como fazem `run.ts`, `debug.ts` e `lsp.ts`.

### 5.3 Workbench (a janela)
`Workbench` (em `workbench.ts`) é criado com a pasta do projeto, e `mount()`:
1. carrega `ProjectSettings` (do `load_doc` com chave `project-<caminho normalizado>`);
2. resolve o interpretador Python (configurado → `.venv`/`venv` do projeto → o mais novo instalado);
3. instancia os módulos **nesta ordem**: `Editors`, `ProjectView`, `DbTools`, `Git`, `Structure`, `Runner`, `Debugger`, `Terminals`, `Problems` (cada um registra suas tool windows com `wb.register()`);
4. liga o watcher e restaura o layout e os arquivos abertos;
5. instala os atalhos globais (fase de captura do `keydown`).

**Tool windows**: `wb.register({id, title, icon, anchor: "left"|"right"|"bottom", shortcut, body, headerTabs?, actions?, onShow?})`. Há uma visível por lado (`show`, `hide`, `toggle`, `isVisible`). O cabeçalho do cartão (seletor segmentado + `actions` + menu ⋮, e `headerTabs` numa segunda linha nos cartões laterais) é refeito por `refreshHeader(id)`, e `setBadge(id, bool)` acende o ponto vermelho no segmento e, com o painel oculto, no botão de layout da barra de título. O nome do ícone é o arquivo em `assets/icons/toolwindows/<nome>@20x20.svg` (ou um ícone próprio do `icons.ts`).

IDs e atalhos atuais: `project` (Alt+1), `database` (Alt+2, esquerda), `find` (Alt+3), `run` (Alt+4), `debug` (Alt+5), `problems` (Alt+6), `structure` (Alt+7), `services` (Alt+8), `git` (Alt+9), `commit` (Alt+0), `terminal` (Alt+F12), `docker` (só com o plugin, embaixo à direita), `airflow`, `jupyter`, `dbt` e `audit` (só com os respectivos plugins, à direita).

**Posição das tool windows**: cada janela fica num dos três cartões (`anchor`: `left`, `right` ou `bottom`); a ordem no seletor vem de `order`. O menu ⋮ e o clique direito num segmento têm "Mover para o painel esquerdo/inferior/direito", "Restaurar layout padrão" e "Ocultar". Também dá para **arrastar** um segmento para outro cartão ou para um botão de painel da barra de título (`startTwDrag`, por eventos de ponteiro: o drag-and-drop HTML5 é interceptado pela janela nativa no Windows); `moveToolWindow` mantém o cartão de origem aberto com outra janela. Segmentos que não cabem vão para o botão ⋮ no fim da faixa (`fitSegments`). A posição é salva no `localStorage` `toolLayout` (global, vale para todos os projetos) e aplicada no `register()`. Padrão: Projeto, Database, Commit e Estrutura à esquerda; Airflow à direita; o resto embaixo. Os botões de layout da barra de título (`layoutBtns`) chamam `toggleSide()`; com o cartão esquerdo oculto, um botão do projeto aparece na barra de título (`.left-hidden`).

**Tela de início ("Início")**: a primeira aba é fixa (`TabManager` com `home`; `showHome()`), e mostra `renderHome()`: título e chips do projeto, "Comece por aqui", "No projeto" (`detectProject()` procura Compose, Dockerfile, `*.tf`, `tests/`, `go.mod` e `pyproject.toml` na raiz e reaproveita as ações de `infra.ts` e `runner.runTestsIn()`), Executar e a barra de comando (`commandBar()`: Enter busca com `searchEverywhere(wb, tab, query)` ou roda no Terminal com `terminals.newTab(root, cmd)`; Tab alterna o modo). Sem `activeFile` salvo, o projeto abre nessa aba. `unregister(id)` remove uma janela (usado pelos plugins opcionais).

**Keymaps** (`keymap.ts`): `keymapId()` é `"vscode"` (padrão no macOS) ou `"jetbrains"` (padrão no Windows), no `localStorage` `keymap`. Os menus continuam escritos com rótulos JetBrains ("Ctrl" = ⌘ no Mac); `displayShortcut()` traduz para o keymap ativo e desenha ⌃⌥⇧⌘ no macOS (o `ui.ts` aplica isso em `contextMenu` e `popupList`). No modo VS Code, `Workbench.vscodeKey()` trata os atalhos globais antes dos JetBrains (incluindo o acorde ⌘K). Os do editor ficam em `CodeEditor.keymap()`, embrulhados em `jb()`/`vs()`, que checam o keymap na hora da tecla. Atalho novo: inclua nos dois keymaps e no `VS`/`keymapTable()`. Para letras use `e.code` (o Option do Mac altera o `e.key`).

**Plugins opcionais**: o Docker não é instalado no interpretador; ele é "ativado" (`localStorage` `plugin.docker`). `setDockerEnabled()` emite `rits-plugins`, e `Workbench.syncPlugins()` cria ou descarta o `DockerTools`. A janela usa `docker ps/images/volume ls --format "{{json .}}"`, agrupa pelo label `com.docker.compose.project`, atualiza ao vivo com um processo `docker events` e mostra `docker stats` a cada 5 s, só quando a janela está visível. Logs e o shell no container abrem como abas do Terminal (`docker logs -f`, `docker exec -it`). O plugin Airflow segue o mesmo padrão (`plugin.airflow`, `airflow/plugin.ts`), mas é carregado por `import()` dinâmico; veja 5.9.

**Trocar de projeto**: `wb.openProject(path)` pergunta "Esta janela / Nova janela" (a escolha pode ser lembrada no `localStorage` `openProjectIn`). "Esta janela" chama `prepareClose()` (salva, para execuções, depuração, terminais e servidores LSP) e navega para `index.html?project=<path>`. "Nova janela" cria um `WebviewWindow` com label `project-<id>`. Sem `?project`, o `main.ts` reabre o projeto mais recente; com `?welcome=1`, mostra a tela de boas-vindas.

### 5.4 Editor e LSP
- `Editors.openFile(path, {line, col, len, background})` cria ou ativa o `CodeEditor`. A chave do mapa é o caminho em **minúsculas** (o Windows não diferencia maiúsculas). A aba tem id `file:<caminho minúsculo>`.
- **Auto-save** como no JetBrains: 1,5 s depois da última edição, ao perder o foco e ao trocar de aba. Mudanças externas chegam por `fs-change` → `reload()`, que ignora o próprio save por 1,5 s.
- **Go**: formata no save (gofmt via `textDocument/formatting` do gopls), controlado por `settings.goFmtOnSave`. **Python**: formata com `ruff format -` e otimiza imports com `ruff check --select I,F401 --fix -`, ambos via stdin.
- O **`LspManager`** inicia `basedpyright-langserver --stdio` (ou `pyright-langserver`) e `gopls serve`. Detalhes que **não podem ser removidos**:
  - `patchInitialize()` reescreve o `initialize` enviado pelo `@codemirror/lsp-client`, que **não** manda `workspaceFolders` nem declara `workspace.configuration`. Sem isso o basedpyright cai num workspace "default", ignora as configurações e procura o `python` errado.
  - Pedidos do **servidor para o cliente** (`workspace/configuration`, `workspace/applyEdit`, `client/registerCapability`, `window/workDoneProgress/create`, `window/showDocument`…) são interceptados no transporte, porque o lsp-client responderia "MethodNotFound".
  - Depois do init, o app envia `workspace/didChangeConfiguration`. As configurações ficam em `settings()`, e `PY_OVERRIDES` desliga regras do basedpyright que o PyCharm não aplica (`reportImplicitRelativeImport`).
  - O `IdeWorkspace` permite vários arquivos, abre o editor ao pular para uma definição (`displayFile`) e aplica edições em arquivos fechados direto no disco.
  - O cliente sincroniza sozinho 500 ms depois de cada edição (extensão `autoSync` do lsp-client). Os diagnósticos são gravados em `lsp.diagnostics` e alimentam o editor, a aba, a árvore e Problemas.
  - Na primeira vez num projeto, o gopls leva de 10 a 15 s carregando pacotes. Pedidos feitos nesse intervalo podem voltar vazios. Isso é esperado.
- **Gutter**: a ordem é breakpoints, marcadores ▶ e marcas do Git. As marcas do Git vêm do diff de linhas (Myers, `lineDiff` em `editors.ts`) contra `git show HEAD:<arquivo>`. Os marcadores ▶ vêm de `runTargets()` por regex: Python `if __name__ == "__main__":`, `def test_*` e `class Test*`; Go `func main()` em `package main` e `func Test*|Benchmark*|Example*|Fuzz*` em `_test.go`.

- **Linguagens de infra**: `LspLang` também tem `terraform` (`terraform-ls serve`), `dockerfile` (`docker-langserver --stdio`) e `yaml` (`yaml-language-server --stdio`), instalados pelo plugin "Infraestrutura (IaC)". O YAML LS recebe os schemas do Compose (por nome de arquivo) e do Kubernetes (pastas comuns e, por conteúdo, arquivos com `apiVersion` + `kind`, via `markKubernetes`). Em YAML comum, a falta do servidor não gera aviso (`ensure(lang, quiet)`). O HCL tem realce próprio (`hcl` em `lang.ts`). `infra.ts` mostra uma barra de ações no topo do editor (compose up/down/logs, terraform plan/apply/validate, kubectl apply/diff, docker build) e modelos no menu "Novo" da árvore.
- **Autocomplete** (`completion.ts`): o `@codemirror/lsp-client` não faz `completionItem/resolve`, e por isso não traria a documentação nem o auto-import. As extensões do cliente são montadas **sem** o `serverCompletion` (veja `lsp.ts`), e a fonte própria faz uma requisição por digitação, ordena pelo `sortText` do servidor (`boost`), mostra `labelDetails`, resolve a documentação sob demanda e aplica os `additionalTextEdits` ao aceitar. O `patchInitialize` declara `resolveSupport`, `labelDetailsSupport` e todos os `CompletionItemKind` (o cliente mandava a lista vazia). Sem LSP, valem as fontes da linguagem mais as palavras do arquivo. As opções ficam no `localStorage` `completion` (Configurações › Editor › Autocompletar) e são aplicadas ao vivo pelo evento `rits-completion`.

- **Tab no autocomplete**: `completionTabKeymap` (`completion.ts`), compartilhado pelos editores de código e SQL, tem prioridade sobre indentação e navegação de snippets. Respeita `tabAccepts` e o modo somente leitura. Se o popup acabou de abrir, consome Tab e aceita após a proteção de 75 ms do CodeMirror, desde que documento, seleção e sugestão continuem iguais; Enter mantém a proteção original. Sem sugestão, Tab/Shift+Tab mantêm indentação e navegação dos campos. `await (await import('/dev/completion-smoke.ts')).probeCompletionTab()` no app servido pelo Vite testa os dois keymaps, SQL, snippets, opção desativada e edição durante essa espera.

### 5.5 Executar e depurar
- `RunConfig` (`project.ts`) tem os tipos `python`, `pytest`, `go`, `gotest` e `shell`. `Runner.command(cfg)` resolve a linha de comando: Python roda com `-X utf8`; pytest com `-m pytest -v --color=yes alvo[::filtro]`; Go com `go run ./pkg` e `go test -v -run ^Nome$ ./pkg`. Configurações criadas pelo gutter ou pelo "Executar arquivo" são **temporárias** (no máximo 5), como no JetBrains.
- O console renderiza ANSI (SGR) e transforma em links `File "x.py", line N` e `arquivo.go:L:C`.
- **Depurador** (`debug.ts`): Python usa `python -m debugpy.adapter` (stdio, modo rpc). Go sobe `dlv dap --listen=127.0.0.1:<porta livre>` e conecta via `proc_connect`. A sequência é `initialize`, `launch`, evento `initialized`, `setBreakpoints` (todos os arquivos), `setExceptionBreakpoints`, `configurationDone` e a resposta do `launch`. Os breakpoints ficam em `settings.breakpoints[caminho minúsculo] = [linhas]`.
- O estado vira `paused` assim que chega o evento `stopped`; frames e escopos chegam **logo depois**, em paralelo. Em testes, espere `debugger.vars.length > 0`.

### 5.6 Git
Tudo passa por `git` via `run_capture`, com `-c core.quotepath=false -c color.ui=false`. O status vem de `git status --porcelain=v2 --branch -z --untracked-files=all`. Operações demoradas (pull, push, fetch, checkout, merge, clone) usam `runBackground` (progresso na barra de status) com `GIT_TERMINAL_PROMPT=0`; a autenticação fica a cargo do Git Credential Manager do usuário. O repositório pode estar acima da pasta do projeto: use `git.repoRoot` em caminhos relativos.

### 5.7 Database Tools
Código de antes da IDE, reaproveitado. O `DbTools` cria o `Explorer` dentro da tool window `database` e abre consoles e tabelas como abas no `wb.tabs`. Os consoles abertos são salvos em `settings.dbConsoles`. Cada aba de console usa um **canal** (conexão física) próprio (`console-<id>`); o explorador usa `meta` e `meta-run`, e as abas de tabela usam `data`. Isso evita que uma query longa trave o explorador. O cancelamento usa `CancelToken` no Postgres e `KILL QUERY` no MySQL.

O backup e o restore montam argumentos em `tools.rs` (`pg_plan`/`my_plan`, que são funções puras e testadas) e procuram os binários na pasta configurada na conexão, no PATH, em `C:\Program Files\PostgreSQL\*\bin` e em `MySQL`/`MariaDB`. A senha vai por `PGPASSWORD`/`MYSQL_PWD`, nunca pela linha de comando.

**Drivers sob demanda** (`db/ext.rs`): os bancos não nativos viram `Session::Ext`. No `test_connection` e no `save_connection`, `ensure_driver(kind)` cria (uma vez) o venv em `<config>/drivers/venv` com um Python 3.9+ do sistema e roda `pip install` dos pacotes de `packages()` (puro Python quando possível: `python-tds`, `oracledb` thin, `firebirdsql`, `pymongo`). O marcador `<kind>.installed` evita baixar de novo. O progresso do pip vai para o evento `driver-progress`, mostrado no diálogo de conexão. Cada sessão é um processo `rits_driver.py`, e cancelar uma query mata esse processo (`Canceller::Ext`). Para um banco novo: variante em `DbKind`, pacotes em `packages()`, uma classe no `rits_driver.py` (registrada em `DRIVERS`) e uma entrada em `DIALECTS` (`dialects.ts`).

**Dialetos** (`dialects.ts`): no frontend, todo `if postgres/mysql` deve passar por `dialect(kind)`: `quote`, `page` (LIMIT/OFFSET, OFFSET…FETCH), `explain`, `begin`, `schemas` (banco > schema > objetos ou banco > objetos), `file` (SQLite/DuckDB), `sql` (o MongoDB usa comandos estilo mongosh, e a aba de coleção é somente leitura) e `backup`. `PRESETS` oferece servidores compatíveis (CockroachDB, Supabase/Neon, TiDB, Redshift…).

**Escopo da conexão**: `ConnConfig.project` guarda a pasta do projeto em que a conexão foi criada; `""` = global (as conexões antigas são globais). `store.setProject(wb.root)` e `store.connections` mostram as globais mais as do projeto; `store.all` tem todas. O diálogo tem "Mostrar esta conexão em todos os projetos", e o menu da conexão alterna o escopo.

**Diagrama ER** (`diagram.ts` + comando `diagram_info`): uma consulta por schema (colunas com PK e FKs). Cartões HTML num "mundo" com `transform`, ligações SVG com pé de galinha, layout em camadas (pais à esquerda), arrastar, pan/zoom (roda = pan, Ctrl/⌘ + roda ou pinça = zoom), minimapa, busca e destaque das relações. As posições ficam no `localStorage` `diagram:<conn>:<db>:<schema>`. No MongoDB as relações são inferidas de campos `<coleção>Id` do tipo ObjectId.

### 5.8 Persistência
Na pasta de configuração (`%APPDATA%\dev.rits.ide\` no Windows, `~/Library/Application Support/dev.rits.ide/` no macOS) ficam:
- `connections.json`: conexões de banco (**senhas em texto puro**; melhoria pendente: migrá-las para o cofre do sistema de `airflow/secrets.rs`, já usado pelo Airflow);
- `airflow-instances.json` e `airflow-envs.json`: instâncias e ambientes locais do Airflow (**sem** senhas nem tokens, que ficam no cofre do sistema); `airflow-envs/<slug>/compose.yaml`: o compose de cada ambiente local (fora do projeto e do Git);
- `jupyter-servers.json`, `jupyter-envs.json`, `jupyter-envs/<slug>/compose.yaml` e `jupyter-trust.json` (Jupyter, sem tokens); `dbt-profiles.json` e `dbt-profiles/<id>/profiles.yml` (dbt, sem senhas); `migration-audit/` (projetos, baselines, execuções e exportações do Migration Audit — podem conter dados auditados); `assistant-chat-<projeto>.json` (conversas do Assistente IA);
- `history.json`: histórico SQL; `recentProjects.json`: projetos recentes; `project-<…>.json`: `ProjectSettings` de cada projeto (layout, arquivos abertos, breakpoints, configurações de execução, interpretador, pastas expandidas, consoles).

Preferências de interface (tema, tamanho de fonte, "abrir projeto em") ficam no `localStorage`; sempre envolva o acesso em `try/catch`. Quando o app se chamava "Beaver Grip", o identificador era `dev.beavergrip.app`; `store::migrate_legacy` copia esses arquivos uma única vez.


### 5.9 Plugin Apache Airflow
Plugin opcional (Configurações › Plugins › Infraestrutura), ativado pelo `localStorage` `plugin.airflow`. O `Workbench.syncPlugins()` carrega `airflow/panel.ts` por `import()` dinâmico (chunk separado do Vite) e chama `dispose()` ao desativar: cancela requisições, para o polling, fecha as abas e chama `airflow_release`, que descarta tokens e clientes HTTP. Instâncias externas e o ambiente Docker continuam rodando.

- **Só a API pública do Airflow 3** (`/api/v2`), conferida contra o OpenAPI da 3.3.2. O `check_path` recusa qualquer caminho fora de `/api/v2/` (nada de `/ui`, scraping ou banco de metadados). Airflow 2 (`/api/v1`) é detectado e recusado com mensagem clara.
- **Chamadas pelo backend** (`airflow_request`, `airflow_get_all`): o frontend nunca vê senhas nem tokens, e não há CORS. Autenticação: `password` (POST `/auth/token` → JWT, cache até 60 s antes do `exp`, novo login automático), `token` (bearer colado pelo usuário) ou `none`. TLS validado por padrão (desligar é opção explícita, com aviso).
- **Segredos**: `airflow/secrets.rs` usa o cofre do sistema (`keyring`: Keychain no macOS, Credential Manager no Windows), com as chaves `airflow:<id>` e `airflow-env:<slug>:{admin,jwt,fernet}`. O documento `airflow-instances` guarda só nome, URL, usuário, timeout e TLS. As senhas das conexões de banco **ainda não** usam esse cofre.
- **Repetição**: a única repetição automática é um novo login depois de um 401 (o servidor recusou, nada rodou). Timeout e 5xx nunca são repetidos, e o botão de disparar fica desabilitado até a resposta. A limpeza de tarefas sempre roda primeiro com `dry_run: true` para mostrar o alcance.
- **Polling** (`panel.ts`, `dagTab.ts`): a lista a cada 20 s só com a janela visível, dobrando até 160 s em erros consecutivos; execuções e logs a cada 3 s só enquanto não terminaram e a aba está ativa. Logs usam `full_content` e o `content` estruturado (`::group::`).
- **Ambiente local** (`env.ts` + `airflow_env_*`): compose gerado de `composeFor()`, baseado no oficial da 3.3.2 (CeleryExecutor → LocalExecutor, sem Redis/worker), com imagens fixadas (`apache/airflow:3.3.2`, `postgres:16.15`), porta só em `127.0.0.1`, FabAuthManager com senha aleatória (sem acesso anônimo) e rótulos `dev.rits.plugin=airflow`. O compose fica na pasta de configuração (`airflow-envs/<slug>/`), fora do projeto e do Git. `airflow_env_compose` injeta os segredos como variáveis de ambiente e só aceita `up/down/stop/start/restart/ps/logs/pull` (nunca `config`, que imprimiria os segredos); `down -v` exige a flag de confirmação, que a UI só envia depois de o usuário digitar o nome do ambiente. Parar preserva os volumes. Depois do `up`, a IDE espera o `/api/v2/monitor/health` e cadastra a instância sozinha.
- **Projeto** (`project.ts`, `ProjectSettings.airflow`): instância, pasta de DAGs e forma de entrega (`volume`, `git` ou `manual`). A API não recebe arquivos. Ao salvar um `.py` da pasta de DAGs, a IDE acompanha o processamento (`last_parsed_time` e `importErrors`) e avisa quando a DAG foi processada ou deu erro; no modo Git, lembra de publicar com commit e push. O arquivo local de uma DAG vem do `relative_fileloc`. Para o autocomplete, `installSdk()` instala `apache-airflow-task-sdk==TASK_SDK_VERSION` (`env.ts`, a versão que o `apache-airflow` 3.3.2 exige) no interpretador do projeto, só quando o usuário aceita (sugerido uma vez por sessão, ao criar uma DAG ou associar o projeto), e reinicia o LSP de Python. Ao subir a versão do Airflow, atualize `AIRFLOW_VERSION` e `TASK_SDK_VERSION` juntos.
- **Painel web** (`web.ts`): a UI oficial abre numa janela separada (`airflow-web-*`, fora das capabilities da IDE, sem acesso a comandos) ou no navegador do sistema. Login e navegação foram validados; as funções principais usam a API nativa.
- **Teste real**: suba um Airflow 3 (por exemplo, o ambiente local da IDE), coloque `rits_smoke.py` e `rits_quebrada.py` (veja o cabeçalho de `tests/airflow_live.rs`) na pasta de DAGs e rode `RITS_AIRFLOW_URL=http://127.0.0.1:8080 RITS_AIRFLOW_PASSWORD=... cargo test --test airflow_live -- --ignored`.

### 5.10 Plugin Jupyter
Plugin opcional (`plugin.jupyter`), carregado por `LAZY_PLUGINS` (`plugins.ts`). O `JupyterTools` registra a tool window `jupyter` e uma contribuição de editor que abre `.ipynb` no `NotebookTab` (o "Abrir como texto" usa `openFile(path, {text: true})`).

- **Backend** (`src/jupyter`): REST só em `/api/...` (`check_path`), token no header `Authorization: token` (vindo do cofre, chave `jupyter:<id>`; URL com `?token=` é recusada). Os kernels usam WebSocket (`/api/kernels/<id>/channels`, serialização JSON legada) aberto pelo backend: sem Origin de navegador, o Jupyter aceita a IDE. **Toda mensagem é montada e lida em `proto.rs`** (lista fechada de pedidos permitidos; eventos `jupyter-msg`/`jupyter-closed` por canal). Conexões pertencem à janela (`close_owner` no `window_reset` e ao destruir a janela).
- **Execução** (`notebook.ts`): uma célula termina quando chegam o `execute_reply` (shell) **e** o `status: idle` (iopub), em qualquer ordem (`finishPart`). Respostas podem chegar antes de o `invoke` devolver o `msg_id`: ficam em `early` e são reprocessadas. Interromper e reiniciar usam a API REST. Reconectar consulta `/api/kernels/<id>` e nunca reexecuta células.
- **Sessões**: `POST /api/sessions` com o caminho do notebook como o servidor o vê (`localRoot` ↔ `remoteRoot`; no ambiente Docker, `work`). Sessões criadas pela aba são encerradas ao fechá-la; sessões já existentes (JupyterLab) são preservadas. Desativar o plugin fecha só as conexões.
- **Confiança**: `render.ts`. Markdown e HTML sempre sanitizados (DOMPurify); HTML com scripts e JavaScript só para notebooks confiáveis ou saídas desta sessão, num iframe `sandbox="allow-scripts"` sem same-origin. A confiança é o SHA-256 do arquivo no documento `jupyter-trust`, atualizada ao salvar.
- **Ambiente local**: `jupyter_env_create` gera o `compose.yaml` (`compose_for`, imagem fixada em `JUPYTER_IMAGE`, porta `127.0.0.1`, volume `home`, rótulos `dev.rits.plugin=jupyter`) em `jupyter-envs/<slug>/`; `jupyter_env_compose` injeta `RITS_JP_TOKEN` do cofre e aceita só `up/down/stop/start/restart/ps/logs/pull` (`down -v` exige `--rits-confirmed-delete`). O JupyterLab oficial abre por `jupyter_open_lab` (o backend monta a URL com o token e cria a janela `jupyter-web-*`, fora das capabilities).
- Autocomplete via `complete_request` do kernel; diagnóstico com Ruff (`E9,F63,F7,F82`) nas células concatenadas, quando instalado.

### 5.11 Plugin dbt
Plugin opcional (`plugin.dbt`). Configuração do projeto em `ProjectSettings.dbt` (pasta, runtime, perfil, target).

- **Comandos** (`dbt_run`): `build_args`/`docker_args` (funções puras, testadas) montam argumentos sem shell; lista fechada em `COMMANDS`; seleção validada por `selector_ok` (nunca começa com `-`). JSON logs (`--log-format json`) alimentam a aba `DbtRunTab`. **Uma execução por pasta `target/`** (lock no `DbtState`, liberado pelo `spawn_notify`). Cancelar mata a árvore e, no Docker, faz `docker kill` do container nomeado.
- **Perfis gerenciados** (PostgreSQL): documento `dbt-profiles` sem senhas; `render_profile` grava `profiles.yml` em `dbt-profiles/<id>/` com `password: "{{ env_var('RITS_DBT_PASSWORD') }}"`. A senha vem do cofre (`dbt:<perfil>:<target>:password`) ou da conexão do Rits (`connConfig.password`) e entra no ambiente só do target selecionado. No Docker, segredos vão como `-e NOME` (valor herdado do ambiente do processo).
- Antes de `run/build/seed/snapshot` a UI roda `dbt ls` com a mesma seleção e mostra target, alcance e o impacto do `--full-refresh`.
- **Artefatos**: `artifacts.rs` aceita manifest v10–v12 e run_results v4–v6 (fora disso: `old`/`newer`/`unknown`), sinaliza resultados de outra invocação e arquivos alterados depois da execução. `ref()`/`source()` resolvem pelo manifest (`resolveRef`) com fallback por nome de arquivo.
- Os modelos de arquivo (`TEMPLATES`) foram validados com `dbt parse` 1.12.6 (sintaxe `data_tests`, `arguments:`, snapshots em YAML, unit tests).

### 5.12 Plugin Migration Audit
Plugin opcional (`plugin.audit`) de auditoria determinística de conversões. **Nunca escreve nos bancos auditados** e usa conexões próprias (não as sessões do explorador).

- **Armazenamento** (`store.rs`): `<config>/migration-audit/<projeto>/{project.json, mappings.json, structure-*.json, baselines/<id>/, runs/<id>/}`. Gravação atômica (tmp + rename + fsync). Manifestos com `format`, versão do plugin e `digest` (SHA-256 do JSON sem o campo); cada arquivo de evidência com tamanho e SHA-256 (`verify_baseline`). Mapeamentos têm `version` incrementada a cada salvamento; baselines e execuções guardam a cópia exata das unidades.
- **Valores canônicos** (`canon.rs`): tipo lógico por dialeto, codificação `tag|u32 len|bytes` (sem colisão por concatenação, nulo com marcador próprio), decimais exatos em texto, datas/horas normalizadas (offset → UTC), valores inválidos viram `Invalid` (nunca nulo). Regras (`Rules`) são explícitas; o padrão não muda nada.
- **Evidência** (`evidence.rs`): uma linha por identidade, ordenada pela chave canônica (hex), com multiplicidade, digest da chave bruta (colisões por normalização = `*`), digest da linha, FKs e estados dos campos (`N`, `E`, `W:`, `V:`, `I:`, valor opcional). Ordenação externa: blocos de `batch_rows` em memória, depois merge k-way. Limite de disco interrompe a unidade (fica incompleta, nunca vira amostra).
- **Motor** (`engine.rs`): `Capturer` (linhas → evidência, perfil e exclusões), `MapCapturer`/`translate` (mapa de IDs), `compare` (merge-join: ausentes, extras, multiplicidade, pré-existentes, campos, FKs) e `orphans`/`check_fk_via_map`. Chaves duplicadas nunca escolhem uma linha: campos ficam "não comparados".
- **Adapters** (`adapter.rs`): PostgreSQL e MySQL/MariaDB nativos; SQL Server e Firebird pelo `rits_driver.py` (ops `audit_discover`, `audit_describe`, `audit_begin`, `audit_end`, `audit_stream` em lotes). SQL com identificadores escapados por dialeto e valores sempre como parâmetros (`select_sql`, `count_sql`); consultas personalizadas passam por `single_statement` e rodam em transação somente leitura quando o banco suporta. `capabilities()` é a matriz mostrada na UI — atualize-a junto com os testes.
- **Orquestração** (`runner.rs`): `capture_side` (snapshot do coordenador; no PostgreSQL os workers importam o `pg_export_snapshot`), `reconcile` (usa a configuração congelada da baseline para a origem; campos cujas regras mudaram ficam bloqueados), `volume_result` (estimativas e cardinalidades não 1:1 nunca aprovam). Progresso pelo evento `audit-progress`; cancelamento por `JobCtl` (cancela também a consulta no banco).
- **Relatórios** (`report.rs`): HTML autocontido (escape completo, sem scripts nem recursos remotos), CSV com proteção contra fórmulas, máscara de valores sensíveis por padrão (detalhado só por ação explícita).
- Para um banco novo: variante em `dialect_of`, descoberta e streaming no adapter (ou no driver Python), linha na matriz `capabilities()` e um caso em `tests/audit_db.rs`.

### 5.13 Plugin Assistente IA (Claude Code e Codex)
Plugin opcional (`plugin.assistant`, `LAZY_PLUGINS`). Um chat na tool window `assistant` (direita) que conversa com o **CLI oficial do usuário**: o Rits não chama APIs de modelos nem guarda chaves.

- **Agentes** (`providers.ts`): `locate()` acha `claude`/`codex` no PATH e em `~/.local/bin`, `~/.claude/local`, `%APPDATA%\npm`; sem Codex global, usa `npx -y @openai/codex@latest`.
  - **Claude Code**: um processo por conversa, `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --mcp-config <arquivo> --append-system-prompt … --allowedTools=<ferramentas do Rits>`. Cada mensagem é uma linha JSON no stdin; o `session_id` do `system/init` é salvo e usado no `--resume` depois de reabrir. Modos: `plan` (somente leitura), `--permission-prompt-tool mcp__rits__approve` (aprovação no chat) e `acceptEdits`. **`--allowedTools` é variádico**: passe um único valor com `=` e vírgulas, senão ele engole os argumentos seguintes.
  - **Codex**: um `codex exec --json` por mensagem e `codex exec resume <thread> -` depois. O prompt vai pelo **stdin** (`-`), nunca pela linha de comando; os `-c` usam valores **sem aspas** (o TOML cai no texto literal). Isso evita problemas de aspas e quebras de linha nos launchers `.cmd` do Windows. `exec resume` não aceita `-s`: o sandbox vai em `-c sandbox_mode=…`. O token do MCP vai pela variável `RITS_MCP_TOKEN` (`bearer_token_env_var`). Os modelos vêm de `codex debug models` (`visibility: list`).
- **Servidor MCP** (`assistant.rs`): HTTP mínimo em `127.0.0.1:<porta livre>`, rota `/mcp`, respostas JSON (sem SSE). Exige o bearer de uma conversa registrada (`assistant_open`) e `Host` local (proteção contra DNS rebinding). `tools/call` vira o evento `assistant-tool-call` **só para a janela dona** da conversa e espera `assistant_tool_result` (180 s; 30 min para `approve`). Tokens morrem no `assistant_close`, no `window_reset`/fechamento da janela (`drop_owner`) e no `assistant_release`. O arquivo do `--mcp-config` fica em `<cache>/assistant/` com permissão 0600 e é apagado ao fechar.
- **Ferramentas** (`tools.ts`): todas com `readOnlyHint` (o Codex só chama ferramentas MCP sem aprovação quando elas se declaram somente leitura). Reaproveitam as APIs da IDE: editores (inclusive texto não salvo), `lsp.diagnostics`, `store.connections` (sem senhas), `api.completion/columns/indexes`, `AirflowApi`, `dbt.artifacts`, notebooks abertos do plugin Jupyter, `docker ps` e `audit.projects/history`. Consultas do agente passam por `assistant_db_query` → `export::stream_query` (transação somente leitura, até 2000 linhas, 60 s). Saídas cortadas em 60 mil caracteres. **Nunca** exponha senhas, tokens ou comandos que escrevam por aqui; ferramenta nova = entrada em `TOOLS` + caso em `runTool()` + linha na tabela de `docs/assistente-ia.md`.
- **Chat** (`panel.ts`): streaming (`stream_event` → `delta`), cartões por ferramenta, Markdown pelo `renderMarkdown` do Jupyter (sanitizado), aprovação com diff para `Edit`/`Write`, "Sempre permitir nesta conversa". Conversa por projeto no documento `assistant-chat-<projeto>` (últimas 200 mensagens + sessões por agente); preferências no `localStorage` `assistant.*`.

---

## 6. Convenções de código

**Frontend**
- Monte DOM com `h("tag.classe", {atributos, onclick}, ...filhos)` de `util.ts`. Filhos `null`, `undefined` ou `false` são ignorados **no `h()`**, mas `replaceChildren()` **não** aceita `null`: use `""`.
- Ícones: `icon("pasta/nome")` (caminho dentro de `assets/icons`, sem `.svg`) ou um nome próprio de `icons.ts`. A variante `_dark` é escolhida sozinha e `setIconTheme()` atualiza os ícones ao trocar de tema. Para ícones de arquivo use `fileIcon(nome)`/`fileIconName(nome)`; para as tool windows, `twIcon(nome)`.
- **Cores só por variáveis CSS** do topo de `styles.css` (`--frame`, `--island`, `--card-border`, `--fg`, `--accent`, `--on-accent`, `--sel`, `--syn-*`…). Nunca coloque cor fixa num componente; os dois temas (e o vidro) precisam continuar funcionando. Texto ou ícone sobre um fundo `--accent` usa `--on-accent` / `filter: var(--on-accent-icon)`, nunca `#fff`: o lilás do tema escuro é claro. Texto fica acima de 4,5:1 nos dois temas. As cores de sintaxe ainda vêm do esquema `IslandSchemeDark` do intellij-community.
- Popups e menus: `contextMenu`, `dropdown` e `popupList` (com busca, seções e submenus via `children`). Para diálogos, use `modal` com `button`; para avisos, `toast` ou `notify` (com ações).
- Caminhos: **sempre** com barras `/` e normalizados por `P.norm()`. Compare com `P.same()`/`P.inside()` (sem diferenciar maiúsculas). Para o Windows (Explorer, argumentos que o usuário vê) use `P.win()`; para LSP, `P.uri()`/`P.fromUri()` (`file:///C:/...`).
- Textos de interface em **pt-BR** e atalhos nos keymaps **JetBrains** e **VS Code** (`keymap.ts`; veja 5.3). Atalho novo: registre em `Workbench.installKeys()`/`vscodeKey()` (global) ou no `keymap()` do `CodeEditor` (editor), e atualize as tabelas em `keymap.ts`.
- TypeScript `strict` e `noUnusedLocals`: o `tsc` precisa passar sem erros.

**Backend**
- Comandos Tauri retornam `Result<T, String>` com mensagens em pt-BR para o usuário. Exceção: os do Airflow retornam `AfError {kind, status, message}`, para a UI distinguir autenticação, permissão, servidor fora do ar e TLS. Todo comando novo precisa ser registrado em `generate_handler!` (`lib.rs`), ganhar um wrapper em `src/ide/host.ts` ou `src/api.ts` e, se usar uma API de janela ou webview, uma permissão em `capabilities/default.json`.
- Processos filhos sempre com `hidden()` (`CREATE_NO_WINDOW`), senão uma janela de console pisca.
- Nada de `unwrap()` em caminho que o usuário alcança; prefira `map_err(|e| e.to_string())`.
- Leitura de stream: use `read_text_chunks`/`read_rpc_messages`, que já tratam UTF-8 partido e mensagens fragmentadas e são testados.
- O release usa `opt-level = "s"`, `lto`, `strip` e `panic = "abort"` (`Cargo.toml`) para manter o exe pequeno. Não adicione dependências pesadas sem necessidade.

---

## 7. Receitas comuns

**Adicionar uma linguagem com LSP (ex.: Rust)**
1. `lang.ts`: entrada em `LANGS` e `EXT` (realce de sintaxe).
2. `lsp.ts`: estender `LspLang`, `command()` (como achar o binário), `settings()` e `lspLangFor()`.
3. `sdk.ts`: um `LangPlugin` em `PLUGINS` com `components` (check e install), que aparece sozinho em Configurações › Plugins.
4. `editors.ts`: marcadores ▶ em `runTargets()` se fizer sentido; `run.ts`: um tipo novo em `RunConfig` e em `command()`; `debug.ts`: os argumentos de `launch` do adaptador.
5. `icons.ts`: o ícone do tipo de arquivo.

**Adicionar uma tool window**: crie uma classe que recebe `wb`, chame `wb.register({...})` no construtor, instancie em `Workbench.mount()`, ponha o atalho em `installKeys()` e acrescente o item em "Exibir › Janelas de ferramentas", que é gerado sozinho.

**Adicionar um plugin opcional**: inclua uma entrada em `LAZY_PLUGINS` (`plugins.ts`) com um módulo que implemente `PluginHandle` (`dispose()` obrigatório, `newItems()` opcional) e, se precisar do editor, use `contribute()` (abrir arquivos, extensões CodeMirror, ir para definição, barra de ações). Para o card, use `optionalCard()` em `settings.ts`. O Airflow segue o padrão antigo: Um módulo de entrada leve (`enabled()`/`setEnabled()` no `localStorage`, que emitem `rits-plugins`), um card em Configurações › Plugins, o carregamento e o `dispose()` em `Workbench.syncPlugins()` e `unregister()` da tool window. O resto vai por `import()` dinâmico, para não pesar a IDE de quem não usa. O `dispose()` precisa parar timers, processos e requisições. Escreva o guia em `docs/<plugin>.md` (pt-BR, para o usuário), registre-o em `PLUGIN_DOCS` (`src/ide/docs.ts`, chave = id da tool window) e ponha a linha no `docs/README.md`: o botão "?" aparece sozinho no cabeçalho da janela.

**Adicionar uma ação**: inclua em `actions()` de `search.ts` (para aparecer em Ctrl+Shift+A e no Shift duplo) e, se couber, no `mainMenu()` de `workbench.ts`.

**Mudar o visual**: ajuste os tokens no topo de `styles.css` para os **dois** temas (e a seção Liquid Glass, se o token existir lá) e confira no app real (seção 3) com Rits Escuro e Rits Claro. Para mexer em CSS sem o Tauri, `npm run dev` e abra `/dev/ide-mock.html` (janela da IDE com um projeto fictício; `?os=mac` simula o macOS com o vidro sobre um papel de parede, `?theme=light`, `?glass=0`, `?welcome=1`).

---

## 8. Armadilhas conhecidas

- **O `@codemirror/lsp-client` é minimalista** (veja 5.4). Antes de "simplificar" `lsp.ts`, entenda `patchInitialize` e o tratamento de pedidos do servidor.
- **O Windows não diferencia maiúsculas em caminhos**: compare chaves sempre em minúsculas (`Editors.key`, `settings.breakpoints`).
- **CRLF**: os editores trabalham com LF. A conversão acontece só em `fs_read`/`fs_write`. Com `core.autocrlf=true`, o `git show HEAD:` devolve LF.
- **O `python` do PATH pode ser o atalho falso da Microsoft Store** (`WindowsApps`). `sdk.findInterpreters()` o ignora; nunca dependa de `python` sem caminho.
- **Ferramentas instaladas depois que o app abriu** não aparecem no PATH do processo. Por isso o `which`/PATH aumentado incluem as pastas padrão do Go e do Python.
- **`go run` cria um processo filho**: parar a execução exige matar a árvore (`kill_tree`), e já é assim.
- **`reqwest` 0.13 sem features padrão** não tem `.query()`: o cliente do Airflow monta a query com `encode_query` (`client.rs`). Para caminhos da API, codifique cada segmento (`encodeURIComponent`), porque os `run_id` têm `:` e `+`.
- **Nunca repita automaticamente uma ação do Airflow** (disparo, limpeza, pausa): um timeout não significa que o servidor não executou. A única repetição permitida é o novo login depois de um 401.
- **`docker compose config` imprime os segredos** injetados pelo ambiente: o `airflow_env_compose` não aceita esse subcomando. Não o libere.
- **O debugpy formata o JSON com espaços** (`"success": true`): faça parse do JSON, não compare strings.
- **Janela sem moldura**: arrastar usa `data-tauri-drag-region` e `startDragging()`; os botões minimizar, maximizar e fechar estão em `renderToolbar()`. Fechar passa por `prepareClose()` para não deixar processos órfãos.
- **Bundle grande (~1,5 MB de JS)**: é aceitável num app local; o aviso do Vite pode ser ignorado.
- **Mensagens do kernel Jupyter chegam fora de ordem**: `execute_reply` (shell) e `status: idle` (iopub) vêm em canais diferentes, e podem chegar antes de o `invoke` devolver o `msg_id`. Não "simplifique" `finishPart`/`early` em `notebook.ts`.
- **`tauri dev` recarrega a página a cada edição**: roteiros temporários de teste carregados pelo `main.ts` rodam de novo a cada recarga. Encerre o app antes de editar.
- **Migration Audit nunca compara o total global** nem transforma erro em zero: mantenha `volume_result` e os estados `not_verified`/`inconclusive` ao mexer no runner.

---

## 9. Antes de commitar

1. `npx tsc --noEmit -p .` sem erros.
2. `cd src-tauri && cargo build` sem warnings e `cargo test` verde. Se mexeu em banco, backup, LSP ou DAP, rode também os `--ignored` (seção 3).
3. Se mudou a interface, abra o app (`npm run tauri dev`) e confira o fluxo de verdade.
4. Não commite `node_modules/`, `dist/`, `src-tauri/target/` nem `src-tauri/gen/` (já estão no `.gitignore`), nem credenciais ou conexões de teste.
5. Atualize o `README.md` e o `README.en.md` (para o usuário, nos dois idiomas), o guia do plugin em `docs/` e este `AGENTS.md` (para quem programa) quando o comportamento ou a estrutura mudar.
