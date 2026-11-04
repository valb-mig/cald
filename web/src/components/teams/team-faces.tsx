import { CircleDashed } from 'lucide-react'
import { Claudinho } from '@/components/claudinho'
import type { Team } from '@/lib/types'
import { cn } from '@/lib/utils'
import { memberSeed } from './model'

/**
 * Os claudinhos do time lado a lado, um pouco por cima do outro; passando de `max`, um "+n". Sem
 * ninguém, nada; com `placeholder`, um lugar tracejado do tamanho de um claudinho, para o nome ao lado
 * alinhar com o dos outros times numa lista.
 */
export function TeamFaces({
  team,
  size = 20,
  max = 5,
  placeholder = false,
  className,
}: {
  team: Pick<Team, 'members'>
  size?: number
  max?: number
  placeholder?: boolean
  className?: string
}) {
  if (placeholder && team.members.length === 0) return <CircleDashed size={size} className={cn('shrink-0 text-muted-foreground/50', className)} />
  const extra = team.members.length - max
  return (
    <span className={cn('flex shrink-0 items-center', className)}>
      {team.members.slice(0, max).map((m, i) => (
        <Claudinho key={m.id} seed={memberSeed(m)} size={size} className={i > 0 ? '-ml-1.5' : undefined} />
      ))}
      {extra > 0 && <span className="ml-0.5 text-[10px] text-muted-foreground tabular-nums">+{extra}</span>}
    </span>
  )
}
