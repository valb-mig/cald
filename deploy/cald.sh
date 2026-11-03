#!/usr/bin/env bash
# cr — utilitário de linha de comando do claude.remote.
# Instalado como alias pelo deploy/install.sh. Uso: cr -link
set -euo pipefail

PORT="${PORT:-7337}"

cr_link() {
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

cr_help() {
  cat <<'EOF'
cr — claude.remote

Uso:
  cr -link     mostra o link de acesso remoto (o endereço da tailnet que o celular abre)
  cr -help     esta ajuda
EOF
}

case "${1:-}" in
  -link|--link|link) cr_link ;;
  -help|--help|help|"") cr_help ;;
  *)
    echo "Opção desconhecida: $1" >&2
    echo >&2
    cr_help >&2
    exit 1
    ;;
esac
