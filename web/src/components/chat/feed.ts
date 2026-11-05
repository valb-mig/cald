import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { useOutbox } from '@/lib/outbox'
import { selectView, useStore } from '@/lib/store'
import type { LoggedEvent } from '@/lib/types'
import { buildItems, type Keyed } from './items'

/**
 * O que uma conversa mostra, montado do histórico salvo e do ao vivo: a tela da conversa (pages/chat.tsx)
 * e a miniatura dela na mesa do projeto (project/mini-chat.tsx) leem daqui.
 */

/**
 * Histórico salvo da conversa. Com a sessão aberta no painel, o servidor devolve só o que
 * existia antes do processo (o resto vem ao vivo). Aberta no PC, atualiza periodicamente.
 */
function useHistory(id: string, machine: string, panelOpen: boolean, pcOwned: boolean, pcWorking: boolean) {
  const [events, setEvents] = useState<LoggedEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)

  const load = useCallback(async () => {
    const ticket = ++latest.current
    try {
      const result = await api.history(id)
      if (ticket === latest.current) {
        // A atualização periódica quase sempre traz o mesmo histórico: sem trocar o array, nada renderiza.
        setEvents((current) => (current && sameHistory(current, result) ? current : result))
        setError(null)
      }
    } catch (err) {
      if (ticket === latest.current) setError(errorMessage(err))
    }
    // A máquina muda quando o catálogo dela chega (conversa aberta por link direto): busca de novo lá.
  }, [id, machine])

  useEffect(() => {
    void load()
  }, [load, panelOpen])

  useEffect(() => {
    if (!pcOwned) return
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), pcWorking ? 4_000 : 15_000)
    return () => clearInterval(timer)
  }, [load, pcOwned, pcWorking])

  return { events, error }
}

// O histórico salvo só cresce no fim (e a janela das últimas mensagens desliza): bastam as pontas e o tamanho.
function sameHistory(a: LoggedEvent[], b: LoggedEvent[]): boolean {
  if (a.length !== b.length) return false
  if (!a.length) return true
  return a[0]!.uuid === b[0]!.uuid && JSON.stringify(a.at(-1)) === JSON.stringify(b.at(-1))
}

/**
 * Chave de cada evento do histórico: pela mensagem de onde ele veio, não pela posição. A lista são as
 * últimas mensagens, então a posição de todas muda quando chega uma nova, e cada item renderizaria
 * do zero (e o que estava aberto pularia para outro).
 */
function historyKeys(events: LoggedEvent[]): Keyed[] {
  const seen = new Map<string, number>()
  return events.map((e, i) => {
    if (!e.uuid) return { ...e, key: `h${i}` }
    const n = seen.get(e.uuid) ?? 0
    seen.set(e.uuid, n + 1)
    return { ...e, key: `h${e.uuid}-${n}` }
  })
}

/** Chave de um evento ao vivo no chat; a resposta lida sozinha precisa da mesma, para o destaque. */
export const liveKey = (runId: string | undefined, seq: number) => `l${runId}-${seq}`

/**
 * A conversa `id` como a tela a mostra: quem cuida dela (o painel, o PC ou ninguém), o estado, os
 * eventos (histórico e ao vivo), os itens do chat depois do último /clear, o que roda em segundo plano
 * e as mensagens ainda na fila de envio.
 */
export function useConversation(id: string, machine: string) {
  const view = useStore(selectView(id))
  const entry = useStore((s) => s.catalog.find((c) => c.sessionId === id))
  // Logo depois de um /clear, o catálogo ainda não tem o id novo (chega uns 300 ms depois): até lá, a
  // pasta é a da conversa de antes, que é a mesma. Sem ela, a barra do projeto sumia e voltava na queda.
  const cwd = useStore((s) => entry?.cwd ?? s.catalog.find((c) => s.rekeys[c.sessionId] === id)?.cwd)

  // O WebSocket sabe primeiro quando o processo do painel abre ou fecha; o catálogo cobre o resto.
  const panelOpen = view.open === true || (view.open === null && entry?.owner === 'panel')
  const owner = panelOpen ? 'panel' : entry?.owner === 'pc' ? 'pc' : null
  const state = panelOpen ? view.state : entry?.state
  const waitingFor = panelOpen ? view.waitingFor : entry?.waitingFor
  const working = panelOpen && (state === 'running' || state === 'starting')

  const history = useHistory(id, machine, panelOpen, owner === 'pc', entry?.state === 'running')

  const saved = useMemo(() => historyKeys(history.events ?? []), [history.events])
  const events: Keyed[] = useMemo(
    () => [...saved, ...(panelOpen ? view.events.map((e) => ({ ...e, key: liveKey(view.runId, e.seq) })) : [])],
    [saved, panelOpen, view.events, view.runId],
  )
  // Depois de um /clear, a tela mostra só dali para baixo: o que veio antes foi para o lixo.
  const cut = useMemo(() => events.findLastIndex((e) => e.kind === 'cleared'), [events])
  const items = useMemo(() => buildItems(cut >= 0 ? events.slice(cut) : events), [events, cut])
  // O que roda em segundo plano agora (monitores, comandos, subagentes): a última lista do processo do painel.
  const background = useMemo(() => {
    if (!panelOpen) return []
    const last = view.events.findLast((e) => e.kind === 'tasks')
    return last?.kind === 'tasks' ? last.tasks : []
  }, [panelOpen, view.events])
  // Chamadas de ferramenta, para o cartão de segundo plano mostrar o comando e o tipo de cada tarefa.
  const uses = useMemo(() => new Map(events.flatMap((e) => (e.kind === 'tool_use' ? [[e.id, e] as const] : []))), [events])
  const outbox = useOutbox((s) => s.items)
  const queued = useMemo(() => {
    // O evento da mensagem costuma chegar pelo WebSocket antes da resposta do envio: aí ela já saiu da fila.
    const delivered = new Set(view.events.flatMap((e) => (e.kind === 'user' && e.clientId ? [e.clientId] : [])))
    return outbox.filter((i) => i.sessionId === id && !delivered.has(i.id))
  }, [outbox, id, view.events])

  return { view, entry, cwd, panelOpen, owner, state, waitingFor, working, history, events, cut, items, background, uses, queued }
}

// Preferência (o "cadeado") de acompanhar o fim da conversa; vale para todas as sessões.
const FOLLOW_KEY = 'cr:chat-follow'

/**
 * Mantém o feed acompanhando o fim da conversa, de forma robusta.
 * - `follow` (o cadeado) liga/desliga o acompanhamento automático e fica salvo.
 * - Ligado, novas mensagens, streaming, imagens e blocos que crescem grudam no fim. Se o usuário
 *   rola para cima para ler, pausa até ele voltar ao fim (ou tocar em "descer").
 * - `atBottom` diz se já dá para esconder o botão flutuante de "descer".
 */
export function useAutoScroll(deps: unknown[]) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [follow, setFollowState] = useState(() => {
    try {
      return localStorage.getItem(FOLLOW_KEY) !== '0'
    } catch {
      return true
    }
  })
  const [atBottom, setAtBottom] = useState(true)
  // Rolou para cima para ler: segura o acompanhamento até voltar ao fim.
  const paused = useRef(false)

  const nearBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior })
  }, [])

  const onScroll = useCallback(() => {
    const near = nearBottom()
    paused.current = !near
    setAtBottom(near)
  }, [nearBottom])

  // Conteúdo cresceu (markdown, imagens, atividade): gruda no fim se estiver acompanhando.
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const observer = new ResizeObserver(() => {
      if (follow && !paused.current) scrollToBottom()
      setAtBottom(nearBottom())
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [follow, nearBottom, scrollToBottom])

  // Novo item/turno/streaming: gruda no fim se estiver acompanhando.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && follow && !paused.current) el.scrollTop = el.scrollHeight
  }, deps)

  const jumpToBottom = useCallback(() => {
    paused.current = false
    scrollToBottom('smooth')
    setAtBottom(true)
  }, [scrollToBottom])

  const setFollow = useCallback(
    (next: boolean) => {
      try {
        localStorage.setItem(FOLLOW_KEY, next ? '1' : '0')
      } catch {
        // localStorage indisponível (modo privado): segue só em memória.
      }
      setFollowState(next)
      if (next) {
        paused.current = false
        scrollToBottom('smooth')
        setAtBottom(true)
      }
    },
    [scrollToBottom],
  )

  return { scrollRef, contentRef, onScroll, atBottom, follow, setFollow, jumpToBottom }
}
