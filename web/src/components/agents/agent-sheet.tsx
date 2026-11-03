import { ArrowUp, ChevronDown, MessagesSquare } from 'lucide-react'
import { createElement, useEffect, useState } from 'react'
import { Activity, toolIcon } from '@/components/chat/activity'
import { buildItems, type ActivityEntry, type Item } from '@/components/chat/items'
import { Markdown } from '@/components/markdown'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { api, errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AgentRow } from './agent-row'
import { AgentFace, typeLabel } from './agent-face'
import { toolLine, useAgents, type AgentNode } from './model'
import { agentMeta, useNow } from './status'
import { AgentStatusBadge } from './status-icon'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  )
}

/** A fala que é o relatório final já aparece na seção dele. */
const isReport = (text: string, result?: string) => Boolean(result) && text.trim() === result!.trim()

/** O que o subagente fez: as falas dele em texto, as ações em blocos de atividade, como no chat. */
function Steps({ sessionId, entries, result }: { sessionId: string; entries: ActivityEntry[]; result?: string }) {
  const blocks: ({ text: string; key: string } | { entries: ActivityEntry[]; key: string })[] = []
  for (const entry of entries) {
    const last = blocks.at(-1)
    if (entry.kind === 'subtext') blocks.push({ text: entry.text, key: entry.key })
    else if (last && 'entries' in last) last.entries.push(entry)
    else blocks.push({ entries: [entry], key: entry.key })
  }
  if (result && blocks.length > 1) {
    const last = blocks.at(-1)!
    if ('text' in last && isReport(last.text, result)) blocks.pop()
  }
  return (
    <div className="space-y-3">
      {blocks.map((b) => ('text' in b ? <Markdown key={b.key} text={b.text} /> : <Activity key={b.key} sessionId={sessionId} entries={b.entries} />))}
    </div>
  )
}

/** Transcript salvo no PC: dos agentes do histórico e dos de sessões abertas no PC (relido enquanto trabalham). */
function useTranscript(sessionId: string, node: AgentNode): { items: Item[] | null; error: string | null } {
  const [state, setState] = useState<{ items: Item[] | null; error: string | null }>({ items: null, error: null })
  const working = node.status === 'running' || node.status === 'waiting'
  useEffect(() => {
    let alive = true
    const load = () =>
      api.agent(sessionId, node.id, node.agentId).then(
        (events) => alive && setState({ items: buildItems(events.map((e, i) => ({ ...e, key: `a${i}` }))), error: null }),
        (err) => alive && setState((s) => ({ items: s.items, error: s.items ? null : errorMessage(err) })),
      )
    void load()
    const timer = working ? setInterval(load, 5_000) : undefined
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [sessionId, node.id, node.agentId, working])
  return state
}

function Transcript({ sessionId, node }: { sessionId: string; node: AgentNode }) {
  const { items, error } = useTranscript(sessionId, node)
  if (error) return <p className="text-xs text-muted-foreground">{error}</p>
  if (!items) return <Skeleton className="h-24 w-full" />
  // O pedido (a primeira mensagem) já está na seção dele; o relatório final, na dele.
  const steps = items.filter((i) => i.type === 'activity' || (i.type === 'assistant' && !isReport(i.text, node.result)))
  if (steps.length === 0) return <p className="text-xs text-muted-foreground">Nada registrado ainda.</p>
  return (
    <div className="space-y-3">
      {steps.map((i) =>
        i.type === 'activity' ? <Activity key={i.key} sessionId={sessionId} entries={i.entries} /> : i.type === 'assistant' && <Markdown key={i.key} text={i.text} />,
      )}
    </div>
  )
}

/** O pedido que o Claude fez ao subagente; longo, abre em três linhas. */
function Prompt({ text }: { text: string }) {
  const [full, setFull] = useState(false)
  const long = text.length > 280 || text.split('\n').length > 4
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      {full || !long ? <Markdown text={text} /> : <p className="line-clamp-4 text-sm whitespace-pre-wrap">{text}</p>}
      {long && (
        <button type="button" onClick={() => setFull(!full)} className="mt-1 flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
          <ChevronDown className={cn('size-3.5 transition-transform', full && 'rotate-180')} />
          {full ? 'Mostrar menos' : 'Ver pedido inteiro'}
        </button>
      )}
    </div>
  )
}

/**
 * Um subagente por inteiro: o que está fazendo agora, quem o chamou e quem ele chamou, o pedido, o
 * passo a passo e o relatório final. Acompanha ao vivo enquanto ele trabalha.
 */
export function AgentSheet({
  sessionId,
  node,
  onOpenChange,
  onOpen,
}: {
  sessionId: string
  /** O agente aberto; `undefined` fecha o painel. */
  node: AgentNode | undefined
  onOpenChange: (open: boolean) => void
  onOpen: (id: string) => void
}) {
  // Guarda o último aberto para o painel não ficar vazio enquanto fecha.
  const [shown, setShown] = useState(node)
  if (node && node !== shown) setShown(node)
  const n = node ?? shown
  const working = n?.status === 'running' || n?.status === 'waiting'
  const now = useNow(Boolean(node) && working)
  const member = useAgents()?.team?.members.find((m) => m.key === n?.type)

  return (
    <Sheet open={Boolean(node)} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto lg:mx-auto lg:max-w-2xl lg:rounded-t-xl lg:border-x">
        {n && (
          <>
            <SheetHeader>
              <div className="flex items-start gap-2 pr-8">
                {member && <AgentFace node={n} member={member} size={28} className="-mt-0.5" />}
                <SheetTitle className="min-w-0 flex-1 leading-snug">{n.name}</SheetTitle>
                <AgentStatusBadge status={n.status} className="mt-0.5" />
              </div>
              <SheetDescription>{[agentMeta(n, now, { label: typeLabel(n, member) }), n.model].filter(Boolean).join(' · ')}</SheetDescription>
            </SheetHeader>

            <div className="space-y-5 px-4 pb-6">
              {n.parent ? (
                <button
                  type="button"
                  onClick={() => onOpen(n.parent!.id)}
                  className="flex max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ArrowUp className="size-3.5 shrink-0" />
                  <span className="truncate">
                    Chamado por <span className="font-medium">{n.parent.name}</span>
                  </span>
                </button>
              ) : (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <MessagesSquare className="size-3.5" /> Chamado pela conversa principal
                </p>
              )}

              {working && (
                <div
                  className={cn(
                    'space-y-1 rounded-lg border px-3 py-2.5',
                    n.status === 'waiting' ? 'border-amber-500/40 bg-amber-500/5' : 'border-sky-500/30 bg-sky-500/5',
                  )}
                >
                  <div
                    className={cn(
                      'text-xs font-medium',
                      n.status === 'waiting' ? 'text-amber-700 dark:text-amber-300' : 'text-sky-700 dark:text-sky-300',
                    )}
                  >
                    {n.status === 'waiting' ? 'Esperando você: responda no chat' : 'Agora'}
                  </div>
                  {n.summary && <p className="text-sm">{n.summary}</p>}
                  {n.current && !n.current.result ? (
                    <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
                      {createElement(toolIcon(n.current.use.name), { className: 'size-3.5 shrink-0' })}
                      <span className="truncate">{toolLine(n.current)}</span>
                    </div>
                  ) : (
                    !n.summary && <p className="font-mono text-xs text-muted-foreground">{n.now ?? 'Começando…'}</p>
                  )}
                </div>
              )}

              {n.children.length > 0 && (
                <Section title={`Subagentes que ele chamou (${n.children.length})`}>
                  <div className="rounded-lg border bg-muted/30 p-1">
                    {n.children.map((child) => (
                      <AgentRow key={child.id} node={child} onOpen={() => onOpen(child.id)} />
                    ))}
                  </div>
                </Section>
              )}

              {n.prompt && (
                <Section title="Pedido">
                  <Prompt text={n.prompt} />
                </Section>
              )}

              <Section title="O que fez">
                {/* Ao vivo, o que ele faz chega pelo painel; do histórico ou do PC, vem do transcript salvo. */}
                {n.entries.length > 0 ? (
                  <Steps sessionId={sessionId} entries={n.entries} result={n.result} />
                ) : n.startedAt ? (
                  <p className="text-xs text-muted-foreground">Nada ainda.</p>
                ) : (
                  <Transcript key={n.id} sessionId={sessionId} node={n} />
                )}
              </Section>

              {n.error ? (
                <Section title="Erro">
                  <pre className="max-h-72 overflow-auto rounded border border-red-500/30 bg-background/60 p-2 font-mono text-[11px] whitespace-pre-wrap break-all text-red-700 dark:text-red-300">
                    {n.error}
                  </pre>
                </Section>
              ) : (
                n.result && (
                  <Section title="Relatório final">
                    <div className="rounded-lg border px-3 py-2">
                      <Markdown text={n.result} />
                    </div>
                  </Section>
                )
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
