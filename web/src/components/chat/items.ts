import type { PanelEvent, Question, Sent } from '@/lib/types'
import { questionsOf } from './questions'

type Of<K extends PanelEvent['kind']> = Extract<PanelEvent, { kind: K }>
/**
 * `ts`: quando chegou ao vivo (o histórico salvo não tem, vem 0). `time`: quando o Claude Code gravou,
 * do transcript; só no histórico.
 */
export type Keyed = PanelEvent & { key: string; ts?: number; uuid?: string; time?: number }

/** A hora de um evento, ao vivo ou do transcript; `undefined` se não se sabe. */
const when = (e: Keyed) => e.ts || e.time || undefined

/** Tudo o que se sabe do subagente pelos eventos `agent`, já juntado. */
export type AgentTask = Omit<Of<'agent'>, 'kind' | 'toolUseId'>

export type ActivityEntry =
  /**
   * `inner` e `task` só nas chamadas que criam subagentes (Agent/Task): o que ele fez fica dentro dela.
   * `answer` só na AskUserQuestion respondida pelo painel: a resposta do pedido, já estruturada.
   */
  | {
      kind: 'tool'
      key: string
      use: Of<'tool_use'>
      result?: Of<'tool_result'>
      /** Quando chegou ao vivo: só ele diz que a ferramenta ainda pode estar rodando agora. */
      at?: number
      /** Quando foi chamada e quando o resultado voltou, ao vivo ou do histórico: quanto levou. */
      started?: number
      finished?: number
      inner?: ActivityEntry[]
      task?: AgentTask
      answer?: Of<'question_resolved'>
    }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'subtext'; key: string; text: string }

export const AGENT_TOOLS = new Set(['Agent', 'Task'])

/** Unidade de renderização do chat; ações consecutivas viram um bloco de atividade. */
export type Item =
  /**
   * `from`: onde cortar para bifurcar a conversa nesta mensagem — a entrada do log logo antes dela.
   * Falta na primeira mensagem (não há o que manter antes) e nas conversas sem UUID no histórico.
   */
  | { type: 'user'; key: string; text: string; images?: string[]; from?: string; sent?: Sent }
  | { type: 'assistant'; key: string; text: string; model?: string; effort?: string }
  | { type: 'notice'; key: string; text: string }
  | { type: 'activity'; key: string; entries: ActivityEntry[] }
  /** `agent`: descrição do subagente que pediu (aprovações de dentro de um subagente). */
  | { type: 'approval'; key: string; req: Of<'approval_request'>; resolution?: Of<'approval_resolved'>['decision']; agent?: string }
  | { type: 'question'; key: string; req: Of<'question_request'>; resolution?: Of<'question_resolved'> }
  | { type: 'result'; key: string; result: Of<'result'> }
  | { type: 'exit'; key: string; error?: string }
  | { type: 'compacting'; key: string }
  /** Um /clear: daqui para cima foi para o lixo, e a conversa segue do zero. */
  | { type: 'cleared'; key: string }

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
  const results = new Map<string, Extract<Keyed, { kind: 'tool_result' }>>()
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
  // As AskUserQuestion da conversa, para cada pedido respondido achar a sua.
  const asks: Extract<ActivityEntry, { kind: 'tool' }>[] = []
  const place = (entry: ActivityEntry, parent: string | null | undefined) => {
    const agent = parent ? agents.get(parent) : undefined
    if (agent) agent.inner!.push(entry)
    else addEntry(entry, entry.key)
  }

  for (const e of events) {
    switch (e.kind) {
      case 'tool_use': {
        const result = results.get(e.id)
        const entry: ActivityEntry = {
          kind: 'tool',
          key: e.key,
          use: e,
          result,
          at: e.ts || undefined,
          started: when(e),
          finished: result && when(result),
        }
        if (AGENT_TOOLS.has(e.name)) {
          entry.inner = []
          entry.task = tasks.get(e.id)
          agents.set(e.id, entry)
        }
        if (e.name === 'AskUserQuestion' && !e.parentToolUseId) asks.push(entry)
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
        push({ type: 'user', key: e.key, text: e.text, images: e.images, from: forks.get(e.key), sent: e.sent })
        break
      case 'notice':
        push({ type: 'notice', key: e.key, text: e.text })
        break
      case 'cleared':
        push({ type: 'cleared', key: e.key })
        break
      case 'approval_request': {
        const parent = e.toolUseId ? uses.get(e.toolUseId)?.parentToolUseId : undefined
        const agent = parent ? uses.get(parent) : undefined
        const name = agent && (String(agent.input.description ?? '') || String(agent.input.subagent_type ?? ''))
        push({ type: 'approval', key: e.key, req: e, resolution: approvals.get(e.requestId), agent: name || undefined })
        break
      }
      case 'question_request': {
        // Respondida: a resposta vai para a linha da própria AskUserQuestion, que passa a mostrá-la, e o
        // cartão sai; senão a pergunta apareceria duas vezes, e o bloco de atividade ficaria partido.
        // Pendente (ou sem a linha dela), segue o cartão, que é onde se responde.
        const resolution = questions.get(e.requestId)
        const ask = resolution && asks.findLast((a) => !a.answer && sameQuestions(a.use.input, e.questions))
        if (ask) ask.answer = resolution
        else push({ type: 'question', key: e.key, req: e, resolution })
        break
      }
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

/** Se o input da AskUserQuestion traz as mesmas perguntas do pedido, na mesma ordem. */
function sameQuestions(input: Record<string, unknown>, asked: Question[]): boolean {
  const own = questionsOf(input)
  return own.length === asked.length && own.every((q, i) => q.question === asked[i]!.question)
}
