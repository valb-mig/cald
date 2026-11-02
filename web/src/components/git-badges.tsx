import { ArrowDown, ArrowUp } from 'lucide-react'
import type { GitSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

const BADGE = 'flex shrink-0 items-center gap-0.5 rounded px-1 text-[10px] font-medium'

/** Arquivos alterados, commits a enviar (↑) e commits novos no remoto (↓); nos projetos e na lista de conversas. */
export function GitBadges({ g }: { g: GitSummary }) {
  return (
    <>
      {g.changed > 0 && (
        <span className={cn(BADGE, 'bg-sky-500/15 text-sky-700 dark:text-sky-300')}>
          {g.changed} {g.changed === 1 ? 'alterado' : 'alterados'}
        </span>
      )}
      {g.ahead > 0 && (
        <span
          className={cn(BADGE, 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}
          title={`${g.ahead} ${g.ahead === 1 ? 'commit para enviar' : 'commits para enviar'}`}
        >
          <ArrowUp className="size-3" />
          {g.ahead}
        </span>
      )}
      {g.behind > 0 && (
        <span
          className={cn(BADGE, 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300')}
          title={`${g.behind} ${g.behind === 1 ? 'commit novo' : 'commits novos'} em ${g.upstream}`}
        >
          <ArrowDown className="size-3" />
          {g.behind}
        </span>
      )}
    </>
  )
}
