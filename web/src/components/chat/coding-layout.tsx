import { CodeXml, Footprints } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { Claudinho } from '@/components/claudinho'
import { ResizeHandle } from '@/components/ui/resize-handle'
import {
  saveTrailSplit,
  saveTrailWidth,
  setScreenCollapsed,
  setTrailSplit,
  setTrailWidth,
  TRAIL_SPLIT,
  TRAIL_WIDTH,
  useCodingSlots,
  useTrailSplit,
  useTrailWidth,
  type Screen,
  type Slot,
} from '@/lib/chat-view'
import { cn } from '@/lib/utils'
import { collectEdits, filesOf } from './code-files'
import { AGENT_TOOLS, type ActivityEntry, type Item } from './items'
import { ScreenCtx, useDraggingScreen } from './screen-ctx'

/** Menor espaço de cada lado: a coluna da direita não passa de MIN_PANE para baixo, e a principal fica com MIN_MAIN. */
const MIN_PANE = 300
const MIN_MAIN = 480
const MIN_TOP = 120
const MIN_BOTTOM = 160
const KEY_STEP = 40
/** A largura do trilho em que a coluna da direita vira quando as duas telas dela estão recolhidas. */
const RAIL = '2.75rem'

const SLOT_NAMES: Record<Slot, string> = { main: 'Principal', top: 'Em cima', bottom: 'Embaixo' }

/**
 * A camada que acende sobre uma janela enquanto uma tela é arrastada: soltar nela troca as duas de lugar.
 * Quem arrasta (ScreenBar) acha a tela embaixo do ponteiro pelo `data-drop-screen` dela.
 */
function DropZone({ screen, slot }: { screen: Screen; slot: Slot }) {
  const dragging = useDraggingScreen((s) => s.screen)
  const over = useDraggingScreen((s) => s.over === screen)
  if (!dragging) return null
  const own = dragging === screen
  return (
    <div
      data-drop-screen={screen}
      className={cn(
        'absolute inset-0 z-30 grid place-items-center rounded-pane text-xs font-medium transition-colors',
        own ? 'bg-background/70' : over ? 'bg-primary/10 text-foreground ring-2 ring-primary' : 'bg-background/40 text-muted-foreground',
      )}
    >
      {/* O lugar de onde a tela saiu fica apagado; nos outros, o nome do lugar. */}
      {!own && <span className="pointer-events-none">{SLOT_NAMES[slot]}</span>}
    </div>
  )
}

/** Alguma ferramenta ainda sem resultado, nas entradas e nas dos subagentes. */
function hasPending(entries: ActivityEntry[]): boolean {
  return entries.some((e) => e.kind === 'tool' && (!e.result || (AGENT_TOOLS.has(e.use.name) && !!e.inner && hasPending(e.inner))))
}

const RAIL_META = {
  code: { Icon: CodeXml, label: 'Abrir o código' },
  steps: { Icon: Footprints, label: 'Abrir os passos' },
} as const

/** O trilho: as telas recolhidas da direita, como botões de ícone; o claudinho no canto diz que há trabalho nelas. */
function Rail({ order, busy, sessionId }: { order: ('code' | 'steps')[]; busy: Record<'code' | 'steps', boolean>; sessionId: string }) {
  return (
    <div style={{ gridArea: 'rail' }} className="flex min-h-0 flex-col items-center gap-1 overflow-hidden rounded-pane bg-background py-2">
      {order.map((screen) => {
        const { Icon, label } = RAIL_META[screen]
        return (
          <button
            key={screen}
            type="button"
            title={label}
            aria-label={label}
            onClick={() => setScreenCollapsed(screen, false)}
            className="relative grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <Icon className="size-4" />
            {busy[screen] && (
              <span className="absolute -top-0.5 -right-0.5 animate-pulse">
                <Claudinho seed={sessionId} size={12} />
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * O chão do modo coding: uma grade de áreas fixas (principal à esquerda; em cima e embaixo, à direita) e as
 * três telas como filhos sempre na mesma ordem, que só trocam a área. Por isso trocar de lugar não remonta
 * nada: o chat mantém rolagem, rascunho e mapa, e o código, o arquivo e a animação. Sem `windows`, a grade é
 * de uma coluna só com o chat, no mesmo lugar da árvore.
 */
export function CodingLayout({
  rowRef,
  windows,
  glass,
  chat,
  code,
  steps,
  sessionId,
  items,
  live,
}: {
  rowRef: React.RefObject<HTMLDivElement | null>
  windows: boolean
  glass: boolean
  chat: React.ReactNode
  code: React.ReactNode
  steps: React.ReactNode
  sessionId: string
  items: Item[]
  /** A conversa está trabalhando ou esperando. */
  live: boolean
}) {
  const { slots, collapsed } = useCodingSlots()
  const width = useTrailWidth((s) => s.width)
  const split = useTrailSplit((s) => s.code)
  const els = useRef<Record<Screen, HTMLDivElement | null>>({ chat: null, code: null, steps: null })

  const slotOf = (screen: Screen): Slot => (['main', 'top', 'bottom'] as const).find((k) => slots[k] === screen)!
  const shut = (screen: Screen) => screen !== 'chat' && collapsed[screen]
  const topShut = shut(slots.top)
  const bottomShut = shut(slots.bottom)

  // As duas da direita recolhidas (nenhuma é o chat, que não recolhe): a coluna vira um trilho.
  const railed = windows && topShut && bottomShut
  const busy = useMemo(() => {
    if (!railed || !live) return { code: false, steps: false }
    const entries = items.flatMap((i) => (i.type === 'activity' ? i.entries : []))
    return { code: filesOf(collectEdits(items), live).some((f) => f.state === 'running'), steps: hasPending(entries) }
  }, [railed, live, items])

  let rows = `minmax(0,${split}fr) var(--gap) minmax(0,${1 - split}fr) 0px`
  if (topShut && bottomShut) rows = 'auto var(--gap) auto minmax(0,1fr)'
  else if (topShut) rows = 'auto var(--gap) minmax(0,1fr) 0px'
  else if (bottomShut) rows = 'minmax(0,1fr) var(--gap) auto 0px'

  const gridStyle: React.CSSProperties = railed
    ? { gridTemplateColumns: `minmax(0,1fr) var(--gap) ${RAIL}`, gridTemplateRows: 'minmax(0,1fr)', gridTemplateAreas: '"main vdiv rail"' }
    : windows
    ? {
        gridTemplateColumns: `minmax(0,1fr) var(--gap) clamp(${MIN_PANE}px, ${width}px, calc(100% - ${MIN_MAIN}px - var(--gap)))`,
        gridTemplateRows: rows,
        gridTemplateAreas: '"main vdiv top" "main vdiv hdiv" "main vdiv bottom" "main vdiv ."',
      }
    : { gridTemplateColumns: 'minmax(0,1fr)', gridTemplateRows: 'minmax(0,1fr)', gridTemplateAreas: '"main"' }

  const clampWidth = (total: number, w: number) => Math.min(Math.max(MIN_PANE, w), Math.max(MIN_PANE, total - MIN_MAIN - 8))
  const clampSplit = (sum: number, top: number) => Math.min(Math.max(MIN_TOP, top), Math.max(MIN_TOP, sum - MIN_BOTTOM)) / sum

  const cell = (screen: Screen, node: React.ReactNode) => {
    const slot = windows ? slotOf(screen) : 'main'
    const isShut = windows && shut(screen)
    // No trilho, as janelas ficam escondidas mas montadas: o arquivo, o ao vivo e o "já visto" continuam.
    return (
      <div
        ref={(el) => {
          els.current[screen] = el
        }}
        style={{ gridArea: windows ? slot : 'main' }}
        className={cn(
          'relative flex min-h-0 min-w-0 flex-col',
          railed && screen !== 'chat' && 'hidden',
          windows && 'overflow-hidden rounded-pane',
          windows && slot === 'main' && 'in-data-[hole=flush]:rounded-tl-none',
          // O vidro do chat é o do fundo animado; sem ele, a janela tem a cor da aba.
          windows && (screen !== 'chat' || !glass) && 'bg-background',
        )}
      >
        <ScreenCtx value={{ screen, slot, collapsed: isShut, toggle: () => screen !== 'chat' && setScreenCollapsed(screen, !collapsed[screen]) }}>{node}</ScreenCtx>
        {windows && <DropZone screen={screen} slot={slot} />}
      </div>
    )
  }

  return (
    <div ref={rowRef} data-windows={windows || undefined} className="grid min-h-0 flex-1" style={gridStyle}>
      {cell('chat', chat)}
      {windows && cell('code', code)}
      {windows && cell('steps', steps)}
      {railed && <Rail order={[slots.top, slots.bottom].filter((x): x is 'code' | 'steps' => x !== 'chat')} busy={busy} sessionId={sessionId} />}
      {windows && (
        <div className="flex" style={{ gridArea: 'vdiv' }}>
          {railed ? <div className="w-gap" /> : <ResizeHandle
            between="windows"
            label="Tamanho da coluna da direita"
            value={50}
            onStart={() => {
              const grid = rowRef.current
              const right = els.current[slots.top]
              if (!grid || !right) return null
              const start = right.getBoundingClientRect().width
              const total = grid.clientWidth
              // A coluna fica à direita: levar a divisória para a esquerda a alarga.
              return (delta) => setTrailWidth(clampWidth(total, start - delta))
            }}
            onStep={(dir) => {
              const total = rowRef.current?.clientWidth
              const right = els.current[slots.top]?.getBoundingClientRect().width
              if (total && right) setTrailWidth(clampWidth(total, right - dir * KEY_STEP))
            }}
            onReset={() => setTrailWidth(TRAIL_WIDTH)}
            onEnd={saveTrailWidth}
          />}
        </div>
      )}
      {windows && !railed && (
        <div style={{ gridArea: 'hdiv' }}>
          {topShut || bottomShut ? (
            <div className="h-gap" />
          ) : (
            <ResizeHandle
              stacked
              between="windows"
              label="Altura das duas telas da direita"
              value={Math.round(split * 100)}
              onStart={() => {
                const top = els.current[slots.top]?.getBoundingClientRect().height
                const bottom = els.current[slots.bottom]?.getBoundingClientRect().height
                if (!top || !bottom) return null
                return (delta) => setTrailSplit(clampSplit(top + bottom, top + delta))
              }}
              onStep={(dir) => {
                const top = els.current[slots.top]?.getBoundingClientRect().height
                const bottom = els.current[slots.bottom]?.getBoundingClientRect().height
                if (top && bottom) setTrailSplit(clampSplit(top + bottom, top + dir * KEY_STEP))
              }}
              onReset={() => setTrailSplit(TRAIL_SPLIT)}
              onEnd={saveTrailSplit}
            />
          )}
        </div>
      )}
    </div>
  )
}
