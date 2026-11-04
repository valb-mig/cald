import { History, Loader2, MessageSquareText, Pencil, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useLocation } from 'wouter'
import { Markdown } from '@/components/markdown'
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
import { Checkbox } from '@/components/ui/checkbox'
import { insertInto } from '@/lib/compose'
import { putDraft } from '@/lib/drafts'
import { placeName, relativeTime } from '@/lib/format'
import { newChatUrl, noteSession } from '@/lib/machines'
import { emptyMemoryTrash, restoreMemories, trashMemories, useMemory } from '@/lib/memory'
import type { Memory, MemoryFolder, MemorySignal, TrashedMemory } from '@/lib/types'
import { useUndo } from '@/lib/undo'
import { cn } from '@/lib/utils'
import { Chip, Chips, Fold, SearchField, Tag, UndoBar } from './bits'
import { MemoryEditor } from './memory-editor'

const SIGNALS: { key: MemorySignal; label: string; title: string; tone: 'muted' | 'warn' | 'bad' }[] = [
  { key: 'unindexed', label: 'Fora do índice', title: 'Não está no MEMORY.md: o Claude não chega a ver esta memória.', tone: 'warn' },
  {
    key: 'broken-link',
    label: 'Link sem memória',
    title: 'Cita um [[nome]] que não existe neste projeto. Pode ser de propósito: o Claude marca assim o que vale escrever depois.',
    tone: 'muted',
  },
  { key: 'orphan', label: 'Órfã', title: 'O projeto dela não existe mais no PC.', tone: 'bad' },
  { key: 'stale', label: 'Velha', title: 'Sem mudar há mais de 60 dias.', tone: 'muted' },
]

/** Os tipos com que o Claude Code grava cada memória. */
const TYPES: Record<string, string> = { feedback: 'Jeito de trabalhar', project: 'Projeto', reference: 'Referência', user: 'Sobre você' }

/** O Claude Code só lê as primeiras 200 linhas do índice: perto disso já vale enxugar. */
const INDEX_WARN = 150

const refKey = (folder: string, file: string) => `${folder}/${file}`

// O pedido de revisão que vai para a conversa nova, sem enviar: dá para mudar antes.
const reviewPrompt = (f: MemoryFolder) =>
  [
    `Revise a memória automática ${f.cwd ? 'deste projeto' : 'de um projeto que não existe mais'}, em \`${f.dir}\` (o índice é o MEMORY.md).`,
    '- Junte as memórias que dizem a mesma coisa e encurte as longas.',
    '- Proponha apagar o que já está no código, no git ou num CLAUDE.md, e o que deixou de valer.',
    '- Deixe o MEMORY.md em sincronia com os arquivos.',
    'Antes de mudar qualquer arquivo, me mostre a lista do que vai juntar, encurtar e apagar, e espere o meu ok.',
  ].join('\n')

/**
 * A memória automática do Claude Code: com `cwd`, a de um projeto (a aba Claude da barra); sem, a de
 * todos os projetos da máquina (o painel Computador), um grupo por projeto. Filtra pelo que pede
 * limpeza, apaga uma ou várias para a lixeira do cald e abre a conversa que criou cada uma.
 * `onLeave`: o painel Computador fecha antes de ir para uma conversa.
 */
export function MemoryView({ machine, cwd, onLeave }: { machine: string; cwd?: string; onLeave?: () => void }) {
  const { list, error } = useMemory(machine, cwd)
  const [, navigate] = useLocation()
  const [query, setQuery] = useState('')
  const [signal, setSignal] = useState<MemorySignal | null>(null)
  const [type, setType] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [editing, setEditing] = useState<{ folder: string; memory: Memory } | null>(null)
  // As que acabaram de ir para a lixeira: o Desfazer fica no pé da lista por um tempo.
  const [undo, setUndo] = useUndo()

  const folders = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (list?.folders ?? [])
      .map((f) => ({
        ...f,
        memories: f.memories.filter(
          (m) =>
            (!signal || m.signals.includes(signal)) &&
            (!type || m.type === type) &&
            (!q || [m.name, m.description, m.body, m.file, f.cwd ?? f.folder].some((t) => t.toLowerCase().includes(q))),
        ),
      }))
      .filter((f) => f.memories.length || (!q && !signal && !type && f.missing.length))
  }, [list, query, signal, type])

  // A seleção vale só para o que está à vista: trocar o filtro não apaga junto o que ficou escondido.
  const visible = new Set(folders.flatMap((f) => f.memories.map((m) => refKey(f.folder, m.file))))
  const picked = [...selected].filter((k) => visible.has(k))
  const all = list?.folders.flatMap((f) => f.memories) ?? []
  const counts = Object.fromEntries(SIGNALS.map((s) => [s.key, all.filter((m) => m.signals.includes(s.key)).length]))
  const types = Object.keys(TYPES).filter((t) => all.some((m) => m.type === t))
  const filtering = Boolean(query.trim() || signal || type)

  const toggle = (keys: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s)
      for (const k of keys) {
        if (on) next.add(k)
        else next.delete(k)
      }
      return next
    })
  const trash = async (items: { folder: string; file: string }[]) => {
    const ids = await trashMemories(machine, items)
    if (ids.length) setUndo(ids)
  }
  const removeSelected = () => {
    const items = picked.map((k) => {
      const at = k.indexOf('/')
      return { folder: k.slice(0, at), file: k.slice(at + 1) }
    })
    setSelected(new Set())
    void trash(items)
  }

  const review = async (f: MemoryFolder) => {
    const text = reviewPrompt(f)
    const where = f.cwd ?? undefined
    const draft = `new:${where ?? '~'}`
    if (!insertInto(draft, text)) await putDraft(draft, { text, attachments: [] })
    onLeave?.()
    navigate(newChatUrl(where, machine))
  }
  const openOrigin = (id: string) => {
    noteSession(id, machine)
    onLeave?.()
    navigate(`/s/${id}`)
  }

  if (!list) {
    return error ? (
      <p className="p-4 text-center text-sm text-muted-foreground">{error}</p>
    ) : (
      <div className="flex justify-center p-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const single = cwd !== undefined
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <SearchField value={query} onChange={setQuery} placeholder="Buscar na memória" />
        <Chips>
          {SIGNALS.filter((s) => counts[s.key]).map((s) => (
            <Chip key={s.key} on={signal === s.key} onClick={() => setSignal(signal === s.key ? null : s.key)} label={s.label} count={counts[s.key]} title={s.title} />
          ))}
          {types.length > 1 &&
            types.map((t) => <Chip key={t} on={type === t} onClick={() => setType(type === t ? null : t)} label={TYPES[t]} />)}
        </Chips>
      </div>

      {list.folders.length === 0 ? (
        <p className="px-1 py-4 text-sm text-muted-foreground">
          {single ? 'O Claude ainda não guardou nada sobre este projeto.' : 'O Claude ainda não guardou memória em nenhum projeto.'}
        </p>
      ) : folders.length === 0 ? (
        <p className="px-1 py-4 text-sm text-muted-foreground">Nada com esse filtro.</p>
      ) : (
        <div className="space-y-2">
          {folders.map((f) => (
            <FolderGroup
              key={f.folder}
              folder={f}
              single={single}
              // Com filtro, os grupos abrem: é o que foi achado.
              forceOpen={filtering}
              selected={selected}
              onSelect={toggle}
              onReview={() => void review(f)}
              onEdit={(memory) => setEditing({ folder: f.folder, memory })}
              onRemove={(memory) => void trash([{ folder: f.folder, file: memory.file }])}
              onOrigin={openOrigin}
            />
          ))}
        </div>
      )}

      {list.trash.length > 0 && <Trash machine={machine} items={list.trash} single={single} />}

      {/* A barra da seleção, ou o Desfazer do que acabou de sair, fica no pé da rolagem, por cima da lista. */}
      {picked.length > 0 ? (
        <div className="sticky bottom-0 z-10 -mx-1 flex items-center gap-2 rounded-xl bg-popover/95 p-2 pl-3 shadow-lg ring-1 ring-foreground/10 backdrop-blur">
          <span className="min-w-0 flex-1 text-sm">
            {picked.length} {picked.length === 1 ? 'selecionada' : 'selecionadas'}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Cancelar
          </Button>
          <Button variant="destructive" size="sm" onClick={removeSelected}>
            <Trash2 /> Para a lixeira
          </Button>
        </div>
      ) : (
        undo && (
          <UndoBar
            text={undo.length === 1 ? 'Memória na lixeira' : `${undo.length} memórias na lixeira`}
            onUndo={() => {
              void restoreMemories(machine, undo)
              setUndo(null)
            }}
          />
        )
      )}

      {editing && <MemoryEditor machine={machine} folder={editing.folder} memory={editing.memory} onClose={() => setEditing(null)} />}
    </div>
  )
}

function FolderGroup({
  folder: f,
  single,
  forceOpen,
  selected,
  onSelect,
  onReview,
  onEdit,
  onRemove,
  onOrigin,
}: {
  folder: MemoryFolder
  single: boolean
  forceOpen: boolean
  selected: Set<string>
  onSelect: (keys: string[], on: boolean) => void
  onReview: () => void
  onEdit: (m: Memory) => void
  onRemove: (m: Memory) => void
  onOrigin: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const keys = f.memories.map((m) => refKey(f.folder, m.file))
  const picked = keys.filter((k) => selected.has(k)).length
  const notes = (
    <>
      {f.indexLines !== null && f.indexLines > INDEX_WARN && (
        <Tag tone="warn" title="O Claude Code só lê as primeiras 200 linhas do MEMORY.md.">
          índice com {f.indexLines} linhas
        </Tag>
      )}
      {f.missing.length > 0 && (
        <Tag tone="warn" title={`O MEMORY.md cita ${f.missing.join(', ')}, que não existe.`}>
          {f.missing.length} no índice sem arquivo
        </Tag>
      )}
    </>
  )
  const review = (
    <Button variant="ghost" size="xs" onClick={onReview} title="Abre uma conversa nova com o pedido de revisão, sem enviar">
      <Sparkles /> Revisar com o Claude
    </Button>
  )
  const rows = f.memories.map((m) => (
    <MemoryRow
      key={m.file}
      memory={m}
      selected={selected.has(refKey(f.folder, m.file))}
      onSelect={(on) => onSelect([refKey(f.folder, m.file)], on)}
      onEdit={() => onEdit(m)}
      onRemove={() => onRemove(m)}
      onOrigin={onOrigin}
    />
  ))

  if (single) {
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-1.5 px-1">
          {notes}
          <span className="ml-auto">{review}</span>
        </div>
        <div className="space-y-0.5">{rows}</div>
      </div>
    )
  }
  return (
    <Fold
      open={open || forceOpen}
      onOpenChange={setOpen}
      count={f.memories.length}
      title={
        <span className="flex min-w-0 items-center gap-1.5" title={f.cwd ?? f.dir}>
          <span className={cn('truncate', !f.cwd && 'line-through decoration-muted-foreground/50')}>{f.cwd ? placeName(f.cwd) : f.folder}</span>
          {!f.cwd && <Tag tone="bad">projeto apagado</Tag>}
          {notes}
        </span>
      }
      aside={
        f.memories.length > 0 && (
          <Checkbox
            checked={picked === keys.length ? true : picked ? 'indeterminate' : false}
            onCheckedChange={(on) => onSelect(keys, on === true)}
            aria-label="Selecionar todas deste projeto"
            title="Selecionar todas deste projeto"
            className="mr-2.5"
          />
        )
      }
    >
      {/* Aberto o grupo, o pedido de revisão dele: na lista fechada, repetido em cada projeto, seria ruído. */}
      <div className="flex justify-end px-1">{review}</div>
      {rows}
    </Fold>
  )
}

function MemoryRow({
  memory: m,
  selected,
  onSelect,
  onEdit,
  onRemove,
  onOrigin,
}: {
  memory: Memory
  selected: boolean
  onSelect: (on: boolean) => void
  onEdit: () => void
  onRemove: () => void
  onOrigin: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn('group rounded-xl px-2.5 py-2 transition-colors hover:bg-foreground/[0.04]', (open || selected) && 'bg-foreground/[0.04]')}>
      <div className="flex min-w-0 items-start gap-2.5">
        <Checkbox checked={selected} onCheckedChange={(on) => onSelect(on === true)} aria-label={`Selecionar ${m.name}`} className="mt-0.5" />
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="min-w-0 flex-1 text-left">
          <span className="block text-[13px] leading-snug font-medium break-words">{m.name}</span>
          {m.description && <span className={cn('mt-0.5 block text-xs text-muted-foreground', !open && 'line-clamp-2')}>{m.description}</span>}
          <span className="mt-1 flex flex-wrap items-center gap-1">
            {m.type && <Tag>{TYPES[m.type] ?? m.type}</Tag>}
            {SIGNALS.filter((s) => m.signals.includes(s.key)).map((s) => (
              <Tag key={s.key} tone={s.tone} title={s.title}>
                {s.label}
              </Tag>
            ))}
            <span className="text-[11px] text-muted-foreground" title={new Date(m.modified).toLocaleString('pt-BR')}>
              {relativeTime(m.modified)}
            </span>
          </span>
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2 pl-6.5">
          <Markdown text={m.body} className="text-[13px]" />
          <div className="space-y-0.5 text-xs text-muted-foreground">
            <p className="font-mono break-all">{m.file}</p>
            {m.citedBy.length > 0 && <p>Citada por {m.citedBy.map((f) => f.replace(/\.md$/, '')).join(', ')}</p>}
            {m.brokenLinks.length > 0 && <p>Sem memória para {m.brokenLinks.map((l) => `[[${l}]]`).join(', ')}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button variant="ghost" size="xs" onClick={onEdit}>
              <Pencil /> Editar
            </Button>
            {m.origin &&
              (m.originExists ? (
                <Button variant="ghost" size="xs" onClick={() => onOrigin(m.origin!)} title="A conversa em que o Claude guardou esta memória">
                  <MessageSquareText /> De onde veio
                </Button>
              ) : (
                <span className="flex items-center gap-1 px-2 text-xs text-muted-foreground" title="O Claude Code apaga as conversas depois de uns 30 dias">
                  <History className="size-3.5" /> A conversa de origem já foi apagada
                </span>
              ))}
            <Button variant="ghost" size="xs" onClick={onRemove} className="ml-auto text-muted-foreground hover:text-destructive">
              <Trash2 /> Para a lixeira
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** A lixeira do cald: o que foi apagado daqui volta igual; some sozinho depois de 30 dias. */
function Trash({ machine, items, single }: { machine: string; items: TrashedMemory[]; single: boolean }) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  return (
    <>
      <Fold
        open={open}
        onOpenChange={setOpen}
        title="Lixeira"
        count={items.length}
        aside={
          <Button variant="ghost" size="xs" onClick={() => setConfirm(true)} className="text-muted-foreground hover:text-destructive">
            Esvaziar
          </Button>
        }
      >
        {items.map((t) => (
          <div key={t.id} className="flex min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-2 hover:bg-foreground/[0.04]">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-muted-foreground line-through decoration-muted-foreground/40">{t.name}</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {!single && `${t.cwd ? placeName(t.cwd) : t.folder} · `}apagada {relativeTime(t.deletedAt)}
              </div>
            </div>
            <Button variant="ghost" size="xs" onClick={() => void restoreMemories(machine, [t.id])}>
              <RotateCcw /> Restaurar
            </Button>
          </div>
        ))}
      </Fold>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Esvaziar a lixeira?</AlertDialogTitle>
            <AlertDialogDescription>
              {items.length === 1 ? 'A memória na lixeira é apagada' : `As ${items.length} memórias na lixeira são apagadas`} de vez. Não dá para desfazer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void emptyMemoryTrash(machine, single ? items.map((t) => t.id) : undefined)}>
              Esvaziar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
