import { ArrowUp, ChevronDown, CircleStop, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Activity } from '@/components/chat/activity'
import { StopTaskDialog } from '@/components/chat/background-tasks'
import { buildItems, type ActivityEntry, type Item } from '@/components/chat/items'
import { Claudinho } from '@/components/claudinho'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api, errorMessage } from '@/lib/api'
import type { BackgroundTask } from '@/lib/types'
import { cn } from '@/lib/utils'
import { AgentFace } from './agent-face'
import { agentSeed, agentState, toolLine, typeLabel, useMember, type AgentNode } from './model'
import { agentMeta, useNow } from './status'
import { AgentStatusBadge } from './status-icon'

/** A fala que é o relatório final já aparece no fim, como a resposta dele. */
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
    <>
      {blocks.map((b) => ('text' in b ? <Markdown key={b.key} text={b.text} /> : <Activity key={b.key} sessionId={sessionId} entries={b.entries} />))}
    </>
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
  // O pedido (a primeira mensagem) já está no balão do alto; o relatório final, no fim.
  const steps = items.filter((i) => i.type === 'activity' || (i.type === 'assistant' && !isReport(i.text, node.result)))
  if (steps.length === 0) return <p className="text-xs text-muted-foreground">Nada registrado ainda.</p>
  return (
    <>
      {steps.map((i) =>
        i.type === 'activity' ? <Activity key={i.key} sessionId={sessionId} entries={i.entries} /> : i.type === 'assistant' && <Markdown key={i.key} text={i.text} />,
      )}
    </>
  )
}

/** Quem fez o pedido, quando foi outro subagente: o claudinho dele. */
function ParentFace({ node }: { node: AgentNode }) {
  return <AgentFace node={node} member={useMember(node)} size={20} />
}

/** O pedido ao subagente, como a mensagem que abre a conversa dele; longo, abre em quatro linhas. */
function Prompt({ sessionId, node }: { sessionId: string; node: AgentNode }) {
  const [full, setFull] = useState(false)
  const text = node.prompt
  const long = text.length > 280 || text.split('\n').length > 4
  return (
    <div className="flex items-end justify-end gap-2">
      <div className="min-w-0 max-w-[85%] rounded-2xl rounded-br-md bg-foreground/[0.06] px-3.5 py-2 text-sm">
        {full || !long ? <Markdown text={text} /> : <p className="line-clamp-4 whitespace-pre-wrap break-words">{text}</p>}
        {long && (
          <button
            type="button"
            onClick={() => setFull(!full)}
            className="mt-1 flex min-h-8 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn('size-3.5 transition-transform', full && 'rotate-180')} />
            {full ? 'Menos' : 'Pedido inteiro'}
          </button>
        )}
      </div>
      {/* Quem pediu: o claudinho da conversa ou o do subagente que o chamou. */}
      {node.parent ? <ParentFace node={node.parent} /> : <Claudinho seed={sessionId} size={20} />}
    </div>
  )
}

/**
 * Enquanto ele trabalha, no fim da conversa dele: o claudinho e o que está fazendo, como a linha do
 * "Rodando…" do chat. Pedindo aprovação, leva de volta ao chat, onde fica o cartão de responder.
 */
function NowLine({ node, onAnswer }: { node: AgentNode; onAnswer: () => void }) {
  const member = useMember(node)
  const tool = node.current && !node.current.result ? node.current : undefined
  const face = <Claudinho seed={agentSeed(node, member)} size={18} state={agentState(node)} className={tool ? 'claudinho-hop' : undefined} />
  if (node.status === 'waiting') {
    return (
      <button type="button" onClick={onAnswer} className="flex min-h-8 max-w-full min-w-0 items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
        {face}
        <span className="min-w-0 truncate">{node.now ?? 'Pede aprovação'}</span>
        <span className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline">Responder no chat</span>
      </button>
    )
  }
  const line = node.summary ?? (tool ? toolLine(tool) : (node.now ?? 'Começando…'))
  return (
    <div className="chat-enter flex min-w-0 items-center gap-2 text-xs text-muted-foreground" role="status">
      {face}
      <span className={cn('min-w-0 truncate', !node.summary && tool && 'font-mono text-[11px]')}>{line}</span>
    </div>
  )
}

/** Abre no fim, como um chat, e acompanha o que chega enquanto você estiver lá embaixo. */
function useStickToBottom() {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  useLayoutEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    el.scrollTop = el.scrollHeight
    const observer = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])
  const onScroll = () => {
    const el = scroller.current
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  return { scroller, content, onScroll }
}

/**
 * Um subagente em foco, no lugar do chat: no alto, quem ele é e como está; embaixo, a conversa dele,
 * com o pedido que recebeu, o passo a passo e o relatório final como resposta. Acompanha ao vivo
 * enquanto ele trabalha. Os subagentes que ele chamou ficam no trilho, ao lado.
 */
export function AgentChat({
  sessionId,
  node,
  task,
  onOpen,
  onClose,
  onAnswer,
  headerClassName,
}: {
  sessionId: string
  node: AgentNode
  /** A tarefa dele em segundo plano, com a conversa aberta no painel: dá para parar. */
  task?: BackgroundTask
  /** Pôr outro agente em foco (quem o chamou). */
  onOpen: (id: string) => void
  /** Voltar à conversa principal. */
  onClose: () => void
  /** Pedindo aprovação: voltar ao chat, no cartão de responder. */
  onAnswer: () => void
  headerClassName?: string
}) {
  const working = node.status === 'running' || node.status === 'waiting'
  const now = useNow(working)
  const member = useMember(node)
  const [stopping, setStopping] = useState(false)
  const { scroller, content, onScroll } = useStickToBottom()
  const meta = [agentMeta(node, now, { label: typeLabel(node, member) }), node.model].filter(Boolean).join(' · ')

  return (
    <section className="@container absolute inset-0 flex flex-col" aria-label={`Subagente: ${node.name}`}>
      {/* Estreito, o alto fica debaixo da aba dos agentes, presa na borda esquerda: o cabeçalho começa
          depois dela. Largo, o centro já fica longe da borda. */}
      <div className={cn('shrink-0 px-2 pt-2 pb-1 @max-[56rem]:pl-15', headerClassName)}>
        <div className="mx-auto flex w-full max-w-3xl min-w-0 items-center gap-2.5 pl-2">
          <AgentFace node={node} member={member} size={30} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{node.name}</div>
            <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
              <span className="min-w-0 truncate">{meta}</span>
              <AgentStatusBadge status={node.status} className="h-5 shrink-0 px-1.5 text-[10px]" />
            </div>
            {node.parent && (
              <button
                type="button"
                onClick={() => onOpen(node.parent!.id)}
                className="flex max-w-full min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowUp className="size-3 shrink-0" />
                <span className="truncate">
                  Chamado por <span className="font-medium">{node.parent.name}</span>
                </span>
              </button>
            )}
          </div>
          {task && working && (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setStopping(true)}>
              <CircleStop /> Parar
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Voltar à conversa" title="Voltar à conversa (Esc)">
            <X />
          </Button>
        </div>
      </div>

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div ref={content} className="mx-auto w-full max-w-3xl space-y-4 px-4 pt-2 pb-4">
          {node.prompt && <Prompt sessionId={sessionId} node={node} />}
          {/* Ao vivo, o que ele faz chega pelo painel; do histórico ou do PC, vem do transcript salvo. */}
          {node.entries.length > 0 ? (
            <Steps sessionId={sessionId} entries={node.entries} result={node.result} />
          ) : (
            !node.startedAt && <Transcript key={node.id} sessionId={sessionId} node={node} />
          )}
          {node.error ? (
            <pre className="max-h-72 overflow-auto rounded-lg bg-red-500/5 p-2 font-mono text-[11px] whitespace-pre-wrap break-all text-red-700 dark:text-red-300">
              {node.error}
            </pre>
          ) : (
            node.result && (
              <div className="rounded-xl bg-foreground/[0.04] px-3.5 py-2.5">
                <Markdown text={node.result} />
              </div>
            )
          )}
          {working && <NowLine node={node} onAnswer={onAnswer} />}
        </div>
      </div>

      <StopTaskDialog sessionId={sessionId} task={task ?? null} open={stopping} onOpenChange={setStopping} />
    </section>
  )
}
