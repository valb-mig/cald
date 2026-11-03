import { ArrowDown, ArrowRight, MessagesSquare, Minus, Plus, Scan } from 'lucide-react'
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useWidth } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { AgentFace, typeLabel, useMember } from './agent-face'
import type { AgentNode, AgentStatus, AgentTree } from './model'
import { STATUS, elapsed, useNow } from './status'
import { AgentStatusIcon } from './status-icon'

/**
 * Fluxograma dos agentes, no jeito do mermaid: a conversa no topo (ou à esquerda), cada subagente
 * ligado a quem o chamou. A linha corre enquanto o agente trabalha; pontilhada, ele roda em segundo plano.
 */

type Dir = 'TD' | 'LR'
type Size = { w: number; h: number }
/** `node` vazio é a conversa principal. */
type Box = Size & { node?: AgentNode; x: number; y: number }
type Link = { from: Box; to: Box; node: AgentNode }

const ROOT: Size = { w: 172, h: 48 }
const NODE: Size = { w: 204, h: 78 }
// Menor que isso a letra some no celular: melhor rolar o desenho.
const MIN_AUTO_SCALE = 0.7
/** Pontilhado do segundo plano e tracejado de quem trabalha: os dois com período 5,5 (a animação anda 11). */
const DOTTED = '0.5 5'
const DASHED = '6 5'
const PAD = 16
const GAP: Record<Dir, { sibling: number; level: number }> = { TD: { sibling: 16, level: 48 }, LR: { sibling: 12, level: 48 } }

/** Árvore arrumada: cada pai fica no meio dos filhos, e cada nível numa faixa. */
function layout(roots: AgentNode[], dir: Dir) {
  const td = dir === 'TD'
  const across = (s: Size) => (td ? s.w : s.h)
  const along = (s: Size) => (td ? s.h : s.w)
  const { sibling, level } = GAP[dir]

  const spans = new Map<AgentNode, number>()
  const spanOf = (kids: AgentNode[]) => kids.reduce((sum, k) => sum + spans.get(k)!, 0) + sibling * Math.max(0, kids.length - 1)
  const measure = (n: AgentNode): void => {
    n.children.forEach(measure)
    spans.set(n, Math.max(across(NODE), spanOf(n.children)))
  }
  roots.forEach(measure)
  const total = Math.max(across(ROOT), spanOf(roots))

  const depthAt = (d: number) => (d === 0 ? 0 : along(ROOT) + level + (d - 1) * (along(NODE) + level))
  const boxes: Box[] = []
  const links: Link[] = []
  const place = (size: Size, start: number, span: number, depth: number, node?: AgentNode): Box => {
    const a = start + (span - across(size)) / 2
    const b = depthAt(depth)
    const box = { ...size, node, x: PAD + (td ? a : b), y: PAD + (td ? b : a) }
    boxes.push(box)
    return box
  }
  const placeChildren = (kids: AgentNode[], parent: Box, start: number, span: number, depth: number) => {
    let cursor = start + (span - spanOf(kids)) / 2
    for (const kid of kids) {
      const s = spans.get(kid)!
      const box = place(NODE, cursor, s, depth, kid)
      links.push({ from: parent, to: box, node: kid })
      placeChildren(kid.children, box, cursor, s, depth + 1)
      cursor += s + sibling
    }
  }
  placeChildren(roots, place(ROOT, 0, total, 0), 0, total, 1)

  return {
    boxes,
    links,
    width: Math.max(...boxes.map((b) => b.x + b.w)) + PAD,
    height: Math.max(...boxes.map((b) => b.y + b.h)) + PAD,
  }
}

/** Curva de quem chamou até o chamado, como as do mermaid; termina na borda, onde fica a seta. */
function curve({ from: a, to: b }: Link, dir: Dir): string {
  if (dir === 'TD') {
    const [x1, y1, x2, y2] = [a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y]
    const m = (y1 + y2) / 2
    return `M ${x1} ${y1} C ${x1} ${m}, ${x2} ${m}, ${x2} ${y2}`
  }
  const [x1, y1, x2, y2] = [a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2]
  const m = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${m} ${y1}, ${m} ${y2}, ${x2} ${y2}`
}

const working = (s: AgentStatus) => s === 'running' || s === 'waiting'

function GraphNode({ box, now, onOpen }: { box: Box; now: number; onOpen: (id: string) => void }) {
  const n = box.node!
  const line = n.summary ?? n.now ?? STATUS[n.status].label
  return (
    <button
      type="button"
      onClick={() => onOpen(n.id)}
      aria-label={`${n.name}: ${STATUS[n.status].label}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      className={cn(
        'absolute flex flex-col justify-between rounded-xl border bg-card px-2.5 py-2 text-left shadow-xs transition-[box-shadow,transform] hover:shadow-md active:scale-[0.98]',
        STATUS[n.status].node,
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <AgentStatusIcon status={n.status} className="size-3" />
        <NodeType node={n} />
        <span className="ml-auto shrink-0 tabular-nums">{elapsed(n, now)}</span>
      </div>
      <div className="truncate text-[13px] leading-tight font-medium">{n.name}</div>
      <div
        className={cn(
          'truncate text-[11px] text-muted-foreground',
          working(n.status) && !n.summary && 'font-mono text-[10.5px]',
          n.status === 'waiting' && 'text-amber-700 dark:text-amber-300',
        )}
      >
        {line}
      </div>
    </button>
  )
}

export function AgentGraph({
  tree,
  rootLabel,
  onOpen,
}: {
  tree: AgentTree
  /** Estado da conversa principal ("Executando", "Concluída"…). */
  rootLabel: string
  onOpen: (id: string) => void
}) {
  const uid = useId().replace(/[^\w-]/g, '')
  const scroller = useRef<HTMLDivElement>(null)
  const width = useWidth(scroller)
  const layouts = useMemo(() => ({ TD: layout(tree.roots, 'TD'), LR: layout(tree.roots, 'LR') }), [tree])
  const [dirPick, setDir] = useState<Dir | null>(null)
  const [zoomPick, setZoom] = useState<number | null>(null)
  const now = useNow(tree.count.running + tree.count.waiting > 0)

  // O sentido em que o desenho cabe maior: no celular em pé, muitos irmãos ficam melhor empilhados (esquerda → direita).
  const fitOf = (d: Dir) => (width ? Math.min(1, width / layouts[d].width) : 1)
  const dir = dirPick ?? (fitOf('TD') >= fitOf('LR') ? 'TD' : 'LR')
  const g = layouts[dir]
  const fit = fitOf(dir)
  const scale = zoomPick ?? Math.max(fit, MIN_AUTO_SCALE)

  // Mais largo que a tela, de cima para baixo: começa com a conversa (no meio) à vista.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = dir === 'TD' ? (el.scrollWidth - el.clientWidth) / 2 : 0
  }, [dir, scale])

  const zoom = (by: number) => setZoom(Math.min(1.5, Math.max(0.3, Math.round((scale + by) * 10) / 10)))
  const legend = (Object.keys(STATUS) as AgentStatus[]).filter((s) => tree.count[s] > 0)

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-xl border bg-muted/20">
        <div
          ref={scroller}
          className="max-h-[62dvh] overflow-auto overscroll-contain bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1px)] bg-size-[16px_16px]"
        >
          <div className="relative mx-auto" style={{ width: g.width * scale, height: g.height * scale }}>
            <div className="absolute top-0 left-0 origin-top-left" style={{ width: g.width, height: g.height, transform: `scale(${scale})` }}>
              <svg width={g.width} height={g.height} className="absolute inset-0" aria-hidden>
                <defs>
                  {(Object.keys(STATUS) as AgentStatus[]).map((s) => (
                    <marker key={s} id={`${uid}-${s}`} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" className={STATUS[s].fill} />
                    </marker>
                  ))}
                </defs>
                {g.links.map((l) => (
                  <path
                    key={l.node.id}
                    d={curve(l, dir)}
                    markerEnd={`url(#${uid}-${l.node.status})`}
                    strokeWidth={working(l.node.status) ? 2 : 1.5}
                    strokeLinecap="round"
                    // Segundo plano pontilhado, como o -.-> do mermaid.
                    strokeDasharray={l.node.background ? DOTTED : working(l.node.status) ? DASHED : undefined}
                    className={cn(
                      'fill-none',
                      STATUS[l.node.status].stroke,
                      working(l.node.status) && 'motion-safe:animate-[agent-flow_0.9s_linear_infinite]',
                    )}
                  />
                ))}
              </svg>
              {g.boxes.map((box) =>
                box.node ? (
                  <GraphNode key={box.node.id} box={box} now={now} onOpen={onOpen} />
                ) : (
                  <div
                    key="root"
                    style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                    className="absolute flex items-center gap-2 rounded-full bg-primary px-3.5 text-primary-foreground shadow-sm"
                  >
                    <MessagesSquare className="size-4 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[13px] leading-tight font-medium">Conversa</div>
                      <div className="truncate text-[11px] opacity-70">{rootLabel}</div>
                    </div>
                  </div>
                ),
              )}
            </div>
          </div>
        </div>

      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground">
          {legend.map((s) => (
            <span key={s} className="flex items-center gap-1">
              <AgentStatusIcon status={s} className="size-3" />
              {STATUS[s].label}
            </span>
          ))}
          {tree.all.some((n) => n.background) && (
            <span className="flex items-center gap-1">
              <svg width="18" height="6" aria-hidden>
                <line x1="2" y1="3" x2="17" y2="3" strokeWidth="2" strokeDasharray={DOTTED} strokeLinecap="round" className="stroke-current" />
              </svg>
              segundo plano
            </span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              setDir(dir === 'TD' ? 'LR' : 'TD')
              setZoom(null)
            }}
            aria-label={dir === 'TD' ? 'Desenhar da esquerda para a direita' : 'Desenhar de cima para baixo'}
            title={dir === 'TD' ? 'Da esquerda para a direita' : 'De cima para baixo'}
          >
            {dir === 'TD' ? <ArrowRight /> : <ArrowDown />}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => zoom(-0.1)} aria-label="Diminuir">
            <Minus />
          </Button>
          <button type="button" className="w-10 text-center text-xs tabular-nums text-muted-foreground" onClick={() => setZoom(1)} title="Tamanho real">
            {Math.round(scale * 100)}%
          </button>
          <Button variant="ghost" size="icon-sm" onClick={() => zoom(0.1)} aria-label="Aumentar">
            <Plus />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setZoom(fit)} aria-label="Caber na tela" title="Caber na tela">
            <Scan />
          </Button>
        </div>
      </div>
    </div>
  )
}

/** O tipo no alto do nó: com o claudinho e o nome, se o subagente é um membro do time. */
function NodeType({ node }: { node: AgentNode }) {
  const member = useMember(node)
  return (
    <>
      {member && <AgentFace node={node} member={member} size={14} />}
      <span className="truncate font-medium">{typeLabel(node, member)}</span>
    </>
  )
}
