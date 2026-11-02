import { create } from 'zustand'

/**
 * O painel de baixo, no PC, como o do VSCode: aberto pela barra de status, embaixo das conversas.
 * Duas abas: os comandos que o Claude rodou na conversa em foco, com a resposta de cada um, e o
 * terminal do projeto. Aberto, a aba e a altura ficam salvos neste aparelho.
 */
export type BottomTab = 'commands' | 'terminal'

export const PANEL_HEIGHT = 260
export const PANEL_MIN_HEIGHT = 120

type Saved = { open: boolean; tab: BottomTab; height: number }
const KEY = 'cr:bottom-panel'

function load(): Saved {
  const fallback: Saved = { open: false, tab: 'commands', height: PANEL_HEIGHT }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>
    return {
      open: raw.open === true,
      tab: raw.tab === 'terminal' ? 'terminal' : 'commands',
      height: typeof raw.height === 'number' && raw.height >= PANEL_MIN_HEIGHT ? raw.height : fallback.height,
    }
  } catch {
    return fallback
  }
}

export const useBottomPanel = create<Saved>(load)

export function saveBottomPanel(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(useBottomPanel.getState()))
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}

/** O botão da barra de status: abre o painel na aba dele; já aberto nela, fecha. */
export function toggleBottomPanel(tab: BottomTab): void {
  const s = useBottomPanel.getState()
  useBottomPanel.setState(s.open && s.tab === tab ? { open: false } : { open: true, tab })
  saveBottomPanel()
}

export const setBottomHeight = (height: number) => useBottomPanel.setState({ height })
