import { ArrowLeft, Bookmark, ChevronDown, ClipboardPaste, Ellipsis, Hammer, Layers, Loader2, Package, Pencil, Pin, PinOff, Plus, RotateCcw, SquarePlus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { UndoBar } from '@/components/claude/bits'
import { Segmented } from '@/components/settings-ui'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from '@/lib/api'
import { useOnChanged } from '@/lib/changes'
import { projectName, relativeTime } from '@/lib/format'
import { runInTerminal, useTerminals } from '@/lib/terminals'
import type { CommandSuggestion, SavedCommand, SavedCommandList } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Os comandos salvos do terminal (ver server/src/saved-commands.ts), numa barra à direita dele no
 * painel de baixo: os fixados, os do projeto da aba à vista, os globais e o que o projeto já oferece
 * (scripts do package.json, alvos do Makefile, comandos do workspace). Tocar roda na aba à vista (ver
 * `runInTerminal`); o resto fica no hover e no `⋯`. Segue a pasta em que o shell está: um `cd` para
 * outro projeto troca a lista. Aberta ou fechada, ver `useCommandsBar`.
 */

type Draft = { id?: string; label: string; command: string; scope: 'project' | 'global'; project: string | null; pinned: boolean }

const nameOf = (c: { label: string; command: string }) => c.label.trim() || c.command
const byName = (a: SavedCommand, b: SavedCommand) => nameOf(a).localeCompare(nameOf(b), 'pt-BR')
const failed = (err: unknown) => toast.error(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err))

// Sugestões além disso ficam num "Mais n" (com uma a mais, mostra todas: "Mais 1" não economiza nada).
const SUGGESTIONS = 6

export function TerminalCommands() {
  const machine = useTerminals((s) => s.tabs.find((t) => t.id === s.active)?.machine)
  const dir = useTerminals((s) => {
    const tab = s.tabs.find((t) => t.id === s.active)
    return tab && (tab.here ?? tab.cwd)
  })
  if (machine === undefined || !dir) return null
  // Outra máquina, outra lista: nada da de antes fica na tela.
  return <Bar key={machine} machine={machine} dir={dir} />
}

function Bar({ machine, dir }: { machine: string; dir: string }) {
  // A lista e a pasta para a qual ela veio: num `cd`, a de antes fica até a nova chegar, sem piscar.
  const [loaded, setLoaded] = useState<{ dir: string; list: SavedCommandList }>()
  const [error, setError] = useState<string | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [editing, setEditing] = useState<{ open: boolean; draft: Draft; n: number }>()
  // O "Desfazer" fica dentro da barra: um aviso no canto da tela fica longe do que sumiu.
  const [undo, setUndo] = useState<SavedCommand | null>(null)
  // O projeto em que as sugestões estão abertas além das primeiras; em outro, recolhem de novo.
  const [moreIn, setMoreIn] = useState<string | null | undefined>(undefined)
  const seq = useRef(0)

  const load = useCallback(() => {
    // Só a resposta do último pedido vale: num `cd` atrás do outro, a de uma pasta antiga chega depois.
    const n = ++seq.current
    api.savedCommands(machine, dir).then(
      (list) => {
        if (n !== seq.current) return
        setLoaded({ dir, list })
        setError(null)
      },
      (err) => n === seq.current && setError(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err)),
    )
  }, [machine, dir])
  useEffect(load, [load])
  // Salvo ou apagado em outro aparelho.
  useOnChanged(machine, 'saved-commands', load)
  useEffect(() => {
    if (!undo) return
    const timer = setTimeout(() => setUndo(null), 6000)
    return () => clearTimeout(timer)
  }, [undo])

  const list = loaded?.list
  const projectDir = list?.projectDir ?? null
  // A pasta da lista à vista: é nela que o PC acha o projeto em que se salva.
  const base = loaded?.dir ?? dir

  const fresh = (): Draft => ({ label: '', command: '', scope: projectDir ? 'project' : 'global', project: null, pinned: false })
  const edit = (draft: Draft) => setEditing((e) => ({ open: true, draft, n: (e?.n ?? 0) + 1 }))

  async function setPinned(c: SavedCommand, pinned: boolean) {
    // Muda já na tela; a lista do PC confirma em seguida.
    const flip = (cs: SavedCommand[]) => cs.map((x) => (x.id === c.id ? { ...x, pinned } : x))
    setLoaded((l) => l && { ...l, list: { ...l.list, project: flip(l.list.project), global: flip(l.list.global) } })
    try {
      await api.saveCommand(machine, { id: c.id, label: c.label, command: c.command, project: c.project, pinned })
    } catch (err) {
      failed(err)
    }
    load()
  }

  async function trash(c: SavedCommand) {
    try {
      await api.trashCommand(machine, c.id)
      setUndo(c)
      load()
    } catch (err) {
      failed(err)
    }
  }

  async function keep(s: CommandSuggestion, pinned: boolean) {
    try {
      await api.saveCommand(machine, { label: s.label, command: s.command, project: projectDir ? base : null, pinned })
      toast.success(pinned ? 'Fixado' : 'Salvo')
      load()
    } catch (err) {
      failed(err)
    }
  }

  const saved = list ? [...list.project, ...list.global] : []
  const pinned = saved.filter((c) => c.pinned).sort(byName)
  const mine = list?.project.filter((c) => !c.pinned) ?? []
  const global = list?.global.filter((c) => !c.pinned) ?? []
  const suggestions = list?.suggestions ?? []
  const more = moreIn === projectDir || suggestions.length <= SUGGESTIONS + 1
  const empty = list && !saved.length && !suggestions.length
  const showTrash = trashOpen && list && list.trash.length > 0

  const row = (c: SavedCommand) => (
    <SavedRow key={c.id} command={c} onPin={() => void setPinned(c, !c.pinned)} onEdit={() => edit(draftOf(c))} onTrash={() => void trash(c)} />
  )

  return (
    <aside aria-label="Comandos salvos" className="cr-fade-in relative mr-1.5 mb-1.5 flex w-56 shrink-0 flex-col overflow-hidden rounded-xl bg-foreground/[0.03]">
      {showTrash ? (
        <TrashList machine={machine} items={list.trash} onBack={() => setTrashOpen(false)} onChanged={load} />
      ) : (
        <>
          <header className="flex h-9 shrink-0 items-center gap-1 pr-1 pl-3">
            <h2 className="flex-1 text-xs font-medium">Salvos</h2>
            <Button variant="ghost" size="icon-xs" onClick={() => edit(fresh())} aria-label="Novo comando" title="Novo comando">
              <Plus />
            </Button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 pb-2">
            {error && <p className="px-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
            {!list && !error && (
              <div role="status" aria-label="Carregando" className="space-y-2 px-2 pt-1">
                {['w-3/5', 'w-4/5', 'w-1/2'].map((w) => (
                  <Skeleton key={w} className={cn('h-3.5', w)} />
                ))}
              </div>
            )}
            {empty ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-3 pb-6 text-center">
                <Bookmark className="size-7 text-muted-foreground/40" />
                <p className="text-xs text-muted-foreground">Nenhum comando salvo</p>
                <Button variant="secondary" size="sm" onClick={() => edit(fresh())}>
                  <Plus /> Novo
                </Button>
              </div>
            ) : (
              list && (
                <>
                  <Section title="Fixados" count={pinned.length}>
                    {pinned.map(row)}
                  </Section>
                  <Section title={projectDir ? projectName(projectDir) : 'Deste projeto'} count={mine.length}>
                    {mine.map(row)}
                  </Section>
                  <Section title="Globais" count={global.length}>
                    {global.map(row)}
                  </Section>
                  <Section title="Sugestões" count={suggestions.length}>
                    {(more ? suggestions : suggestions.slice(0, SUGGESTIONS)).map((s) => (
                      <SuggestionRow key={`${s.source}:${s.from ?? ''}:${s.command}`} suggestion={s} project={projectDir} onKeep={(pin) => void keep(s, pin)} />
                    ))}
                    {!more && (
                      <button
                        type="button"
                        onClick={() => setMoreIn(projectDir)}
                        className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-xs text-muted-foreground transition-colors outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ChevronDown className="size-3.5 shrink-0" />
                        Mais {suggestions.length - SUGGESTIONS}
                      </button>
                    )}
                  </Section>
                </>
              )
            )}
          </div>
          {list && list.trash.length > 0 && (
            <button
              type="button"
              onClick={() => setTrashOpen(true)}
              className="mx-1 mb-1 flex h-7 shrink-0 items-center gap-2 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <Trash2 className="size-3.5" />
              <span className="flex-1 text-left">Lixeira</span>
              <span className="tabular-nums">{list.trash.length}</span>
            </button>
          )}
        </>
      )}
      {undo && (
        <div className="absolute inset-x-2 bottom-2">
          <UndoBar
            text="Na lixeira"
            onUndo={() => {
              setUndo(null)
              void api.restoreCommand(machine, undo.id).then(load, failed)
            }}
          />
        </div>
      )}
      <Dialog open={Boolean(editing?.open)} onOpenChange={(open) => setEditing((e) => e && { ...e, open })}>
        <DialogContent className="sm:max-w-md">
          {/* Fica com o último enquanto o diálogo fecha, para não esvaziar na animação. */}
          {editing && (
            <CommandForm
              key={editing.n}
              machine={machine}
              base={base}
              projectDir={projectDir}
              draft={editing.draft}
              onDone={(changed) => {
                setEditing((e) => e && { ...e, open: false })
                if (changed) load()
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </aside>
  )
}

const draftOf = (c: SavedCommand): Draft => ({ id: c.id, label: c.label, command: c.command, scope: c.project ? 'project' : 'global', project: c.project, pinned: c.pinned })

/** Um grupo da lista, com o título pequeno; vazio (`count` 0), não aparece. */
function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (!count) return null
  return (
    <section>
      <h3 className="truncate px-2 pb-0.5 text-[11px] font-medium text-muted-foreground" title={title}>
        {title}
      </h3>
      {children}
    </section>
  )
}

// Uma linha: o nome ocupa o que sobra, e as ações aparecem no hover (ou com o menu aberto) no lugar do fim dele.
const ROW = 'group/cmd flex h-7 min-w-0 items-center rounded-lg text-xs transition-colors hover:bg-foreground/5 has-[[data-state=open]]:bg-foreground/5'
const MAIN = 'flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring'
const TOOLS = 'hidden shrink-0 items-center pr-0.5 group-focus-within/cmd:flex group-hover/cmd:flex group-has-[[data-state=open]]/cmd:flex pointer-coarse:flex'

/** Um comando salvo: tocar roda; o alfinete e o `⋯` no hover. Sem nome, mostra o próprio comando. */
function SavedRow({ command: c, onPin, onEdit, onTrash }: { command: SavedCommand; onPin: () => void; onEdit: () => void; onTrash: () => void }) {
  return (
    <div className={ROW}>
      <button type="button" onClick={() => runInTerminal(c.command, { enter: true })} title={c.command} className={MAIN}>
        <span className={cn('truncate', !c.label.trim() && 'font-mono text-[11.5px]')}>{nameOf(c)}</span>
      </button>
      <div className={TOOLS}>
        <Button variant="ghost" size="icon-xs" onClick={onPin} aria-label={c.pinned ? 'Desafixar' : 'Fixar'} title={c.pinned ? 'Desafixar' : 'Fixar'}>
          {c.pinned ? <PinOff /> : <Pin />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Mais ações" title="Mais ações">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          {/* Sem devolver o foco ao `⋯`: rodar e colar dão o foco ao terminal, e editar, ao diálogo. */}
          <DropdownMenuContent align="end" className="w-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuItem onSelect={() => runInTerminal(c.command, { enter: true, newTab: true })}>
              <SquarePlus /> Rodar numa aba nova
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => runInTerminal(c.command, { enter: false })}>
              <ClipboardPaste /> Colar sem rodar
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onPin}>
              {c.pinned ? <PinOff /> : <Pin />} {c.pinned ? 'Desafixar' : 'Fixar'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil /> Editar
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onTrash}>
              <Trash2 /> Para a lixeira
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

const SOURCE_ICON = { package: Package, make: Hammer, workspace: Layers } satisfies Record<CommandSuggestion['source'], typeof Package>

/**
 * Um comando que o projeto já tem, em cinza (ainda não é seu): o ícone diz de onde veio. Tocar roda;
 * o `+` e o alfinete salvam (no projeto, ou global fora de um), o alfinete já fixado.
 */
function SuggestionRow({ suggestion: s, project, onKeep }: { suggestion: CommandSuggestion; project: string | null; onKeep: (pinned: boolean) => void }) {
  const Icon = SOURCE_ICON[s.source]
  const where = project ? `em ${projectName(project)}` : 'em todo projeto'
  return (
    <div className={cn(ROW, 'text-muted-foreground hover:text-foreground')}>
      <button type="button" onClick={() => runInTerminal(s.command, { enter: true })} title={[s.command, s.from].filter(Boolean).join('\n')} className={MAIN}>
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{s.label || s.command}</span>
      </button>
      <div className={TOOLS}>
        <Button variant="ghost" size="icon-xs" onClick={() => onKeep(false)} aria-label="Salvar" title={`Salvar ${where}`}>
          <Plus />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={() => onKeep(true)} aria-label="Salvar fixado" title={`Salvar fixado ${where}`}>
          <Pin />
        </Button>
      </div>
    </div>
  )
}

/** A lixeira, no lugar da lista: restaurar ou apagar de vez. Esvaziada, a lista volta. */
function TrashList({ machine, items, onBack, onChanged }: { machine: string; items: SavedCommandList['trash']; onBack: () => void; onChanged: () => void }) {
  const run = (p: Promise<unknown>) => void p.then(onChanged, failed)
  return (
    <>
      <header className="flex h-9 shrink-0 items-center gap-1 px-1">
        <Button variant="ghost" size="icon-xs" onClick={onBack} aria-label="Voltar" title="Voltar">
          <ArrowLeft />
        </Button>
        <h2 className="flex-1 text-xs font-medium">Lixeira</h2>
      </header>
      <div className="tab-panel-in min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {items.map((c) => (
          <div key={c.id} className={ROW} title={`${c.command}\n${c.project ? projectName(c.project) : 'Todo projeto'} · ${relativeTime(c.deletedAt)}`}>
            <span className={cn('min-w-0 flex-1 truncate px-2', !c.label.trim() && 'font-mono text-[11.5px]')}>{nameOf(c)}</span>
            <div className="flex shrink-0 items-center pr-0.5">
              <Button variant="ghost" size="icon-xs" onClick={() => run(api.restoreCommand(machine, c.id))} aria-label="Restaurar" title="Restaurar">
                <RotateCcw />
              </Button>
              <Button variant="ghost" size="icon-xs" onClick={() => run(api.purgeCommand(machine, c.id))} aria-label="Apagar de vez" title="Apagar de vez" className="hover:text-destructive">
                <Trash2 />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// Os campos: sem borda, um tom acima da janela, como a busca das listas do app (o mesmo de habilidades-dialog.tsx).
const FIELD = 'w-full rounded-lg bg-foreground/[0.05] px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/70 focus-visible:bg-foreground/[0.07] focus-visible:ring-1 focus-visible:ring-foreground/15'

/**
 * Novo ou editar: o comando, o nome (opcional; sem ele, a linha mostra o comando) e onde vale. Fora de
 * um repositório não há projeto, e só dá para salvar para todos. Enter salva; Shift+Enter quebra a linha.
 */
function CommandForm({
  machine,
  base,
  projectDir,
  draft,
  onDone,
}: {
  machine: string
  /** A pasta da aba, de onde o PC tira o projeto de um comando novo. */
  base: string
  projectDir: string | null
  draft: Draft
  onDone: (changed: boolean) => void
}) {
  const [d, setD] = useState(draft)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }))
  const ready = d.command.trim().length > 0
  // O projeto do "Só em": o do comando, ao editar um de projeto; senão, o da aba. Sem nenhum, só global.
  const where = d.project ?? projectDir
  const scope = where ? d.scope : 'global'

  async function save() {
    if (!ready || busy) return
    setBusy(true)
    try {
      await api.saveCommand(machine, {
        id: d.id,
        label: d.label.trim(),
        command: d.command.trim(),
        project: scope === 'project' ? (d.project ?? base) : null,
        pinned: d.pinned,
      })
      toast.success('Salvo')
      onDone(true)
    } catch (err) {
      failed(err)
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{d.id ? 'Editar comando' : 'Novo comando'}</DialogTitle>
        <DialogDescription className="sr-only">Um comando do terminal, para rodar com um toque na barra de salvos.</DialogDescription>
      </DialogHeader>
      <form
        id="saved-command"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label className="block space-y-2">
          <span className="block px-1 text-xs font-medium text-muted-foreground">Comando</span>
          <textarea
            value={d.command}
            onChange={(e) => set({ command: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void save()
              }
            }}
            placeholder="pnpm dev"
            rows={1}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={cn(FIELD, 'max-h-40 resize-none font-mono text-[12.5px] leading-relaxed [field-sizing:content]')}
          />
        </label>
        <label className="block space-y-2">
          <span className="block px-1 text-xs font-medium text-muted-foreground">Nome</span>
          <input value={d.label} onChange={(e) => set({ label: e.target.value })} placeholder="Opcional" maxLength={60} className={cn(FIELD, 'h-9')} />
        </label>
        <div className="space-y-2">
          <span className="block px-1 text-xs font-medium text-muted-foreground">Onde vale</span>
          <Segmented
            value={scope}
            onChange={(scope) => set({ scope })}
            options={[...(where ? [{ key: 'project' as const, label: `Só em ${projectName(where)}` }] : []), { key: 'global' as const, label: 'Todo projeto' }]}
          />
        </div>
      </form>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onDone(false)}>
          Cancelar
        </Button>
        <Button type="submit" form="saved-command" disabled={!ready || busy}>
          {busy && <Loader2 className="animate-spin" />} Salvar
        </Button>
      </DialogFooter>
    </>
  )
}
