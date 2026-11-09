#!/usr/bin/env bash
# Instala o Piper, voz neural que roda no próprio PC, para a leitura em voz alta no PC: sem ele, o
# navegador no Linux lê com o espeak, robótico. Baixa o binário e a voz em pt-BR para
# ~/.local/share/editr/piper (os caminhos que o servidor procura; ver server/src/config.ts). Pode
# rodar de novo sem medo.
# Uso: deploy/install-piper.sh [voz]   (padrão: faber-medium; ex.: cadu-medium, jeff-medium, edresson-low)
set -euo pipefail

VOICE="${1:-faber-medium}"
RELEASE=2023.11.14-2
DIR="$HOME/.local/share/editr/piper"
mkdir -p "$DIR/voices"

command -v curl >/dev/null || { echo "falta o curl: instale e rode de novo" >&2; exit 1; }
case "$(uname -m)" in
  x86_64) ARCH=x86_64 ;;
  aarch64 | arm64) ARCH=aarch64 ;;
  *) echo "o Piper não tem binário para $(uname -m)" >&2; exit 1 ;;
esac

if [ ! -x "$DIR/piper/piper" ]; then
  curl -fL --progress-bar "https://github.com/rhasspy/piper/releases/download/$RELEASE/piper_linux_$ARCH.tar.gz" | tar -xz -C "$DIR"
fi

NAME="pt_BR-$VOICE"
SPEAKER="${VOICE%-*}"
QUALITY="${VOICE##*-}"
for ext in onnx onnx.json; do
  FILE="$DIR/voices/$NAME.$ext"
  if [ ! -s "$FILE" ]; then
    curl -fL --progress-bar -o "$FILE.part" "https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/$SPEAKER/$QUALITY/$NAME.$ext"
    mv "$FILE.part" "$FILE"
  fi
done

echo
echo "Piper pronto: $DIR/piper/piper"
echo "Voz: $DIR/voices/$NAME.onnx"
[ "$VOICE" = faber-medium ] || echo "Outra voz: defina PIPER_VOICE=$DIR/voices/$NAME.onnx no serviço (systemctl --user edit editr)."
