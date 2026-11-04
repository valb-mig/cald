import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { Claudinho } from '@/components/claudinho'
import { PeerFaces } from '@/components/peer-faces'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import { claudinhoName } from '@/lib/claudinho'
import { projectName, stateInfo } from '@/lib/format'
import { namesOf, usePeers } from '@/lib/peers'
import { openBeside, useSplit } from '@/lib/split'
import type { CatalogEntry } from '@/lib/types'
import { cn } from '@/lib/utils'

// Como a salinha: o que cada um faz muda a cada ferramenta.
const POLL_MS = 2_500

/** O que a própria conversa (não os subagentes) faz agora, por conversa, enquanto o menu está aberto. */
function useDoing(machine: string, open: boolean): Record<string, string> {
  const [doing, setDoing] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open) return
    let alive = true
    const load = () =>
      api.office(machine).then(
        (rooms) => {
          if (!alive) return
          const next: Record<string, string> = {}
          for (const r of rooms) {
            const detail = r.workers.find((w) => w.id === 'lead')?.detail
            if (detail) next[r.sessionId] = detail
          }
          setDoing(next)
        },
        // Servidor antigo ou fora do ar: o menu fica só com o estado de cada uma.
        () => {},
      )
    void load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [machine, open])
  return doing
}

function PeerItem({ s, doing, onOpen }: { s: CatalogEntry; doing?: string; onOpen: (id: string) => void }) {
  const background = s.state === 'idle' && Boolean(s.tasks?.length)
  const state = background ? 'running' : s.state
  const { label, tone } = stateInfo(state, background ? 'background' : s.waitingFor)
  const name = claudinhoName(s.sessionId, s.claudinhoName)
  return (
    <DropdownMenuItem onSelect={() => onOpen(s.sessionId)} className="items-start gap-2.5 py-2">
      <Claudinho seed={s.sessionId} name={name} state={state} thinking={s.thinking} status size={24} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-medium">{name}</span>
          <span className="truncate text-muted-foreground">{s.title}</span>
        </span>
        <span
          className={cn(
            'block truncate text-xs',
            tone === 'running' ? 'text-sky-700 dark:text-sky-300' : tone === 'attention' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground',
          )}
        >
          {/* Esperando você, o estado diz mais do que a última ferramenta. */}
          {(tone === 'running' && doing) || label}
        </span>
      </span>
    </DropdownMenuItem>
  )
}

/**
 * No cabeçalho do chat, quem mais trabalha agora no mesmo checkout: os claudinhos e o nome deles. O
 * menu mostra o que cada um faz e as abertas paradas; escolher uma a abre ao lado (ou vai até ela, se
 * já está à vista). Sem ninguém trabalhando junto, não aparece. `compact`: só os claudinhos.
 */
export function PeerChip({ id, machine, cwd, compact = false }: { id: string; machine: string; cwd?: string; compact?: boolean }) {
  const { working, idle } = usePeers(machine, cwd, id)
  const [open, setOpen] = useState(false)
  const doing = useDoing(machine, open)
  const split = useSplit()
  const [, navigate] = useLocation()
  if (!working.length) return null
  const project = projectName(cwd)
  const summary = `${namesOf(working)} também ${working.length === 1 ? 'mexe' : 'mexem'} em ${project} agora`
  const go = (peer: string) => {
    if (split.canAdd || split.ids.includes(peer)) openBeside(peer, id)
    else navigate(`/s/${peer}`)
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={summary}
          aria-label={summary}
          className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-sky-500/10 pr-1.5 pl-1 text-[10px] font-medium text-sky-800 ring-1 ring-sky-500/25 transition-colors outline-none ring-inset hover:bg-sky-500/20 focus-visible:ring-2 focus-visible:ring-ring dark:text-sky-200"
        >
          <PeerFaces list={working} size={14} max={compact ? 2 : 3} />
          {!compact && <span className="max-w-28 truncate">com {namesOf(working, 2)}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Mexendo em {project} agora</DropdownMenuLabel>
        {working.map((s) => (
          <PeerItem key={s.sessionId} s={s} doing={doing[s.sessionId]} onOpen={go} />
        ))}
        {idle.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Abertas, paradas</DropdownMenuLabel>
            {idle.map((s) => (
              <PeerItem key={s.sessionId} s={s} onOpen={go} />
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
