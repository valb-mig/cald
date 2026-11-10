import { ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ThemedToken } from 'shiki/core'
import { tokenStyle, useTokens } from '@/lib/highlight'
import { cn } from '@/lib/utils'
import { innerChange, MarkedCode } from './changes'
import { plural, TINT, toneOf, type Block } from './diff-tone'

/**
 * O desenho de um diff no edit.r, o mesmo no visualizador de arquivos e nos diffs de PR e de commit:
 * cada bloco de linhas que entraram ou saíram é um cartão de cantos arredondados, na cor dele, com uma
 * bolinha no começo (+, − ou ±) que o recolhe e abre, e um tracejado até onde ele vai. O cabeçalho de
 * cada trecho (a linha em que começa e a função em volta) recolhe o trecho inteiro.
 */

// Números da margem desenhados pelo CSS (`data-n`): fora da seleção e do que se copia. Em `em`, para
// crescerem com a fonte do código.
const GUTTER = 'w-[3.4em] shrink-0 pr-[0.5em] text-right text-muted-foreground/60 select-none before:content-[attr(data-n)]'
// O número que se toca para comentar na linha: no PC, vira um "+" sob o ponteiro, como no GitHub.
const PICKABLE = "cursor-pointer rounded-[0.4em] hover:bg-foreground/10 hover:text-foreground hover:before:content-['+']"
// O tamanho vem da variável posta no contêiner (`--code-font`), e não por propriedade: mudar a fonte não
// redesenha as milhares de linhas. A altura da linha acompanha (20 px nos 12 px).
export const CODE_TEXT = 'font-mono text-[length:var(--code-font)] leading-[1.667] select-none'

/** Uma linha de código: com as cores de sintaxe, quando os tokens já chegaram; senão, o texto puro. */
export function Code({ text, tokens }: { text: string; tokens: ThemedToken[] | undefined }) {
  if (!tokens || tokens.length === 0) return text || ' '
  return tokens.map((t, i) => (
    <span key={i} style={tokenStyle(t)}>
      {t.content}
    </span>
  ))
}

export type DiffRow =
  /** `line`: onde o trecho começa no arquivo novo; `context`: a função ou bloco em volta, que o git diz. */
  | { kind: 'hunk'; line: number; context: string }
  /** `inner`: o trecho exato que mudou dentro da linha, quando ela tem par do outro lado. */
  | { kind: 'add' | 'del' | 'ctx'; old?: number; new?: number; text: string; side: 'old' | 'new'; at: number; inner?: [number, number] }
  | { kind: 'note'; text: string }

/**
 * O diff unificado em linhas com o número antigo e o novo; o cabeçalho do git (`diff`, `index`, `---`)
 * sai, e o trecho que o GitHub manda (só a partir do `@@`) também serve. Junta os dois lados como texto
 * (o antigo: contexto e tiradas; o novo: contexto e colocadas), para colorir cada um de uma vez: uma
 * linha sozinha não sabe se está dentro de um comentário ou de uma string que começou antes. `at` é a
 * linha dela no texto do seu lado. Uma troca (linhas que saem seguidas das que entram) casa cada uma
 * com a sua par, para realçar o que mudou nela.
 */
export function parseDiff(diff: string): { rows: DiffRow[]; old: string[]; new: string[] } {
  const rows: DiffRow[] = []
  const before: string[] = []
  const after: string[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      inHunk = true
      rows.push({ kind: 'hunk', line: newNo, context: hunk[3]!.trim() })
    } else if (line.startsWith('… diff cortado')) {
      rows.push({ kind: 'note', text: line })
    } else if (!inHunk) {
      if (line.startsWith('Binary files ')) rows.push({ kind: 'note', text: 'Arquivo binário: sem diferenças em texto.' })
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', new: newNo++, text: line.slice(1), side: 'new', at: after.push(line.slice(1)) - 1 })
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', old: oldNo++, text: line.slice(1), side: 'old', at: before.push(line.slice(1)) - 1 })
    } else if (line.startsWith(' ')) {
      before.push(line.slice(1))
      rows.push({ kind: 'ctx', old: oldNo++, new: newNo++, text: line.slice(1), side: 'new', at: after.push(line.slice(1)) - 1 })
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'note', text: 'sem quebra de linha no fim do arquivo' })
    }
  }
  // Trocas: um bloco de tiradas logo seguido de um de colocadas; a k-ésima de cada lado formam um par.
  for (let i = 0; i < rows.length; ) {
    if (rows[i]!.kind !== 'del') {
      i++
      continue
    }
    let d = i
    while (rows[d]?.kind === 'del') d++
    let a = d
    while (rows[a]?.kind === 'add') a++
    for (let k = 0; k < Math.min(d - i, a - d); k++) {
      const del = rows[i + k] as Extract<DiffRow, { side: 'old' | 'new' }>
      const add = rows[d + k] as Extract<DiffRow, { side: 'old' | 'new' }>
      const inner = innerChange(del.text, add.text)
      if (inner) {
        del.inner = inner.old
        add.inner = inner.new
      }
    }
    i = a
  }
  return { rows, old: before, new: after }
}


/** A bolinha do bloco: tocar recolhe (ou abre) as linhas dele. */
export function Dot({ block, open, onToggle, className }: { block: Block; open: boolean; onToggle: () => void; className?: string }) {
  const tone = toneOf(block)
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? 'Recolher' : 'Abrir'}: ${tone.label}`}
      title={`${open ? 'Recolher' : 'Abrir'}: ${tone.label}`}
      className={cn(
        'relative z-10 flex size-[1.2em] items-center justify-center rounded-full font-sans leading-none font-bold text-white transition-transform hover:scale-110',
        tone.dot,
        className,
      )}
    >
      <span className="text-[0.75em]">{tone.sign}</span>
    </button>
  )
}

/**
 * As linhas do diff (`rows`, já cortadas por quem chama), dentro do `<pre>`. As que existem no arquivo
 * novo levam `data-line`, e toda linha leva `data-row` (o índice em `rows`), que as setas de mudança e o
 * minimapa usam para chegar nela; um bloco ou trecho recolhido deixa só a linha de resumo à vista.
 */
export function DiffLines({
  rows,
  oldTokens,
  newTokens,
  wrap,
  className,
  children,
  onPick,
  picked,
  below,
}: {
  rows: DiffRow[]
  oldTokens: ThemedToken[][] | null
  newTokens: ThemedToken[][] | null
  wrap: boolean
  className?: string
  /** Depois das linhas (o aviso de diff cortado). */
  children?: React.ReactNode
  /** Para comentar (num PR): tocar no número de uma linha a escolhe; com Shift, estende até ela. */
  onPick?: (row: number, extend: boolean) => void
  /** As linhas escolhidas, da primeira à última (índices em `rows`), em destaque. */
  picked?: readonly [number, number] | null
  /** O que vai embaixo de uma linha: as conversas presas a ela e a caixa de comentar. */
  below?: (row: number) => React.ReactNode
}) {
  // Recolhidos, pelo índice da primeira linha: os blocos (pela bolinha) e os trechos (pelo cabeçalho).
  const [folded, setFolded] = useState<Set<number>>(() => new Set())
  const toggle = (i: number) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  // De cada linha, o bloco em que ela está; de cada cabeçalho, onde o trecho dele acaba.
  const { blockAt, hunkEnd } = useMemo(() => {
    const blockAt: (Block | undefined)[] = []
    const hunkEnd = new Map<number, number>()
    let open: Block | null = null
    let hunk = -1
    rows.forEach((r, i) => {
      if (r.kind === 'add' || r.kind === 'del') {
        open ??= { start: i, end: i, adds: 0, dels: 0 }
        open.end = i + 1
        if (r.kind === 'add') open.adds++
        else open.dels++
        blockAt[i] = open
      } else {
        open = null
      }
      if (r.kind === 'hunk') {
        if (hunk >= 0) hunkEnd.set(hunk, i)
        hunk = i
      }
    })
    if (hunk >= 0) hunkEnd.set(hunk, rows.length)
    return { blockAt, hunkEnd }
  }, [rows])

  const out: React.ReactNode[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    // O índice desta linha, guardado: `i` ainda pula as recolhidas, e os cliques não podem ver o pulo.
    const at = i
    if (r.kind === 'hunk') {
      const end = hunkEnd.get(i) ?? rows.length
      const closed = folded.has(i)
      // O começo de um trecho: o que ficou de fora entre um e outro não muda, e a linha diz onde se está.
      out.push(
        <button
          key={i}
          type="button"
          data-row={i}
          onClick={() => toggle(at)}
          aria-expanded={!closed}
          className="mx-2 mt-3 mb-1 flex w-[calc(100%-1rem)] items-center gap-2 rounded-[0.6em] bg-foreground/[0.04] px-2 py-1 text-left font-sans text-[0.9em] text-muted-foreground transition-colors first:mt-1 hover:bg-foreground/[0.07]"
        >
          <ChevronRight className={cn('size-[1.1em] shrink-0 transition-transform', !closed && 'rotate-90')} />
          <span className="shrink-0 tabular-nums">Linha {r.line}</span>
          {r.context && <span className="truncate font-mono text-foreground/70">{r.context}</span>}
          {closed && <span className="ml-auto shrink-0 pr-1">{plural(end - i - 1, 'linha recolhida', 'linhas recolhidas')}</span>}
        </button>,
      )
      if (closed) i = end - 1
      continue
    }
    if (r.kind === 'note') {
      out.push(
        <div key={i} data-row={i} className="mx-2 px-2 text-muted-foreground italic">
          {r.text}
        </div>,
      )
      continue
    }
    const block = blockAt[i]
    if (block && i === block.start && folded.has(i)) {
      // O bloco recolhido: uma linha só, com a bolinha para abrir e o que ficou guardado nele.
      const tone = toneOf(block)
      out.push(
        <div key={i} data-row={i} className={cn('mx-2 my-1 flex items-center rounded-[0.6em]', TINT[block.adds ? 'add' : 'del'])}>
          <span className={GUTTER} />
          <span className="flex w-[1.8em] shrink-0 items-center justify-center">
            <Dot block={block} open={false} onToggle={() => toggle(at)} />
          </span>
          <button type="button" onClick={() => toggle(at)} className="py-px pr-4 text-left font-sans text-[0.9em] text-muted-foreground hover:text-foreground">
            {tone.label}
          </button>
        </div>,
      )
      i = block.end - 1
      continue
    }
    const first = block?.start === i
    const last = block?.end === i + 1
    const chosen = picked != null && i >= picked[0] && i <= picked[1]
    out.push(
      <div
        key={i}
        data-row={i}
        // Só as linhas que existem no arquivo novo se mencionam: as tiradas não têm para onde apontar.
        data-line={r.new}
        data-code=""
        className={cn(
          'mx-2 flex',
          chosen ? 'bg-foreground/[0.12]' : r.kind !== 'ctx' && TINT[r.kind],
          first && 'mt-1 rounded-t-[0.6em]',
          last && 'mb-1 rounded-b-[0.6em]',
        )}
      >
        {/* Um número só, como no GitHub em linha: o do arquivo novo, ou o do antigo numa linha que saiu. */}
        {onPick ? (
          <span
            role="button"
            tabIndex={-1}
            data-n={r.kind === 'del' ? r.old : r.new}
            title="Comentar nesta linha (Shift: até ela)"
            onClick={(e) => onPick(at, e.shiftKey)}
            className={cn(GUTTER, PICKABLE)}
          />
        ) : (
          <span data-n={r.kind === 'del' ? r.old : r.new} className={GUTTER} />
        )}
        {/* A bolinha fica na altura da primeira linha (`h-[1lh]`), também quando ela quebra em várias. */}
        <span className="relative flex w-[1.8em] shrink-0 justify-center">
          {block && first && (
            <span className="flex h-[1lh] items-center">
              <Dot block={block} open onToggle={() => toggle(at)} />
            </span>
          )}
          {/* O tracejado desce da bolinha até a última linha do bloco. */}
          {block && block.end - block.start > 1 && (
            <span
              aria-hidden
              className={cn('absolute left-1/2 border-l border-dashed', toneOf(block).line, first ? 'top-[0.833lh] bottom-0' : last ? 'top-0 h-[0.5lh]' : 'inset-y-0')}
            />
          )}
        </span>
        <span className={cn('pr-4', wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre')}>
          {r.kind === 'ctx' ? (
            <Code text={r.text} tokens={newTokens?.[r.at]} />
          ) : (
            <MarkedCode text={r.text} tokens={(r.side === 'old' ? oldTokens : newTokens)?.[r.at]} range={r.inner} tone={r.kind} />
          )}
        </span>
      </div>,
    )
    const extra = below?.(at)
    if (extra) {
      // Na largura da área à vista (`100cqw`, ver `usePatchRows`), presa à esquerda: a linha de código pode
      // ser mais larga que a tela, a conversa não.
      out.push(
        <div key={`below-${i}`} className="sticky left-0 w-[100cqw] px-2 py-1.5 font-sans text-sm leading-normal whitespace-normal select-text">
          {extra}
        </div>,
      )
    }
  }
  return (
    <pre className={cn('w-max min-w-full', CODE_TEXT, className)}>
      {out}
      {children}
    </pre>
  )
}

/** As linhas do trecho de diff que o GitHub manda, com as cores de sintaxe dos dois lados. */
export function usePatchRows(patch: string, path: string) {
  const parsed = useMemo(() => parseDiff(patch), [patch])
  const oldText = useMemo(() => parsed.old.join('\n'), [parsed])
  const newText = useMemo(() => parsed.new.join('\n'), [parsed])
  const oldTokens = useTokens(oldText, path)
  const newTokens = useTokens(newText, path)
  return { rows: parsed.rows, oldTokens, newTokens }
}

/**
 * Onde o diff de um arquivo de PR ou de commit rola de lado. É contêiner de largura: o que vai embaixo
 * de uma linha (`below`) usa a largura à vista dele.
 */
export const PATCH_SCROLL = 'overflow-x-auto [container-type:inline-size] [--code-font:12px]'

/** O trecho do diff de um arquivo que o GitHub manda (um PR, um commit), no mesmo desenho, com as cores de sintaxe. */
export function PatchDiff({ patch, path }: { patch: string; path: string }) {
  const { rows, oldTokens, newTokens } = usePatchRows(patch, path)
  return (
    <div className={PATCH_SCROLL}>
      <DiffLines rows={rows} oldTokens={oldTokens} newTokens={newTokens} wrap={false} />
    </div>
  )
}
