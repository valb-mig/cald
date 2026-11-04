import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { ThemedToken } from 'shiki/core'
import { Button } from '@/components/ui/button'
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

export const KIND_LABEL: Record<Block['kind'], string> = { add: 'Linhas novas', mod: 'Linhas mudadas', del: 'Linhas apagadas' }

/**
 * A mudança aberta debaixo das linhas dela, como o "peek" do VSCode: o que saiu em vermelho e o que
 * entrou em verde, com o trecho exato que mudou realçado dentro da linha. As setas vão para a mudança
 * vizinha, e o X fecha. Fora da grade de linhas (sem `data-row`), para a seleção de código não contar com ela.
 */
export function ChangePeek({
  block,
  index,
  total,
  addedTokens,
  onGo,
  onClose,
  className = 'ml-[4.9em]',
}: {
  block: Block
  index: number
  total: number
  /** As cores das linhas que entraram, uma por linha, na ordem. */
  addedTokens?: (ThemedToken[] | undefined)[]
  onGo: (index: number) => void
  onClose: () => void
  /** A margem à esquerda: no arquivo só leitura, a dos números; no editor, eles ficam fora do peek. */
  className?: string
}) {
  const pairs = Math.min(block.removed.length, block.added.length)
  const inner = Array.from({ length: pairs }, (_, k) => innerChange(block.removed[k]!, block.added[k]!))
  return (
    <div
      className={cn('my-1.5 mr-4 overflow-hidden rounded-lg bg-background shadow-lg ring-1 ring-foreground/10', className)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b py-1 pr-1 pl-3 font-sans text-xs">
        <span className={cn('size-2 shrink-0 rounded-full', MARK_BAR[block.kind])} />
        <span className="truncate">
          {KIND_LABEL[block.kind]} · <span className="text-muted-foreground tabular-nums">mudança {index + 1} de {total}</span>
        </span>
        <span className="shrink-0 tabular-nums">
          {block.added.length > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{block.added.length}</span>}{' '}
          {block.removed.length > 0 && <span className="text-red-600 dark:text-red-400">−{block.removed.length}</span>}
        </span>
        <div className="flex-1" />
        <Button variant="ghost" size="icon-sm" disabled={total < 2} onClick={() => onGo((index - 1 + total) % total)} aria-label="Mudança anterior">
          <ChevronUp />
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={total < 2} onClick={() => onGo((index + 1) % total)} aria-label="Próxima mudança">
          <ChevronDown />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Fechar">
          <X />
        </Button>
      </div>
      <div className="max-h-80 overflow-auto py-1">
        {block.removed.map((line, k) => (
          <div key={`r${k}`} className="flex w-max min-w-full bg-red-500/[0.12] text-red-950 dark:text-red-100">
            <span className="w-[1.6em] shrink-0 text-center text-red-600/80 select-none dark:text-red-400/80">−</span>
            <span className="pr-4 whitespace-pre">
              <MarkedCode text={line} tokens={undefined} range={inner[k]?.old} tone="del" />
            </span>
          </div>
        ))}
        {block.added.map((line, k) => (
          <div key={`a${k}`} className="flex w-max min-w-full bg-emerald-500/[0.12]">
            <span className="w-[1.6em] shrink-0 text-center text-emerald-600/80 select-none dark:text-emerald-400/80">+</span>
            <span className="pr-4 whitespace-pre">
              <MarkedCode text={line} tokens={addedTokens?.[k]} range={inner[k]?.new} tone="add" />
            </span>
          </div>
        ))}
        {block.kind === 'del' && block.removed.length === 0 && <div className="px-3 text-muted-foreground">Nada a mostrar.</div>}
      </div>
    </div>
  )
}

/**
 * As setas para ir de mudança em mudança, como no VSCode: "2 de 7" diz em qual se está, e as setas
 * levam à anterior e à seguinte. Ao lado, o tanto que entrou e saiu. `keys`: os atalhos de cada seta.
 */
export function ChangeNavBar({
  added,
  removed,
  current,
  total,
  onGo,
  keys,
}: {
  added: number
  removed: number
  current: number
  total: number
  onGo: (dir: 1 | -1) => void
  keys: [string, string]
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-foreground/[0.05] p-0.5">
      <span className="px-2 text-xs tabular-nums max-sm:hidden">
        {added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>}
        {added > 0 && removed > 0 && ' '}
        {removed > 0 && <span className="text-red-600 dark:text-red-400">−{removed}</span>}
      </span>
      <Button variant="ghost" size="icon-sm" className="rounded-full" onClick={() => onGo(-1)} aria-label="Mudança anterior" title={`Mudança anterior · ${keys[0]}`}>
        <ChevronUp />
      </Button>
      <span className="min-w-[4.5em] text-center text-xs text-muted-foreground tabular-nums">
        {current >= 0 ? current + 1 : '–'} de {total}
      </span>
      <Button variant="ghost" size="icon-sm" className="rounded-full" onClick={() => onGo(1)} aria-label="Próxima mudança" title={`Próxima mudança · ${keys[1]}`}>
        <ChevronDown />
      </Button>
    </div>
  )
}
