#!/bin/bash
# Instala (ou atualiza) o Rits no macOS Apple Silicon a partir da última release do GitHub.
# O app tem assinatura ad-hoc (sem notarização da Apple); por isso este script remove o atributo
# de quarentena, que faria o macOS bloquear ou isolar o app.
#
# Uso:  curl -fsSL https://raw.githubusercontent.com/hugaojanuario/rits/main/scripts/install-macos.sh | bash
set -euo pipefail

REPO="hugaojanuario/rits"
APP="${RITS_APP:-/Applications/Rits.app}"
URL="https://github.com/$REPO/releases/latest/download/Rits-macos-arm64.dmg"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Este instalador é para macOS." >&2
  exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
  echo "O Rits para macOS é publicado para Apple Silicon (arm64)." >&2
  exit 1
fi

TMP="$(mktemp -d)"
MNT="$TMP/mnt"
cleanup() {
  hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "Baixando a última versão do Rits…"
curl -fL --progress-bar -o "$TMP/Rits.dmg" "$URL"

echo "Montando a imagem…"
mkdir -p "$MNT"
hdiutil attach "$TMP/Rits.dmg" -nobrowse -readonly -quiet -mountpoint "$MNT"

if [ -z "${RITS_APP:-}" ] && { pgrep -xq rits || pgrep -xq Rits; }; then
  echo "Fechando o Rits aberto…"
  osascript -e 'tell application "Rits" to quit' >/dev/null 2>&1 || true
  sleep 2
fi

echo "Instalando em ${APP}…"
rm -rf "${APP}"
ditto "$MNT/Rits.app" "${APP}"

echo "Liberando o app (removendo a quarentena)…"
xattr -dr com.apple.quarantine "${APP}"

VERSION="$(defaults read "${APP}/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "?")"
echo "Rits $VERSION instalado em ${APP}."
[ -n "${RITS_NO_OPEN:-}" ] || open "${APP}"
