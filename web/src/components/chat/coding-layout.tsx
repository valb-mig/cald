import { useRef, useState } from 'react'
import { ResizeHandle } from '@/components/ui/resize-handle'
import {
  saveTrailSplit,
  saveTrailWidth,
  setScreenCollapsed,
  setTrailSplit,
  setTrailWidth,
  swapScreens,
  TRAIL_SPLIT,
  TRAIL_WIDTH,
  useCodingSlots,
  useTrailSplit,
  useTrailWidth,
  type Screen,
  type Slot,
} from '@/lib/chat-view'
import { cn } from '@/lib/utils'
import { ScreenCtx, useDraggingScreen } from './screen-ctx'

/** Menor espaço de cada lado: a coluna da direita não passa de MIN_PANE para baixo, e a principal fica com MIN_MAIN. */
const MIN_PANE = 300
const MIN_MAIN = 480
const MIN_TOP = 120
const MIN_BOTTOM = 160
const KEY_STEP = 40

const SLOT_NAMES: Record<Slot, string> = { main: 'Principal', top: 'Em cima', bottom: 'Embaixo' }

/** A camada que acende sobre uma janela enquanto uma tela é arrastada: soltar nela troca as duas de lugar. */
function DropZone({ screen, slot }: { screen: Screen; slot: Slot }) {
  const dragging = useDraggingScreen((s) => s.screen)
  const [over, setOver] = useState(false)
  if (!dragging) return null
  const own = dragging === screen
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = own ? 'none' : 'move'
      }}
      onDragEnter={() => setOver(true)}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        if (!own) swapScreens(dragging, screen)
        useDraggingScreen.setState({ screen: null })
      }}
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
}: {
  rowRef: React.RefObject<HTMLDivElement | null>
  windows: boolean
  glass: boolean
  chat: React.ReactNode
  code: React.ReactNode
  steps: React.ReactNode
}) {
  const { slots, collapsed } = useCodingSlots()
  const width = useTrailWidth((s) => s.width)
  const split = useTrailSplit((s) => s.code)
  const els = useRef<Record<Screen, HTMLDivElement | null>>({ chat: null, code: null, steps: null })

  const slotOf = (screen: Screen): Slot => (['main', 'top', 'bottom'] as const).find((k) => slots[k] === screen)!
  const shut = (screen: Screen) => screen !== 'chat' && collapsed[screen]
  const topShut = shut(slots.top)
  const bottomShut = shut(slots.bottom)

  let rows = `minmax(0,${split}fr) var(--gap) minmax(0,${1 - split}fr) 0px`
  if (topShut && bottomShut) rows = 'auto var(--gap) auto minmax(0,1fr)'
  else if (topShut) rows = 'auto var(--gap) minmax(0,1fr) 0px'
  else if (bottomShut) rows = 'minmax(0,1fr) var(--gap) auto 0px'

  const gridStyle: React.CSSProperties = windows
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
    return (
      <div
        ref={(el) => {
          els.current[screen] = el
        }}
        style={{ gridArea: windows ? slot : 'main' }}
        className={cn(
          'relative flex min-h-0 min-w-0 flex-col',
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
      {windows && (
        <div className="flex" style={{ gridArea: 'vdiv' }}>
          <ResizeHandle
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
          />
        </div>
      )}
      {windows && (
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
