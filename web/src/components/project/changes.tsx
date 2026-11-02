import type { ThemedToken } from 'shiki/core'
import { tokenStyle } from '@/lib/highlight'
import { cn } from '@/lib/utils'

/**
 * O que mudou num arquivo, para o diff e para o arquivo aberto (as marcas na lateral, como o VSCode).
 * `add`: linhas novas; `mod`: linhas trocadas; `del`: linhas que saíram; `hunk`: o começo de um trecho.
 */
export type Mark = 'add' | 'del' | 'mod' | 'hunk'

/**
 * Uma mudança no arquivo atual contra o último commit: as linhas `start`..`end` do arquivo (contando de 1).
 * Numa `del` não sobra linha: `start` é a que ficou logo depois do que saiu.
 */
export type Block = { kind: 'add' | 'mod' | 'del'; start: number; end: number; removed: string[]; added: string[] }

/** As mudanças de um diff unificado, na ordem do arquivo. */
export function blocksOf(diff: string): Block[] {
  const blocks: Block[] = []
  let line = 0
  let inHunk = false
  let open: { start: number; removed: string[]; added: string[] } | null = null
  const close = () => {
    if (!open) return
    const kind = open.added.length ? (open.removed.length ? 'mod' : 'add') : 'del'
    const start = Math.max(1, open.start)
    blocks.push({ kind, start, end: kind === 'del' ? start : start + open.added.length - 1, removed: open.removed, added: open.added })
    open = null
  }
  for (const raw of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      close()
      line = Number(hunk[1])
      inHunk = true
    } else if (!inHunk) {
      continue
    } else if (raw.startsWith('+')) {
      open ??= { start: line, removed: [], added: [] }
      open.added.push(raw.slice(1))
      line++
    } else if (raw.startsWith('-')) {
      open ??= { start: line, removed: [], added: [] }
      open.removed.push(raw.slice(1))
    } else if (raw.startsWith(' ')) {
      close()
      line++
    } else if (!raw.startsWith('\\')) {
      close()
    }
  }
  close()
  return blocks
}

/**
 * O trecho que mudou entre a linha antiga `a` e a nova `b`: tudo menos o começo e o fim que as duas têm
 * em comum. `null` quando quase nada bate (a linha inteira mudou, e realçar tudo não diz nada).
 */
export function innerChange(a: string, b: string): { old: [number, number]; new: [number, number] } | null {
  const max = Math.min(a.length, b.length)
  let p = 0
  while (p < max && a[p] === b[p]) p++
  let s = 0
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  if (p + s < 3) return null
  if (p === a.length && p === b.length) return null
  return { old: [p, a.length - s], new: [p, b.length - s] }
}

/**
 * Uma linha de código com o trecho `range` realçado por cima das cores de sintaxe: os tokens são
 * cortados nas bordas do trecho, para o realce começar e terminar no caractere certo.
 */
export function MarkedCode({
  text,
  tokens,
  range,
  tone,
}: {
  text: string
  tokens: ThemedToken[] | undefined
  range: [number, number] | null | undefined
  tone: 'add' | 'del'
}) {
  const parts: { text: string; style?: React.CSSProperties; marked: boolean }[] = []
  const pieces = tokens?.length ? tokens : [{ content: text } as ThemedToken]
  let at = 0
  for (const t of pieces) {
    const style = tokens?.length ? tokenStyle(t) : undefined
    const from = at
    const to = at + t.content.length
    at = to
    if (!range || range[1] <= from || range[0] >= to) {
      parts.push({ text: t.content, style, marked: false })
      continue
    }
    const a = Math.max(range[0], from) - from
    const b = Math.min(range[1], to) - from
    if (a > 0) parts.push({ text: t.content.slice(0, a), style, marked: false })
    parts.push({ text: t.content.slice(a, b), style, marked: true })
    if (b < t.content.length) parts.push({ text: t.content.slice(b), style, marked: false })
  }
  if (parts.length === 0 || (parts.length === 1 && !parts[0]!.text)) return ' '
  return parts.map((p, i) =>
    p.marked ? (
      <span key={i} style={p.style} className={cn('rounded-[2px]', tone === 'add' ? 'bg-emerald-500/35' : 'bg-red-500/35')}>
        {p.text}
      </span>
    ) : (
      <span key={i} style={p.style}>
        {p.text}
      </span>
    ),
  )
}

/** As cores das marcas, as mesmas no código, na lateral e no minimapa. */
export const MARK_BAR: Record<Block['kind'], string> = {
  add: 'bg-emerald-500',
  mod: 'bg-sky-500',
  del: 'bg-red-500',
}
