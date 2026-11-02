# Terminal do Claude Remote (ver ../claude-remote.zsh): o zsh do painel lê os arquivos de início desta
# pasta, e cada um carrega o do usuário antes de voltar para cá. Assim vale toda a configuração dele.
CR_SHELL_DIR=$ZDOTDIR
ZDOTDIR=${CR_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
# O .zshenv do usuário pode ter trocado o ZDOTDIR: os próximos arquivos dele saem de lá.
CR_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$CR_SHELL_DIR
