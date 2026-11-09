import { Claudinho } from '@/components/claudinho'
import { Bar, Card, Empty } from '@/components/empty-art'

// Os desenhos dos vazios da barra do projeto, com as peças de components/empty-art.tsx. A barra é
// estreita: um objeto por aba, na altura do menor desenho do chat, e só o Git leva cor (o verde do
// "em dia"); o resto da cor fica com os claudinhos.
// As posições dos claudinhos, em px, contam com esta altura.
const ART = 'h-24 w-auto text-foreground'

/** Os dois ramos do PR, como o ícone: o da esquerda reto e o da direita voltando para ele com a seta. */
function PullGlyph({ x, y, o = 0.3 }: { x: number; y: number; o?: number }) {
  const node = (cx: number, cy: number) => (
    <circle cx={cx} cy={cy} r="3.5" className="fill-background" stroke="currentColor" strokeOpacity={o} strokeWidth="1.5" />
  )
  return (
    <g stroke="currentColor" strokeOpacity={o} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={`M${x} ${y}V${y + 28}`} />
      <path d={`M${x + 16} ${y + 28}V${y + 9}a6 6 0 0 0 -6 -6H${x + 7}m3.5 -3.5L${x + 7} ${y + 3}l3.5 3.5`} />
      {node(x, y)}
      {node(x, y + 28)}
      {node(x + 16, y + 28)}
    </g>
  )
}

/** Dois PRs empilhados, como na lista: o ícone dos ramos, o título e os metadados em barras. */
function PullStack() {
  return (
    <svg viewBox="0 0 152 104" fill="none" aria-hidden className={ART}>
      <g transform="rotate(6 92 30)">
        <Card x={40} y={10} w={100} h={40} tint={0.035} rx={9} />
        <Bar x={52} y={20} w={46} o={0.1} />
        <Bar x={52} y={30} w={28} o={0.07} />
      </g>
      <Card x={12} y={42} w={116} h={52} tint={0.07} rx={9} />
      <PullGlyph x={26} y={54} />
      <Bar x={56} y={53} w={52} o={0.24} />
      <Bar x={56} y={62} w={34} o={0.24} />
      <Bar x={56} y={76} w={12} o={0.12} />
      <Bar x={72} y={76} w={22} o={0.12} />
      <Bar x={98} y={76} w={14} o={0.12} />
    </svg>
  )
}

/** A bandeja de entrada num círculo, com as folhas saindo; a da frente com o círculo de issue. */
function IssueTray() {
  const front = 'M28 66H50L55 74H77L82 66H104V84A6 6 0 0 1 98 90H34A6 6 0 0 1 28 84Z'
  return (
    <svg viewBox="16 4 100 100" fill="none" aria-hidden className={ART}>
      <circle cx="66" cy="54" r="46" className="fill-background" />
      <circle cx="66" cy="54" r="46" fill="currentColor" fillOpacity="0.035" stroke="currentColor" strokeOpacity="0.07" />
      {/* O fundo da bandeja, atrás das folhas. */}
      <path d="M28 66 36 50H96L104 66Z" className="fill-background" />
      <path d="M28 66 36 50H96L104 66Z" fill="currentColor" fillOpacity="0.04" stroke="currentColor" strokeOpacity="0.1" strokeLinejoin="round" />
      <g transform="rotate(-8 54 44)">
        <Card x={38} y={20} w={34} h={46} tint={0.04} rx={5} />
        <Bar x={44} y={28} w={16} o={0.1} />
        <Bar x={44} y={35} w={22} o={0.1} />
      </g>
      <g transform="rotate(6 80 40)">
        <Card x={58} y={12} w={40} h={54} tint={0.065} rx={5} />
        {/* O círculo de issue, como na lista. */}
        <circle cx="67" cy="22" r="4" stroke="currentColor" strokeOpacity="0.32" strokeWidth="1.5" />
        <circle cx="67" cy="22" r="1.4" fill="currentColor" fillOpacity="0.32" />
        <Bar x={75} y={20} w={16} o={0.22} />
        <Bar x={64} y={32} w={26} o={0.12} />
        <Bar x={64} y={39} w={20} o={0.12} />
      </g>
      {/* A frente da bandeja, com a dobra do meio, tapando o pé das folhas. */}
      <path d={front} className="fill-background" />
      <path d={front} fill="currentColor" fillOpacity="0.07" stroke="currentColor" strokeOpacity="0.14" strokeLinejoin="round" />
    </svg>
  )
}

/** Uma folha com a orelha dobrada no canto. */
function Doc({ x, y, w, h, tint }: { x: number; y: number; w: number; h: number; tint: number }) {
  const d = `M${x + 5} ${y}H${x + w - 11}L${x + w} ${y + 11}V${y + h - 5}a5 5 0 0 1 -5 5H${x + 5}a5 5 0 0 1 -5 -5V${y + 5}a5 5 0 0 1 5 -5Z`
  return (
    <>
      <path d={d} className="fill-background" />
      <path d={d} fill="currentColor" fillOpacity={tint} stroke="currentColor" strokeOpacity={tint + 0.06} strokeLinejoin="round" />
      <path d={`M${x + w - 11} ${y}V${y + 8}a3 3 0 0 0 3 3H${x + w}`} fill="currentColor" fillOpacity={tint + 0.04} stroke="currentColor" strokeOpacity={tint + 0.06} strokeLinejoin="round" />
    </>
  )
}

/** Folhas empilhadas, todas guardadas; o selo verde de "em dia" no canto da da frente. */
function CleanDocs() {
  return (
    <svg viewBox="8 0 124 104" fill="none" aria-hidden className={ART}>
      <g transform="rotate(-10 48 50)">
        <Doc x={24} y={20} w={44} h={58} tint={0.03} />
      </g>
      <g transform="rotate(9 92 46)">
        <Doc x={72} y={14} w={44} h={58} tint={0.045} />
        <Bar x={80} y={34} w={20} o={0.1} />
        <Bar x={80} y={41} w={26} o={0.1} />
      </g>
      <Doc x={46} y={26} w={48} h={64} tint={0.07} />
      <Bar x={54} y={38} w={18} o={0.24} />
      <Bar x={54} y={49} w={30} o={0.13} />
      <Bar x={54} y={57} w={24} o={0.13} />
      <Bar x={54} y={65} w={28} o={0.13} />
      <Bar x={54} y={73} w={14} o={0.13} />
      <g className="text-emerald-500">
        <circle cx="93" cy="86" r="10" className="fill-background" />
        <circle cx="93" cy="86" r="10" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.5" />
        <path d="m88.5 86 3 3 5.5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  )
}

/** A prancheta com as caixinhas vazias e o lápis encostado. */
function Clipboard() {
  return (
    <svg viewBox="22 0 104 104" fill="none" aria-hidden className={ART}>
      <g transform="rotate(-5 60 54)">
        <Card x={32} y={14} w={56} h={80} tint={0.06} />
        {/* O prendedor no topo. */}
        <Card x={48} y={8} w={24} h={12} tint={0.1} rx={4} />
        {[34, 50, 66].map((y, i) => (
          <g key={y}>
            <rect x="40" y={y - 2.5} width="9" height="9" rx="2.5" className="fill-background" stroke="currentColor" strokeOpacity="0.26" strokeWidth="1.25" />
            <Bar x={54} y={y} w={[24, 18, 26][i]!} o={0.16} />
          </g>
        ))}
        <rect x="40" y="79.5" width="9" height="9" rx="2.5" stroke="currentColor" strokeOpacity="0.14" strokeWidth="1.25" strokeDasharray="2 2" />
      </g>
      {/* O lápis, deitado na diagonal por cima do canto. */}
      <g transform="rotate(32 98 64)">
        <rect x="93" y="34" width="10" height="44" rx="2" className="fill-background" />
        <rect x="93" y="34" width="10" height="44" rx="2" fill="currentColor" fillOpacity="0.07" stroke="currentColor" strokeOpacity="0.14" />
        <rect x="93" y="34" width="10" height="8" rx="2" fill="currentColor" fillOpacity="0.1" />
        <path d="M93 78h10l-5 11Z" className="fill-background" />
        <path d="M93 78h10l-5 11Z" fill="currentColor" fillOpacity="0.05" stroke="currentColor" strokeOpacity="0.14" strokeLinejoin="round" />
        <path d="M96.2 85h3.6l-1.8 4Z" fill="currentColor" fillOpacity="0.35" />
      </g>
    </svg>
  )
}

/** A aba de PRs sem nenhum aberto. */
export function PullsEmptyArt() {
  return (
    <Empty
      title="Nenhum PR aberto"
      hint="Os PRs abertos do repositório aparecem aqui."
      art={
        <div className="relative px-5 py-2">
          <PullStack />
          <Claudinho seed="vazio-prs-1" size={16} className="absolute top-[22px] left-[30px] -rotate-12" />
          {/* Sentado na beirada do PR de trás. */}
          <Claudinho seed="vazio-prs-2" size={13} className="absolute top-[7px] left-[122px] rotate-6" />
        </div>
      }
    />
  )
}

/** A aba de issues sem nenhuma aberta. */
export function IssuesEmptyArt() {
  return (
    <Empty
      title="Nenhuma issue aberta"
      hint="As issues abertas do repositório aparecem aqui."
      art={
        <div className="relative px-5 py-2">
          <IssueTray />
          {/* No lugar do selo, na beirada do círculo. */}
          <Claudinho seed="vazio-issues-1" size={16} className="absolute top-[20px] left-[96px] rotate-12" />
        </div>
      }
    />
  )
}

/** A aba do Git sem nada a mostrar: `title` e `hint` mudam com o que a lista compara. */
export function CleanEmptyArt({ title, hint }: { title: string; hint: string }) {
  return (
    <Empty
      title={title}
      hint={hint}
      art={
        <div className="relative px-5 py-2">
          <CleanDocs />
          <Claudinho seed="vazio-git-1" size={15} className="absolute top-[76px] left-[14px] -rotate-6" />
        </div>
      }
    />
  )
}

/** O TODO do projeto sem nenhum item. */
export function TodoEmptyArt() {
  return (
    <Empty
      title="Nada por fazer"
      hint="Anote acima o que falta neste projeto."
      art={
        <div className="relative px-5 py-2">
          <Clipboard />
          {/* Empoleirado na prancheta, ao lado do prendedor. */}
          <Claudinho seed="vazio-todo-1" size={15} className="absolute top-[8px] left-[66px] rotate-6" />
          <Claudinho seed="vazio-todo-2" size={13} className="absolute top-[70px] left-[8px] -rotate-12" />
        </div>
      }
    />
  )
}
