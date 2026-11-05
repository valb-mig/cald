import { useMemo } from 'react'
import { navigate } from 'wouter/use-browser-location'
import { create } from 'zustand'
import { api } from './api'
import { HOME, newChatUrl, useMachines } from './machines'
import { useStore } from './store'
import type { CatalogEntry, InboxAction, InboxItem, InboxItemState, InboxPayload } from './types'
import { openPanelTab, openProjectHub } from './workbench'

/**
 * A inbox do app: o que cada máquina manda (PRs e issues do GitHub, projetos com mudanças, TODOs) e as
 * conversas que esperam você, do catálogo. O visto e o adiado ficam no PC principal (ver
 * server/src/inbox.ts) e valem em todos os aparelhos.
 */

export type InboxGroup = 'waiting' | 'review' | 'mine' | 'issues' | 'code' | 'todo'
export const GROUPS: { id: InboxGroup; label: string }[] = [
  { id: 'waiting', label: 'Esperando você' },
  { id: 'review', label: 'Revisão pedida' },
  { id: 'mine', label: 'Seus PRs' },
  { id: 'issues', label: 'Issues' },
  { id: 'code', label: 'Código' },
  { id: 'todo', label: 'TODOs' },
]

export type InboxEntry = {
  key: string
  mark: string
  machine: string
  group: InboxGroup
  /** Para ordenar dentro do grupo: o mais recente primeiro. */
  at: number
  item: InboxItem | { type: 'waiting'; session: CatalogEntry }
}

type State = {
  byMachine: Record<string, InboxPayload | undefined>
  state: Record<string, InboxItemState>
  loading: boolean
  /** Quando a última busca terminou (o "atualizado há…"). */
  at: number
}

export const useInbox = create<State>(() => ({ byMachine: {}, state: {}, loading: false, at: 0 }))

let running: Promise<void> | null = null

/** Busca de novo a inbox de cada máquina e o estado no PC principal; `refresh` consulta o GitHub e o remoto. */
export function refreshInbox(refresh = false): Promise<void> {
  if (running && !refresh) return running
  useInbox.setState({ loading: true })
  const machines = useMachines.getState().machines.map((m) => m.id)
  const ids = [HOME, ...machines.filter((m) => m !== HOME)]
  running = Promise.all([
    ...ids.map((m) =>
      api.inbox(m, refresh).then(
        (payload) => useInbox.setState((s) => ({ byMachine: { ...s.byMachine, [m]: payload } })),
        // Máquina fora do ar ou com servidor antigo: fica com o que tinha.
        () => {},
      ),
    ),
    api.inboxState(HOME).then(
      (state) => useInbox.setState({ state }),
      () => {},
    ),
  ]).then(() => {
    useInbox.setState({ loading: false, at: Date.now() })
    running = null
  })
  return running
}

const EVERY_MS = 2 * 60_000
let started = false

/** Mantém a inbox em dia: ao abrir o app, a cada 2 min com ele à vista e ao voltar para ele. */
export function startInbox(): void {
  if (started) return
  started = true
  void refreshInbox()
  setInterval(() => document.visibilityState === 'visible' && void refreshInbox(), EVERY_MS)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void refreshInbox())
}

/** Visto, adiado ou de volta: muda na hora e grava no PC principal. */
export function actOnInbox(actions: InboxAction[]): void {
  const now = Date.now()
  useInbox.setState((s) => {
    const next = { ...s.state }
    for (const a of actions) {
      if (a.action === 'clear') delete next[a.key]
      else if (a.action === 'seen') next[a.key] = { seen: a.mark ?? '', at: now }
      else next[a.key] = { ...next[a.key], snoozedUntil: a.until, at: now }
    }
    return { state: next }
  })
  api.setInboxState(HOME, actions).then(
    (state) => useInbox.setState({ state }),
    () => void refreshInbox(),
  )
}

/** Amanhã às 8h: até quando o "adiar" esconde o item. */
export function tomorrowMorning(): number {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  return d.getTime()
}

/** Abre o item: a conversa, o PR ou a issue, ou o projeto (no PC o hub dele; no celular, uma conversa nova nele). */
export function openInboxEntry(e: InboxEntry, wide: boolean): void {
  const it = e.item
  if (it.type === 'waiting') return navigate(`/s/${it.session.sessionId}`)
  if (it.type === 'github') {
    // No PC, com o projeto clonado aqui, o PR ou a issue abre numa aba; senão, no GitHub.
    if (wide && it.cwd) return openPanelTab({ kind: 'github', machine: e.machine, cwd: it.cwd, item: it.kind, number: it.number, title: it.title }, { preview: true })
    return void window.open(it.url, '_blank', 'noreferrer')
  }
  if (wide) return openProjectHub(e.machine, it.cwd)
  navigate(newChatUrl(it.cwd, e.machine))
}

const groupOf = (i: InboxItem): InboxGroup =>
  i.type === 'git' ? 'code' : i.type === 'todo' ? 'todo' : i.reason === 'review' ? 'review' : i.reason === 'assigned' || i.reason === 'mentioned' ? 'issues' : 'mine'

/** Todos os itens, sem repetir o mesmo PR vindo de duas máquinas (o GitHub é da conta, não da máquina). */
export function useInboxEntries(): InboxEntry[] {
  const byMachine = useInbox((s) => s.byMachine)
  const catalog = useStore((s) => s.catalog)
  return useMemo(() => {
    const out: InboxEntry[] = []
    const seen = new Set<string>()
    for (const s of catalog) {
      if (s.state !== 'waiting' && !s.pending?.length) continue
      const machine = s.machine ?? HOME
      out.push({
        key: `wait:${machine}|${s.sessionId}`,
        mark: s.pending?.map((p) => p.requestId).join(',') || `${s.waitingFor ?? ''}|${s.lastModified}`,
        machine,
        group: 'waiting',
        at: s.lastModified,
        item: { type: 'waiting', session: s },
      })
    }
    for (const [machine, payload] of Object.entries(byMachine)) {
      for (const item of payload?.items ?? []) {
        // Os do GitHub valem para a conta: a mesma chave em qualquer máquina. Os outros são da máquina.
        const key = item.type === 'github' || machine === HOME ? item.key : `${machine}|${item.key}`
        if (seen.has(key)) continue
        seen.add(key)
        const at = item.type === 'github' ? Date.parse(item.updatedAt) : item.type === 'todo' ? item.createdAt : 0
        out.push({ key, mark: item.mark, machine, group: groupOf(item), at, item })
      }
    }
    return out.sort((a, b) => b.at - a.at)
  }, [byMachine, catalog])
}

export type InboxStatus = 'new' | 'seen' | 'snoozed'

export function statusOf(e: InboxEntry, state: Record<string, InboxItemState>, now = Date.now()): InboxStatus {
  const st = state[e.key]
  if (st?.snoozedUntil && st.snoozedUntil > now) return 'snoozed'
  // Visto com outra marca: o item mudou desde então e volta como novo.
  return st?.seen !== undefined && st.seen === e.mark ? 'seen' : 'new'
}

/** Quantos itens novos (nem vistos nem adiados): o número no botão da inbox. */
export function useInboxCount(): number {
  const entries = useInboxEntries()
  const state = useInbox((s) => s.state)
  return useMemo(() => entries.filter((e) => statusOf(e, state) === 'new').length, [entries, state])
}
