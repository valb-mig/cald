import { ChevronDown } from 'lucide-react'
import { useContext, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { swapScreens, type Screen } from '@/lib/chat-view'
import { cn } from '@/lib/utils'
import { ScreenCtx, useDraggingScreen } from './screen-ctx'

/** Quanto o ponteiro anda, com o botão apertado, antes de virar arrasto: menos que isso é um clique. */
const DRAG_FROM = 5

const stopDragging = () => useDraggingScreen.setState({ screen: null, over: null })

/** A tela embaixo do ponteiro: a camada de soltar dela (ver DropZone, em coding-layout.tsx). */
const screenAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-screen]')?.dataset.dropScreen as Screen | undefined) ?? null

/** O nome da tela que vai, preso ao ponteiro enquanto ela é arrastada. */
function DragChip({ icon, title }: { icon: React.ReactNode; title: string }) {
  const { x, y } = useDraggingScreen()
  return createPortal(
    <div
      style={{ transform: `translate(${x + 12}px, ${y + 12}px)` }}
      className="pointer-events-none fixed top-0 left-0 z-50 flex h-8 items-center gap-2 rounded-lg bg-popover px-2.5 text-sm font-medium text-popover-foreground shadow-lg ring-1 ring-foreground/10"
    >
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      {title}
    </div>,
    document.body,
  )
}

/**
 * A barra do alto de uma tela: ícone, nome, os controles dela e o recolher. É também a alça de arrastar
 * para trocá-la de lugar; os botões dentro dela não iniciam o arrasto. Recolhida, a janela é só ela, e
 * tocar nela abre.
 */
export function ScreenBar({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  const ctx = useContext(ScreenCtx)
  const from = useRef<{ x: number; y: number } | null>(null)
  // Fica ligado até o clique que vem depois do soltar, para ele não abrir a tela recolhida.
  const moved = useRef(false)
  const dragging = useDraggingScreen((s) => ctx !== null && s.screen === ctx.screen)

  // Esc desiste do arrasto, com a tela no lugar.
  useEffect(() => {
    if (!dragging) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      from.current = null
      stopDragging()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dragging])

  if (!ctx) return null
  const { screen, slot, collapsed, toggle } = ctx
  return (
    <div
      onPointerDown={(e) => {
        // Só o botão principal, fora dos botões da barra, arma o arrasto.
        if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
        from.current = { x: e.clientX, y: e.clientY }
        moved.current = false
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const start = from.current
        if (!start) return
        if (!moved.current && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_FROM) return
        moved.current = true
        useDraggingScreen.setState({ screen, x: e.clientX, y: e.clientY, over: screenAt(e.clientX, e.clientY) })
      }}
      onPointerUp={() => {
        const { screen: going, over } = useDraggingScreen.getState()
        if (from.current && going === screen && over && over !== screen) swapScreens(screen, over)
        from.current = null
        stopDragging()
      }}
      onPointerCancel={() => {
        from.current = null
        stopDragging()
      }}
      onClick={() => {
        if (moved.current) moved.current = false
        else if (collapsed) toggle()
      }}
      className="flex h-9 shrink-0 cursor-grab touch-none items-center gap-2 px-2.5 text-sm font-medium select-none active:cursor-grabbing"
    >
      <span className="flex shrink-0 items-center gap-2">
        <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
        {title}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2 font-normal">{children}</div>
      {slot !== 'main' && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Abrir ${title}` : `Recolher ${title}`}
          title={collapsed ? 'Abrir' : 'Recolher'}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronDown className={cn('size-4 transition-transform', collapsed && '-rotate-90')} />
        </button>
      )}
      {dragging && <DragChip icon={icon} title={title} />}
    </div>
  )
}
