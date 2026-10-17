O Rits reúne código Python e Go, bancos de dados e infraestrutura em uma IDE leve. A versão 0.4.2 corrige:

- O X das abas abertas volta a fechar a aba.
- Excluir arquivos e pastas em locais sem Lixeira (como pastas do OneDrive ou compartilhamentos de rede): a IDE mostra o motivo e oferece excluir definitivamente, só com sua confirmação.

Da 0.4.1: botão ⋮ na faixa de janelas, nomes sem autocorreção, renomear por diálogo, ⌘⌫ e F2 na árvore e submenu "Novo" legível no Liquid Glass.

Baixe `Rits-windows-x64-setup.exe` para **Windows 11 x64** ou `Rits-macos-arm64.dmg` para **Mac Apple Silicon**. O arquivo `SHA256SUMS.txt` contém os hashes dos dois instaladores.

No Mac, instale com uma linha no Terminal (baixa, instala em Aplicativos e libera o app):

```bash
curl -fsSL https://raw.githubusercontent.com/hugaojanuario/rits/main/scripts/install-macos.sh | bash
```

Ou arraste o Rits do DMG para Aplicativos e rode `xattr -dr com.apple.quarantine /Applications/Rits.app`: a assinatura é ad-hoc, sem notarização da Apple, e sem esse comando o macOS mantém o app em quarentena.
