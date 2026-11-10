import { createContext, useContext, useMemo } from 'react'
import { useLocation, useSearch } from 'wouter'
import { navigate } from 'wouter/use-browser-location'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { useWide, useWindowWidth, WIDE_QUERY } from './hooks'
import { PANEL_RAIL, useProjectPanel } from './project-panel'
import { useSidebar } from './sidebar'
import { onRekey } from './store'
import { closeChatTabs, focusedChat, keyOf, onWorkbench, openTab, revealChat, swapChatTab, useWorkbench, visibleChats } from './workbench'

/**
 * Conversas lado a lado (split). No celular, a URL guarda as abertas, na ordem da tela: `/s/A?com=B,C`.
 * Assim o voltar desfaz a última abertura ou fechamento, e um link para `/s/A` (notificação) abre só
 * ela. No PC, a tela é a das abas (ver lib/workbench.ts): as ações daqui agem nelas, e a URL só diz a
 * conversa em foco.
 */

/** Largura mínima de cada conversa no PC: a de um celular pequeno, para o qual o chat foi feito. */
export const MIN_CHAT = 340
/** No PC, a alça (`w-16`) fica sempre; a lista de conversas, da largura escolhida, recolhe. */
const RAIL = 64
/** A folga entre as janelas do PC e a casca (`--gap` em index.css), também a largura da divisória entre elas. */
export const GAP = 6
/** A margem em volta das ilhas e entre a alça e a casca (`--frame`), mais a folga em volta das janelas (ver App.tsx). */
const CHROME = 10 * 3 + GAP * 2
const MAX_CHATS = 4

/** Se a tela é a do PC (abas) agora: as ações leem na hora, como a URL. */
const isWide = () => matchMedia(WIDE_QUERY).matches

export function splitUrl(ids: string[]): string {
  const [first, ...rest] = ids
  if (!first) return '/'
  return rest.length ? `/s/${first}?com=${rest.join(',')}` : `/s/${first}`
}

export function parseChats(pathname: string, search: string): string[] {
  const match = /^\/s\/([^/]+)$/.exec(pathname)
  if (!match) return []
  const rest = new URLSearchParams(search).get('com')?.split(',').filter(Boolean) ?? []
  return [...new Set([match[1], ...rest])]
}

// Conversa em foco: a que recebe o que é escolhido na lista ao lado. Tocar numa conversa a põe em foco.
const useFocus = create<{ id: string | null }>(() => ({ id: null }))
export const focusChat = (id: string) => useFocus.setState({ id })

// Toques que trouxeram uma conversa para o foco. O foco muda já no começo do toque, antes de o botão
// tocado reagir; por aqui ele sabe que a conversa não estava em foco (ver ProjectPanelButton).
const focusing = new WeakSet<Event>()
export const markFocusing = (e: Event) => focusing.add(e)
export const broughtFocus = (e: Event) => focusing.has(e)

// ---- ações: leem a URL na hora, então servem em efeitos e callbacks sem ficar velhas ----

const current = () => parseChats(location.pathname, location.search)
const focusedOf = (ids: string[]) => {
  const id = useFocus.getState().id
  return id && ids.includes(id) ? id : ids[0]
}
const go = (ids: string[], replace = false) => navigate(splitUrl(ids), { replace })

/** Abre `id` logo depois da conversa `after` (ou da em foco); se já está aberta, só ganha o foco. */
export function openBeside(id: string, after?: string): void {
  if (isWide()) {
    if (!revealChat(id)) openTab({ kind: 'chat', id }, { beside: true, after: after && keyOf({ kind: 'chat', id: after }) })
    return
  }
  const ids = current()
  focusChat(id)
  if (ids.includes(id)) return
  const at = ids.indexOf(after ?? focusedOf(ids)) + 1 || ids.length
  go([...ids.slice(0, at), id, ...ids.slice(at)])
}

/** Troca a conversa `old` por `id` no mesmo lugar (cópia, sessão que ganhou id novo). */
export function swapChat(old: string, id: string, replace = false): void {
  if (isWide()) return swapChatTab(old, id)
  const ids = current()
  focusChat(id)
  go(ids.includes(id) ? ids : ids.map((x) => (x === old ? id : x)), replace)
}

/** Tira a conversa da tela; fechar a última volta para a lista. Fora da tela, não faz nada. */
export function closeChat(id: string, replace = false): void {
  if (isWide()) {
    closeChatTabs(id)
    // Sem aba nenhuma, a tela das abas não tem o que mostrar: volta para a home.
    if (!useWorkbench.getState().groups.length && onWorkbench(location.pathname)) navigate('/', { replace: true })
    return
  }
  const ids = current()
  if (!ids.includes(id)) return
  const rest = ids.filter((x) => x !== id)
  if (focusedOf(ids) === id && rest.length) focusChat(rest[Math.max(0, ids.indexOf(id) - 1)])
  go(rest, replace)
}

/**
 * Leva a conversa `id` para antes ou depois de `target`, arrastando pelo topo dela. Troca a URL sem
 * criar entrada no histórico: arrumar a tela não é um passo que o voltar deva desfazer.
 */
export function moveChat(id: string, target: string, after: boolean): void {
  const ids = current()
  if (id === target || !ids.includes(id) || !ids.includes(target)) return
  const rest = ids.filter((x) => x !== id)
  const at = rest.indexOf(target) + (after ? 1 : 0)
  go([...rest.slice(0, at), id, ...rest.slice(at)], true)
}

/** Tipo do arrasto de uma conversa pelo topo; só ele é aceito como soltura entre os painéis. */
export const CHAT_DRAG = 'application/x-editr-chat'

/** A conversa sendo arrastada pelo topo, para as outras saberem mostrar onde ela vai cair. */
export const useDraggingChat = create<{ id: string | null }>(() => ({ id: null }))

// ---- tamanho de cada conversa lado a lado ----

/**
 * Quanto cada conversa ocupa, em peso relativo (1 é a parte igual). Arrastar a divisória passa peso
 * de uma para a vizinha. Fica salvo só das conversas abertas, para a lista não crescer para sempre.
 */
const SIZES_KEY = 'cr:split-sizes'

function savedSizes(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(SIZES_KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0))
  } catch {
    return {}
  }
}

export const useSplitSizes = create<{ weights: Record<string, number> }>(() => ({ weights: savedSizes() }))

export function setSplitWeights(patch: Record<string, number>): void {
  useSplitSizes.setState((s) => ({ weights: { ...s.weights, ...patch } }))
}

/**
 * Grava os tamanhos no fim do arrasto, não a cada movimento do mouse; só os de `keep` (por padrão, as
 * conversas na URL; no PC, os grupos de abas), para a lista não crescer para sempre.
 */
export function saveSplitSizes(keep: string[] = current()): void {
  const open = new Set(keep)
  const weights = Object.fromEntries(Object.entries(useSplitSizes.getState().weights).filter(([id]) => open.has(id)))
  try {
    localStorage.setItem(SIZES_KEY, JSON.stringify(weights))
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}

// O /clear dá id novo à conversa: o tamanho dela lado a lado vai junto.
onRekey((from, to) => {
  const { [from]: weight, ...rest } = useSplitSizes.getState().weights
  if (weight === undefined) return
  useSplitSizes.setState({ weights: { ...rest, [to]: weight } })
  saveSplitSizes(current().map((id) => (id === from ? to : id)))
})

// ---- leitura para a tela ----

/**
 * No PC, a largura que sobra para as conversas (e a barra do projeto aberta) depois da alça e da lista
 * à esquerda, da alça da barra do projeto à direita, que fica enquanto há projeto na tela, e das folgas.
 */
export function useMainWidth(): number {
  const width = useWindowWidth()
  const sidebar = useSidebar((s) => (s.collapsed ? RAIL : RAIL + s.width))
  const right = useProjectPanel((s) => (s.project ? PANEL_RAIL : 0))
  return width - sidebar - right - CHROME
}

/** Quantas conversas cabem lado a lado: até 2 no celular; no PC, conforme a largura (até 4). */
export function useMaxChats(): number {
  const width = useWindowWidth()
  const main = useMainWidth()
  if (width < 1024) return 2
  return Math.min(MAX_CHATS, Math.max(1, Math.floor(main / MIN_CHAT)))
}

/**
 * Conversas na tela (vazio fora do chat), a em foco, quantas cabem, quantos lados a tela tem e o link
 * de cada conversa da lista. No PC, vem das abas: as conversas à vista são as abas ativas de cada grupo.
 */
export function useSplit() {
  const [pathname] = useLocation()
  const search = useSearch()
  const urlIds = useMemo(() => parseChats(pathname, search), [pathname, search])
  const max = useMaxChats()
  const focusedId = useFocus((s) => s.id)
  const wide = useWide()
  const tabIds = useWorkbench(useShallow(visibleChats))
  const tabFocused = useWorkbench(focusedChat)
  const groups = useWorkbench((s) => s.groups.length)
  if (wide) {
    // Também na tela das abas sem conversa em foco: as conversas dos outros grupos seguem à vista.
    const onChat = onWorkbench(pathname)
    const ids = onChat ? tabIds : []
    return {
      ids,
      max,
      focused: onChat ? tabFocused : null,
      panes: onChat ? groups : 0,
      canAdd: groups < max,
      // A conversa abre numa aba (de prévia) do grupo em foco; já aberta, só vai para ela.
      hrefFor: (id: string) => `/s/${id}`,
    }
  }
  const focused = focusedId && urlIds.includes(focusedId) ? focusedId : urlIds[0]
  return {
    ids: urlIds,
    max,
    focused,
    panes: urlIds.length,
    canAdd: urlIds.length < max,
    /** Link de uma conversa na lista ao lado: já na tela, fica onde está; senão, toma o lugar da em foco. */
    hrefFor: (id: string) =>
      !urlIds.length ? `/s/${id}` : splitUrl(urlIds.includes(id) ? urlIds : urlIds.map((x) => (x === focused ? id : x))),
  }
}

/** Lugar de uma conversa na tela: se divide a tela com outras, se está em foco e se está encolhida. */
export type Pane = { split: boolean; focused: boolean; collapsed: boolean }

export const PaneContext = createContext<Pane>({ split: false, focused: true, collapsed: false })

export const usePane = () => useContext(PaneContext)
