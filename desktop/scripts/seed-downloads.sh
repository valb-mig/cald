#!/usr/bin/env bash
# Baixa pela API do GitHub, autenticado (gh, com GH_TOKEN), o Electron e as ferramentas de que o
# electron-builder precisa, e deixa nos caches onde ele procura antes de baixar. Os downloads
# anônimos dos Releases do GitHub podem falhar em massa (504 no incidente de 2026-11-09, com os
# autenticados de pé); com tudo aqui, o build não depende deles. Usado pelo CI
# (.github/workflows/desktop.yml); ver "offline air-gapped builds" na documentação do electron-builder.
set -euo pipefail

cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# O Electron: o zip no cache do @electron/get (a pasta é o sha256 da URL do Release) e o
# SHASUMS256.txt semeado, para a conferência não ir à rede.
electron="$(node -p "require('electron/package.json').version")"
zip="electron-v$electron-linux-x64.zip"
url="https://github.com/electron/electron/releases/download/v$electron"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/electron"
dir="$cache/$(node -p "require('crypto').createHash('sha256').update(process.argv[1]).digest('hex')" "$url")"
gh release download "v$electron" --repo electron/electron --pattern "$zip" --pattern SHASUMS256.txt --dir "$tmp"
(cd "$tmp" && grep -F " *$zip" SHASUMS256.txt | sha256sum -c --quiet)
mkdir -p "$dir"
mv "$tmp/$zip" "$dir/$zip"
mv "$tmp/SHASUMS256.txt" "$cache/SHASUMS256.txt-$electron"
echo "Electron $electron no cache."

# As ferramentas do electron-builder 26.17 (o electron-builder confere o checksum de cada uma). Num
# electron-builder novo, a que mudou de versão só avisa e é baixada como antes.
tools="${ELECTRON_BUILDER_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/electron-builder}"
while read -r release file; do
  if gh release download "$release" --repo electron-userland/electron-builder-binaries --pattern "$file" --dir "$tools/$release" --clobber; then
    echo "$release/$file no cache."
  else
    echo "::warning::$release/$file não veio pela API; o electron-builder baixa como antes."
  fi
done <<'LIST'
7zip@1.0.0 7zip-linux-x64.tar.gz
appimage-12.0.1 appimage-12.0.1.7z
fpm@2.1.4 fpm-1.17.0-ruby-3.4.3-linux-amd64.7z
LIST
