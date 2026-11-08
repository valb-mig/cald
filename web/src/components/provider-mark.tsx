import { Bot } from 'lucide-react'
import { ClaudeMark } from '@/components/claude-mark'
import { CLAUDE } from '@/lib/providers'
import { cn } from '@/lib/utils'

/** A marca de um agente (ver lib/providers.ts): o asterisco do Claude, ou um robô no cinza para os outros. */
export function ProviderMark({ id, className }: { id: string; className?: string }) {
  if (id === CLAUDE) return <ClaudeMark className={className} />
  return <Bot aria-hidden className={cn('shrink-0 text-muted-foreground', className)} />
}
