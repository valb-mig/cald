import { ChevronDown, ExternalLink, FileX, Globe, Link2, RotateCcw, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { PageFrame, PageProblem } from '@/components/prototype/page-frame'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { artefatoViewUrl } from '@/lib/api'
import {
  ArtefatoIcon,
  artefatoLink,
  closeArtefatoDialog,
  copyLink,
  latestOf,
  loadArtefatos,
  openArtefatos,
  restoreArtefato,
  useArtefato,
  useArtefatoDialog,
  type ArtefatoRef,
} from '@/lib/artefatos'
import { shortPath, shortTime } from '@/lib/format'
import { useWide } from '@/lib/hooks'
import type { Artefato, ArtefatoVersao } from '@/lib/types'

type Props = ArtefatoRef & {
  /** No celular, em tela cheia: com o voltar. */
  dialog?: boolean
  onBack?: () => void
  /** Escolheu outra versão na barra: quem mostra a vista guarda (a aba, ou a tela cheia). */
  onVersion: (n: number) => void
  /** Um toque dentro da página, para o grupo da aba vir para o foco. */
  onInteract?: () => void
}

/**
 * Um artefato no mini-navegador (ver PageFrame): a versão `n` (sem ela, a atual) num iframe isolado. A
 * versão é congelada, então não há o que conferir: recarregar só pede a página de novo. Na barra, a
 * escolha da versão, o selo verde de quando ele está na internet, copiar o link e abrir numa janela.
 */
export function ArtefatoView({ machine, id, n, title, dialog = false, onBack, onVersion, onInteract }: Props) {
  const { artefato: a, trashed, loaded, error } = useArtefato(machine, id)
  const [reloads, setReloads] = useState(0)
  const [busy, setBusy] = useState(false)

  const latest = a && latestOf(a)
  const version = (a && n !== undefined ? a.versions.find((v) => v.n === n) : undefined) ?? latest
  const old = Boolean(version && latest && version.n !== latest.n)
  const view = a && version ? artefatoViewUrl(machine, a.id, version.n, version.entry) : null
  // Recarregar à mão entra na URL, para o iframe novo pedir a página de novo.
  const src = view ? `${view}${reloads ? `?r=${reloads}` : ''}` : null
  // Uma versão antiga leva ao link dela; a atual, ao link fixo.
  const link = a && artefatoLink(machine, a.link, old ? version!.n : undefined)
  const name = a?.title || title || 'Artefato'

  // A página, e a lista de novo (o artefato pode ter ganhado versão, ou voltado da lixeira).
  const reload = () => {
    setReloads((r) => r + 1)
    setBusy(true)
    loadArtefatos(machine)
      .catch(() => {})
      .finally(() => setBusy(false))
  }

  const problem = !a ? (
    trashed ? (
      <PageProblem icon={Trash2} text="Este artefato está na lixeira.">
        <Button size="sm" variant="outline" onClick={() => void restoreArtefato(machine, id)}>
          <RotateCcw /> Restaurar
        </Button>
      </PageProblem>
    ) : loaded ? (
      <PageProblem icon={FileX} text="Este artefato não existe mais." />
    ) : error ? (
      <PageProblem icon={TriangleAlert} text={error}>
        <Button size="sm" variant="outline" onClick={reload}>
          Tentar de novo
        </Button>
      </PageProblem>
    ) : undefined
  ) : !version ? (
    <PageProblem icon={FileX} text="Este artefato não tem versões." />
  ) : undefined

  return (
    <PageFrame
      src={src}
      title={name}
      dialog={dialog}
      onBack={onBack}
      onReload={reload}
      busy={busy}
      onInteract={onInteract}
      problem={problem}
      icon={ArtefatoIcon}
      address={name}
      hint={a ? `${a.title}\n${shortPath(a.source)}` : name}
      badge={
        a?.public && (
          <span title={`v${a.public.n} pública na internet`} className="flex shrink-0">
            <Globe aria-label="Público" className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          </span>
        )
      }
      actions={
        a &&
        version && (
          <>
            <VersionPicker machine={machine} artefato={a} version={version} onVersion={onVersion} dialog={dialog} />
            <Button variant="ghost" size="icon" onClick={() => copyLink(link!)} aria-label="Copiar o link" title={old ? `Copiar o link da v${version.n}` : 'Copiar o link'}>
              <Link2 />
            </Button>
            <Button variant="ghost" size="icon" asChild>
              <a href={link!} target="_blank" rel="noreferrer" aria-label="Abrir numa janela" title="Abrir numa janela">
                <ExternalLink />
              </a>
            </Button>
          </>
        )
      }
    />
  )
}

/** "v2 ▾": as versões, da mais nova para a mais antiga, com a atual marcada; e o caminho para a galeria. */
function VersionPicker({
  machine,
  artefato: a,
  version,
  onVersion,
  dialog,
}: {
  machine: string
  artefato: Artefato
  version: ArtefatoVersao
  onVersion: (n: number) => void
  dialog: boolean
}) {
  const latest = latestOf(a)
  const versions = [...a.versions].reverse()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-0.5 px-2 font-mono" aria-label={`Versão ${version.n}`} title="Versões">
          v{version.n}
          {/* Numa antiga, quantas há: a atual está no menu. */}
          {latest && version.n !== latest.n && <span className="text-muted-foreground max-sm:hidden">/{latest.n}</span>}
          <ChevronDown className="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-64">
        <DropdownMenuRadioGroup value={String(version.n)} onValueChange={(v) => onVersion(Number(v))}>
          {versions.map((v) => (
            <DropdownMenuRadioItem key={v.n} value={String(v.n)}>
              <span className="shrink-0 font-mono text-xs">v{v.n}</span>
              <span className="min-w-0 flex-1 truncate">{v.label}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{v.n === latest?.n ? 'atual' : shortTime(v.at)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            // No celular, a tela cheia sai da frente da galeria.
            if (dialog) closeArtefatoDialog()
            openArtefatos({ machine, id: a.id })
          }}
        >
          <ArtefatoIcon /> Ver em Artefatos
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * O artefato aberto pelo chat ou pela galeria no celular: ocupa a tela toda, e o voltar fecha (e volta à
 * galeria, se veio dela). No PC, ele abre como aba (ver lib/artefatos.ts).
 */
export function ArtefatoDialog() {
  const ref = useArtefatoDialog((s) => s.open)
  const wide = useWide()
  if (wide) return null
  return (
    <Dialog open={ref !== null} onOpenChange={(o) => !o && closeArtefatoDialog()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex h-dvh w-screen max-w-none flex-col gap-0 rounded-none border-0 p-0 pb-[env(safe-area-inset-bottom)] ring-0 sm:max-w-none"
      >
        {ref && (
          <ArtefatoView
            key={`${ref.machine}\n${ref.id}`}
            {...ref}
            dialog
            onBack={closeArtefatoDialog}
            onVersion={(n) => useArtefatoDialog.setState({ open: { ...ref, n } })}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
