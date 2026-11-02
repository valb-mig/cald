import { Badge } from '@/components/ui/badge'
import { stateInfo, type Tone } from '@/lib/format'
import type { CatalogState, SessionState } from '@/lib/types'
import { cn } from '@/lib/utils'

const toneClass: Record<Tone, string> = {
  running: 'border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300',
  attention: 'border-transparent bg-amber-500/20 text-amber-800 dark:text-amber-300',
  done: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  muted: 'text-muted-foreground',
}

export function StateBadge({
  state,
  waitingFor,
  className,
}: {
  state: CatalogState | SessionState | undefined
  waitingFor?: string
  className?: string
}) {
  const { label, tone } = stateInfo(state, waitingFor)
  return (
    <Badge variant="outline" className={cn('gap-1.5', toneClass[tone], className)}>
      {/* O ponto brilha na própria cor: trabalhando ou esperando você. */}
      {tone === 'running' && <span className="size-1.5 animate-pulse rounded-full bg-current shadow-[0_0_6px_currentColor]" />}
      {tone === 'attention' && <span className="size-1.5 rounded-full bg-current shadow-[0_0_6px_currentColor]" />}
      {label}
    </Badge>
  )
}
