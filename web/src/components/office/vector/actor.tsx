import { Body, Eye } from '@/components/claudinho'
import { lookOf, type Look, type Shape } from '@/lib/claudinho'
import type { BubbleKind, Carry, Facing, Family } from './layout'
import { PAL } from './palette'
import type { Actor, World } from './world'

/**
 * O claudinho da salinha é o mesmo do avatar da conversa (components/claudinho.tsx), com perninhas e
 * bracinhos para andar pelo escritório. O desenho do avatar é de 32 × 32; aqui ele é encolhido para a
 * escala do mundo, com os pés em (x, y).
 */

/** Unidades do mundo por unidade do desenho do avatar: o corpo fica com uns 17 de largura. */
const K = 0.76
/** Altura das perninhas, no mundo. */
const LEG = 4
/** Quanto o corpo desaba no cochilo. */
const SLUMP = 3
/** Até onde chapéu sobe acima da cabeça, no mundo. */
const HAT = 4.5

/** Onde o corpo de cada forma começa e termina, no desenho de 32 × 32 (contando o traço que arredonda as pontas). */
const BOUNDS: Record<Shape, { top: number; bottom: number; left: number; right: number }> = {
  square: { top: 4, bottom: 28, left: 4, right: 28 },
  wide: { top: 7, bottom: 25, left: 2, right: 30 },
  circle: { top: 3, bottom: 29, left: 3, right: 29 },
  tall: { top: 2, bottom: 30, left: 6, right: 26 },
  hex: { top: 3, bottom: 29, left: 1, right: 31 },
  drop: { top: 3, bottom: 30, left: 1.5, right: 30.5 },
  arch: { top: 2.5, bottom: 28.5, left: 3.5, right: 28.5 },
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16)
  const c = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)))
  return `rgb(${c(16)},${c(8)},${c(0)})`
}

export type Pose = {
  facing: Facing
  /** Fase do passo (seno), de -1 a 1; 0 parado. */
  step: number
  bob: number
  seated?: 'chair' | 'sofa'
  arms: boolean
  blink: boolean
  slump: boolean
  hat?: Family
  carry?: Carry
}

/** Onde fica a base do corpo, em relação aos pés: de pé, em cima das pernas; na cadeira, um pouco acima; no sofá, no assento. */
function bodyBottom(seated: Pose['seated'], slump: boolean): number {
  const base = seated === 'chair' ? -4 : seated === 'sofa' ? 0 : -LEG
  return base + (slump ? SLUMP : 0)
}

/** Topo da cabeça (no mundo, na área): para o nome e o balão ficarem logo acima dele. */
export function headTop(world: World, a: Actor): number {
  const b = BOUNDS[lookOf(a.seed).shape]
  const hat = a.lead && world.rooms.get(a.room)?.family ? HAT : 0
  return a.y + bodyBottom(world.seatOf(a), world.slumped(a)) - (b.bottom - b.top) * K - hat
}

/** Chapéu do modelo da conversa, no desenho do avatar, com o topo da cabeça em `top`. */
function Hat({ family, top }: { family: Family; top: number }) {
  if (family === 'opus') {
    // Coroa.
    return (
      <g>
        <path d={`M9.5 ${top + 1.5}V${top - 5}l3.3 3l3.2 -5l3.2 5l3.3 -3V${top + 1.5}z`} fill={PAL.gold} strokeLinejoin="round" stroke={PAL.gold} strokeWidth={1.2} />
        <circle cx={16} cy={top - 1.2} r={1.3} fill={PAL.red} />
      </g>
    )
  }
  if (family === 'fable') {
    // Chapéu de mago, com estrelinha.
    return (
      <g>
        <path d={`M8.5 ${top + 1}L17.5 ${top - 14}L23.5 ${top + 1}z`} fill="#6f52c8" stroke="#6f52c8" strokeWidth={1.5} strokeLinejoin="round" />
        <ellipse cx={16} cy={top + 1} rx={10} ry={2.2} fill="#5b3fb0" />
        <path d={`M15 ${top - 6.5}l0.7 1.4l1.5 0.2l-1.1 1l0.3 1.5l-1.4 -0.7l-1.4 0.7l0.3 -1.5l-1.1 -1l1.5 -0.2z`} fill={PAL.gold} />
      </g>
    )
  }
  if (family === 'sonnet') {
    // Boina.
    return (
      <g>
        <ellipse cx={16.5} cy={top - 0.5} rx={10} ry={3.6} fill="#c24a4a" />
        <ellipse cx={16.5} cy={top + 0.8} rx={8.5} ry={1.4} fill="#a63a3a" />
        <circle cx={17} cy={top - 4.3} r={1.3} fill="#a63a3a" />
      </g>
    )
  }
  // Brotinho.
  return (
    <g>
      <path d={`M16 ${top + 1}V${top - 5}`} stroke={PAL.leafDark} strokeWidth={1.4} strokeLinecap="round" />
      <ellipse cx={13} cy={top - 5.5} rx={3} ry={1.6} fill={PAL.leaf} transform={`rotate(20 13 ${top - 5.5})`} />
      <ellipse cx={19} cy={top - 7} rx={3.2} ry={1.7} fill={PAL.leaf} transform={`rotate(-25 19 ${top - 7})`} />
    </g>
  )
}

/** O que ele leva nas mãos (no mundo, em relação aos pés), na altura dos braços. */
function Carried({ item, facing, y }: { item: Carry; facing: Facing; y: number }) {
  const dx = facing === 'left' ? -10 : facing === 'right' ? 3 : -3.5
  if (item === 'box') {
    return (
      <g transform={`translate(${dx} ${y})`}>
        <rect x={-0.5} y={-2.5} width={8} height={6.5} rx={0.8} fill={PAL.cardboard} />
        <rect x={-0.5} y={-2.5} width={8} height={1.4} rx={0.7} fill={PAL.cardboardLight} />
        <rect x={2.7} y={-2.5} width={1.6} height={6.5} fill={PAL.cardboardDark} />
      </g>
    )
  }
  if (item === 'folder') {
    return (
      <g transform={`translate(${dx} ${y})`}>
        <path d="M0 -2.2h2.6l0.8 1h3.6v5.2h-7z" fill={PAL.amber} />
        <rect x={1} y={-0.6} width={5} height={1} rx={0.5} fill={PAL.paper} />
      </g>
    )
  }
  return (
    <g transform={`translate(${dx} ${y})`}>
      <rect x={0} y={-1.5} width={6} height={5} rx={0.8} fill={PAL.books[0]} />
      <rect x={1} y={-0.5} width={4} height={1} rx={0.5} fill={PAL.paper} />
    </g>
  )
}

/** Os olhos, de frente ou de lado (de costas não aparecem); piscando, achatam. */
function Eyes({ look, facing, closed }: { look: Look; facing: Facing; closed: boolean }) {
  if (facing === 'back') return null
  const side = facing === 'left' ? -1 : facing === 'right' ? 1 : 0
  const half = (look.gap / 2) * (side ? 0.75 : 1)
  const cx = 16 + side * 4
  const kind = closed && (look.eyes === 'oval' || look.eyes === 'big' || look.eyes === 'dot' || look.eyes === 'focused') ? 'sleepy' : look.eyes
  return (
    <g>
      <Eye x={cx - half} y={look.eyeY} s={look.eyeScale} kind={kind} side={-1} />
      <Eye x={cx + half} y={look.eyeY} s={look.eyeScale} kind={kind} side={1} />
    </g>
  )
}

/** Um claudinho com os pés em (x, y). */
export function ActorShape({ seed, x, y, pose }: { seed: string; x: number; y: number; pose: Pose }) {
  const look = lookOf(seed)
  const b = BOUNDS[look.shape]
  const dark = shade(look.color, 0.72)
  const base = bodyBottom(pose.seated, pose.slump) + pose.bob
  const mid = (b.top + b.bottom) / 2 + 3
  const lift = pose.arms ? -6 : 0
  // Andando, uma perninha sobe enquanto a outra fica no chão, e o corpo balança junto.
  const legA = Math.max(0, pose.step) * 1.8
  const legB = Math.max(0, -pose.step) * 1.8
  const tilt = look.tilt + (pose.slump ? 12 : 0)
  return (
    <g transform={`translate(${x.toFixed(2)} ${y.toFixed(2)})`}>
      {!pose.seated && <ellipse cx={0} cy={0} rx={7} ry={1.5} fill={PAL.shadow} />}
      {!pose.seated && (
        <g fill={dark}>
          <rect x={-4.2} y={-LEG - 1.5 - legA} width={2.6} height={LEG + 1.5} rx={1.3} />
          <rect x={1.6} y={-LEG - 1.5 - legB} width={2.6} height={LEG + 1.5} rx={1.3} />
        </g>
      )}
      <g transform={`translate(0 ${base.toFixed(2)}) scale(${K}) translate(-16 ${-b.bottom})`}>
        {/* Bracinhos atrás do corpo, aparecendo dos lados; erguidos, digitando ou apontando. */}
        <g fill={dark}>
          <ellipse cx={b.left + 0.5} cy={mid + lift} rx={2.6} ry={3.6} transform={pose.arms ? `rotate(-35 ${b.left + 0.5} ${mid + lift})` : undefined} />
          <ellipse cx={b.right - 0.5} cy={mid + lift} rx={2.6} ry={3.6} transform={pose.arms ? `rotate(35 ${b.right - 0.5} ${mid + lift})` : undefined} />
        </g>
        <g transform={tilt ? `rotate(${tilt.toFixed(1)} 16 ${b.bottom})` : undefined}>
          <Body look={look} />
          <Eyes look={look} facing={pose.facing} closed={pose.blink || pose.slump} />
          {pose.hat && <Hat family={pose.hat} top={b.top} />}
        </g>
      </g>
      {pose.carry && <Carried item={pose.carry} facing={pose.facing} y={base - 7} />}
    </g>
  )
}

/** Balão de fala com rabinho, com a ponta em (x, y). `t` (segundos) anima o de dentro. */
export function Bubble({ x, y, kind, t }: { x: number; y: number; kind: BubbleKind; t: number }) {
  const bg = kind === 'alert' ? PAL.amber : kind === 'error' ? PAL.red : kind === 'check' ? PAL.led : PAL.white
  const float = Math.sin(t * 2.4) * 0.5
  return (
    <g transform={`translate(${x.toFixed(2)} ${(y + float).toFixed(2)})`}>
      <path d="M-7 -11.5a2.5 2.5 0 0 1 2.5 -2.5h9a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1 -2.5 2.5h-2.5l-2 2.2l-2 -2.2h-2.5a2.5 2.5 0 0 1 -2.5 -2.5z" fill={bg} stroke={PAL.ink} strokeWidth={0.7} strokeLinejoin="round" />
      <g transform="translate(0 -8.5)">
        <BubbleInside kind={kind} t={t} />
      </g>
    </g>
  )
}

function BubbleInside({ kind, t }: { kind: BubbleKind; t: number }) {
  switch (kind) {
    case 'dots':
      // As reticências acendem uma por vez, em onda.
      return (
        <g fill={PAL.ink}>
          {[-3.2, 0, 3.2].map((dx, i) => {
            const p = (((t * 1.6 - i * 0.22) % 1) + 1) % 1
            const up = p < 0.4 ? Math.sin((p / 0.4) * Math.PI) : 0
            return <circle key={i} cx={dx} cy={-up * 1.2} r={1.05} opacity={0.35 + up * 0.65} />
          })}
        </g>
      )
    case 'alert':
      return (
        <g fill={PAL.white}>
          <rect x={-0.9} y={-3.4} width={1.8} height={4.2} rx={0.9} />
          <circle cx={0} cy={2.3} r={0.95} />
        </g>
      )
    case 'error':
      return (
        <text x={0} y={0.3} textAnchor="middle" dominantBaseline="central" fontSize={6.4} fontWeight={800} fill={PAL.white}>
          !?
        </text>
      )
    case 'check':
      return <path d="M-3 0l2 2l4 -4" fill="none" stroke={PAL.white} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    case 'heart': {
      const s = 1 + Math.max(0, Math.sin(t * 9)) * 0.15
      return <path d="M0 3C-5 -0.5 -3.5 -4.5 -0.9 -3.3c0.5 0.2 0.8 0.6 0.9 0.9c0.1 -0.3 0.4 -0.7 0.9 -0.9C3.5 -4.5 5 -0.5 0 3z" fill={PAL.red} transform={`scale(${s.toFixed(3)})`} />
    }
    case 'bulb':
      return (
        <g>
          <circle cx={0} cy={-0.8} r={4} fill={PAL.gold} opacity={0.25 + 0.2 * Math.sin(t * 5)} />
          <circle cx={0} cy={-0.8} r={2.4} fill={PAL.gold} />
          <rect x={-1.2} y={1.2} width={2.4} height={1.1} rx={0.3} fill={PAL.metalDark} />
          <rect x={-0.9} y={2.3} width={1.8} height={0.8} rx={0.3} fill={PAL.metalDeep} />
        </g>
      )
    case 'sleep': {
      // Um "z" que sobe e some, e outro que já vem.
      const p = (t * 0.5) % 1
      return (
        <g fill={PAL.ink} fontWeight={800} textAnchor="middle" dominantBaseline="central">
          <text x={-1.5 + p * 2} y={1 - p * 2} fontSize={4.8} opacity={1 - p * 0.6}>
            z
          </text>
          <text x={2 + p * 1.5} y={-1.5 - p * 1.5} fontSize={3.2} opacity={0.4 + p * 0.6}>
            z
          </text>
        </g>
      )
    }
  }
}
