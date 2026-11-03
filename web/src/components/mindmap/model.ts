import type { AgentStatus, AgentTree } from '@/components/agents/model'
import { AGENT_TOOLS, type ActivityEntry, type Item } from '@/components/chat/items'
import type { ToolEntry } from '@/components/chat/turn'
import { askOf, picked, questionsOf } from '@/components/chat/questions'
import { toolSummary } from '@/lib/format'
import type { Question } from '@/lib/types'

/**
 * Mapa mental da conversa: ela no topo, cada mensagem sua abre um trecho, e dele descem os passos
 * do Claude (o que ele disse que ia fazer, as perguntas, a resposta). O que cada passo tocou
 * (arquivos, comandos, buscas, sites) fica nas pontas da árvore e vira o resumo do cartão dele; os
 * subagentes e as perguntas viram cartões próprios (ver layout.ts).
 */

export type MindKind =
  | 'root'
  | 'turn'
  | 'step'
  | 'answer'
  | 'approval'
  /** Ponto de decisão: uma pergunta que o Claude fez com opções. Desenhado como losango. */
  | 'decision'
  /** Um galho da decisão: o caminho que você tomou ou um que ficou para trás. */
  | 'option'
  | 'agent'
  | 'file'
  | 'command'
  | 'search'
  | 'web'
  | 'tool'
  | 'notice'

export type MindStatus = AgentStatus

/** O estado no pé do cartão do mapa (na tela e na imagem exportada). */
export const STATE_LABEL: Record<MindStatus, string> = {
  done: 'feito',
  running: 'trabalhando',
  waiting: 'espera você',
  failed: 'falhou',
  stopped: 'parou',
}

/** O tipo no canto do cartão. */
export const KIND_LABEL: Partial<Record<MindKind, string>> = {
  root: 'conversa',
  turn: 'você',
  step: 'passo',
  answer: 'resposta',
  approval: 'aprovação',
  decision: 'pergunta',
  agent: 'agente',
}

/** Números do cartão: modelo, consumo e quanto levou; cada tipo de nó preenche o que tem. */
export type MindStats = {
  model?: string
  tokens?: number
  /** Ferramentas que um subagente usou. */
  tools?: number
  durationMs?: number
  /** Quando começou, para contar o tempo ao vivo. */
  startedAt?: number
  costUsd?: number
}

export type MindNode = {
  id: string
  kind: MindKind
  label: string
  /** Segunda linha: "editou +12 −3", "3 comandos · leu 2 arquivos", "4 passos". */
  meta?: string
  /** Num subagente, o resumo do que ele fez (a segunda linha é o tipo dele). */
  detail?: string
  /** O claudinho do nó: o da conversa nos passos do Claude, o próprio em cada subagente. */
  seed?: string
  stats?: MindStats
  /** Ferramenta que deu origem (para o ícone). */
  tool?: string
  status: MindStatus
  /** Galho (turno) a que pertence; dá a cor. O centro é -1. */
  branch: number
  /** Item do chat para onde o toque leva. */
  itemKey?: string
  /** Subagente (abre a folha dele) ou pedido pendente (abre o cartão). */
  agentId?: string
  requestId?: string
  /** Num arquivo: quantas vezes foi lido e editado, e as linhas colocadas e tiradas. */
  reads?: number
  writes?: number
  added?: number
  removed?: number
  /** Num galho de decisão: `true` é o caminho que você tomou, `false` um descartado; sem resposta, nada. */
  chosen?: boolean
  children: MindNode[]
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Primeira frase de um texto em markdown, sem marcação; corta se for longa. */
export function firstSentence(text: string, max = 90): string {
  const line = text.split('\n').find((l) => l.replace(/[#>*_`\-\s|]/g, '').length > 0) ?? ''
  const plain = line.replace(/^[#>\-*\s]+|[*_`]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
  const sentence = plain.match(/^.+?[.!?:](?=\s|$)/)?.[0] ?? plain
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence
}

const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

function hostPath(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return url
  }
}

function toolStatus(e: ToolEntry, pending: Set<string>): MindStatus {
  if (pending.has(e.use.id)) return 'waiting'
  if (!e.result) return 'running'
  return e.result.isError ? 'failed' : 'done'
}

const READS = new Set(['Read'])
const WRITES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
// Encanamento do próprio Claude Code: não diz nada sobre o caminho que ele seguiu.
const HIDDEN = new Set(['ToolSearch'])

function lineCount(text: unknown): number {
  return typeof text === 'string' && text ? text.split('\n').length : 0
}

/** Linhas colocadas e tiradas por uma edição (como no resumo do turno). */
function changed(use: ToolEntry['use']): { added: number; removed: number } {
  const input = use.input
  if (use.name === 'Edit') return { added: lineCount(input.new_string), removed: lineCount(input.old_string) }
  if (use.name === 'Write') return { added: lineCount(input.content), removed: 0 }
  if (use.name === 'NotebookEdit') return { added: lineCount(input.new_source), removed: 0 }
  if (use.name === 'MultiEdit' && Array.isArray(input.edits)) {
    return (input.edits as Record<string, unknown>[]).reduce<{ added: number; removed: number }>(
      (n, e) => ({ added: n.added + lineCount(e.new_string), removed: n.removed + lineCount(e.old_string) }),
      { added: 0, removed: 0 },
    )
  }
  return { added: 0, removed: 0 }
}

/** Junta estados de várias chamadas no mesmo nó: o que pede atenção vence. */
function worst(a: MindStatus, b: MindStatus): MindStatus {
  const rank: MindStatus[] = ['waiting', 'running', 'failed', 'stopped', 'done']
  return rank.indexOf(a) <= rank.indexOf(b) ? a : b
}

/** `scope`: o passo ou subagente dono das pontas (um arquivo aparece uma vez em cada). */
/**
 * `asked`: perguntas que já viraram decisão pelo cartão do pedido ao vivo do painel (as pendentes; as
 * respondidas vão para a linha da ferramenta, ver chat/items.ts). A chamada da ferramenta delas
 * também chega como ação, e sem isto cada pergunta apareceria duas vezes no mapa.
 */
type Ctx = { branch: number; pending: Set<string>; agents: AgentTree; itemKey: string; scope: string; asked: Set<string> }

/**
 * Cada pergunta vira um losango, e cada opção um galho dele: o que você escolheu fica aceso, os que
 * ficaram para trás, apagados. Resposta escrita à mão não bate com nenhuma opção e vira um galho
 * próprio. Sem resposta (pendente ou recusada), os galhos ficam neutros.
 */
function decisions(
  questions: Question[],
  answers: Record<string, string> | undefined,
  base: { id: string; branch: number; itemKey?: string; open: boolean; requestId?: string },
): MindNode[] {
  return questions.map((q, qi) => {
    const id = `${base.id}:d${qi}`
    const answer = answers?.[q.question]?.trim()
    const known = !base.open && answer !== undefined && answer !== ''
    const option = (label: string, i: number | string, chosen: boolean | undefined, meta?: string): MindNode => ({
      id: `${id}:${i}`,
      kind: 'option',
      label,
      meta,
      status: 'done',
      branch: base.branch,
      itemKey: base.itemKey,
      chosen,
      children: [],
    })
    const options = q.options.map((o, i) => option(o.label, i, known ? picked(answer, o.label) : undefined))
    const took = options.filter((o) => o.chosen).length
    if (known && took === 0) options.push(option(answer, 'livre', true, 'sua resposta'))
    return {
      id,
      kind: 'decision',
      label: q.question,
      meta: base.open
        ? 'Pergunta para você'
        : !known
          ? 'Sem resposta'
          : took === 0
            ? 'Respondida com texto seu'
            : q.multiSelect
              ? `Escolheu ${took} de ${q.options.length}`
              : `Escolheu 1 de ${q.options.length}`,
      status: base.open ? 'waiting' : 'done',
      branch: base.branch,
      itemKey: base.itemKey,
      requestId: base.requestId,
      children: options,
    }
  })
}

/** As pontas de um passo: cada arquivo uma vez só (lido e editado juntos), o resto na ordem. */
function leaves(entries: ActivityEntry[], ctx: Ctx): MindNode[] {
  const out: MindNode[] = []
  const files = new Map<string, MindNode & { reads: number; writes: number; added: number; removed: number; created: boolean }>()

  for (const e of entries) {
    if (e.kind !== 'tool' || HIDDEN.has(e.use.name)) continue
    const { name, input } = e.use
    const base = { branch: ctx.branch, itemKey: ctx.itemKey, tool: name, status: toolStatus(e, ctx.pending), children: [] }

    if (name === 'AskUserQuestion') {
      const questions = questionsOf(input)
      // Pergunta com o cartão do painel (pendente): o pedido dela já desenha a decisão, e é por ele que se responde.
      if (questions.length && questions.every((q) => ctx.asked.has(q.question))) continue
      if (questions.length) {
        // Respondida no painel, a resposta estruturada vem junto (ver chat/items.ts); senão, recortada do resultado.
        const { answers } = askOf(input, e.result, e.answer)
        out.push(...decisions(questions, answers, { id: e.use.id, branch: ctx.branch, itemKey: ctx.itemKey, open: !e.result && !e.answer }))
        continue
      }
    }

    if (AGENT_TOOLS.has(name)) {
      const agent = ctx.agents.byId.get(e.use.id)
      const inner = leaves(e.inner ?? [], { ...ctx, scope: e.use.id })
      out.push({
        ...base,
        id: e.use.id,
        kind: 'agent',
        label: str(input.description) || str(input.subagent_type) || 'Subagente',
        meta: [agent?.type ?? (str(input.subagent_type) || undefined), agent?.background && 'segundo plano'].filter(Boolean).join(' · '),
        detail: actionSummary(inner, true),
        seed: e.use.id,
        stats: { model: agent?.model, tokens: agent?.tokens, tools: agent?.tools, durationMs: agent?.durationMs, startedAt: agent?.startedAt },
        status: agent?.status ?? base.status,
        agentId: e.use.id,
        children: inner,
      })
      continue
    }

    const path = str(input.file_path) || str(input.notebook_path)
    if (path && (READS.has(name) || WRITES.has(name))) {
      let file = files.get(path)
      if (!file) {
        file = { ...base, id: `${ctx.scope}:${path}`, kind: 'file', label: basename(path), reads: 0, writes: 0, added: 0, removed: 0, created: false }
        files.set(path, file)
        out.push(file)
      } else {
        file.status = worst(file.status, base.status)
      }
      if (WRITES.has(name)) {
        file.writes++
        file.tool = name
        if (name === 'Write') file.created = true
        if (base.status === 'done') {
          const { added, removed } = changed(e.use)
          file.added += added
          file.removed += removed
        }
      } else {
        file.reads++
      }
      continue
    }

    if (name === 'Bash') {
      out.push({ ...base, id: e.use.id, kind: 'command', label: str(input.description) || str(input.command).split('\n')[0] })
    } else if (name === 'Grep' || name === 'Glob') {
      out.push({ ...base, id: e.use.id, kind: 'search', label: str(input.pattern) })
    } else if (name === 'WebFetch') {
      out.push({ ...base, id: e.use.id, kind: 'web', label: hostPath(str(input.url)) })
    } else if (name === 'WebSearch') {
      out.push({ ...base, id: e.use.id, kind: 'web', label: str(input.query) })
    } else {
      const label = name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : name
      const detail = toolSummary(name, input)
      out.push({ ...base, id: e.use.id, kind: 'tool', label: detail ? `${label}: ${detail}` : label })
    }
  }

  for (const f of files.values()) {
    // Ainda não aconteceu (ou foi negado): não dá para dizer "criou".
    if (f.status === 'waiting') f.meta = 'aguarda você'
    else if (f.status === 'running') f.meta = f.created ? 'criando' : f.writes ? 'editando' : 'lendo'
    else if (f.status === 'failed' && !f.added && !f.removed) f.meta = 'falhou'
    if (f.meta) continue
    const ops = [
      f.writes ? (f.created ? 'criou' : 'editou') : '',
      f.added || f.removed ? `+${f.added} −${f.removed}` : '',
      !f.writes ? (f.reads > 1 ? `leu ×${f.reads}` : 'leu') : '',
    ]
    f.meta = ops.filter(Boolean).join(' ')
  }
  return out
}

/**
 * O que um passo (ou um subagente) fez, numa linha: "editou 2 arquivos +40 −12 · 3 comandos · leu 4
 * arquivos". Os subagentes de um passo viram cartões embaixo dele, e só entram na conta (`agents`)
 * quando são de um subagente, que não abre os dele.
 */
export function actionSummary(kids: MindNode[], agents = false): string | undefined {
  const count = (kind: MindKind) => kids.filter((c) => c.kind === kind).length
  const files = kids.filter((c) => c.kind === 'file')
  const edited = files.filter((f) => f.writes)
  const read = files.length - edited.length
  const added = edited.reduce((n, f) => n + (f.added ?? 0), 0)
  const removed = edited.reduce((n, f) => n + (f.removed ?? 0), 0)
  const parts = [
    edited.length && `editou ${plural(edited.length, 'arquivo', 'arquivos')}${added || removed ? ` +${added} −${removed}` : ''}`,
    count('command') && plural(count('command'), 'comando', 'comandos'),
    read && `leu ${plural(read, 'arquivo', 'arquivos')}`,
    count('search') && plural(count('search'), 'busca', 'buscas'),
    count('web') && plural(count('web'), 'consulta na web', 'consultas na web'),
    count('tool') && plural(count('tool'), 'outra ferramenta', 'outras ferramentas'),
    agents && count('agent') && plural(count('agent'), 'subagente', 'subagentes'),
  ]
  return parts.filter(Boolean).join(' · ') || undefined
}

/** Título de um passo sem fala do Claude antes: o raciocínio, se veio, ou o que ele mais fez. */
function autoLabel(entries: ActivityEntry[]): string {
  const thought = entries.find((e) => e.kind === 'thinking')
  if (thought) return firstSentence(thought.text)
  const tools = entries.filter((e): e is ToolEntry => e.kind === 'tool')
  const count = (names: Set<string> | string[]) => tools.filter((t) => (Array.isArray(names) ? names.includes(t.use.name) : names.has(t.use.name))).length
  const n = (k: number, one: string, many: string) => (k === 1 ? one : many.replace('#', String(k)))
  const kinds: [number, string][] = [
    [count(WRITES), n(count(WRITES), 'Editando um arquivo', 'Editando # arquivos')],
    [count(AGENT_TOOLS), n(count(AGENT_TOOLS), 'Chamando um subagente', 'Chamando # subagentes')],
    [count(['Bash']), n(count(['Bash']), 'Rodando um comando', 'Rodando # comandos')],
    [count(READS), n(count(READS), 'Lendo um arquivo', 'Lendo # arquivos')],
    [count(['Grep', 'Glob']), 'Procurando no código'],
    [count(['WebFetch', 'WebSearch']), 'Pesquisando na web'],
  ]
  return kinds.find(([k]) => k > 0)?.[1] ?? 'Trabalhando'
}

const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

type Turn = MindNode & { done?: boolean }

export function mindTree({
  seed,
  items,
  title,
  rootMeta,
  working,
  streaming,
  agents,
}: {
  /** O claudinho da conversa: o do topo e o dos passos do Claude. */
  seed: string
  items: Item[]
  title: string
  rootMeta: string
  /** O processo do painel está no meio de um turno. */
  working: boolean
  /** Texto que o Claude está escrevendo agora; basta o começo (só a primeira frase aparece). */
  streaming: string
  agents: AgentTree
}): MindNode {
  const pending = new Set(items.flatMap((i) => (i.type === 'approval' && !i.resolution && i.req.toolUseId ? [i.req.toolUseId] : [])))
  const asked = new Set(items.flatMap((i) => (i.type === 'question' ? i.req.questions.map((q) => q.question) : [])))
  const turns: Turn[] = []
  let turn: Turn | null = null
  // Fala do Claude ainda sem destino: vira o título do próximo passo, ou a resposta se o turno acabar.
  let said: Extract<Item, { type: 'assistant' }> | null = null

  const ensureTurn = (key: string): Turn => {
    if (!turn) {
      turn = { id: `t:${key}`, kind: 'turn', label: 'Começo da conversa', status: 'done', branch: turns.length, children: [] }
      turns.push(turn)
    }
    return turn
  }
  const add = (node: Omit<MindNode, 'branch' | 'children'> & { children?: MindNode[] }, key: string) => {
    const t = ensureTurn(key)
    // Depois do fim do turno: o Claude voltou sozinho (uma tarefa em segundo plano terminou).
    t.done = false
    t.children.push({ seed, ...node, branch: t.branch, children: node.children ?? [] })
  }
  const flushSaid = (kind: 'step' | 'answer') => {
    if (!said) return
    add({ id: said.key, kind, label: firstSentence(said.text), status: 'done', itemKey: said.key }, said.key)
    said = null
  }

  for (const item of items) {
    switch (item.type) {
      case 'user': {
        flushSaid('answer')
        const label = firstSentence(item.text, 80) || (item.images?.length ? plural(item.images.length, 'imagem', 'imagens') : '…')
        turn = { id: item.key, kind: 'turn', label, status: 'done', branch: turns.length, itemKey: item.key, children: [] }
        turns.push(turn)
        break
      }
      case 'assistant':
        // Duas falas seguidas: a primeira fica como um passo sem ações.
        flushSaid('step')
        said = item
        break
      case 'activity': {
        const t = ensureTurn(item.key)
        const ctx = { branch: t.branch, pending, agents, itemKey: said?.key ?? item.key, scope: item.key, asked }
        const kids = leaves(item.entries, ctx)
        if (!kids.length && !said) break
        const status = kids.reduce<MindStatus>((s, k) => worst(s, k.status === 'failed' ? 'done' : k.status), 'done')
        add(
          {
            id: said?.key ?? item.key,
            kind: 'step',
            label: said ? firstSentence(said.text) : autoLabel(item.entries),
            meta: actionSummary(kids),
            status,
            itemKey: said?.key ?? item.key,
            children: kids,
          },
          item.key,
        )
        said = null
        break
      }
      case 'approval': {
        flushSaid('step')
        const open = !item.resolution
        add(
          {
            id: item.key,
            kind: 'approval',
            label: item.req.title || `${item.req.toolName}: ${toolSummary(item.req.toolName, item.req.input)}`,
            meta: open ? 'Pede aprovação' : item.resolution === 'allow' ? 'Aprovado' : item.resolution === 'deny' ? 'Negado' : 'Cancelado',
            tool: item.req.toolName,
            status: open ? 'waiting' : item.resolution === 'allow' ? 'done' : 'stopped',
            itemKey: item.key,
            requestId: open ? item.req.requestId : undefined,
          },
          item.key,
        )
        break
      }
      case 'question': {
        flushSaid('step')
        const open = !item.resolution
        // Recusada ou cancelada: não houve caminho tomado, e os galhos ficam neutros.
        const answers = item.resolution?.decision === 'answered' ? item.resolution.answers : undefined
        const base = { id: item.key, branch: ensureTurn(item.key).branch, itemKey: item.key, open, requestId: open ? item.req.requestId : undefined }
        for (const d of decisions(item.req.questions, answers, base)) add(d, item.key)
        break
      }
      case 'result': {
        flushSaid('answer')
        const t = ensureTurn(item.key)
        const r = item.result
        t.done = true
        t.status = r.ok ? 'done' : r.subtype === 'error_during_execution' ? 'stopped' : 'failed'
        t.stats = { durationMs: r.durationMs, costUsd: r.costUsd }
        break
      }
      case 'compacting':
        add({ id: item.key, kind: 'notice', label: 'Compactou o contexto', status: 'done', itemKey: item.key }, item.key)
        break
    }
  }

  // O que sobrou: no turno em andamento é o que ele está pensando agora; num turno encerrado, a resposta.
  const last = turns.at(-1)
  const live = working && last && !last.done
  flushSaid(live ? 'step' : 'answer')
  if (streaming && live) {
    add({ id: 'streaming', kind: 'step', label: firstSentence(streaming) || 'Escrevendo…', status: 'running' }, 'streaming')
  }

  // Quantos pontos de decisão o galho tem, em qualquer profundidade: no turno recolhido eles somem,
  // e a contagem na segunda linha é o que avisa que vale abrir.
  const decided = (n: MindNode): number => (n.kind === 'decision' ? 1 : 0) + n.children.reduce((sum, c) => sum + decided(c), 0)
  for (const t of turns) {
    const steps = t.children.filter((c) => c.kind !== 'notice').length
    const choices = decided(t)
    if (t.children.some((c) => c.status === 'waiting')) t.status = 'waiting'
    else if (t === last && live) t.status = 'running'
    t.meta = [steps && plural(steps, 'passo', 'passos'), choices && plural(choices, 'decisão', 'decisões'), t.meta].filter(Boolean).join(' · ') || undefined
  }

  // No turno em andamento, o último passo é onde ele está agora (se nada mais estiver rodando).
  if (live && last && !hasActive(last)) {
    const now = last.children.at(-1)
    if (now) now.status = 'running'
  }

  // As perguntas feitas pela ferramenta nascem dentro do passo, sem passar por `add`: herdam o
  // claudinho de quem perguntou, como o resto do que o Claude fez.
  const inherit = (n: MindNode, from: string) => {
    for (const c of n.children) {
      if (c.kind === 'decision' || c.kind === 'option') c.seed ??= from
      inherit(c, c.seed ?? from)
    }
  }
  turns.forEach((t) => inherit(t, seed))

  return { id: 'root', kind: 'root', label: title, meta: rootMeta, seed, status: working ? 'running' : 'done', branch: -1, children: turns }
}

function hasActive(node: MindNode): boolean {
  return node.children.some((c) => c.status === 'running' || c.status === 'waiting' || hasActive(c))
}

/** O que vira cartão no mapa: as ações (arquivos, comandos) ficam no resumo do passo, e o que um subagente fez, no dele. */
const DRAWN = new Set<MindKind>(['root', 'turn', 'step', 'answer', 'approval', 'decision', 'option', 'agent', 'notice'])

/**
 * O nó a acompanhar ao vivo, entre os que têm cartão: um pedido esperando você, senão o mais fundo
 * trabalhando, senão o último. O comando rodando agora não tem cartão; o passo dele está trabalhando também.
 */
export function focusOf(root: MindNode): MindNode {
  const flat: MindNode[] = []
  const walk = (n: MindNode) => {
    flat.push(n)
    if (n.kind !== 'agent') n.children.filter((c) => DRAWN.has(c.kind)).forEach(walk)
  }
  walk(root)
  return flat.find((n) => n.status === 'waiting' && n.kind !== 'turn') ?? flat.findLast((n) => n.status === 'running' && n.kind !== 'root') ?? flat.at(-1)!
}
