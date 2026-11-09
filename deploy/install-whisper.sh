#!/usr/bin/env bash
# Instala o Whisper (whisper.cpp) para o ditado em navegadores sem reconhecimento de voz, como o
# Firefox: compila o `whisper-cli` e baixa o modelo, em ~/.local/share/editr/whisper (os
# caminhos que o servidor procura; ver server/src/config.ts). Pode rodar de novo sem medo.
# Uso: deploy/install-whisper.sh [modelo]   (padrão: small-q5_1; ex.: base-q5_1, large-v3-turbo-q5_0)
set -euo pipefail

MODEL="${1:-small-q5_1}"
DIR="$HOME/.local/share/editr/whisper"
mkdir -p "$DIR/models"

for tool in git cmake make g++ curl; do
  command -v "$tool" >/dev/null || { echo "falta o $tool: instale e rode de novo" >&2; exit 1; }
done

if [ ! -d "$DIR/whisper.cpp" ]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$DIR/whisper.cpp"
else
  git -C "$DIR/whisper.cpp" pull --ff-only
fi

cmake -S "$DIR/whisper.cpp" -B "$DIR/whisper.cpp/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF >/dev/null
cmake --build "$DIR/whisper.cpp/build" -j "$(( $(nproc) > 4 ? 4 : $(nproc) ))" --config Release --target whisper-cli

FILE="$DIR/models/ggml-$MODEL.bin"
if [ ! -s "$FILE" ]; then
  curl -fL --progress-bar -o "$FILE.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
  mv "$FILE.part" "$FILE"
fi

echo
echo "Whisper pronto: $DIR/whisper.cpp/build/bin/whisper-cli"
echo "Modelo: $FILE"
[ "$MODEL" = small-q5_1 ] || echo "Outro modelo: defina WHISPER_MODEL=$FILE no serviço (systemctl --user edit editr)."
