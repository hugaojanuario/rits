O Rits reúne código Python e Go, bancos de dados e infraestrutura em uma IDE leve. A versão 0.4.0 traz três plugins opcionais para engenharia de dados, ativados em Configurações › Plugins e carregados só quando ativos.

- **Jupyter**: notebooks `.ipynb` no editor da IDE, com células Python e Markdown, execução por kernel de um Jupyter Server (local, remoto ou JupyterLab criado no Docker), tabelas, imagens, gráficos e erros, interrupção e reinício do kernel, confiança de notebooks e saídas ativas isoladas. Validado com Jupyter Server 2.21.1 / JupyterLab 4.6.4.
- **dbt**: projetos dbt Core com `debug`, `deps`, `parse`, `compile`, `run`, `test`, `build` e documentação; seleção estruturada, prévia do alcance antes de alterar o banco, logs ao vivo, resultados, linhagem, SQL compilado, navegação por `ref()`/`source()` e perfis PostgreSQL sem senhas no repositório. Validado com dbt Core 1.12.6 e dbt-postgres 1.11.0.
- **Migration Audit**: auditoria determinística de conversões de dados entre bancos — descoberta estrutural, mapeamento confirmado, baseline imutável, reconciliação por unidade (volume, identidade, campos e relacionamentos) e relatórios HTML/CSV com evidências e limitações. Validado com PostgreSQL 17, MySQL 8.4, MariaDB 11.8, SQL Server 2022 e Firebird 5.

Tokens e senhas dos novos plugins ficam no cofre do sistema (Keychain / Credential Manager).

Baixe `Rits-windows-x64-setup.exe` para **Windows 11 x64** ou `Rits-macos-arm64.dmg` para **Mac Apple Silicon**. O arquivo `SHA256SUMS.txt` contém os hashes dos dois instaladores.

No Mac, arraste o Rits para Aplicativos. A assinatura é ad-hoc, sem notarização; na primeira abertura, use clique direito → **Abrir** e, se necessário, autorize em Ajustes do Sistema → Privacidade e Segurança.
