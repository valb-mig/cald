import { lookOf, phaseOf, useLooks, type Eyes, type Look } from '@/lib/claudinho'
import type { CatalogState, SessionState } from '@/lib/types'
import { cn } from '@/lib/utils'

/** O corpo, num desenho de 32 × 32. Hexágono, gota e arco arredondam as pontas com um traço grosso da mesma cor (na gota, bem grosso: a ponta vira um cocuruto). */
function Body({ look }: { look: Look }) {
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
function Eye({ x, y, s, kind, side }: { x: number; y: number; s: number; kind: Eyes; side: -1 | 1 }) {
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

/**
 * O claudinho de uma conversa (ver lib/claudinho.ts). O estado mexe na expressão: trabalhando, ele
 * pisca de vez em quando (cada um no seu tempo); esperando você, olha para cima. `status` põe a
 * bolinha do estado no canto (azul trabalhando, âmbar esperando), para onde não há outro sinal dele.
 */
export function Claudinho({
  seed,
  size = 28,
  name,
  state,
  status = false,
  className,
}: {
  seed: string
  /** O nome dele: vira a dica ao passar o mouse e o que o leitor de tela lê. Sem nome, é só enfeite. */
  name?: string
  size?: number
  state?: CatalogState | SessionState
  status?: boolean
  className?: string
}) {
  // A conversa que continua outra (um /clear) veste o claudinho de lá: o mesmo personagem.
  const worn = useLooks((s) => s[seed]) ?? seed
  const look = lookOf(worn)
  const running = state === 'running' || state === 'starting'
  const waiting = state === 'waiting'
  const half = look.gap / 2
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
      <g transform={look.tilt ? `rotate(${look.tilt.toFixed(1)} 16 16)` : undefined}>
        <Body look={look} />
        <g
          className={running ? 'claudinho-blink' : undefined}
          style={running ? { animationDelay: `${(-phaseOf(worn) * 4).toFixed(2)}s` } : undefined}
          transform={waiting ? 'translate(0 -1.6)' : undefined}
        >
          <Eye x={16 - half} y={look.eyeY} s={look.eyeScale} kind={look.eyes} side={-1} />
          <Eye x={16 + half} y={look.eyeY} s={look.eyeScale} kind={look.eyes} side={1} />
        </g>
      </g>
      {status && (running || waiting) && (
        <circle cx="27.5" cy="27.5" r="4.2" className={running ? 'fill-sky-500' : 'fill-amber-500'} stroke="var(--background)" strokeWidth="2.5" />
      )}
    </svg>
  )
}
