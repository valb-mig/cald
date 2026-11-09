import { useEffect, useState, type ReactNode } from 'react'
import { lookOf, phaseOf, useLooks, type Eyes, type Look } from '@/lib/claudinho'
import type { CatalogState, SessionState } from '@/lib/types'
import { cn } from '@/lib/utils'

/** O corpo, num desenho de 32 × 32. Hexágono, gota e arco arredondam as pontas com um traço grosso da mesma cor (na gota, bem grosso: a ponta vira um cocuruto). */
export function Body({ look }: { look: Look }) {
  const c = look.color
  switch (look.shape) {
    case 'square':
      return <rect x="4" y="4" width="24" height="24" rx="8" fill={c} />
    case 'wide':
      return <rect x="2" y="7" width="28" height="18" rx="9" fill={c} />
    case 'circle':
      return <circle cx="16" cy="16" r="13" fill={c} />
    case 'tall':
      return <rect x="6" y="2" width="20" height="28" rx="9" fill={c} />
    case 'hex':
      return <polygon points="9.5,5.5 22.5,5.5 28.5,16 22.5,26.5 9.5,26.5 3.5,16" fill={c} stroke={c} strokeWidth="5" strokeLinejoin="round" />
    case 'drop':
      return <polygon points="16,8 25.5,25 6.5,25" fill={c} stroke={c} strokeWidth="10" strokeLinejoin="round" />
    case 'arch':
      return <path d="M5 27V15a11 11 0 0 1 22 0v12z" fill={c} stroke={c} strokeWidth="3" strokeLinejoin="round" />
  }
}

/** Um olho; `side`: -1 o da esquerda, 1 o da direita (o piscadinho e o olhar de lado dependem dele). */
export function Eye({ x, y, s, kind, side }: { x: number; y: number; s: number; kind: Eyes; side: -1 | 1 }) {
  const arc = (
    <path
      d={`M${x - 2.5 * s} ${y + 1.3 * s}Q${x} ${y - 2.8 * s} ${x + 2.5 * s} ${y + 1.3 * s}`}
      fill="none"
      stroke="#fff"
      strokeWidth={2.2 * s}
      strokeLinecap="round"
    />
  )
  switch (kind) {
    case 'oval':
      return <ellipse cx={x} cy={y} rx={2.4 * s} ry={3.4 * s} fill="#fff" />
    case 'dot':
      return <circle cx={x} cy={y} r={2.2 * s} fill="#fff" />
    case 'big':
      return <circle cx={x} cy={y} r={3.3 * s} fill="#fff" />
    case 'happy':
      return arc
    case 'sleepy':
      // Só a metade de baixo: o olho meio fechado, de quem está tranquilo.
      return <path d={`M${x - 2.8 * s} ${y}a${2.8 * s} ${2.6 * s} 0 0 0 ${5.6 * s} 0z`} fill="#fff" />
    case 'focused':
      // Inclinados para dentro: a cara de quem está concentrado.
      return <ellipse cx={x} cy={y} rx={2.4 * s} ry={3.2 * s} fill="#fff" transform={`rotate(${-side * 20} ${x} ${y})`} />
    case 'wink':
      return side < 0 ? <ellipse cx={x} cy={y} rx={2.4 * s} ry={3.4 * s} fill="#fff" /> : arc
  }
}

/** A pose do claudinho: pensando (a mão no queixo) ou o joinha de quando termina. */
export type Pose = 'think' | 'done'

/** Quanto dura o joinha do fim do turno. */
export const CHEER_MS = 2400
// Pensando só depois de um tempo assim: entre ferramentas rápidas, ele não fica trocando de pose.
const PONDER_MS = 1000

/** `true` por CHEER_MS depois que `busy` passa a falso com `ok`: a hora do joinha. */
function useCheer(busy: boolean, ok = true): boolean {
  const [was, setWas] = useState(busy)
  const [on, setOn] = useState(false)
  if (busy !== was) {
    setWas(busy)
    setOn(!busy && ok)
  }
  useEffect(() => {
    if (!on) return
    const timer = setTimeout(() => setOn(false), CHEER_MS)
    return () => clearTimeout(timer)
  }, [on])
  return on
}

/** `on` depois de `ms` seguidos ligado; desliga na hora. */
function useSettled(on: boolean, ms: number): boolean {
  const [settled, setSettled] = useState(false)
  if (!on && settled) setSettled(false)
  useEffect(() => {
    if (!on) return
    const timer = setTimeout(() => setSettled(true), ms)
    return () => clearTimeout(timer)
  }, [on, ms])
  return on && settled
}

/**
 * Os traços por cima do corpo (mão, balão) ganham um contorno da cor do fundo, para se destacarem
 * dele mesmo em 16 px: o desenho vai duas vezes, primeiro só o contorno, depois na cor.
 */
function Outlined({ children, fill, className }: { children: ReactNode; fill?: string; className?: string }) {
  return (
    <>
      <g fill="var(--background)" stroke="var(--background)" strokeWidth="2.5" strokeLinejoin="round">
        {children}
      </g>
      <g fill={fill} className={className}>
        {children}
      </g>
    </>
  )
}

/** O balão no canto de cima, com o rabinho apontando para ele: "…" executando, "!" esperando você. */
function Bubble({ kind }: { kind: 'dots' | 'alert' }) {
  const shape = (
    <>
      <path d="M22.5 -1.8h5a4.5 4.5 0 0 1 0 9h-5a4.5 4.5 0 0 1 0 -9z" />
      <path d="M20.2 5.6L18.9 8.9L23.6 7z" />
    </>
  )
  if (kind === 'dots') {
    return (
      <g aria-hidden>
        <Outlined className="fill-sky-500">{shape}</Outlined>
        <g fill="#fff" className="claudinho-typing">
          <circle cx="21.6" cy="2.7" r="1.3" />
          <circle cx="25" cy="2.7" r="1.3" />
          <circle cx="28.4" cy="2.7" r="1.3" />
        </g>
      </g>
    )
  }
  return (
    <g aria-hidden className="claudinho-nudge">
      <Outlined className="fill-amber-500">{shape}</Outlined>
      <path d="M25 0.4v3.2" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="25" cy="5.7" r="1.1" fill="#fff" />
    </g>
  )
}

/** Pensando: a mão fechada debaixo do queixo, com o indicador encostado nele, dando batidinhas. */
function ThinkingHand({ look }: { look: Look }) {
  const x = 16 - look.gap * 0.15
  const chin = Math.min(look.eyeY + 6 * look.eyeScale, 24)
  return (
    <g aria-hidden className="claudinho-hmm">
      <Outlined fill={look.color}>
        <rect x={x - 5} y={chin + 2.6} width="6.6" height="5.4" rx="2.5" />
        <rect x={x - 1.5} y={chin} width="2.5" height="5" rx="1.25" />
      </Outlined>
    </g>
  )
}

/** A sobrancelha erguida de quem pensa, sobre o olho da esquerda. */
function Brow({ x, y, s }: { x: number; y: number; s: number }) {
  return (
    <path
      d={`M${x - 2.6 * s} ${y - 4.6 * s}Q${x - 0.2 * s} ${y - 7 * s} ${x + 2.6 * s} ${y - 5.4 * s}`}
      fill="none"
      stroke="#fff"
      strokeWidth={1.5 * s}
      strokeLinecap="round"
    />
  )
}

/** O joinha: o punho no canto de baixo, polegar para cima, surgindo com um balanço. */
function ThumbsUp({ color }: { color: string }) {
  return (
    <g aria-hidden className="claudinho-thumb">
      <Outlined fill={color}>
        <rect x="23.4" y="25" width="8" height="6" rx="2.6" />
        <rect x="25.1" y="19.9" width="3" height="7.2" rx="1.5" />
      </Outlined>
      {/* As dobras dos dedos, para o punho não virar só um bloco. */}
      <path d="M27.1 27.1h3.6M27.1 29h3.6" stroke="var(--background)" strokeWidth="0.8" strokeLinecap="round" opacity="0.55" />
    </g>
  )
}

/**
 * O claudinho de uma conversa (ver lib/claudinho.ts). O estado mexe na expressão: trabalhando, ele
 * pisca de vez em quando (cada um no seu tempo); esperando você, olha para cima. `status` mostra o
 * estado nele mesmo, para onde não há outro sinal: o balão com "…" executando, a mão no queixo
 * pensando (`thinking`), o balão com "!" esperando você e o joinha quando o turno acaba. `pose`
 * força uma pose, para quem acompanha o turno por conta própria (o fim do chat).
 */
export function Claudinho({
  seed,
  size = 28,
  name,
  state,
  status = false,
  thinking = false,
  pose,
  className,
}: {
  seed: string
  /** O nome dele: vira a dica ao passar o mouse e o que o leitor de tela lê. Sem nome, é só enfeite. */
  name?: string
  size?: number
  state?: CatalogState | SessionState
  status?: boolean
  /** Turno em andamento sem ferramenta rodando (ver CatalogEntry.thinking); só vale com `status`. */
  thinking?: boolean
  pose?: Pose
  className?: string
}) {
  // A conversa que continua outra (um /clear) veste o claudinho de lá: o mesmo personagem.
  const worn = useLooks((s) => s[seed]) ?? seed
  const look = lookOf(worn)
  const running = state === 'running' || state === 'starting'
  const waiting = state === 'waiting'
  const cheer = useCheer(status && running, state === 'idle')
  const pondering = useSettled(status && running && thinking, PONDER_MS)
  const shown = pose ?? (cheer ? 'done' : pondering ? 'think' : undefined)
  const bubble = status && !shown ? (waiting ? 'alert' : running ? 'dots' : undefined) : undefined
  const half = look.gap / 2
  const eyes = shown === 'done' ? 'happy' : look.eyes
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role={name ? 'img' : undefined}
      aria-label={name}
      aria-hidden={name ? undefined : true}
      className={cn('shrink-0 overflow-visible', className)}
    >
      {name && <title>{name}</title>}
      <g className={shown === 'done' ? 'claudinho-cheer' : undefined}>
        <g transform={look.tilt ? `rotate(${look.tilt.toFixed(1)} 16 16)` : undefined}>
          <Body look={look} />
          {/* Esperando, olha para cima; pensando, para o alto e de lado. */}
          <g transform={waiting ? 'translate(0 -1.6)' : shown === 'think' ? 'translate(0.9 -1.3)' : undefined}>
            <g
              className={running ? 'claudinho-blink' : undefined}
              style={running ? { animationDelay: `${(-phaseOf(worn) * 4).toFixed(2)}s` } : undefined}
            >
              <Eye x={16 - half} y={look.eyeY} s={look.eyeScale} kind={eyes} side={-1} />
              <Eye x={16 + half} y={look.eyeY} s={look.eyeScale} kind={eyes} side={1} />
            </g>
            {shown === 'think' && <Brow x={16 - half} y={look.eyeY} s={look.eyeScale} />}
          </g>
          {shown === 'think' && <ThinkingHand look={look} />}
        </g>
      </g>
      {shown === 'done' && <ThumbsUp color={look.color} />}
      {bubble && <Bubble kind={bubble} />}
    </svg>
  )
}

/**
 * A marca do edit.r, o ".r" do ícone do app (web/icons/icon.svg) sem o fundo, na cor do texto: o
 * ponto e o r de traço grosso com as pontas redondas, na mesma grade de 1024, num quadrado em volta dele.
 */
export function EditrMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="321 260 520 520"
      className={cn('shrink-0', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={116}
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="408" cy="636" r="64" fill="currentColor" stroke="none" />
      <path d="M600 398V642M600 560C600 450 650 398 760 398" />
    </svg>
  )
}
