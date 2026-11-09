import { cn } from '@/lib/utils'

// As peças dos desenhos dos vazios (ver chat/empty-art.tsx e project/empty-art.tsx): cinza chapado,
// texto em barras, peças opacas empilhadas. As cores saem de `currentColor`, então valem nos dois temas.

/** Os três pontinhos da barra de título de uma janela. */
export function Dots({ x, y }: { x: number; y: number }) {
  return (
    <g fill="currentColor" fillOpacity="0.18">
      <circle cx={x} cy={y} r="1.6" />
      <circle cx={x + 5} cy={y} r="1.6" />
      <circle cx={x + 10} cy={y} r="1.6" />
    </g>
  )
}

/** Uma linha de texto ou de código: uma barra arredondada. */
export function Bar({ x, y, w, o = 0.2, fill = 'currentColor' }: { x: number; y: number; w: number; o?: number; fill?: string }) {
  return <rect x={x} y={y} width={w} height="4" rx="2" fill={fill} fillOpacity={o} />
}

/** Um cartão ou uma folha: opaco (o fundo da tela por baixo, senão o de trás apareceria através) e tingido. */
export function Card({ x, y, w, h, tint, rx = 8 }: { x: number; y: number; w: number; h: number; tint: number; rx?: number }) {
  return (
    <>
      <rect x={x} y={y} width={w} height={h} rx={rx} className="fill-background" />
      <rect x={x} y={y} width={w} height={h} rx={rx} fill="currentColor" fillOpacity={tint} stroke="currentColor" strokeOpacity={tint + 0.06} />
    </>
  )
}

/** Uma janela: o cartão com a barra de título. */
export function Window({ x, y, w, h, tint }: { x: number; y: number; w: number; h: number; tint: number }) {
  return (
    <>
      <Card x={x} y={y} w={w} h={h} tint={tint} />
      <path d={`M${x} ${y + 12}h${w}`} stroke="currentColor" strokeOpacity={tint + 0.04} />
      <Dots x={x + 7} y={y + 6} />
    </>
  )
}

/** A grade de fundo, que some em direção às bordas. */
export function Grid() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 text-foreground/[0.06]"
      style={{
        backgroundImage: 'linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)',
        backgroundSize: '18px 18px',
        backgroundPosition: 'center',
        maskImage: 'radial-gradient(closest-side, black, transparent)',
      }}
    />
  )
}

/**
 * Um vazio: o desenho no meio, um título curto e uma linha do que vai aparecer ali. Com `fit`, o vazio mede
 * a própria altura (ele precisa de altura definida, como filho de uma linha flex): baixo demais, o desenho
 * some e fica o texto. O desenho pode também encolher antes, com `[@container(max-height:…)]` no svg.
 */
export function Empty({ art, title, hint, fit }: { art: React.ReactNode; title: string; hint: string; fit?: boolean }) {
  return (
    <div className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden p-4 text-center', fit && '[container-type:size]')}>
      <Grid />
      <div className={cn('relative', fit && '[@container(max-height:190px)]:hidden')}>{art}</div>
      <div className="relative space-y-0.5">
        <p className="text-sm text-foreground/85">{title}</p>
        <p className="text-xs text-balance text-muted-foreground">{hint}</p>
      </div>
    </div>
  )
}
