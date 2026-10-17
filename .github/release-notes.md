O Rits reúne código Python e Go, bancos de dados, orquestração e infraestrutura em uma IDE leve. A versão 0.6.1 corrige o ditado do Assistente IA:

- **Ditado no Mac sempre no dispositivo**: a partir da segunda gravação, o reconhecimento podia ir para os servidores da Apple e falhar com "Siri and Dictation are disabled". Agora ele sempre roda no próprio Mac quando o idioma está baixado, mesmo com a Siri e o Ditado desligados, e só usa o servidor se o reconhecimento local falhar duas vezes.
- **Gravações seguidas**: o fim atrasado de uma gravação não encerra mais a seguinte (Mac e Windows).
- Quando o Ditado do macOS é necessário e está desligado, a mensagem explica onde ativar.

Depois de atualizar, o macOS pode pedir de novo as permissões de Microfone e Reconhecimento de Fala.

Da 0.6.0: modelo, versão e esforço no Assistente IA, comandos e skills com `/`, arquivos com `@` e ditado pelo microfone.

Quem está na 0.5.x ou na 0.6.0 vê o botão **Atualizar para v0.6.1** na barra de título.

Baixe `Rits-windows-x64-setup.exe` para **Windows 11 x64** ou `Rits-macos-arm64.dmg` para **Mac Apple Silicon**. O arquivo `SHA256SUMS.txt` contém os hashes dos dois instaladores.

No Mac, instale com uma linha no Terminal (baixa, instala em Aplicativos e libera o app):

```bash
curl -fsSL https://raw.githubusercontent.com/hugaojanuario/rits/main/scripts/install-macos.sh | bash
```

Ou arraste o Rits do DMG para Aplicativos e rode `xattr -dr com.apple.quarantine /Applications/Rits.app`: a assinatura é ad-hoc, sem notarização da Apple, e sem esse comando o macOS mantém o app em quarentena.
