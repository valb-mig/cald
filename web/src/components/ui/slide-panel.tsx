import { useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Painel que abre e fecha deslizando: a largura (ou a altura, embaixo) vai de 0 até `size` e volta,
 * com o conteúdo por dentro já no tamanho cheio, recortado, para não refazer o layout dele a cada
 * quadro. A animação só liga ao abrir ou fechar; arrastando a divisória, o tamanho acompanha o mouse
 * direto. Fechando, o conteúdo fica montado até terminar de deslizar (e depois, com `keepMounted`).
 */
export function SlidePanel({
  open,
  size,
  side,
  keepMounted,
  label,
  className,
  children,
}: {
  open: boolean
  size: number
  /** De que lado da tela fica: o conteúdo se prende ao lado de dentro e desliza junto da borda. */
  side: 'left' | 'right' | 'bottom'
  /** Fechado, só esconde: o que roda dentro (um terminal) continua vivo. */
  keepMounted?: boolean
  label?: string
  className?: string
  children: React.ReactNode
}) {
  const [mounted, setMounted] = useState(open)
  const [moving, setMoving] = useState(false)
  const [was, setWas] = useState(open)
  if (open !== was) {
    setWas(open)
    setMoving(true)
    if (open) setMounted(true)
  }
  if (!mounted && !keepMounted) return null
  const across = side === 'bottom'
  return (
    <div
      style={{ '--slide-size': `${open ? size : 0}px` } as React.CSSProperties}
      className={cn(
        'flex shrink-0 overflow-hidden',
        across ? 'h-(--slide-size) flex-col' : 'w-(--slide-size)',
        side === 'right' && 'justify-end',
        !mounted && 'hidden',
        // Com menos movimento, 1 ms: a transição ainda termina e avisa, para o painel fechado sair.
        moving &&
          (across
            ? 'transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] starting:h-0 motion-reduce:duration-1'
            : 'transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] starting:w-0 motion-reduce:duration-1'),
      )}
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget) return
        setMoving(false)
        if (!open) setMounted(false)
      }}
    >
      <aside
        style={across ? { height: size } : { width: size }}
        aria-label={label}
        className={cn(
          'flex shrink-0 flex-col transition-opacity duration-300 motion-reduce:transition-none',
          moving && 'starting:opacity-0',
          !open && 'opacity-0',
          className,
        )}
      >
        {children}
      </aside>
    </div>
  )
}
