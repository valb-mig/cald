import { useId } from 'react'
import { Claudinho } from '@/components/claudinho'
import { Bar, Dots, Empty, Window } from '@/components/empty-art'

// Os desenhos dos vazios do painel do modo coding, com as peças de components/empty-art.tsx: janelas
// empilhadas e cor só no que é do Claude (o laranja da edição, os claudinhos).
const CLAUDE = '#d97757'
// Os desenhos da tela de código: a janela tem altura variável, então o desenho encolhe quando ela baixa
// (e o `Empty` com `fit` o tira de vez, abaixo disso).
const CODE_ART = 'h-32 w-auto text-foreground [@container(max-height:250px)]:h-20'

/** A janela de trás, à esquerda: a mesma nos desenhos da tela de código, que são da mesma família. */
function BackWindow() {
  return (
    <g transform="rotate(-8 50 60)">
      <Window x={12} y={32} w={72} h={56} tint={0.03} />
    </g>
  )
}

/** Três janelas de código empilhadas; a da frente com a faixa que o Claude acabou de escrever. */
function CodeStack() {
  return (
    <svg viewBox="0 0 168 120" fill="none" aria-hidden className={CODE_ART}>
      <BackWindow />
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

/** A tela de código antes da primeira edição: as janelas e uns claudinhos em volta, à espera. */
export function CodeEmptyArt() {
  return (
    <Empty
      title="Nada modificado"
      hint="O que o Claude escrever nos arquivos aparece aqui."
      fit
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

// O corte da janela fantasma: uma linha em zigue-zague da borda de cima à de baixo, como papel rasgado.
const TEAR = '98,40 93,50 99,61 90,75 95,89 88,110'

/** A janela da frente de `CodeStack`, só o contorno tracejado e rasgada em duas: o arquivo que não se alcança. */
function MissingStack() {
  const id = useId()
  const ghost = (
    <>
      <rect x="40" y="40" width="92" height="70" rx="8" className="fill-background" />
      <rect x="40" y="40" width="92" height="70" rx="8" fill="currentColor" fillOpacity="0.015" stroke="currentColor" strokeOpacity="0.24" strokeDasharray="4 3" />
      <path d="M40 52h92" stroke="currentColor" strokeOpacity="0.12" strokeDasharray="4 3" />
      <Dots x={47} y={46} />
      <Bar x={49} y={61} w={24} o={0.08} />
      <Bar x={77} y={61} w={18} o={0.06} />
      <Bar x={56} y={70} w={36} o={0.08} />
      <Bar x={56} y={81} w={46} o={0.06} />
      <Bar x={49} y={94} w={14} o={0.08} />
      <Bar x={49} y={102} w={28} o={0.06} />
    </>
  )
  // A borda do rasgo, nos dois pedaços: sem ela, o corte some no tema claro.
  const edge = <polyline points={TEAR} stroke="currentColor" strokeOpacity="0.2" strokeLinejoin="round" />
  return (
    <svg viewBox="0 0 168 120" fill="none" aria-hidden className={CODE_ART}>
      <defs>
        <clipPath id={`${id}l`}>
          <polygon points={`0,0 98,0 ${TEAR} 88,120 0,120`} />
        </clipPath>
        <clipPath id={`${id}r`}>
          <polygon points={`98,0 168,0 168,120 88,120 ${TEAR.split(' ').reverse().join(' ')}`} />
        </clipPath>
      </defs>
      <BackWindow />
      <g clipPath={`url(#${id}l)`}>
        {ghost}
        {edge}
      </g>
      {/* O pedaço da direita, solto e caindo um pouco. */}
      <g transform="translate(11 4) rotate(4 110 75)">
        <g clipPath={`url(#${id}r)`}>
          {ghost}
          {edge}
        </g>
      </g>
    </svg>
  )
}

/** A janela da frente com uma imagem (montanha e sol) e a de trás com pixels: o que não é texto. */
function NotTextStack() {
  const id = useId()
  // Os pixels da janela de trás: tons variados, sem padrão que chame a atenção.
  const pixels = []
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 8; c++) {
      const o = [0.05, 0.14, 0.09, 0.2, 0.07][(r * 3 + c * 7 + ((r * c) % 3)) % 5]!
      pixels.push(<rect key={`${r}-${c}`} x={86 + c * 7} y={35 + r * 7} width="5" height="5" rx="1" fill="currentColor" fillOpacity={o} />)
    }
  return (
    <svg viewBox="0 0 168 120" fill="none" aria-hidden className={CODE_ART}>
      <defs>
        <clipPath id={id}>
          <rect x="40" y="40" width="92" height="70" rx="8" />
        </clipPath>
      </defs>
      <BackWindow />
      <g transform="rotate(6 114 50)">
        <Window x={78} y={18} w={76} h={58} tint={0.045} />
        {pixels}
      </g>
      <Window x={40} y={40} w={92} h={70} tint={0.07} />
      <circle cx="112" cy="68" r="6" fill="currentColor" fillOpacity="0.16" />
      <g clipPath={`url(#${id})`}>
        <path d="M40 112V98L68 72L88 90L100 80L134 106V112Z" fill="currentColor" fillOpacity="0.1" />
        <path d="M40 112V104L60 92L84 108L106 96L134 112Z" fill="currentColor" fillOpacity="0.08" />
      </g>
    </svg>
  )
}

/** O arquivo que a tela de código não alcança: fora das pastas de projeto, apagado ou nunca criado. */
export function FileMissingArt() {
  return (
    <Empty
      title="Arquivo indisponível"
      hint="Fora das pastas de projeto, ou não existe mais no disco."
      fit
      art={
        <div className="relative px-6 py-3">
          <MissingStack />
          {/* Em cima do rasgo, espiando onde o arquivo deveria estar. */}
          <Claudinho seed="vazio-indisponivel-1" size={14} className="absolute top-[25%] left-[56%] -rotate-6" />
        </div>
      }
    />
  )
}

/** O arquivo que não é texto: imagem, PDF ou binário. */
export function FileNotTextArt({ kind }: { kind: 'image' | 'pdf' | 'binary' | 'large' }) {
  // O `large` (grande demais para ler) cabe no mesmo desenho: é o que a tela não mostra como texto.
  const [title, hint] =
    kind === 'large' ? ['Grande demais', 'Passa do tamanho que esta tela lê.'] : ['Não é texto', `${{ image: 'Imagem', pdf: 'PDF', binary: 'Binário' }[kind]}: aqui só aparece texto.`]
  return (
    <Empty
      title={title}
      hint={hint}
      fit
      art={
        <div className="relative px-6 py-3">
          <NotTextStack />
          {/* No pé da janela da imagem, olhando para ela. */}
          <Claudinho seed="vazio-binario-1" size={14} className="absolute bottom-[12%] left-[22%] -rotate-12" />
        </div>
      }
    />
  )
}

/** Os passos antes do primeiro comando. */
export function StepsEmptyArt() {
  return <Empty title="Nenhum passo ainda" hint="Os comandos do Claude e o que voltou deles aparecem aqui." art={<TerminalStack />} />
}
