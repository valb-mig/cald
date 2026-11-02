ZDOTDIR=$CR_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zlogin ]] && source $ZDOTDIR/.zlogin
# Daqui em diante é o zsh de sempre: um zsh aberto dentro deste lê só a configuração do usuário.
unset CR_SHELL_DIR CR_USER_ZDOTDIR
