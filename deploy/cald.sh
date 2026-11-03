#!/usr/bin/env bash
# cald — utilitário de linha de comando do cald.
# Instalado como alias pelo deploy/install.sh. Uso: cald -link
set -euo pipefail

PORT="${PORT:-7337}"

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

cald_help() {
  cat <<'EOF'
cald — painel mobile do Claude Code

Uso:
  cald -link   mostra o link de acesso remoto (o endereço da tailnet que o celular abre)
  cald -help   esta ajuda
EOF
}

case "${1:-}" in
  -link|--link|link) cald_link ;;
  -help|--help|help|"") cald_help ;;
  *)
    echo "Opção desconhecida: $1" >&2
    echo >&2
    cald_help >&2
    exit 1
    ;;
esac
