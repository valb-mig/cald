import { create } from 'zustand'

/** As seções do painel (ver SECTIONS em components/computer-sheet.tsx). */
export type ComputerSection = 'status' | 'usage' | 'memory' | 'skills' | 'mcp' | 'worktrees' | 'access' | 'alerts' | 'look' | 'about'

/**
 * O painel Computador (sistema, limites, notificações, sons, tema) abre por cima da tela em que você
 * está, em vez de ser uma página: dá para conferir o PC ou mudar um ajuste sem sair da conversa.
 */
export const useComputer = create<{ open: boolean; section: ComputerSection }>(() => ({ open: false, section: 'status' }))

/** Abre no Status, ou na seção pedida; fechar mantém a seção, para ela não trocar durante a saída. */
export function setComputerOpen(open: boolean, section: ComputerSection = 'status'): void {
  useComputer.setState(open ? { open, section } : { open })
}

export function setComputerSection(section: ComputerSection): void {
  useComputer.setState({ section })
}

/** O nome de cada seção no endereço (`?computador=acesso`). */
const SLUGS: Record<string, ComputerSection> = {
  status: 'status',
  uso: 'usage',
  memoria: 'memory',
  skills: 'skills',
  mcp: 'mcp',
  worktrees: 'worktrees',
  acesso: 'access',
  avisos: 'alerts',
  aparencia: 'look',
  sobre: 'about',
}

/**
 * Um endereço do app que pede o painel (`/?computador=acesso`, do aviso de aparelho novo): abre ele
 * na seção e devolve o endereço sem o parâmetro; `null` se o endereço não pede o painel.
 */
export function openComputerLink(url: string): string | null {
  const u = new URL(url, location.origin)
  const slug = u.searchParams.get('computador')
  if (slug === null) return null
  u.searchParams.delete('computador')
  setComputerOpen(true, SLUGS[slug] ?? 'status')
  return u.pathname + u.search + u.hash
}
