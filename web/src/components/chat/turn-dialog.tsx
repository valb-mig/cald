import { FilePen, Link2, SquareTerminal, X } from 'lucide-react'
import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useWide } from '@/lib/hooks'
import { machineOf } from '@/lib/machines'
import { cn } from '@/lib/utils'
import { LineCounts } from './activity'
import { linksOf, type TurnInfo } from './turn'
import { CommandsView, FilesView, LinksView, SEARCH_FROM } from './turn-views'

export type TurnSection = 'files' | 'commands' | 'links'

const KIND = {
  files: { title: 'Arquivos', icon: FilePen, description: 'Os arquivos que o Claude mudou nesta resposta, com as edições.' },
  commands: { title: 'Comandos', icon: SquareTerminal, description: 'Os comandos que o Claude rodou nesta resposta, com a saída.' },
  links: { title: 'Links', icon: Link2, description: 'As páginas que o Claude abriu, as pesquisas e os links citados nesta resposta.' },
} as const

/**
 * O que o Claude fez num turno, um assunto por modal: cada atalho embaixo da resposta (arquivos,
 * comandos, links) abre o seu. Uma ilha de janela só, como a do TODO: o tipo e a contagem na casca e
 * a lista numa janela.
 */
export function TurnDialog({
  kind,
  turn,
  cwd,
  sessionId,
  open,
  onOpenChange,
}: {
  kind: TurnSection
  turn: TurnInfo
  cwd?: string
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(40rem,calc(100dvh-2rem))] w-[min(42rem,calc(100vw-1.5rem))] max-w-none flex-col gap-0 overflow-hidden rounded-island bg-shell p-0 shadow-island ring-0 sm:max-w-none"
      >
        {/* O conteúdo só existe com o modal aberto: fechado, a lista e as contas não são refeitas a cada evento. */}
        <TurnBody kind={kind} turn={turn} cwd={cwd} sessionId={sessionId} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function TurnBody({ kind, turn, cwd, sessionId, onClose }: { kind: TurnSection; turn: TurnInfo; cwd?: string; sessionId: string; onClose: () => void }) {
  // A busca já vem em foco só no PC: no celular, abriria o teclado por cima da lista.
  const wide = useWide()
  const links = useMemo(() => (kind === 'links' ? linksOf(turn) : []), [kind, turn])
  const { title, icon: Icon, description } = KIND[kind]
  const count = kind === 'files' ? turn.files.length : kind === 'commands' ? turn.commands.length : links.length
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 py-1.5 pr-1.5 pl-[calc(var(--gap)+1.25rem)] max-sm:pl-[calc(var(--gap)+1rem)]">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <DialogTitle className="text-sm">{title}</DialogTitle>
        <span className="text-sm text-muted-foreground tabular-nums">{count}</span>
        {kind === 'files' && (
          <LineCounts added={turn.files.reduce((n, f) => n + f.added, 0)} removed={turn.files.reduce((n, f) => n + f.removed, 0)} />
        )}
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <DialogClose asChild>
          <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Fechar" title="Fechar">
            <X />
          </Button>
        </DialogClose>
      </header>

      {/* Com busca, a janela tem uma altura mínima: filtrar não encolhe a ilha a cada letra. */}
      <div className={cn('mx-gap mb-gap flex min-h-0 flex-1 flex-col overflow-hidden rounded-pane bg-background', count > SEARCH_FROM && 'min-h-[min(26rem,calc(100dvh-6rem))]')}>
        {kind === 'files' ? (
          <FilesView files={turn.files} cwd={cwd} machine={machineOf(sessionId)} onDone={onClose} autoFocus={wide} />
        ) : kind === 'commands' ? (
          <CommandsView commands={turn.commands} autoFocus={wide} />
        ) : (
          <LinksView visited={turn.visited} cited={turn.cited} autoFocus={wide} />
        )}
      </div>
    </>
  )
}
