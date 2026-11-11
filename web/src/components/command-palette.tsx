import { Inbox, MessageSquarePlus, Search } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { navigate } from 'wouter/use-browser-location'
import { create } from 'zustand'
import { Claudinho } from '@/components/claudinho'
import { describe } from '@/components/inbox/describe'
import { ProjectMark } from '@/components/project-mark'
import { ProjectPicker } from '@/components/project-picker'
import { useQuickOpen } from '@/components/project/quick-open'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { ArtefatoIcon, latestOf, loadArtefatos, openArtefatos, showArtefato, useArtefatos } from '@/lib/artefatos'
import { askAgent } from '@/lib/ask-agent'
import { claudinhoName } from '@/lib/claudinho'
import { projectName, relativeTime } from '@/lib/format'
import { useWide, WIDE_QUERY } from '@/lib/hooks'
import { openInboxEntry, statusOf, useInbox, useInboxEntries } from '@/lib/inbox'
import { useLock } from '@/lib/lock'
import { HOME, machineName, newChatUrl, useMachines } from '@/lib/machines'
import { projectKey } from '@/lib/project-groups'
import { useProjectPanel } from '@/lib/project-panel'
import { useStore } from '@/lib/store'
import type { CatalogEntry } from '@/lib/types'
import { cn } from '@/lib/utils'
import { openInbox, openProjectHub, revealChat } from '@/lib/workbench'
import { projectOf } from '@/lib/worktree'

/**
 * A paleta de comandos (Ctrl+K, ⌘K no Mac): achar e abrir qualquer coisa pelo nome, as conversas (as
 * que esperam você primeiro), os projetos, os artefatos e a inbox, ou começar uma conversa nova com o que foi
 * digitado. Sem nada digitado, mostra o que pede você e o que foi usado por último. O Ctrl+P segue
 * sendo o dos arquivos do projeto (ver project/quick-open.tsx).
 *
 * Fica montada no app todo, então fechada ela só escuta o atalho: o catálogo e o resto só entram com
 * ela aberta.
 */

const usePalette = create<{ open: boolean }>(() => ({ open: false }))
const close = () => usePalette.setState({ open: false })

/** Os projetos de cada máquina, buscados ao abrir a paleta (até chegarem, valem os da última vez). */
const useProjectLists = create<Record<string, string[]>>(() => ({}))
const PROJECTS_EVERY_MS = 30_000
let projectsAt = 0

function loadProjects(): void {
  if (Date.now() - projectsAt < PROJECTS_EVERY_MS) return
  projectsAt = Date.now()
  const machines = useMachines.getState().machines.map((m) => m.id)
  for (const m of [HOME, ...machines.filter((m) => m !== HOME)]) {
    api.projects(m).then(
      (list) => useProjectLists.setState({ [m]: list }),
      // Máquina fora do ar: fica com o que tinha, e com os projetos das conversas dela.
      () => {},
    )
  }
}

/** Os artefatos de cada máquina que ainda não foram buscados; os já buscados seguem ao vivo (ver lib/artefatos.ts). */
function loadAllArtefatos(): void {
  const known = useArtefatos.getState().byMachine
  for (const { id } of useMachines.getState().machines) if (!known[id]) loadArtefatos(id).catch(() => {})
}

type Section = 'waiting' | 'chats' | 'projects' | 'artefatos' | 'inbox' | 'ask'
const SECTIONS: Record<Section, string> = {
  waiting: 'Esperando você',
  chats: 'Conversas',
  projects: 'Projetos',
  artefatos: 'Artefatos',
  inbox: 'Inbox',
  ask: 'Perguntar',
}
const ORDER = ['waiting', 'chats', 'projects', 'artefatos', 'inbox'] as const
/** Quantos de cada parte, sem nada digitado e buscando. */
const LIMIT: Record<(typeof ORDER)[number], [number, number]> = { waiting: [6, 6], chats: [5, 8], projects: [4, 5], artefatos: [1, 5], inbox: [4, 5] }

type Item = {
  key: string
  section: Section
  icon: React.ReactNode
  title: string
  /** Um dado só, em cinza, à direita. */
  meta?: React.ReactNode
  /** Onde a busca procura, e o título, já sem acento e em minúsculas. */
  text: string
  name: string
  /** Para o mais recente vir primeiro; o que só aparece buscando fica abaixo de zero. */
  at: number
  run: () => void
}

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** 3: o título começa pelo termo; 2: o título o contém; 1: só o resto contém as palavras; 0: não acha. */
function score(item: Item, words: string[], q: string): number {
  if (!words.every((w) => item.text.includes(w))) return 0
  return item.name.startsWith(q) ? 3 : item.name.includes(q) ? 2 : 1
}

type Target = { machine: string; cwd: string | undefined }

function openChat(id: string): void {
  // No PC, já à vista noutro grupo: só o grupo dela ganha o foco.
  if (matchMedia(WIDE_QUERY).matches && revealChat(id)) return
  navigate(`/s/${id}`)
}

function pick(item: Item | undefined): void {
  if (!item) return
  close()
  item.run()
}

/**
 * A linha de cada conversa, guardada pela entrada do catálogo: o catálogo troca só as entradas que
 * mudaram, então com centenas de conversas a paleta aberta não refaz (nem redesenha) as outras.
 */
const chatItems = new WeakMap<CatalogEntry, { several: boolean; item: Item }>()

function chatItem(s: CatalogEntry, several: boolean): Item {
  const hit = chatItems.get(s)
  if (hit?.several === several) return hit.item
  const where = s.cwd ? projectName(s.cwd) : '~'
  const title = s.title || 'Sem título'
  const item: Item = {
    key: `chat:${s.sessionId}`,
    section: s.state === 'waiting' || s.pending?.length ? 'waiting' : 'chats',
    icon: <Claudinho seed={s.sessionId} state={s.state} thinking={s.thinking} status size={20} />,
    title,
    meta: where,
    text: norm(
      [title, claudinhoName(s.sessionId, s.claudinhoName), where, s.gitBranch, s.workspace?.name, several && machineName(s.machine ?? HOME)]
        .filter(Boolean)
        .join(' '),
    ),
    name: norm(title),
    at: s.lastModified,
    run: () => openChat(s.sessionId),
  }
  chatItems.set(s, { several, item })
  return item
}

/** Um ícone ou avatar no mesmo espaço, para os títulos ficarem alinhados. */
const Slot = ({ children }: { children: React.ReactNode }) => <span className="flex size-5 shrink-0 items-center justify-center">{children}</span>

/** O que dá para achar, por parte, cada uma do mais recente para o mais antigo. */
function useSections(): Record<(typeof ORDER)[number], Item[]> {
  const catalog = useStore((s) => s.catalog)
  const lists = useProjectLists()
  const several = useMachines((s) => s.machines.length > 1)
  const entries = useInboxEntries()
  const inboxState = useInbox((s) => s.state)
  const artefatos = useArtefatos((s) => s.byMachine)
  const wide = useWide()

  return useMemo(() => {
    const by: Record<(typeof ORDER)[number], Item[]> = { waiting: [], chats: [], projects: [], artefatos: [], inbox: [] }
    for (const s of catalog) {
      const item = chatItem(s, several)
      by[item.section as 'waiting' | 'chats'].push(item)
    }

    // Os projetos de cada máquina, e os das conversas (o de cada worktree é o projeto de origem).
    const used = new Map<string, number>()
    const projects = new Map<string, Target>()
    for (const [m, list] of Object.entries(lists)) for (const cwd of list) projects.set(projectKey(m, cwd), { machine: m, cwd })
    for (const s of catalog) {
      if (!s.cwd) continue
      const machine = s.machine ?? HOME
      const cwd = projectOf(s.cwd)
      const key = projectKey(machine, cwd)
      used.set(key, Math.max(used.get(key) ?? 0, s.lastModified))
      if (!projects.has(key)) projects.set(key, { machine, cwd })
    }
    for (const [key, { machine, cwd }] of projects) {
      if (!cwd) continue
      const name = projectName(cwd)
      const at = used.get(key) ?? 0
      by.projects.push({
        key: `project:${key}`,
        section: 'projects',
        icon: <ProjectMark machine={machine} cwd={cwd} name={name} />,
        title: name,
        meta: several ? machineName(machine) : at ? relativeTime(at) : undefined,
        text: norm(`${name} ${cwd} ${several ? machineName(machine) : ''}`),
        name: norm(name),
        at,
        // No PC, o hub do projeto; no celular, uma conversa nova nele (como na lista de projetos).
        run: () => (wide ? openProjectHub(machine, cwd) : navigate(newChatUrl(cwd, machine))),
      })
    }

    // Cada artefato só aparece buscando (abre a versão atual); sem nada digitado, fica a entrada da galeria.
    for (const [m, list] of Object.entries(artefatos)) {
      for (const a of list?.artefatos ?? []) {
        const where = a.cwd ? projectName(projectOf(a.cwd)) : '~'
        by.artefatos.push({
          key: `artefato:${m}\n${a.id}`,
          section: 'artefatos',
          icon: <ArtefatoIcon className="size-4 text-muted-foreground" />,
          title: a.title,
          meta: several ? machineName(m) : where,
          text: norm(`${a.title} ${a.description ?? ''} ${where} ${several ? machineName(m) : ''}`),
          name: norm(a.title),
          at: -1,
          run: () => showArtefato({ machine: m, id: a.id, n: latestOf(a)?.n, title: a.title }),
        })
      }
    }
    by.artefatos.push({
      key: 'artefatos',
      section: 'artefatos',
      icon: <ArtefatoIcon className="size-4 text-muted-foreground" />,
      title: 'Artefatos',
      text: 'artefatos paginas publicadas links',
      name: 'artefatos',
      // Sempre a primeira da parte dela.
      at: Infinity,
      run: () => openArtefatos(),
    })

    // O número é o mesmo do botão da inbox: tudo que é novo, as conversas que esperam você inclusive.
    let unread = 0
    for (const e of entries) {
      const status = statusOf(e, inboxState)
      if (status === 'new') unread++
      // As conversas que esperam você já têm a parte delas; o adiado fica para depois.
      if (e.group === 'waiting' || status === 'snoozed') continue
      const d = describe(e)
      by.inbox.push({
        key: `inbox:${e.key}`,
        section: 'inbox',
        icon: d.icon,
        title: d.title,
        meta: d.where,
        text: norm(`${d.title} ${d.why} ${d.where}`),
        name: norm(d.title),
        // O que já foi visto só aparece buscando.
        at: status === 'new' ? e.at : -1,
        run: () => openInboxEntry(e, wide),
      })
    }
    by.inbox.push({
      key: 'inbox',
      section: 'inbox',
      icon: <Inbox className="size-4 text-muted-foreground" />,
      title: 'Inbox',
      meta: unread || undefined,
      text: 'inbox caixa de entrada',
      name: 'inbox',
      // Sempre a primeira da parte dela.
      at: Infinity,
      run: () => (wide ? openInbox() : navigate('/inbox')),
    })

    for (const list of Object.values(by)) list.sort((a, b) => b.at - a.at)
    return by
  }, [catalog, lists, entries, inboxState, artefatos, wide, several])
}

/** O que aparece para o termo: as partes em ordem, as melhores de cada uma, e por fim o "Perguntar". */
function useItems(text: string, target: Target, onAskElsewhere: (text: string) => void): Item[] {
  const sections = useSections()
  return useMemo(() => {
    const prompt = text.trim()
    const q = norm(prompt)
    const words = q.split(/\s+/).filter(Boolean)
    const out: Item[] = []
    for (const section of ORDER) {
      const [few, many] = LIMIT[section]
      const pool = sections[section]
      if (!q) {
        // Já em ordem: os primeiros são os mais recentes, e o que só aparece buscando fica no fim.
        out.push(...pool.slice(0, few).filter((i) => i.at >= 0))
        continue
      }
      // Uma passada, sem ordenar tudo: cada nível de acerto guarda a ordem por data, e para quando o melhor enche.
      const tiers: Item[][] = [[], [], []]
      for (const i of pool) {
        const s = score(i, words, q)
        if (s) tiers[3 - s]!.push(i)
        if (tiers[0]!.length >= many) break
      }
      out.push(...tiers.flat().slice(0, many))
    }
    if (q) {
      const name = target.cwd ? projectName(target.cwd) : '~'
      out.push(
        {
          key: 'ask:here',
          section: 'ask',
          icon: <MessageSquarePlus className="size-4 text-muted-foreground" />,
          title: prompt,
          meta: (
            <span className="flex min-w-0 items-center gap-1.5">
              {target.cwd && <ProjectMark machine={target.machine} cwd={target.cwd} name={name} className="size-3.5 text-[8px]" />}
              <span className="truncate">{name}</span>
            </span>
          ),
          text: '',
          name: '',
          at: 0,
          run: () => void askAgent(target, prompt),
        },
        {
          key: 'ask:elsewhere',
          section: 'ask',
          icon: <MessageSquarePlus className="size-4 text-muted-foreground" />,
          title: 'Em outro projeto…',
          text: '',
          name: '',
          at: 0,
          run: () => onAskElsewhere(prompt),
        },
      )
    }
    return out
  }, [sections, text, target, onAskElsewhere])
}

/** Uma linha: só redesenha quando o item ou a seleção mudam (o claudinho de cada conversa é um SVG animado). */
const Row = memo(function Row({
  item,
  index,
  selected,
  header,
  onHover,
}: {
  item: Item
  index: number
  selected: boolean
  /** A primeira linha da parte leva o título dela. */
  header: boolean
  onHover: (index: number) => void
}) {
  return (
    <div>
      {header && (
        <div
          className={cn(
            'px-4 pt-2 pb-1 text-xs text-muted-foreground',
            // A única cor da paleta: o que espera você.
            item.section === 'waiting' && 'text-amber-600 dark:text-amber-400',
          )}
        >
          {SECTIONS[item.section]}
        </div>
      )}
      <button
        type="button"
        role="option"
        data-index={index}
        aria-selected={selected}
        onMouseMove={() => onHover(index)}
        onClick={() => pick(item)}
        className={cn('flex w-full min-w-0 items-center gap-2.5 px-4 py-1.5 text-left text-[13px]', selected && 'bg-muted')}
      >
        <Slot>{item.icon}</Slot>
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
        {item.meta !== undefined && <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{item.meta}</span>}
      </button>
    </div>
  )
})

/** O projeto em que a pergunta cai: o da conversa em foco (o de origem, se ela roda num worktree) ou o último usado. */
function useTarget(): Target {
  const focused = useProjectPanel((s) => s.project)
  const catalog = useStore((s) => s.catalog)
  return useMemo(() => {
    if (focused) return { machine: focused.machine, cwd: projectOf(focused.cwd) }
    let last: CatalogEntry | undefined
    for (const s of catalog) if (s.cwd && (!last || s.lastModified > last.lastModified)) last = s
    return last?.cwd ? { machine: last.machine ?? HOME, cwd: projectOf(last.cwd) } : { machine: HOME, cwd: undefined }
  }, [focused, catalog])
}

function Palette({ onAskElsewhere }: { onAskElsewhere: (text: string, machine: string) => void }) {
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const wide = useWide()
  const target = useTarget()
  const elsewhere = useMemo(() => (prompt: string) => onAskElsewhere(prompt, target.machine), [onAskElsewhere, target.machine])
  const items = useItems(text, target, elsewhere)
  const current = Math.min(active, Math.max(0, items.length - 1))

  return (
    <>
      <div className="flex items-center gap-2 border-b px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setActive(0)
            if (list.current) list.current.scrollTop = 0
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const n = items.length
              if (!n) return
              const next = (current + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
              setActive(next)
              // Só ao navegar: rolar já na abertura forçava o layout da tela toda no meio da animação.
              list.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' })
            } else if (e.key === 'Enter') {
              e.preventDefault()
              // Ctrl+Enter: pergunta no projeto, de qualquer linha.
              pick(e.ctrlKey || e.metaKey ? items.find((i) => i.key === 'ask:here') : items[current])
            }
          }}
          placeholder="Buscar ou perguntar ao Claude"
          aria-label="Buscar conversas, projetos, artefatos e inbox, ou perguntar ao Claude"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div ref={list} role="listbox" className="max-h-[min(60vh,460px)] overflow-y-auto py-1">
        {items.map((item, i) => (
          <Row key={item.key} item={item} index={i} selected={i === current} header={item.section !== items[i - 1]?.section} onHover={setActive} />
        ))}
        {items.length === 0 && <p className="px-4 py-3 text-xs text-muted-foreground">Digite para buscar ou perguntar.</p>}
      </div>
      {wide && (
        <div className="flex gap-3 border-t px-4 py-1.5 text-[11px] text-muted-foreground">
          <span>↑↓ navegar</span>
          <span>↵ abrir</span>
          {text.trim() && <span>Ctrl ↵ perguntar</span>}
        </div>
      )}
    </>
  )
}

/** A paleta e o atalho dela, valendo no app todo (menos no terminal, onde o Ctrl+K é do shell). */
export function CommandPalette() {
  const open = usePalette((s) => s.open)
  // "Em outro projeto…": a pergunta espera a escolha do projeto. O seletor só fica montado enquanto é usado.
  const [asking, setAsking] = useState<{ text: string; machine: string } | null>(null)
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return
      if (useLock.getState().status === 'locked') return
      if (e.target instanceof Element && e.target.closest('.xterm')) return
      // No lugar da busca do navegador.
      e.preventDefault()
      useQuickOpen.setState({ open: false })
      usePalette.setState((s) => ({ open: !s.open }))
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    if (!open) return
    loadProjects()
    loadAllArtefatos()
  }, [open])

  // Fechado o seletor, sai depois da animação.
  useEffect(() => {
    if (picking || !asking) return
    const timer = setTimeout(() => setAsking(null), 300)
    return () => clearTimeout(timer)
  }, [picking, asking])

  const askElsewhere = useMemo(
    () => (text: string, machine: string) => {
      setAsking({ text, machine })
      setPicking(true)
    },
    [],
  )

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && close()}>
        <DialogContent
          showCloseButton={false}
          // Perto do topo, como no VSCode, e não no meio da tela.
          className={cn('top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl', !matchMedia(WIDE_QUERY).matches && 'top-4')}
        >
          <DialogTitle className="sr-only">Paleta de comandos</DialogTitle>
          <DialogDescription className="sr-only">Busque conversas, projetos, artefatos e a inbox, ou pergunte algo ao Claude</DialogDescription>
          {open && <Palette onAskElsewhere={askElsewhere} />}
        </DialogContent>
      </Dialog>
      {asking && (
        <ProjectPicker
          key={asking.machine}
          open={picking}
          onOpenChange={setPicking}
          machine={asking.machine}
          title="Perguntar em"
          description={asking.text}
          onPick={(cwd, machine) => {
            setPicking(false)
            void askAgent({ machine, cwd }, asking.text)
          }}
        />
      )}
    </>
  )
}
