import { create } from 'zustand'
import { onAudio, onAudioReady, quietAudio, type Spectrum } from './audio'
import { emitChanged, type Changed } from './changes'
import { useLooks } from './claudinho'
import { pinRejected, useLock } from './lock'
import { HOME, baseOf, machineOf, noteSession, noteSessions, useMachines } from './machines'
import { withToken } from './pin-tokens'
import type { CatalogEntry, LoggedEvent, SessionSettings, SessionState, SystemSnapshot, UsageSnapshot } from './types'

export type Connection = 'connecting' | 'open' | 'closed'

/** Estado ao vivo de uma sessão aberta no painel (vindo do WebSocket). */
export type LiveView = {
  runId?: string
  events: LoggedEvent[]
  lastSeq: number
  state?: SessionState
  waitingFor?: string
  /** Processo do painel ativo? `null` enquanto não se sabe. */
  open: boolean | null
  /** Modelo, esforço e modo vigentes (último evento `settings`). */
  settings: SessionSettings
}

type Store = {
  /** Conexão com a máquina desta página (a faixa "Sem conexão" no topo). */
  connection: Connection
  /** Conexão com cada máquina (ver machines.ts). */
  connections: Record<string, Connection>
  /** Conversas de todas as máquinas, cada uma com `machine`. */
  catalog: CatalogEntry[]
  catalogLoaded: boolean
  live: Record<string, LiveView>
  /**
   * Texto parcial do turno em andamento, por sessão. Fica fora do LiveView de propósito: cada pedaço
   * que chega re-renderiza só quem mostra o texto, e não a conversa inteira.
   */
  streams: Record<string, string>
  /** Sessões bifurcadas que ganharam ID novo: antigo → novo. */
  rekeys: Record<string, string>
  /** CPU, memória e processos do Claude em cada máquina (a cada ~3 s). */
  systems: Record<string, SystemSnapshot>
  /** Limites do plano e gasto da semana, por máquina. */
  usages: Record<string, UsageSnapshot>
}

export const useStore = create<Store>(() => ({
  connection: 'connecting',
  connections: {},
  catalog: [],
  catalogLoaded: false,
  live: {},
  streams: {},
  rekeys: {},
  systems: {},
  usages: {},
}))

const emptyView = (): LiveView => ({ events: [], lastSeq: 0, open: null, settings: {} })

const settingsOf = (events: LoggedEvent[], fallback: SessionSettings): SessionSettings => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.kind === 'settings') return { model: e.model, effort: e.effort, permissionMode: e.permissionMode }
  }
  return fallback
}

export const selectView = (id: string) => (s: Store) => s.live[id] ?? EMPTY
const EMPTY = emptyView()

function patchView(id: string, fn: (v: LiveView) => LiveView): void {
  useStore.setState((s) => ({ live: { ...s.live, [id]: fn(s.live[id] ?? emptyView()) } }))
}

// Pedaços do streaming ainda não gravados: chegam às dezenas por segundo, então vão para o store
// juntos, uma vez por quadro.
const pendingDeltas = new Map<string, string>()
let deltaFrame = 0

function flushDeltas(): void {
  cancelAnimationFrame(deltaFrame)
  deltaFrame = 0
  if (!pendingDeltas.size) return
  const chunks = [...pendingDeltas]
  pendingDeltas.clear()
  useStore.setState((s) => {
    const streams = { ...s.streams }
    for (const [id, text] of chunks) streams[id] = (streams[id] ?? '') + text
    return { streams }
  })
}

function clearStream(id: string): void {
  pendingDeltas.delete(id)
  if (!useStore.getState().streams[id]) return
  useStore.setState((s) => {
    const { [id]: _, ...streams } = s.streams
    return { streams }
  })
}

/** Eventos que encerram o texto parcial: a resposta completa chegou ou o turno acabou. */
const endsStream = (e: LoggedEvent) =>
  (e.kind === 'state' && e.state !== 'running') || (e.kind === 'assistant' && !e.parentToolUseId) || e.kind === 'exit'

// ---------------------------------------------------------------------------
// Conexões WebSocket, uma por máquina (ver machines.ts): reconectam sozinhas e retomam cada
// sessão do último seq visto.
// ---------------------------------------------------------------------------

const STALE_MS = 60_000

/** Sessões acompanhadas e a máquina em cuja conexão cada uma está inscrita. */
const subscribed = new Map<string, string>()
// Conversas de cada máquina; o catálogo do store junta todas.
const catalogs = new Map<string, CatalogEntry[]>()

function setConnection(machine: string, state: Connection): void {
  useStore.setState((s) => ({
    connections: { ...s.connections, [machine]: state },
    ...(machine === HOME ? { connection: state } : {}),
  }))
}

class MachineSocket {
  machine: string
  ws: WebSocket | null = null
  retry = 0
  retryTimer: ReturnType<typeof setTimeout> | undefined
  lastMessageAt = 0
  /** Saiu da lista de máquinas: não reconecta mais. */
  disposed = false

  constructor(machine: string) {
    this.machine = machine
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private url(): string {
    const base = baseOf(this.machine)
    if (base) return withToken(`${base.replace(/^http/, 'ws')}/ws`)
    return withToken(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  }

  connect(): void {
    if (this.ws || this.disposed) return
    clearTimeout(this.retryTimer)
    setConnection(this.machine, 'connecting')
    const socket = new WebSocket(this.url())
    this.ws = socket

    socket.onopen = () => {
      this.retry = 0
      this.lastMessageAt = Date.now()
      setConnection(this.machine, 'open')
      for (const [id, machine] of subscribed) if (machine === this.machine) this.sendSubscribe(id)
      // O fundo de som pede a captura assim que a cena começa, que costuma ser antes de a conexão
      // abrir; sem repetir aqui, o pedido se perderia na carga da página e em cada reconexão.
      if (audioUsers > 0 && this.machine === HOME) this.send({ type: 'listen_audio' })
    }
    socket.onmessage = (e) => {
      this.lastMessageAt = Date.now()
      handle(this.machine, JSON.parse(String(e.data)))
    }
    socket.onclose = (e) => {
      if (this.ws !== socket) return
      // O servidor derrubou por falta de PIN (travou em outro lugar, PIN trocado): destrava de novo ou trava o app.
      if (e.code === 4401) void pinRejected(socket.url)
      this.ws = null
      setConnection(this.machine, 'closed')
      if (!this.disposed) this.retryTimer = setTimeout(() => this.connect(), Math.min(15_000, 1_000 * 2 ** this.retry++))
    }
  }

  /** Derruba a conexão atual (se parecer morta) e reconecta já, sem esperar o backoff. */
  reconnectNow(force: boolean): void {
    const stale = Date.now() - this.lastMessageAt > STALE_MS
    if (this.ws && (force || stale)) {
      const old = this.ws
      this.ws = null
      old.close()
    }
    this.retry = 0
    this.connect()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.retryTimer)
    const old = this.ws
    this.ws = null
    old?.close()
  }

  send(msg: unknown): void {
    if (this.open) this.ws!.send(JSON.stringify(msg))
  }

  sendSubscribe(id: string): void {
    const v = useStore.getState().live[id]
    this.send({ type: 'subscribe', sessionId: id, sinceSeq: v?.lastSeq ?? 0, runId: v?.runId })
  }
}

const sockets = new Map<string, MachineSocket>()

// Várias telas podem querer o som ao mesmo tempo (a conversa e a miniatura dos ajustes): só a
// primeira liga a captura no PC e só a última desliga, senão uma derrubaria a da outra.
let audioUsers = 0

/**
 * Pede o espectro do que está tocando no PC enquanto a tela precisar, e devolve como parar. É
 * sempre o som da máquina que serve o painel — o PC na sua frente —, não o da conversa aberta, que
 * pode estar em outra máquina.
 */
export function listenAudio(): () => void {
  if (audioUsers++ === 0) sockets.get(HOME)?.send({ type: 'listen_audio' })
  let done = false
  return () => {
    if (done) return
    done = true
    if (--audioUsers === 0) {
      sockets.get(HOME)?.send({ type: 'unlisten_audio' })
      quietAudio()
    }
  }
}

const socketOf = (sessionId: string) => sockets.get(subscribed.get(sessionId) ?? machineOf(sessionId))

/** Uma conexão para cada máquina da lista; a que sai da lista é fechada e some do catálogo. */
function syncSockets(): void {
  const ids = new Set(useMachines.getState().machines.map((m) => m.id))
  for (const id of ids) {
    if (sockets.has(id)) continue
    const socket = new MachineSocket(id)
    sockets.set(id, socket)
    socket.connect()
  }
  for (const [id, socket] of sockets) {
    if (ids.has(id)) continue
    socket.dispose()
    sockets.delete(id)
    catalogs.delete(id)
    mergeCatalogs()
  }
}

let started = false

export function connect(): void {
  if (started) return
  started = true
  syncSockets()
  useMachines.subscribe(syncSockets)
  // Destravou de novo: reabre já, com o token novo, sem esperar o backoff.
  useLock.subscribe((s, prev) => s.round !== prev.round && reconnectNow(true))
}

/** Reconecta já com todas as máquinas: `force` derruba até as que parecem vivas. */
export function reconnectNow(force = false): void {
  for (const socket of sockets.values()) socket.reconnectNow(force)
}

// Celular voltando do bloqueio ou da falta de rede: as conexões antigas podem estar mortas.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') reconnectNow()
})
window.addEventListener('online', () => reconnectNow(true))
setInterval(() => {
  for (const socket of sockets.values()) {
    if (socket.open && Date.now() - socket.lastMessageAt > STALE_MS) socket.reconnectNow(true)
  }
}, 15_000)

/** Pede o log inteiro da execução atual, descartando o que o cliente tem. */
function resync(id: string): void {
  socketOf(id)?.send({ type: 'subscribe', sessionId: id, sinceSeq: 0 })
}

/**
 * Quantas telas acompanham cada sessão: a mesma conversa pode estar na aba dela e na mesa do projeto
 * (ver project/hub.tsx), e fechar uma não pode cortar o ao vivo da outra. Numa troca de id (o rekey),
 * a inscrição passa para o novo e a conta fica no velho, que a tela solta ao remontar com o novo.
 */
const watchers = new Map<string, number>()

export function subscribe(id: string): void {
  const count = watchers.get(id) ?? 0
  watchers.set(id, count + 1)
  if (count) return
  const machine = machineOf(id)
  subscribed.set(id, machine)
  sockets.get(machine)?.sendSubscribe(id)
}

export function unsubscribe(id: string): void {
  const left = (watchers.get(id) ?? 1) - 1
  if (left > 0) return void watchers.set(id, left)
  watchers.delete(id)
  const machine = subscribed.get(id)
  subscribed.delete(id)
  if (machine !== undefined) sockets.get(machine)?.send({ type: 'unsubscribe', sessionId: id })
}

// ---------------------------------------------------------------------------
// Mensagens do servidor
// ---------------------------------------------------------------------------

type ServerMsg =
  | { type: 'hello' | 'tick' }
  | { type: 'catalog'; sessions: CatalogEntry[] }
  | {
      type: 'snapshot'
      sessionId: string
      runId: string
      state: SessionState
      waitingFor?: string
      reset: boolean
      events: LoggedEvent[]
    }
  | { type: 'not_open'; sessionId: string }
  | { type: 'event'; sessionId: string; runId: string; event: LoggedEvent }
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'rekey'; from: string; to: string; look?: string }
  | { type: 'system'; system: SystemSnapshot }
  | { type: 'audio'; spectrum: Spectrum }
  | { type: 'audio_ready'; available: boolean }
  | { type: 'usage'; usage: UsageSnapshot }
  | ({ type: 'changed' } & Changed)

type LiveListener = (sessionId: string, runId: string, event: LoggedEvent) => void
const liveListeners = new Set<LiveListener>()

/** Eventos que chegam ao vivo pelo WebSocket, uma vez cada; não inclui o histórico nem o snapshot. */
export function onLiveEvent(listener: LiveListener): () => void {
  liveListeners.add(listener)
  return () => {
    liveListeners.delete(listener)
  }
}

function handle(machine: string, m: ServerMsg): void {
  // O que chega de uma sessão vem depois dos pedaços já recebidos dela: grava-os antes, na ordem.
  if (m.type === 'snapshot' || m.type === 'not_open' || m.type === 'event' || m.type === 'rekey') flushDeltas()
  switch (m.type) {
    case 'catalog':
      return onCatalog(machine, m.sessions)
    case 'audio':
      return onAudio(m.spectrum)
    case 'audio_ready':
      return onAudioReady(m.available)
    case 'system':
      return useStore.setState((s) => ({ systems: { ...s.systems, [machine]: m.system } }))
    case 'usage':
      return useStore.setState((s) => ({ usages: { ...s.usages, [machine]: m.usage } }))
    case 'changed':
      return emitChanged(machine, { what: m.what, cwd: m.cwd, rev: m.rev })
    case 'snapshot':
      if (m.state !== 'running') clearStream(m.sessionId)
      return patchView(m.sessionId, (v) => {
        const sameRun = v.runId === m.runId && !m.reset
        const base = sameRun ? v.events : []
        const since = sameRun ? v.lastSeq : 0
        const events = [...base, ...m.events.filter((e) => e.seq > since)]
        return {
          ...v,
          runId: m.runId,
          events,
          lastSeq: events.at(-1)?.seq ?? 0,
          state: m.state,
          waitingFor: m.waitingFor,
          open: m.state !== 'exited',
          settings: settingsOf(events, sameRun ? v.settings : {}),
        }
      })
    case 'not_open':
      clearStream(m.sessionId)
      return patchView(m.sessionId, (v) => ({ ...v, open: false }))
    case 'event': {
      const before = useStore.getState().live[m.sessionId]
      // Repetido (já veio no snapshot ou num reenvio): não é novidade.
      const fresh = before?.runId !== m.runId || m.event.seq > before.lastSeq
      // Processo novo da mesma conversa começa do zero, sem o texto parcial do anterior.
      if (before?.runId !== m.runId || (fresh && endsStream(m.event))) clearStream(m.sessionId)
      patchView(m.sessionId, (v) => applyEvent(v, m.runId, m.event))
      if (fresh) {
        for (const listener of liveListeners) listener(m.sessionId, m.runId, m.event)
      }
      if (before?.runId === m.runId) {
        // Buraco na sequência (mensagem perdida): pede o que falta.
        if (m.event.seq > before.lastSeq + 1) socketOf(m.sessionId)?.sendSubscribe(m.sessionId)
      } else if (m.event.seq > 1) {
        // Execução nova pega pela metade (ex.: eventos gravados antes de a sessão ser anunciada): pede tudo.
        resync(m.sessionId)
      }
      return
    }
    case 'delta':
      pendingDeltas.set(m.sessionId, (pendingDeltas.get(m.sessionId) ?? '') + m.text)
      deltaFrame ||= requestAnimationFrame(flushDeltas)
      return
    case 'rekey':
      // A mesma conversa com id novo (um /clear): já com o claudinho de antes, antes do catálogo chegar.
      if (m.look) useLooks.setState({ [m.to]: m.look })
      useStore.setState((s) => {
        const { [m.from]: moved, ...rest } = s.live
        const { [m.from]: text, ...streams } = s.streams
        return {
          live: moved ? { ...rest, [m.to]: moved } : rest,
          streams: text ? { ...streams, [m.to]: text } : streams,
          rekeys: { ...s.rekeys, [m.from]: m.to },
        }
      })
      noteSession(m.to, machine)
      if (subscribed.delete(m.from)) subscribed.set(m.to, machine)
      return
  }
}

function applyEvent(view: LiveView, runId: string, e: LoggedEvent): LiveView {
  // Primeiro evento de um processo novo da mesma conversa: começa do zero.
  const v = view.runId === runId ? view : { ...emptyView(), runId }
  if (e.seq <= v.lastSeq) return v
  const next: LiveView = { ...v, events: [...v.events, e], lastSeq: e.seq, open: true }
  if (e.kind === 'state') {
    next.state = e.state
    next.waitingFor = e.waitingFor
  }
  if (e.kind === 'settings') next.settings = { model: e.model, effort: e.effort, permissionMode: e.permissionMode }
  if (e.kind === 'exit') next.open = false
  return next
}

function mergeCatalogs(): void {
  // A mesma conversa em duas máquinas (pastas do Claude sincronizadas): fica a primeira da lista.
  const seen = new Set<string>()
  const catalog = [...catalogs.values()]
    .flat()
    .filter((s) => !seen.has(s.sessionId) && seen.add(s.sessionId))
    .sort((a, b) => b.lastModified - a.lastModified)
  const current = useStore.getState().catalog
  if (catalog.length === current.length && catalog.every((s, i) => s === current[i])) return
  useStore.setState({ catalog })
}

function onCatalog(machine: string, sessions: CatalogEntry[]): void {
  // As conversas que continuam outra vestem o claudinho de lá (ver lib/claudinho.ts).
  const looks = sessions.filter((e) => e.look)
  if (looks.length) {
    const current = useLooks.getState()
    if (looks.some((e) => current[e.sessionId] !== e.look)) useLooks.setState(Object.fromEntries(looks.map((e) => [e.sessionId, e.look!])))
  }
  const previous = new Map(useStore.getState().catalog.map((s) => [s.sessionId, s]))
  const before = new Map([...previous].map(([id, s]) => [id, s.owner]))
  // O catálogo chega inteiro a cada mudança; a entrada que não mudou continua o mesmo objeto, senão
  // toda tela que lê uma conversa renderizaria de novo por causa de outra.
  catalogs.set(
    machine,
    sessions.map((s) => {
      const next = { ...s, machine }
      const old = previous.get(s.sessionId)
      return old && JSON.stringify(old) === JSON.stringify(next) ? old : next
    }),
  )
  noteSessions(machine, sessions.map((s) => s.sessionId))
  mergeCatalogs()
  if (!useStore.getState().catalogLoaded) useStore.setState({ catalogLoaded: true })
  for (const s of sessions) {
    const at = subscribed.get(s.sessionId)
    if (at === undefined) continue
    if (at !== machine) {
      // Aberta antes de se saber a máquina dela (link direto, notificação): passa para a conexão certa.
      sockets.get(at)?.send({ type: 'unsubscribe', sessionId: s.sessionId })
      subscribed.set(s.sessionId, machine)
      sockets.get(machine)?.sendSubscribe(s.sessionId)
    } else if (s.owner === 'panel' && before.get(s.sessionId) !== 'panel') {
      // Sessão acompanhada que acabou de abrir no painel: pede o snapshot para saber o estado inicial.
      sockets.get(machine)?.sendSubscribe(s.sessionId)
    }
  }
}
