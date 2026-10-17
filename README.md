<p align="center">
  <img src="assets/logo.svg" alt="Rits" width="128" height="128">
</p>

<h1 align="center">Rits</h1>

<p align="center">
  <b>A IDE leve para engenharia de dados.</b><br>
  Código Python e Go, SQL em nove bancos (e compatíveis), diagramas ER, Airflow, dbt, Jupyter, Docker e um assistente de IA com o contexto de tudo isso, numa janela só.
</p>

<p align="center">
  <a href="https://github.com/hugaojanuario/rits/releases/latest"><img alt="Última versão" src="https://img.shields.io/github/v/release/hugaojanuario/rits?label=vers%C3%A3o&color=A08CFF"></a>
  <img alt="Plataformas" src="https://img.shields.io/badge/plataformas-Windows%2011%20%7C%20macOS%20Apple%20Silicon-555">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB">
  <a href="LICENSE"><img alt="Licença MIT" src="https://img.shields.io/badge/licen%C3%A7a-MIT-green"></a>
</p>

<p align="center">
  <b>Português</b> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/hugaojanuario/rits/releases/latest/download/Rits-windows-x64-setup.exe">Baixar Windows x64</a> ·
  <a href="https://github.com/hugaojanuario/rits/releases/latest/download/Rits-macos-arm64.dmg">Baixar macOS Apple Silicon</a> ·
  <a href="https://github.com/hugaojanuario/rits/releases/latest">Releases</a>
</p>

---

**Sumário:** [O que é](#o-que-é-o-rits) · [Para quem é](#para-quem-é) · [Plugins](#plugins) · [Destaques](#destaques) · [Instalação](#instalação) · [Primeiros passos](#primeiros-passos) · [Atalhos](#atalhos-principais) · [Arquitetura](#arquitetura) · [Desenvolvimento](#desenvolvimento) · [Privacidade](#dados-e-privacidade)

## O que é o Rits

Um dia de trabalho de engenharia de dados costuma passar por várias ferramentas: o PyCharm para o pipeline em Python, o DataGrip ou o DBeaver para consultar o banco, o Docker Desktop para subir o Postgres local, um terminal para o `terraform plan` e mais um para o `kubectl`.

O **Rits** junta esse fluxo numa IDE desktop rápida e leve:

- **Escreva o pipeline** em Python ou Go, com autocomplete de verdade, depurador, testes e Git.
- **Consulte e explore os dados** em PostgreSQL, MySQL, SQL Server, Oracle, ClickHouse, DuckDB, SQLite, Firebird, MongoDB e compatíveis (CockroachDB, Supabase, Redshift…).
- **Entenda o modelo** com diagramas ER gerados do banco, com relações, chaves e layout automático.
- **Suba a infraestrutura** com Docker, Compose, Terraform e Kubernetes direto do editor.
- **Orquestre e transforme** com Apache Airflow, projetos dbt e notebooks Jupyter, e **audite migrações de dados** entre bancos (plugins opcionais).
- **Converse com o seu Claude Code ou Codex** num chat dentro da IDE que enxerga o projeto, os bancos, as DAGs e o resto do que está aberto.

Tudo com o visual próprio do Rits (layout *Blocos*: abas no topo, painéis em cartões e uma tela de início para cada projeto) e, no macOS, com o **Liquid Glass** nativo.

> **Leve de verdade:** o Rits usa o WebView do sistema (Tauri 2), sem Chromium embutido. O app tem cerca de **7 MB**, e os drivers de banco só são baixados quando você usa aquele banco.

## Para quem é

- **Engenheiros de dados** que escrevem ETL/ELT em Python ou Go e passam o dia entre código e SQL.
- **Analytics engineers** que exploram schemas, comparam bancos e precisam ver o modelo de dados.
- **Times de plataforma de dados** que mantêm a infraestrutura (Postgres no Docker, Terraform, manifestos Kubernetes) junto do código.

## Plugins

O núcleo do Rits é leve. Cada integração pesada é um **plugin opcional**, ativado em Configurações › Plugins: desativado, não carrega código nem faz requisições. Cada janela de plugin tem um botão **?** que abre o guia dentro da IDE.

| Plugin | O que faz | Guia |
|---|---|---|
| **Assistente IA** | chat com o seu Claude Code ou Codex, com o contexto da IDE (projeto, bancos, Airflow, dbt, notebooks, Docker) | [assistente-ia.md](docs/assistente-ia.md) |
| **Migration Audit** | auditoria determinística de conversões de dados entre bancos, com baseline, reconciliação e relatório | [migration-audit.md](docs/migration-audit.md) |
| **Apache Airflow** | DAGs, execuções e logs de um Airflow 3, e um ambiente local com Docker | [airflow.md](docs/airflow.md) |
| **dbt** | comandos com seleção e prévia do alcance, resultados, linhagem e `ref()` navegável | [dbt.md](docs/dbt.md) |
| **Jupyter** | notebooks `.ipynb` no editor, com kernel local, remoto ou JupyterLab no Docker | [jupyter.md](docs/jupyter.md) |
| **Docker** | containers, imagens e volumes, logs e shell no container | [docker.md](docs/docker.md) |
| **Python · Go · Infraestrutura (IaC)** | servidores de linguagem, formatadores, depuradores e linters, instalados com um clique | — |

## Destaques

### Bancos de dados

| Banco | Driver |
|---|---|
| PostgreSQL, MySQL / MariaDB | incluído no app |
| SQL Server, Oracle, Firebird, SQLite, DuckDB, ClickHouse, MongoDB | baixado na primeira conexão* |
| CockroachDB, TimescaleDB, Supabase / Neon, TiDB, Amazon Redshift | presets dos drivers acima |

<sub>* Como no DataGrip e no DBeaver, o driver é baixado ao testar ou salvar a primeira conexão daquele banco, e só uma vez. Os drivers rodam num ambiente Python privado do Rits, então é preciso ter o **Python 3.9+** instalado.</sub>

- **Explorador** de conexões → bancos → schemas → tabelas, views, funções, sequências e triggers.
- **Console SQL** com autocomplete de tabelas e colunas, várias instruções por execução, transação manual, cancelamento de query, EXPLAIN e histórico.
- **Editor de dados** paginado, com filtro e ordenação, edição inline, preview do SQL gerado e gravação em transação.
- **Diagrama ER**: cartões de tabela com PK/FK e tipos, ligações com cardinalidade, layout automático, minimapa, busca, pan/zoom (pinça no trackpad), exportação para **SVG** e cópia como **Mermaid**.
- **MongoDB** com comandos no estilo `mongosh` (`db.pedidos.find({status: "pago"}).limit(20)`) e relações inferidas no diagrama.
- **Exportação de resultados** em CSV, TSV, Excel (.xlsx), JSON, JSON Lines, XML, `INSERT` SQL, Markdown e HTML: da página visível ou do **resultado completo**, transmitido direto para o arquivo em transação somente leitura, com progresso e cancelamento. Também copia para a área de transferência em qualquer formato.
- **DDL** e **backup/restore** com `pg_dump`/`pg_restore`/`mysqldump`.
- **Conexões por projeto**: cada conexão aparece só no projeto em que foi criada, a menos que você a marque como global.

### Código

- **Python** (basedpyright, Ruff, debugpy, pytest) e **Go** (gopls, Delve, staticcheck), instalados com um clique em Configurações › Plugins.
- **Autocomplete no estilo JetBrains**: relevância do servidor de linguagem, documentação ao lado, **importação automática** ao aceitar, Tab ou Enter. Tab aceita a sugestão selecionada nos editores de código e SQL; sem sugestão, mantém a indentação. Liga e desliga em Configurações › Editor.
- Ir para definição, encontrar usos, renomear, quick fixes, reformatar e otimizar imports.
- Executar e depurar com breakpoints, variáveis, step e console; ▶ no gutter para `main` e testes.
- **Git** completo: commit, push/pull, branches, log, diff lado a lado.
- Terminal real (PTY) com o venv do projeto ativado.

### Apache Airflow (plugin)

- Conexão nativa com a **API pública do Airflow 3** (`/api/v2`), sem painel web embutido nem scraping. Suporta várias instâncias locais ou remotas, com teste de conexão e detecção de versão.
- **DAGs** com busca, filtro por tags e estado, pausar e reativar, e disparar com configuração JSON.
- **Execuções**: histórico, grafo de tarefas colorido pelo estado, **logs ao vivo** por tentativa e reexecução de tarefas mostrando antes o que será afetado.
- **Erros de importação** das DAGs, com atalho para o arquivo local.
- **Ambiente local com Docker** em um clique: Airflow 3.3.2 com Postgres, porta só em localhost, usuário com senha aleatória e cadastro automático na IDE. É **só para desenvolvimento**.
- **Projeto ↔ Airflow**: nova DAG a partir de modelo, pasta de DAGs montada no ambiente local ou publicada pelo seu fluxo Git, e aviso de quando o Airflow processou o arquivo salvo.
- **Autocomplete das DAGs**: a IDE oferece instalar o `apache-airflow-task-sdk` (a versão do Airflow 3.3.2) no interpretador do projeto, de preferência um `.venv`, para o editor conhecer o `airflow.sdk`.
- Senhas e tokens ficam no **cofre do sistema** (Keychain / Credential Manager), e as chamadas passam pelo backend da IDE com TLS validado.

Limitações: requer Airflow 3 (o Airflow 2 é detectado e recusado); o ambiente local precisa do Docker com cerca de 4 GB de RAM e baixa ~3,2 GB de imagens na primeira vez; o painel web oficial abre numa janela separada ou no navegador.

Guia completo: [docs/airflow.md](docs/airflow.md).

### Jupyter (plugin)

- Notebooks `.ipynb` (nbformat 4) no **editor da própria IDE**: células Python e Markdown, executar célula, executar daqui em diante e executar tudo, com contadores e ordem das saídas preservados. Células, metadados e saídas desconhecidas são mantidos ao salvar.
- Saídas: texto, tabelas (pandas), imagens e gráficos (matplotlib), erros com traceback colorido. HTML e JavaScript de notebooks **não confiáveis** não são executados; saídas ativas confiáveis rodam isoladas num iframe sem acesso à IDE.
- **Kernel**: escolha do servidor e do kernel, estado (ocioso/ocupado), interromper e reiniciar (com aviso de que as variáveis se perdem). Ao reconectar, a IDE consulta o estado real e **nunca reexecuta células**.
- **Servidores**: Jupyter Server local ou remoto com token (guardado no Keychain / Credential Manager), teste de conexão, arquivos do servidor e kernels em execução. Ou um **JupyterLab local no Docker** com imagem fixada (`quay.io/jupyter/scipy-notebook:2026-10-12`, JupyterLab 4.6.4), pasta do projeto montada em `/home/jovyan/work`, porta só em `127.0.0.1` e token aleatório.
- Autocomplete vem do **próprio kernel** (o ambiente do servidor, que pode ser diferente do Python da IDE); com o Ruff instalado, erros de sintaxe e nomes indefinidos aparecem nas células.
- **Abrir no JupyterLab** (janela separada da IDE ou navegador) como complemento.

Validado com Jupyter Server 2.21.1 / JupyterLab 4.6.4. Limitações: widgets interativos (ipywidgets) e LaTeX em Markdown não são renderizados (use o JupyterLab); autenticação por senha do Jupyter não é suportada (use token); desativar o plugin fecha as conexões da IDE, mas não para servidores nem kernels.

Guia completo: [docs/jupyter.md](docs/jupyter.md).

### dbt (plugin)

- Detecta projetos pelo `dbt_project.yml` e cria novos com o comando oficial `dbt init`.
- Executa o **dbt Core** de um ambiente Python do projeto ou da imagem Docker oficial (`ghcr.io/dbt-labs/dbt-postgres:1.9.0`). **Nada é instalado globalmente**; há um botão explícito para instalar o dbt no `.venv` do projeto.
- `debug`, `deps`, `parse`, `compile`, `run`, `test`, `build`, `docs generate` e visualização da documentação, com seleção (modelo, `+modelo+`, `tag:`, `path:`…), exclusão, target, `--vars`, threads e `--full-refresh` explícito.
- Antes de comandos que alteram o banco, a IDE mostra o **target e o alcance** (via `dbt ls`) e o impacto do full refresh. Os comandos usam argumentos estruturados (sem shell), um por vez em cada projeto, com log ao vivo, estado por nó, duração, código de saída e cancelamento.
- **Perfis PostgreSQL gerenciados**: o `profiles.yml` fica na pasta de configuração do Rits, fora do repositório, sem senhas — elas vêm do cofre do sistema ou de uma conexão PostgreSQL do Rits e entram como variável de ambiente só durante a execução. Variáveis de ambiente do projeto (`env_var()`) também podem ser secretas. Outros adapters funcionam com o seu próprio `profiles.yml`.
- Lê `manifest.json` e `run_results.json` (com checagem de versão do schema e aviso de resultados antigos), mostra falhas que abrem o arquivo, linhagem, SQL compilado, navegação por `ref()`/`source()` com Ctrl/⌘+clique, realce de Jinja e modelos de arquivo (modelo, sources, testes, teste unitário, seed, snapshot).

Validado com dbt Core 1.12.6 e dbt-postgres 1.11.0 (artefatos manifest v12, run_results v6). O dbt v2 é detectado e avisado, mas não foi validado. O grafo de dependências não é um agendador: execuções periódicas ficam com o Airflow ou outro orquestrador.

Guia completo: [docs/dbt.md](docs/dbt.md).

### Migration Audit (plugin)

Auditoria de **conversões de dados** entre um banco de origem e um de destino, por lógica **determinística** (SQL, metadados, regras explícitas e comparação de evidências — sem IA). O plugin audita: não executa a conversão nem corrige dados, e nunca escreve nos bancos auditados.

- Fluxo: projeto → escopo → descoberta estrutural → mapeamento (sugestões com critérios, que só valem depois de confirmadas) → **baseline imutável** da origem → conversão por fora → **reconciliação** → relatório. Cada reconciliação vira uma execução nova; o histórico é preservado.
- Comparação por **unidade de reconciliação** (nunca pelo total global), com dimensões separadas: **volume, identidade, campos e relacionamentos**. Resultados: compatível no escopo verificado, divergente, inconclusivo ou não verificado.
- Identidade por chave preservada, de negócio ou composta, **mapa de IDs** (`id_origem → id_destino`) ou conteúdo. Detecta ausentes, extras, duplicados, multiplicidade, chaves nulas, colisões introduzidas por normalização e problemas do mapa.
- Campos: separa campo não mapeado, **perda de preenchimento**, valor criado e valor divergente; regras explícitas (trim, maiúsculas, Unicode, vazio = nulo, datas em texto, fuso fixo, precisão, escala, tolerância, JSON, booleanos, mapa de valores). Por padrão nada é normalizado, nulo nunca vira zero e decimais nunca passam por ponto flutuante.
- Relacionamentos: órfãos e **preservação da associação original** (uma FK válida pode apontar para a entidade errada).
- Baseline com manifesto JSON e digest, evidências ordenadas em disco (ordenação externa, memória limitada) com SHA-256; detecta arquivos ausentes, truncados ou alterados. Snapshot consistente quando o banco permite.
- Relatório navegável (unidade → tipo → identidades paginadas, valores sensíveis mascarados) e exportação: relatório HTML autocontido, manifesto JSON, resumo CSV e listas completas em CSV (com proteção contra fórmulas).

Bancos: PostgreSQL, MySQL, MariaDB, SQL Server e Firebird — todos validados com testes de integração reais (PostgreSQL 17, MySQL 8.4, MariaDB 11.8, SQL Server 2022, Firebird 5). Limitações: MongoDB fica fora desta versão; no SQL Server as consultas personalizadas não rodam em transação somente leitura (use um login somente leitura) e o snapshot exige `ALLOW_SNAPSHOT_ISOLATION`; fusos com horário de verão não são suportados nas regras (só deslocamentos fixos); relações 1:N e N:1 exigem conjuntos normalizados por consulta para comparação completa.

Guia completo: [docs/migration-audit.md](docs/migration-audit.md).

### Assistente IA: Claude Code e Codex (plugin)

Um **chat dentro da IDE** com o seu Claude Code ou o seu Codex, como as extensões oficiais do VS Code, mas com o contexto de tudo o que está aberto no Rits.

- Usa o **CLI oficial e a sua conta** (assinatura ou chave da API). O Rits não tem servidor próprio: nada passa por ele.
- O agente enxerga a IDE por um **servidor MCP local** (`127.0.0.1`, token por conversa): projeto, arquivo ativo, seleção e alterações não salvas, problemas do LSP, Git, **bancos conectados** (estrutura e consultas em transação somente leitura), **DAGs, execuções e logs do Airflow**, resultados do **dbt**, células dos **notebooks**, containers do **Docker** e auditorias do **Migration Audit**. Senhas e tokens nunca são entregues.
- Respostas em streaming, cartões com cada ferramenta usada, blocos de código com **Copiar** e **Inserir no cursor**, arquivo ativo e seleção anexados com um clique.
- Permissões: somente leitura, **editar com aprovação** (cada edição ou comando do Claude Code aparece no chat com o diff e os botões Permitir/Negar) ou editar automaticamente. A conversa de cada projeto continua de onde parou.

Guia completo: [docs/assistente-ia.md](docs/assistente-ia.md).

### Infraestrutura

- **Docker**: gerenciador de containers (plugin opcional), com containers agrupados por projeto do Compose, iniciar/parar/reiniciar, logs, shell no container, CPU e memória ao vivo, imagens e volumes.
- **Docker Compose, Dockerfile, Terraform e Kubernetes**: realce, autocomplete e validação por schema, mais uma barra de ações no topo do arquivo (`compose up/down/logs`, `terraform plan/apply/validate`, `kubectl apply/diff`, `docker build`).
- **Modelos prontos** em Novo › Dockerfile, Compose, Terraform e Kubernetes.

### Experiência

- Layout **Blocos**: abas dos arquivos na barra de título, painéis em cartões com um seletor de janelas de ferramentas, botões para mostrar ou esconder cada painel e uma barra de status discreta.
- **Tela de início do projeto**: atalhos, o que foi encontrado no projeto (Compose, Dockerfile, Terraform, testes) com a ação certa para cada um, Executar e uma barra de comando que busca em tudo ou roda um comando no terminal (Tab alterna).
- Janelas de ferramentas (inclusive as dos plugins) movidas entre os painéis esquerdo, direito e inferior **arrastando o ícone** ou pelo botão direito; a posição vale para todos os projetos.
- **Atualizações pelo próprio app**: quando há uma versão nova, aparece um botão na barra de título; o instalador é baixado do GitHub, conferido pelo SHA-256 e instalado, e o Rits reabre na versão nova.
- Keymaps **VS Code** (padrão no macOS) e **JetBrains**, com os atalhos exibidos com ⌘⌥⇧ no Mac.
- Temas Rits Escuro e Rits Claro, com o lilás da marca como cor de destaque, e **Liquid Glass** no macOS 26 (vibrancy nas versões anteriores).
- Interface toda em português.

## Instalação

### macOS (Apple Silicon)

A forma mais simples é uma linha no Terminal: baixa a última versão, instala em Aplicativos e libera o app.

```bash
curl -fsSL https://raw.githubusercontent.com/hugaojanuario/rits/main/scripts/install-macos.sh | bash
```

Ou [baixe o DMG para Apple Silicon](https://github.com/hugaojanuario/rits/releases/latest/download/Rits-macos-arm64.dmg), arraste o Rits para Aplicativos e rode no Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Rits.app
```

O Rits tem assinatura ad-hoc e não é notarizado pela Apple; sem esse comando, o macOS mantém o app em quarentena (avisos ao abrir e execução a partir de uma cópia temporária, o que impede as atualizações). Se esquecer, a própria IDE avisa e oferece copiar o comando. As atualizações feitas pelo Rits já liberam o app sozinhas.

As ferramentas de linguagem e de banco vêm do Homebrew:

```bash
brew install python go libpq mysql-client
```

### Windows 11

[Baixe o instalador para Windows x64](https://github.com/hugaojanuario/rits/releases/latest/download/Rits-windows-x64-setup.exe) e execute. O WebView2 é instalado automaticamente se necessário. A [página da release](https://github.com/hugaojanuario/rits/releases/latest) também traz `SHA256SUMS.txt` para conferir os downloads.

Os plugins também encontram ferramentas nas pastas padrão do npm e WinGet, mesmo quando instaladas depois de abrir a IDE. O Docker Desktop pode estar instalado só para seu usuário ou em Program Files. As ações de infraestrutura funcionam no PowerShell 5.1 e 7, inclusive com nomes de arquivo que contêm espaços e caracteres especiais. O Liquid Glass é exclusivo do macOS; no Windows, use Rits Escuro ou Rits Claro.

## Primeiros passos

1. **Abra uma pasta** ou crie um projeto (Python com `.venv`, Go com `go mod init`, ou vazio).
2. **Instale os plugins** que for usar em Configurações › Plugins: Python, Go, Infraestrutura (IaC), Docker, Apache Airflow, Jupyter, dbt, Migration Audit ou Assistente IA.
3. **Conecte um banco**: abra a janela Database (Alt+2, ou ⌥2 no Mac), clique em **+**, escolha o banco e preencha a conexão.
4. **Veja o modelo**: clique direito no schema › **Diagrama ER**.
5. **Suba a infra**: crie um `compose.yaml` em Novo › docker-compose.yml e clique em **Subir** na barra do editor.
6. **Pergunte à IA**: com o Assistente IA ativo e o CLI do Claude Code ou do Codex logado, pergunte "quais tabelas existem no banco conectado?" ou "explique o arquivo aberto".

## Atalhos principais

| Ação | VS Code (padrão no Mac) | JetBrains |
|---|---|---|
| Paleta de comandos | ⌘⇧P | Ctrl+Shift+A |
| Abrir arquivo | ⌘P | Ctrl+Shift+N |
| Mostrar/ocultar barra lateral / painel | ⌘B / ⌘J | Alt+1 (Projeto) / Shift+Esc (ocultar) |
| Terminal | ⌃` | Alt+F12 |
| Ir para definição / usos | F12 / ⇧F12 | Ctrl+B / Alt+F7 |
| Renomear | F2 | Shift+F6 |
| Depurar / executar | F5 / ⌃F5 | Shift+F9 / Shift+F10 |

O esquema muda em Configurações › Keymap, onde fica a lista completa.

## Arquitetura

| Camada | Tecnologia |
|---|---|
| Janela / runtime | Tauri 2 (WebView2 no Windows, WKWebView no macOS) |
| Backend | Rust: `tokio-postgres`, `mysql_async`, `portable-pty`, `notify`, `ignore` |
| Drivers sob demanda | processo Python privado (`python-tds`, `oracledb`, `firebirdsql`, `duckdb`, `clickhouse-connect`, `pymongo`) |
| Frontend | TypeScript sem framework + Vite, CodeMirror 6, xterm.js |
| Linguagens | servidores LSP e adaptadores DAP (basedpyright, gopls, terraform-ls, yaml-language-server, debugpy, Delve) |

O backend é genérico: arquivos, processos (LSP/DAP via JSON-RPC), terminais e bancos. A lógica da IDE fica no frontend (`src/ide/`). O guia completo para quem for programar no projeto está no **[AGENTS.md](AGENTS.md)**.

## Desenvolvimento

Pré-requisitos: Node 22+, Rust stable e, no Windows, o Visual Studio Build Tools (C++). No macOS, os Xcode Command Line Tools.

```bash
npm install
npm run tauri dev       # modo desenvolvimento com hot reload
npm run tauri build     # app de release (.app/.dmg no macOS, instalador NSIS no Windows)
npx tsc --noEmit -p .   # checagem de tipos
cd src-tauri && cargo test
```

A cada push e pull request, o workflow de CI roda a checagem de tipos, o build do frontend, o `cargo build` sem warnings e o `cargo test` no **Windows** e no **macOS**. Os testes de integração (`cargo test -- --ignored`) usam Postgres e MySQL no Docker e as ferramentas de linguagem; o passo a passo está no [AGENTS.md](AGENTS.md#3-como-rodar-compilar-e-testar).

## Dados e privacidade

- As conexões ficam em `connections.json` na pasta de configuração do app (`~/Library/Application Support/dev.rits.ide` no macOS, `%APPDATA%\dev.rits.ide` no Windows). **As senhas ainda são guardadas em texto puro**; a integração com o Keychain e o Credential Manager está pendente.
- Os drivers baixados ficam em `drivers/` na mesma pasta e podem ser apagados quando quiser (são baixados de novo quando necessário).
- Tokens do Jupyter, senhas dos perfis do dbt e segredos do Airflow ficam no cofre do sistema. Projetos, baselines e evidências do Migration Audit ficam em `migration-audit/` na pasta de configuração (fora dos repositórios) e podem conter dados das tabelas auditadas; exclua-os pelo próprio plugin.
- **Assistente IA**: o Rits não fala com nenhum provedor de IA; quem fala é o CLI oficial (Claude Code ou Codex), com a sua conta. O contexto da IDE chega ao CLI por um servidor local em `127.0.0.1`, com um token por conversa. Senhas e tokens nunca são entregues ao agente, e as consultas dele ao banco rodam em transação somente leitura.
- **Atualizações**: o Rits consulta a API de releases do GitHub ao abrir e a cada 6 horas. Desligue em Configurações › Sobre.
- O Rits não envia telemetria.

## Créditos e licença

- Código sob a licença [MIT](LICENSE).
- Os ícones em `src/assets/icons` e as cores de sintaxe do editor vêm do [IntelliJ Community](https://github.com/JetBrains/intellij-community) (Apache 2.0; veja `src/assets/icons/LICENSE-intellij-community.txt`). O nome, a logo do Rits e os demais ícones são próprios. Nenhum código ou asset de produtos comerciais da JetBrains foi usado.
- Docker, PostgreSQL, MySQL, SQL Server, Oracle, MongoDB, Terraform e Kubernetes são marcas de seus respectivos donos; os ícones são desenhos simplificados para identificar cada integração.
- Fontes Figtree e JetBrains Mono (SIL Open Font License).
