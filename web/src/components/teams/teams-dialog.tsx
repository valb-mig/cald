import { ChevronDown, ChevronRight, Loader2, Pencil, Plus, RotateCcw, Trash2, UserMinus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { UndoBar } from '@/components/claude/bits'
import { Claudinho } from '@/components/claudinho'
import { EFFORTS, ModelPill, prettyModel, useModels } from '@/components/chat/composer-controls'
import { FIELD, ISLAND, ISLAND_WIDE, NAV_ITEM, WINDOW, WindowHeader } from '@/components/island'
import { Group } from '@/components/settings-ui'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from '@/lib/api'
import { useOnChanged } from '@/lib/changes'
import { relativeTime } from '@/lib/format'
import { useMediaQuery } from '@/lib/hooks'
import type { Effort, Team, TeamInput, TeamMember, TrashedTeam } from '@/lib/types'
import { cn } from '@/lib/utils'
import { memberSeed, newMember, ROLES } from './model'
import { TeamFaces } from './team-faces'

/**
 * Os times de agentes da máquina (ver server/src/teams.ts), desenhados como as habilidades: uma ilha
 * com os times à esquerda e o escolhido numa janela à direita, com os membros e o editor. No celular,
 * a lista e a janela se revezam. Apagar manda para a lixeira; editar ou apagar não muda as conversas
 * que já usam o time, porque cada uma guarda o dela.
 */

type Member = TeamInput['members'][number] & { id: string }
type Draft = { id?: string; name: string; members: Member[] }
/** O que a janela mostra: um time, o editor (com um membro aberto, se veio de um toque nele) ou a lixeira. */
type View = { kind: 'show'; id: string } | { kind: 'edit'; draft: Draft; open?: string } | { kind: 'trash' }

const MAX_MEMBERS = 8

const failed = (err: unknown) => toast.error(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err))
const byName = (a: Team, b: Team) => a.name.localeCompare(b.name, 'pt-BR')
const draftOf = (t: Team): Draft => ({ id: t.id, name: t.name, members: t.members.map(({ key: _key, ...m }) => m) })
const fresh = (): Draft => ({ name: '', members: [newMember(ROLES[0]), newMember(ROLES[2])] })
/** "Haiku 5.5 · Baixo"; sem modelo nem esforço, nada: ele usa os da conversa. */
const specOf = (m: Pick<TeamMember, 'model' | 'effort'>) => [m.model && prettyModel(m.model), m.effort && EFFORTS[m.effort]].filter(Boolean).join(' · ')

const LABEL = 'block px-1 text-xs font-medium text-muted-foreground'
// Uma linha de membro dentro do bloco, com o alvo de toque do celular.
const ROW = 'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-foreground/[0.04]'
// O modelo no canto da linha; longo ("Sonnet 4.5 · 1M · Muito alto"), corta antes do nome no celular.
const SPEC = 'max-w-[40%] shrink-0 truncate text-xs text-muted-foreground'

/** `onSaved` avisa qual time acabou de ser salvo; `onChange`, a lista depois de salvar, apagar ou restaurar. */
export function TeamsDialog({
  machine,
  open,
  onOpenChange,
  onChange,
  onSaved,
}: {
  machine: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange?: (teams: Team[]) => void
  onSaved?: (team: Team) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className={ISLAND}>
        <DialogTitle className="sr-only">Times de agentes</DialogTitle>
        <DialogDescription className="sr-only">Cada membro vira um subagente da conversa, com o modelo, o esforço e as instruções dele.</DialogDescription>
        {/* Monta a cada abertura: fechou no meio da edição, na próxima abre na lista. */}
        {open && <Body key={machine} machine={machine} onChange={onChange} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  )
}

function Body({ machine, onChange, onSaved }: { machine: string; onChange?: (teams: Team[]) => void; onSaved?: (team: Team) => void }) {
  const wide = useMediaQuery(ISLAND_WIDE)
  const [teams, setTeams] = useState<Team[]>()
  // `null`: o PC roda um servidor de antes da lixeira, e apagar lá é de vez.
  const [trash, setTrash] = useState<TrashedTeam[] | null>([])
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View | null>(null)
  // O "Desfazer" fica dentro do modal: um aviso fica por baixo dele e não dá para tocar.
  const [undo, setUndo] = useState<Team | null>(null)

  const load = useCallback(() => {
    api.teams(machine).then(
      (list) => {
        setTeams(list)
        setError(null)
      },
      (err) => setError(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err)),
    )
    api.teamTrash(machine).then(setTrash, (err) => setTrash(isOutdatedServer(err) ? null : []))
  }, [machine])
  useEffect(load, [load])
  // O Claude de uma conversa montou ou mudou um time (o MCP do cald), ou outro aparelho mexeu. Quem
  // está no editor fica como está: o rascunho é dele.
  useOnChanged(machine, 'teams', load)
  useEffect(() => {
    if (!undo) return
    const timer = setTimeout(() => setUndo(null), 6000)
    return () => clearTimeout(timer)
  }, [undo])

  const list = teams ?? []
  const update = (next: Team[]) => {
    setTeams(next)
    onChange?.(next)
  }
  // Apagado em outro aparelho enquanto aberto: volta para a lista.
  const picked = view?.kind === 'show' && !list.some((t) => t.id === view.id) ? null : view
  // No PC, a janela nunca fica vazia: abre no primeiro time.
  const shown: View | null = picked ?? (wide && list[0] ? { kind: 'show', id: list[0].id } : null)
  const current = shown?.kind === 'show' ? list.find((t) => t.id === shown.id) : undefined
  const focused = current?.id ?? (shown?.kind === 'edit' ? shown.draft.id : undefined)
  const showNav = wide || !shown
  const showWindow = wide || Boolean(shown)
  const startNew = () => setView({ kind: 'edit', draft: fresh() })
  const undoBar = undo && (
    <div className="absolute inset-x-4 bottom-4">
      <UndoBar
        text={`${undo.name} foi para a lixeira`}
        onUndo={() => {
          setUndo(null)
          void restore(undo.id)
        }}
      />
    </div>
  )

  async function toTrash(team: Team) {
    try {
      await api.deleteTeam(machine, team.id)
      update(list.filter((t) => t.id !== team.id))
      setView(null)
      if (trash) setUndo(team)
      load()
    } catch (err) {
      failed(err)
    }
  }

  async function restore(id: string) {
    try {
      const team = await api.restoreTeam(machine, id)
      update([...list.filter((t) => t.id !== team.id), team].sort(byName))
      setView({ kind: 'show', id: team.id })
      load()
    } catch (err) {
      failed(err)
    }
  }

  return (
    <>
      {showNav && (
        <nav className="flex min-h-0 shrink-0 flex-col gap-1 p-3 sm:w-60">
          <div className="flex items-center gap-1 px-2 pt-1 pb-2">
            <h2 className="flex-1 text-sm font-medium">Times</h2>
            <Button variant="ghost" size="icon-sm" onClick={startNew} aria-label="Novo time" title="Novo time">
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
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {error && <p className="px-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
            {!teams && !error && <Loader2 className="mx-auto my-6 size-4 animate-spin text-muted-foreground" />}
            {teams?.length === 0 && (wide ? <p className="px-2.5 text-xs text-muted-foreground/70">Nenhum ainda</p> : <Intro onNew={startNew} />)}
            {list.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={focused === t.id ? 'page' : undefined}
                onClick={() => setView({ kind: 'show', id: t.id })}
                className={NAV_ITEM}
              >
                <TeamFaces team={t} size={16} max={3} placeholder />
                <span className="min-w-0 flex-1 truncate text-left">{t.name}</span>
              </button>
            ))}
          </div>
          {trash && trash.length > 0 && (
            <button type="button" aria-current={shown?.kind === 'trash' ? 'page' : undefined} onClick={() => setView({ kind: 'trash' })} className={NAV_ITEM}>
              <Trash2 />
              <span className="flex-1 text-left">Lixeira</span>
              <span className="text-xs text-muted-foreground tabular-nums">{trash.length}</span>
            </button>
          )}
        </nav>
      )}

      {showWindow && (
        <div className={WINDOW}>
          {shown?.kind === 'edit' ? (
            <Editor
              key={shown.draft.id ?? 'novo'}
              machine={machine}
              draft={shown.draft}
              open={shown.open}
              onCancel={() => setView(shown.draft.id ? { kind: 'show', id: shown.draft.id } : null)}
              onSaved={(team) => {
                update([...list.filter((t) => t.id !== team.id), team].sort(byName))
                onSaved?.(team)
                setView({ kind: 'show', id: team.id })
              }}
            />
          ) : shown?.kind === 'trash' ? (
            <TrashView items={trash ?? []} onBack={() => setView(null)} onRestore={(id) => void restore(id)} onPurge={(id) => void api.purgeTeam(machine, id).then(load, failed)} />
          ) : current ? (
            <Detail
              key={current.id}
              team={current}
              canUndo={trash !== null}
              onEdit={(member) => setView({ kind: 'edit', draft: draftOf(current), open: member })}
              onAdd={(m) => {
                const draft = draftOf(current)
                setView({ kind: 'edit', draft: { ...draft, members: [...draft.members, m] }, open: m.id })
              }}
              onTrash={() => void toTrash(current)}
              onBack={() => setView(null)}
            />
          ) : (
            teams && <Intro onNew={startNew} />
          )}
          {undoBar}
        </div>
      )}
      {/* No celular, apagar volta para a lista, sem a janela: a barra fica no pé da ilha. */}
      {!showWindow && undoBar}
    </>
  )
}

/** Nenhum time ainda: o que é um, e montar o primeiro. */
function Intro({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 py-10 text-center">
      <span className="flex">
        {['a', 'b', 'c'].map((s, i) => (
          <Claudinho key={s} seed={`time:exemplo-${s}`} size={32} className={i > 0 ? '-ml-2' : undefined} />
        ))}
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium">Times de agentes</p>
        <p className="max-w-sm text-xs text-muted-foreground">Subagentes seus, cada um com modelo, esforço e instruções. A conversa escolhe um time e delega a ele.</p>
      </div>
      <Button size="sm" onClick={onNew}>
        <Plus /> Novo time
      </Button>
    </div>
  )
}

/**
 * O time escolhido: os membros, cada um com o modelo dele. Tocar num membro abre o editor nele. Sem
 * ninguém, a janela é a de vazio, com pôr o primeiro (já aberto no editor) como a ação.
 */
function Detail({
  team,
  canUndo,
  onEdit,
  onAdd,
  onTrash,
  onBack,
}: {
  team: Team
  /** Sem lixeira no PC (servidor antigo), apagar é de vez e pede confirmação. */
  canUndo: boolean
  onEdit: (member?: string) => void
  onAdd: (member: Member) => void
  onTrash: () => void
  onBack: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const n = team.members.length
  const when = relativeTime(team.updatedAt)
  return (
    <>
      {/* Sem membros, quem diz é o corpo da janela: o subtítulo fica só com a data. */}
      <WindowHeader title={team.name} subtitle={n ? `${n === 1 ? '1 membro' : `${n} membros`} · editado ${when}` : `Editado ${when}`} onBack={onBack}>
        <Button variant="ghost" size="icon-sm" onClick={() => onEdit()} aria-label="Editar" title="Editar" className="-mt-1">
          <Pencil />
        </Button>
        {confirming ? (
          <Button variant="destructive" size="xs" onClick={onTrash} className="-mt-0.5">
            Apagar de vez
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={canUndo ? onTrash : () => setConfirming(true)}
            aria-label={canUndo ? 'Para a lixeira' : 'Apagar'}
            title={canUndo ? 'Para a lixeira' : 'Apagar'}
            className="-mt-1 hover:text-destructive"
          >
            <Trash2 />
          </Button>
        )}
      </WindowHeader>
      {n ? (
        <div className="tab-panel-in min-h-0 flex-1 overflow-y-auto px-6 pb-6 max-sm:px-4">
          <Group title="Membros">
            {team.members.map((m) => (
              <button key={m.id} type="button" onClick={() => onEdit(m.id)} className={ROW}>
                <Claudinho seed={memberSeed(m)} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{m.name}</span>
                  {m.role && <span className="block truncate text-xs text-muted-foreground">{m.role}</span>}
                </span>
                <span className={SPEC}>{specOf(m)}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </Group>
        </div>
      ) : (
        // O lugar tracejado é o mesmo da lista, maior; o botão já abre a escolha do papel.
        <div className="tab-panel-in flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-16 text-center">
          <TeamFaces team={team} size={32} placeholder />
          <p className="text-sm text-muted-foreground">Ninguém no time ainda</p>
          <AddMember onAdd={onAdd} align="center">
            <Button size="sm">
              <Plus /> Pôr alguém
            </Button>
          </AddMember>
        </div>
      )}
    </>
  )
}

function Editor({ machine, draft, open, onCancel, onSaved }: { machine: string; draft: Draft; open?: string; onCancel: () => void; onSaved: (team: Team) => void }) {
  const [d, setD] = useState(draft)
  // Um membro aberto por vez: os outros ficam numa linha, para o time caber na tela.
  const [expanded, setExpanded] = useState<string | null>(open ?? null)
  const [busy, setBusy] = useState(false)
  const patch = (id: string, p: Partial<Member>) => setD((x) => ({ ...x, members: x.members.map((m) => (m.id === id ? { ...m, ...p } : m)) }))
  const add = (m: Member) => {
    setD((x) => ({ ...x, members: [...x.members, m] }))
    setExpanded(m.id)
  }
  const ready = d.name.trim().length > 0 && d.members.every((m) => m.name.trim())

  async function save() {
    setBusy(true)
    try {
      onSaved(await api.saveTeam(machine, d))
    } catch (err) {
      failed(err)
      setBusy(false)
    }
  }

  return (
    <>
      <WindowHeader title={d.id ? 'Editar time' : 'Novo time'} subtitle="Cada membro vira um subagente da conversa." onBack={onCancel}>
        <Button variant="ghost" size="sm" onClick={onCancel} className="-mt-1 max-sm:hidden">
          Cancelar
        </Button>
        <Button type="submit" form="team-editor" size="sm" disabled={!ready || busy} className="-mt-1">
          {busy && <Loader2 className="animate-spin" />} Salvar
        </Button>
      </WindowHeader>
      <form
        id="team-editor"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready && !busy) void save()
        }}
        className="tab-panel-in min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6 max-sm:px-4"
      >
        <label className="block space-y-2">
          <span className={LABEL}>Nome</span>
          <input
            value={d.name}
            onChange={(e) => setD((x) => ({ ...x, name: e.target.value }))}
            maxLength={60}
            placeholder="Frontend e testes"
            autoFocus={!d.id}
            className={cn(FIELD, 'h-9 py-0')}
          />
        </label>
        <Group title="Membros">
          {d.members.map((m) => (
            <MemberItem
              key={m.id}
              member={m}
              open={expanded === m.id}
              onToggle={() => setExpanded((e) => (e === m.id ? null : m.id))}
              onChange={(p) => patch(m.id, p)}
              onRemove={() => setD((x) => ({ ...x, members: x.members.filter((y) => y.id !== m.id) }))}
            />
          ))}
          {d.members.length < MAX_MEMBERS && <AddMember onAdd={add} />}
        </Group>
      </form>
    </>
  )
}

/** Um membro no editor: fechado, uma linha com o claudinho, o nome, o papel e o modelo; aberto, os campos dele. */
function MemberItem({
  member: m,
  open,
  onToggle,
  onChange,
  onRemove,
}: {
  member: Member
  open: boolean
  onToggle: () => void
  onChange: (patch: Partial<Member>) => void
  onRemove: () => void
}) {
  const models = useModels()
  const ref = useRef<HTMLDivElement>(null)
  // Aberto (por um toque na lista do time, ou recém-criado no fim) sem os campos à vista: sobe para o alto.
  useEffect(() => {
    const item = ref.current
    const area = item?.closest('form')?.getBoundingClientRect()
    if (!open || !item || !area) return
    const top = item.getBoundingClientRect().top
    if (top < area.top || top > area.bottom - 160) item.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [open])
  return (
    <div ref={ref} className="scroll-my-4">
      <button type="button" onClick={onToggle} aria-expanded={open} className={ROW}>
        <Claudinho seed={memberSeed(m)} size={32} />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-sm', !m.name.trim() && 'text-muted-foreground')}>{m.name.trim() || 'Sem nome'}</span>
          {m.role && <span className="block truncate text-xs text-muted-foreground">{m.role}</span>}
        </span>
        {!open && <span className={SPEC}>{specOf(m)}</span>}
        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-3 px-3 pt-1 pb-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className={LABEL}>Nome</span>
              <input value={m.name} onChange={(e) => onChange({ name: e.target.value })} maxLength={40} placeholder="Thor" className={cn(FIELD, 'h-9 py-0')} />
            </label>
            <label className="block space-y-1.5">
              <span className={LABEL}>Papel</span>
              <input value={m.role} onChange={(e) => onChange({ role: e.target.value })} maxLength={60} placeholder="Frontend" className={cn(FIELD, 'h-9 py-0')} />
            </label>
          </div>
          <div className="flex items-center gap-1">
            <span className={LABEL}>Modelo</span>
            {/* Sem modelo, ele usa o da conversa ("Padrão"). */}
            <ModelPill
              models={models}
              settings={{ model: m.model, effort: m.effort }}
              onChange={(p) => onChange({ ...('model' in p ? { model: p.model } : {}), ...('effort' in p ? { effort: p.effort as Effort } : {}) })}
            />
            <Button type="button" variant="ghost" size="xs" onClick={onRemove} className="ml-auto text-muted-foreground hover:text-destructive">
              <UserMinus /> Tirar do time
            </Button>
          </div>
          <label className="block space-y-1.5">
            <span className={LABEL}>Instruções · Markdown</span>
            <textarea
              value={m.instructions}
              onChange={(e) => onChange({ instructions: e.target.value })}
              maxLength={8000}
              placeholder="O que ele faz, como trabalha e o que deve evitar."
              spellCheck={false}
              className={cn(FIELD, 'max-h-[50dvh] min-h-32 resize-none font-mono text-[12.5px] leading-relaxed [field-sizing:content]')}
            />
          </label>
        </div>
      )}
    </div>
  )
}

/**
 * Pôr um membro, começando por um dos papéis prontos ou em branco. Sem `children`, é a última linha do
 * bloco de membros do editor; com, o botão que abre a escolha (o do time vazio).
 */
function AddMember({ onAdd, align = 'start', children }: { onAdd: (m: Member) => void; align?: 'start' | 'center'; children?: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {children ?? (
          <button type="button" className={cn(ROW, 'text-sm text-muted-foreground hover:text-foreground')}>
            <span className="flex size-8 shrink-0 items-center justify-center">
              <Plus className="size-4" />
            </span>
            Membro
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        <DropdownMenuLabel>Começar como</DropdownMenuLabel>
        {ROLES.map((r) => (
          <DropdownMenuItem key={r.role} onSelect={() => onAdd(newMember(r))}>
            {r.role}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => onAdd({ ...newMember(), role: '', instructions: '' })}>Em branco</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function TrashView({ items, onBack, onRestore, onPurge }: { items: TrashedTeam[]; onBack: () => void; onRestore: (id: string) => void; onPurge: (id: string) => void }) {
  return (
    <>
      <WindowHeader title="Lixeira" subtitle="O que fica mais de 30 dias aqui some sozinho." onBack={onBack} />
      <div className="tab-panel-in min-h-0 flex-1 overflow-y-auto px-6 pb-6 max-sm:px-4">
        {items.length ? (
          <Group>
            {items.map((t) => (
              <div key={t.id} className="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2">
                <TeamFaces team={t} size={20} max={3} placeholder />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{t.name}</div>
                  <div className="text-xs text-muted-foreground">{relativeTime(t.deletedAt)}</div>
                </div>
                <Button variant="ghost" size="xs" onClick={() => onRestore(t.id)}>
                  <RotateCcw /> Restaurar
                </Button>
                <Button variant="ghost" size="icon-xs" onClick={() => onPurge(t.id)} aria-label={`Apagar ${t.name} de vez`} title="Apagar de vez" className="hover:text-destructive">
                  <X />
                </Button>
              </div>
            ))}
          </Group>
        ) : (
          <p className="px-1 text-sm text-muted-foreground">Vazia.</p>
        )}
      </div>
    </>
  )
}
