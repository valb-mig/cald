import { ChevronDown } from 'lucide-react'
import { useContext } from 'react'
import { cn } from '@/lib/utils'
import { SCREEN_DRAG, ScreenCtx, useDraggingScreen } from './screen-ctx'

/**
 * A barra do alto de uma tela: ícone, nome, os controles dela e o recolher. É também a alça de arrastar
 * para trocá-la de lugar; os botões dentro dela não iniciam o arrasto. Recolhida, a janela é só ela, e
 * tocar nela abre.
 */
export function ScreenBar({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  const ctx = useContext(ScreenCtx)
  if (!ctx) return null
  const { screen, slot, collapsed, toggle } = ctx
  return (
    <div
      onPointerDown={(e) => {
        // Só o que não é botão arma o arrasto.
        e.currentTarget.draggable = !(e.target as HTMLElement).closest('button')
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData(SCREEN_DRAG, screen)
        e.dataTransfer.effectAllowed = 'move'
        useDraggingScreen.setState({ screen })
      }}
      onDragEnd={() => useDraggingScreen.setState({ screen: null })}
      onClick={collapsed ? toggle : undefined}
      className="flex h-9 shrink-0 cursor-grab items-center gap-2 px-2.5 text-sm font-medium select-none active:cursor-grabbing"
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
    </div>
  )
}
