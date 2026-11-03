#!/usr/bin/env sh
# Gera os PNGs do ícone em web/public a partir dos desenhos de web/icons. Precisa do rsvg-convert
# (pacote librsvg). Uso: web/scripts/icons.sh
set -eu
cd "$(dirname "$0")/.."

png() { rsvg-convert -w "$2" -h "$2" "icons/$1.svg" -o "public/$3"; }

png icon 512 pwa-512.png
png icon 192 pwa-192.png
png favicon 64 favicon.png
png full 512 maskable-512.png
png full 180 apple-touch-icon.png
png badge 96 badge-96.png
# O SVG vai direto para a aba: nítido em qualquer tamanho.
cp icons/favicon.svg public/favicon.svg
