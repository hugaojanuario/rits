# Apache Airflow

> DAGs, execuções e logs de um Airflow 3 dentro do Rits, e um ambiente local pronto com Docker.

## Para que serve

Para desenvolver DAGs e acompanhar o Airflow sem abrir a interface web: ver se a DAG foi processada, disparar uma execução, ler o log de uma tarefa e voltar para o código.

## Como ativar

1. **Configurações › Plugins › Infraestrutura › Apache Airflow › Instalar plugin**.
2. A janela **Airflow** aparece no painel da direita.

## Conectar

| Opção | Como |
|---|---|
| **Instância existente** | URL do Airflow 3 e autenticação (usuário e senha, token ou nenhuma) |
| **Ambiente local (Docker)** | o Rits gera um compose baseado no oficial (Airflow 3.3.2, PostgreSQL, LocalExecutor), com porta só em `127.0.0.1` e senha aleatória |

Só a API pública do Airflow 3 (`/api/v2`) é usada. Senhas e tokens ficam no cofre do sistema; a IDE nunca os mostra. O Airflow 2 é detectado e recusado com uma mensagem clara.

## No painel

- **DAGs** com busca, tags, pausa e último estado. A lista se atualiza a cada 20 s enquanto o painel está visível.
- **Erros de importação** em destaque, com link para o arquivo.
- **Disparar** com `conf` em JSON e nota. O botão fica desabilitado até a resposta: um disparo nunca é repetido sozinho.
- Abrir uma DAG mostra as execuções, as tarefas de cada execução e os **logs** (atualizados a cada 3 s enquanto rodam).
- **Limpar tarefas**: o plugin mostra primeiro o alcance (`dry_run`) e só depois limpa.
- **Abrir no Airflow** abre a interface oficial numa janela separada ou no navegador.

## Projeto e entrega das DAGs

Associe o projeto a uma instância, escolha a **pasta de DAGs** e a forma de entrega:

- **Volume**: a pasta do projeto é montada no Airflow (padrão do ambiente local).
- **Git**: o Airflow lê do repositório; a IDE lembra de fazer commit e push.
- **Manual**: você copia os arquivos.

Ao salvar um `.py` da pasta de DAGs, a IDE acompanha o processamento e avisa se a DAG foi carregada ou deu erro. Para o autocomplete, o plugin oferece instalar o `apache-airflow-task-sdk` no interpretador do projeto.

## Ambiente local

O compose fica na pasta de configuração do Rits, fora do projeto e do Git. Parar preserva os volumes. Excluir com os dados pede que você digite o nome do ambiente.

## Dicas

Com o **Assistente IA** ativo, peça "resuma o estado das DAGs" ou "por que a tarefa X falhou?": o agente lê as DAGs, as execuções e os logs.
