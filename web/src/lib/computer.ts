import { create } from 'zustand'

/** As seções do painel (ver SECTIONS em components/computer-sheet.tsx). */
export type ComputerSection = 'status' | 'agents' | 'worktrees' | 'access' | 'alerts' | 'look' | 'about'

/** As abas da página de um agente, na seção Agentes: só aparecem as que ele oferece (ver lib/providers.ts). */
export type AgentTab = 'geral' | 'usage' | 'memory' | 'skills' | 'mcp'

/**
 * As seções de antes dos agentes, que eram do Claude e viraram abas da página dele: quem ainda pede
 * uma (um atalho, um link salvo) cai em Agentes → Claude Code → a aba.
 */
type ClaudeSection = 'usage' | 'memory' | 'skills' | 'mcp'
const isClaudeSection = (s: string): s is ClaudeSection => s === 'usage' || s === 'memory' || s === 'skills' || s === 'mcp'

type State = {
  open: boolean
  section: ComputerSection
  /** O agente aberto na seção Agentes; `null` é a lista deles. */
  agent: string | null
  agentTab: AgentTab
}

/**
 * O painel Computador (sistema, agentes, notificações, sons, tema) abre por cima da tela em que você
 * está, em vez de ser uma página: dá para conferir o PC ou mudar um ajuste sem sair da conversa.
 */
export const useComputer = create<State>(() => ({ open: false, section: 'status', agent: null, agentTab: 'geral' }))

/** Onde a seção pedida leva; as antigas do Claude abrem a página dele (o `CLAUDE` de lib/providers.ts). */
function placeOf(section: ComputerSection | ClaudeSection): Pick<State, 'section' | 'agent' | 'agentTab'> {
  if (isClaudeSection(section)) return { section: 'agents', agent: 'claude', agentTab: section }
  return { section, agent: null, agentTab: 'geral' }
}

/** Abre no Status, ou na seção pedida; fechar mantém a seção, para ela não trocar durante a saída. */
export function setComputerOpen(open: boolean, section: ComputerSection | ClaudeSection = 'status'): void {
  useComputer.setState(open ? { open, ...placeOf(section) } : { open })
}

/** Troca de seção; a de Agentes começa na lista deles. */
export function setComputerSection(section: ComputerSection | ClaudeSection): void {
  useComputer.setState(placeOf(section))
}

/** Abre o painel já na página de um agente, numa aba (o "Uso do Claude" do início abre no uso dele). */
export function openComputerAgent(agent: string, tab: AgentTab = 'geral'): void {
  useComputer.setState({ open: true, section: 'agents', agent, agentTab: tab })
}

/** Dentro da seção Agentes: a página de um agente, ou a lista com `null`. */
export function setComputerAgent(agent: string | null, tab: AgentTab = 'geral'): void {
  useComputer.setState({ section: 'agents', agent, agentTab: tab })
}

export function setAgentTab(tab: AgentTab): void {
  useComputer.setState({ agentTab: tab })
}

/** O nome de cada seção no endereço (`?computador=acesso`); as do Claude continuam valendo. */
const SLUGS: Record<string, ComputerSection | ClaudeSection> = {
  status: 'status',
  agentes: 'agents',
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
