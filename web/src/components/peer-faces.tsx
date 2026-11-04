import { Claudinho } from '@/components/claudinho'
import { claudinhoName } from '@/lib/claudinho'
import type { CatalogEntry } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Os claudinhos de várias conversas, como os de um time (ver teams/team-faces.tsx); passando de `max`, um "+n". */
export function PeerFaces({ list, size = 16, max = 3, className }: { list: CatalogEntry[]; size?: number; max?: number; className?: string }) {
  const extra = list.length - max
  return (
    <span className={cn('flex shrink-0 items-center', className)}>
      {list.slice(0, max).map((s, i) => (
        <Claudinho
          key={s.sessionId}
          seed={s.sessionId}
          name={claudinhoName(s.sessionId, s.claudinhoName)}
          size={size}
          className={i > 0 ? '-ml-1' : undefined}
        />
      ))}
      {extra > 0 && <span className="ml-0.5 text-[10px] text-muted-foreground tabular-nums">+{extra}</span>}
    </span>
  )
}
