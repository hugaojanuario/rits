# Docker

> Containers, imagens e volumes do Docker numa janela da IDE.

## Para que serve

Para acompanhar os serviços do projeto (bancos, Airflow, JupyterLab, APIs) sem sair da IDE: ver o que está rodando, ler logs e abrir um shell no container.

## Como ativar

1. Instale o Docker Desktop (Windows/macOS) ou o Docker Engine.
2. **Configurações › Plugins › Infraestrutura › Docker › Ativar**.
3. A janela **Docker** aparece no painel inferior.

## No painel

- **Containers** agrupados pelo projeto do Compose, com estado, portas e uso de CPU e memória (atualizado a cada 5 s, só com a janela visível).
- **Iniciar, parar, reiniciar e remover** containers.
- **Logs** e **shell** abrem como abas do Terminal (`docker logs -f`, `docker exec -it`).
- **Imagens** e **volumes**, com remoção.
- Atualização ao vivo pelos eventos do Docker.
- Se o Docker Desktop estiver fechado, o painel oferece iniciá-lo.

## No editor

`Dockerfile` e `compose.yaml` ganham uma barra de ações (build, up, down, logs) e autocomplete com o plugin **Infraestrutura (IaC)**.
