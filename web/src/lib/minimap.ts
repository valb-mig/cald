import { create } from 'zustand'

/**
 * Os dois minimapas, como o do VSCode: a linha do tempo da conversa (os seus pedidos ao longo do chat)
 * e o do código aberto. Cada um pode ser recolhido; a escolha é deste aparelho e fica salva.
 */
type MinimapPrefs = { timeline: boolean; code: boolean }

const KEY = 'cr:minimap'
const DEFAULTS: MinimapPrefs = { timeline: true, code: true }

function load(): MinimapPrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<MinimapPrefs>) }
  } catch {
    return DEFAULTS
  }
}

export const useMinimap = create<MinimapPrefs>(load)

export function setMinimap(next: Partial<MinimapPrefs>): void {
  useMinimap.setState(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(useMinimap.getState()))
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}
