import {
  Check,
  Columns2,
  Download,
  FileImage,
  Image as ImageIcon,
  Info,
  Loader2,
  LocateFixed,
  Minus,
  MoveHorizontal,
  MoveVertical,
  Plus,
  Share2,
  ShieldAlert,
  User,
  X,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { toast } from 'sonner'
import { STATUS, useNow } from '@/components/agents/status'
import { Claudinho } from '@/components/claudinho'
import { compact } from '@/components/home/scale'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { api, errorMessage } from '@/lib/api'
import { duration } from '@/lib/format'
import { useWidth } from '@/lib/hooks'
import type { SessionCost } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useScrim, veil } from '@/lib/wallpaper'
import { canShareImage, download, mapImage, type ImageFormat, type RootSpend } from './export'
import { layout, type Box } from './layout'
import { focusOf, KIND_LABEL, STATE_LABEL, type MindNode, type MindStatus } from './model'

/** Depois de mexer no mapa com a mão, por quanto tempo ele não puxa você de volta ao passo atual. */
const HANDS_OFF_MS = 4000
const MIN_ZOOM = 0.1
const MAX_ZOOM = 2
// Sem arredondar: os passos pequenos da pinça do trackpad somam; o arredondamento fica só no número da barra.
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
/** Folga em volta do desenho para arrastar além da borda dele. */
const SPACE = 160
/** Margem dos enquadramentos (caber na largura, ver tudo). */
const FIT_PAD = 24

/** O estado no pé do cartão. Concluído é o normal e fica em cinza; a cor fica para o que pede olhar. */
const STATE_CLASS: Record<MindStatus, string> = {
  done: 'text-muted-foreground',
  running: 'text-sky-600 dark:text-sky-400',
  waiting: 'text-amber-600 dark:text-amber-400',
  failed: 'text-red-600 dark:text-red-400',
  stopped: 'text-muted-foreground',
}

const usd = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const active = (n: MindNode) => n.status === 'running' || n.status === 'waiting'
/** A cara do claudinho: pisca trabalhando, olha para cima esperando você; o resto, tranquilo. */
const mood = (n: MindNode) => (n.status === 'running' || n.status === 'waiting' ? n.status : undefined)

/** Tokens de entrada e saída e quanto da entrada veio do cache, como no rodapé de um nó de agente. */
function spend(cost: SessionCost): RootSpend {
  const main = [...cost.models].sort((a, b) => b.output - a.output)[0]
  const input = cost.models.reduce((n, m) => n + m.input + m.cacheRead + m.cacheWrite, 0)
  const output = cost.models.reduce((n, m) => n + m.output, 0)
  const cached = cost.models.reduce((n, m) => n + m.cacheRead, 0)
  const hit = input ? Math.round((cached / input) * 100) : 0
  return { model: main?.model, line: `${compact(input)}↓ ${compact(output)}↑ ○${hit}%`, usd: usd.format(cost.costUsd) }
}

/** O estado e quanto levou, no canto de baixo do cartão. */
function StateLine({ status, time }: { status: MindStatus; time?: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] font-medium tracking-[0.06em] uppercase tabular-nums">
      <span className={STATE_CLASS[status]}>{STATE_LABEL[status]}</span>
      {time && <span className="text-muted-foreground normal-case">{time}</span>}
    </span>
  )
}

/**
 * O cartão de um nó, como na referência de fluxo: o ícone à esquerda, o título com o tipo no canto,
 * as linhas de baixo e um fio da cor de quem fez no alto. Trabalhando ou esperando você, ganha a
 * borda do estado.
 */
function Card({
  box,
  icon,
  title,
  lines = 2,
  children,
  onTap,
  glow,
}: {
  box: Box
  icon: ReactNode
  title: string
  lines?: 1 | 2
  children?: ReactNode
  onTap?: () => void
  glow?: boolean
}) {
  const n = box.node
  const style: CSSProperties = { left: box.x, top: box.y, width: box.w, height: box.h }
  if (glow) style.boxShadow = `0 0 56px -14px ${box.color}`
  const type = KIND_LABEL[n.kind]
  return (
    <button
      type="button"
      onClick={onTap}
      style={style}
      className={cn(
        'absolute flex gap-3 overflow-hidden rounded-[14px] border border-foreground/[0.09] bg-card px-3.5 py-3 text-left shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-[border-color,box-shadow,scale] hover:border-foreground/20 active:scale-[0.99]',
        'animate-in fade-in-0 zoom-in-95 duration-300',
        glow && 'rounded-[18px]',
        active(n) && STATUS[n.status].node,
      )}
    >
      <span aria-hidden className="absolute inset-x-4 top-0 h-px" style={{ background: box.color }} />
      <span className="flex w-7 shrink-0 justify-center pt-0.5">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-start gap-2">
          <span className={cn('min-w-0 flex-1 text-[13px] leading-snug font-semibold', lines === 1 ? 'truncate' : 'line-clamp-2')}>{title}</span>
          {type && <span className="shrink-0 pt-px text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">{type}</span>}
        </span>
        {children}
      </span>
    </button>
  )
}

const Sub = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cn('truncate text-[12px] text-muted-foreground', className)}>{children}</span>
)

/** O pé do cartão: à esquerda, o modelo ou os números; à direita, o estado. */
const Foot = ({ left, right }: { left?: ReactNode; right: ReactNode }) => (
  <span className="mt-auto flex items-center gap-2">
    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/75">{left}</span>
    {right}
  </span>
)

function AgentCard({ box, onTap }: { box: Box; onTap: () => void }) {
  const n = box.node
  const s = n.stats
  const now = useNow(active(n))
  const time = active(n) && s?.startedAt ? duration(Math.max(0, now - s.startedAt)) : s?.durationMs ? duration(s.durationMs) : undefined
  return (
    <Card box={box} icon={<Claudinho seed={n.seed ?? n.id} state={mood(n)} size={28} />} title={n.label} lines={1} onTap={onTap}>
      <Sub>{n.detail ?? (n.meta || 'Subagente')}</Sub>
      <span className="truncate font-mono text-[11px] text-foreground/75">{s?.model ?? n.meta ?? ''}</span>
      {/* As ferramentas já estão no resumo de cima; no pé, só o consumo. */}
      <Foot left={s?.tokens ? `${compact(s.tokens)} tokens` : undefined} right={<StateLine status={n.status} time={time} />} />
    </Card>
  )
}

function NodeView({ box, cost, onTap }: { box: Box; cost: SessionCost | null; onTap: (n: MindNode) => void }) {
  const n = box.node
  const tap = () => onTap(n)

  if (n.kind === 'root') {
    const used = cost && spend(cost)
    return (
      <Card
        box={box}
        glow
        icon={
          <span className="relative">
            <span aria-hidden className="absolute -inset-2 rounded-full opacity-30 blur-md" style={{ background: box.color }} />
            <Claudinho seed={n.seed ?? 'root'} state={mood(n)} status size={30} className="relative" />
          </span>
        }
        title={n.label}
      >
        <span className="truncate font-mono text-[11px] text-foreground/75">{used?.model ?? n.meta}</span>
        <Foot left={used?.line} right={used && <span className="shrink-0 text-[12px] font-semibold tabular-nums">{used.usd}</span>} />
      </Card>
    )
  }

  if (n.kind === 'turn') {
    const s = n.stats
    return (
      <Card
        box={box}
        icon={
          <span className="flex size-7 items-center justify-center rounded-full bg-foreground/[0.08]">
            <User className="size-3.5 text-muted-foreground" />
          </span>
        }
        title={n.label}
        onTap={tap}
      >
        {n.meta && <Sub>{n.meta}</Sub>}
        <Foot
          left={s?.costUsd ? usd.format(s.costUsd) : undefined}
          right={<StateLine status={n.status} time={n.status === 'done' && s?.durationMs ? duration(s.durationMs) : undefined} />}
        />
      </Card>
    )
  }

  if (n.kind === 'agent') return <AgentCard box={box} onTap={tap} />

  if (n.kind === 'option') {
    const took = n.chosen === true
    const dropped = n.chosen === false
    return (
      <button
        type="button"
        onClick={tap}
        style={{ left: box.x, top: box.y, width: box.w, height: box.h, borderColor: took ? box.color : undefined }}
        title={dropped ? `Descartada: ${n.label}` : n.label}
        className={cn(
          'absolute flex items-center gap-2 rounded-xl border bg-card px-3 text-left text-[12px] transition-colors hover:border-foreground/25',
          'animate-in fade-in-0 zoom-in-95 duration-300',
          took ? 'border-[1.5px] font-medium' : 'border-foreground/[0.09]',
          dropped && 'border-dashed bg-transparent text-muted-foreground opacity-60',
        )}
      >
        {took ? (
          <Check className="size-3.5 shrink-0" style={{ color: box.color }} strokeWidth={3} />
        ) : dropped ? (
          <X className="size-3.5 shrink-0" />
        ) : (
          <span className="size-2 shrink-0 rotate-45 border border-muted-foreground" />
        )}
        <span className={cn('min-w-0 flex-1 truncate', dropped && 'line-through decoration-muted-foreground/50')}>{n.label}</span>
        {n.meta && <span className="shrink-0 text-[10.5px] text-muted-foreground">{n.meta}</span>}
      </button>
    )
  }

  if (n.kind === 'notice') {
    return (
      <div
        style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
        className="absolute flex items-center justify-center gap-1.5 rounded-full border border-dashed border-foreground/15 text-[11.5px] text-muted-foreground"
      >
        <Info className="size-3.5" />
        {n.label}
      </div>
    )
  }

  // Passo, resposta, aprovação e pergunta: o que o próprio Claude fez, com o claudinho da conversa.
  const waiting = n.status === 'waiting'
  const icon =
    n.kind === 'approval' ? (
      <ShieldAlert className={cn('size-5', waiting ? 'text-amber-500' : 'text-muted-foreground')} />
    ) : n.kind === 'decision' ? (
      <span className="mt-1 size-3 rotate-45 rounded-[3px]" style={{ background: waiting ? 'var(--color-amber-500)' : box.color }} />
    ) : (
      <Claudinho seed={n.seed ?? 'root'} state={mood(n)} size={24} />
    )
  return (
    <Card box={box} icon={icon} title={n.label} onTap={tap}>
      {n.status === 'done' ? (
        n.meta && <Sub>{n.meta}</Sub>
      ) : (
        <Foot left={n.meta && <span className="font-sans text-[12px] text-muted-foreground">{n.meta}</span>} right={<StateLine status={n.status} />} />
      )}
    </Card>
  )
}

/** Consumo da conversa para o cartão do topo; relido a cada turno que termina. */
function useCost(sessionId: string, turns: number): SessionCost | null {
  const [cost, setCost] = useState<{ id: string; value: SessionCost } | null>(null)
  useEffect(() => {
    let alive = true
    api.cost(sessionId).then(
      (value) => alive && setCost({ id: sessionId, value }),
      // Sem respostas salvas ainda, ou servidor antigo: o cartão fica só com o estado.
      () => {},
    )
    return () => {
      alive = false
    }
  }, [sessionId, turns])
  return cost?.id === sessionId ? cost.value : null
}

/**
 * O mapa da conversa como um fluxo, ao vivo. Arrasta-se com o dedo ou o mouse; a pinça, o Ctrl + roda
 * e os botões do canto mudam o zoom. Tocar numa mensagem, passo ou opção leva ao ponto do chat; num
 * subagente, abre a folha dele; num pedido, ao cartão de resposta.
 */
export function MindMap({
  sessionId,
  root,
  title,
  onJump,
  onAgent,
  onRequest,
  side,
}: {
  sessionId: string
  root: MindNode
  title: string
  onJump: (itemKey: string) => void
  onAgent: (id: string) => void
  onRequest: (itemKey: string) => void
  /** Lado a lado com o chat: `null` se a tela não comporta. */
  side: { on: boolean; toggle: () => void } | null
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const width = useWidth(scroller)
  const g = useMemo(() => layout(root), [root])
  const cost = useCost(sessionId, root.children.filter((t) => t.stats).length)
  const [zoomPick, setZoom] = useState<number | null>(null)
  const scale = zoomPick ?? (width && width < 400 ? 0.9 : 1)
  // Folga em volta do desenho para arrastar em qualquer direção, como numa tela livre; quando ele é
  // mais estreito que a tela, a folga começa onde ele fica centrado.
  const offX = SPACE + Math.max(0, (width - g.width * scale) / 2)
  const offY = SPACE

  /**
   * Ao vivo, sempre: mantém à vista o pedido que espera você ou o passo em andamento. Mexer no mapa
   * com a mão segura: por alguns segundos depois disso ele deixa você olhar outra parte em paz, e
   * fora disso cada passo novo volta a ficar à vista. Com o Claude parado o foco não muda.
   */
  const movedAt = useRef(0)
  const focus = useMemo(() => focusOf(root), [root])
  const focusBox = g.boxes.find((b) => b.node.id === focus.id)
  const fx = focusBox ? focusBox.x + focusBox.w / 2 : null
  const fy = focusBox ? focusBox.y + focusBox.h / 2 : null
  const placed = useRef(false)
  // Um passo novo que chegou com a mão no mapa: quando a folga acaba, ele é mostrado (sem isto, um
  // pedido de aprovação logo depois de um zoom ficava fora da tela até o foco mudar de novo).
  const [retry, setRetry] = useState(0)
  const center = (smooth: boolean) => {
    const el = scroller.current
    if (!el || fx === null || fy === null) return
    el.scrollTo({ left: offX + fx * scale - el.clientWidth / 2, top: offY + fy * scale - el.clientHeight / 2, behavior: smooth ? 'smooth' : 'auto' })
  }
  useLayoutEffect(() => {
    if (!scroller.current || fx === null || !width) return
    const wait = HANDS_OFF_MS - (Date.now() - movedAt.current)
    if (placed.current && wait > 0) {
      const timer = setTimeout(() => setRetry((n) => n + 1), wait)
      return () => clearTimeout(timer)
    }
    center(placed.current)
    placed.current = true
    // `center` lê o resto do render; só o foco, o tamanho e a folga que acabou mudam onde ele fica.
  }, [fx, fy, width, retry]) // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom que segura o ponto embaixo do dedo (ou do centro da tela): depois de redesenhar, a rolagem volta a ele.
  const anchor = useRef<{ gx: number; gy: number; ax: number; ay: number } | null>(null)
  /** O zoom na tela agora, e o último pedido (vários eventos de roda num quadro só somam a partir dele). */
  const scaleRef = useRef(scale)
  const target = useRef(scale)
  const offRef = useRef({ x: offX, y: offY })
  useLayoutEffect(() => {
    scaleRef.current = scale
    if (!anchor.current) target.current = scale
    offRef.current = { x: offX, y: offY }
  })
  const zoomAt = (next: number, ax?: number, ay?: number, at?: { gx: number; gy: number }) => {
    const el = scroller.current
    const z = clampZoom(next)
    // No limite (ou já nele): nada muda, e uma âncora guardada à toa seria aplicada num redesenho qualquer depois.
    if (!el || Math.abs(z - target.current) < 1e-4) return
    const x = ax ?? el.clientWidth / 2
    const y = ay ?? el.clientHeight / 2
    const s = scaleRef.current
    // Ainda sem redesenhar desde o último pedido, a rolagem é a de antes: o ponto segurado continua o mesmo.
    const held = anchor.current
    anchor.current = at
      ? { ...at, ax: x, ay: y }
      : held
        ? { ...held, ax: x, ay: y }
        : { gx: (el.scrollLeft + x - offRef.current.x) / s, gy: (el.scrollTop + y - offRef.current.y) / s, ax: x, ay: y }
    movedAt.current = Date.now()
    target.current = z
    setZoom(z)
  }
  useLayoutEffect(() => {
    const el = scroller.current
    const a = anchor.current
    if (!el || !a) return
    anchor.current = null
    el.scrollLeft = offX + a.gx * scale - a.ax
    el.scrollTop = offY + a.gy * scale - a.ay
  }, [scale, offX, offY])

  // Pinça no celular e Ctrl + roda no PC (a página em si não tem zoom no app).
  const zoomRef = useRef(zoomAt)
  useLayoutEffect(() => {
    zoomRef.current = zoomAt
  })
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    let pinch: { dist: number; scale: number } | null = null
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const local = (x: number, y: number) => {
      const r = el.getBoundingClientRect()
      return [x - r.left, y - r.top] as const
    }
    const start = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch = { dist: dist(e.touches), scale: scaleRef.current }
    }
    const move = (e: TouchEvent) => {
      // A rolagem com o dedo cancela o ponteiro logo no começo: a folga do acompanhamento conta daqui.
      movedAt.current = Date.now()
      if (!pinch || e.touches.length !== 2) return
      e.preventDefault()
      const [x, y] = local((e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2)
      zoomRef.current((pinch.scale * dist(e.touches)) / pinch.dist, x, y)
    }
    const end = (e: TouchEvent) => {
      movedAt.current = Date.now()
      if (e.touches.length < 2) pinch = null
    }
    const wheel = (e: WheelEvent) => {
      movedAt.current = Date.now()
      if (!e.ctrlKey) return
      e.preventDefault()
      const [x, y] = local(e.clientX, e.clientY)
      // Em linhas (Firefox), cada passo vale umas 16 px.
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      zoomRef.current(target.current * (1 - delta * 0.002), x, y)
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
      el.removeEventListener('wheel', wheel)
    }
  }, [])

  // Arrastar com o mouse pelo fundo, como uma mão; o dedo já arrasta pela rolagem do próprio navegador.
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [grabbing, setGrabbing] = useState(false)
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') {
      movedAt.current = Date.now()
      return
    }
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, a')) return
    const el = e.currentTarget
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }
    el.setPointerCapture(e.pointerId)
    setGrabbing(true)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    e.currentTarget.scrollLeft = d.left - (e.clientX - d.x)
    e.currentTarget.scrollTop = d.top - (e.clientY - d.y)
    movedAt.current = Date.now()
  }
  const endDrag = () => {
    drag.current = null
    setGrabbing(false)
  }

  const tap = (n: MindNode) => {
    if (n.agentId) return onAgent(n.agentId)
    if (n.requestId && n.itemKey) return onRequest(n.itemKey)
    if (n.itemKey) onJump(n.itemKey)
  }

  const fitWidth = () => {
    const el = scroller.current
    if (el) zoomAt((el.clientWidth - FIT_PAD * 2) / g.width, undefined, FIT_PAD, { gx: g.width / 2, gy: (el.scrollTop + FIT_PAD - offY) / scale })
  }
  const fitAll = () => {
    const el = scroller.current
    if (el) zoomAt(Math.min((el.clientWidth - FIT_PAD * 2) / g.width, (el.clientHeight - FIT_PAD * 2) / g.height), undefined, undefined, { gx: g.width / 2, gy: g.height / 2 })
  }
  const now = () => {
    movedAt.current = 0
    center(true)
  }

  const [exporting, setExporting] = useState(false)
  const shareable = useMemo(() => canShareImage(), [])
  const save = async (format: ImageFormat, share: boolean) => {
    setExporting(true)
    try {
      const file = await mapImage(g, title, format, cost && spend(cost))
      if (share) await navigator.share({ files: [file], title })
      else download(file)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') toast.error('Não deu para gerar a imagem', { description: errorMessage(err) })
    } finally {
      setExporting(false)
    }
  }

  // Com fundo animado, o mapa deixa a cena aparecer atrás dele, sob o mesmo escurecido do chat.
  const scrim = useScrim()
  const dim = scrim === null ? null : veil(scrim)

  return (
    <div
      className={cn('relative flex h-full min-h-0 flex-col', dim ? cn(dim.className, 'backdrop-blur-[1.5px]') : 'bg-background')}
      style={dim?.style}
    >
      <div
        ref={scroller}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={cn(
          // Um dedo rola pelo navegador; a pinça fica com o mapa, sem a rolagem nativa brigar com o zoom.
          'min-h-0 flex-1 touch-pan-x touch-pan-y overflow-auto overscroll-contain bg-[radial-gradient(circle,color-mix(in_oklab,var(--foreground)_14%,transparent)_1px,transparent_1px)] bg-size-[20px_20px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          grabbing ? 'cursor-grabbing select-none' : 'pointer-fine:cursor-grab',
        )}
      >
        {root.children.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">O mapa aparece quando a conversa começar.</p>
        ) : (
          <div className="relative" style={{ width: g.width * scale + offX * 2, height: g.height * scale + offY * 2 }}>
            <div className="absolute origin-top-left" style={{ left: offX, top: offY, width: g.width, height: g.height, transform: `scale(${scale})` }}>
              {g.groups.map((gr) => (
                <div
                  key={`${gr.x}:${gr.y}`}
                  style={{ left: gr.x, top: gr.y, width: gr.w, height: gr.h }}
                  className="absolute rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.015]"
                >
                  <span className="absolute top-1.5 left-3.5 text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">{gr.label}</span>
                </div>
              ))}
              <svg width={g.width} height={g.height} className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden>
                {g.edges.map((e) => (
                  <g key={e.id} opacity={e.dim ? 0.4 : 1}>
                    <path
                      d={e.d}
                      fill="none"
                      stroke={e.color}
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeDasharray={e.live ? '6 5' : e.dash === 'dot' ? '1.5 5' : e.dash === 'dash' ? '5 5' : undefined}
                      className={cn(e.live && 'motion-safe:animate-[agent-flow_0.9s_linear_infinite]')}
                    />
                    <polygon points={e.arrow} fill={e.color} />
                  </g>
                ))}
              </svg>
              {g.edges.map(
                (e) =>
                  e.label && (
                    <span
                      key={`${e.id}:label`}
                      style={{ left: e.label.x, top: e.label.y, borderColor: e.color }}
                      className="absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border bg-background px-2.5 font-mono text-[10.5px] leading-[18px] whitespace-nowrap text-foreground/85"
                    >
                      {e.label.text}
                    </span>
                  ),
              )}
              {g.boxes.map((box) => (
                <NodeView key={box.node.id} box={box} cost={cost} onTap={tap} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Zoom e enquadramento no canto de baixo, como numa tela de fluxo; ali o polegar alcança. */}
      <div className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-xl border bg-background/90 p-1 shadow-lg backdrop-blur">
        <Button variant="ghost" size="icon-sm" onClick={() => zoomAt(scale - 0.1)} aria-label="Diminuir">
          <Minus />
        </Button>
        <button type="button" className="w-11 text-center text-xs text-muted-foreground tabular-nums hover:text-foreground" onClick={() => zoomAt(1)} title="Tamanho real">
          {Math.round(scale * 100)}%
        </button>
        <Button variant="ghost" size="icon-sm" onClick={() => zoomAt(scale + 0.1)} aria-label="Aumentar">
          <Plus />
        </Button>
        <span aria-hidden className="mx-1 h-5 w-px bg-border" />
        <Button variant="ghost" size="icon-sm" onClick={now} aria-label="Ir para onde a conversa está" title="Ir para onde a conversa está">
          <LocateFixed />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={fitWidth} aria-label="Caber na largura" title="Caber na largura">
          <MoveHorizontal />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={fitAll} aria-label="Ver tudo" title="Ver tudo">
          <MoveVertical />
        </Button>
        <span aria-hidden className="mx-1 h-5 w-px bg-border" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled={exporting || root.children.length === 0} aria-label="Salvar como imagem" title="Salvar como imagem">
              {exporting ? <Loader2 className="animate-spin" /> : <Download />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuItem onSelect={() => void save('png', false)}>
              <ImageIcon /> Baixar PNG
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void save('svg', false)}>
              <FileImage /> Baixar SVG
            </DropdownMenuItem>
            {shareable && (
              <DropdownMenuItem onSelect={() => void save('png', true)}>
                <Share2 /> Compartilhar imagem
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {side && (
          <Button
            variant={side.on ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={side.toggle}
            aria-pressed={side.on}
            aria-label={side.on ? 'Só o mapa' : 'Chat e mapa lado a lado'}
            title={side.on ? 'Só o mapa' : 'Lado a lado com o chat'}
          >
            <Columns2 />
          </Button>
        )}
      </div>
    </div>
  )
}
