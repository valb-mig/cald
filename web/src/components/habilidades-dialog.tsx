import { ArrowLeft, Loader2, Pencil, Plus, RotateCcw, Trash2, WandSparkles, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { UndoBar } from '@/components/claude/bits'
import { forgetCommands } from '@/components/chat/prompt-input'
import { Markdown } from '@/components/markdown'
import { Group, Segmented, SettingRow } from '@/components/settings-ui'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { api, errorMessage } from '@/lib/api'
import { projectName, relativeTime } from '@/lib/format'
import { useMediaQuery } from '@/lib/hooks'
import { useProjectPanel } from '@/lib/project-panel'
import { useStore } from '@/lib/store'
import type { Habilidade, HabilidadeList } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * As habilidades do cald (ver server/src/habilidades.ts): skills do próprio cald, globais ou do
 * projeto, que o Claude vê nas conversas do painel como `/cald:nome` e carrega pela descrição. Abre
 * pelo botão do pé da alça da direita, com o projeto e a conversa em foco.
 *
 * Desenhado como o painel Computador: uma ilha na cor da casca, com a lista à esquerda (as deste
 * projeto, as globais e a lixeira) e a escolhida numa janela à direita, com o liga e desliga nesta
 * conversa, o que ela diz e o editor. No celular, a lista e a janela se revezam.
 */

export const useHabilidadesDialog = create<{ open: boolean }>(() => ({ open: false }))
export const openHabilidades = () => useHabilidadesDialog.setState({ open: true })

type Draft = { id?: string; name: string; description: string; body: string; scope: 'project' | 'global' }
/** O que a janela mostra: uma habilidade, o editor (nova ou editando) ou a lixeira. */
type View = { kind: 'show'; id: string } | { kind: 'edit'; draft: Draft } | { kind: 'trash' }

/** O nome como o Claude chama: minúsculas, números e hífen, sem acento. */
const slug = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 50)

// Os campos do editor: sem borda, um tom acima da janela, como a busca das listas do app.
const FIELD = 'w-full rounded-lg bg-foreground/[0.05] px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/70 focus-visible:bg-foreground/[0.07] focus-visible:ring-1 focus-visible:ring-foreground/15'

export function HabilidadesDialog() {
  const open = useHabilidadesDialog((s) => s.open)
  const project = useProjectPanel((s) => s.project)
  return (
    <Dialog open={open} onOpenChange={(o) => useHabilidadesDialog.setState({ open: o })}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(38rem,calc(100dvh-2rem))] w-[min(52rem,calc(100vw-1.5rem))] max-w-none flex-col gap-0 overflow-hidden rounded-island bg-shell p-0 shadow-island ring-0 max-sm:h-[calc(100dvh-6rem)] sm:max-w-none sm:flex-row"
      >
        <DialogTitle className="sr-only">Habilidades do cald</DialogTitle>
        <DialogDescription className="sr-only">As habilidades do cald deste projeto e as globais, com o liga e desliga nesta conversa.</DialogDescription>
        {open && <Body key={`${project?.machine ?? ''}\n${project?.cwd ?? ''}`} machine={project?.machine ?? ''} cwd={project?.cwd} session={project?.chat || undefined} />}
      </DialogContent>
    </Dialog>
  )
}

function Body({ machine, cwd, session }: { machine: string; cwd?: string; session?: string }) {
  const wide = useMediaQuery('(min-width: 40rem)')
  const [list, setList] = useState<HabilidadeList>()
  const [off, setOff] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View | null>(null)
  // O "Desfazer" fica dentro do modal: um aviso fica por baixo dele e não dá para tocar.
  const [undo, setUndo] = useState<Habilidade | null>(null)
  // A conversa em foco: as do PC (terminal, VSCode) não carregam o plugin do cald.
  const entry = useStore((s) => (session ? s.catalog.find((c) => c.sessionId === session) : undefined))

  const load = useCallback(() => {
    api.habilidades(machine, cwd).then(
      (l) => {
        setList(l)
        setError(null)
      },
      (err) => setError(errorMessage(err)),
    )
  }, [machine, cwd])
  useEffect(load, [load])
  useEffect(() => {
    if (session) api.sessionHabilidades(session).then((r) => setOff(r.off), () => {})
  }, [session])
  useEffect(() => {
    if (!undo) return
    const timer = setTimeout(() => setUndo(null), 6000)
    return () => clearTimeout(timer)
  }, [undo])

  const all = list ? [...list.project, ...list.global] : []
  // No PC, a janela nunca fica vazia: abre na primeira habilidade.
  const shown: View | null = view ?? (wide && all[0] ? { kind: 'show', id: all[0].id } : null)
  const current = shown?.kind === 'show' ? all.find((h) => h.id === shown.id) : undefined

  const changed = () => {
    forgetCommands()
    load()
  }

  async function toggle(h: Habilidade, on: boolean) {
    if (!session) return
    setOff((o) => (on ? o.filter((x) => x !== h.id) : [...o, h.id]))
    try {
      setOff((await api.setSessionHabilidade(session, h.id, on)).off)
      forgetCommands()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  async function trash(h: Habilidade) {
    try {
      await api.trashHabilidade(machine, h.id)
      setUndo(h)
      setView(null)
      changed()
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const fresh = (): Draft => ({ name: '', description: '', body: '', scope: cwd ? 'project' : 'global' })
  const projectNames = new Set(list?.project.map((h) => h.name))
  const showNav = wide || !shown
  const showWindow = wide || Boolean(shown)

  return (
    <>
      {showNav && (
        <nav className="flex min-h-0 shrink-0 flex-col gap-1 p-3 sm:w-60">
          <div className="flex items-center gap-1 px-2 pt-1 pb-2">
            <h2 className="flex-1 text-sm font-medium">Habilidades</h2>
            <Button variant="ghost" size="icon-sm" onClick={() => setView({ kind: 'edit', draft: fresh() })} aria-label="Nova habilidade" title="Nova habilidade">
              <Plus />
            </Button>
            {!wide && (
              <DialogClose asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Fechar">
                  <X />
                </Button>
              </DialogClose>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            {error && <p className="px-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
            {!list && !error && <Loader2 className="mx-auto my-6 size-4 animate-spin text-muted-foreground" />}
            {list && cwd && (
              <NavGroup title={`Deste projeto · ${projectName(cwd)}`} empty="Nenhuma ainda">
                {list.project.map((h) => (
                  <NavItem key={h.id} habilidade={h} current={current?.id === h.id} on={!off.includes(h.id)} session={Boolean(session)} onClick={() => setView({ kind: 'show', id: h.id })} />
                ))}
              </NavGroup>
            )}
            {list && (
              <NavGroup title="Globais" empty="Nenhuma ainda">
                {list.global.map((h) => (
                  <NavItem
                    key={h.id}
                    habilidade={h}
                    current={current?.id === h.id}
                    on={!off.includes(h.id)}
                    session={Boolean(session)}
                    shadowed={projectNames.has(h.name)}
                    onClick={() => setView({ kind: 'show', id: h.id })}
                  />
                ))}
              </NavGroup>
            )}
          </div>
          {list && list.trash.length > 0 && (
            <button
              type="button"
              aria-current={shown?.kind === 'trash' ? 'page' : undefined}
              onClick={() => setView({ kind: 'trash' })}
              className={NAV_ITEM}
            >
              <Trash2 />
              <span className="flex-1 text-left">Lixeira</span>
              <span className="text-xs text-muted-foreground tabular-nums">{list.trash.length}</span>
            </button>
          )}
        </nav>
      )}

      {/* A janela, como a do Computador: um tom acima da casca no claro, e mais clara que ela no escuro. */}
      {showWindow && (
        <div className="relative m-gap flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-pane bg-background max-sm:mt-0 sm:ml-0">
          {shown?.kind === 'edit' ? (
            <Editor
              key={shown.draft.id ?? 'nova'}
              machine={machine}
              cwd={cwd}
              draft={shown.draft}
              onCancel={() => setView(shown.draft.id ? { kind: 'show', id: shown.draft.id } : null)}
              onSaved={(h) => {
                changed()
                setView({ kind: 'show', id: h.id })
              }}
            />
          ) : shown?.kind === 'trash' && list ? (
            <TrashView machine={machine} items={list.trash} onBack={() => setView(null)} onChanged={changed} />
          ) : current ? (
            <Detail
              habilidade={current}
              on={!off.includes(current.id)}
              shadowed={current.project === null && projectNames.has(current.name)}
              session={session}
              sessionTitle={entry?.title}
              onPc={entry?.owner === 'pc'}
              onToggle={(on) => void toggle(current, on)}
              onEdit={() => setView({ kind: 'edit', draft: { id: current.id, name: current.name, description: current.description, body: current.body, scope: current.project ? 'project' : 'global' } })}
              onTrash={() => void trash(current)}
              onBack={() => setView(null)}
            />
          ) : (
            list && <Intro onNew={() => setView({ kind: 'edit', draft: fresh() })} />
          )}
          {undo && (
            <div className="absolute inset-x-4 bottom-4">
              <UndoBar
                text={`/cald:${undo.name} foi para a lixeira`}
                onUndo={() => {
                  setUndo(null)
                  void api.restoreHabilidade(machine, undo.id).then(changed, (err) => toast.error(errorMessage(err)))
                }}
              />
            </div>
          )}
        </div>
      )}
    </>
  )
}

const NAV_ITEM =
  'flex h-9 w-full shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-foreground aria-[current=page]:shadow-xs [&_svg]:size-4 [&_svg]:shrink-0'

function NavGroup({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="space-y-0.5">
      <h3 className="truncate px-2.5 pb-1 text-[11px] font-medium text-muted-foreground" title={title}>
        {title}
      </h3>
      {children.length ? children : <p className="px-2.5 text-xs text-muted-foreground/70">{empty}</p>}
    </section>
  )
}

/**
 * Uma habilidade na lista: o nome e, com uma conversa em foco, um ponto que diz se vale nela. A global
 * encoberta por uma do projeto de mesmo nome fica apagada, sem ponto: ali vale a do projeto.
 */
function NavItem({
  habilidade: h,
  current,
  on,
  session,
  shadowed = false,
  onClick,
}: {
  habilidade: Habilidade
  current: boolean
  on: boolean
  session: boolean
  shadowed?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
      className={cn(NAV_ITEM, shadowed && 'opacity-50')}
      title={shadowed ? 'A deste projeto, de mesmo nome, vale aqui' : h.description}
    >
      <span className={cn('min-w-0 flex-1 truncate text-left font-mono text-[12.5px]', shadowed && 'line-through decoration-muted-foreground/60')}>{h.name}</span>
      {session && !shadowed && (
        <span
          aria-label={on ? 'ligada nesta conversa' : 'desligada nesta conversa'}
          className={cn('size-1.5 shrink-0 rounded-full', on ? 'bg-emerald-500' : 'ring-1 ring-muted-foreground/50')}
        />
      )}
    </button>
  )
}

/** A janela sem nada escolhido: o que é uma habilidade, e criar a primeira. */
function Intro({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <WandSparkles className="size-6 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Habilidades do cald</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Skills do próprio cald, deste projeto ou de todos. Nas conversas do painel, o Claude usa uma quando ela serve, ou quando você chama com <code>/cald:nome</code>.
        </p>
      </div>
      <Button size="sm" onClick={onNew}>
        <Plus /> Nova habilidade
      </Button>
    </div>
  )
}

/** O cabeçalho da janela, como o do Computador; no celular, com o voltar para a lista. */
function WindowHeader({ title, subtitle, onBack, children }: { title: React.ReactNode; subtitle?: React.ReactNode; onBack?: () => void; children?: React.ReactNode }) {
  const wide = useMediaQuery('(min-width: 40rem)')
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

function Detail({
  habilidade: h,
  on,
  shadowed,
  session,
  sessionTitle,
  onPc,
  onToggle,
  onEdit,
  onTrash,
  onBack,
}: {
  habilidade: Habilidade
  on: boolean
  /** Uma do projeto tem o mesmo nome: nesta pasta vale a do projeto. */
  shadowed: boolean
  session?: string
  sessionTitle?: string
  onPc: boolean
  onToggle: (on: boolean) => void
  onEdit: () => void
  onTrash: () => void
  onBack: () => void
}) {
  return (
    <>
      <WindowHeader
        title={<span className="font-mono">/cald:{h.name}</span>}
        subtitle={`${h.project ? `Só em ${projectName(h.project)}` : 'Em todo projeto'} · editada ${relativeTime(h.updatedAt)}`}
        onBack={onBack}
      >
        <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="Editar" title="Editar" className="-mt-1">
          <Pencil />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onTrash} aria-label="Para a lixeira" title="Para a lixeira" className="-mt-1 hover:text-destructive">
          <Trash2 />
        </Button>
      </WindowHeader>
      <div className="tab-panel-in min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6 max-sm:px-4">
        <Group>
          {shadowed ? (
            <SettingRow label="Não vale aqui" hint="Este projeto tem uma habilidade com o mesmo nome, e ela ganha desta." />
          ) : session ? (
            <SettingRow
              label="Ligada nesta conversa"
              hint={onPc ? 'Aberta no PC: vale quando ela vier para o painel.' : (sessionTitle ?? 'A conversa em foco')}
              htmlFor="habilidade-on"
            >
              <Switch id="habilidade-on" checked={on} onCheckedChange={onToggle} />
            </SettingRow>
          ) : (
            <SettingRow label="Ligada em toda conversa" hint="Abra uma conversa para desligar só nela." />
          )}
        </Group>
        <Group title="Quando usar">
          <p className="px-3 py-2 text-sm">{h.description}</p>
        </Group>
        <Group title="Instruções">{h.body.trim() ? <Markdown text={h.body} className="px-3 py-2" /> : <p className="px-3 py-2 text-sm text-muted-foreground">Sem instruções.</p>}</Group>
      </div>
    </>
  )
}

function Editor({ machine, cwd, draft, onCancel, onSaved }: { machine: string; cwd?: string; draft: Draft; onCancel: () => void; onSaved: (h: Habilidade) => void }) {
  const [d, setD] = useState(draft)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }))
  const name = d.name.replace(/-+$/, '')
  const ready = name.length > 0 && d.description.trim().length > 0

  async function save() {
    setBusy(true)
    try {
      const saved = await api.saveHabilidade(machine, { id: d.id, name, description: d.description, body: d.body, project: d.scope === 'project' && cwd ? cwd : null })
      toast.success(d.id ? 'Habilidade salva' : `/cald:${saved.name} criada`)
      onSaved(saved)
    } catch (err) {
      toast.error(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <>
      <WindowHeader title={d.id ? 'Editar habilidade' : 'Nova habilidade'} subtitle="O Claude decide usar pela descrição; o nome é o atalho no chat." onBack={onCancel}>
        <Button variant="ghost" size="sm" onClick={onCancel} className="-mt-1 max-sm:hidden">
          Cancelar
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={!ready || busy} className="-mt-1">
          {busy && <Loader2 className="animate-spin" />} Salvar
        </Button>
      </WindowHeader>
      <div className="tab-panel-in flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6 max-sm:px-4">
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block space-y-2">
            <span className="block px-1 text-xs font-medium text-muted-foreground">Nome</span>
            <span className={cn(FIELD, 'flex h-9 items-center gap-0 py-0 font-mono focus-within:bg-foreground/[0.07] focus-within:ring-1 focus-within:ring-foreground/15')}>
              <span className="shrink-0 text-muted-foreground">/cald:</span>
              <input
                value={d.name}
                onChange={(e) => set({ name: slug(e.target.value) })}
                placeholder="revisar-pr"
                autoFocus={!d.id}
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/50"
              />
            </span>
          </label>
          {cwd && (
            <div className="space-y-2">
              <span className="block px-1 text-xs font-medium text-muted-foreground">Onde vale</span>
              <Segmented
                value={d.scope}
                onChange={(scope) => set({ scope })}
                options={[
                  { key: 'project', label: `Só em ${projectName(cwd)}` },
                  { key: 'global', label: 'Todo projeto' },
                ]}
              />
            </div>
          )}
        </div>
        <label className="block space-y-2">
          <span className="block px-1 text-xs font-medium text-muted-foreground">Quando usar</span>
          <textarea
            value={d.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="Use quando o usuário pedir para revisar um PR deste projeto."
            rows={2}
            className={cn(FIELD, 'resize-none [field-sizing:content]')}
          />
        </label>
        <label className="flex min-h-56 flex-1 flex-col gap-2">
          <span className="block px-1 text-xs font-medium text-muted-foreground">Instruções · Markdown</span>
          <textarea
            value={d.body}
            onChange={(e) => set({ body: e.target.value })}
            placeholder={'1. O passo a passo\n2. As regras\n3. Um exemplo do que você espera'}
            spellCheck={false}
            className={cn(FIELD, 'min-h-0 flex-1 resize-none font-mono text-[12.5px] leading-relaxed')}
          />
        </label>
      </div>
    </>
  )
}

function TrashView({ machine, items, onBack, onChanged }: { machine: string; items: HabilidadeList['trash']; onBack: () => void; onChanged: () => void }) {
  const run = (p: Promise<unknown>) => p.then(onChanged, (err) => toast.error(errorMessage(err)))
  return (
    <>
      <WindowHeader title="Lixeira" subtitle="O que fica mais de 30 dias aqui some sozinho." onBack={onBack} />
      <div className="tab-panel-in min-h-0 flex-1 overflow-y-auto px-6 pb-6 max-sm:px-4">
        <Group>
          {items.map((t) => (
            <SettingRow key={t.id} label={<span className="font-mono">/cald:{t.name}</span>} hint={`${t.project ? projectName(t.project) : 'Em todo projeto'} · ${relativeTime(t.deletedAt)}`}>
              <Button variant="ghost" size="xs" onClick={() => void run(api.restoreHabilidade(machine, t.id))}>
                <RotateCcw /> Restaurar
              </Button>
              <Button variant="ghost" size="xs" onClick={() => void run(api.purgeHabilidade(machine, t.id))} className="hover:text-destructive">
                Apagar de vez
              </Button>
            </SettingRow>
          ))}
        </Group>
      </div>
    </>
  )
}
