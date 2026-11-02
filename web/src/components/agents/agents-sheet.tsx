import { CornerDownRight, List, Network } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import type { AgentNode, AgentTree } from './model'
import { agentMeta, countLine, useNow } from './status'
import { AgentStatusIcon } from './status-icon'

// O grafo só aparece com a folha aberta na aba dele: chega quando for desenhado.
const AgentGraph = lazy(() => import('./agent-graph').then((m) => ({ default: m.AgentGraph })))

type View = 'graph' | 'list'
// Grafo ou lista: a última escolha vale para todas as conversas.
const VIEW_KEY = 'cr:agents-view'

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'graph'
  } catch {
    return 'graph'
  }
}

function ListRow({ node, now, onOpen }: { node: AgentNode; now: number; onOpen: (id: string) => void }) {
  const working = node.status === 'running' || node.status === 'waiting'
  const line = node.summary ?? node.now
  return (
    // Chamados por outro subagente ficam recuados embaixo de quem os chamou.
    <li className="flex items-start gap-1" style={{ paddingLeft: Math.max(0, node.depth - 1) * 20 }}>
      {node.depth > 0 && <CornerDownRight className="mt-3 size-3.5 shrink-0 text-muted-foreground" />}
      <button
        type="button"
        onClick={() => onOpen(node.id)}
        className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-left hover:bg-muted/50"
      >
        <AgentStatusIcon status={node.status} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{node.name}</div>
          <div className="truncate text-xs text-muted-foreground">{agentMeta(node, now)}</div>
          {line && (
            <div
              className={cn(
                'mt-1 truncate text-xs text-muted-foreground',
                working && !node.summary && 'font-mono text-[11px]',
                node.status === 'waiting' && 'text-amber-700 dark:text-amber-300',
              )}
            >
              {line}
            </div>
          )}
        </div>
      </button>
    </li>
  )
}

/** Visão geral dos subagentes da conversa: o fluxograma de quem chamou quem, ou a lista com o andamento de cada um. */
export function AgentsSheet({
  tree,
  rootLabel,
  open,
  onOpenChange,
  onOpenAgent,
}: {
  tree: AgentTree
  rootLabel: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenAgent: (id: string) => void
}) {
  const [view, setViewState] = useState<View>(savedView)
  const now = useNow(open && view === 'list' && tree.count.running + tree.count.waiting > 0)
  const setView = (next: View) => {
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      // Modo privado: vale só nesta tela.
    }
    setViewState(next)
  }
  const tab = (value: View, label: string, Icon: typeof List) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === value}
      onClick={() => setView(value)}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors',
        view === value && 'bg-background text-foreground shadow-xs',
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto lg:mx-auto lg:max-w-3xl lg:rounded-t-xl lg:border-x">
        <SheetHeader>
          <SheetTitle>Agentes</SheetTitle>
          <SheetDescription>{tree.all.length ? countLine(tree.count) : 'Nenhum subagente nesta conversa ainda.'}</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 px-4 pb-6">
          {tree.all.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Quando o Claude delegar parte do trabalho a um subagente (a ferramenta Agent), ele aparece aqui, com o que está fazendo e
              ligado a quem o chamou.
            </p>
          ) : (
            <>
              <div role="tablist" className="flex gap-1 rounded-lg bg-muted p-1">
                {tab('graph', 'Grafo', Network)}
                {tab('list', 'Lista', List)}
              </div>
              {view === 'graph' ? (
                <Suspense>
                  <AgentGraph tree={tree} rootLabel={rootLabel} onOpen={onOpenAgent} />
                </Suspense>
              ) : (
                <ul className="space-y-1.5">
                  {tree.all.map((node) => (
                    <ListRow key={node.id} node={node} now={now} onOpen={onOpenAgent} />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
