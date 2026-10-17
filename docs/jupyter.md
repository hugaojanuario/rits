# Jupyter

> Notebooks `.ipynb` dentro do editor do Rits, executados por um Jupyter Server local, remoto ou no Docker.

## Para que serve

Para analisar dados sem sair da IDE: explorar uma tabela, testar uma transformação, gerar um gráfico. O notebook fica ao lado do código, do terminal e do console SQL do mesmo projeto.

## Como ativar

1. **Configurações › Plugins › Dados › Jupyter › Instalar plugin**.
2. A janela **Jupyter** aparece no painel da direita.

Não é preciso ter o Jupyter instalado na máquina para usar um servidor remoto ou o ambiente Docker.

## Conectar um servidor

Na janela Jupyter, escolha uma das opções:

| Opção | Quando usar |
|---|---|
| **Servidor existente** | já há um Jupyter Server ou JupyterLab rodando (local ou remoto). Informe a URL e o token |
| **JupyterLab local (Docker)** | o Rits gera um ambiente com imagem fixada, porta só em `127.0.0.1` e token aleatório |

O token fica no **cofre do sistema** (Keychain no macOS, Gerenciador de Credenciais no Windows), nunca na URL nem no projeto. Em servidores remotos, configure a **pasta local ↔ pasta no servidor** para o notebook abrir no lugar certo.

## Usando o notebook

- Abra qualquer `.ipynb` pela árvore do projeto ou crie em **Novo › Notebook Jupyter**.
- Células **Python** e **Markdown**. **Shift+Enter** executa e vai para a próxima; **Ctrl+Enter** executa e fica.
- Saídas: texto, tabelas (pandas), imagens, gráficos, HTML e erros com traceback.
- **Interromper** e **Reiniciar** o kernel pela barra do notebook. Reconectar nunca reexecuta células.
- Autocomplete vem do próprio kernel. Com o Ruff instalado, erros de sintaxe e nomes indefinidos são marcados nas células.
- **Abrir como texto** mostra o JSON do arquivo.
- **Abrir no JupyterLab** abre a interface oficial numa janela separada, já autenticada.

## Segurança

- Markdown e HTML das saídas são sempre sanitizados.
- Scripts em saídas HTML só rodam em notebooks **confiáveis** (os que você salvou neste computador) ou gerados nesta sessão, sempre num iframe isolado.
- As sessões que a aba criou são encerradas ao fechá-la. As já existentes no JupyterLab são preservadas.

## Ambiente Docker

O ambiente local fica na pasta de configuração do Rits (fora do projeto e do Git). Parar o ambiente preserva o volume `home`. Excluir com os dados pede que você digite o nome do ambiente.

## Dicas

- Use o venv do projeto como kernel para ter as mesmas bibliotecas do código.
- Com o **Assistente IA** ativo, o agente lê as células e saídas dos notebooks abertos.
