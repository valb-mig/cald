import { FILE_TOOLS, shortPath } from '@/lib/format'
import { AGENT_TOOLS, type ActivityEntry, type Item } from './items'
import { lineCounts, type ToolEntry } from './turn'

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Quem editou: a conversa principal, ou um subagente (`seed`: o id da chamada que o criou, para o claudinho dele). */
export type EditAgent = 'main' | { type: string; seed: string }

export type FileEdit = {
  toolId: string
  /** Absoluto, como o Claude passou. */
  path: string
  kind: 'Edit' | 'MultiEdit' | 'Write' | 'NotebookEdit'
  /** `old: null` no Write: ele troca o arquivo inteiro. */
  edits: { old: string | null; new: string }[]
  result?: ToolEntry['result']
  at?: number
  started?: number
  agent: EditAgent
  counts: { added: number; removed: number }
}

/** Um arquivo mudado no git (não se sabe quem mexeu): a letra do git e as linhas dele. */
export type GitChange = { path: string; letter: 'M' | 'A' | 'D' | 'R' | 'U'; additions: number; deletions: number }

export type FileInfo = {
  path: string
  /** `tools`: as edições da conversa; `git`: só o git viu (mexido pelo terminal, por exemplo). */
  source: 'tools' | 'git'
  /** Só no que veio do git. */
  git?: GitChange
  edits: FileEdit[]
  added: number
  removed: number
  /** Sem ele, o arquivo é só do git. */
  last?: FileEdit
  state: 'running' | 'failed' | 'ok'
}

/** Junta ao que as ferramentas editaram o que o git viu mudar: o arquivo nos dois fica como as ferramentas o têm. */
export function withGit(files: FileInfo[], changes: GitChange[], cwd: string): FileInfo[] {
  const base = cwd.replace(/\/+$/, '')
  const seen = new Set(files.map((f) => f.path))
  const extra = changes
    .map((c): FileInfo => ({ path: `${base}/${c.path}`, source: 'git', git: c, edits: [], added: c.additions, removed: c.deletions, state: 'ok' }))
    .filter((f) => !seen.has(f.path))
  return extra.length ? [...files, ...extra] : files
}

function piecesOf(t: ToolEntry): FileEdit['edits'] {
  const input = t.use.input
  switch (t.use.name) {
    case 'Edit':
      return [{ old: str(input.old_string), new: str(input.new_string) }]
    case 'MultiEdit':
      return (Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []).map((e) => ({ old: str(e.old_string), new: str(e.new_string) }))
    case 'Write':
      return [{ old: null, new: str(input.content) }]
    default:
      return [{ old: null, new: str(input.new_source) }]
  }
}

function walk(entries: ActivityEntry[], agent: EditAgent, out: FileEdit[]) {
  for (const e of entries) {
    if (e.kind !== 'tool') continue
    if (FILE_TOOLS.has(e.use.name)) {
      const path = str(e.use.input.file_path) || str(e.use.input.notebook_path)
      if (path)
        out.push({
          toolId: e.use.id,
          path,
          kind: e.use.name as FileEdit['kind'],
          edits: piecesOf(e),
          result: e.result,
          at: e.at,
          started: e.started,
          agent,
          counts: lineCounts(e.use),
        })
    }
    // O que o subagente mexeu fica dentro da chamada dele.
    if (AGENT_TOOLS.has(e.use.name) && e.inner) {
      walk(e.inner, { type: str(e.use.input.subagent_type) || str(e.use.input.description) || 'agente', seed: e.use.id }, out)
    }
  }
}

/** Todas as edições de arquivo da conversa, subagentes incluídos, da mais antiga à mais nova. */
export function collectEdits(items: Item[]): FileEdit[] {
  const out: FileEdit[] = []
  for (const item of items) if (item.type === 'activity') walk(item.entries, 'main', out)
  return out
}

/** Os arquivos mexidos, do que mudou há menos tempo ao que mudou há mais. */
export function filesOf(edits: FileEdit[], live: boolean): FileInfo[] {
  const byPath = new Map<string, FileEdit[]>()
  for (const e of edits) {
    const list = byPath.get(e.path) ?? []
    list.push(e)
    // Reinserir leva o arquivo para o fim: a ordem do mapa é a da última edição.
    byPath.delete(e.path)
    byPath.set(e.path, list)
  }
  return [...byPath.entries()]
    .map(([path, list]): FileInfo => {
      const last = list[list.length - 1]!
      const ok = list.filter((e) => !e.result?.isError)
      return {
        path,
        source: 'tools',
        edits: list,
        added: ok.reduce((n, e) => n + e.counts.added, 0),
        removed: ok.reduce((n, e) => n + e.counts.removed, 0),
        last,
        state: !last.result ? (live ? 'running' : 'ok') : last.result.isError ? 'failed' : 'ok',
      }
    })
    .reverse()
}

/** O caminho para mostrar: relativo à pasta da conversa; fora dela, com `~` e a própria raiz. */
export function relOf(path: string, cwd: string): string {
  const base = cwd.replace(/\/+$/, '')
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : shortPath(path)
}

/** Onde ler o arquivo no servidor: dentro da pasta da conversa pelo caminho relativo; fora, pela pasta dele. */
export function targetOf(path: string, cwd: string): { cwd: string; rel: string } {
  const base = cwd.replace(/\/+$/, '')
  if (base && path.startsWith(`${base}/`)) return { cwd: base, rel: path.slice(base.length + 1) }
  const at = path.lastIndexOf('/')
  return { cwd: at > 0 ? path.slice(0, at) : '/', rel: path.slice(at + 1) }
}

export type TreeNode = { name: string; key: string; file?: FileInfo; children: TreeNode[] }

/**
 * A árvore dos arquivos mexidos: pastas primeiro, depois os arquivos, por nome. Pasta que só tem outra
 * pasta dentro vira uma linha só ("web/src/components"), como no VSCode: senão um arquivo fundo empurra o
 * nome dele para fora da barra.
 */
export function buildTree(files: { rel: string; info: FileInfo }[]): TreeNode[] {
  const root: TreeNode = { name: '', key: '', children: [] }
  for (const { rel, info } of files) {
    let node = root
    const parts = rel.split('/')
    parts.forEach((name, i) => {
      const key = parts.slice(0, i + 1).join('/')
      let child = node.children.find((c) => c.key === key)
      if (!child) node.children.push((child = { name, key, children: [] }))
      if (i === parts.length - 1) child.file = info
      node = child
    })
  }
  const compact = (n: TreeNode): TreeNode => {
    let cur = n
    while (!cur.file && cur.children.length === 1 && !cur.children[0]!.file) {
      const only = cur.children[0]!
      cur = { name: `${cur.name}/${only.name}`, key: only.key, children: only.children }
    }
    return { ...cur, children: sort(cur.children) }
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes.map(compact).sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name))
  return sort(root.children)
}
