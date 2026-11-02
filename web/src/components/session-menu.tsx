import { Columns2, PencilLine, SquarePlus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { navigate } from 'wouter/use-browser-location'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { claudinhoName } from '@/lib/claudinho'
import { useWide } from '@/lib/hooks'
import { openBeside, useSplit } from '@/lib/split'
import type { CatalogEntry } from '@/lib/types'
import { openTab } from '@/lib/workbench'

/** Conversa e ponto da tela (o do clique ou do dedo) onde o menu abre. */
export type MenuAt = { session: CatalogEntry; x: number; y: number }

/**
 * Menu de uma conversa da lista, no ponto onde foi pedido. No PC, abrir numa aba nova (fixa: não toma
 * o lugar da prévia, como o clique) ou ao lado, num grupo novo; e, em qualquer tela, renomear o
 * claudinho e apagar.
 */
export function SessionMenu({
  at,
  open,
  onOpenChange,
  onDelete,
  onRename,
}: {
  /** Fica com a última conversa enquanto o menu fecha, para ele não esvaziar na animação. */
  at: MenuAt | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDelete: (session: CatalogEntry) => void
  /** Trocar o nome do claudinho da conversa (ver claudinho-name.tsx). */
  onRename: (session: CatalogEntry) => void
}) {
  const onPc = at?.session.owner === 'pc'
  const wide = useWide()
  const split = useSplit()
  // Fora da tela das abas (home, nova conversa), a URL leva até a aba que acabou de abrir.
  const show = (id: string) => navigate(`/s/${id}`)
  return (
    <DropdownMenu open={open && Boolean(at)} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: at?.x ?? 0, top: at?.y ?? 0 }} />
      </DropdownMenuTrigger>
      {/* Um pouco abaixo do dedo: ao soltar, ele não cai em cima de uma opção. */}
      <DropdownMenuContent
        align="start"
        sideOffset={8}
        collisionPadding={8}
        className="w-auto max-w-72 min-w-52"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {at && (
          <>
            <DropdownMenuLabel className="truncate">{at.session.title}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {wide && (
              <>
                <DropdownMenuItem
                  onSelect={() => {
                    openTab({ kind: 'chat', id: at.session.sessionId })
                    show(at.session.sessionId)
                  }}
                >
                  <SquarePlus /> Abrir em nova aba
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    const id = at.session.sessionId
                    if (!split.ids.includes(id) && !split.canAdd)
                      return void toast(`Cabem ${split.max} conversas lado a lado nesta tela. Feche uma para abrir outra.`)
                    openBeside(id)
                    show(id)
                  }}
                >
                  <Columns2 /> Abrir ao lado
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={() => onRename(at.session)}>
              <PencilLine /> Renomear {claudinhoName(at.session.sessionId, at.session.claudinhoName)}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={onPc} onSelect={() => onDelete(at.session)}>
              <Trash2 /> {onPc ? 'Apagar (feche no PC antes)' : 'Apagar conversa'}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
