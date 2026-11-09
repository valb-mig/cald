import { ChevronRight, CodeXml, PanelRight } from 'lucide-react'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ThemedToken } from 'shiki/core'
import { Claudinho } from '@/components/claudinho'
import { FileIcon, FolderIcon } from '@/components/project/file-icons'
import { api } from '@/lib/api'
import { setCodeSide, useCodeSide } from '@/lib/chat-view'
import { shortPath } from '@/lib/format'
import { tokenStyle, useTokens } from '@/lib/highlight'
import type { FileView } from '@/lib/types'
import { cn } from '@/lib/utils'
import { LineCounts } from './activity'
import { buildTree, relOf, targetOf, type FileEdit, type FileInfo, type TreeNode } from './code-files'
import { CodeEmptyArt } from './empty-art'
import { isRecent, reducedMotion } from './fresh'
import { ScreenBar } from './screen-bar'
import { ScreenCtx } from './screen-ctx'

// O laranja do Claude: a faixa que ele acabou de escrever.
const CLAUDE = '#d97757'
const MAX_ROWS = 3000

/** As edições que já passaram por esta tela: cada uma é digitada uma vez só (pelo id da chamada). */
const seenEdits = new Set<string>()

const nlCount = (s: string, to: number) => {
  let n = 0
  for (let i = s.indexOf('\n'); i !== -1 && i < to; i = s.indexOf('\n', i + 1)) n++
  return n
}

/** O arquivo depois da edição: o `old` de cada parte trocado pelo `new` (o Write troca tudo). */
function applied(before: string, edit: FileEdit): string {
  if (edit.kind === 'Write' || edit.kind === 'NotebookEdit') return edit.edits[0]!.new
  let text = before
  for (const p of edit.edits) if (p.old && text.includes(p.old)) text = text.replace(p.old, () => p.new)
  return text
}

type Mark = 'last' | 'prev' | undefined

/** As linhas que as edições escreveram, achadas pelo texto novo no conteúdo de agora; o Write (o arquivo todo) não marca. */
function marksOf(content: string, info: FileInfo): { marks: Mark[]; first: number } {
  const marks: Mark[] = []
  let first = -1
  for (const e of info.edits) {
    if (e.kind !== 'Edit' && e.kind !== 'MultiEdit') continue
    if (e.result?.isError) continue
    const last = e === info.last
    for (const p of e.edits) {
      if (!p.new.trim()) continue
      const at = content.indexOf(p.new)
      if (at < 0) continue
      const start = nlCount(content, at)
      const end = start + p.new.replace(/\n$/, '').split('\n').length - 1
      for (let l = start; l <= end; l++) marks[l] = last ? 'last' : 'prev'
      if (last && (first < 0 || start < first)) first = start
    }
  }
  return { marks, first }
}

type Disk = { path: string; key: string; view: FileView | 'missing' }

/** O arquivo no disco; relê quando `key` muda (uma edição dele ganhou resposta). Sem ler, `null`. */
function useDisk(machine: string, cwd: string, path: string, key: string): Disk | null {
  const [disk, setDisk] = useState<Disk | null>(null)
  useEffect(() => {
    let alive = true
    const at = targetOf(path, cwd)
    api.file(machine, at.cwd, at.rel).then(
      (view) => alive && setDisk({ path, key, view }),
      () => alive && setDisk({ path, key, view: 'missing' }),
    )
    return () => {
      alive = false
    }
  }, [machine, cwd, path, key])
  return disk && disk.path === path ? disk : null
}

type Anim = { edit: FileEdit; before: string; i: number; old: string; text: string }
type Row = { text: string; tokens?: ThemedToken[]; mark?: Mark | 'zone'; cursor?: boolean; first?: boolean }

function Rows({ rows, seed }: { rows: Row[]; seed: string }) {
  return (
    <div className="relative w-max min-w-full py-1 font-mono text-[11px] leading-5">
      {rows.map((r, n) => (
        <div
          key={n}
          data-mark={r.mark}
          data-cursor={r.cursor ? '' : undefined}
          className={cn('relative flex whitespace-pre', (r.mark === 'last' || r.mark === 'zone') && 'bg-[#d97757]/10 shadow-[inset_2px_0_0_#d97757]')}
        >
          <span className="relative w-11 shrink-0 pr-2 text-right text-muted-foreground/60 select-none">
            {n + 1}
            {r.mark === 'prev' && <span className="absolute inset-y-0.5 right-0 w-0.5 rounded-full" style={{ background: `${CLAUDE}66` }} />}
          </span>
          <span className="pr-16">
            {r.tokens
              ? r.tokens.map((t, j) => (
                  <span key={j} style={tokenStyle(t)}>
                    {t.content}
                  </span>
                ))
              : r.text}
          </span>
          {/* Preso à borda direita do que se vê: sem quebra de linha, o fim da linha fica fora da área. */}
          {r.first && (
            <span className="pointer-events-none sticky right-2 z-10 ml-auto w-0 self-start">
              <span className="absolute top-0.5 right-0 rounded-full bg-background/80">
                <Claudinho seed={seed} size={16} />
              </span>
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

// Pastas recolhidas, por conversa e caminho: trocar de arquivo ou fechar o painel não as reabre.
const closed = new Set<string>()

/** Se o arquivo `path` (absoluto) está em algum lugar debaixo de `node`. */
const holds = (node: TreeNode, path: string | null): boolean =>
  Boolean(path) && (node.file?.path === path || node.children.some((c) => holds(c, path)))

type TreeProps = { nodes: TreeNode[]; shown: string; running: string | null; sessionId: string; onPick: (path: string) => void }

/** A árvore dos mexidos como a do explorador: seta para recolher, linha-guia em cada nível. */
function Tree({ nodes, ...props }: TreeProps) {
  const { shown, running, sessionId, onPick } = props
  const [, redraw] = useState(0)
  return nodes.map((n) => {
    if (n.file)
      return (
        <button
          key={n.key}
          type="button"
          onClick={() => onPick(n.file!.path)}
          title={n.file.path}
          className={cn('flex w-full min-w-0 items-center gap-1 rounded-md py-1 pr-1.5 pl-1 text-left text-xs select-none hover:bg-muted', shown === n.file.path && 'bg-muted')}
        >
          {/* No lugar da seta das pastas, para os ícones ficarem na mesma coluna. */}
          <span className="size-3 shrink-0" />
          <FileIcon name={n.name} className="size-3.5 shrink-0" />
          <span className={cn('min-w-0 flex-1 truncate', n.file.state === 'failed' && 'text-red-600 dark:text-red-400')}>{n.name}</span>
          {running === n.file.path ? <Claudinho seed={sessionId} size={14} className="shrink-0 animate-pulse" /> : <LineCounts added={n.file.added} removed={n.file.removed} className="shrink-0 text-[10px]" />}
        </button>
      )
    const id = `${sessionId}:${n.key}`
    const open = !closed.has(id)
    return (
      <div key={n.key}>
        <button
          type="button"
          onClick={() => {
            if (open) closed.add(id)
            else closed.delete(id)
            redraw((x) => x + 1)
          }}
          aria-expanded={open}
          className="flex w-full min-w-0 items-center gap-1 rounded-md py-1 pr-1.5 pl-1 text-left text-xs text-muted-foreground select-none hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
          <FolderIcon name={n.name} open={open} className="size-3.5 shrink-0" />
          {/* Caminho juntado e comprido: só as duas últimas pastas, que dizem onde se está; o resto no title. */}
          <span className="min-w-0 flex-1 truncate" title={n.name}>
            {n.name.split('/').length > 2 ? `…/${n.name.split('/').slice(-2).join('/')}` : n.name}
          </span>
          {/* Recolhida, ainda avisa que o Claude está escrevendo lá dentro. */}
          {!open && holds(n, running) && <Claudinho seed={sessionId} size={14} className="shrink-0 animate-pulse" />}
        </button>
        {open && (
          <div className="ml-[10px] border-l border-foreground/10 pl-0.5">
            <Tree nodes={n.children} {...props} />
          </div>
        )}
      </div>
    )
  })
}

/** Mostra ou esconde a árvore dos arquivos mexidos; a escolha é do aparelho. */
function SideToggle() {
  const side = useCodeSide((s) => s.open)
  return (
    <button
      type="button"
      onClick={() => setCodeSide(!side)}
      aria-pressed={side}
      aria-label="Arquivos mexidos"
      title="Arquivos mexidos"
      className={cn('grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground', side && 'text-foreground')}
    >
      <PanelRight className="size-4" />
    </button>
  )
}

/** A tela de código antes da primeira edição da conversa: o mesmo lugar e a mesma barra, sem arquivo. */
export function CodeEmpty() {
  const side = useCodeSide((s) => s.open)
  const ctx = useContext(ScreenCtx)
  return (
    <>
      <ScreenBar icon={<CodeXml />} title="Código">
        <span className="flex-1" />
        <SideToggle />
      </ScreenBar>
      <div className={cn('flex min-h-0 flex-1', ctx?.collapsed && 'hidden')}>
        <CodeEmptyArt />
        {side && <div className="w-[190px] shrink-0 bg-foreground/[0.03]" />}
      </div>
    </>
  )
}

/**
 * Os arquivos que o Claude edita, ao vivo: a árvore dos mexidos e o arquivo em leitura, com a faixa nova
 * em destaque. A edição que chega é "digitada" no lugar dela: o input da ferramenta vem inteiro, então a
 * digitação é encenada. Só leitura, e leve: nada do editor (salvar, rascunhos, abas).
 */
export function CodeVision({ sessionId, machine, cwd, files, live }: { sessionId: string; machine: string; cwd: string; files: FileInfo[]; live: boolean }) {
  const side = useCodeSide((s) => s.open)
  const [follow, setFollow] = useState(true)
  const [picked, setPicked] = useState<string | null>(null)
  const path = (follow ? files[0]?.path : (picked ?? files[0]?.path)) ?? ''
  const info = files.find((f) => f.path === path) ?? files[0]!

  // Relê quando uma edição dele ganha resposta.
  const doneKey = info.edits.filter((e) => e.result).map((e) => e.toolId).join(',')
  const disk = useDisk(machine, cwd, path, doneKey)

  const [override, setOverride] = useState<{ toolId: string; text: string } | null>(null)
  const [wait, setWait] = useState<FileEdit | null>(null)
  const [anim, setAnim] = useState<Anim | null>(null)
  const [k, setK] = useState(0)
  // Terminada a digitação, o arranjo fica (faixa completa, sem cursor) até o realce do conteúdo final chegar.
  const [settle, setSettle] = useState<Anim | null>(null)

  // O texto local da edição que acabou de ser digitada vale até o disco dizer o mesmo (ou recusar).
  useEffect(() => {
    if (override && disk && disk.key.split(',').includes(override.toolId)) setOverride(null)
  }, [disk, override])

  // Edição recém-chegada: com o ao vivo ligado, vira a que se digita.
  const edits = useMemo(() => files.flatMap((f) => f.edits), [files])
  useEffect(() => {
    let fresh: FileEdit | undefined
    for (const e of edits) {
      if (seenEdits.has(e.toolId)) continue
      seenEdits.add(e.toolId)
      if (isRecent(e.at ?? e.started) && !reducedMotion() && e.kind !== 'NotebookEdit') fresh = e
    }
    if (fresh && follow) setWait(fresh)
  }, [edits, follow])

  // Com o arquivo dela lido, acha onde o texto velho está e começa a digitar; sem achar, só destaca.
  useEffect(() => {
    if (!wait || wait.path !== path || !disk) return
    setWait(null)
    const before = disk.view === 'missing' ? '' : disk.view.kind === 'text' ? disk.view.content : null
    if (before === null) return
    const piece = wait.edits[0]
    if (!piece) return
    const write = piece.old === null
    const old = write ? before : piece.old!
    const i = write ? 0 : old ? before.indexOf(old) : -1
    if (i < 0) return
    setK(0)
    setAnim({ edit: wait, before, i, old, text: piece.new })
  }, [wait, disk, path])

  const animId = anim?.edit.toolId
  useEffect(() => {
    if (!anim) return
    const total = Math.min(1500, Math.max(300, anim.text.length * 8))
    const start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / total)
      setK(Math.ceil(anim.text.length * p))
      if (p < 1) frame = requestAnimationFrame(tick)
      else {
        setOverride({ toolId: anim.edit.toolId, text: applied(anim.before, anim.edit) })
        setSettle(anim)
        setAnim(null)
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // Só recomeça numa edição nova.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animId])

  // Trocar de arquivo no meio da digitação a corta: o texto final já vale.
  useEffect(() => {
    if (anim && anim.edit.path !== path) setAnim(null)
  }, [anim, path])

  const text = disk && disk.view !== 'missing' && disk.view.kind === 'text' ? disk.view.content : null
  const content = override && override.toolId && info.edits.some((e) => e.toolId === override.toolId) ? override.text : text
  const arr = anim ?? settle
  // Dois realces: o do arquivo de antes (fora da faixa, durante o arranjo) e o do conteúdo de agora.
  const beforeTokens = useTokens(arr ? arr.before : null, path)
  const tokens = useTokens(content, path)
  useEffect(() => {
    if (settle && (tokens || content === null || settle.edit.path !== path)) setSettle(null)
  }, [settle, tokens, content, path])

  const rows = useMemo<Row[] | null>(() => {
    if (arr) {
      const { before, i, old, text: typed } = arr
      const lines = before.split('\n')
      const tk = beforeTokens
      const a = nlCount(before, i)
      const end = i + old.length
      const endLine = nlCount(before, end)
      const lineStart = before.lastIndexOf('\n', i - 1) + 1
      const nextNl = before.indexOf('\n', end)
      const zone = `${before.slice(lineStart, i)}${anim ? typed.slice(0, k) : typed}${anim ? '▊' : ''}${before.slice(end, nextNl < 0 ? before.length : nextNl)}`.split('\n')
      // Fora da faixa, os tokens do arquivo de antes: só ela é texto puro, e não se retokeniza a cada quadro.
      return [
        ...lines.slice(0, a).map((t, n): Row => ({ text: t, tokens: tk?.[n] })),
        ...zone.map((t, n): Row => ({ text: t, mark: 'zone', cursor: Boolean(anim) && n === zone.length - 1, first: n === 0 })),
        ...lines.slice(endLine + 1).map((t, n): Row => ({ text: t, tokens: tk?.[endLine + 1 + n] })),
      ]
    }
    if (content === null) return null
    const { marks, first } = marksOf(content, info)
    return content.split('\n').map((t, n): Row => ({ text: t, tokens: tokens?.[n], mark: marks[n], first: n === first }))
  }, [arr, anim, k, content, tokens, beforeTokens, info])

  // O que se vê acompanha o cursor (e, sem digitação, vai à faixa nova uma vez por edição).
  const scroller = useRef<HTMLDivElement>(null)
  const scrolled = useRef('')
  useEffect(() => {
    const box = scroller.current
    if (!box || !follow) return
    const el = anim ? box.querySelector<HTMLElement>('[data-cursor]') : box.querySelector<HTMLElement>('[data-mark="last"]')
    if (!el) return
    const mark = `${path}:${info.last.toolId}`
    if (!anim && scrolled.current === mark) return
    if (!anim) scrolled.current = mark
    box.scrollTop = Math.max(0, el.offsetTop - box.clientHeight / 2)
  }, [rows, anim, follow, path, info.last.toolId])

  const tree = useMemo(() => buildTree(files.map((f) => ({ rel: relOf(f.path, cwd), info: f }))), [files, cwd])
  const running = live ? (files.find((f) => f.state === 'running')?.path ?? null) : null
  const seed = info.last.agent === 'main' ? sessionId : info.last.agent.seed
  const view = disk?.view
  const ctx = useContext(ScreenCtx)

  return (
    <>
      <ScreenBar icon={<CodeXml />} title="Código">
        <FileIcon name={path.split('/').pop() ?? ''} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={path}>
          {shortPath(relOf(path, cwd))}
        </span>
        <button
          type="button"
          onClick={() => {
            if (follow) {
              setPicked(path)
              setFollow(false)
            } else setFollow(true)
          }}
          aria-pressed={follow}
          title={follow ? 'Acompanhando o último arquivo: tocar para pausar' : 'Pausado: tocar para acompanhar'}
          className={cn('flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-muted', follow ? 'text-foreground' : 'text-muted-foreground')}
        >
          <span className={cn('size-1.5 rounded-full', follow ? 'animate-pulse bg-red-500' : 'bg-muted-foreground/40')} />
          Ao vivo
        </button>
        <SideToggle />
      </ScreenBar>
      <div className={cn('flex min-h-0 flex-1', ctx?.collapsed && 'hidden')}>
        <div ref={scroller} className="relative min-w-0 flex-1 overflow-auto">
          {rows ? (
            <>
              <Rows rows={rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows} seed={seed} />
              {view && view !== 'missing' && view.kind === 'text' && view.truncated && <p className="px-3 pb-2 text-xs text-muted-foreground">Arquivo cortado: só o começo.</p>}
            </>
          ) : (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              {view === 'missing' ? 'Arquivo indisponível' : view ? (view.kind === 'text' ? '' : 'Arquivo que não é texto') : 'Carregando…'}
            </p>
          )}
        </div>
        {side && (
          <div className="w-[190px] shrink-0 overflow-y-auto bg-foreground/[0.03] px-1 py-1">
            <Tree
              nodes={tree}
              shown={path}
              running={running}
              sessionId={sessionId}
              onPick={(p) => {
                setPicked(p)
                setFollow(false)
              }}
            />
          </div>
        )}
      </div>
    </>
  )
}
