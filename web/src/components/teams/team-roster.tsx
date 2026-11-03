import { Claudinho } from '@/components/claudinho'
import { prettyModel } from '@/components/chat/composer-controls'
import type { AgentNode, AgentTree } from '@/components/agents/model'
import { AgentStatusIcon } from '@/components/agents/status-icon'
import type { TeamSnapshot } from '@/lib/types'
import { memberSeed } from './model'

const EFFORT: Record<string, string> = { low: 'baixo', medium: 'médio', high: 'alto', xhigh: 'muito alto', max: 'máximo' }

/**
 * O time da conversa, no alto da folha de agentes: cada membro com o claudinho, o papel, o modelo e o
 * esforço, e o que está fazendo agora (as chamadas dele são as do `subagent_type` com a chave dele).
 * Tocar abre a última chamada dele.
 */
export function TeamRoster({ team, tree, onOpen }: { team: TeamSnapshot; tree: AgentTree; onOpen: (id: string) => void }) {
  const calls = new Map<string, AgentNode[]>()
  for (const node of tree.all) calls.set(node.type, [...(calls.get(node.type) ?? []), node])
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">Time {team.name}</h3>
      <ul className="divide-y overflow-hidden rounded-xl border bg-card">
        {team.members.map((m) => {
          const mine = calls.get(m.key) ?? []
          const live = mine.find((n) => n.status === 'running' || n.status === 'waiting')
          const last = live ?? mine.at(-1)
          const line = live ? (live.summary ?? live.now ?? live.name) : last ? `Fez: ${last.name}` : 'Livre'
          const spec = [prettyModel(m.model), m.effort && EFFORT[m.effort]].filter(Boolean).join(' · ')
          const body = (
            <>
              <Claudinho seed={memberSeed(m)} size={32} state={live ? 'running' : undefined} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate text-sm font-medium">{m.name}</span>
                  {m.role && <span className="shrink-0 text-xs text-muted-foreground">{m.role}</span>}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{spec}</span>
                </div>
                <div className="truncate text-xs text-muted-foreground">{line}</div>
              </div>
              {last && <AgentStatusIcon status={last.status} />}
            </>
          )
          return (
            <li key={m.id}>
              {last ? (
                <button type="button" onClick={() => onOpen(last.id)} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-muted/50">
                  {body}
                </button>
              ) : (
                <div className="flex items-center gap-2.5 px-3 py-2.5">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
