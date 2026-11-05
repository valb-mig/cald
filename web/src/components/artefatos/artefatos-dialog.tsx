import { ChevronRight, Copy, Ellipsis, ExternalLink, Globe, Link2, Loader2, RotateCcw, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { UndoBar } from '@/components/claude/bits'
import { Claudinho } from '@/components/claudinho'
import { ISLAND, ISLAND_WIDE, NAV_ITEM, WINDOW, WindowHeader } from '@/components/island'
import { ProjectMark } from '@/components/project-mark'
import { Group, SettingRow } from '@/components/settings-ui'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { artefatoViewUrl } from '@/lib/api'
import {
  ArtefatoIcon,
  artefatoLink,
  copyLink,
  latestOf,
  loadArtefatos,
  purgeArtefato,
  restoreArtefato,
  setArtefatoPublic,
  showArtefato,
  trashArtefato,
  useArtefatos,
  useArtefatosDialog,
  versionSize,
  type GaleriaAt,
} from '@/lib/artefatos'
import { projectName, relativeTime, shortTime } from '@/lib/format'
import { useMediaQuery } from '@/lib/hooks'
import { machineName, useMachines } from '@/lib/machines'
import type { Artefato, ArtefatoLixo, ArtefatoVersao } from '@/lib/types'
import { cn } from '@/lib/utils'
import { projectOf } from '@/lib/worktree'

/**
 * A galeria dos artefatos da máquina (ver lib/artefatos.ts), desenhada como as habilidades e os times:
 * uma ilha com os artefatos à esquerda, por projeto, e o escolhido numa janela à direita: a prévia, as
 * versões, o link fixo e o link público. Apagar manda para a lixeira, com Desfazer ali mesmo. No
 * celular, a lista e a janela se revezam.
 */

/** O que a janela mostra: um artefato ou a lixeira. */
type View = { kind: 'show'; id: string } | { kind: 'trash' }

/** Quantas versões aparecem antes do "Mais". */
const FEW_VERSIONS = 4

// Uma linha clicável dentro do bloco, com o alvo de toque do celular.
const ROW = 'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-foreground/[0.04]'

const bare = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

export function ArtefatosDialog() {
  const open = useArtefatosDialog((s) => s.open)
  const at = useArtefatosDialog((s) => s.at)
  const opened = useArtefatosDialog((s) => s.opened)
  return (
    <Dialog open={open} onOpenChange={(o) => useArtefatosDialog.setState({ open: o })}>
      <DialogContent showCloseButton={false} className={ISLAND}>
        <DialogTitle className="sr-only">Artefatos</DialogTitle>
        <DialogDescription className="sr-only">As páginas que o Claude publicou, com as versões, o link fixo e o link público.</DialogDescription>
        {/* Monta a cada abertura: começa no artefato pedido, ou no projeto de onde veio. */}
        {open && <Body key={`${at.machine}\n${opened}`} at={at} />}
      </DialogContent>
    </Dialog>
  )
}

/** Os artefatos por projeto (o de um worktree vai no de origem): primeiro o projeto `first`, depois pelo mais recente. */
function byProject(list: Artefato[], first?: string) {
  const groups = new Map<string, { cwd?: string; name: string; items: Artefato[] }>()
  for (const a of list) {
    const cwd = a.cwd ? projectOf(a.cwd) : undefined
    const key = cwd ?? ''
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { cwd, name: cwd ? projectName(cwd) : 'Sem projeto', items: [] }))
    g.items.push(a)
  }
  const all = [...groups.values()]
  const lead = first ? all.findIndex((g) => g.cwd === projectOf(first)) : -1
  return lead > 0 ? [all[lead]!, ...all.filter((_, i) => i !== lead)] : all
}

function Body({ at }: { at: GaleriaAt }) {
  const { machine } = at
  const wide = useMediaQuery(ISLAND_WIDE)
  const several = useMachines((s) => s.machines.length > 1)
  const list = useArtefatos((s) => s.byMachine[machine])
  const error = useArtefatos((s) => s.errors[machine])
  const [view, setView] = useState<View | null>(at.id ? { kind: 'show', id: at.id } : null)
  // O "Desfazer" fica dentro do modal: um aviso fica por baixo dele e não dá para tocar.
  const [undo, setUndo] = useState<Artefato | null>(null)

  // Sempre fresca ao abrir; depois, o `changed: artefatos` mantém a lista (ver lib/artefatos.ts).
  useEffect(() => {
    loadArtefatos(machine).catch(() => {})
  }, [machine])
  useEffect(() => {
    if (!undo) return
    const timer = setTimeout(() => setUndo(null), 6000)
    return () => clearTimeout(timer)
  }, [undo])

  const all = useMemo(() => list?.artefatos ?? [], [list])
  const groups = useMemo(() => byProject(all, at.cwd), [all, at.cwd])
  // Apagado em outro aparelho enquanto aberto: volta para a lista.
  const picked = view?.kind === 'show' && list && !all.some((a) => a.id === view.id) ? null : view
  // No PC, a janela nunca fica vazia: abre no primeiro do projeto de onde veio (ou no mais recente).
  const first = groups[0]?.items[0]
  const shown: View | null = picked ?? (wide && first ? { kind: 'show', id: first.id } : null)
  const current = shown?.kind === 'show' ? all.find((a) => a.id === shown.id) : undefined
  const showNav = wide || !shown
  const showWindow = wide || Boolean(shown)

  async function toTrash(a: Artefato) {
    if (!(await trashArtefato(machine, a))) return
    setUndo(a)
    setView(null)
  }

  async function restore(id: string) {
    const a = await restoreArtefato(machine, id)
    if (a) setView({ kind: 'show', id: a.id })
  }

  const undoBar = undo && (
    <div className="absolute inset-x-4 bottom-4">
      <UndoBar
        text={`${undo.title} foi para a lixeira`}
        onUndo={() => {
          setUndo(null)
          void restore(undo.id)
        }}
      />
    </div>
  )

  return (
    <>
      {showNav && (
        <nav className="flex min-h-0 shrink-0 flex-col gap-1 p-3 sm:w-72">
          <div className="flex items-center gap-1 px-2 pt-1 pb-2">
            <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
              Artefatos
              {several && <span className="font-normal text-muted-foreground"> · {machineName(machine)}</span>}
            </h2>
            {!wide && (
              <DialogClose asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Fechar">
                  <X />
                </Button>
              </DialogClose>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            {error && !list && <p className="px-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
            {!list && !error && <Loader2 className="mx-auto my-6 size-4 animate-spin text-muted-foreground" />}
            {list && !all.length && (wide ? <p className="px-2.5 text-xs text-muted-foreground/70">Nenhum ainda</p> : <Empty />)}
            {groups.map((g) => (
              <section key={g.cwd ?? ''} className="space-y-0.5">
                <h3 className="flex items-center gap-1.5 px-2.5 pb-1 text-[11px] font-medium text-muted-foreground" title={g.cwd}>
                  {g.cwd && <ProjectMark machine={machine} cwd={g.cwd} name={g.name} className="size-3.5 rounded-[4px] text-[8px]" />}
                  <span className="truncate">{g.name}</span>
                </h3>
                {g.items.map((a) => (
                  <NavItem key={a.id} artefato={a} current={current?.id === a.id} onClick={() => setView({ kind: 'show', id: a.id })} />
                ))}
              </section>
            ))}
          </div>
          {list && list.lixeira.length > 0 && (
            <button type="button" aria-current={shown?.kind === 'trash' ? 'page' : undefined} onClick={() => setView({ kind: 'trash' })} className={cn(NAV_ITEM, 'max-sm:h-11')}>
              <Trash2 />
              <span className="flex-1 text-left">Lixeira</span>
              <span className="text-xs text-muted-foreground tabular-nums">{list.lixeira.length}</span>
            </button>
          )}
        </nav>
      )}

      {showWindow && (
        <div className={WINDOW}>
          {shown?.kind === 'trash' ? (
            <TrashView items={list?.lixeira ?? []} onBack={() => setView(null)} onRestore={(id) => void restore(id)} onPurge={(id) => void purgeArtefato(machine, id)} />
          ) : current ? (
            <Detail key={current.id} machine={machine} artefato={current} onTrash={() => void toTrash(current)} onBack={() => setView(null)} />
          ) : list ? (
            <Empty />
          ) : (
            <div className="space-y-4 p-6">
              <Skeleton className="h-5 w-1/2 rounded-md" />
              <Skeleton className="aspect-[16/10] w-full rounded-xl" />
            </div>
          )}
          {undoBar}
        </div>
      )}
      {/* No celular, apagar volta para a lista, sem a janela: a barra fica no pé da ilha. */}
      {!showWindow && undoBar}
    </>
  )
}

/** Um artefato na lista: o claudinho da conversa que publicou, o título e, em cinza, a versão e quando. */
function NavItem({ artefato: a, current, onClick }: { artefato: Artefato; current: boolean; onClick: () => void }) {
  const latest = latestOf(a)
  return (
    <button type="button" aria-current={current ? 'page' : undefined} onClick={onClick} title={a.title} className={cn(NAV_ITEM, 'max-sm:h-11')}>
      {a.sessionId ? <Claudinho seed={a.sessionId} size={16} /> : <ArtefatoIcon />}
      <span className="min-w-0 flex-1 truncate text-left">{a.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {latest && <span className="font-mono">v{latest.n} · </span>}
        {shortTime(a.updatedAt)}
      </span>
    </button>
  )
}

/** Nenhum artefato: o que é um, e quem cria (o Claude). */
function Empty() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 py-10 text-center">
      <ArtefatoIcon className="size-8 text-muted-foreground/50" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Nenhum artefato ainda</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          O Claude publica uma página aqui com <code>publicar_artefato</code>, e cada versão fica guardada.
        </p>
      </div>
    </div>
  )
}

function Detail({ machine, artefato: a, onTrash, onBack }: { machine: string; artefato: Artefato; onTrash: () => void; onBack: () => void }) {
  const latest = latestOf(a)
  const link = artefatoLink(machine, a.link)
  const open = (n?: number) => showArtefato({ machine, id: a.id, n: n ?? latest?.n, title: a.title })
  const where = a.cwd ? projectName(projectOf(a.cwd)) : null
  return (
    <>
      <WindowHeader title={a.title} subtitle={[where, `atualizado ${relativeTime(a.updatedAt)}`].filter(Boolean).join(' · ')} onBack={onBack}>
        <Button size="sm" onClick={() => open()} disabled={!latest} className="-mt-1">
          Abrir
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Mais" title="Mais" className="-mt-1">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => copyLink(link)}>
              <Link2 /> Copiar link
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={link} target="_blank" rel="noreferrer">
                <ExternalLink /> Abrir numa janela
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onTrash}>
              <Trash2 /> Para a lixeira
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </WindowHeader>
      <div className="tab-panel-in min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6 max-sm:px-4">
        <div className="space-y-2">
          {latest && <Preview machine={machine} artefato={a} version={latest} onOpen={() => open()} />}
          {a.description && <p className="line-clamp-3 px-1 text-sm text-muted-foreground">{a.description}</p>}
        </div>
        <Versions artefato={a} onOpen={open} />
        <Group title="Link" note="Abre na sua tailnet, sempre na versão mais nova.">
          <LinkRow url={link} />
        </Group>
        <Public machine={machine} artefato={a} />
      </div>
    </>
  )
}

/**
 * A versão atual em miniatura, como a página aparece numa tela larga: o iframe tem o dobro do tamanho e
 * fica pela metade. Isolado (só scripts) e sem toque: tocar abre o artefato.
 */
function Preview({ machine, artefato: a, version: v, onOpen }: { machine: string; artefato: Artefato; version: ArtefatoVersao; onOpen: () => void }) {
  const src = artefatoViewUrl(machine, a.id, v.n, v.entry)
  return (
    <div className="rounded-xl bg-foreground/[0.04] p-1">
      <div className="relative aspect-[16/10] overflow-hidden rounded-lg bg-white">
        <iframe
          key={src}
          src={src}
          title={`Prévia de ${a.title}`}
          sandbox="allow-scripts"
          loading="lazy"
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 h-[200%] w-[200%] origin-top-left scale-50 border-0"
        />
        <button type="button" onClick={onOpen} aria-label={`Abrir ${a.title}`} className="absolute inset-0 transition-colors hover:bg-foreground/[0.03]" />
      </div>
    </div>
  )
}

/** As versões, da mais nova para a mais antiga; tocar abre aquela. As antigas além de algumas ficam no "Mais". */
function Versions({ artefato: a, onOpen }: { artefato: Artefato; onOpen: (n: number) => void }) {
  const [all, setAll] = useState(false)
  const versions = [...a.versions].reverse()
  const latest = versions[0]
  const shown = all ? versions : versions.slice(0, FEW_VERSIONS)
  const hidden = versions.length - shown.length
  return (
    <Group title="Versões">
      {shown.map((v) => (
        <button key={v.n} type="button" onClick={() => onOpen(v.n)} className={ROW}>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">
              <span className="font-mono">v{v.n}</span>
              {v.label && <span> · {v.label}</span>}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {relativeTime(v.at)} · {versionSize(v)}
            </span>
          </span>
          {a.public?.n === v.n && (
            <span title="Esta está no link público" className="flex shrink-0">
              <Globe aria-label="Pública" className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            </span>
          )}
          {v === latest && <span className="shrink-0 text-xs text-muted-foreground">atual</span>}
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </button>
      ))}
      {hidden > 0 && (
        <button type="button" onClick={() => setAll(true)} className={cn(ROW, 'text-sm text-muted-foreground hover:text-foreground')}>
          Mais {hidden === 1 ? '1 versão' : `${hidden} versões`}
        </button>
      )}
    </Group>
  )
}

/** Um link para ler, com copiar e abrir. */
function LinkRow({ url, live = false }: { url: string; live?: boolean }) {
  return (
    <div className="flex min-h-11 items-center gap-1 rounded-lg py-1 pr-1 pl-3">
      {live && <Globe className="mr-1 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={url}>
        {bare(url)}
      </span>
      <Button variant="ghost" size="icon-sm" onClick={() => copyLink(url)} aria-label="Copiar o link" title="Copiar o link">
        <Copy />
      </Button>
      <Button variant="ghost" size="icon-sm" asChild>
        <a href={url} target="_blank" rel="noreferrer" aria-label="Abrir numa janela" title="Abrir numa janela">
          <ExternalLink />
        </a>
      </Button>
    </div>
  )
}

/**
 * O link público (o Funnel do Tailscale): só você liga, por aqui. Ele mostra a versão que estava atual ao
 * ligar; com uma mais nova, "Publicar vN" leva ela para o mesmo link.
 */
function Public({ machine, artefato: a }: { machine: string; artefato: Artefato }) {
  const [busy, setBusy] = useState(false)
  const latest = latestOf(a)
  const run = async (on: boolean) => {
    setBusy(true)
    await setArtefatoPublic(machine, a.id, on)
    setBusy(false)
  }
  return (
    <Group note="Qualquer pessoa com o link vê a versão publicada; versões novas só entram quando você atualizar.">
      <SettingRow
        label="Link público"
        hint={a.public ? `v${a.public.n} pública · desde ${relativeTime(a.public.since)}` : undefined}
        htmlFor="artefato-publico"
      >
        {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        <Switch id="artefato-publico" checked={Boolean(a.public)} disabled={busy} onCheckedChange={(on) => void run(on)} />
      </SettingRow>
      {a.public && <LinkRow url={a.public.url} live />}
      {a.public && latest && latest.n > a.public.n && (
        <SettingRow label={`A v${latest.n} é mais nova`}>
          <Button variant="secondary" size="xs" disabled={busy} onClick={() => void run(true)}>
            Publicar v{latest.n}
          </Button>
        </SettingRow>
      )}
    </Group>
  )
}

function TrashView({ items, onBack, onRestore, onPurge }: { items: ArtefatoLixo[]; onBack: () => void; onRestore: (id: string) => void; onPurge: (id: string) => void }) {
  // Apagar de vez não tem volta: pergunta antes.
  const [purging, setPurging] = useState<ArtefatoLixo | null>(null)
  return (
    <>
      <WindowHeader title="Lixeira" subtitle="O que fica mais de 30 dias aqui some sozinho." onBack={onBack} />
      <div className="tab-panel-in min-h-0 flex-1 overflow-y-auto px-6 pb-6 max-sm:px-4">
        {items.length ? (
          <Group>
            {items.map((t) => (
              <div key={t.id} className="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2">
                {t.sessionId ? <Claudinho seed={t.sessionId} size={20} /> : <ArtefatoIcon className="size-4 shrink-0 text-muted-foreground" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{t.title}</div>
                  <div className="text-xs text-muted-foreground">{relativeTime(t.deletedAt)}</div>
                </div>
                <Button variant="ghost" size="xs" onClick={() => onRestore(t.id)}>
                  <RotateCcw /> Restaurar
                </Button>
                <Button variant="ghost" size="icon-xs" onClick={() => setPurging(t)} aria-label={`Apagar ${t.title} de vez`} title="Apagar de vez" className="hover:text-destructive">
                  <X />
                </Button>
              </div>
            ))}
          </Group>
        ) : (
          <p className="px-1 text-sm text-muted-foreground">Vazia.</p>
        )}
      </div>
      <AlertDialog open={purging !== null} onOpenChange={(o) => !o && setPurging(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar de vez?</AlertDialogTitle>
            <AlertDialogDescription>
              {purging?.title} e todas as versões saem do PC, e os links dele param de abrir.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => purging && onPurge(purging.id)}>
              Apagar de vez
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
