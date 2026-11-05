import { FILE_TOOLS } from '@/lib/format'
import type { ActivityEntry, Item } from './items'
import { askOf } from './questions'

export type ToolEntry = Extract<ActivityEntry, { kind: 'tool' }>

/** O que o Claude fez num turno, da mensagem da pessoa até o fim da resposta. */
export type TurnInfo = {
  /** Arquivos que ele mudou (só as mudanças que deram certo), com as edições na ordem. */
  files: { path: string; changes: ToolEntry[]; added: number; removed: number }[]
  /** Comandos do terminal, na ordem, com o resultado. */
  commands: ToolEntry[]
  /** Páginas que ele abriu (WebFetch, navegador) ou pesquisas que fez (WebSearch). */
  visited: { tool: ToolEntry; url?: string; query?: string }[]
  /** Links citados no texto da resposta. */
  cited: { url: string; label: string }[]
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const lines = (text: string) => (text ? text.split('\n').length : 0)

/** Linhas tiradas e colocadas por uma edição, a partir do que a ferramenta recebeu. */
export function lineCounts(use: ToolEntry['use']): { added: number; removed: number } {
  const input = use.input
  switch (use.name) {
    case 'Edit':
      return { added: lines(str(input.new_string)), removed: lines(str(input.old_string)) }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
      return edits.reduce<{ added: number; removed: number }>(
        (n, e) => ({ added: n.added + lines(str(e.new_string)), removed: n.removed + lines(str(e.old_string)) }),
        { added: 0, removed: 0 },
      )
    }
    case 'Write':
      return { added: lines(str(input.content)), removed: 0 }
    case 'NotebookEdit':
      return { added: lines(str(input.new_source)), removed: 0 }
    default:
      return { added: 0, removed: 0 }
  }
}

// Link em markdown ([texto](url)) ou endereço solto; o ponto final da frase não entra no endereço.
const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()[\]`'"]*[^\s<>()[\]`'".,;:!?])/g

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function citedLinks(texts: string[]): TurnInfo['cited'] {
  const seen = new Map<string, string>()
  for (const text of texts) {
    // Endereços dentro de blocos de código são exemplos, não links.
    const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
    for (const m of prose.matchAll(LINK)) {
      const url = m[2] ?? m[3]
      if (!seen.has(url)) seen.set(url, m[1] ?? hostOf(url))
    }
  }
  return [...seen].map(([url, label]) => ({ url, label }))
}

function summarize(tools: ToolEntry[], texts: string[]): TurnInfo {
  const files = new Map<string, TurnInfo['files'][number]>()
  const commands: ToolEntry[] = []
  const visited: TurnInfo['visited'] = []
  for (const tool of tools) {
    const { name, input } = tool.use
    const path = str(input.file_path) || str(input.notebook_path)
    if (FILE_TOOLS.has(name) && path && !tool.result?.isError) {
      const file = files.get(path) ?? { path, changes: [], added: 0, removed: 0 }
      const { added, removed } = lineCounts(tool.use)
      files.set(path, { ...file, changes: [...file.changes, tool], added: file.added + added, removed: file.removed + removed })
    }
    if (name === 'Bash' && str(input.command)) commands.push(tool)
    if (name === 'WebSearch' && str(input.query)) visited.push({ tool, query: str(input.query) })
    else if (/^https?:\/\//.test(str(input.url))) visited.push({ tool, url: str(input.url) })
  }
  return { files: [...files.values()], commands, visited, cited: citedLinks(texts) }
}

/** Ferramentas de um bloco de atividade, incluindo as dos subagentes criados nele. */
export function toolsIn(entries: ActivityEntry[]): ToolEntry[] {
  return entries.flatMap((e) => (e.kind === 'tool' ? [e, ...toolsIn(e.inner ?? [])] : []))
}

/** Todas as ferramentas da conversa carregada, inclusive as dos subagentes, na ordem do chat. */
export const toolsOf = (items: Item[]): ToolEntry[] => toolsIn(items.flatMap((i) => (i.type === 'activity' ? i.entries : [])))

/** O que o Claude fez na conversa carregada inteira, com as mesmas contas de um turno: o resumo da sessão. */
export function sessionOf(items: Item[]): TurnInfo {
  return summarize(toolsOf(items), items.flatMap((i) => (i.type === 'assistant' ? [i.text] : [])))
}

/** As que deram erro. Pergunta que você recusou volta como erro, mas não é falha (como na linha da atividade). */
export const failedTools = (tools: ToolEntry[]): ToolEntry[] =>
  tools.filter((t) => t.result?.isError && !(t.use.name === 'AskUserQuestion' && askOf(t.use.input, t.result, t.answer).note))

export type LinkEntry =
  | { kind: 'cited'; key: string; url: string; label: string }
  | { kind: 'opened'; key: string; url: string; tool: ToolEntry }
  | { kind: 'search'; key: string; query: string; tool: ToolEntry }

/**
 * Os links de um turno (ou da conversa) numa lista só: as páginas abertas e as pesquisas, na ordem,
 * e depois os citados na resposta. Página aberta de novo aparece uma vez, a primeira.
 */
export function linksOf({ visited, cited }: Pick<TurnInfo, 'visited' | 'cited'>): LinkEntry[] {
  const opened = new Set<string>()
  const links: LinkEntry[] = []
  for (const { tool, url, query } of visited) {
    if (url) {
      if (opened.has(url)) continue
      opened.add(url)
      links.push({ kind: 'opened', key: tool.key, url, tool })
    } else if (query) links.push({ kind: 'search', key: tool.key, query, tool })
  }
  for (const { url, label } of cited) links.push({ kind: 'cited', key: `cited:${url}`, url, label })
  return links
}

/**
 * O que cada turno fez, pela chave da última resposta do Claude nele (onde os atalhos aparecem).
 * Turnos sem arquivos, comandos nem links ficam de fora.
 */
export function turnsOf(items: Item[]): Map<string, TurnInfo> {
  const turns = new Map<string, TurnInfo>()
  let tools: ToolEntry[] = []
  let texts: string[] = []
  let last: string | null = null
  const close = () => {
    if (last) {
      const info = summarize(tools, texts)
      if (info.files.length + info.commands.length + info.visited.length + info.cited.length) turns.set(last, info)
    }
    tools = []
    texts = []
    last = null
  }
  for (const item of items) {
    if (item.type === 'user') close()
    else if (item.type === 'activity') tools.push(...toolsIn(item.entries))
    else if (item.type === 'assistant') {
      texts.push(item.text)
      last = item.key
    } else if (item.type === 'result') close()
  }
  close()
  return turns
}
