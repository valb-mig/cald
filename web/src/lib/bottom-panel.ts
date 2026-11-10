import { create } from 'zustand'

/**
 * O painel de baixo, no PC, como o do VSCode: aberto pela barra de status, embaixo das conversas,
 * com o terminal do projeto. Aberto e a altura ficam salvos neste aparelho.
 */
export const PANEL_HEIGHT = 260
export const PANEL_MIN_HEIGHT = 120

type Saved = { open: boolean; height: number }
const KEY = 'cr:bottom-panel'

function load(): Saved {
  const fallback: Saved = { open: false, height: PANEL_HEIGHT }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>
    return {
      open: raw.open === true,
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

/** O botão da barra de status: abre o painel; aberto, fecha. */
export function toggleBottomPanel(): void {
  useBottomPanel.setState((s) => ({ open: !s.open }))
  saveBottomPanel()
}

export const setBottomHeight = (height: number) => useBottomPanel.setState({ height })
