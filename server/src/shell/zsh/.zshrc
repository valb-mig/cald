ZDOTDIR=$CR_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
ZDOTDIR=$CR_SHELL_DIR
# Por último: o prompt do painel vale por cima do tema do usuário.
source $CR_SHELL_DIR/../claude-remote.zsh
