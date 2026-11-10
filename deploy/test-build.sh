#!/usr/bin/env bash
# O app do PC de teste de uma branch: compila o worktree deste script, sobe uma instância de teste dele
# (o servidor do worktree, com uma cópia dos seus dados) e abre o app do PC nela, ao lado do de sempre,
# com a faixa da build no topo. Recompilar o web (`pnpm --filter web build`) recarrega a janela; mudou
# o servidor, `systemctl --user restart editr-test-<worktree>`. Fechar a janela derruba a instância.
#
#   deploy/test-build.sh           compila, sobe e abre (de novo, se já estava aberto)
#   deploy/test-build.sh --link    também publica na tailnet, para o celular, com o seu PIN
#   deploy/test-build.sh --fresh   copia os dados de novo, jogando fora o que os testes de antes fizeram
#   deploy/test-build.sh --stop    fecha o app e derruba a instância
set -euo pipefail
shopt -s dotglob nullglob

ROOT="$(git -C "$(dirname "$(readlink -f "$0")")" rev-parse --show-toplevel)"
SLUG="$(basename "$ROOT")"
SLUG="${SLUG//[^a-zA-Z0-9-]/-}"
UNIT="editr-test-$SLUG"
APP_UNIT="$UNIT-app"
DIR="/tmp/editr-test-$SLUG"
TEST_HOME="$DIR/home"

LINK=0
FRESH=0
for arg in "$@"; do
  case "$arg" in
    --link) LINK=1 ;;
    --fresh) FRESH=1 ;;
    --stop) STOP=1 ;;
    *) echo "Opção desconhecida: $arg" >&2; exit 2 ;;
  esac
done

stop_all() {
  # No fim do app (o ExecStopPost abaixo, que o systemd marca com SERVICE_RESULT), sem esperar por ele,
  # que espera este script; fora dele, espera, para um app velho saindo tarde não derrubar a instância nova.
  if [ -n "${SERVICE_RESULT:-}" ]; then
    systemctl --user stop --no-block "$APP_UNIT" 2>/dev/null || true
  else
    systemctl --user stop "$APP_UNIT" 2>/dev/null || true
  fi
  systemctl --user stop "$UNIT" 2>/dev/null || true
  if [ -f "$DIR/link" ]; then
    tailscale serve --https="$(cat "$DIR/link")" off >/dev/null 2>&1 || true
    rm -f "$DIR/link"
  fi
}

if [ "${STOP:-0}" = 1 ]; then
  stop_all
  exit 0
fi

# Liga em `to` tudo de `from`, menos os nomes dados: o HOME de teste é o seu, por link, fora do edit.r.
link_except() {
  local from="$1" to="$2" f name
  shift 2
  for f in "$from"/*; do
    name="${f##*/}"
    [[ " $* " == *" $name "* ]] && continue
    ln -sfn "$f" "$to/$name"
  done
}

# Os dados do edit.r copiados, e não os de verdade: ao subir, o servidor limpa o cache das conversas
# abertas, e duas instâncias gravando os mesmos arquivos apagariam uma a outra.
make_home() {
  mkdir -p "$TEST_HOME/.local/share/editr" "$TEST_HOME/.local/state" "$TEST_HOME/.cache/editr"
  link_except "$HOME" "$TEST_HOME" .local .cache
  link_except "$HOME/.local" "$TEST_HOME/.local" share state
  link_except "$HOME/.local/share" "$TEST_HOME/.local/share" editr
  link_except "$HOME/.local/state" "$TEST_HOME/.local/state" editr
  link_except "$HOME/.cache" "$TEST_HOME/.cache" editr
  local f
  for f in "$HOME/.local/share/editr"/*; do
    # Os modelos de voz são grandes e só de leitura: por link.
    case "${f##*/}" in
      piper | whisper) ln -sfn "$f" "$TEST_HOME/.local/share/editr/" ;;
      *) cp -a "$f" "$TEST_HOME/.local/share/editr/" ;;
    esac
  done
  cp -a "$HOME/.local/state/editr" "$TEST_HOME/.local/state/"
  # Sem os aparelhos inscritos para avisos (o app de sempre já avisa das mesmas conversas) nem os
  # tokens do PIN deles.
  rm -f "$TEST_HOME/.local/state/editr/push.json" "$TEST_HOME/.local/state/editr/pin-tokens.json"
}

port_free() { ! ss -ltnH "sport = :$1" | grep -q .; }

stop_all

echo "Compilando $ROOT…"
mkdir -p "$DIR"
[ -d "$ROOT/node_modules" ] || (cd "$ROOT" && pnpm install --frozen-lockfile)
if ! (cd "$ROOT" && pnpm --filter web build && node desktop/scripts/build.mjs) >"$DIR/build.log" 2>&1; then
  tail -30 "$DIR/build.log" >&2
  exit 1
fi

if [ "$FRESH" = 1 ] || [ ! -d "$TEST_HOME" ]; then
  rm -rf "$TEST_HOME"
  make_home
fi
# O PIN só vale com a tailnet: sem ela, a instância só escuta no próprio PC.
if [ "$LINK" = 1 ]; then
  cp -a "$HOME/.local/state/editr/pin.json" "$TEST_HOME/.local/state/editr/" 2>/dev/null || true
else
  rm -f "$TEST_HOME/.local/state/editr/pin.json"
fi

# A porta da última vez (o app guarda o tamanho da janela por porta) ou a primeira livre.
TEST_PORT="$(cat "$DIR/port" 2>/dev/null || true)"
if [ -z "$TEST_PORT" ] || ! port_free "$TEST_PORT"; then
  TEST_PORT=""
  for p in $(seq 7338 7399); do
    if port_free "$p"; then
      TEST_PORT="$p"
      break
    fi
  done
fi
[ -n "$TEST_PORT" ] || { echo "Nenhuma porta livre entre 7338 e 7399." >&2; exit 1; }
echo "$TEST_PORT" >"$DIR/port"

systemd-run --user --unit="$UNIT" --collect --quiet --working-directory="$ROOT/server" \
  --setenv=PORT="$TEST_PORT" --setenv=HOME="$TEST_HOME" --setenv=EDITR_TEST_BUILD=1 \
  --setenv=PROJECT_ROOTS="${PROJECT_ROOTS:-$HOME/Projects}" --setenv=PATH="$PATH" \
  "$(command -v node)" src/index.ts

for _ in $(seq 60); do
  curl -fsS "http://127.0.0.1:$TEST_PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -fsS "http://127.0.0.1:$TEST_PORT/api/health" >/dev/null 2>&1; then
  echo "A instância de teste não respondeu:" >&2
  journalctl --user -u "$UNIT" --no-pager -n 20 >&2
  stop_all
  exit 1
fi

if [ "$LINK" = 1 ]; then
  LINK_PORT=$((10000 + TEST_PORT - 7338))
  tailscale serve --bg --https="$LINK_PORT" "http://127.0.0.1:$TEST_PORT" >/dev/null
  echo "$LINK_PORT" >"$DIR/link"
  TAILNET="$(curl -fsS "http://127.0.0.1:$TEST_PORT/api/health" | node -p 'JSON.parse(require("fs").readFileSync(0)).tailnetHost ?? ""')"
fi

ELECTRON="$ROOT/desktop/node_modules/electron/dist/electron"
# O pnpm não roda o postinstall do Electron (ver deploy/editr-app.sh): sem o binário, baixa.
[ -x "$ELECTRON" ] || node "$ROOT/desktop/node_modules/electron/install.js"
systemd-run --user --unit="$APP_UNIT" --collect --quiet \
  -p ExecStopPost="$ROOT/deploy/test-build.sh --stop" \
  --setenv=EDITR_TEST=1 --setenv=EDITR_PORT="$TEST_PORT" --setenv=PATH="$PATH" \
  ${WAYLAND_DISPLAY:+--setenv=WAYLAND_DISPLAY="$WAYLAND_DISPLAY"} ${DISPLAY:+--setenv=DISPLAY="$DISPLAY"} \
  "$ELECTRON" "$ROOT/desktop"

echo "App de teste aberto: $(git -C "$ROOT" rev-parse --abbrev-ref HEAD) em 127.0.0.1:$TEST_PORT"
echo "  dados: $TEST_HOME (cópia)"
echo "  servidor: $UNIT · app: $APP_UNIT"
[ "$LINK" = 1 ] && echo "  celular: https://${TAILNET:-<host da tailnet>}:$LINK_PORT"
echo "Recompilar o web recarrega a janela; fechar derruba a instância."
