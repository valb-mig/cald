import { AArrowDown, AArrowUp, ArrowLeft, AtSign, ExternalLink, FileDiff, FileText, Loader2, WrapText } from 'lucide-react'
import { createElement, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ThemedToken } from 'shiki/core'
import { CopyButton, Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { api, errorMessage, fileRawUrl } from '@/lib/api'
import { formatSize } from '@/lib/attachments'
import { CODE_FONT, CODE_FONT_MAX, CODE_FONT_MIN, setCodeFont, stepCodeFont, useCodeFont } from '@/lib/code-font'
import { projectName } from '@/lib/format'
import { useWide } from '@/lib/hooks'
import { tokenStyle, useTokens } from '@/lib/highlight'
import { closeViewer, openViewer, useProjectPanel, type Viewing } from '@/lib/project-panel'
import type { FileView } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useCodeSelection } from './code-mention'
import { mention } from './file-menu'
import { fileIcon, splitPath } from './status'

const MAX_LINES = 5_000
const MAX_DIFF_ROWS = 4_000

const SIDE_LABEL = { staged: 'Alterações preparadas', unstaged: 'Alterações' } as const

// Números da margem desenhados pelo CSS (`data-n`): fora da seleção e do que se copia. Em `em`, para
// crescerem com a fonte do código (ver `useCodeZoom`).
const GUTTER = 'w-[4em] shrink-0 pr-[1em] text-right text-muted-foreground/60 select-none before:content-[attr(data-n)]'
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

function TextContent({ content, path, wrap }: { content: string; path: string; wrap: boolean }) {
  const lines = useMemo(() => content.split('\n'), [content])
  const shown = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines
  const code = useMemo(() => (lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join('\n') : content), [lines, content])
  const tokens = useTokens(code, path)
  return (
    // Sem a seleção do navegador: a de linhas é do app (ver code-mention.tsx), assim como `data-*`.
    <pre className={cn('min-w-full py-2', CODE_TEXT)}>
      {shown.map((line, i) => (
        <div key={i} data-row={i} data-line={i + 1} data-code="" className="flex">
          <span data-n={i + 1} className={GUTTER} />
          <span className={cn('pr-4', wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre')}>
            <Code text={line} tokens={tokens?.[i]} />
          </span>
        </div>
      ))}
      {lines.length > MAX_LINES && (
        <div className="px-4 py-2 text-muted-foreground">… mostrando {MAX_LINES} de {lines.length} linhas</div>
      )}
    </pre>
  )
}

/**
 * `onView` avisa o cabeçalho do que chegou (tamanho, se é texto); precisa ser estável, como um
 * `setState`. Memorizado, como o diff: a seleção de linhas muda o cabeçalho sem redesenhar o código.
 */
const FileContent = memo(function FileContent({
  viewing,
  wrap,
  rendered,
  onView,
}: {
  viewing: Viewing
  wrap: boolean
  rendered: boolean
  onView: (v: FileView) => void
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
    return (
      <>
        {rendered ? <Markdown text={view.content} className="p-4" /> : <TextContent content={view.content} path={path} wrap={wrap} />}
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
  | { kind: 'hunk'; text: string }
  | { kind: 'add' | 'del' | 'ctx'; old?: number; new?: number; text: string; side: 'old' | 'new'; at: number }
  | { kind: 'note'; text: string }

/**
 * O diff unificado em linhas com o número antigo e o novo; o cabeçalho do git (`diff`, `index`, `---`)
 * sai. Junta também os dois lados como texto (o antigo: contexto e tiradas; o novo: contexto e
 * colocadas), para colorir cada um de uma vez: uma linha sozinha não sabe se está dentro de um
 * comentário ou de uma string que começou antes. `at` é a linha dela no texto do seu lado.
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
      rows.push({ kind: 'hunk', text: line })
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
  return { rows, old: before, new: after }
}

const DiffContent = memo(function DiffContent({ viewing, wrap }: { viewing: Viewing; wrap: boolean }) {
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
  const tokens = { old: useTokens(oldText, path), new: useTokens(newText, path) }

  if (error) return <p className="p-4 text-sm text-red-600 dark:text-red-400">{error}</p>
  if (!parsed) return <Loader2 className="m-auto size-5 animate-spin text-muted-foreground" />
  const { rows } = parsed
  if (rows.length === 0) return <p className="p-4 text-sm text-muted-foreground">Sem diferenças em texto (só permissões ou nada a mostrar).</p>
  return (
    <pre className={cn('w-max min-w-full py-1', CODE_TEXT)}>
      {rows.slice(0, MAX_DIFF_ROWS).map((r, i) =>
        r.kind === 'hunk' ? (
          <div key={i} data-row={i} className="mt-1 bg-sky-500/10 px-3 text-sky-700 first:mt-0 dark:text-sky-300">
            {r.text}
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
              r.kind === 'add' && 'bg-emerald-500/15 text-emerald-900 dark:text-emerald-100',
              r.kind === 'del' && 'bg-red-500/15 text-red-900 dark:text-red-100',
            )}
          >
            <span data-n={r.old ?? ''} className={DIFF_GUTTER} />
            <span data-n={r.new ?? ''} className={DIFF_GUTTER} />
            <span
              data-n={r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}
              className="w-[1.4em] shrink-0 text-center text-muted-foreground select-none before:content-[attr(data-n)]"
            />
            <span className={cn('pr-4', wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre')}>
              <Code text={r.text} tokens={tokens[r.side]?.[r.at]} />
            </span>
          </div>
        ),
      )}
      {rows.length > MAX_DIFF_ROWS && <div className="px-3 py-2 text-muted-foreground">… diff com {rows.length} linhas, cortado</div>}
    </pre>
  )
})

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

/** Cabeçalho e conteúdo: o arquivo (só leitura) ou o diff de um lado dele. */
/**
 * O arquivo (ou o diff) com o topo de ações: no celular, em tela cheia, com o voltar (`dialog`); no
 * PC, como aba (ver pages/workbench.tsx), sem botão de fechar, que é o X da própria aba.
 */
export function ViewerBody({ viewing, dialog }: { viewing: Viewing; dialog: boolean }) {
  const { cwd, path, diff } = viewing
  const [wrap, setWrap] = useState(false)
  const [rendered, setRendered] = useState(false)
  const [file, setFile] = useState<FileView | null>(null)
  const { name, dir } = splitPath(path)
  const markdown = !diff && /\.mdx?$/i.test(name) && file?.kind === 'text'
  const Title = dialog ? DialogTitle : 'h2'
  const code = useCodeSelection(path)
  const fontSize = useCodeZoom(code.bind.ref)
  const isCode = Boolean(diff) || (file?.kind === 'text' && !rendered)

  return (
    <>
      <header className="flex shrink-0 items-center gap-1 border-b px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
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
            {file && !diff && ` · ${formatSize(file.size)}`}
          </div>
        </div>
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
        <Button variant="ghost" size="icon" onClick={() => mention(path)} aria-label="Mencionar no chat" title="Mencionar no chat">
          <AtSign />
        </Button>
        <CopyButton text={path} className="size-8" />
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className="relative flex min-h-0 flex-1 flex-col overflow-auto"
          style={{ '--code-font': `${fontSize}px` } as React.CSSProperties}
          {...code.bind}
        >
          {diff ? <DiffContent viewing={viewing} wrap={wrap} /> : <FileContent viewing={viewing} wrap={wrap} rendered={rendered} onView={setFile} />}
          {code.highlight}
        </div>
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
