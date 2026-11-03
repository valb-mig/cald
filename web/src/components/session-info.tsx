import { Bot, GitFork, Hourglass, Layers, Monitor, Pin, Server } from 'lucide-react'
import { Claudinho } from '@/components/claudinho'
import { TeamFaces } from '@/components/teams/team-faces'
import { claudinhoName } from '@/lib/claudinho'
import { projectName, relativeTime, shortTime, stateInfo } from '@/lib/format'
import { HOME, useMachines } from '@/lib/machines'
import type { CatalogEntry } from '@/lib/types'
import { cn } from '@/lib/utils'
import { workspaceColor } from '@/lib/workspaces'

/**
 * Conteúdo de uma conversa numa lista, como numa lista de mensagens: o claudinho dela, com o estado
 * nele (como na alça e nas abas), o título com a hora no canto e, embaixo, o nome dele, o
 * projeto e se está aberta no PC. O estado só vira texto quando pede olhar: trabalhando (azul) ou
 * esperando você (âmbar); concluída é o normal e fica sem rótulo. `grouped`: dentro do grupo do
 * projeto (ver pages/sessions.tsx), que já diz o projeto e a máquina. `roomy`: na lista do celular,
 * claudinho e letras maiores, para o dedo e para ler de longe.
 */
export function SessionInfo({ s, grouped = false, roomy = false }: { s: CatalogEntry; grouped?: boolean; roomy?: boolean }) {
  // Com várias máquinas, cada conversa diz de qual é.
  const machine = useMachines((m) =>
    !grouped && m.machines.length > 1 ? m.machines.find((x) => x.id === (s.machine ?? HOME))?.name : undefined,
  )
  // Turno acabou com algo em segundo plano (monitor, comando): o Claude ainda vai voltar.
  const background = s.state === 'idle' && Boolean(s.tasks?.length)
  const state = background ? 'running' : s.state
  const { label, tone } = stateInfo(state, background ? 'background' : s.waitingFor)
  const name = claudinhoName(s.sessionId, s.claudinhoName)
  const size = roomy ? 40 : grouped ? 28 : 32
  return (
    <>
      {/* Com time, os claudinhos dele ficam ao lado do da conversa, menores, como quem está junto. */}
      <span className="mt-0.5 flex shrink-0 items-end">
        <Claudinho seed={s.sessionId} name={name} state={state} thinking={s.thinking} status size={size} />
        {s.team && <TeamFaces team={s.team} size={Math.round(size * 0.55)} max={3} className="-ml-0.5 pb-px" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {s.pinned && <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label="Fixada" />}
          {s.forkedFrom && <GitFork className="size-3.5 shrink-0 text-muted-foreground" aria-label="Bifurcada de outra conversa" />}
          <span className={cn('min-w-0 flex-1 truncate font-medium', roomy ? 'text-[15px]' : 'text-sm')}>{s.title}</span>
          <span className={cn('shrink-0 text-muted-foreground tabular-nums', roomy ? 'text-xs' : 'text-[11px]')} title={relativeTime(s.lastModified)}>
            {shortTime(s.lastModified)}
          </span>
        </div>
        <div className={cn('mt-0.5 flex items-center gap-1.5 text-muted-foreground', roomy ? 'text-[13px]' : 'text-xs')}>
          <span className="shrink-0 font-medium text-foreground/70">{name}</span>
          {s.workspace && (
            <>
              <span>·</span>
              <span className="flex min-w-0 shrink items-center gap-1 font-medium" style={{ color: workspaceColor(s.workspace.color) }}>
                <Layers className="size-3 shrink-0" />
                <span className="truncate">{s.workspace.name}</span>
              </span>
            </>
          )}
          {!grouped && (
            <>
              <span>·</span>
              <span className="truncate">{projectName(s.cwd)}</span>
            </>
          )}
          {machine && (
            <>
              <span>·</span>
              <span className="flex shrink-0 items-center gap-0.5">
                <Server className="size-3" />
                {machine}
              </span>
            </>
          )}
          {(tone === 'running' || tone === 'attention') && (
            <>
              <span>·</span>
              <span className={cn('truncate', tone === 'running' ? 'text-sky-700 dark:text-sky-300' : 'text-amber-700 dark:text-amber-300')}>
                {label}
              </span>
            </>
          )}
          {/* No canto, como a hora em cima: subagentes trabalhando e se a conversa está aberta no PC. */}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
            {s.agents ? (
              <span
                className="flex items-center gap-0.5 text-[11px] text-sky-700 tabular-nums dark:text-sky-300"
                title={`${s.agents} ${s.agents === 1 ? 'subagente' : 'subagentes'}`}
              >
                <Bot className="size-3" />
                {s.agents}
              </span>
            ) : null}
            {/* Aberta no painel é o normal e fica sem marca; no PC, ela é só de leitura aqui. */}
            {s.owner === 'pc' && (
              <span title="Aberta no PC">
                <Monitor className="size-3" aria-label="Aberta no PC" />
              </span>
            )}
          </span>
        </div>
        {s.tasks?.length ? (
          <div className={cn('mt-0.5 flex min-w-0 items-center gap-1 text-sky-700 dark:text-sky-300', roomy ? 'text-[13px]' : 'text-xs')}>
            <Hourglass className="size-3 shrink-0" />
            <span className="truncate">{s.tasks[0]!.description}</span>
            {s.tasks.length > 1 && <span className="shrink-0">+{s.tasks.length - 1}</span>}
          </div>
        ) : null}
      </div>
    </>
  )
}
