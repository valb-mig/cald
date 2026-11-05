import { ArrowLeft, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogClose } from '@/components/ui/dialog'
import { useMediaQuery } from '@/lib/hooks'

/**
 * As peças dos modais em ilha, como o Computador (ver computer-sheet.tsx), as habilidades e os times:
 * uma ilha na cor da casca, com a lista à esquerda e a escolhida numa janela à direita. No celular, a
 * lista e a janela se revezam.
 */

/** O `DialogContent` da ilha (com `showCloseButton={false}`: o fechar fica no cabeçalho). */
export const ISLAND =
  'flex h-[min(38rem,calc(100dvh-2rem))] w-[min(52rem,calc(100vw-1.5rem))] max-w-none flex-col gap-0 overflow-hidden rounded-island bg-shell p-0 shadow-island ring-0 max-sm:h-[calc(100dvh-6rem)] sm:max-w-none sm:flex-row'

/** A janela, como a do Computador: um tom acima da casca no claro, e mais clara que ela no escuro. */
export const WINDOW = 'relative m-gap flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-pane bg-background max-sm:mt-0 sm:ml-0'

export const NAV_ITEM =
  'flex h-9 w-full shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-foreground aria-[current=page]:shadow-xs [&_svg]:size-4 [&_svg]:shrink-0'

// Os campos de um editor: sem borda, um tom acima da janela, como a busca das listas do app.
export const FIELD =
  'w-full rounded-lg bg-foreground/[0.05] px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/70 focus-visible:bg-foreground/[0.07] focus-visible:ring-1 focus-visible:ring-foreground/15'

/** A partir daqui, lista e janela lado a lado; abaixo, uma de cada vez. */
export const ISLAND_WIDE = '(min-width: 40rem)'

export function NavGroup({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="space-y-0.5">
      <h3 className="truncate px-2.5 pb-1 text-[11px] font-medium text-muted-foreground" title={title}>
        {title}
      </h3>
      {children.length ? children : <p className="px-2.5 text-xs text-muted-foreground/70">{empty}</p>}
    </section>
  )
}

/** O cabeçalho da janela, como o do Computador; no celular, com o voltar para a lista. */
export function WindowHeader({ title, subtitle, onBack, children }: { title: React.ReactNode; subtitle?: React.ReactNode; onBack?: () => void; children?: React.ReactNode }) {
  const wide = useMediaQuery(ISLAND_WIDE)
  return (
    <header className="flex shrink-0 items-start gap-2 px-6 pt-5 pb-4 max-sm:px-4 max-sm:pt-4">
      {!wide && onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Voltar" className="-ml-1">
          <ArrowLeft />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-base font-medium">{title}</h2>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {children}
      {wide && (
        <DialogClose asChild>
          <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-2" aria-label="Fechar">
            <X />
          </Button>
        </DialogClose>
      )}
    </header>
  )
}
