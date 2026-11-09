#!/usr/bin/env bash
# install.sh — instala o edit.r de ponta a ponta:
#   compila o app, sobe o serviço systemd, publica na tailnet e instala o alias `editr`.
# No fim, imprime o link que o celular vai acessar.
#
# Uso:  ./deploy/install.sh        (de dentro do projeto clonado)
# Opções por variável de ambiente:
#   PORT=7337   porta local do servidor (o tailscale serve aponta para ela)
set -euo pipefail

# --- localização do projeto -------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PORT="${PORT:-7337}"
SERVICE_NAME="editr"
# Nomes de antes (claude-remote, depois cald): os serviços e o alias antigos saem na reinstalação.
LEGACY_SERVICES=(cald claude-remote)

# --- saída ------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\e[1m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; DIM=$'\e[2m'; RESET=$'\e[0m'
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; DIM=""; RESET=""
fi
step() { printf '\n%s==>%s %s%s%s\n' "$GREEN" "$RESET" "$BOLD" "$1" "$RESET"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '%s!!%s  %s\n' "$YELLOW" "$RESET" "$1" >&2; }
die()  { printf '%s✗%s  %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- 1. requisitos ----------------------------------------------------------
step "Conferindo requisitos"

have node  || die "Node.js não encontrado. Instale a versão 22.18 ou mais nova."
have pnpm  || die "pnpm não encontrado. Instale com: npm install -g pnpm"
have systemctl || die "systemd não encontrado. O serviço depende de 'systemctl --user'."

# Node >= 22.18
node_ver="$(node -v | sed 's/^v//')"
node_major="${node_ver%%.*}"
node_minor="${node_ver#*.}"; node_minor="${node_minor%%.*}"
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 18 ]; }; then
  die "Node.js $node_ver é antigo demais; precisa de 22.18 ou mais novo."
fi
info "Node.js $node_ver"

have claude    || warn "Claude Code (claude) não encontrado no PATH. Instale e rode 'claude' uma vez para logar."
have tailscale || warn "Tailscale não encontrado. Sem ele, só o acesso local (127.0.0.1) vai funcionar."

# --- 2. build ---------------------------------------------------------------
step "Instalando dependências e compilando o app"
( cd "$PROJECT_DIR" && pnpm install && pnpm build )
info "web/dist gerado."

# --- 3. serviço systemd -----------------------------------------------------
step "Configurando o serviço de usuário ($SERVICE_NAME)"

# Shell de login do usuário (para o serviço herdar PATH/variáveis do rc).
login_shell="$(getent passwd "$USER" 2>/dev/null | cut -d: -f7)"
case "$login_shell" in
  *zsh)  SHELL_BIN="$(command -v zsh)"  ;;
  *bash) SHELL_BIN="$(command -v bash)" ;;
  *)     SHELL_BIN="$(command -v zsh || command -v bash)" ;;
esac
[ -n "${SHELL_BIN:-}" ] || die "Nem zsh nem bash foram encontrados para rodar o serviço."

# Como invocar o node: version managers (nvm/fnm/mise/asdf) embutem a versão no
# caminho, então usamos só 'node' (resolvido pelo PATH do shell de login);
# para instalações do sistema, usamos o caminho absoluto.
node_bin="$(command -v node)"
case "$node_bin" in
  */.nvm/*|*/.fnm/*|*/mise/*|*/.asdf/*|*/.local/*|*/.volta/*) NODE_INVOKE="node" ;;
  *) NODE_INVOKE="$node_bin" ;;
esac

SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME.service"
mkdir -p "$SERVICE_DIR"

# Instalação de antes da troca de nome: desliga o serviço antigo, que ocupa a mesma porta. As pastas
# de dados mudam de nome sozinhas na primeira subida do servidor (ver server/src/config.ts).
# O -L pega a unit instalada como symlink para o arquivo antigo do deploy: o pull que trouxe o nome
# novo a deixa quebrada, o -e dá falso e o 'disable' falha, então o link em default.target.wants sai à mão.
for legacy in "${LEGACY_SERVICES[@]}"; do
  legacy_file="$SERVICE_DIR/$legacy.service"
  if [ -e "$legacy_file" ] || [ -L "$legacy_file" ]; then
    systemctl --user disable --now "$legacy" >/dev/null 2>&1 || true
    rm -f "$legacy_file" "$SERVICE_DIR/default.target.wants/$legacy.service"
    info "Serviço antigo ($legacy) desligado e removido."
  fi
done
# Remove qualquer arquivo/symlink anterior (ex.: de um 'systemctl --user link'),
# senão o '>' escreveria através do symlink e alteraria o arquivo do repo.
rm -f "$SERVICE_FILE"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=edit.r (painel mobile do Claude Code)

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR/server
Environment=PORT=$PORT
# Via shell de login interativo para herdar o ambiente do seu rc (PATH, JAVA_HOME…):
# as sessões abertas pelo celular precisam enxergar as mesmas ferramentas do terminal.
ExecStart=$SHELL_BIN -lic 'exec $NODE_INVOKE src/index.ts'
SyslogIdentifier=$SERVICE_NAME
Restart=on-failure
RestartSec=3
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
info "Escrito em $SERVICE_FILE"
info "ExecStart=$SHELL_BIN -lic 'exec $NODE_INVOKE src/index.ts'"

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"
loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "Não consegui ligar o linger; o serviço pode não subir sem login no PC."

# Confere a saúde pela porta local.
sleep 1
if have curl && curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  info "Servidor respondendo em http://127.0.0.1:$PORT"
else
  warn "O serviço subiu mas /api/health ainda não respondeu. Veja: journalctl --user -u $SERVICE_NAME -f"
fi

# --- 4. publicar na tailnet -------------------------------------------------
REMOTE_URL=""
if have tailscale; then
  step "Publicando na tailnet (tailscale serve --bg $PORT)"
  serve_out=""
  if ! serve_out="$(tailscale serve --bg "$PORT" 2>&1)"; then
    if printf '%s' "$serve_out" | grep -qi "denied"; then
      warn "Acesso negado. Rode e tente de novo:  sudo tailscale set --operator=\"$USER\""
    else
      warn "Falha ao publicar: $serve_out"
    fi
  fi
  # Em http, na porta 80: digitar só o nome da máquina (http://<máquina>, pelo MagicDNS) cai no
  # endereço completo, que o servidor devolve (ver server/src/guard.ts). Falhar aqui não atrapalha o resto.
  tailscale serve --bg --http=80 "$PORT" >/dev/null 2>&1 || warn "Não deu para publicar o atalho em http (porta 80)."
  REMOTE_URL="$(tailscale serve status 2>/dev/null | awk '/^https:\/\// {print $1; exit}')"
  if [ -z "$REMOTE_URL" ]; then
    warn "Ainda não há link publicado. Confira MagicDNS e HTTPS Certificates no painel do Tailscale."
  fi
fi

# --- 5. alias `editr` no shell -----------------------------------------------
step "Instalando o comando 'editr' (alias)"
chmod +x "$SCRIPT_DIR/editr.sh"

BEGIN_MARK="# >>> editr >>>"
END_MARK="# <<< editr <<<"
install_alias() {
  local rc="$1"
  [ -e "$rc" ] || return 0
  # Remove o bloco anterior (idempotente; também os dos aliases antigos `cald` e `cr`) e reescreve com
  # o caminho atual.
  sed -i -e "\|$BEGIN_MARK|,\|$END_MARK|d" \
    -e "\|# >>> cald >>>|,\|# <<< cald <<<|d" \
    -e "\|# >>> claude.remote (cr) >>>|,\|# <<< claude.remote (cr) <<<|d" "$rc"
  {
    printf '%s\n' "$BEGIN_MARK"
    printf 'alias editr="%s"\n' "$SCRIPT_DIR/editr.sh"
    printf '%s\n' "$END_MARK"
  } >> "$rc"
  info "Alias adicionado em $rc"
}

installed_in_any=0
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  if [ -e "$rc" ]; then install_alias "$rc"; installed_in_any=1; fi
done
if [ "$installed_in_any" -eq 0 ]; then
  warn "Não achei ~/.zshrc nem ~/.bashrc. Para usar 'editr', adicione à mão:"
  warn "  alias editr=\"$SCRIPT_DIR/editr.sh\""
fi

# --- fim --------------------------------------------------------------------
step "Pronto 🎉"
if [ -n "$REMOTE_URL" ]; then
  printf '\n    Link de acesso remoto (abra no celular com o Tailscale ligado):\n'
  printf '      %s%s%s\n' "$BOLD" "$REMOTE_URL" "$RESET"
else
  printf '\n    %sO link ainda não está disponível.%s Depois de configurar o tailscale serve, pegue com:\n' "$YELLOW" "$RESET"
fi
printf '\n    %sAbra um novo terminal (ou rode:  source ~/.zshrc) e consulte o link quando quiser:%s\n' "$DIM" "$RESET"
printf '      %seditr -link%s\n\n' "$BOLD" "$RESET"
