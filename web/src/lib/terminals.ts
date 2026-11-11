import { create } from 'zustand'
import { openBottomPanel } from './bottom-panel'

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

/** Abre uma aba nova na pasta e põe ela à vista; devolve o id, para mandar algo rodar nela (ver `runCommand`). */
export function newTerminal(place: { machine: string; cwd: string }): string {
  const tab: TermTab = { id: newId(), machine: place.machine, cwd: place.cwd }
  useTerminals.setState((s) => ({ tabs: [...s.tabs, tab], active: tab.id }))
  return tab.id
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
  waiting.delete(id)
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

/** A barra dos comandos salvos ao lado do terminal (ver components/terminal-commands.tsx): aberta ou fechada, lembrada neste aparelho. Nasce aberta, para ser vista. */
const BAR_KEY = 'cr:terminal-commands'

function loadBar(): boolean {
  try {
    return (JSON.parse(localStorage.getItem(BAR_KEY) ?? '{}') as { open?: boolean }).open !== false
  } catch {
    return true
  }
}

export const useCommandsBar = create<{ open: boolean }>(() => ({ open: loadBar() }))

export function toggleCommandsBar(): void {
  useCommandsBar.setState((s) => ({ open: !s.open }))
  try {
    localStorage.setItem(BAR_KEY, JSON.stringify(useCommandsBar.getState()))
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}

// ---- mandar texto para um terminal ----

/** O que um terminal aberto e conectado oferece ao resto do app (ver TerminalView). */
export type TermBridge = {
  /** Cola como o Ctrl+V: o xterm faz o "bracketed paste", e o shell não roda nada sozinho. */
  paste: (text: string) => void
  /** Manda direto ao shell, como se fosse digitado (o `\r` é o Enter). */
  send: (data: string) => void
  focus: () => void
}

const bridges = new Map<string, TermBridge>()
type Job = { at: number; run: (bridge: TermBridge) => void }
/** O que foi pedido a uma aba antes de ela conectar (uma aba nova, um shell reconectando). */
const waiting = new Map<string, Job[]>()
// Pedido mais velho que isso não sai mais: a aba que não conectou a tempo não roda, minutos depois, um comando esquecido.
const STALE = 30_000

/** O terminal da aba `id` está pronto para receber; o que esperava por ele sai agora. Devolve como desligar. */
export function registerTerminal(id: string, bridge: TermBridge): () => void {
  bridges.set(id, bridge)
  const jobs = waiting.get(id) ?? []
  waiting.delete(id)
  for (const job of jobs) if (Date.now() - job.at < STALE) job.run(bridge)
  return () => {
    if (bridges.get(id) === bridge) bridges.delete(id)
  }
}

/** Cola `command` na aba `id` e, com `enter`, roda; se ela ainda não conectou, espera por ela. */
export function runCommand(id: string, command: string, { enter }: { enter: boolean }): void {
  // A quebra de linha do fim rodaria o comando mesmo no "colar sem rodar".
  const text = command.replace(/\s+$/, '')
  const run = (bridge: TermBridge) => {
    bridge.paste(text)
    if (enter) bridge.send('\r')
    bridge.focus()
  }
  const bridge = bridges.get(id)
  if (bridge) return run(bridge)
  waiting.set(id, [...(waiting.get(id) ?? []), { at: Date.now(), run }])
}

/**
 * Roda (ou só cola) `command` num terminal na pasta `place`, com o painel de baixo aberto nele: na aba
 * livre que já está ali (a à vista primeiro), ou numa nova. É o ▷ dos comandos do chat (ver
 * components/markdown.tsx), que rodam onde a conversa está, e não onde o terminal à vista estiver.
 */
export function runInFolder(place: { machine: string; cwd: string }, command: string, { enter, newTab = false }: { enter: boolean; newTab?: boolean }): void {
  const { tabs, active } = useTerminals.getState()
  const busy = useTermActivity.getState()
  const here = newTab
    ? undefined
    : [...tabs]
        .sort((a, b) => Number(b.id === active) - Number(a.id === active))
        .find((t) => t.machine === place.machine && (t.here ?? t.cwd) === place.cwd && busy[t.id] !== 'running')
  if (here) selectTerminal(here.id)
  const id = here?.id ?? newTerminal(place)
  openBottomPanel()
  runCommand(id, command, { enter })
}

/**
 * Roda (ou só cola) na aba à vista. Ocupada com um comando (um `pnpm dev`, por exemplo), o texto iria
 * para ele, e não para o shell: abre outra aba na mesma pasta e roda lá. `newTab` abre outra sempre.
 */
export function runInTerminal(command: string, { enter, newTab = false }: { enter: boolean; newTab?: boolean }): void {
  const { tabs, active } = useTerminals.getState()
  const tab = tabs.find((t) => t.id === active)
  if (!tab) return
  const busy = useTermActivity.getState()[tab.id] === 'running'
  const id = newTab || busy ? newTerminal({ machine: tab.machine, cwd: tab.here ?? tab.cwd }) : tab.id
  runCommand(id, command, { enter })
}
