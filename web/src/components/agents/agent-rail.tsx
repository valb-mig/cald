import { useEffect, useRef } from 'react'
import { Claudinho } from '@/components/claudinho'
import type { CatalogState, SessionState } from '@/lib/types'
import { cn } from '@/lib/utils'
import { AgentFace } from './agent-face'
import { typeLabel, useMember, type AgentNode, type AgentTree } from './model'
import { STATUS } from './status'

const working = (n: AgentNode) => n.status === 'running' || n.status === 'waiting'

/** Rola a fila só o necessário para o agente ficar à vista. */
const reveal = (list: HTMLElement | null, id: string) =>
  list?.querySelector(`[data-agent="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })

const item = 'relative flex size-11 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-foreground/5'
// O em foco ganha o destaque da barra lateral, que também fica na cor da casca: um tom mais claro que ela.
const selectedItem = 'bg-sidebar-accent shadow-xs hover:bg-sidebar-accent'

/** Um subagente no trilho: o claudinho dele e, no canto, o ponto do que pede você (âmbar) ou deu errado (vermelho). */
function RailAgent({ node, selected, onFocus }: { node: AgentNode; selected: boolean; onFocus: (id: string) => void }) {
  const member = useMember(node)
  const label = `${node.name} · ${typeLabel(node, member)} · ${STATUS[node.status].label}`
  const dot = node.status === 'waiting' ? 'bg-amber-500' : node.status === 'failed' ? 'bg-red-500' : null
  // Quem já terminou fica um tom abaixo: o olho vai para quem ainda trabalha.
  const finished = node.status === 'done' || node.status === 'stopped'
  return (
    <button
      type="button"
      data-agent={node.id}
      onClick={() => onFocus(node.id)}
      title={label}
      aria-label={label}
      aria-current={selected || undefined}
      className={cn(item, selected && selectedItem)}
    >
      {/* Chamado por outro subagente: um pouco menor que quem o chamou. */}
      <AgentFace
        node={node}
        member={member}
        size={node.depth > 0 ? 22 : 28}
        className={cn('transition-opacity', finished && !selected && 'opacity-60')}
      />
      {/* O contorno tem a cor do que está atrás, para o ponto se destacar do claudinho. */}
      {dot && (
        <span
          aria-hidden
          className={cn('absolute top-1.5 right-1.5 size-2.5 rounded-full ring-2', selected ? 'ring-sidebar-accent' : 'ring-shell', dot)}
        />
      )}
    </button>
  )
}

/**
 * A fila dos agentes da conversa, numa aba que sai da borda esquerda dela (ver .rail-tab em index.css),
 * na ordem em que foram chamados, com a altura do que tem dentro. No alto, o claudinho da conversa, que
 * volta ao chat principal; tocar num agente põe a conversa dele em foco. Sem nenhum agente, não
 * aparece. Muitos agentes rolam dentro da aba, e quando um novo começa a trabalhar, ela rola até ele.
 * Quem usa põe a altura (`className`, com o `top` e o `max-h`).
 */
export function AgentRail({
  sessionId,
  name,
  state,
  tree,
  focused,
  onFocus,
  glass = false,
  inert,
  className,
}: {
  sessionId: string
  /** O nome do claudinho da conversa. */
  name: string
  state?: CatalogState | SessionState
  tree: AgentTree
  /** O agente em foco; `null` é a conversa principal. */
  focused: string | null
  onFocus: (id: string | null) => void
  /** Vidro, com a cena passando por baixo (o celular com fundo animado). */
  glass?: boolean
  inert?: boolean
  className?: string
}) {
  const list = useRef<HTMLDivElement>(null)
  const seen = useRef(new Set<string>())

  // Só os que passam a trabalhar agora: os que já estavam não puxam a fila de novo.
  const live = tree.all.filter(working).map((n) => n.id).join(' ')
  useEffect(() => {
    const fresh = live ? live.split(' ').filter((id) => !seen.current.has(id)) : []
    for (const id of fresh) seen.current.add(id)
    const last = fresh.at(-1)
    if (last) reveal(list.current, last)
  }, [live])
  // Em foco por fora (a linha no chat, o mapa, "Chamado por"): fica à vista aqui também.
  useEffect(() => {
    if (focused) reveal(list.current, focused)
  }, [focused])

  if (!tree.all.length) return null
  return (
    <nav
      aria-label="Agentes da conversa"
      inert={inert}
      className={cn('rail-tab absolute left-0 z-20 flex flex-col rounded-r-2xl', glass && 'rail-glass backdrop-blur-md', className)}
    >
      <div
        ref={list}
        className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto overscroll-contain rounded-r-2xl p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <button
          type="button"
          onClick={() => onFocus(null)}
          title={`${name} · conversa principal`}
          aria-label={`${name}: voltar à conversa principal`}
          aria-current={!focused || undefined}
          className={cn(item, !focused && selectedItem)}
        >
          <Claudinho seed={sessionId} state={state} size={30} />
        </button>
        <div aria-hidden className="h-1 shrink-0" />
        {tree.all.map((node) => (
          <RailAgent key={node.id} node={node} selected={node.id === focused} onFocus={onFocus} />
        ))}
      </div>
    </nav>
  )
}
