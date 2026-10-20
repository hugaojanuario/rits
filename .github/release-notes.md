O Rits reúne código Python e Go, bancos de dados, orquestração e infraestrutura em uma IDE leve. A versão 0.8.0 chega ao **Linux**:

- **Linux x64**: AppImage para qualquer distribuição e pacote `.deb` para Debian/Ubuntu. Requer o WebKitGTK 4.1 (Ubuntu 22.04+, Debian 12+, Fedora 38+).
- **Segredos no Linux**: senhas e tokens dos plugins (Airflow, Jupyter, dbt) ficam no Secret Service (GNOME Keyring ou KWallet).
- **Ferramentas encontradas no Linux**: o PATH do shell de login é lido ao abrir (pyenv, Go, `~/.local/bin`…), além de linuxbrew e `/snap/bin`; `pg_dump`, `pg_restore` e `psql` são procurados também em `/usr/lib/postgresql/*/bin` e `/usr/pgsql-*/bin`.
- No Linux, a atualização é manual (baixe a versão nova) e o ditado do Assistente IA não está disponível.

Quem está na 0.7.x no Windows ou no Mac vê o botão **Atualizar para v0.8.0** na barra de título.

Baixe `Rits-windows-x64-setup.exe` para **Windows 11 x64**, `Rits-macos-arm64.dmg` para **Mac Apple Silicon**, `Rits-linux-x64.AppImage` ou `Rits-linux-x64.deb` para **Linux x64**. O arquivo `SHA256SUMS.txt` contém os hashes dos instaladores.

No Linux:

```bash
chmod +x Rits-linux-x64.AppImage && ./Rits-linux-x64.AppImage
# ou, no Debian/Ubuntu:
sudo apt install ./Rits-linux-x64.deb
```

No Mac, instale com uma linha no Terminal (baixa, instala em Aplicativos e libera o app):

```bash
curl -fsSL https://raw.githubusercontent.com/hugaojanuario/rits/main/scripts/install-macos.sh | bash
```

Ou arraste o Rits do DMG para Aplicativos e rode `xattr -dr com.apple.quarantine /Applications/Rits.app`: a assinatura é ad-hoc, sem notarização da Apple, e sem esse comando o macOS mantém o app em quarentena.
