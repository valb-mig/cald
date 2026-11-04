import { cn } from '@/lib/utils'
import { veil } from '@/lib/wallpaper'

/**
 * A camada que escurece a janela inteira por dentro (a conversa, a inbox), por igual: a cena recua e o
 * texto ganha contraste sem uma faixa no meio da tela. Quem usa passa o `useScrim()`.
 */
export function Veil({ dim }: { dim: number }) {
  const { className, style } = veil(dim)
  return <div aria-hidden className={cn('pointer-events-none absolute inset-0', className)} style={style} />
}
