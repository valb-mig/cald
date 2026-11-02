import { Bot, GitFork, Hourglass, Monitor, Pin, Server, Smartphone } from 'lucide-react'
import { Claudinho } from '@/components/claudinho'
import { claudinhoName } from '@/lib/claudinho'
import { StateBadge } from '@/components/state-badge'
import { projectName, relativeTime } from '@/lib/format'
import { HOME, useMachines } from '@/lib/machines'
import type { CatalogEntry } from '@/lib/types'

/**
 * Conteúdo de uma conversa numa lista: o claudinho dela, título, projeto, quando mexeu por último,
 * estado e onde está aberta. `grouped`: dentro do grupo do projeto (ver pages/sessions.tsx), que já
 * diz o projeto e a máquina.
 */
export function SessionInfo({ s, grouped = false }: { s: CatalogEntry; grouped?: boolean }) {
  // Com várias máquinas, cada conversa diz de qual é.
  const machine = useMachines((m) =>
    !grouped && m.machines.length > 1 ? m.machines.find((x) => x.id === (s.machine ?? HOME))?.name : undefined,
  )
  // Turno acabou com algo em segundo plano (monitor, comando): o Claude ainda vai voltar.
  const background = s.state === 'idle' && Boolean(s.tasks?.length)
  const name = claudinhoName(s.sessionId, s.claudinhoName)
  return (
    <>
      <Claudinho seed={s.sessionId} name={name} state={background ? 'running' : s.state} size={grouped ? 28 : 32} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {s.pinned && <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label="Fixada" />}
          {s.forkedFrom && <GitFork className="size-3.5 shrink-0 text-muted-foreground" aria-label="Bifurcada de outra conversa" />}
          <span className="truncate">{s.title}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 font-medium text-foreground/70">{name}</span>
          <span>·</span>
          {!grouped && <span className="truncate">{projectName(s.cwd)}</span>}
          {machine && (
            <>
              <span>·</span>
              <span className="flex shrink-0 items-center gap-0.5">
                <Server className="size-3" />
                {machine}
              </span>
            </>
          )}
          {!grouped && <span>·</span>}
          <span className="shrink-0">{relativeTime(s.lastModified)}</span>
        </div>
        {s.tasks?.length ? (
          <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-sky-700 dark:text-sky-300">
            <Hourglass className="size-3 shrink-0" />
            <span className="truncate">{s.tasks[0]!.description}</span>
            {s.tasks.length > 1 && <span className="shrink-0">+{s.tasks.length - 1}</span>}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {s.state !== 'stopped' && (
          <StateBadge state={background ? 'running' : s.state} waitingFor={background ? 'background' : s.waitingFor} />
        )}
        {s.agents ? (
          <span className="flex items-center gap-1 text-[11px] text-sky-700 dark:text-sky-300">
            <Bot className="size-3" />
            {s.agents} {s.agents === 1 ? 'subagente' : 'subagentes'}
          </span>
        ) : null}
        {s.owner && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {s.owner === 'pc' ? <Monitor className="size-3" /> : <Smartphone className="size-3" />}
            {s.owner === 'pc' ? 'no PC' : 'no painel'}
          </span>
        )}
      </div>
    </>
  )
}
