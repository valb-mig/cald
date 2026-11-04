import {
  AArrowDown,
  AArrowUp,
  ArrowLeft,
  AtSign,
  ExternalLink,
  FileDiff,
  FileText,
  Loader2,
  Map as MapIcon,
  Save,
  WrapText,
} from 'lucide-react'
import { Fragment, Suspense, createElement, lazy, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ThemedToken } from 'shiki/core'
import { ErrorBoundary } from '@/components/error-boundary'
import { Veil } from '@/components/wallpaper/veil'
import { CopyButton, Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { api, errorMessage, fileRawUrl } from '@/lib/api'
import { formatSize } from '@/lib/attachments'
import { CODE_FONT, CODE_FONT_MAX, CODE_FONT_MIN, setCodeFont, stepCodeFont, useCodeFont } from '@/lib/code-font'
import { projectName } from '@/lib/format'
import { useWide } from '@/lib/hooks'
import { tokenStyle, useTokens } from '@/lib/highlight'
import { setMinimap, useMinimap } from '@/lib/minimap'
import { useGlass, useScrim } from '@/lib/wallpaper'
import { closeViewer, openViewer, useProjectPanel, type Viewing } from '@/lib/project-panel'
import { doneReveal, revealKey, useReveal } from '@/lib/reveal'
import type { FileView } from '@/lib/types'
import { useUnsaved } from '@/lib/unsaved'
import { cn } from '@/lib/utils'
import { keyOf } from '@/lib/workbench'
import { useCodeSelection } from './code-mention'
import { mention } from './file-menu'
import { blocksOf, ChangeNavBar, ChangePeek, innerChange, KIND_LABEL, MARK_BAR, MarkedCode, type Block, type Mark } from './changes'
import type { EditorHandle, EditorStatus } from './editor'
import { CodeMinimap, type MinimapToken } from './minimap'
import { fileIcon, splitPath } from './status'

const MAX_LINES = 5_000
const MAX_DIFF_ROWS = 4_000

const SIDE_LABEL = { staged: 'Alterações preparadas', unstaged: 'Alterações' } as const

// Números da margem desenhados pelo CSS (`data-n`): fora da seleção e do que se copia. Em `em`, para
// crescerem com a fonte do código (ver `useCodeZoom`).
const GUTTER = 'w-[4em] shrink-0 pr-[0.4em] text-right text-muted-foreground/60 select-none before:content-[attr(data-n)]'
const DIFF_GUTTER = 'w-[3.7em] shrink-0 pr-[0.6em] text-right text-muted-foreground/60 select-none before:content-[attr(data-n)]'
// O tamanho vem da variável posta no contêiner, e não por propriedade: mudar a fonte (na pinça, a cada
// movimento) não redesenha as milhares de linhas. A altura da linha acompanha (20 px nos 12 px).
const CODE_TEXT = 'font-mono text-[length:var(--code-font)] leading-[1.667] select-none'

/** Uma linha de código: com as cores de sintaxe, quando os tokens já chegaram; senão, o texto puro. */
function Code({ text, tokens }: { text: string; tokens: ThemedToken[] | undefined }) {
  if (!tokens || tokens.length === 0) return text || ' '
  return tokens.map((t, i) => (
    <span key={i} style={tokenStyle(t)}>
      {t.content}
    </span>
  ))
}

/** O que o código mostra, para o minimapa (ver minimap.tsx) e para as setas de mudança (ver `ChangeNav`). */
export type CodeMap = {
  lines: string[]
  tokens: (MinimapToken[] | undefined)[] | null
  marks?: (Mark | undefined)[]
  /** A linha da grade (`data-row`) onde cada mudança começa, na ordem. */
  changes: number[]
  added: number
  removed: number
  /** No diff, o minimapa tinge a linha toda; no arquivo, só a borda. */
  tint?: boolean
}

/**
 * Leva a linha `row` da grade a um terço do alto da tela, com um lampejo nela para o olho achar onde
 * parou. Fica a um terço, e não no topo, para sobrar um pouco do que vem antes.
 */
export function revealRow(scroller: HTMLElement, row: number): void {
  const el = scroller.querySelector<HTMLElement>(`[data-row="${row}"]`)
  if (!el) return
  scroller.scrollTo({ top: Math.max(0, el.offsetTop - scroller.clientHeight / 3), behavior: 'smooth' })
  el.animate([{ backgroundColor: 'rgb(14 165 233 / 0.28)' }, { backgroundColor: 'transparent' }], { duration: 1000, easing: 'ease-out' })
}

/**
 * O arquivo, linha a linha. Ao lado dos números, as marcas do que mudou desde o último commit, como o
 * VSCode: verde nas linhas novas, azul nas mudadas e um triângulo vermelho onde linhas saíram. Clicar
 * numa marca abre a mudança ali mesmo, debaixo das linhas (ver `ChangePeek`).
 */
function TextContent({
  content,
  path,
  machine,
  cwd,
  wrap,
  onCode,
}: {
  content: string
  path: string
  machine: string
  cwd: string
  wrap: boolean
  /** Estável, como um `setState`: recebe o código ao chegar e `null` ao sair. */
  onCode?: (code: CodeMap | null) => void
}) {
  const lines = useMemo(() => content.split('\n'), [content])
  const shown = useMemo(() => (lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines), [lines])
  const code = useMemo(() => (lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join('\n') : content), [lines, content])
  const tokens = useTokens(code, path)
  const box = useRef<HTMLPreElement>(null)
  const [blocks, setBlocks] = useState<Block[]>([])
  const [peek, setPeek] = useState<number | null>(null)

  // O que mudou desde o último commit; fora de um repositório, ou sem mudança, nada aparece.
  useEffect(() => {
    let alive = true
    api.gitDiff(machine, cwd, path).then(
      (r) => alive && setBlocks(blocksOf(r.diff)),
      () => alive && setBlocks([]),
    )
    return () => {
      alive = false
    }
  }, [machine, cwd, path, content])

  // Por linha (contando de 0): a mudança que a cobre e a que saiu logo acima dela.
  const layout = useMemo(() => {
    const owner: (number | undefined)[] = []
    const removedAbove: (number | undefined)[] = []
    const marks: (Mark | undefined)[] = []
    const changes: number[] = []
    let added = 0
    let removed = 0
    blocks.forEach((b, k) => {
      added += b.added.length
      removed += b.removed.length
      if (b.kind === 'del') {
        const i = Math.min(shown.length, b.start) - 1
        removedAbove[i] ??= k
        marks[i] ??= 'del'
        changes.push(i)
      } else {
        for (let l = b.start; l <= Math.min(b.end, shown.length); l++) {
          owner[l - 1] = k
          marks[l - 1] = b.kind
        }
        changes.push(b.start - 1)
      }
    })
    return { owner, removedAbove, marks, changes, added, removed }
  }, [blocks, shown.length])

  useEffect(() => {
    onCode?.({ lines: shown, tokens, marks: layout.marks, changes: layout.changes, added: layout.added, removed: layout.removed })
  }, [onCode, shown, tokens, layout])
  useEffect(() => () => onCode?.(null), [onCode])

  // Aberto já numa linha (a busca nos arquivos): leva até ela quando o código aparece.
  const rkey = revealKey(machine, cwd, path)
  const reveal = useReveal((s) => s[rkey])
  useEffect(() => {
    const scroller = box.current?.parentElement
    if (!reveal || !scroller) return
    requestAnimationFrame(() => revealRow(scroller, Math.min(reveal.line, shown.length) - 1))
    doneReveal(rkey)
  }, [reveal, rkey, shown.length])

  const openPeek = (k: number) => setPeek((p) => (p === k ? null : k))
  const goPeek = (k: number) => {
    setPeek(k)
    const scroller = box.current?.parentElement
    const row = layout.changes[k]
    if (scroller && row !== undefined) requestAnimationFrame(() => revealRow(scroller, row))
  }
  // Onde a mudança aberta aparece: debaixo da última linha dela; numa que só tirou linhas, logo acima da que ficou.
  const open = peek !== null ? blocks[peek] : undefined
  const after = open ? (open.kind === 'del' ? Math.min(shown.length, open.start) - 2 : Math.min(open.end, shown.length) - 1) : null
  const peekView = open && (
    <ChangePeek
      block={open}
      index={peek!}
      total={blocks.length}
      addedTokens={tokens?.slice(open.start - 1, open.start - 1 + open.added.length)}
      onGo={goPeek}
      onClose={() => setPeek(null)}
    />
  )

  return (
    // Sem a seleção do navegador: a de linhas é do app (ver code-mention.tsx), assim como `data-*`.
    <pre ref={box} className={cn('min-w-full py-2', CODE_TEXT)}>
      {after === -1 && peekView}
      {shown.map((line, i) => {
        const k = layout.owner[i]
        const gone = layout.removedAbove[i]
        return (
          <Fragment key={i}>
            <div data-row={i} data-line={i + 1} data-code="" className="flex">
              <span data-n={i + 1} className={GUTTER} />
              {/* A marca do que mudou, com folga para o clique; a seleção de linhas não começa nela. */}
              <span className="relative w-[0.9em] shrink-0 select-none" onPointerDown={(e) => (k ?? gone) !== undefined && e.stopPropagation()}>
                {k !== undefined && blocks[k] && (
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => openPeek(k)}
                    aria-label={`${KIND_LABEL[blocks[k]!.kind]}: ver a mudança`}
                    title="Ver a mudança"
                    className="group/mark absolute inset-y-0 left-0 w-full cursor-pointer"
                  >
                    <span className={cn('absolute inset-y-0 left-[0.2em] w-[3px] transition-[width] group-hover/mark:w-[5px]', MARK_BAR[blocks[k]!.kind])} />
                  </button>
                )}
                {gone !== undefined && (
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => openPeek(gone)}
                    aria-label="Linhas apagadas: ver a mudança"
                    title="Ver o que saiu"
                    className={cn(
                      'absolute left-0 h-2.5 w-full cursor-pointer',
                      // No fim do arquivo não há linha depois: o triângulo fica no pé da última.
                      blocks[gone]!.start > shown.length ? '-bottom-[5px]' : '-top-[5px]',
                    )}
                  >
                    <span className="absolute top-1/2 left-[0.2em] -translate-y-1/2 border-y-[5px] border-l-[6px] border-y-transparent border-l-red-500" />
                  </button>
                )}
              </span>
              <span className={cn('pr-4', wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre')}>
                <Code text={line} tokens={tokens?.[i]} />
              </span>
            </div>
            {after === i && peekView}
          </Fragment>
        )
      })}
      {lines.length > MAX_LINES && (
        <div className="px-4 py-2 text-muted-foreground">… mostrando {MAX_LINES} de {lines.length} linhas</div>
      )}
    </pre>
  )
}

// O editor do PC baixa à parte, só quando um arquivo abre (ver editor.tsx).
const CodeEditor = lazy(() => import('./editor'))

/** O que o editor do PC precisa de quem o mostra (ver `ViewerBody`); tudo estável entre desenhos. */
type EditorLink = {
  handle: React.RefObject<EditorHandle | null>
  scrollRef: React.RefObject<HTMLElement | null>
  onStatus: (status: EditorStatus) => void
}

/**
 * `onView` avisa o cabeçalho do que chegou (tamanho, se é texto); precisa ser estável, como um
 * `setState`. Memorizado, como o diff: a seleção de linhas muda o cabeçalho sem redesenhar o código.
 * Com `editor` (no PC), o texto abre no editor; sem ele (no celular), só para leitura.
 */
const FileContent = memo(function FileContent({
  viewing,
  wrap,
  rendered,
  minimap,
  editor,
  onView,
  onCode,
}: {
  viewing: Viewing
  wrap: boolean
  rendered: boolean
  minimap: boolean
  editor: EditorLink | null
  onView: (v: FileView) => void
  onCode: (code: CodeMap | null) => void
}) {
  const { machine, cwd, path } = viewing
  const [view, setView] = useState<FileView | { kind: 'error'; message: string } | null>(null)

  useEffect(() => {
    api.file(machine, cwd, path).then(
      (v) => {
        setView(v)
        onView(v)
      },
      (err) => setView({ kind: 'error', message: errorMessage(err) }),
    )
  }, [machine, cwd, path, onView])

  const raw = fileRawUrl(machine, cwd, path)
  if (!view) return <Loader2 className="m-auto size-5 animate-spin text-muted-foreground" />
  if (view.kind === 'text') {
    const readOnly = <TextContent content={view.content} path={path} machine={machine} cwd={cwd} wrap={wrap} onCode={onCode} />
    // Sem o `hash`, o servidor do PC ainda é o de antes do editor: o arquivo abre só para leitura.
    if (editor && !rendered && typeof view.hash === 'string') {
      return (
        // Sem rede para baixar o editor (ou um erro nele): o arquivo abre só para leitura, como antes.
        <ErrorBoundary fallback={() => readOnly}>
          <Suspense fallback={<Loader2 className="m-auto size-5 animate-spin text-muted-foreground" />}>
            <CodeEditor viewing={viewing} file={{ ...view, hash: view.hash }} wrap={wrap} minimap={minimap} onCode={onCode} {...editor} />
          </Suspense>
        </ErrorBoundary>
      )
    }
    return (
      <>
        {rendered ? <Markdown text={view.content} className="p-4" /> : readOnly}
        {view.truncated && <p className="px-4 pb-4 text-xs text-muted-foreground">Arquivo grande: mostrando só o primeiro 1 MB.</p>}
      </>
    )
  }
  if (view.kind === 'image') {
    return (
      <div className="flex min-h-full items-center justify-center bg-[repeating-conic-gradient(#8881_0_25%,transparent_0_50%)] bg-size-[16px_16px] p-4">
        <img src={raw} alt={splitPath(path).name} className="max-w-full" />
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      <p>
        {view.kind === 'pdf' && 'PDF'}
        {view.kind === 'binary' && 'Arquivo binário: não dá para mostrar como texto.'}
        {view.kind === 'large' && 'Arquivo grande demais para mostrar.'}
        {view.kind === 'error' && view.message}
      </p>
      {view.kind === 'pdf' && (
        <Button asChild>
          <a href={raw} target="_blank" rel="noreferrer">
            <ExternalLink /> Abrir PDF
          </a>
        </Button>
      )}
    </div>
  )
})

type DiffRow =
  /** `line`: onde o trecho começa no arquivo novo; `context`: a função ou bloco em volta, que o git diz. */
  | { kind: 'hunk'; line: number; context: string }
  /** `inner`: o trecho exato que mudou dentro da linha, quando ela tem par do outro lado. */
  | { kind: 'add' | 'del' | 'ctx'; old?: number; new?: number; text: string; side: 'old' | 'new'; at: number; inner?: [number, number] }
  | { kind: 'note'; text: string }

/**
 * O diff unificado em linhas com o número antigo e o novo; o cabeçalho do git (`diff`, `index`, `---`)
 * sai. Junta também os dois lados como texto (o antigo: contexto e tiradas; o novo: contexto e
 * colocadas), para colorir cada um de uma vez: uma linha sozinha não sabe se está dentro de um
 * comentário ou de uma string que começou antes. `at` é a linha dela no texto do seu lado. Uma troca
 * (linhas que saem seguidas das que entram) casa cada uma com a sua par, para realçar o que mudou nela.
 */
function parseDiff(diff: string): { rows: DiffRow[]; old: string[]; new: string[] } {
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

/**
 * O diff do arquivo. Cada trecho abre com a linha em que começa e a função em volta (o que o git diz
 * depois do `@@`); as linhas que entram e saem ganham uma borda na cor delas, e numa troca o trecho
 * exato que mudou fica realçado. As mudanças (blocos seguidos de linhas que entram ou saem) vão para
 * as setas do cabeçalho e para o minimapa, pelo `onCode`.
 */
const DiffContent = memo(function DiffContent({
  viewing,
  wrap,
  onCode,
}: {
  viewing: Viewing
  wrap: boolean
  onCode: (code: CodeMap | null) => void
}) {
  const { machine, cwd, path, diff: side } = viewing
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.gitDiff(machine, cwd, path, side).then(
      (r) => setDiff(r.diff),
      (err) => setError(errorMessage(err)),
    )
  }, [machine, cwd, path, side])

  const parsed = useMemo(() => (diff === null ? null : parseDiff(diff)), [diff])
  const oldText = useMemo(() => parsed?.old.join('\n') ?? null, [parsed])
  const newText = useMemo(() => parsed?.new.join('\n') ?? null, [parsed])
  const oldTokens = useTokens(oldText, path)
  const newTokens = useTokens(newText, path)

  const shown = useMemo(() => parsed?.rows.slice(0, MAX_DIFF_ROWS) ?? [], [parsed])
  const map = useMemo<CodeMap>(() => {
    const changes: number[] = []
    let added = 0
    let removed = 0
    shown.forEach((r, i) => {
      if (r.kind !== 'add' && r.kind !== 'del') return
      if (r.kind === 'add') added++
      else removed++
      const prev = shown[i - 1]
      if (prev?.kind !== 'add' && prev?.kind !== 'del') changes.push(i)
    })
    return {
      lines: shown.map((r) => (r.kind === 'add' || r.kind === 'del' || r.kind === 'ctx' ? r.text : '')),
      tokens: shown.map((r) =>
        r.kind === 'add' || r.kind === 'del' || r.kind === 'ctx' ? (r.side === 'old' ? oldTokens : newTokens)?.[r.at] : undefined,
      ),
      marks: shown.map((r) => (r.kind === 'add' || r.kind === 'del' || r.kind === 'hunk' ? r.kind : undefined)),
      changes,
      added,
      removed,
      tint: true,
    }
  }, [shown, oldTokens, newTokens])
  useEffect(() => {
    if (parsed) onCode(map)
  }, [onCode, map, parsed])
  useEffect(() => () => onCode(null), [onCode])

  if (error) return <p className="p-4 text-sm text-red-600 dark:text-red-400">{error}</p>
  if (!parsed) return <Loader2 className="m-auto size-5 animate-spin text-muted-foreground" />
  const { rows } = parsed
  if (rows.length === 0) return <p className="p-4 text-sm text-muted-foreground">Sem diferenças em texto (só permissões ou nada a mostrar).</p>
  return (
    <pre className={cn('w-max min-w-full pb-2', CODE_TEXT)}>
      {shown.map((r, i) =>
        r.kind === 'hunk' ? (
          // O começo de um trecho: o que ficou de fora entre um e outro não muda, e a linha diz onde se está.
          <div
            key={i}
            data-row={i}
            className="mt-3 flex items-center gap-2 border-y border-foreground/[0.06] bg-foreground/[0.035] px-3 py-1 font-sans text-[0.9em] text-muted-foreground first:mt-0 first:border-t-0"
          >
            <span className="shrink-0 tabular-nums">Linha {r.line}</span>
            {r.context && <span className="truncate font-mono text-foreground/70">{r.context}</span>}
          </div>
        ) : r.kind === 'note' ? (
          <div key={i} data-row={i} className="px-3 text-muted-foreground italic">
            {r.text}
          </div>
        ) : (
          <div
            key={i}
            data-row={i}
            // Só as linhas que existem no arquivo novo se mencionam: as tiradas não têm para onde apontar.
            data-line={r.new}
            data-code=""
            className={cn(
              'flex',
              r.kind === 'add' && 'bg-emerald-500/[0.1] shadow-[inset_3px_0_0_var(--color-emerald-500)]',
              r.kind === 'del' && 'bg-red-500/[0.1] shadow-[inset_3px_0_0_var(--color-red-500)]',
            )}
          >
            <span data-n={r.old ?? ''} className={DIFF_GUTTER} />
            <span data-n={r.new ?? ''} className={DIFF_GUTTER} />
            <span
              data-n={r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}
              className={cn(
                'w-[1.4em] shrink-0 text-center select-none before:content-[attr(data-n)]',
                r.kind === 'add' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
              )}
            />
            <span className={cn('pr-4', wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre')}>
              {r.kind === 'ctx' ? (
                <Code text={r.text} tokens={newTokens?.[r.at]} />
              ) : (
                <MarkedCode text={r.text} tokens={(r.side === 'old' ? oldTokens : newTokens)?.[r.at]} range={r.inner} tone={r.kind} />
              )}
            </span>
          </div>
        ),
      )}
      {rows.length > MAX_DIFF_ROWS && <div className="px-3 py-2 text-muted-foreground">… diff com {rows.length} linhas, cortado</div>}
    </pre>
  )
})

/**
 * As setas para ir de mudança em mudança, como no VSCode: "2 de 7" diz em qual o trecho na tela está,
 * e as setas levam à anterior e à seguinte (da última, volta à primeira). Pelo teclado, Alt+↑ / Alt+↓
 * ou F7 / Shift+F7, com o código em foco. Ao lado, o tanto que entrou e saiu.
 */
function ChangeNav({ scrollRef, map }: { scrollRef: React.RefObject<HTMLDivElement | null>; map: CodeMap }) {
  const [current, setCurrent] = useState(-1)
  const total = map.changes.length

  // Onde cada mudança começa, na rolagem; a régua é um terço do alto da tela, onde `revealRow` as põe.
  const tops = () => {
    const el = scrollRef.current
    if (!el) return []
    return map.changes.map((row) => el.querySelector<HTMLElement>(`[data-row="${row}"]`)?.offsetTop ?? 0)
  }
  const ruler = () => {
    const el = scrollRef.current
    return el ? el.scrollTop + el.clientHeight / 3 : 0
  }

  // A última ida, para cliques seguidos: enquanto a rolagem suave anda, a posição ainda é a de antes.
  const last = useRef<{ k: number; at: number } | null>(null)
  const go = (dir: 1 | -1) => {
    const el = scrollRef.current
    if (!el || total === 0) return
    let k: number
    if (last.current && performance.now() - last.current.at < 700) k = (last.current.k + dir + total) % total
    else {
      const at = tops()
      const y = ruler()
      k = dir > 0 ? at.findIndex((t) => t > y + 4) : at.findLastIndex((t) => t < y - 4)
      if (k < 0) k = dir > 0 ? 0 : total - 1
    }
    last.current = { k, at: performance.now() }
    revealRow(el, map.changes[k]!)
    setCurrent(k)
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let frame = 0
    const update = () => {
      frame = 0
      if (last.current && performance.now() - last.current.at < 700) return
      const y = ruler() + 4
      setCurrent(tops().findLastIndex((t) => t <= y))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    const onKey = (e: KeyboardEvent) => {
      const down = (e.altKey && e.key === 'ArrowDown') || (e.key === 'F7' && !e.shiftKey)
      const up = (e.altKey && e.key === 'ArrowUp') || (e.key === 'F7' && e.shiftKey)
      if (!down && !up) return
      e.preventDefault()
      go(down ? 1 : -1)
    }
    el.addEventListener('scroll', schedule, { passive: true })
    el.addEventListener('keydown', onKey)
    schedule()
    return () => {
      el.removeEventListener('scroll', schedule)
      el.removeEventListener('keydown', onKey)
      cancelAnimationFrame(frame)
    }
    // `go` e as réguas leem o mapa da vez: refaz quando ele muda.
  }, [scrollRef, map])

  return <ChangeNavBar added={map.added} removed={map.removed} current={current} total={total} onGo={go} keys={['Alt+↑', 'Alt+↓']} />
}

/**
 * O tamanho da fonte do código (ver lib/code-font.ts): Ctrl+roda e a pinça sobre o código, e Ctrl+= /
 * Ctrl+− / Ctrl+0 com o arquivo aberto, como no VSCode (a página em si não tem zoom no app). A linha que
 * estava no topo continua no topo, em vez de o texto escorregar para baixo ou para cima.
 */
function useCodeZoom(container: React.RefObject<HTMLDivElement | null>): number {
  const size = useCodeFont((s) => s.size)
  const anchor = useRef<{ row: string; offset: number } | null>(null)

  // O aviso do store chega antes de a tela mudar: dá para ver qual linha está no topo com a fonte velha...
  useEffect(
    () =>
      useCodeFont.subscribe(() => {
        const el = container.current
        if (!el) return
        const box = el.getBoundingClientRect()
        const row = document.elementFromPoint(box.left + box.width / 2, box.top + 1)?.closest<HTMLElement>('[data-row]')
        anchor.current = row && el.contains(row) ? { row: row.dataset.row!, offset: row.offsetTop - el.scrollTop } : null
      }),
    [container],
  )
  // ...e, já com a nova, rolar até ela voltar ao mesmo lugar.
  useLayoutEffect(() => {
    const el = container.current
    const at = anchor.current
    anchor.current = null
    const row = at && el?.querySelector<HTMLElement>(`[data-row="${at.row}"]`)
    if (el && at && row) el.scrollTo({ top: row.offsetTop - at.offset })
  }, [size, container])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const by =
        e.key === '=' || e.key === '+' || e.code === 'NumpadAdd'
          ? 1
          : e.key === '-' || e.code === 'NumpadSubtract'
            ? -1
            : e.key === '0' || e.code === 'Numpad0'
              ? 0
              : null
      if (by === null) return
      // No lugar do zoom do navegador, que no app não faz sentido.
      e.preventDefault()
      if (by) stepCodeFont(by)
      else setCodeFont(CODE_FONT)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    const el = container.current
    if (!el) return
    let pinch: { dist: number; size: number } | null = null
    const dist = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY)
    const start = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch = { dist: dist(e.touches), size: useCodeFont.getState().size }
    }
    const move = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return
      e.preventDefault()
      setCodeFont((pinch.size * dist(e.touches)) / pinch.dist)
    }
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null
    }
    // A roda do mouse anda de 100 em 100; a pinça do touchpad (Ctrl+roda também), de poucos em poucos.
    let wheeled = 0
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      wheeled += e.deltaY
      while (Math.abs(wheeled) >= 50) {
        stepCodeFont(wheeled < 0 ? 0.5 : -0.5)
        wheeled -= Math.sign(wheeled) * 50
      }
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('wheel', wheel)
    }
  }, [container])

  return size
}

/**
 * O arquivo (ou o diff) com o topo de ações: no celular, em tela cheia, com o voltar (`dialog`); no
 * PC, como aba (ver pages/workbench.tsx), sem botão de fechar, que é o X da própria aba.
 */
export function ViewerBody({ viewing, dialog }: { viewing: Viewing; dialog: boolean }) {
  const { cwd, path, diff } = viewing
  const [wrap, setWrap] = useState(false)
  const [rendered, setRendered] = useState(false)
  const [file, setFile] = useState<FileView | null>(null)
  const [codeMap, setCodeMap] = useState<CodeMap | null>(null)
  // O minimapa é do PC: no celular a tela é estreita demais para tirar uma coluna do código. Cada aba
  // tem o seu: esconder aqui não mexe no da aba ao lado; o último escolhido vale para as que abrirem depois.
  const [mapOn, setMapOn] = useState(() => useMinimap.getState().code)
  const toggleMap = () => {
    setMapOn(!mapOn)
    setMinimap({ code: !mapOn })
  }
  const canMap = !dialog && (diff ? true : file?.kind === 'text' && !rendered)
  const { name, dir } = splitPath(path)
  const markdown = !diff && /\.mdx?$/i.test(name) && file?.kind === 'text'
  const Title = dialog ? DialogTitle : 'h2'
  const code = useCodeSelection(path)
  const fontSize = useCodeZoom(code.bind.ref)
  const isCode = Boolean(diff) || (file?.kind === 'text' && !rendered)
  // No PC, o texto abre no editor (ver editor.tsx), que avisa o cabeçalho do que tem e faz o que ele pede.
  const editing = !dialog && !diff && !rendered && file?.kind === 'text' && typeof file.hash === 'string'
  const editorHandle = useRef<EditorHandle | null>(null)
  const editorScroll = useRef<HTMLElement | null>(null)
  const [status, setStatus] = useState<EditorStatus | null>(null)
  const editor = useMemo<EditorLink | null>(() => (dialog ? null : { handle: editorHandle, scrollRef: editorScroll, onStatus: setStatus }), [dialog])
  const dirty = useUnsaved((s) => Boolean(s.dirty[keyOf({ kind: 'file', machine: viewing.machine, cwd, path })]))
  const selected = editing ? status?.lines : null
  // No PC, com a cena animada atrás, o arquivo é como a conversa: o topo de vidro e o véu sob o código.
  const glass = useGlass() && !dialog
  const scrim = useScrim()

  return (
    <>
      <header
        className={cn(
          'flex shrink-0 items-center gap-1 border-b px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2',
          glass && 'relative z-10 bg-background/70 backdrop-blur-md',
        )}
      >
        {dialog && (
          <Button variant="ghost" size="icon" onClick={closeViewer} aria-label="Voltar">
            <ArrowLeft />
          </Button>
        )}
        {createElement(diff ? FileDiff : fileIcon(name), { className: cn('size-4 shrink-0 text-muted-foreground', !dialog && 'ml-1.5') })}
        <div className="min-w-0 flex-1 pl-1">
          <Title className="truncate font-mono text-sm font-normal">{name}</Title>
          <div className="truncate font-mono text-xs text-muted-foreground">
            {diff ? `${SIDE_LABEL[diff]} · ` : ''}
            {dir || projectName(cwd)}
            {file && !diff && ` · ${formatSize((editing ? status?.size : null) ?? file.size)}`}
          </div>
        </div>
        {codeMap && codeMap.changes.length > 0 && (diff || !rendered) && <ChangeNav scrollRef={code.bind.ref} map={codeMap} />}
        {editing && status && status.changes.total > 0 && (
          <ChangeNavBar {...status.changes} onGo={(dir) => editorHandle.current?.goChange(dir)} keys={['Shift+F7', 'F7']} />
        )}
        {editing && dirty && (
          <Button variant="secondary" size="sm" disabled={status?.saving} onClick={() => void editorHandle.current?.save()} title="Salvar · Ctrl+S">
            {status?.saving ? <Loader2 className="animate-spin" /> : <Save />} Salvar
          </Button>
        )}
        {diff && (
          // Arquivo apagado não tem o que abrir: o servidor responde que não existe, e a tela diz isso.
          <Button variant="ghost" size="sm" onClick={() => openViewer({ ...viewing, diff: undefined })} aria-label="Abrir arquivo">
            {/* No celular, só o ícone: o topo já tem bastante botão. */}
            <FileText /> <span className="max-sm:hidden">Abrir arquivo</span>
          </Button>
        )}
        {markdown && (
          <Button variant={rendered ? 'secondary' : 'ghost'} size="sm" onClick={() => setRendered((r) => !r)}>
            {rendered ? 'Código' : 'Formatado'}
          </Button>
        )}
        {isCode && (
          <>
            <Button
              variant="ghost"
              size="icon"
              disabled={fontSize <= CODE_FONT_MIN}
              onClick={() => stepCodeFont(-1)}
              aria-label="Diminuir a fonte"
              title={`Diminuir a fonte (${fontSize} px) · Ctrl+−`}
            >
              <AArrowDown />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={fontSize >= CODE_FONT_MAX}
              onClick={() => stepCodeFont(1)}
              aria-label="Aumentar a fonte"
              title={`Aumentar a fonte (${fontSize} px) · Ctrl+= · Ctrl+0 volta ao padrão`}
            >
              <AArrowUp />
            </Button>
          </>
        )}
        {canMap && (
          <Button
            variant={mapOn ? 'secondary' : 'ghost'}
            size="icon"
            onClick={toggleMap}
            aria-pressed={mapOn}
            aria-label="Minimapa"
            title={mapOn ? 'Esconder o minimapa' : 'Mostrar o minimapa'}
          >
            <MapIcon />
          </Button>
        )}
        {isCode && (
          <Button
            variant={wrap ? 'secondary' : 'ghost'}
            size="icon"
            onClick={() => setWrap((w) => !w)}
            aria-pressed={wrap}
            aria-label="Quebrar linhas"
            title="Quebrar linhas"
          >
            <WrapText />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          // No editor, menciona as linhas selecionadas (e grava antes, para o Claude ler o mesmo texto).
          onClick={() => (editing && editorHandle.current ? editorHandle.current.mention() : mention(path))}
          aria-label="Mencionar no chat"
          title={
            selected
              ? `Mencionar ${selected[0] === selected[1] ? `a linha ${selected[0]}` : `as linhas ${selected[0]}–${selected[1]}`} no chat · Ctrl+Alt+K`
              : 'Mencionar no chat'
          }
        >
          <AtSign />
        </Button>
        <CopyButton text={path} className="size-8" />
      </header>
      {/* O código e, à direita dele, o minimapa, numa coluna própria: por cima, cobriria o fim das linhas. */}
      <div className="relative flex min-h-0 flex-1">
        {/* O escurecido atrás do código, de lado a lado; fora da rolagem, para não rolar junto. */}
        {glass && scrim !== null && <Veil dim={scrim} />}
        <div
          // Focável pelo clique (sem entrar no Tab): é o que leva as teclas de mudança (ver `ChangeNav`).
          tabIndex={-1}
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-auto outline-none"
          style={
            {
              '--code-font': `${fontSize}px`,
              ...(glass && { '--code-gutter': 'color-mix(in oklab, var(--background) 70%, transparent)' }),
            } as React.CSSProperties
          }
          {...code.bind}
        >
          {diff ? (
            <DiffContent viewing={viewing} wrap={wrap} onCode={setCodeMap} />
          ) : (
            <FileContent viewing={viewing} wrap={wrap} rendered={rendered} minimap={mapOn} editor={editor} onView={setFile} onCode={setCodeMap} />
          )}
          {code.highlight}
        </div>
        {canMap && mapOn && codeMap && (
          // No editor, quem rola é o próprio CodeMirror.
          <CodeMinimap scrollRef={editing && status ? editorScroll : code.bind.ref} lines={codeMap.lines} tokens={codeMap.tokens} marks={codeMap.marks} tint={codeMap.tint} />
        )}
        {code.overlay}
      </div>
    </>
  )
}

/**
 * O arquivo ou o diff aberto pela barra do projeto no celular: ocupa a tela toda, e o voltar fecha.
 * No PC, ele abre como aba (ver lib/workbench.ts).
 */
export function ProjectViewer() {
  const viewing = useProjectPanel((s) => s.viewing)
  const wide = useWide()
  if (wide) return null
  const key = viewing && `${viewing.machine}\n${viewing.cwd}\n${viewing.path}\n${viewing.diff ?? ''}`
  return (
    <Dialog open={viewing !== null} onOpenChange={(o) => !o && closeViewer()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-dvh w-screen max-w-none flex-col gap-0 rounded-none border-0 p-0 ring-0 sm:max-w-none"
      >
        {viewing && <ViewerBody key={key} viewing={viewing} dialog />}
      </DialogContent>
    </Dialog>
  )
}
