import { toast } from 'sonner'
import { create } from 'zustand'
import { ApiError, api, errorMessage } from './api'
import { idb } from './db'
import { useStore } from './store'
import type { AttachmentPayload, RunOptions } from './types'

/**
 * Mensagem escrita no celular que ainda não chegou ao PC. Como no WhatsApp: sem conexão,
 * fica com o relógio e segue sozinha quando o PC volta a responder.
 */
export type OutboxItem = {
  /** Vai junto ao servidor: reenviar a mesma mensagem não repete o turno. */
  id: string
  sessionId: string
  text: string
  attachments: AttachmentPayload[]
  /** Modelo, esforço e modo para retomar a conversa, se ela estiver parada na hora do envio. */
  options?: RunOptions
  /** Com o Claude trabalhando, entra na fila da conversa, com o modelo e o esforço de `options` (ver api.send). */
  next?: boolean
  createdAt: number
  status: 'queued' | 'sending' | 'failed'
  error?: string
}

export const useOutbox = create<{ items: OutboxItem[] }>(() => ({ items: [] }))

// ---------------------------------------------------------------------------
// Persistência: a fila sobrevive ao app fechado (ver db.ts). Se o navegador recusar, segue só em memória.
// ---------------------------------------------------------------------------

function save(item: OutboxItem): void {
  idb('outbox', 'readwrite', (s) => s.put(item)).catch(() => {})
}

function update(id: string, change: Partial<OutboxItem>, persist = true): void {
  let next: OutboxItem | undefined
  useOutbox.setState((s) => ({ items: s.items.map((i) => (i.id === id ? (next = { ...i, ...change }) : i)) }))
  if (next && persist) save(next)
}

function remove(id: string): void {
  useOutbox.setState((s) => ({ items: s.items.filter((i) => i.id !== id) }))
  idb('outbox', 'readwrite', (s) => s.delete(id)).catch(() => {})
}

// ---------------------------------------------------------------------------
// Ações da interface
// ---------------------------------------------------------------------------

export function enqueue(sessionId: string, text: string, attachments: AttachmentPayload[], options?: RunOptions, next?: boolean): void {
  const item: OutboxItem = { id: crypto.randomUUID(), sessionId, text, attachments, options, next, createdAt: Date.now(), status: 'queued' }
  useOutbox.setState((s) => ({ items: [...s.items, item] }))
  save(item)
  void flush()
}

export function retryItem(id: string): void {
  update(id, { status: 'queued', error: undefined })
  void flush()
}

/** Desiste de uma mensagem na fila ou que falhou; a que está saindo agora não dá mais para segurar. */
export function discard(id: string): void {
  if (useOutbox.getState().items.find((i) => i.id === id)?.status !== 'sending') remove(id)
}

// ---------------------------------------------------------------------------
// Envio: em ordem, uma de cada vez, só com o PC alcançável.
// ---------------------------------------------------------------------------

// O processo do painel caiu (ou o serviço reiniciou) enquanto a mensagem esperava.
const NOT_OPEN = new Set(['not_open_in_panel', 'session_exited', 'session_closed'])

let flushing = false
let retry = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined

/** Rede fora, pedido expirado ou o proxy do Tailscale sem alcançar o serviço: tenta de novo depois. */
function transient(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true
  return err.status === 408 || err.status === 429 || err.status >= 502
}

async function deliver(item: OutboxItem): Promise<void> {
  const bytes = item.attachments.reduce((n, a) => n + a.data.length, 0)
  const queue = item.next ? { next: true, model: item.options?.model, effort: item.options?.effort } : {}
  const body = { text: item.text, attachments: item.attachments, clientId: item.id, ...queue }
  // Folga para anexos grandes em rede lenta (~50 KB/s); passou disso, a conexão travou.
  const send = () => api.send(item.sessionId, body, AbortSignal.timeout(30_000 + bytes / 50))
  try {
    await send()
  } catch (err) {
    if (!(err instanceof ApiError && NOT_OPEN.has(err.code))) throw err
    // Conversa parada, ou aberta e ociosa no terminal do PC (que é encerrado): retoma aqui e envia.
    await api.takeover(item.sessionId, item.options)
    await send()
  }
}

async function flush(): Promise<void> {
  if (flushing) return
  flushing = true
  clearTimeout(retryTimer)
  try {
    for (;;) {
      if (useStore.getState().connection !== 'open' || !navigator.onLine) return
      const item = useOutbox.getState().items.find((i) => i.status === 'queued')
      if (!item) return
      update(item.id, { status: 'sending' }, false)
      try {
        await deliver(item)
        remove(item.id)
        retry = 0
      } catch (err) {
        if (transient(err)) {
          update(item.id, { status: 'queued' }, false)
          retryTimer = setTimeout(flush, Math.min(30_000, 2_000 * 2 ** retry++))
          return
        }
        const error = errorMessage(err)
        update(item.id, { status: 'failed', error })
        toast.error('Mensagem não enviada', { description: error })
      }
    }
  } finally {
    flushing = false
  }
}

async function load(): Promise<void> {
  const saved = await idb<OutboxItem[]>('outbox', 'readonly', (s) => s.getAll()).catch(() => [])
  // Envio interrompido pelo app fechando: volta para a fila.
  const restored = saved.map((i) => (i.status === 'sending' ? { ...i, status: 'queued' as const } : i))
  useOutbox.setState((s) => {
    const known = new Set(s.items.map((i) => i.id))
    const items = [...restored.filter((i) => !known.has(i.id)), ...s.items]
    return { items: items.sort((a, b) => a.createdAt - b.createdAt) }
  })
  void flush()
}

let started = false

export function startOutbox(): void {
  if (started) return
  started = true
  void load()
  useStore.subscribe((s, prev) => {
    // Conexão com alguma máquina de volta: manda o que ficou na fila, sem esperar o intervalo de nova tentativa.
    if (Object.entries(s.connections).some(([m, c]) => c === 'open' && prev.connections[m] !== 'open')) {
      retry = 0
      void flush()
    }
    // Conversa bifurcada que ganhou ID novo: o que estava na fila segue para ela.
    if (s.rekeys !== prev.rekeys) {
      for (const i of useOutbox.getState().items) {
        const to = s.rekeys[i.sessionId]
        if (to) update(i.id, { sessionId: to })
      }
    }
  })
}
