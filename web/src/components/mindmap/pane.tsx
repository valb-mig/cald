import { ResizeHandle } from '@/components/ui/resize-handle'
import { MAP_WIDTH, saveMapWidth, setMapWidth, useMapWidth } from './view'

/** Menor espaço de cada lado ao arrastar: o do chat é o de um celular pequeno, para o qual ele foi feito. */
const MIN_MAP = 300
const MIN_CHAT = 340
/** Quanto cada toque nas setas do teclado move a divisória, em fração da largura dos dois. */
const KEY_STEP = 0.05

/**
 * A borda entre o chat e o mapa. Arrastar passa espaço de um para o outro, dois cliques voltam ao
 * tamanho de sempre, e com foco as setas do teclado também mexem.
 */
function Divider() {
  const width = useMapWidth((s) => s.width)

  /** Limites da fração do mapa para a largura `total`; janela estreita demais divide ao meio. */
  const bounds = (total: number) => {
    const lo = Math.min(MIN_MAP, total / 2)
    const hi = Math.max(total - MIN_CHAT, total / 2)
    return [lo / total, hi / total] as const
  }

  return (
    <ResizeHandle
      label="Tamanho do chat e do mapa"
      value={Math.round((1 - width) * 100)}
      onStart={(bar) => {
        const map = bar.nextElementSibling?.getBoundingClientRect()
        const total = bar.parentElement?.clientWidth
        if (!map || !total) return null
        const [lo, hi] = bounds(total)
        // O mapa fica à direita: levar a divisória para a esquerda o alarga.
        return (delta) => setMapWidth(Math.min(hi, Math.max(lo, (map.width - delta) / total)))
      }}
      onStep={(dir, bar) => {
        const total = bar.parentElement?.clientWidth
        if (!total) return
        const [lo, hi] = bounds(total)
        setMapWidth(Math.min(hi, Math.max(lo, width - dir * KEY_STEP)))
      }}
      onReset={() => setMapWidth(MAP_WIDTH)}
      onEnd={saveMapWidth}
    />
  )
}

/**
 * Onde o mapa fica: no lugar do chat ou, com `beside`, à direita dele, com a divisória no meio. É o
 * mesmo elemento nos dois casos, para trocar de um para o outro não desmontar o mapa (zoom, galhos
 * recolhidos). Só isto acompanha a largura, então arrastar não redesenha a conversa inteira.
 */
export function MapPane({ beside, children }: { beside: boolean; children: React.ReactNode }) {
  const width = useMapWidth((s) => s.width)
  return (
    <>
      {beside && <Divider />}
      <div
        // O mínimo e o máximo seguram os dois lados quando a janela encolhe depois do arrasto.
        className={beside ? 'relative shrink-0' : 'absolute inset-0 z-20'}
        style={beside ? { width: `${width * 100}%`, minWidth: MIN_MAP, maxWidth: `calc(100% - ${MIN_CHAT}px)` } : undefined}
      >
        {children}
      </div>
    </>
  )
}
