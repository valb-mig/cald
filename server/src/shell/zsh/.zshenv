# Terminal do edit.r (ver ../editr.zsh): o zsh do painel lê os arquivos de início desta
# pasta, e cada um carrega o do usuário antes de voltar para cá. Assim vale toda a configuração dele.
EDITR_SHELL_DIR=$ZDOTDIR
ZDOTDIR=${EDITR_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
# O .zshenv do usuário pode ter trocado o ZDOTDIR: os próximos arquivos dele saem de lá.
EDITR_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$EDITR_SHELL_DIR
