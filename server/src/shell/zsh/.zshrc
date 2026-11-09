ZDOTDIR=$EDITR_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
ZDOTDIR=$EDITR_SHELL_DIR
# Por último: o prompt do painel vale por cima do tema do usuário.
source $EDITR_SHELL_DIR/../editr.zsh
