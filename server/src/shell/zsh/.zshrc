ZDOTDIR=$CALD_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
ZDOTDIR=$CALD_SHELL_DIR
# Por último: o prompt do painel vale por cima do tema do usuário.
source $CALD_SHELL_DIR/../cald.zsh
