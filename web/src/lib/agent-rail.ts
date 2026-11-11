import { create } from 'zustand'

/**
 * A aba dos agentes da conversa (components/agents/agent-rail.tsx): recolhida ou aberta. Uma
 * preferência só, deste aparelho, valendo para todas as conversas: quem recolhe quer o chat livre
 * onde estiver, e o sinal de alerta na alça já avisa o que importa.
 */
const KEY = 'cr:agent-rail'

function load(): { collapsed: boolean } {
  try {
    return { collapsed: localStorage.getItem(KEY) === 'collapsed' }
  } catch {
    return { collapsed: false }
  }
}

export const useAgentRail = create<{ collapsed: boolean }>(load)

export function setAgentRailCollapsed(collapsed: boolean): void {
  useAgentRail.setState({ collapsed })
  try {
    localStorage.setItem(KEY, collapsed ? 'collapsed' : 'open')
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}
