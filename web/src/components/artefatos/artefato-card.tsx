import { Ellipsis, Link2 } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ArtefatoIcon, artefatoLink, copyLink, openArtefatos, showArtefato, useArtefatos, type Publicacao } from '@/lib/artefatos'
import { machineOf } from '@/lib/machines'

/**
 * O artefato que o Claude publicou, à vista no chat como a página do claude.ai (ver PrototypeCard): o
 * título, a versão e o arquivo em cinza, o Abrir (no PC, numa aba; no celular, em tela cheia) e, no `⋯`,
 * copiar o link fixo e ver na galeria. Abre a versão que esta publicação criou.
 */
export function ArtefatoCard({ sessionId, pub }: { sessionId: string; pub: Publicacao }) {
  const machine = machineOf(sessionId)
  // O link que a ferramenta devolveu; sem ele, o da lista.
  const stored = useArtefatos((s) => s.byMachine[machine]?.artefatos.find((a) => a.id === pub.id)?.link)
  const link = pub.link ?? (stored ? artefatoLink(machine, stored) : undefined)
  const open = () => showArtefato({ machine, id: pub.id, n: pub.n, title: pub.title })
  return (
    <div className="flex max-w-md items-center gap-1 rounded-xl bg-foreground/[0.04] p-1">
      <button
        type="button"
        onClick={open}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1 pr-1.5 pl-1 text-left transition-colors hover:bg-foreground/[0.04]"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background">
          <ArtefatoIcon className="size-4 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{pub.title}</span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            v{pub.n}
            {pub.file && pub.file !== pub.title && ` · ${pub.file}`}
          </span>
        </span>
        <span className="shrink-0 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">Abrir</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Mais"
            title="Mais"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <Ellipsis className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!link} onSelect={() => link && copyLink(link)}>
            <Link2 /> Copiar link
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openArtefatos({ machine, id: pub.id })}>
            <ArtefatoIcon /> Ver em Artefatos
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
