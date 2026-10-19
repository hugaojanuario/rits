O Rits reúne código Python e Go, bancos de dados, orquestração e infraestrutura em uma IDE leve. A versão 0.7.0 traz scripts SQL e um console SQL bem mais esperto:

- **Executar sem `;`**: Ctrl+Enter executa só a instrução do cursor, mesmo quando as consultas não terminam em `;`. "Executar tudo" separa do mesmo jeito, e `GO` (SQL Server), `/` (Oracle), `DELIMITER` (MySQL) e `SET TERM` (Firebird) são respeitados.
- **Marcações no editor**: o `;` que falta, aspas e parênteses sem fechamento e o ponto exato do erro devolvido pelo banco aparecem sublinhados em vermelho; tabelas que o banco não tem, em amarelo.
- **Scripts SQL**: arquivos `.sql` do projeto abrem com conexão, database e schema próprios (lembrados por arquivo), salvamento automático e o painel de resultados. Crie em Novo › Script SQL, na árvore do projeto ou no menu de uma conexão.
- **Parâmetros**: `:id`, `?`, `${var}` e `$1` são perguntados antes de executar.
- **Erro no meio do script**: escolha parar, ignorar ou ignorar todos os erros.
- **Buscar mais**: resultados cortados em 50 mil linhas ganham "Buscar mais" e "Buscar tudo" (até 1 milhão).
- **Ctrl/⌘+clique** numa tabela do SQL abre os dados dela.
- **Transação manual** também no SQL Server, Oracle, Firebird, SQLite e DuckDB.

Quem está na 0.6.x vê o botão **Atualizar para v0.7.0** na barra de título.

Baixe `Rits-windows-x64-setup.exe` para **Windows 11 x64** ou `Rits-macos-arm64.dmg` para **Mac Apple Silicon**. O arquivo `SHA256SUMS.txt` contém os hashes dos dois instaladores.

No Mac, instale com uma linha no Terminal (baixa, instala em Aplicativos e libera o app):

```bash
curl -fsSL https://raw.githubusercontent.com/hugaojanuario/rits/main/scripts/install-macos.sh | bash
```

Ou arraste o Rits do DMG para Aplicativos e rode `xattr -dr com.apple.quarantine /Applications/Rits.app`: a assinatura é ad-hoc, sem notarização da Apple, e sem esse comando o macOS mantém o app em quarentena.
