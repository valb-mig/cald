import { AGENT_TOOLS, type ActivityEntry, type Item } from './items'

/** Texto curto do pedido: menções @caminho viram só o nome do arquivo. Também o da linha do tempo. */
export const plain = (text: string) =>
  text
    .replace(/(^|\s)@([^\s]+)/g, (_, space: string, path: string) => `${space}@${path.replace(/\/$/, '').split('/').pop()!.replace(/^\d{13}-/, '')}`)
    .trim()

export type ToolEntry = Extract<ActivityEntry, { kind: 'tool' }>

/** Um passo: o porquê (o que o Claude disse ou pensou antes) e as ferramentas que vieram dele. Guardados em ordem cronológica; quem mostra inverte (o mais novo no topo). */
export type Step = {
  key: string
  why?: { kind: 'text' | 'thinking'; text: string }
  tools: ToolEntry[]
  /** O que cada subagente fez, por chave da chamada dele, com o mesmo agrupamento. */
  nested?: Record<string, Step[]>
}

/** `n`: o número do pedido, o mesmo da linha do tempo. */
export type TrailGroup = { key: string; n: number; prompt?: string; steps: Step[] }

/** Monta passos aos poucos: ferramentas seguidas, sem texto no meio, caem no mesmo passo. */
function stepper() {
  const steps: Step[] = []
  let why: Step['why']
  let current: Step | null = null
  return {
    steps,
    say(kind: 'text' | 'thinking', text: string) {
      // Texto vazio não explica nada; não corta o passo.
      if (!text.trim()) return
      why = { kind, text }
      current = null
    },
    tool(entry: ToolEntry) {
      if (!current) {
        current = { key: entry.key, why, tools: [] }
        why = undefined
        steps.push(current)
      }
      current.tools.push(entry)
      if (AGENT_TOOLS.has(entry.use.name) && entry.inner?.length) {
        ;(current.nested ??= {})[entry.key] = stepsOf(entry.inner)
      }
    },
    cut() {
      why = undefined
      current = null
    },
  }
}

function feed(s: ReturnType<typeof stepper>, entry: ActivityEntry) {
  if (entry.kind === 'tool') s.tool(entry)
  else s.say(entry.kind === 'thinking' ? 'thinking' : 'text', entry.text)
}

/** Passos de uma lista de entradas, do mais antigo ao mais novo (os do subagente; a tela os inverte). */
export function stepsOf(entries: ActivityEntry[]): Step[] {
  const s = stepper()
  for (const e of entries) feed(s, e)
  return s.steps
}

/** Os passos da conversa por pedido, do pedido mais novo ao mais antigo e, em cada um, do passo mais novo ao mais antigo. */
export function buildTrail(items: Item[]): TrailGroup[] {
  const groups: { key: string; n: number; prompt?: string; s: ReturnType<typeof stepper> }[] = []
  type G = (typeof groups)[number]
  let group = null as G | null
  let count = 0
  const open = (key: string, prompt?: string) => {
    const g: G = { key, n: prompt === undefined ? 0 : ++count, prompt, s: stepper() }
    group = g
    groups.push(g)
    return g
  }
  for (const item of items) {
    if (item.type === 'user') {
      open(item.key, plain(item.text) || (item.images?.length ? 'Imagem' : 'Mensagem'))
    } else if (item.type === 'cleared') {
      group = null
    } else if (item.type === 'assistant') {
      group?.s.say('text', item.text)
    } else if (item.type === 'activity') {
      // Ferramenta antes de qualquer pedido: grupo sem pedido.
      const g = group ?? open(item.key)
      for (const e of item.entries) feed(g.s, e)
    }
  }
  return groups
    .filter((g) => g.s.steps.length > 0)
    .reverse()
    .map((g) => ({ key: g.key, n: g.n, prompt: g.prompt, steps: [...g.s.steps].reverse() }))
}

/** Quantas ferramentas, subagentes por dentro incluídos. */
export function countTools(groups: TrailGroup[]): number {
  const count = (steps: Step[]): number =>
    steps.reduce((n, st) => n + st.tools.length + Object.values(st.nested ?? {}).reduce((m, inner) => m + count(inner), 0), 0)
  return groups.reduce((n, g) => n + count(g.steps), 0)
}
