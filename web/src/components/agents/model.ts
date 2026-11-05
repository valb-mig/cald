import { createContext, use } from 'react'
import type { ActivityEntry, Item } from '@/components/chat/items'
import type { ToolEntry } from '@/components/chat/turn'
import { memberSeed } from '@/components/teams/model'
import { toolSummary } from '@/lib/format'
import type { AgentUsage, TeamMember, TeamSnapshot } from '@/lib/types'

export type AgentStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

/** Um subagente da conversa: a chamada da ferramenta Agent que o criou, com o que ele fez e o estado. */
export type AgentNode = {
  /** ID da chamada da ferramenta Agent. */
  id: string
  /** Descrição curta dada pelo Claude ("Encontrar o código de login"). */
  name: string
  /** Tipo do subagente (Explore, general-purpose, um agente seu…). */
  type: string
  prompt: string
  model?: string
  background: boolean
  status: AgentStatus
  /** O que ele está fazendo agora; parado, o começo do relatório ou o motivo. */
  now?: string
  /** Resumo periódico do andamento, feito pelo Claude Code (só com o processo do painel). */
  summary?: string
  /** Ferramenta em uso, ou a última usada. */
  current?: ToolEntry
  /** O que ele fez, na ordem; vazio quando só o transcript salvo tem (ver agent-chat.tsx). */
  entries: ActivityEntry[]
  tools: number
  tokens?: number
  durationMs?: number
  /** Quando foi chamado (só ao vivo). */
  startedAt?: number
  result?: string
  error?: string
  /** ID do transcript salvo (`agent-<id>.jsonl`), quando já se sabe. */
  agentId?: string
  depth: number
  parent?: AgentNode
  children: AgentNode[]
}

export type AgentTree = {
  /** Chamados direto pela conversa principal; os outros ficam em `children`. */
  roots: AgentNode[]
  /** Todos, na ordem em que foram chamados. */
  all: AgentNode[]
  byId: Map<string, AgentNode>
  count: Record<AgentStatus, number>
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Resultado que só confirma que o subagente foi para o segundo plano: o fim dele chega depois. */
function launchedOnly(entry: ToolEntry): boolean {
  if (entry.use.input.run_in_background === true || entry.task?.background) return true
  return /^Async agent launched|working in the background/i.test(entry.result?.text ?? '')
}

/**
 * Resultado da ferramenta Agent como o Claude Code devolve ao modelo: um cabeçalho, o relatório
 * com as linhas recuadas e um rodapé com o ID e o uso. Ao vivo, o relatório limpo vem no evento `agent`;
 * no histórico salvo, só aqui.
 */
export function parseReport(text: string): { report: string; agentId?: string; usage?: AgentUsage } {
  const agentId = text.match(/^agentId: ([\w-]+)/m)?.[1]
  const usage = text.match(/<usage>([\s\S]*?)<\/usage>/)?.[1]
  const num = (key: string) => Number(usage?.match(new RegExp(`${key}: (\\d+)`))?.[1] ?? 0)
  let report = text.replace(/^\[Subagent hand-back\][^\n]*\n/, '').replace(/\n+agentId: [\s\S]*$/, '')
  const lines = report.split('\n')
  if (lines.every((l) => !l.trim() || l.startsWith('  '))) report = lines.map((l) => l.slice(2)).join('\n')
  return {
    report: report.trim(),
    agentId,
    usage: usage ? { tokens: num('subagent_tokens'), toolUses: num('tool_uses'), durationMs: num('duration_ms') } : undefined,
  }
}

function statusOf(entry: ToolEntry, alive: boolean, pending: Set<string>): AgentStatus {
  switch (entry.task?.status) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'stopped'
  }
  if (entry.result && !launchedOnly(entry)) return entry.result.isError ? 'failed' : 'done'
  // Sem processo vivo, quem não terminou não termina mais.
  if (!alive) return 'stopped'
  return (entry.inner ?? []).some((e) => e.kind === 'tool' && pending.has(e.use.id)) ? 'waiting' : 'running'
}

/** Primeira linha com texto de um relatório em markdown, sem marcação. */
function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.replace(/[#>*_`\-\s|]/g, '').length > 0) ?? ''
  return line.replace(/^[#>\s]+|[*_`]/g, '').trim()
}

export function toolLine(tool: ToolEntry): string {
  const name = tool.use.name.startsWith('mcp__') ? tool.use.name.split('__').slice(1).join(' · ') : tool.use.name
  const detail = toolSummary(tool.use.name, tool.use.input)
  return detail ? `${name} · ${detail}` : name
}

function toNode(entry: ToolEntry, parent: AgentNode | undefined, alive: boolean, pending: Set<string>): AgentNode {
  const input = entry.use.input
  const task = entry.task ?? {}
  const status = statusOf(entry, alive, pending)
  const own = (entry.inner ?? []).filter((e): e is ToolEntry => e.kind === 'tool')
  const current = own.findLast((t) => !t.result) ?? own.at(-1)
  const saved = entry.result && !launchedOnly(entry) ? parseReport(entry.result.text) : undefined
  const usage = task.usage ?? saved?.usage
  const result = task.result ?? saved?.report
  const error = task.error ?? (status === 'failed' && entry.result?.isError ? entry.result.text : undefined)

  let now: string | undefined
  if (status === 'waiting') {
    const asking = own.find((t) => pending.has(t.use.id))
    now = asking ? `Pede aprovação: ${toolLine(asking)}` : 'Pede aprovação'
  } else if (status === 'running') {
    // A ferramenta em uso (ou a última); sem nenhuma à vista (sessão do PC), a linha que o Claude Code manda.
    now = current ? toolLine(current) : task.activity
  } else if (status === 'failed') {
    now = firstLine(error ?? result ?? '') || 'Falhou'
  } else if (status === 'stopped') {
    now = 'Interrompido'
  } else {
    now = result ? firstLine(result) : undefined
  }

  return {
    id: entry.use.id,
    name: str(input.description) || str(input.subagent_type) || 'Subagente',
    type: str(input.subagent_type) || 'general-purpose',
    prompt: str(input.prompt),
    model: str(input.model) || undefined,
    background: input.run_in_background === true || Boolean(task.background),
    status,
    now,
    summary: status === 'running' || status === 'waiting' ? task.summary : undefined,
    current,
    entries: entry.inner ?? [],
    tools: Math.max(usage?.toolUses ?? 0, own.length),
    tokens: usage?.tokens,
    durationMs: usage?.durationMs,
    startedAt: entry.at,
    result,
    error,
    agentId: task.agentId ?? saved?.agentId,
    depth: parent ? parent.depth + 1 : 0,
    parent,
    children: [],
  }
}

/**
 * Os subagentes da conversa, em árvore (um subagente pode chamar outros). `alive`: há um processo
 * cuidando da conversa (no painel ou no PC); sem ele, quem não terminou foi interrompido.
 */
export function agentTree(items: Item[], alive: boolean): AgentTree {
  const pending = new Set(items.flatMap((i) => (i.type === 'approval' && !i.resolution && i.req.toolUseId ? [i.req.toolUseId] : [])))
  const all: AgentNode[] = []
  const visit = (entries: ActivityEntry[], parent: AgentNode | undefined, out: AgentNode[]) => {
    for (const e of entries) {
      if (e.kind !== 'tool' || !e.inner) continue
      const node = toNode(e, parent, alive, pending)
      out.push(node)
      all.push(node)
      visit(e.inner, node, node.children)
    }
  }
  const roots: AgentNode[] = []
  for (const item of items) if (item.type === 'activity') visit(item.entries, undefined, roots)

  const count: AgentTree['count'] = { running: 0, waiting: 0, done: 0, failed: 0, stopped: 0 }
  for (const node of all) count[node.status]++
  return { roots, all, byId: new Map(all.map((n) => [n.id, n])), count }
}

export const EMPTY_TREE: AgentTree = agentTree([], false)

/** Agentes da conversa na tela e como abrir um deles; o chat põe, a atividade e os painéis usam. */
/** `team`: o time da conversa, para os subagentes dele aparecerem com o claudinho e o nome do membro. */
export const AgentsContext = createContext<{ tree: AgentTree; open: (id: string) => void; team?: TeamSnapshot } | null>(null)
export const useAgents = () => use(AgentsContext)

/** O membro do time da conversa que este subagente é (pelo `subagent_type`), se for de um. */
export function useMember(node: Pick<AgentNode, 'type'>): TeamMember | undefined {
  return useAgents()?.team?.members.find((m) => m.key === node.type)
}

/** Como chamar o tipo do subagente: o nome (e o papel) do membro do time, ou o tipo de sempre. */
export const typeLabel = (node: Pick<AgentNode, 'type'>, member?: TeamMember) =>
  member ? (member.role ? `${member.name} · ${member.role}` : member.name) : node.type

/** De quem é o claudinho do subagente: o do membro do time, ou um próprio de cada chamada. */
export const agentSeed = (node: Pick<AgentNode, 'id'>, member?: TeamMember) => (member ? memberSeed(member) : node.id)

/** O estado de conversa que o claudinho do subagente imita: piscando enquanto trabalha, olhando para cima esperando você. */
export const agentState = (node: Pick<AgentNode, 'status'>) =>
  node.status === 'running' ? 'running' : node.status === 'waiting' ? 'waiting' : undefined
