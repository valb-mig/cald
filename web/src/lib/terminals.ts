import { create } from 'zustand'

/**
 * As abas do terminal, no painel de baixo (ver components/terminal.tsx). Cada uma é um shell no PC que
 * segue vivo lá mesmo com o app travado, recarregado ou fechado (ver server/src/terminal.ts): a aba
 * volta a ele pelo id. Não seguem a conversa em foco: trocar de aba nas conversas não troca de terminal,
 * e o "+" abre um novo na pasta da conversa ou do projeto em foco. Ficam salvas neste aparelho.
 */
export type TermTab = {
  id: string
  machine: string
  /** Onde o shell abriu (e reabre, se o PC tiver sido reiniciado). */
  cwd: string
  /** Onde ele está agora, pelo `cd` (a marca OSC 7 do shell): é o nome que a aba mostra. */
  here?: string
}

type Saved = { tabs: TermTab[]; active: string | null }

const KEY = 'cr:terminals'

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>
    const tabs = Array.isArray(raw.tabs)
      ? raw.tabs.filter((t): t is TermTab => Boolean(t && typeof t.id === 'string' && typeof t.machine === 'string' && typeof t.cwd === 'string'))
      : []
    const active = tabs.some((t) => t.id === raw.active) ? raw.active! : (tabs[0]?.id ?? null)
    return { tabs, active }
  } catch {
    return { tabs: [], active: null }
  }
}

export const useTerminals = create<Saved>(load)

useTerminals.subscribe(() => {
  try {
    localStorage.setItem(KEY, JSON.stringify(useTerminals.getState()))
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
})

const newId = (): string =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`

export function newTerminal(place: { machine: string; cwd: string }): void {
  const tab: TermTab = { id: newId(), machine: place.machine, cwd: place.cwd }
  useTerminals.setState((s) => ({ tabs: [...s.tabs, tab], active: tab.id }))
}

export const selectTerminal = (id: string) => useTerminals.setState({ active: id })

/** Fecha a aba (e o shell dela no PC, ver TerminalView); a vizinha da direita, ou a da esquerda, fica à vista. */
export function closeTerminal(id: string): void {
  useTerminals.setState((s) => {
    const index = s.tabs.findIndex((t) => t.id === id)
    if (index < 0) return s
    const tabs = s.tabs.filter((t) => t.id !== id)
    const active = s.active === id ? (tabs[index] ?? tabs[index - 1])?.id ?? null : s.active
    return { tabs, active }
  })
  useTermActivity.setState(({ [id]: _, ...rest }) => rest, true)
}

export function setTerminalHere(id: string, here: string): void {
  useTerminals.setState((s) =>
    s.tabs.some((t) => t.id === id && t.here !== here) ? { tabs: s.tabs.map((t) => (t.id === id ? { ...t, here } : t)) } : s,
  )
}

/** O último comando de cada aba, para a bolinha dela (ver `watchBlocks`); não fica salvo. */
export type TermActivity = 'idle' | 'running' | 'ok' | 'fail'

export const useTermActivity = create<Record<string, TermActivity>>(() => ({}))

export const setTermActivity = (id: string, state: TermActivity) =>
  useTermActivity.getState()[id] !== state && useTermActivity.setState({ [id]: state })
