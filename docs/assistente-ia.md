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
- **Nova conversa** (`+`) começa do zero. A conversa de cada projeto é guardada e continua de onde parou, inclusive depois de reabrir a IDE.
- Trocar de agente no seletor não apaga a conversa: cada agente mantém a própria sessão.

## Modelo, versão e esforço

Os seletores no topo do painel valem a partir da próxima mensagem, sem perder a conversa (a sessão é retomada com as novas opções):

| Seletor | Claude Code | Codex |
|---|---|---|
| **Modelo** | **Sempre o mais recente** (Fable, Opus, Sonnet, Haiku: o alias acompanha a versão nova) ou **Versão fixa** (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5) | os modelos liberados para a sua conta, lidos do próprio CLI |
| **Outro modelo…** | qualquer nome completo ou alias aceito pelo `claude --model` | qualquer identificador aceito pelo `codex -m` |
| **Esforço** | baixo, médio, alto, muito alto ou máximo (`--effort`) | os níveis que o modelo escolhido suporta (`model_reasoning_effort`); o padrão do modelo aparece entre parênteses |

Mais esforço faz o modelo pensar mais antes de responder: fica mais lento e consome mais da sua cota. Para perguntas rápidas, use esforço baixo e um modelo menor.

A linha abaixo dos seletores mostra o que está em uso. No Claude Code, o nome exato do modelo (por exemplo `claude-opus-5-5`) é o que o próprio CLI informou na última resposta.

## Comandos e skills com `/`

Digite **/** no começo da mensagem para abrir a lista de comandos e skills. Ela filtra enquanto você digita; **↑ ↓** escolhem, **Enter** ou **Tab** inserem, **Esc** fecha.

| De onde vem | Claude Code | Codex |
|---|---|---|
| Projeto | `.claude/commands/*.md` (subpastas viram `pasta:nome`) e `.claude/skills/<skill>/SKILL.md` | `.agents/skills/<skill>/SKILL.md` e `.codex/skills` |
| Usuário | `~/.claude/commands` e `~/.claude/skills` | `~/.agents/skills`, `~/.codex/skills` e prompts em `~/.codex/prompts/*.md` |
| Plugins | skills e comandos dos plugins instalados (`plugin:nome`) | — |
| CLI | depois da primeira resposta, também os comandos internos que o Claude Code informa | — |

A descrição de cada item vem do campo `description` do arquivo. O que vier depois do nome vai como argumento: `/revisar src/pipeline.py`.

No Codex, o Rits traduz: uma skill vira `$nome` (o jeito do Codex de chamar uma skill) e um prompt salvo é expandido com `$ARGUMENTS` e `$1`…`$9` substituídos. **/clear** começa uma nova conversa nos dois.

## Arquivos com `@`

Digite **@** em qualquer ponto da mensagem para procurar um arquivo ou uma pasta do projeto (busca aproximada pelo nome; arquivos abertos aparecem primeiro). Escolher uma pasta mostra o conteúdo dela em seguida.

Ao enviar, cada arquivo mencionado vai junto com a pergunta, **com as alterações ainda não salvas** do editor. Arquivos binários ou muito grandes (acima de 60 mil caracteres) e pastas vão só como caminho e lista: o agente lê o que precisar com as ferramentas dele.

## Ditado (microfone)

Clique no **microfone** ao lado da caixa de texto e fale: o texto aparece enquanto você fala. Clique de novo para parar; **Enter** envia (e para o ditado). O botão direito no microfone escolhe o idioma (português do Brasil por padrão).

A transcrição usa o reconhecimento de fala do próprio sistema, sem baixar modelos e sem chave de API:

- **macOS**: o reconhecimento de fala do macOS. Na primeira vez, o sistema pede permissão para o **Microfone** e para o **Reconhecimento de Fala**. Quando o idioma tem reconhecimento no próprio Mac, o áudio não sai do computador.
- **Windows**: o reconhecimento de fala do Windows (ditado). Precisa de **Reconhecimento de fala online** ligado em Configurações › Privacidade e segurança › Fala, e do microfone liberado para aplicativos da área de trabalho.

O microfone só fica ligado enquanto o botão está vermelho.

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
| erro de esforço não suportado | escolha **Esforço: padrão** ou outro nível |
| `/` não mostra uma skill nova | troque de agente e volte, ou reabra o painel (a lista é lida uma vez por agente) |
| o ditado diz que não tem permissão | macOS: Ajustes do Sistema › Privacidade e Segurança › Microfone e Reconhecimento de Fala; Windows: Configurações › Privacidade e segurança › Fala e Microfone |
| o ditado não reconhece o idioma | botão direito no microfone e escolha o idioma; no Windows, instale o pacote de fala em Configurações › Hora e idioma › Fala |
| o agente não usa o contexto | peça explicitamente: "use as ferramentas do Rits" |
