import { create } from 'zustand'

// Barra lateral do PC (a lista ao lado da alça, ver components/sidebar-rail.tsx) recolhida: a escolha fica salva.
const KEY = 'cr:sidebar-collapsed'

function saved(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

// Largura da lista no PC, arrastando a margem entre a barra lateral e a casca (ver App.tsx).
const WIDTH_KEY = 'cr:sidebar-width'
export const SIDEBAR_WIDTH = 320
export const SIDEBAR_MIN = 240
export const SIDEBAR_MAX = 560

function savedWidth(): number {
  try {
    const width = Number(localStorage.getItem(WIDTH_KEY))
    return width >= SIDEBAR_MIN && width <= SIDEBAR_MAX ? width : SIDEBAR_WIDTH
  } catch {
    return SIDEBAR_WIDTH
  }
}

/** O que a barra lateral do PC mostra ao lado da alça; escolhido pelos ícones dela. */
export type SidebarView = 'sessions' | 'projects'
const VIEW_KEY = 'cr:sidebar-view'

function savedView(): SidebarView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'projects' ? 'projects' : 'sessions'
  } catch {
    return 'sessions'
  }
}

export const useSidebar = create<{ collapsed: boolean; width: number; view: SidebarView }>(() => ({
  collapsed: saved(),
  width: savedWidth(),
  view: savedView(),
}))

/** Abre a barra lateral numa lista. */
export function showSidebarView(view: SidebarView): void {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    // localStorage indisponível (modo privado): vale só nesta tela.
  }
  useSidebar.setState({ view })
  setSidebarCollapsed(false)
}

/** O ícone de uma lista na alça, como na barra de atividades do VS Code: abre a barra nela; já à vista, recolhe. */
export function toggleSidebarView(view: SidebarView): void {
  const state = useSidebar.getState()
  if (!state.collapsed && state.view === view) return setSidebarCollapsed(true)
  showSidebarView(view)
}

export function setSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(KEY, collapsed ? '1' : '0')
  } catch {
    // localStorage indisponível (modo privado): vale só nesta tela.
  }
  useSidebar.setState({ collapsed })
}

export const setSidebarWidth = (width: number) => useSidebar.setState({ width })

/** Fim do arrasto (ou de um passo pelo teclado): a largura fica para a próxima vez. */
export function saveSidebarWidth(): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(useSidebar.getState().width))
  } catch {
    // localStorage indisponível (modo privado): vale só nesta tela.
  }
}
