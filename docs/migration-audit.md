# Migration Audit

> Auditoria de conversões de dados entre bancos, com evidências. Plugin opcional do Rits, de autoria própria.

O **Migration Audit** responde, com provas, a uma pergunta que toda migração de sistema deixa no ar: **os dados que estavam na origem chegaram ao destino, completos e corretos?**

Ele não converte nada nem corrige dados. Ele **audita**: lê a origem e o destino em modo somente leitura, compara com regras explícitas e produz um relatório que diz o que foi verificado, o que divergiu, o que não foi possível verificar e por quê.

- **Determinístico**: o mesmo dado com as mesmas regras sempre dá o mesmo resultado. Não usa IA nem heurísticas escondidas.
- **Somente leitura**: nunca escreve nos bancos auditados. Usa conexões próprias, separadas das abas e do explorador da IDE.
- **Com evidências**: cada conclusão aponta para arquivos de evidência com tamanho e SHA-256, guardados fora do projeto.
- **Honesto sobre limites**: uma estimativa nunca aprova uma tabela, e um registro ambíguo nunca é escolhido "no chute".

---

## Quando usar

- Migração de um ERP legado (Firebird, SQL Server) para PostgreSQL ou MySQL.
- Troca de banco com remodelagem: tabelas divididas ou unidas, chaves novas, campos renomeados, códigos traduzidos.
- Cargas repetidas (ensaios de migração): comparar cada ensaio com a mesma baseline.
- Homologação com o cliente: entregar um relatório que mostra o escopo verificado, e não só "deu certo".

## Bancos suportados

| Banco | Papel | Leitura consistente |
|---|---|---|
| PostgreSQL | origem e destino | snapshot exportado (`pg_export_snapshot`), compartilhado entre os workers |
| MySQL / MariaDB | origem e destino | `START TRANSACTION WITH CONSISTENT SNAPSHOT` por conexão (com concorrência maior que 1, cada conexão tem o seu) |
| SQL Server | origem e destino | transação `SNAPSHOT` (exige `ALLOW_SNAPSHOT_ISOLATION`) |
| Firebird | origem e destino | transação `SNAPSHOT READ ONLY` |

SQL Server e Firebird usam o driver sob demanda do Rits (instalado na primeira conexão). A matriz completa aparece no plugin, em **Bancos suportados e capacidades**.

---

## Como ativar

1. **Configurações › Plugins › Dados › Migration Audit › Instalar plugin**.
2. A janela **Migration Audit** aparece no painel da direita (você pode arrastá-la para outro painel).
3. Cadastre as conexões de origem e de destino no **Database** (Alt+2), se ainda não existirem.

Desativar o plugin encerra as tarefas e conexões dele. Projetos, baselines e execuções continuam guardados.

---

## O fluxo em 8 passos

Cada projeto de auditoria abre numa aba com oito etapas. Você pode voltar a qualquer uma; o plugin avisa quando algo depende de uma etapa anterior.

### 1. Projeto

Dê um nome (ex.: "Conversão do ERP legado"), escolha a **conexão e o banco de origem** e a **conexão e o banco de destino**. Você pode guardar uma descrição e observações: lote, watermark, janela de congelamento.

### 2. Escopo

Diga o que entra na auditoria:

- **Schemas** (no MySQL, bancos).
- **Tabelas técnicas, de auditoria ou histórico**: padrões `LIKE` separados por vírgula para ficarem de fora.
- **Incluir views**: são contadas separadamente, para não haver dupla contagem.
- **Tabelas não convertidas intencionalmente**: ficam marcadas como fora do escopo, com justificativa, e aparecem assim no relatório.

### 3. Estrutura

**Executar descoberta estrutural** lê só metadados (nenhum dado é lido): tabelas, colunas, tipos, chaves primárias, chaves estrangeiras e estimativas de linhas do catálogo.

O plugin mostra **alertas estruturais**: riscos, não perdas comprovadas. Por exemplo, colunas mais curtas no destino, precisão decimal menor ou datas sem fuso.

### 4. Mapeamento

Aqui você diz **o que corresponde a quê**. A unidade de trabalho é a **unidade de reconciliação**: um conjunto da origem, um conjunto do destino e a regra de identidade entre eles.

- **Sugerir unidades** propõe pares por nome: tabelas iguais e prefixos removidos (configurável). Um dicionário de aliases cobre nomes diferentes (`origem=destino`, um por linha).
- **Confirmar sugestões**: nada é auditado sem confirmação. Cada unidade mostra quem sugeriu.
- **Conjunto** pode ser uma tabela ou uma **consulta somente leitura** (ex.: `SELECT c.id AS id, c.nome AS nome FROM clientes c WHERE c.ativo = true`). Use consultas para normalizar 1:N/N:1 ao mesmo grão.
- **Filtros do conjunto**: os valores vão sempre como parâmetros, nunca concatenados no SQL.
- **Chave na origem / chave no destino**: a identidade de cada registro. Pode ser composta.
- **Mapa de IDs**: quando a chave muda (ex.: o destino gera IDs novos), aponte a tabela ou consulta que liga o ID antigo ao novo. O plugin avisa sobre IDs repetidos no mapa, correspondências ambíguas, consolidação (vários IDs de origem viram um) e mapas apontando para registros inexistentes.
- **Cardinalidade esperada** (1:1, 1:N, N:1): só 1:1 pode ser aprovado.
- **Campos**: o par de colunas e as **regras do campo**.
- **Relacionamentos**: FKs a verificar, inclusive via mapa de IDs.
- **Exclusões justificadas**: registros da origem que não deviam ser convertidos (ex.: inativos há 10 anos). Cada exclusão exige condição e justificativa e aparece no relatório.

#### Regras de normalização (explícitas)

Por padrão **nada é normalizado**: `"José "` é diferente de `"JOSE"`. Você escolhe por campo ou por chave:

| Regra | Exemplo |
|---|---|
| Remover espaços nas pontas | `" abc "` = `"abc"` |
| Ignorar maiúsculas/minúsculas | `"Abc"` = `"ABC"` |
| Ignorar acentos | `"José"` = `"Jose"` |
| Normalização Unicode (NFC) | formas compostas e decompostas iguais |
| Remover pontuação | `123.456.789-00` = `12345678900` |
| Texto vazio equivale a nulo | `""` = `NULL` |
| Sentinelas tratadas como nulo | `0`, `1900-01-01`, `-1` |
| Valores verdadeiros / falsos | `S, 1, Y` = `true` |
| Mapa de valores (de=para) | `A=ativo`, `I=inativo` |
| Escala decimal (arredondar) | `10.005` → `10.01` |
| Tolerância absoluta / relativa | diferença de até `0,01` ou `0,1 %` |
| Formato de data em texto | `DD/MM/YYYY` ou `YYYYMMDD HHmmss` |
| Fuso das datas sem fuso | datas de origem e destino em fusos diferentes |
| Comparar somente a data | quando o destino perdeu a hora, de forma autorizada |
| Dígitos de fração de segundo | `12:00:00.123456` = `12:00:00.123` |
| JSON canônico | `{"b":1,"a":2}` = `{"a":2,"b":1}` |
| Mantém zeros à esquerda | `007` continua diferente de `7` |

Toda regra aplicada aparece no relatório (**Formato aplicado**, **Regra:**). Uma regra que muda depois de capturada a baseline bloqueia a comparação daquele campo, em vez de comparar com regras diferentes.

### 5. Evidência e desempenho

**Nível de evidência da baseline**:

| Nível | O que guarda | O que permite |
|---|---|---|
| **Básico** | metadados, contagens e perfil (nulos, mín./máx., preenchidos) | diferenças agregadas, **sem** listar quais registros sumiram |
| **Identidade** | todas as identidades e multiplicidades | listar ausentes, extras e duplicados |
| **Campos selecionados** | identidades + digest (ou valor canônico) de cada campo | localizar perdas de preenchimento e divergências por registro |

> Uma baseline só com contagens não reconstrói as identidades depois, se a origem mudar. Na dúvida, escolha **Identidade** ou **Campos**.

**Estratégia** da reconciliação: análise rápida (estimativas identificadas, nunca aprova), volume (contagens exatas e perfil), identidade (varredura completa das chaves), campos selecionados ou diagnóstico aprofundado.

**Desempenho**: concorrência global e conexões por banco, registros em memória por bloco ordenado (acima disso os blocos vão para o disco, em ordenação externa), limite de disco, tempo limite por consulta e orçamento de consultas. **Estimar armazenamento** calcula o espaço antes de começar.

### 6. Baseline

**Capturar baseline da origem** congela o estado da origem **antes da conversão**, numa leitura consistente (snapshot) quando o banco suporta.

- A baseline é **imutável**: manifesto com versão, digest SHA-256 e a cópia exata do mapeamento usado. Cada arquivo de evidência tem tamanho e SHA-256, conferidos antes de cada uso.
- **Destino antes da carga** (opcional): capture o destino vazio ou parcial para separar registros **pré-existentes** dos criados pela conversão.
- O **histórico de baselines** fica no projeto; você escolhe qual usar em cada reconciliação.

### 7. Reconciliação

Depois da carga, **Reconciliar o destino com a baseline**. O plugin lê o destino com as mesmas regras e compara por **merge-join** sobre as evidências ordenadas, unidade por unidade:

- **Volume**: contagens exatas da origem, do destino e das exclusões.
- **Identidade**: **ausentes** no destino, **extras** no destino, **multiplicidade diferente** (duplicações) e **pré-existentes**.
- **Campos**: comparados, iguais, **perdidos no destino** (preenchido na origem, vazio no destino), **criados no destino**, **divergentes**, vazios nos dois, **inválidos** e **não comparados**.
- **Relacionamentos**: FKs que mudaram e **órfãos no destino**.
- **Recorte por lote ou watermark**: reconcilie só a fatia carregada.
- **Verificar se a origem mudou desde a baseline** (informativo): contagem e estrutura.

Chaves duplicadas **nunca** escolhem uma linha: os campos dessas identidades ficam "não comparados" e aparecem assim no relatório.

O progresso aparece ao vivo. Cancelar interrompe também a consulta no banco, e o que já foi feito fica registrado como **parcial**.

#### Resultado de cada unidade

| Resultado | Significa |
|---|---|
| **Compatível no escopo verificado** | tudo o que foi verificado bate. A frase é proposital: só vale para o escopo e as regras escolhidas |
| **Divergente** | há diferença comprovada, listada com evidência |
| **Inconclusivo** | não deu para decidir (ex.: identidades ambíguas, unidade incompleta por limite de disco, cardinalidade não 1:1) |
| **Não verificado** | a estratégia ou o nível de evidência não cobre esse aspecto |

### 8. Relatórios

- **Relatório HTML** autocontido: sem scripts e sem recursos remotos, abre em qualquer navegador e pode ser anexado a um e-mail ou chamado.
- **Resumo CSV**, protegido contra fórmulas (`=`, `+`, `-`, `@` no início das células).
- **Manifesto JSON** com os digests de baseline e execução.
- **Exportar lista completa (CSV)** de ausentes, extras ou divergentes.

Valores sensíveis ficam **mascarados por padrão** na interface e nos relatórios de resumo. A exportação detalhada sem máscara exige uma ação explícita e uma confirmação.

---

## Exemplo rápido

**Cenário**: `clientes` do Firebird legado viram `customer` no PostgreSQL. O ID é novo (serial), o CPF vinha com pontuação e `situacao` era `A`/`I`.

1. Projeto: origem Firebird `ERP`, destino PostgreSQL `crm`.
2. Escopo: schema `public`, ignorar `LOG_%,TMP_%`.
3. Descoberta: o plugin alerta que `customer.name` é `varchar(80)` e `clientes.nome` é `varchar(120)`.
4. Mapeamento: unidade `clientes → customer`, mapa de IDs `legacy_map(old_id, new_id)`, campos `nome→name` (remover espaços), `cpf→document` (remover pontuação), `situacao→status` (mapa `A=active`, `I=inactive`), exclusão justificada `situacao = 'X'` ("cadastros cancelados não migram").
5. Evidência: **Campos selecionados**.
6. Baseline da origem na sexta, antes do congelamento.
7. Reconciliação na segunda, depois da carga: 3 ausentes, 0 extras, 12 nomes truncados (**divergentes**), 0 órfãos.
8. Relatório HTML para a homologação, com a lista CSV dos 3 ausentes.

---

## Onde ficam os dados

Na pasta de configuração do Rits (`%APPDATA%\dev.rits.ide\` no Windows, `~/Library/Application Support/dev.rits.ide/` no macOS), em `migration-audit/<projeto>/`:

```
project.json         configuração do projeto
mappings.json        mapeamento (com versão)
structure-*.json     descobertas estruturais
baselines/<id>/      manifesto + arquivos de evidência (imutáveis)
runs/<id>/           execuções de reconciliação
```

Nada disso vai para o repositório do projeto. **Execuções mantidas** controla quantas execuções antigas guardar.

## Boas práticas

- Capture a baseline **antes** de qualquer carga e, se possível, numa janela de congelamento.
- Prefira **Identidade** ou **Campos** para tabelas críticas; **Básico** serve para tabelas de apoio.
- Escreva a **justificativa** de cada exclusão como você explicaria ao cliente.
- Use **consultas** para comparar grãos diferentes, em vez de relaxar as regras.
- Leia os "não comparados" e os "inconclusivos": eles dizem onde a auditoria **não** pode afirmar nada.

## Limitações

- Não executa a conversão nem corrige dados.
- Bancos sem snapshot consistente são lidos **sem garantia de snapshot**, e isso aparece no relatório.
- **SQL Server**: consultas personalizadas não rodam em transação somente leitura (use um login somente leitura), e o snapshot exige `ALLOW_SNAPSHOT_ISOLATION`.
- **MongoDB** fica fora desta versão.
- Fusos com horário de verão não são suportados nas regras: só deslocamentos fixos (ex.: `-03:00`).
- Tipos binários (BLOB) podem ser excluídos da comparação, e a exclusão é registrada.
- Cardinalidades diferentes de 1:1 nunca aprovam uma unidade: normalize o grão com uma consulta.

Validado com testes de integração reais em PostgreSQL 17, MySQL 8.4, MariaDB 11.8, SQL Server 2022 e Firebird 5.
