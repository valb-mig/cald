import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from './api'
import { onChanged } from './changes'
import { machineOf } from './machines'
import type { MemorySuggestion } from './types'

/**
 * As memórias que o Claude quis guardar em cada conversa e esperam você (ver
 * server/src/memory-suggestions.ts), e de qual conversa a lista está aberta: a linha da ferramenta no
 * chat abre a mesma lista do botão do topo.
 */
type State = { bySession: Record<string, MemorySuggestion[]>; open: string | null }
export const useMemorySuggestions = create<State>(() => ({ bySession: {}, open: null }))

const EMPTY: MemorySuggestion[] = []
// Só a última leitura de cada conversa vale: uma que saiu antes de uma mudança e chega depois traria o de antes.
const latest = new Map<string, number>()
let reads = 0

const setList = (sessionId: string, list: (old: MemorySuggestion[]) => MemorySuggestion[]) =>
  useMemorySuggestions.setState((s) => ({ bySession: { ...s.bySession, [sessionId]: list(s.bySession[sessionId] ?? EMPTY) } }))

export function loadMemorySuggestions(sessionId: string): Promise<void> {
  const n = ++reads
  latest.set(sessionId, n)
  return api.memorySuggestions(sessionId).then(
    (list) => {
      if (latest.get(sessionId) === n) setList(sessionId, () => list)
    },
    // Máquina com o cald de antes, sem sugestões: o botão só não aparece.
    () => {},
  )
}

// Quantos na tela usam as sugestões de cada conversa (o botão e a folha, em cada conversa aberta): a
// conversa é lida uma vez ao entrar na tela e uma vez a cada mudança, e não uma vez por quem a usa.
const watching = new Map<string, number>()
let listening = false

function watch(sessionId: string): () => void {
  const n = watching.get(sessionId) ?? 0
  watching.set(sessionId, n + 1)
  if (!n) void loadMemorySuggestions(sessionId)
  if (!listening) {
    listening = true
    onChanged((machine, c) => {
      if (c.what === 'memory-suggestions' && c.session && watching.has(c.session) && machine === machineOf(c.session))
        void loadMemorySuggestions(c.session)
    })
  }
  return () => {
    const left = (watching.get(sessionId) ?? 1) - 1
    if (left) watching.set(sessionId, left)
    else watching.delete(sessionId)
  }
}

/** As sugestões da conversa, recarregadas quando mudam (o Claude sugeriu outra, ou outro aparelho respondeu). */
export function useSessionMemorySuggestions(sessionId: string): MemorySuggestion[] {
  const list = useMemorySuggestions((s) => s.bySession[sessionId])
  useEffect(() => watch(sessionId), [sessionId])
  return list ?? EMPTY
}

export const openMemorySuggestions = (sessionId: string) => useMemorySuggestions.setState({ open: sessionId })
export const closeMemorySuggestions = () => useMemorySuggestions.setState({ open: null })

// Sai da lista na hora; se o servidor recusar, ela volta pela leitura de novo.
async function answer(sessionId: string, id: string, call: Promise<unknown>): Promise<void> {
  setList(sessionId, (list) => list.filter((s) => s.id !== id))
  try {
    await call
  } catch (err) {
    void loadMemorySuggestions(sessionId)
    throw err
  }
}

/** Salva do jeito que veio ou, com `edit`, com a descrição e o texto mudados. */
export const saveMemorySuggestion = (sessionId: string, id: string, edit?: { description: string; body: string }) =>
  answer(sessionId, id, api.saveMemorySuggestion(sessionId, id, edit))

export const dismissMemorySuggestion = (sessionId: string, id: string) => answer(sessionId, id, api.dismissMemorySuggestion(sessionId, id))

export async function restoreMemorySuggestion(sessionId: string, id: string): Promise<void> {
  await api.restoreMemorySuggestion(sessionId, id)
  await loadMemorySuggestions(sessionId)
}

/**
 * O começo dos recados que o Claude recebe (MEMORY_SUGGESTED e INDEX_HELD, no servidor): a memória
 * virou sugestão, ou a linha dela no índice ficou para quando ela for salva.
 */
const SUGGESTED = '[cald] Memória não gravada'
const HELD = '[cald] MEMORY.md não mudado'
type Result = { isError: boolean; text: string }

/** A ferramenta que ia gravar uma memória e virou sugestão. */
export const isMemorySuggested = (result?: Result) => Boolean(result?.isError && result.text.includes(SUGGESTED))

/** Negada pelo cald por causa de uma sugestão (a memória ou a linha dela no índice): no chat, não é erro. */
export const isMemoryHeld = (result?: Result) => Boolean(result?.isError && (result.text.includes(SUGGESTED) || result.text.includes(HELD)))
