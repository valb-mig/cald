import { cn } from '@/lib/utils'

/**
 * A borda que se arrasta para repartir o espaço entre dois lados: conversas lado a lado, as conversas e a barra do projeto. Arrastar muda o tamanho, as setas do teclado com
 * foco também, e dois cliques voltam ao padrão. Quem usa decide o que o deslocamento significa.
 */
export function ResizeHandle({
  label,
  value,
  stacked = false,
  between,
  reset = 'tamanho padrão',
  onStart,
  onStep,
  onReset,
  onEnd,
}: {
  label: string
  /** Quanto o primeiro lado ocupa, em porcentagem, para leitores de tela. */
  value: number
  /** Um lado em cima do outro: a borda é horizontal e arrasta para cima e para baixo. */
  stacked?: boolean
  /**
   * No PC, em vez de linha, a própria folga entre dois lados, com uma pílula que acende ao passar o
   * mouse. `windows`: entre as janelas da casca e a barra do projeto (`--gap`); com `stacked`, entre as
   * conversas e o painel de baixo; `islands`: entre a barra lateral e a casca (`--frame`).
   */
  between?: 'windows' | 'islands'
  /** O que os dois cliques fazem, para a dica. */
  reset?: string
  /** Começo do arrasto: mede o que precisa e devolve o que fazer com o deslocamento (px desde o começo). */
  onStart: (bar: HTMLElement) => ((delta: number) => void) | null
  /** Seta do teclado: -1 para a esquerda (ou para cima), 1 para a direita (ou para baixo). */
  onStep: (dir: -1 | 1, bar: HTMLElement) => void
  onReset: () => void
  /** Fim do arrasto, de um passo pelo teclado ou da volta ao padrão: hora de salvar. */
  onEnd: () => void
}) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const bar = e.currentTarget
    const move = onStart(bar)
    if (!move) return
    const pos = (ev: { clientX: number; clientY: number }) => (stacked ? ev.clientY : ev.clientX)
    const start = pos(e)
    bar.setPointerCapture(e.pointerId)
    // Sem isso o arrasto vai selecionando o texto das conversas pelo caminho.
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent) => move(pos(ev) - start)
    const up = () => {
      bar.removeEventListener('pointermove', onMove)
      bar.removeEventListener('pointerup', up)
      bar.removeEventListener('pointercancel', up)
      document.body.style.userSelect = ''
      onEnd()
    }
    bar.addEventListener('pointermove', onMove)
    bar.addEventListener('pointerup', up)
    bar.addEventListener('pointercancel', up)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dir = ({ [stacked ? 'ArrowUp' : 'ArrowLeft']: -1, [stacked ? 'ArrowDown' : 'ArrowRight']: 1 } as const)[e.key]
    if (dir === undefined) return
    e.preventDefault()
    onStep(dir, e.currentTarget)
    onEnd()
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={stacked ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      title={`Arrastar para mudar o tamanho · dois cliques: ${reset}`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        onReset()
        onEnd()
      }}
      onKeyDown={onKeyDown}
      className={cn(
        'group relative z-10 shrink-0 touch-none outline-none',
        between === 'windows'
          ? stacked
            ? 'h-gap cursor-row-resize'
            : 'w-gap cursor-col-resize'
          : between === 'islands'
            ? 'w-frame cursor-col-resize'
            : cn('bg-border', stacked ? 'h-px cursor-row-resize' : 'w-px cursor-col-resize'),
      )}
    >
      {/* Área de pegar mais larga que a linha: acertar 1px com o mouse é impossível. */}
      <span className={cn('absolute', stacked ? 'inset-x-0 -inset-y-1.5' : 'inset-y-0 -inset-x-1.5')} />
      {/* A linha (ou a pílula, na folga) acende ao passar o mouse, ao arrastar e com foco do teclado. */}
      <span
        className={cn(
          'pointer-events-none absolute opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100',
          between
            ? cn('top-1/2 left-1/2 -translate-1/2 rounded-full bg-foreground/25 group-active:bg-foreground/50', stacked ? 'h-1 w-12' : 'h-12 w-1')
            : cn('bg-primary', stacked ? 'inset-x-0 -top-px h-[3px]' : 'inset-y-0 -left-px w-[3px]'),
        )}
      />
    </div>
  )
}
