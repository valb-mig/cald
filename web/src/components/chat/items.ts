import type { PanelEvent } from '@/lib/types'

type Of<K extends PanelEvent['kind']> = Extract<PanelEvent, { kind: K }>
/** `ts`: quando chegou ao vivo (o histórico salvo não tem, vem 0). */
export type Keyed = PanelEvent & { key: string; ts?: number; uuid?: string }

/** Tudo o que se sabe do subagente pelos eventos `agent`, já juntado. */
export type AgentTask = Omit<Of<'agent'>, 'kind' | 'toolUseId'>

export type ActivityEntry =
  /** `inner` e `task` só nas chamadas que criam subagentes (Agent/Task): o que ele fez fica dentro dela. */
  | { kind: 'tool'; key: string; use: Of<'tool_use'>; result?: Of<'tool_result'>; at?: number; inner?: ActivityEntry[]; task?: AgentTask }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'subtext'; key: string; text: string }

export const AGENT_TOOLS = new Set(['Agent', 'Task'])

/** Unidade de renderização do chat; ações consecutivas viram um bloco de atividade. */
export type Item =
  /**
   * `from`: onde cortar para bifurcar a conversa nesta mensagem — a entrada do log logo antes dela.
   * Falta na primeira mensagem (não há o que manter antes) e nas conversas sem UUID no histórico.
   */
  | { type: 'user'; key: string; text: string; images?: string[]; from?: string }
  | { type: 'assistant'; key: string; text: string; model?: string; effort?: string }
  | { type: 'notice'; key: string; text: string }
  | { type: 'activity'; key: string; entries: ActivityEntry[] }
  /** `agent`: descrição do subagente que pediu (aprovações de dentro de um subagente). */
  | { type: 'approval'; key: string; req: Of<'approval_request'>; resolution?: Of<'approval_resolved'>['decision']; agent?: string }
  | { type: 'question'; key: string; req: Of<'question_request'>; resolution?: Of<'question_resolved'> }
  | { type: 'result'; key: string; result: Of<'result'> }
  | { type: 'exit'; key: string; error?: string }
  | { type: 'compacting'; key: string }

/**
 * Para cada mensagem do usuário, a entrada do log imediatamente anterior a ela: é onde uma
 * bifurcação corta, mantendo tudo até ali e descartando a mensagem e o que veio depois.
 */
function forkPoints(events: Keyed[]): Map<string, string> {
  const at = new Map<string, string>()
  let previous: string | undefined
  for (const e of events) {
    if (!e.uuid) continue
    if (e.kind === 'user' && previous && previous !== e.uuid) at.set(e.key, previous)
    previous = e.uuid
  }
  return at
}

export function buildItems(events: Keyed[]): Item[] {
  const forks = forkPoints(events)
  const results = new Map<string, Of<'tool_result'>>()
  const approvals = new Map<string, Of<'approval_resolved'>['decision']>()
  const questions = new Map<string, Of<'question_resolved'>>()
  const tasks = new Map<string, AgentTask>()
  const uses = new Map<string, Of<'tool_use'>>()
  for (const e of events) {
    if (e.kind === 'tool_result') results.set(e.toolUseId, e)
    if (e.kind === 'approval_resolved') approvals.set(e.requestId, e.decision)
    if (e.kind === 'question_resolved') questions.set(e.requestId, e)
    if (e.kind === 'tool_use') uses.set(e.id, e)
    if (e.kind === 'agent') {
      const { kind: _, toolUseId, ...patch } = e
      tasks.set(toolUseId, { ...tasks.get(toolUseId), ...patch })
    }
  }

  const items: Item[] = []
  let activity: Extract<Item, { type: 'activity' }> | null = null
  const addEntry = (entry: ActivityEntry, key: string) => {
    if (!activity) {
      activity = { type: 'activity', key, entries: [] }
      items.push(activity)
    }
    activity.entries.push(entry)
  }
  const push = (item: Item) => {
    activity = null
    items.push(item)
  }

  // O que cada subagente faz vai para dentro da chamada que o criou, não para o meio do chat.
  const agents = new Map<string, Extract<ActivityEntry, { kind: 'tool' }>>()
  const place = (entry: ActivityEntry, parent: string | null | undefined) => {
    const agent = parent ? agents.get(parent) : undefined
    if (agent) agent.inner!.push(entry)
    else addEntry(entry, entry.key)
  }

  for (const e of events) {
    switch (e.kind) {
      case 'tool_use': {
        const entry: ActivityEntry = { kind: 'tool', key: e.key, use: e, result: results.get(e.id), at: e.ts || undefined }
        if (AGENT_TOOLS.has(e.name)) {
          entry.inner = []
          entry.task = tasks.get(e.id)
          agents.set(e.id, entry)
        }
        place(entry, e.parentToolUseId)
        break
      }
      case 'thinking':
        place({ kind: 'thinking', key: e.key, text: e.text }, e.parentToolUseId)
        break
      case 'assistant':
        if (e.parentToolUseId) place({ kind: 'subtext', key: e.key, text: e.text }, e.parentToolUseId)
        else push({ type: 'assistant', key: e.key, text: e.text, model: e.model, effort: e.effort })
        break
      case 'user':
        push({ type: 'user', key: e.key, text: e.text, images: e.images, from: forks.get(e.key) })
        break
      case 'notice':
        push({ type: 'notice', key: e.key, text: e.text })
        break
      case 'approval_request': {
        const parent = e.toolUseId ? uses.get(e.toolUseId)?.parentToolUseId : undefined
        const agent = parent ? uses.get(parent) : undefined
        const name = agent && (String(agent.input.description ?? '') || String(agent.input.subagent_type ?? ''))
        push({ type: 'approval', key: e.key, req: e, resolution: approvals.get(e.requestId), agent: name || undefined })
        break
      }
      case 'question_request':
        push({ type: 'question', key: e.key, req: e, resolution: questions.get(e.requestId) })
        break
      case 'result':
        push({ type: 'result', key: e.key, result: e })
        break
      case 'exit':
        push({ type: 'exit', key: e.key, error: e.error })
        break
      case 'status':
        if (e.status === 'compacting') push({ type: 'compacting', key: e.key })
        break
    }
  }
  return items
}
