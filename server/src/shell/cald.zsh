# O terminal do cald (ver server/src/terminal.ts e web/src/components/terminal.tsx).
#
# Cada comando vira um bloco: antes do prompt, uma linha de cabeçalho com a pasta e a branch (e uma
# bolinha âmbar com mudança sem commit), e o prompt é um `›` no laranja do Claude. As marcas OSC 133
# (as do FinalTerm, que o VSCode também usa) dizem ao painel onde cada bloco começa, quando o comando
# roda e com que código saiu: o painel desenha a faixa do cabeçalho e põe nela o resultado e o tempo.
#   A  começo do cabeçalho    B  começo do que se digita    C  o comando rodou    D;n  saiu com n

typeset -gi __cr_ran=0 __cr_first=1 __cr_code=0

__cr_osc() { printf '\e]133;%s\a' "$1" }

# A linha do cabeçalho: a pasta (o nome, ou ~) e, num repositório, a branch.
__cr_head() {
  local name=${PWD:t}
  [[ $PWD == $HOME ]] && name='~'
  local branch dirty=''
  branch=$(git symbolic-ref --short -q HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)
  if [[ -n $branch ]] && ! git diff --quiet --ignore-submodules HEAD -- 2>/dev/null; then
    # O âmbar do app (o de "esperando você"), fixo: o amarelo do tema claro do terminal é quase marrom.
    dirty=$' \e[38;2;245;158;11m●\e[0m'
  fi
  printf ' \e[1m%s\e[0m' "$name"
  [[ -n $branch ]] && printf '  \e[37m%s\e[0m%s' "$branch" "$dirty"
  printf '\n'
}

# O primeiro de todos: guarda o código de saída antes que outro gancho (o do tema) o troque.
__cr_status() { __cr_code=$? }

__cr_precmd() {
  (( __cr_ran )) && __cr_osc "D;$__cr_code"
  __cr_ran=0
  # Um respiro entre um bloco e o próximo; o primeiro cola no alto.
  (( __cr_first )) || print ''
  __cr_first=0
  __cr_osc A
  __cr_head
}

__cr_preexec() {
  __cr_ran=1
  __cr_osc C
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec __cr_preexec
precmd_functions=(__cr_status ${precmd_functions:#(__cr_status|__cr_precmd)} __cr_precmd)

PROMPT=$'%{\e[38;2;217;119;87m%}›%{\e[0m%} %{\e]133;B\a%}'
RPROMPT=''
# Sem o `%` que o zsh põe quando a saída não termina em quebra de linha: o respiro já separa.
PROMPT_EOL_MARK=''
