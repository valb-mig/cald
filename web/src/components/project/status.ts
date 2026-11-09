import type { DiffSide, GitFile } from '@/lib/types'

/** Nome e pasta de um caminho do projeto. */
export function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  return { name: path.slice(slash + 1), dir: slash > 0 ? path.slice(0, slash) : '' }
}

export type Badge = { letter: string; className: string; label: string }

/** Como cada diff se chama: o rótulo curto, ao lado do nome na aba, o do título dela e o do visualizador. */
export const DIFF_LABEL: Record<DiffSide, { short: string; long: string; title: string }> = {
  staged: { short: 'preparado', long: 'alterações preparadas', title: 'Alterações preparadas' },
  unstaged: { short: 'alterações', long: 'alterações', title: 'Alterações' },
  head: { short: 'alterações', long: 'alterações', title: 'Alterações' },
  base: { short: 'da branch', long: 'alterações da branch', title: 'Alterações da branch' },
}

export const BADGES = {
  U: { letter: 'U', className: 'text-emerald-600 dark:text-emerald-400', label: 'novo' },
  M: { letter: 'M', className: 'text-amber-600 dark:text-amber-400', label: 'modificado' },
  A: { letter: 'A', className: 'text-emerald-600 dark:text-emerald-400', label: 'adicionado' },
  D: { letter: 'D', className: 'text-red-600 dark:text-red-400', label: 'apagado' },
  R: { letter: 'R', className: 'text-sky-600 dark:text-sky-400', label: 'renomeado' },
  '!': { letter: '!', className: 'text-red-600 dark:text-red-400', label: 'em conflito' },
} satisfies Record<string, Badge>

/** Em conflito de merge: os dois lados mexeram (UU, AA, DD, AU...). */
export const isConflict = (f: GitFile) => f.index === 'U' || f.worktree === 'U' || (f.index === f.worktree && (f.index === 'A' || f.index === 'D'))

/** Já tem algo staged. */
export const isStaged = (f: GitFile) => !f.untracked && !isConflict(f) && f.index !== '.'

/** Tem algo fora do stage: alterado, novo ou em conflito. */
export const isUnstaged = (f: GitFile) => f.untracked || isConflict(f) || f.worktree !== '.'

/**
 * Letra e cor como no VSCode: U novo, M modificado, A adicionado, D apagado, R renomeado, ! em
 * conflito. Com `side`, a do lado pedido (o arquivo pode estar staged de um jeito e alterado de outro).
 */
export function badge(f: GitFile, side?: DiffSide): Badge {
  if (f.untracked) return BADGES.U
  if (isConflict(f)) return BADGES['!']
  const code = side === 'staged' ? f.index : side === 'unstaged' ? f.worktree : f.worktree !== '.' ? f.worktree : f.index
  switch (code) {
    case 'M':
    case 'T':
      return BADGES.M
    case 'A':
      return BADGES.A
    case 'D':
      return BADGES.D
    case 'R':
    case 'C':
      return BADGES.R
    default:
      return BADGES['!']
  }
}

// Numa pasta com várias alterações dentro, a cor é a da mais importante.
const RANK = ['!', 'M', 'R', 'A', 'U', 'D']

/**
 * A marca de cada arquivo alterado e das pastas que têm algum alterado dentro, para a árvore pintar
 * como o VSCode. As pastas ficam com a cor e um ponto no lugar da letra.
 */
export function treeMarks(files: GitFile[]): Map<string, Badge> {
  const marks = new Map<string, Badge>()
  for (const f of files) {
    const b = badge(f)
    marks.set(f.path, b)
    const parts = f.path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      const prev = marks.get(dir)
      if (!prev || RANK.indexOf(b.letter) < RANK.indexOf(prev.letter)) marks.set(dir, b)
    }
  }
  return marks
}
