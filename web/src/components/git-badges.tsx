import { ArrowDown, ArrowUp } from 'lucide-react'
import type { GitSummary } from '@/lib/types'

// Pílula cinza, como os outros chips neutros: as setas já dizem para que lado vão os commits.
const BADGE = 'flex shrink-0 items-center gap-0.5 rounded-full bg-foreground/[0.07] px-1.5 text-[10px] leading-4 font-medium text-muted-foreground tabular-nums'

/** Arquivos alterados, commits a enviar (↑) e commits novos no remoto (↓); nos projetos e na lista de conversas. */
export function GitBadges({ g }: { g: GitSummary }) {
  return (
    <>
      {g.changed > 0 && (
        <span className={BADGE}>
          {g.changed} {g.changed === 1 ? 'alterado' : 'alterados'}
        </span>
      )}
      {g.ahead > 0 && (
        <span
          className={BADGE}
          title={`${g.ahead} ${g.ahead === 1 ? 'commit para enviar' : 'commits para enviar'}`}
        >
          <ArrowUp className="size-3" />
          {g.ahead}
        </span>
      )}
      {g.behind > 0 && (
        <span
          className={BADGE}
          title={`${g.behind} ${g.behind === 1 ? 'commit novo' : 'commits novos'} em ${g.upstream}`}
        >
          <ArrowDown className="size-3" />
          {g.behind}
        </span>
      )}
    </>
  )
}
