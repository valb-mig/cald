#!/usr/bin/env bash
# edit.r — utilitário de linha de comando do edit.r.
# Instalado como alias pelo deploy/install.sh. Uso: editr -link [on|off]
set -euo pipefail

PORT="${PORT:-7337}"
SERVER_DIR="$(cd "$(dirname "$(readlink -f "$0")")/../server" && pwd)"

editr_link() {
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "tailscale não encontrado. Instale-o e rode 'tailscale serve --bg ${PORT}'." >&2
    return 1
  fi

  # Ligar e desligar o link remoto, como o botão da seção Acesso do app (ver server/src/link.ts).
  case "${1:-}" in
    off)
      tailscale serve --https=443 off >/dev/null 2>&1 || true
      tailscale serve --http=80 off >/dev/null 2>&1 || true
      echo "Link remoto desligado: o painel só abre no próprio PC (http://localhost:${PORT})."
      return 0
      ;;
    on)
      tailscale serve --bg "$PORT" >/dev/null
      # O atalho em http (digitar só o nome da máquina); falhar aqui não atrapalha o link.
      tailscale serve --bg --http=80 "$PORT" >/dev/null 2>&1 || true
      ;;
  esac

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
editr_pin() {
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

editr_help() {
  cat <<'EOF'
edit.r — painel mobile do Claude Code

Uso:
  editr -link      mostra o link de acesso remoto (o endereço da tailnet que o celular abre)
  editr -link off  desliga o link remoto (o painel só abre no próprio PC)
  editr -link on   liga de novo
  editr -pin       define (ou troca) o PIN pedido para abrir o painel
  editr -pin off   remove o PIN
  editr -help      esta ajuda
EOF
}

case "${1:-}" in
  -link|--link|link) editr_link "${2:-}" ;;
  -pin|--pin|pin) editr_pin "${2:-}" ;;
  -help|--help|help|"") editr_help ;;
  *)
    echo "Opção desconhecida: $1" >&2
    echo >&2
    editr_help >&2
    exit 1
    ;;
esac
