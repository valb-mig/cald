#!/usr/bin/env bash
# cald — utilitário de linha de comando do cald.
# Instalado como alias pelo deploy/install.sh. Uso: cald -link
set -euo pipefail

PORT="${PORT:-7337}"
SERVER_DIR="$(cd "$(dirname "$(readlink -f "$0")")/../server" && pwd)"

cald_link() {
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "tailscale não encontrado. Instale-o e rode 'tailscale serve --bg ${PORT}'." >&2
    return 1
  fi

  # O endereço remoto é o primeiro https:// que o tailscale serve está publicando.
  local url
  url="$(tailscale serve status 2>/dev/null | awk '/^https:\/\// {print $1; exit}')"

  if [ -z "$url" ]; then
    echo "O acesso remoto ainda não está publicado na sua tailnet." >&2
    echo "Rode:  tailscale serve --bg ${PORT}" >&2
    return 1
  fi

  echo "$url"
}

# PIN do painel (ver server/src/pin.ts): pedido duas vezes sem eco e passado ao node pela entrada
# padrão, para não ficar no histórico nem na lista de processos.
cald_pin() {
  if [ "${1:-}" = "off" ]; then
    node "$SERVER_DIR/src/pin-cli.ts" off
    return
  fi
  local pin again
  read -rsp "PIN novo (4 a 8 dígitos): " pin; echo
  read -rsp "Repita o PIN: " again; echo
  if [ "$pin" != "$again" ]; then
    echo "Os PINs não batem." >&2
    return 1
  fi
  printf '%s' "$pin" | node "$SERVER_DIR/src/pin-cli.ts"
}

cald_help() {
  cat <<'EOF'
cald — painel mobile do Claude Code

Uso:
  cald -link      mostra o link de acesso remoto (o endereço da tailnet que o celular abre)
  cald -pin       define (ou troca) o PIN pedido para abrir o painel
  cald -pin off   remove o PIN
  cald -help      esta ajuda
EOF
}

case "${1:-}" in
  -link|--link|link) cald_link ;;
  -pin|--pin|pin) cald_pin "${2:-}" ;;
  -help|--help|help|"") cald_help ;;
  *)
    echo "Opção desconhecida: $1" >&2
    echo >&2
    cald_help >&2
    exit 1
    ;;
esac
