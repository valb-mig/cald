# Terminal do cald (ver ../cald.zsh): o zsh do painel lê os arquivos de início desta
# pasta, e cada um carrega o do usuário antes de voltar para cá. Assim vale toda a configuração dele.
CALD_SHELL_DIR=$ZDOTDIR
ZDOTDIR=${CALD_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
# O .zshenv do usuário pode ter trocado o ZDOTDIR: os próximos arquivos dele saem de lá.
CALD_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$CALD_SHELL_DIR
