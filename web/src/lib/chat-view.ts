import { create } from 'zustand'

/** Como se acompanha a conversa: `vibing` é o chat de sempre; `coding` soma o que ajuda a ver como a IA decide. */
export type ChatView = 'vibing' | 'coding'

const KEY = 'cr:coding'
const WIDTH_KEY = 'cr:trail-width'

function load(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}

// Só as conversas em coding ficam na lista: vibing é o padrão e não ocupa espaço.
const useCoding = create<{ ids: string[] }>(() => ({ ids: load() }))

export const useChatView = (sessionId: string): ChatView => useCoding((s) => (s.ids.includes(sessionId) ? 'coding' : 'vibing'))

export function setChatView(sessionId: string, view: ChatView): void {
  const rest = useCoding.getState().ids.filter((id) => id !== sessionId)
  const ids = view === 'coding' ? [...rest, sessionId] : rest
  save(KEY, JSON.stringify(ids))
  useCoding.setState({ ids })
}

/** Largura do painel de passos, em px; uma preferência do aparelho, como a do mapa. */
export const TRAIL_WIDTH = 460

function savedWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY))
    return saved > 0 ? saved : TRAIL_WIDTH
  } catch {
    return TRAIL_WIDTH
  }
}

export const useTrailWidth = create<{ width: number }>(() => ({ width: savedWidth() }))

export const setTrailWidth = (width: number) => useTrailWidth.setState({ width })

/** Grava a largura no fim do arrasto, não a cada movimento do mouse. */
export const saveTrailWidth = () => save(WIDTH_KEY, String(useTrailWidth.getState().width))

const SPLIT_KEY = 'cr:trail-split'
const SIDE_KEY = 'cr:code-side'

/** Quanto da altura do painel é da visão de código; o resto são os passos. */
export const TRAIL_SPLIT = 0.55

function savedSplit(): number {
  try {
    const saved = Number(localStorage.getItem(SPLIT_KEY))
    return saved > 0 && saved < 1 ? saved : TRAIL_SPLIT
  } catch {
    return TRAIL_SPLIT
  }
}

export const useTrailSplit = create<{ code: number }>(() => ({ code: savedSplit() }))

export const setTrailSplit = (code: number) => useTrailSplit.setState({ code })

export const saveTrailSplit = () => save(SPLIT_KEY, String(useTrailSplit.getState().code))

/** A árvore de arquivos ao lado do código: aberta ou fechada, por aparelho. */
function savedSide(): boolean {
  try {
    return localStorage.getItem(SIDE_KEY) === '1'
  } catch {
    return false
  }
}

export const useCodeSide = create<{ open: boolean }>(() => ({ open: savedSide() }))

export function setCodeSide(open: boolean): void {
  save(SIDE_KEY, open ? '1' : '0')
  useCodeSide.setState({ open })
}

/** As três telas do modo coding e os três lugares fixos delas: uma principal, à esquerda, e duas na coluna da direita. */
export type Screen = 'chat' | 'code' | 'steps'
export type Slot = 'main' | 'top' | 'bottom'
export type Slots = Record<Slot, Screen>

const SLOTS_KEY = 'cr:coding-slots'
const COLLAPSED_KEY = 'cr:coding-collapsed'
const DEFAULT_SLOTS: Slots = { main: 'chat', top: 'code', bottom: 'steps' }

function savedSlots(): Slots {
  try {
    const saved = JSON.parse(localStorage.getItem(SLOTS_KEY) ?? 'null') as Partial<Slots> | null
    const list = saved ? [saved.main, saved.top, saved.bottom] : []
    // Só vale se cada tela aparece uma vez: qualquer outra coisa volta ao padrão.
    if (list.length === 3 && (['chat', 'code', 'steps'] as const).every((s) => list.includes(s))) return saved as Slots
  } catch {
    // localStorage indisponível ou lixo: o padrão.
  }
  return DEFAULT_SLOTS
}

function savedCollapsed(): { code: boolean; steps: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}') as { code?: unknown; steps?: unknown }
    return { code: saved.code === true, steps: saved.steps === true }
  } catch {
    return { code: false, steps: false }
  }
}

export const useCodingSlots = create<{ slots: Slots; collapsed: { code: boolean; steps: boolean } }>(() => ({ slots: savedSlots(), collapsed: savedCollapsed() }))

function persist() {
  const { slots, collapsed } = useCodingSlots.getState()
  save(SLOTS_KEY, JSON.stringify(slots))
  save(COLLAPSED_KEY, JSON.stringify(collapsed))
}

/** Troca os lugares de duas telas. Uma recolhida que vai para a principal abre: recolher só vale fora dela. */
export function swapScreens(a: Screen, b: Screen): void {
  const { slots, collapsed } = useCodingSlots.getState()
  const next = { ...slots }
  for (const k of ['main', 'top', 'bottom'] as const) next[k] = slots[k] === a ? b : slots[k] === b ? a : slots[k]
  const open = { ...collapsed }
  if (next.main !== 'chat') open[next.main] = false
  useCodingSlots.setState({ slots: next, collapsed: open })
  persist()
}

export function setScreenCollapsed(screen: 'code' | 'steps', value: boolean): void {
  const { slots, collapsed } = useCodingSlots.getState()
  if (slots.main === screen) return
  useCodingSlots.setState({ collapsed: { ...collapsed, [screen]: value } })
  persist()
}
