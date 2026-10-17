# Assistente IA (Claude Code e Codex)

> Um chat dentro do Rits com o **seu** Claude Code ou o **seu** Codex, que enxerga o que a IDE enxerga.

## Para que serve

Para perguntar e pedir coisas sobre o trabalho aberto na IDE, sem copiar e colar contexto:

- "O que este projeto faz?"
- "Explique a função selecionada."
- "Quais tabelas existem no banco conectado e como `rental` se liga a `customer`?"
- "Por que a última execução do dbt falhou?"
- "A DAG `vendas_diarias` falhou ontem: leia o log e proponha a correção."
- "Escreva um teste para este arquivo."

## Como funciona

O Rits **não** tem um modelo próprio nem um servidor na nuvem. O plugin conversa com o **CLI oficial** que você já usa, com a sua conta e a sua assinatura:

| Agente | CLI | Login |
|---|---|---|
| **Claude Code** | `claude` (Anthropic) | assinatura Claude ou chave da API |
| **Codex** | `codex` (OpenAI) | conta ChatGPT ou chave da API |

O contexto da IDE chega ao agente por um **servidor MCP local** que o Rits abre em `127.0.0.1`, com um token por conversa. Ninguém fora do seu computador acessa esse servidor.

## Como ativar

1. **Configurações › Plugins › Inteligência artificial › Assistente IA › Instalar plugin**.
2. A janela **Assistente IA** aparece no painel da direita.
3. Se o CLI não for encontrado, o painel mostra o comando de instalação e um botão para rodá-lo no Terminal:
   - Claude Code: `npm install -g @anthropic-ai/claude-code` (ou o instalador nativo da Anthropic).
   - Codex: `npm install -g @openai/codex`. Sem instalação global, o plugin usa `npx @openai/codex`.
4. Faça login uma vez pelo botão **Fazer login…** (abre o CLI no Terminal).

## O que o agente vê

| Ferramenta | O que entrega |
|---|---|
| **Contexto da IDE** | projeto, arquivo ativo, cursor e seleção, arquivos e abas abertos, interpretador Python, branch e alterações do Git, plugins ativos |
| **Ler editor** | o conteúdo atual de um arquivo aberto, **inclusive alterações não salvas** |
| **Problemas** | erros e avisos dos servidores de linguagem |
| **Abrir no editor** | abre um arquivo numa linha para mostrar algo a você |
| **Conexões de banco** | as conexões do Database (sem senhas) |
| **Estrutura do banco** | tabelas, colunas, tipos e índices |
| **Consultar banco** | SQL em transação **somente leitura**, com limite de linhas e de tempo |
| **Airflow** | instâncias, DAGs, erros de importação, execuções e logs de tarefas |
| **dbt** | modelos, dependências e o resultado da última execução |
| **Notebooks** | células e saídas dos notebooks abertos |
| **Docker** | containers, estado e portas |
| **Migration Audit** | projetos e o resumo da última reconciliação |

Todas essas ferramentas são de **leitura**. O agente também lê e edita arquivos do projeto com as ferramentas do próprio CLI.

## Permissões

O seletor no topo do painel define o que o agente pode fazer:

| Modo | Claude Code | Codex |
|---|---|---|
| **Somente leitura** | só lê e responde (modo plano) | sandbox `read-only` |
| **Editar com aprovação** | cada edição ou comando aparece no chat com **Permitir**, **Sempre permitir nesta conversa** ou **Negar** | — |
| **Editar no projeto** | — | sandbox `workspace-write`: edita dentro da pasta do projeto |
| **Editar automaticamente** | aceita edições de arquivo sem perguntar; comandos ainda pedem aprovação | — |

No pedido de aprovação de uma edição, o chat mostra o trecho antigo e o novo.

## Usando o chat

- **Enter** envia; **Shift+Enter** quebra a linha. O botão vira **Parar** enquanto o agente trabalha.
- Os chips acima da caixa de texto mandam o **arquivo ativo** e a **seleção** junto com a pergunta. Clique para ligar ou desligar.
- Cada chamada de ferramenta aparece como um cartão recolhível, com a entrada e a saída.
- Blocos de código têm **Copiar** e **Inserir no cursor** do editor ativo.
- **Modelo**: o padrão da sua conta ou um modelo específico (a lista do Codex vem do próprio CLI).
- **Nova conversa** (`+`) começa do zero. A conversa de cada projeto é guardada e continua de onde parou, inclusive depois de reabrir a IDE.
- Trocar de agente no seletor não apaga a conversa: cada agente mantém a própria sessão.

## Privacidade

- O Rits não envia nada para servidores próprios. O que vai para a Anthropic ou para a OpenAI é o que o CLI de cada uma envia, nas condições da sua conta.
- Senhas de bancos e tokens do Airflow e do Jupyter **nunca** são entregues ao agente.
- As consultas do agente ao banco rodam em transação somente leitura, com até 2.000 linhas e 60 s.
- Desativar o plugin encerra os processos e invalida os tokens das conversas.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| "não foi encontrado" | instale o CLI e clique em **Verificar de novo** |
| erro de login ou 401 | **Fazer login…** e repita a pergunta |
| "modelo não suportado" | escolha outro modelo no seletor |
| o agente não usa o contexto | peça explicitamente: "use as ferramentas do Rits" |
