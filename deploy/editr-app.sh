#!/usr/bin/env bash
# O app do PC rodando deste repositório, sem empacotar (o canal dev, ver deploy/install.sh --dev).
# O lançador e o autostart chamam este script: o caminho fica o mesmo quando a versão do Electron muda.
# Os argumentos vão para o app (--hidden, --open=/s/<id>).
set -euo pipefail
DESKTOP_DIR="$(cd "$(dirname "$(readlink -f "$0")")/../desktop" && pwd)"
ELECTRON="$DESKTOP_DIR/node_modules/electron/dist/electron"
# O pnpm não roda o postinstall do Electron (fora do allowBuilds): sem o binário, baixa (ou tira do cache).
[ -x "$ELECTRON" ] || node "$DESKTOP_DIR/node_modules/electron/install.js"
exec "$ELECTRON" "$DESKTOP_DIR" "$@"
