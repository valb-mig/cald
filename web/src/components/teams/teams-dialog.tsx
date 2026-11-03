import { ArrowLeft, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Claudinho } from '@/components/claudinho'
import { ModelPill, useModels } from '@/components/chat/composer-controls'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from '@/lib/api'
import type { Effort, Team, TeamInput } from '@/lib/types'
import { memberSeed, newMember, ROLES } from './model'
import { TeamFaces } from './team-faces'

type Draft = { id?: string; name: string; members: (TeamInput['members'][number] & { id: string })[] }

const failed = (err: unknown) => toast.error(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err))

/** Um membro no editor: o claudinho, nome, papel, modelo e esforço, e as instruções. */
function MemberCard({
  member,
  onChange,
  onRemove,
}: {
  member: Draft['members'][number]
  onChange: (patch: Partial<Draft['members'][number]>) => void
  onRemove: () => void
}) {
  const models = useModels()
  return (
    <li className="space-y-2 rounded-xl border p-3">
      <div className="flex items-center gap-2">
        <Claudinho seed={memberSeed(member)} size={30} />
        <Input value={member.name} onChange={(e) => onChange({ name: e.target.value })} maxLength={40} placeholder="Nome" aria-label="Nome" className="h-8 min-w-0 flex-1" />
        <Input value={member.role} onChange={(e) => onChange({ role: e.target.value })} maxLength={60} placeholder="Papel" aria-label="Papel" className="h-8 w-28 min-w-0 sm:w-36" />
        <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label={`Tirar ${member.name || 'o membro'} do time`} title="Tirar do time">
          <X />
        </Button>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Modelo</span>
        {/* Sem modelo, ele usa o da conversa ("Padrão"). */}
        <ModelPill models={models} settings={{ model: member.model, effort: member.effort }} onChange={(patch) => onChange({ ...('model' in patch ? { model: patch.model } : {}), ...('effort' in patch ? { effort: patch.effort as Effort } : {}) })} />
      </div>
      <Textarea
        value={member.instructions}
        onChange={(e) => onChange({ instructions: e.target.value })}
        rows={3}
        maxLength={8000}
        placeholder="O que ele faz, como trabalha e o que deve evitar."
        aria-label="Instruções"
        className="min-h-16 text-sm"
      />
    </li>
  )
}

function Editor({ machine, initial, onBack, onSaved }: { machine: string; initial: Draft; onBack: () => void; onSaved: (team: Team) => void }) {
  const [draft, setDraft] = useState<Draft>(initial)
  const [busy, setBusy] = useState(false)
  const patch = (id: string, p: Partial<Draft['members'][number]>) =>
    setDraft((d) => ({ ...d, members: d.members.map((m) => (m.id === id ? { ...m, ...p } : m)) }))

  const save = async () => {
    setBusy(true)
    try {
      onSaved(await api.saveTeam(machine, draft))
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Voltar aos times" className="-ml-2">
            <ArrowLeft />
          </Button>
          <DialogTitle>{initial.id ? 'Editar time' : 'Novo time'}</DialogTitle>
        </div>
        <DialogDescription>Cada membro vira um subagente da conversa, com o modelo, o esforço e as instruções dele.</DialogDescription>
      </DialogHeader>
      <form
        id="team-editor"
        className="min-w-0 space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} maxLength={60} placeholder="Nome do time" aria-label="Nome do time" autoFocus={!initial.id} />
        <ul className="max-h-[50dvh] space-y-2 overflow-y-auto">
          {draft.members.map((m) => (
            <MemberCard key={m.id} member={m} onChange={(p) => patch(m.id, p)} onRemove={() => setDraft((d) => ({ ...d, members: d.members.filter((x) => x.id !== m.id) }))} />
          ))}
        </ul>
        {draft.members.length < 8 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                <Plus /> Membro
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Começar como</DropdownMenuLabel>
              {ROLES.map((r) => (
                <DropdownMenuItem key={r.role} onSelect={() => setDraft((d) => ({ ...d, members: [...d.members, newMember(r)] }))}>
                  {r.role}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onSelect={() => setDraft((d) => ({ ...d, members: [...d.members, { ...newMember(), role: '', instructions: '' }] }))}>
                Em branco
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </form>
      <DialogFooter>
        <Button type="submit" form="team-editor" disabled={busy || !draft.name.trim() || draft.members.some((m) => !m.name.trim())}>
          {busy && <Loader2 className="animate-spin" />} Salvar
        </Button>
      </DialogFooter>
    </>
  )
}

function TeamList({
  teams,
  onEdit,
  onNew,
  onDelete,
}: {
  teams: Team[] | null
  onEdit: (team: Team) => void
  onNew: () => void
  onDelete: (team: Team) => void
}) {
  const [confirming, setConfirming] = useState<string | null>(null)
  return (
    <>
      <DialogHeader>
        <DialogTitle>Times de agentes</DialogTitle>
        <DialogDescription>Subagentes seus, cada um com o modelo e o esforço dele. A conversa nova escolhe um time, e o Claude dela delega aos membros.</DialogDescription>
      </DialogHeader>
      {teams === null ? (
        <div className="flex justify-center py-6 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : teams.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">Nenhum time ainda. Monte um com, por exemplo, alguém de frontend e alguém que roda os testes.</p>
      ) : (
        <ul className="-mx-2 space-y-0.5">
          {teams.map((t) => (
            <li key={t.id} className="flex min-w-0 items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-foreground/[0.04]">
              <button type="button" onClick={() => onEdit(t)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                <TeamFaces team={t} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{t.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{t.members.map((m) => (m.role ? `${m.name} (${m.role})` : m.name)).join(', ') || 'Sem membros'}</span>
                </span>
              </button>
              {confirming === t.id ? (
                <Button variant="destructive" size="xs" onClick={() => onDelete(t)}>
                  Apagar
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="icon-sm" onClick={() => onEdit(t)} aria-label={`Editar ${t.name}`}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setConfirming(t.id)} aria-label={`Apagar ${t.name}`}>
                    <Trash2 />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <DialogFooter>
        <Button onClick={onNew}>
          <Plus /> Novo time
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * Criar, editar e apagar os times de agentes da máquina. Apagar ou editar não muda as conversas que já
 * usam o time: cada uma guarda o dela. `onSaved` avisa qual time acabou de ser salvo.
 */
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
  const [teams, setTeams] = useState<Team[] | null>(null)
  const [editing, setEditing] = useState<Draft | null>(null)

  useEffect(() => {
    if (!open) return
    api.teams(machine).then(setTeams, (err) => {
      setTeams([])
      failed(err)
    })
  }, [open, machine])

  const update = (next: Team[]) => {
    setTeams(next)
    onChange?.(next)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Fechou no meio da edição: na próxima vez abre na lista.
        if (!o) setEditing(null)
        onOpenChange(o)
      }}
    >
      <DialogContent className="min-w-0 sm:max-w-lg">
        {editing ? (
          <Editor
            key={editing.id ?? 'novo'}
            machine={machine}
            initial={editing}
            onBack={() => setEditing(null)}
            onSaved={(team) => {
              update([...(teams ?? []).filter((t) => t.id !== team.id), team].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')))
              onSaved?.(team)
              setEditing(null)
            }}
          />
        ) : (
          <TeamList
            teams={teams}
            onNew={() => setEditing({ name: '', members: [newMember(ROLES[0]), newMember(ROLES[2])] })}
            onEdit={(t) => setEditing({ id: t.id, name: t.name, members: t.members.map(({ key: _key, ...m }) => m) })}
            onDelete={(t) => {
              api.deleteTeam(machine, t.id).then(() => update((teams ?? []).filter((x) => x.id !== t.id)), failed)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
