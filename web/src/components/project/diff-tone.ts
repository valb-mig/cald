/** A cor e a marca dos blocos de mudança, do diff moderno (`DiffLines`) e da tela Código. */

/** Um bloco de mudança: as linhas seguidas que entram ou saem, de `start` até antes de `end`. */
export type Block = { start: number; end: number; adds: number; dels: number }

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** O que o bloco é, para a cor e a marca da bolinha: só entradas, só saídas ou uma troca. */
export function toneOf(b: Block) {
  if (!b.dels) return { sign: '+', dot: 'bg-emerald-500', line: 'border-emerald-500/60', label: plural(b.adds, 'linha adicionada', 'linhas adicionadas') }
  if (!b.adds) return { sign: '−', dot: 'bg-red-500', line: 'border-red-500/60', label: plural(b.dels, 'linha removida', 'linhas removidas') }
  return { sign: '±', dot: 'bg-amber-500', line: 'border-amber-500/60', label: `${plural(b.dels, 'removida', 'removidas')}, ${plural(b.adds, 'adicionada', 'adicionadas')}` }
}

export const TINT = { add: 'bg-emerald-500/[0.12]', del: 'bg-red-500/[0.12]' }
