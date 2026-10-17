O Rits reúne código Python e Go, bancos de dados, orquestração e infraestrutura em uma IDE leve. Novidades da 0.5.0:

- **Assistente IA (plugin)**: um chat dentro da IDE com o seu Claude Code ou o seu Codex, usando o CLI oficial e a sua conta. O agente enxerga o projeto, o arquivo aberto e a seleção, os problemas, o Git, os bancos conectados (consultas somente leitura), as DAGs e os logs do Airflow, o dbt, os notebooks, o Docker e o Migration Audit. Edições e comandos do Claude Code pedem aprovação no chat, com o diff.
- **Exportar resultados** do console e das tabelas em CSV, TSV, Excel (.xlsx), JSON, JSON Lines, XML, `INSERT` SQL, Markdown e HTML, da página visível ou do resultado completo, com progresso e cancelamento.
- **Atualização pelo próprio app**: quando há versão nova, aparece um botão na barra de título; o instalador é conferido pelo SHA-256 e o Rits reabre na versão nova.
- **Janelas de ferramentas arrastáveis**: arraste o ícone de qualquer janela, inclusive as dos plugins, para o painel esquerdo, direito ou inferior.
- **Guias dos plugins**: o botão **?** de cada janela de plugin abre a documentação dentro da IDE (Migration Audit, Assistente IA, Airflow, dbt, Jupyter e Docker).
- O X das abas fecha de primeira, e uma falha ao salvar não trava mais a aba.
- Um pequeno espaço no topo do editor de código e do console SQL.

Baixe `Rits-windows-x64-setup.exe` para **Windows 11 x64** ou `Rits-macos-arm64.dmg` para **Mac Apple Silicon**. O arquivo `SHA256SUMS.txt` contém os hashes dos dois instaladores.

No Mac, instale com uma linha no Terminal (baixa, instala em Aplicativos e libera o app):

```bash
curl -fsSL https://raw.githubusercontent.com/hugaojanuario/rits/main/scripts/install-macos.sh | bash
```

Ou arraste o Rits do DMG para Aplicativos e rode `xattr -dr com.apple.quarantine /Applications/Rits.app`: a assinatura é ad-hoc, sem notarização da Apple, e sem esse comando o macOS mantém o app em quarentena.
