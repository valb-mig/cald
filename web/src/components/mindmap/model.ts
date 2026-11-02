import type { AgentStatus, AgentTree } from '@/components/agents/model'
import { AGENT_TOOLS, type ActivityEntry, type Item } from '@/components/chat/items'
import type { ToolEntry } from '@/components/chat/turn'
import { duration, toolSummary } from '@/lib/format'
import type { Question } from '@/lib/types'

/**
 * Mapa mental da conversa: ela no centro, cada mensagem sua é um galho, e dele saem os passos
 * do Claude (o que ele disse que ia fazer, as perguntas, a resposta) com o que cada passo tocou
 * (arquivos, comandos, buscas, sites, subagentes) nas pontas.
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
  | 'more'

export type MindStatus = AgentStatus

export type MindNode = {
  id: string
  kind: MindKind
  label: string
  /** Segunda linha: "editou +12 −3", "4 passos · 1min 2s". */
  meta?: string
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
  /** Turno recolhido: quantos passos estão escondidos. */
  folded?: number
  /** "+N ações" / "Mostrar menos": o nó cujas pontas o toque abre ou fecha. */
  toggles?: string
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
 * `asked`: perguntas que já viraram decisão pelo pedido ao vivo do painel. A chamada da ferramenta
 * delas também chega como ação, e sem isto cada pergunta apareceria duas vezes no mapa.
 */
type Ctx = { branch: number; pending: Set<string>; agents: AgentTree; itemKey: string; scope: string; asked: Set<string> }

/** As perguntas do input da AskUserQuestion, no formato do pedido ao vivo; vazio se não bater. */
function questionsOf(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : []
  return raw.flatMap((q) =>
    typeof q?.question === 'string' && Array.isArray(q.options)
      ? [
          {
            question: q.question,
            header: str(q.header),
            multiSelect: Boolean(q.multiSelect),
            options: (q.options as Record<string, unknown>[]).map((o) => ({ label: str(o.label), description: str(o.description) })),
          },
        ]
      : [],
  )
}

/**
 * As respostas, recortadas do texto que o Claude Code grava no resultado da AskUserQuestion. O
 * histórico só guarda esse texto (o SDK descarta a versão estruturada), mas o miolo é estável —
 * `"pergunta"="resposta"`, uma atrás da outra —, e como as perguntas vêm exatas do input, cada
 * resposta vai do fim da sua pergunta até o começo da próxima.
 */
export function parseAnswers(text: string, questions: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  questions.forEach((q, i) => {
    const open = `"${q}"="`
    const at = text.indexOf(open)
    if (at < 0) return
    const start = at + open.length
    const nexts = questions
      .slice(i + 1)
      .map((n) => text.indexOf(`", "${n}"="`, start))
      .filter((p) => p >= 0)
    const tail = text.indexOf('". ', start)
    const end = nexts.length ? Math.min(...nexts) : tail >= 0 ? tail : text.lastIndexOf('"')
    if (end > start) out[q] = text.slice(start, end)
  })
  return out
}

/**
 * Se a opção está entre as escolhidas: a resposta inteira, ou um dos itens de uma múltipla escolha,
 * que chega com os rótulos unidos por vírgula. Compara o rótulo inteiro com fronteira dos dois
 * lados, porque os próprios rótulos podem ter vírgula dentro.
 */
function picked(answer: string, label: string): boolean {
  if (!label) return false
  for (let at = answer.indexOf(label); at >= 0; at = answer.indexOf(label, at + 1)) {
    const before = at === 0 || answer.slice(at - 2, at) === ', '
    const end = at + label.length
    const after = end === answer.length || answer.slice(end, end + 2) === ', '
    if (before && after) return true
  }
  return false
}

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
      // Pergunta do painel ao vivo: o pedido dela já desenha a decisão, com a resposta estruturada.
      if (questions.length && questions.every((q) => ctx.asked.has(q.question))) continue
      if (questions.length) {
        const answers = e.result && !e.result.isError ? parseAnswers(e.result.text, questions.map((q) => q.question)) : undefined
        out.push(...decisions(questions, answers, { id: e.use.id, branch: ctx.branch, itemKey: ctx.itemKey, open: !e.result }))
        continue
      }
    }

    if (AGENT_TOOLS.has(name)) {
      const agent = ctx.agents.byId.get(e.use.id)
      out.push({
        ...base,
        id: e.use.id,
        kind: 'agent',
        label: str(input.description) || str(input.subagent_type) || 'Subagente',
        meta: [agent?.type ?? (str(input.subagent_type) || undefined), agent?.background && 'segundo plano'].filter(Boolean).join(' · '),
        status: agent?.status ?? base.status,
        agentId: e.use.id,
        children: leaves(e.inner ?? [], { ...ctx, scope: e.use.id }),
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
  items,
  title,
  rootMeta,
  working,
  streaming,
  agents,
}: {
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
    t.children.push({ ...node, branch: t.branch, children: node.children ?? [] })
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
            meta: kids.length ? plural(kids.length, 'ação', 'ações') : undefined,
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
        t.meta = r.ok ? duration(r.durationMs) : r.subtype === 'error_during_execution' ? 'Interrompido' : 'Terminou com erro'
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

  return { id: 'root', kind: 'root', label: title, meta: rootMeta, status: working ? 'running' : 'done', branch: -1, children: turns }
}

function hasActive(node: MindNode): boolean {
  return node.children.some((c) => c.status === 'running' || c.status === 'waiting' || hasActive(c))
}

/** O nó a acompanhar ao vivo: um pedido esperando você, senão o mais fundo trabalhando, senão o último. */
export function focusOf(root: MindNode): MindNode {
  const flat: MindNode[] = []
  const walk = (n: MindNode) => {
    flat.push(n)
    n.children.forEach(walk)
  }
  walk(root)
  return flat.find((n) => n.status === 'waiting' && n.kind !== 'turn') ?? flat.findLast((n) => n.status === 'running' && n.kind !== 'root') ?? flat.at(-1)!
}

/** Pontas visíveis num passo fechado; as mais antigas viram "+N ações". */
const MAX_LEAVES = 6

/**
 * O que aparece na tela. Turnos antigos ficam recolhidos (abertos só o último, o que está em
 * andamento e os que esperam você); passos com muitas ações mostram as mais recentes, que é onde
 * ele está trabalhando. `open` guarda o que a pessoa abriu ou fechou à mão.
 */
export function fold(root: MindNode, open: ReadonlyMap<string, boolean>): MindNode {
  const last = root.children.at(-1)
  const turns = root.children.map((t) => {
    const shown = open.get(t.id) ?? (t === last || t.status === 'waiting' || t.status === 'running')
    return shown ? { ...t, children: t.children.map((c) => trim(c, open)) } : { ...t, children: [], folded: t.children.length }
  })
  return { ...root, children: turns }
}

function trim(n: MindNode, open: ReadonlyMap<string, boolean>): MindNode {
  const kids = n.children.map((c) => trim(c, open))
  // Decisão nunca vai para o "+N ações": é o que o mapa quer destacar, e um passo com muitas ações
  // a esconderia. Só as ações comuns contam para o limite, e as mais antigas é que somem.
  const plain = kids.filter((k) => k.kind !== 'decision')
  if (plain.length <= MAX_LEAVES) return { ...n, children: kids }
  const toggle = (label: string): MindNode => ({ id: `${n.id}:more`, kind: 'more', label, status: 'done', branch: n.branch, toggles: n.id, children: [] })
  if (open.get(n.id)) return { ...n, children: [...kids, toggle('Mostrar menos')] }
  const hidden = plain.length - (MAX_LEAVES - 1)
  const drop = new Set(plain.slice(0, hidden))
  return { ...n, children: [toggle(`+${plural(hidden, 'ação', 'ações')}`), ...kids.filter((k) => !drop.has(k))] }
}
