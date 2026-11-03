import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentFace, typeLabel, useMember } from './agent-face'
import type { AgentNode } from './model'
import { AgentStatusIcon } from './status-icon'

/**
 * Subagente no bloco de atividade do chat: tarefa, tipo e, embaixo, o que está fazendo agora
 * (ou como terminou). Tocar abre o painel dele, com tudo o que fez.
 */
export function AgentRow({ node, onOpen }: { node: AgentNode; onOpen: () => void }) {
  const working = node.status === 'running' || node.status === 'waiting'
  const subagents = node.children.length
  const member = useMember(node)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60"
    >
      <AgentFace node={node} member={member} size={member ? 20 : 16} className={member ? 'mt-px' : 'mt-0.5'} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate font-medium">{node.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{typeLabel(node, member)}</span>
        </div>
        {(node.summary || node.now) && (
          <div
            className={cn(
              'mt-0.5 truncate text-xs text-muted-foreground',
              // O que faz agora é uma ferramenta (mono); o fim é texto.
              working && !node.summary && 'font-mono text-[11px]',
              node.status === 'waiting' && 'text-amber-700 dark:text-amber-300',
            )}
          >
            {node.summary ?? node.now}
          </div>
        )}
      </div>
      {subagents > 0 && <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">+{subagents}</span>}
      <AgentStatusIcon status={node.status} className="mt-0.5" />
      <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
    </button>
  )
}
