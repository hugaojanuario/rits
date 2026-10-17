O Rits reúne código Python e Go, bancos de dados, orquestração e infraestrutura em uma IDE leve. A versão 0.6.0 traz mais controle e atalhos ao Assistente IA:

- **Modelo, versão e esforço**: escolha o modelo (Fable, Opus, Sonnet ou Haiku, sempre o mais recente ou uma versão fixa, ou qualquer outro nome) e o esforço de raciocínio, de baixo a máximo. No Codex, a lista de modelos e de níveis vem da sua conta. A linha de status mostra o modelo realmente em uso, e a troca vale na próxima mensagem, sem perder a conversa.
- **Comandos e skills com `/`**: digite `/` para ver os comandos e as skills do projeto, os seus e os dos plugins do Claude Code, com a descrição de cada um. No Codex, as skills e os prompts salvos também funcionam.
- **Arquivos com `@`**: digite `@` para procurar arquivos e pastas do projeto; o conteúdo vai junto com a pergunta, inclusive o que ainda não foi salvo.
- **Ditado pelo microfone**: clique no microfone e fale; o texto aparece enquanto você fala. Usa o reconhecimento de fala do próprio macOS ou Windows, em português por padrão (botão direito para trocar o idioma). No Mac, o sistema pede permissão para o microfone e para o reconhecimento de fala na primeira vez.

Da 0.5.x: X para fechar notificações, uma linha de espaço no topo do editor, Assistente IA com Claude Code e Codex, exportação de resultados, atualização pelo próprio app e janelas de ferramentas arrastáveis.

Quem está na 0.5.x vê o botão **Atualizar para v0.6.0** na barra de título.

Baixe `Rits-windows-x64-setup.exe` para **Windows 11 x64** ou `Rits-macos-arm64.dmg` para **Mac Apple Silicon**. O arquivo `SHA256SUMS.txt` contém os hashes dos dois instaladores.

No Mac, instale com uma linha no Terminal (baixa, instala em Aplicativos e libera o app):

```bash
curl -fsSL https://raw.githubusercontent.com/hugaojanuario/rits/main/scripts/install-macos.sh | bash
```

Ou arraste o Rits do DMG para Aplicativos e rode `xattr -dr com.apple.quarantine /Applications/Rits.app`: a assinatura é ad-hoc, sem notarização da Apple, e sem esse comando o macOS mantém o app em quarentena.
