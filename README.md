# Rits

IDE leve para **Python**, **Go** e **bancos de dados** (PostgreSQL, MySQL/MariaDB), com a interface no estilo das IDEs JetBrains (tema *Islands*). Junta, numa única janela, o fluxo de código do PyCharm/GoLand, as ferramentas de banco do DataGrip e a simplicidade de backup/restore do DBeaver.

## Stack

| Camada | Tecnologia |
|---|---|
| Janela / runtime | Tauri 2 (WebView2 do Windows, sem Chromium embutido), janela sem moldura com barra própria |
| Backend | Rust: `tokio-postgres`, `mysql_async`, `portable-pty` (ConPTY), `notify`, `ignore`, `regex`, `trash` |
| Frontend | TypeScript puro + Vite, CodeMirror 6, `@codemirror/lsp-client`, `@codemirror/merge`, xterm.js |
| Linguagens | basedpyright, Ruff, debugpy e pytest (Python); gopls, Delve e staticcheck (Go) |

O backend é genérico: lista e lê arquivos, faz busca, observa o disco, inicia processos com framing JSON-RPC (LSP/DAP por stdio ou TCP) e abre terminais PTY. Toda a lógica da IDE fica no frontend (`src/ide/`), na mesma arquitetura que o VS Code usa (servidores de linguagem e adaptadores de depuração).

## Funcionalidades

**Janela e projetos**
- Barra principal com **widget de projeto**: projetos recentes, novo projeto, abrir, clonar repositório e fechar. Ao trocar de projeto, pergunta se abre nesta janela ou numa nova.
- **Widget de branch**: atualizar (pull), commit, push, novo branch, checkout, merge, renomear e excluir branches locais e remotos.
- **Widget de execução**: configurações de execução, ▶ executar, 🐞 depurar e ■ parar.
- Tela de boas-vindas, Novo projeto (Python com `.venv`, Go com `go mod init`, vazio, com Git opcional) e Clonar repositório.
- Tool windows nas faixas laterais: Projeto, Commit, Estrutura, Database, Run, Debug, Terminal, Problemas, Git, Services, Find. Todas redimensionáveis e móveis entre esquerda, direita e baixo.
- Barra de status com breadcrumbs, linha:coluna, LF/CRLF, encoding, indentação, status do servidor de linguagem e interpretador/SDK.
- Temas Islands Dark e Islands Light.

**Editor**
- Autocomplete, diagnósticos ao vivo, hover (Ctrl+Q), assinatura (Ctrl+P), ir para definição/implementação (Ctrl+B / Ctrl+Clique), encontrar usos (Alt+F7), renomear (Shift+F6), ações de contexto e quick fixes (Alt+Enter).
- Reformatar código (Ruff no Python, gofmt via gopls no Go), otimizar imports, auto-save, e gofmt ao salvar opcional.
- Gutter com breakpoints, ▶ para rodar `main`/`__main__` e testes, e marcas de alteração do Git.

**Executar, testar e depurar**: Python, pytest, `go run` e `go test`, com saída colorida, links clicáveis em tracebacks e stdin. O depurador (debugpy/Delve) tem frames, variáveis expansíveis, step over/into/out, avaliação de expressões e console.

**Git**: commit com seleção de arquivos e amend, push/pull/fetch, log com detalhes, diff lado a lado com HEAD, reverter, `.gitignore` e clone.

**Navegação**: Buscar em tudo (Shift duplo), arquivos (Ctrl+Shift+N), símbolos (Ctrl+N), ações (Ctrl+Shift+A), localizar nos arquivos com preview (Ctrl+Shift+F), arquivos recentes (Ctrl+E), estrutura (Ctrl+F12) e ir para linha (Ctrl+G).

**Plugins** (Configurações › Plugins): mostram o status de cada componente e instalam ou atualizam com um clique. No Python os componentes vão no interpretador do projeto; no Go, no GOPATH.

**Database Tools**: explorador de conexões, console SQL com autocomplete, editor de dados com DML e preview, DDL, exportação, e backup/restore via `pg_dump`/`pg_restore`/`psql`/`mysqldump`/`mysql`.

## Desenvolvimento

```bash
npm install
npm run tauri dev
```

Build de release (exe e instalador NSIS em `src-tauri/target/release/bundle/nsis`):

```bash
npm run tauri build
```

Testes do backend:

```bash
cd src-tauri && cargo test
```

Os testes marcados com `--ignored` precisam do Docker (Postgres e MySQL de teste, com dados em `src-tauri/tests/fixtures`) e das ferramentas de linguagem instaladas. O passo a passo está no [AGENTS.md](AGENTS.md), que também é o guia completo de arquitetura e convenções para quem for programar no projeto.

## Créditos e licenças

- Os ícones em `src/assets/icons` e as cores dos temas vêm do projeto [IntelliJ Community](https://github.com/JetBrains/intellij-community), sob Apache 2.0 (veja `src/assets/icons/LICENSE-intellij-community.txt`). O nome e o logo do Rits são próprios. Nenhum código, binário ou asset do DataGrip foi usado.
- Fontes Inter e JetBrains Mono, sob SIL Open Font License.

## Observações

- As conexões de banco ficam em `%APPDATA%\dev.rits.ide\connections.json`, **com as senhas em texto puro**.
- O primeiro carregamento do gopls num projeto pode levar alguns segundos enquanto ele indexa os pacotes.
