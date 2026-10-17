# dbt

> Projetos dbt Core dentro do Rits: comandos com seleção, prévia do alcance, logs ao vivo, linhagem e navegação por `ref()`.

## Para que serve

Para desenvolver e rodar transformações dbt sem alternar entre terminal, editor e documentação. O plugin entende o `dbt_project.yml`, lê os artefatos (`manifest.json`, `run_results.json`) e mostra o resultado de cada modelo e teste.

## Como ativar

1. **Configurações › Plugins › Dados › dbt › Instalar plugin**.
2. A janela **dbt** aparece no painel da direita.
3. Aponte a pasta do projeto dbt (onde está o `dbt_project.yml`).

## Onde o dbt roda

| Runtime | Como |
|---|---|
| **Python do projeto** | o `dbt` do venv do projeto (`pip install dbt-postgres`) |
| **Docker** | a imagem oficial, sem instalar nada na máquina |

Nada é instalado globalmente. Validado com dbt Core 1.10 a 1.12 e `dbt-postgres`.

## Perfis sem senha no repositório

Para PostgreSQL, o plugin gerencia o `profiles.yml`: você escolhe uma **conexão do Rits** ou informa host/usuário, e a senha fica no **cofre do sistema**. O arquivo gerado usa `env_var('RITS_DBT_PASSWORD')`, e a senha entra só no ambiente do comando.

## Comandos

`debug`, `deps`, `parse`, `compile`, `run`, `test`, `build`, `seed`, `snapshot`, `ls` e `docs generate`, com:

- **Seleção** (`--select`, `--exclude`) validada.
- **Target** e `--full-refresh`.
- **Prévia do alcance**: antes de `run`, `build`, `seed` ou `snapshot`, o plugin roda `dbt ls` com a mesma seleção e mostra o target e os nós que serão alterados.
- **Logs ao vivo** e uma aba de resultados com status, tempo e mensagem de cada nó.
- **Cancelar** encerra o processo (e o container, no Docker).

Só uma execução por pasta `target/` de cada vez.

## No editor

- **Ctrl+clique** (ou F12) em `ref('modelo')` e `source('fonte', 'tabela')` abre o arquivo do modelo.
- Realce de Jinja nos `.sql` de modelos.
- Barra de ações no topo do modelo: executar, testar, compilar e ver o SQL compilado.
- **Linhagem**: dependências e dependentes do modelo atual.
- Modelos de arquivo em **Novo**: modelo, fonte, teste, snapshot, seed e unit test.

## Artefatos

O plugin lê `manifest` v10 a v12 e `run_results` v4 a v6 e avisa quando os resultados são de outra invocação ou quando arquivos mudaram depois da última execução.

## Dicas

- Com o **Assistente IA** ativo, pergunte "por que a última execução do dbt falhou?": o agente lê os resultados e o SQL dos modelos.
- Use o **Database** para consultar as tabelas que o dbt criou.
