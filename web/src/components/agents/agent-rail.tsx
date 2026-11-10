import { ChevronLeft } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Claudinho } from '@/components/claudinho'
import { setAgentRailCollapsed, useAgentRail } from '@/lib/agent-rail'
import type { CatalogState, SessionState } from '@/lib/types'
import { cn } from '@/lib/utils'
import { AgentFace } from './agent-face'
import { typeLabel, useMember, type AgentNode, type AgentStatus, type AgentTree } from './model'
import { STATUS } from './status'

const working = (n: AgentNode) => n.status === 'running' || n.status === 'waiting'

/** Rola a fila só o necessário para o agente ficar à vista. */
const reveal = (list: HTMLElement | null, id: string) =>
  list?.querySelector(`[data-agent="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })

const item = 'relative flex size-11 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-foreground/5'
// Os subagentes, abaixo da conversa, num degrau menor: o olho vai primeiro para ela. No toque, o alvo segue com 44px.
const agentItem = 'relative flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-foreground/5 pointer-coarse:size-11'
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
      className={cn(agentItem, selected && selectedItem)}
    >
      {/* Chamado por outro subagente: um pouco menor que quem o chamou. */}
      <AgentFace
        node={node}
        member={member}
        size={node.depth > 0 ? 16 : 22}
        className={cn('transition-opacity', finished && !selected && 'opacity-60')}
      />
      {/* O contorno tem a cor do que está atrás, para o ponto se destacar do claudinho. */}
      {dot && (
        <span
          aria-hidden
          className={cn('absolute top-1 right-1 size-2 rounded-full ring-2', selected ? 'ring-sidebar-accent' : 'ring-shell', dot)}
        />
      )}
    </button>
  )
}

// Na alça recolhida cabem estes rostos; os outros viram o "+N" embaixo deles.
const STACK = 3
// A ordem da alça: quem pede você, quem deu errado e quem trabalha vêm antes dos que já pararam.
const RANK: Record<AgentStatus, number> = { waiting: 0, failed: 1, running: 2, done: 3, stopped: 3 }

/** Um rosto da pilha da alça, com o ponto do que pede você (âmbar) ou deu errado (vermelho), como no trilho aberto. */
function HandleFace({ node, selected, glass }: { node: AgentNode; selected: boolean; glass: boolean }) {
  const member = useMember(node)
  const dot = node.status === 'waiting' ? 'bg-amber-500' : node.status === 'failed' ? 'bg-red-500' : null
  const finished = node.status === 'done' || node.status === 'stopped'
  return (
    <span className={cn('relative flex size-7 shrink-0 items-center justify-center rounded-lg', selected && 'bg-sidebar-accent')}>
      <AgentFace node={node} member={member} size={20} className={cn(finished && !selected && 'opacity-60')} />
      {dot && (
        <span
          aria-hidden
          className={cn('absolute top-0 right-0 size-2 rounded-full ring-2', selected ? 'ring-sidebar-accent' : glass ? 'ring-transparent' : 'ring-shell', dot)}
        />
      )}
    </span>
  )
}

/**
 * A alça da aba recolhida: a pilha dos rostos dos agentes (o em foco na frente, depois quem pede você,
 * quem deu errado e quem trabalha, os mais novos antes) e, passando de STACK, quantos mais. Cada rosto
 * tem o seu ponto, como no trilho aberto. Tocar abre a aba de novo.
 */
function RailHandle({ tree, focused, glass }: { tree: AgentTree; focused: string | null; glass: boolean }) {
  // O sort é estável: de trás para a frente, dentro de cada grupo os mais novos ficam antes.
  const shown = [...tree.all]
    .reverse()
    .sort((a, b) => (a.id === focused ? -1 : b.id === focused ? 1 : 0) || RANK[a.status] - RANK[b.status])
    .slice(0, STACK)
  const n = tree.all.length
  const more = n - shown.length
  const some = (s: AgentStatus) => tree.all.some((node) => node.status === s)
  const hint = [some('waiting') && 'pede aprovação', some('failed') && 'falhou', some('running') && 'trabalhando'].filter(Boolean).join(', ')
  const label = `Mostrar os agentes (${n})${hint ? ` · ${hint}` : ''}`
  return (
    <button
      type="button"
      onClick={() => setAgentRailCollapsed(false)}
      title={label}
      aria-label={label}
      className="flex w-9 flex-col items-center gap-0.5 rounded-r-2xl py-1.5 transition-colors hover:bg-foreground/5 pointer-coarse:w-11"
    >
      {shown.map((node) => (
        <HandleFace key={node.id} node={node} selected={node.id === focused} glass={glass} />
      ))}
      {more > 0 && <span className="pt-0.5 text-[10px] leading-none font-medium text-muted-foreground tabular-nums">+{more}</span>}
    </button>
  )
}

/**
 * A fila dos agentes da conversa, numa aba que sai da borda esquerda dela (ver .rail-tab em index.css),
 * na ordem em que foram chamados, com a altura do que tem dentro. No alto, o claudinho da conversa, que
 * volta ao chat principal; tocar num agente põe a conversa dele em foco. Sem nenhum agente, não
 * aparece. Muitos agentes rolam dentro da aba, e quando um novo começa a trabalhar, ela rola até ele.
 * Recolhida, vira só a alça (RailHandle), com os rostos dos agentes e um toque para abrir. Quem usa
 * põe a altura (`className`, com o `top` e o `max-h`).
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
  const collapsed = useAgentRail((s) => s.collapsed)
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
      {/* Troca curta: o conteúdo entra deslizando da borda, sem nada com movimento reduzido. */}
      <div
        key={collapsed ? 'handle' : 'list'}
        className="flex min-h-0 flex-col rounded-r-2xl duration-200 animate-in fade-in-0 slide-in-from-left-3 motion-reduce:animate-none"
      >
        {collapsed ? (
          <RailHandle tree={tree} focused={focused} glass={glass} />
        ) : (
          <>
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
                <Claudinho seed={sessionId} state={state} size={34} />
              </button>
              {/* Um traço separa a conversa dos agentes dela. */}
              <div aria-hidden className="my-1 h-px w-5 shrink-0 bg-foreground/10" />
              {tree.all.map((node) => (
                <RailAgent key={node.id} node={node} selected={node.id === focused} onFocus={onFocus} />
              ))}
            </div>
            <button
              type="button"
              onClick={() => setAgentRailCollapsed(true)}
              title="Recolher os agentes"
              aria-label="Recolher os agentes"
              className="mx-auto mb-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/5"
            >
              <ChevronLeft aria-hidden className="size-4" />
            </button>
          </>
        )}
      </div>
    </nav>
  )
}
