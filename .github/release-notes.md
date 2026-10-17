O Rits reúne código Python e Go, bancos de dados, orquestração e infraestrutura em uma IDE leve. A versão 0.5.1 traz:

- **Mais espaço no topo do editor**: a primeira linha do editor de código e do console SQL começa uma linha abaixo, sem ficar colada na barra de abas.

É também a primeira atualização entregue pelo próprio app: quem está na 0.5.0 vê o botão **Atualizar para v0.5.1** na barra de título.

Da 0.5.0: Assistente IA com Claude Code e Codex, exportação de resultados (CSV, Excel, JSON, XML e mais), atualização pelo app, janelas de ferramentas arrastáveis e guias dos plugins na IDE.

Baixe `Rits-windows-x64-setup.exe` para **Windows 11 x64** ou `Rits-macos-arm64.dmg` para **Mac Apple Silicon**. O arquivo `SHA256SUMS.txt` contém os hashes dos dois instaladores.

No Mac, instale com uma linha no Terminal (baixa, instala em Aplicativos e libera o app):

```bash
curl -fsSL https://raw.githubusercontent.com/hugaojanuario/rits/main/scripts/install-macos.sh | bash
```

Ou arraste o Rits do DMG para Aplicativos e rode `xattr -dr com.apple.quarantine /Applications/Rits.app`: a assinatura é ad-hoc, sem notarização da Apple, e sem esse comando o macOS mantém o app em quarentena.
