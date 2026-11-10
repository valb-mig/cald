import { ChevronRight, CodeXml, FileX, PanelRight } from 'lucide-react'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ThemedToken } from 'shiki/core'
import { Claudinho } from '@/components/claudinho'
import { Dot } from '@/components/project/diff-lines'
import { TINT, toneOf, type Block } from '@/components/project/diff-tone'
import { FileIcon, FolderIcon } from '@/components/project/file-icons'
import { api } from '@/lib/api'
import { setCodeSide, useCodeSide } from '@/lib/chat-view'
import { shortPath } from '@/lib/format'
import { tokenStyle, useTokens } from '@/lib/highlight'
import type { FileView } from '@/lib/types'
import { cn } from '@/lib/utils'
import { LineCounts } from './activity'
import { buildTree, relOf, targetOf, type FileEdit, type FileInfo, type TreeNode } from './code-files'
import { useGitAdded, type GitSide } from './code-git'
import { CodeEmptyArt, FileMissingArt, FileNotTextArt } from './empty-art'
import { isRecent, reducedMotion } from './fresh'
import { ScreenBar } from './screen-bar'
import { ScreenCtx } from './screen-ctx'

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
function marksOf(content: string, info: FileInfo): { marks: Mark[]; first: number; dels: Map<number, string[]> } {
  const marks: Mark[] = []
  // As linhas que a edição mais recente tirou, logo antes do que pôs no lugar.
  const dels = new Map<number, string[]>()
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
      if (last && p.old?.trim()) dels.set(start, p.old.replace(/\n$/, '').split('\n'))
    }
  }
  return { marks, first, dels }
}

type Disk = { path: string; key: string; view: FileView | 'missing' }

/** O arquivo no disco; relê quando `key` muda (uma edição dele ganhou resposta). Sem ler, `null`. */
function useDisk(machine: string, cwd: string, path: string, key: string): Disk | null {
  const [disk, setDisk] = useState<Disk | null>(null)
  useEffect(() => {
    // Sem caminho: nada a ler (arquivo apagado).
    if (!path) return
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
/** `del`: uma linha que saiu (não existe no arquivo de agora, sem número). */
type Row = { text: string; tokens?: ThemedToken[]; mark?: Mark | 'zone' | 'git'; cursor?: boolean; first?: boolean; del?: boolean }

const changed = (r: Row) => r.del || Boolean(r.mark)

/**
 * O arquivo com as mudanças no desenho do diff moderno (ver `DiffLines`): cada bloco de linhas que
 * entraram ou saíram é um cartão arredondado, com a bolinha (+, − ou ±) que o recolhe e o tracejado.
 * O bloco da edição mais recente (e o que se digita) leva um anel laranja do Claude na bolinha.
 */
function Rows({ rows, seed }: { rows: Row[]; seed: string }) {
  const [folded, setFolded] = useState<Set<number>>(() => new Set())
  const toggle = (i: number) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  // De cada linha, o bloco dela.
  const blockAt = useMemo(() => {
    const out: (Block | undefined)[] = []
    let open: Block | null = null
    rows.forEach((r, i) => {
      if (!changed(r)) {
        open = null
        return
      }
      open ??= { start: i, end: i, adds: 0, dels: 0 }
      open.end = i + 1
      if (r.del) open.dels++
      else open.adds++
      out[i] = open
    })
    return out
  }, [rows])
  // O número de cada linha no arquivo (as que saíram não têm).
  const nums = useMemo(() => {
    let n = 0
    return rows.map((r) => (r.del ? 0 : ++n))
  }, [rows])
  const out: React.ReactNode[] = []
  let skipTo = 0
  for (let i = 0; i < rows.length; i++) {
    if (i < skipTo) continue
    const r = rows[i]!
    const block = blockAt[i]
    if (block && i === block.start && folded.has(i)) {
      const tone = toneOf(block)
      out.push(
        <div key={i} className={cn('mx-2 my-1 flex items-center rounded-[0.6em]', TINT[block.adds ? 'add' : 'del'])}>
          <span className="w-11 shrink-0" />
          <span className="flex w-5 shrink-0 items-center justify-center">
            <Dot block={block} open={false} onToggle={() => toggle(i)} />
          </span>
          <button type="button" onClick={() => toggle(i)} className="py-px pr-4 text-left font-sans text-[0.9em] text-muted-foreground hover:text-foreground">
            {tone.label}
          </button>
        </div>,
      )
      skipTo = block.end
      continue
    }
    const first = block?.start === i
    const last = block?.end === i + 1
    const mine = block && rows.slice(block.start, block.end).some((x) => x.mark === 'last' || x.mark === 'zone')
    out.push(
      <div
        key={i}
        data-mark={r.mark}
        data-cursor={r.cursor ? '' : undefined}
        className={cn('relative mx-2 flex whitespace-pre', block && TINT[r.del ? 'del' : 'add'], first && 'mt-1 rounded-t-[0.6em]', last && 'mb-1 rounded-b-[0.6em]')}
      >
        <span className="w-11 shrink-0 pr-2 text-right text-muted-foreground/60 select-none">{r.del ? '' : nums[i]}</span>
        <span className="relative flex w-5 shrink-0 justify-center">
          {block && first && (
            <span className="flex h-5 items-center">
              <Dot block={block} open onToggle={() => toggle(i)} className={cn(mine && 'ring-2 ring-[#d97757]')} />
            </span>
          )}
          {block && block.end - block.start > 1 && (
            <span aria-hidden className={cn('absolute left-1/2 border-l border-dashed', toneOf(block).line, first ? 'top-4 bottom-0' : last ? 'top-0 h-2.5' : 'inset-y-0')} />
          )}
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
      </div>,
    )
  }
  return <div className="relative w-max min-w-full py-1 font-mono text-[11px] leading-5">{out}</div>
}

// O esqueleto do carregando: recuo e largura de cada linha, em px, como um trecho de código qualquer.
const SKELETON: [number, number][] = [
  [0, 96], [0, 168], [16, 132], [16, 76], [0, 24], [0, 0], [0, 120], [16, 188], [32, 144], [32, 104], [16, 40], [0, 0], [0, 84], [16, 156],
]

/**
 * Lendo o arquivo: linhas de código em barras, no lugar e no passo das de verdade (gutter, 20 px por linha),
 * para o conteúdo entrar sem pular. Aparece só depois de um instante: leitura rápida não pisca nada.
 */
function CodeSkeleton() {
  return (
    <div aria-busy aria-label="Carregando" className="min-w-0 flex-1 animate-in overflow-hidden py-1 fade-in-0 duration-300" style={{ animationDelay: '200ms', animationFillMode: 'backwards' }}>
      {SKELETON.map(([indent, w], n) => (
        <div key={n} className="flex h-5 items-center">
          <span className="flex w-11 shrink-0 justify-end pr-2">
            <span className="h-2 w-2.5 rounded-full bg-muted/60" />
          </span>
          {w > 0 && <span className="h-2 animate-pulse rounded-full bg-muted motion-reduce:animate-none" style={{ marginLeft: indent, width: w, animationDelay: `${n * 60}ms` }} />}
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
          <span className={cn('min-w-0 flex-1 truncate', n.file.state === 'failed' && 'text-red-600 dark:text-red-400', n.file.git?.letter === 'D' && 'line-through opacity-60')}>{n.name}</span>
          {running === n.file.path ? <Claudinho seed={sessionId} size={14} className="shrink-0 animate-pulse" /> : <LineCounts added={n.file.added} removed={n.file.removed} className="shrink-0 text-[10px]" />}
          {/* Só o git viu: a letra dele, discreta (sem claudinho, não se sabe quem mexeu). */}
          {n.file.git && (
            <span className="w-3 shrink-0 text-center font-mono text-[10px] text-muted-foreground" title="Mudado no git">
              {n.file.git.letter}
            </span>
          )}
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
export function CodeVision({ sessionId, machine, cwd, files, live, gitSide }: { sessionId: string; machine: string; cwd: string; files: FileInfo[]; live: boolean; gitSide: GitSide }) {
  const side = useCodeSide((s) => s.open)
  const [follow, setFollow] = useState(true)
  const [picked, setPicked] = useState<string | null>(null)
  const path = (follow ? files[0]?.path : (picked ?? files[0]?.path)) ?? ''
  const info = files.find((f) => f.path === path) ?? files[0]!

  // Relê quando uma edição dele ganha resposta.
  // Só do git: relê quando o git diz outra coisa dele.
  const gitKey = info.git ? `git:${info.git.letter}:${info.git.additions}:${info.git.deletions}` : ''
  const doneKey = gitKey || info.edits.filter((e) => e.result).map((e) => e.toolId).join(',')
  const deleted = info.git?.letter === 'D'
  const disk = useDisk(machine, cwd, deleted ? '' : path, doneKey)
  const gitAdded = useGitAdded(machine, cwd, info.git && !deleted ? info.git.path : null, gitSide, gitKey)

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
      // As linhas velhas, em vermelho acima do que se escreve (o Write troca o arquivo todo: sem elas).
      const gone = arr.edit.edits[0]?.old?.trim() && arr.edit.kind !== 'Write' ? old.replace(/\n$/, '').split('\n').map((d): Row => ({ text: d, del: true })) : []
      return [
        ...lines.slice(0, a).map((t, n): Row => ({ text: t, tokens: tk?.[n] })),
        ...gone,
        ...zone.map((t, n): Row => ({ text: t, mark: 'zone', cursor: Boolean(anim) && n === zone.length - 1, first: n === 0 })),
        ...lines.slice(endLine + 1).map((t, n): Row => ({ text: t, tokens: tk?.[endLine + 1 + n] })),
      ]
    }
    if (content === null) return null
    // Só do git: as linhas novas do diff, sem claudinho (não se sabe quem mexeu).
    const withDels = (dels: Map<number, string[]> | undefined, row: (t: string, n: number) => Row) =>
      content.split('\n').flatMap((t, n): Row[] => [...(dels?.get(n) ?? []).map((d): Row => ({ text: d, del: true })), row(t, n)])
    if (info.git) return withDels(gitAdded?.removed, (t, n) => ({ text: t, tokens: tokens?.[n], mark: gitAdded?.added.has(n) ? 'git' : undefined }))
    const { marks, first, dels } = marksOf(content, info)
    return withDels(dels, (t, n) => ({ text: t, tokens: tokens?.[n], mark: marks[n], first: n === first }))
  }, [arr, anim, k, content, tokens, beforeTokens, info, gitAdded])

  // O que se vê acompanha o cursor (e, sem digitação, vai à faixa nova uma vez por edição).
  const scroller = useRef<HTMLDivElement>(null)
  const scrolled = useRef('')
  useEffect(() => {
    const box = scroller.current
    if (!box || !follow) return
    const el = anim ? box.querySelector<HTMLElement>('[data-cursor]') : box.querySelector<HTMLElement>(info.git ? '[data-mark="git"]' : '[data-mark="last"]')
    if (!el) return
    const mark = `${path}:${info.last?.toolId ?? ''}`
    if (!anim && scrolled.current === mark) return
    if (!anim) scrolled.current = mark
    box.scrollTop = Math.max(0, el.offsetTop - box.clientHeight / 2)
  }, [rows, anim, follow, path, info.last?.toolId, info.git])

  const tree = useMemo(() => buildTree(files.map((f) => ({ rel: relOf(f.path, cwd), info: f }))), [files, cwd])
  const running = live ? (files.find((f) => f.state === 'running')?.path ?? null) : null
  const seed = !info.last || info.last.agent === 'main' ? sessionId : info.last.agent.seed
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
        {deleted ? (
          <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
            <FileX className="size-8 opacity-40" />
            <span className="text-sm">Apagado</span>
            <LineCounts added={info.added} removed={info.removed} />
          </div>
        ) : rows ? (
          <div ref={scroller} className="relative min-w-0 flex-1 overflow-auto">
            <Rows rows={rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows} seed={seed} />
            {view && view !== 'missing' && view.kind === 'text' && view.truncated && <p className="px-3 pb-2 text-xs text-muted-foreground">Arquivo cortado: só o começo.</p>}
          </div>
        ) : view === 'missing' ? (
          <FileMissingArt />
        ) : view && view.kind !== 'text' ? (
          <FileNotTextArt kind={view.kind} />
        ) : (
          <CodeSkeleton />
        )}
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
