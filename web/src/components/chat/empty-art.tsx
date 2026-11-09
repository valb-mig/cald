import { Claudinho } from '@/components/claudinho'

// Os desenhos dos vazios do painel do modo coding: cinza chapado, texto em barras e janelas empilhadas,
// com cor só no que é do Claude (o laranja da edição, os claudinhos). As cores saem de `currentColor`,
// então valem nos dois temas.
const CLAUDE = '#d97757'

/** Os três pontinhos da barra de título de uma janela. */
function Dots({ x, y }: { x: number; y: number }) {
  return (
    <g fill="currentColor" fillOpacity="0.18">
      <circle cx={x} cy={y} r="1.6" />
      <circle cx={x + 5} cy={y} r="1.6" />
      <circle cx={x + 10} cy={y} r="1.6" />
    </g>
  )
}

/** Uma linha de código: uma barra arredondada. */
function Bar({ x, y, w, o = 0.2, fill = 'currentColor' }: { x: number; y: number; w: number; o?: number; fill?: string }) {
  return <rect x={x} y={y} width={w} height="4" rx="2" fill={fill} fillOpacity={o} />
}

/** Uma janela: opaca (o fundo da tela por baixo, senão a de trás apareceria através), com a barra de título. */
function Window({ x, y, w, h, tint }: { x: number; y: number; w: number; h: number; tint: number }) {
  return (
    <>
      <rect x={x} y={y} width={w} height={h} rx="8" className="fill-background" />
      <rect x={x} y={y} width={w} height={h} rx="8" fill="currentColor" fillOpacity={tint} stroke="currentColor" strokeOpacity={tint + 0.06} />
      <path d={`M${x} ${y + 12}h${w}`} stroke="currentColor" strokeOpacity={tint + 0.04} />
      <Dots x={x + 7} y={y + 6} />
    </>
  )
}

/** Três janelas de código empilhadas; a da frente com a faixa que o Claude acabou de escrever. */
function CodeStack() {
  return (
    <svg viewBox="0 0 168 120" fill="none" aria-hidden className="h-32 w-auto text-foreground">
      <g transform="rotate(-8 50 60)">
        <Window x={12} y={32} w={72} h={56} tint={0.03} />
      </g>
      <g transform="rotate(6 114 50)">
        <Window x={78} y={18} w={76} h={58} tint={0.045} />
        <Bar x={86} y={38} w={30} o={0.1} />
        <Bar x={92} y={46} w={22} o={0.1} />
      </g>
      <Window x={40} y={40} w={92} h={70} tint={0.07} />
      <Bar x={49} y={61} w={24} o={0.24} />
      <Bar x={77} y={61} w={18} o={0.12} />
      <Bar x={56} y={70} w={36} o={0.2} />
      {/* A edição do Claude: o fundo laranja com a barra à esquerda, como na tela de código. */}
      <rect x="41" y="77" width="90" height="12" fill={CLAUDE} fillOpacity="0.13" />
      <rect x="41" y="77" width="2" height="12" fill={CLAUDE} fillOpacity="0.7" />
      <Bar x={56} y={81} w={46} o={0.6} fill={CLAUDE} />
      <Bar x={49} y={94} w={14} o={0.2} />
      <Bar x={49} y={102} w={28} o={0.12} />
    </svg>
  )
}

/** Dois cartões de terminal empilhados: o prompt em barras (pasta, agente, comando) e o cursor esperando. */
function TerminalStack() {
  return (
    <svg viewBox="0 0 168 104" fill="none" aria-hidden className="h-24 w-auto text-foreground">
      <g transform="rotate(-5 84 40)">
        <rect x="30" y="10" width="108" height="46" rx="10" fill="#000" fillOpacity="0.55" stroke="currentColor" strokeOpacity="0.1" />
        <Bar x={40} y={22} w={26} o={0.5} fill="#58a6ff" />
        <Bar x={70} y={22} w={14} o={0.5} fill={CLAUDE} />
        <Bar x={88} y={22} w={34} o={0.25} fill="#e5e5e5" />
        <Bar x={40} y={32} w={52} o={0.15} fill="#e5e5e5" />
      </g>
      <rect x="22" y="40" width="124" height="54" rx="11" fill="#000" stroke="currentColor" strokeOpacity="0.14" />
      <Bar x={33} y={53} w={30} o={0.8} fill="#58a6ff" />
      <Bar x={67} y={53} w={16} o={0.85} fill={CLAUDE} />
      <Bar x={87} y={53} w={40} o={0.45} fill="#e5e5e5" />
      <Bar x={33} y={64} w={64} o={0.22} fill="#e5e5e5" />
      <Bar x={33} y={73} w={44} o={0.22} fill="#e5e5e5" />
      <rect x="33" y="81" width="5" height="8" rx="1" fill="#e5e5e5" fillOpacity="0.85" className="animate-pulse" />
    </svg>
  )
}

/** A grade de fundo, que some em direção às bordas. */
function Grid() {
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

/** Um vazio do painel: o desenho no meio, um título curto e uma linha do que vai aparecer ali. */
function Empty({ art, title, hint }: { art: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden p-4 text-center">
      <Grid />
      <div className="relative">{art}</div>
      <div className="relative space-y-0.5">
        <p className="text-sm text-foreground/85">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  )
}

/** A tela de código antes da primeira edição: as janelas e uns claudinhos em volta, à espera. */
export function CodeEmptyArt() {
  return (
    <Empty
      title="Nada modificado"
      hint="O que o Claude escrever nos arquivos aparece aqui."
      art={
        <div className="relative px-6 py-3">
          <CodeStack />
          <Claudinho seed="vazio-codigo-1" size={16} className="absolute top-0 left-1 -rotate-12" />
          <Claudinho seed="vazio-codigo-2" size={14} className="absolute top-1 right-3 rotate-12" />
          <Claudinho seed="vazio-codigo-3" size={13} className="absolute right-0 bottom-6 -rotate-6" />
        </div>
      }
    />
  )
}

/** Os passos antes do primeiro comando. */
export function StepsEmptyArt() {
  return <Empty title="Nenhum passo ainda" hint="Os comandos do Claude e o que voltou deles aparecem aqui." art={<TerminalStack />} />
}
