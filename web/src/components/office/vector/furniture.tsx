import type { OfficeTodos } from '@/lib/types'
import { AREA_W, FLOOR_BACK, FLOOR_FRONT, SPOTS } from './layout'
import { PAL } from './palette'
import type { Sky } from './sky'

/**
 * Os móveis de uma área, em coordenadas da área. `on`: alguém está usando (acende e mexe); `t`: o
 * relógio do mundo, em segundos, para as animações correrem lisas em vez de pular de quadro em quadro.
 * Apagados, vão para o fundo pronto (ver backdrop.tsx); acesos, entram por cima a cada quadro.
 */

const wave = (t: number, hz: number, phase = 0) => (Math.sin((t * hz + phase) * Math.PI * 2) + 1) / 2

/** Estante na parede: de onde saem os livros das skills. */
export function Shelf({ x, y }: { x: number; y: number }) {
  const books: React.ReactNode[] = []
  for (let row = 0; row < 2; row++) {
    const by = y + row * 11
    for (let i = 0, bx = x + 1; bx < x + 22; i++) {
      const w = 2 + (i % 3 === 0 ? 1 : 0)
      const h = 6 + ((i + row) % 3)
      books.push(<rect key={`${row}-${i}`} x={bx} y={by + 9 - h} width={w - 0.3} height={h} rx={0.6} fill={PAL.books[(i + row * 2) % PAL.books.length]} />)
      bx += w + (i % 4 === 3 ? 2 : 0)
    }
  }
  return (
    <g>
      {books}
      <rect x={x} y={y + 9} width={24} height={2} rx={1} fill={PAL.woodDark} />
      <rect x={x} y={y + 20} width={24} height={2} rx={1} fill={PAL.woodDark} />
    </g>
  )
}

export function WindowPane({ x, y, w, sky }: { x: number; y: number; w: number; sky: Sky }) {
  return (
    <g>
      <rect x={x - 2} y={y - 2} width={w + 4} height={26} rx={2.5} fill={PAL.rim} />
      <rect x={x} y={y} width={w} height={22} rx={1.5} fill="url(#office-pane)" />
      <path d={`M${x + 3} ${y + 19}L${x + 9} ${y + 2}h3L${x + 6} ${y + 19}z`} fill="#fff" opacity={sky.night ? 0.08 : 0.35} />
      {sky.rain &&
        [0, 1, 2, 3].map((i) => <rect key={i} x={x + 6 + i * 5} y={y + 3 + ((i * 7) % 12)} width={0.8} height={3} rx={0.4} fill="#fff" opacity={0.5} />)}
      <rect x={x + w / 2 - 0.5} y={y} width={1} height={22} fill={PAL.rim} />
      <rect x={x - 3} y={y + 22} width={w + 6} height={2} rx={1} fill={PAL.rimDark} />
    </g>
  )
}

/** Planta alta no canto esquerdo da área. */
export function TallPlant() {
  return (
    <g>
      <ellipse cx={12} cy={FLOOR_BACK - 24} rx={4} ry={9} fill={PAL.leafDark} transform={`rotate(-18 12 ${FLOOR_BACK - 16})`} />
      <ellipse cx={19} cy={FLOOR_BACK - 22} rx={3.6} ry={8} fill={PAL.leafDark} transform={`rotate(20 19 ${FLOOR_BACK - 14})`} />
      <ellipse cx={15.5} cy={FLOOR_BACK - 26} rx={4} ry={11} fill={PAL.leaf} />
      <path d={`M9 ${FLOOR_BACK - 9}h12l-1.5 9h-9z`} fill={PAL.pot} />
      <rect x={8.5} y={FLOOR_BACK - 10} width={13} height={2.2} rx={1.1} fill={PAL.potDark} />
    </g>
  )
}

export function Cabinet({ on, t }: { on: boolean; t: number }) {
  const x = 30
  const y = FLOOR_BACK - 38
  // A gaveta do meio abre e fecha devagar (mais depressa compactando, ver areaLive).
  const open = on ? wave(t, 1) * 2.5 : 0
  return (
    <g>
      <g transform={`translate(${x + 10} ${y})`}>
        <ellipse cx={-4} cy={-10} rx={2.4} ry={4} fill={PAL.leaf} transform="rotate(-20 -4 -6)" />
        <ellipse cx={4} cy={-10} rx={2.4} ry={4} fill={PAL.leaf} transform="rotate(20 4 -6)" />
        <ellipse cx={0} cy={-12} rx={2.4} ry={5} fill={PAL.leafDark} />
        <path d="M-4 -6h8l-1 6h-6z" fill={PAL.pot} />
      </g>
      <rect x={x} y={y} width={20} height={38} rx={2} fill={PAL.metalDark} />
      <rect x={x} y={y} width={20} height={2.5} rx={1.2} fill={PAL.metalLight} />
      {[0, 1, 2].map((i) => {
        const dy = y + 4 + i * 11
        const o = i === 1 ? open : 0
        return (
          <g key={i}>
            {o > 0.3 && (
              <>
                <rect x={x + 3} y={dy - 2.5 - o * 0.4} width={4} height={4} rx={0.5} fill={PAL.white} />
                <rect x={x + 8} y={dy - 3 - o * 0.5} width={4} height={5} rx={0.5} fill={PAL.paper} />
              </>
            )}
            <rect x={x + 2 - o * 0.6} y={dy} width={16 + o * 1.2} height={9} rx={1.5} fill={o > 0.3 ? PAL.metalLight : PAL.metal} />
            <rect x={x + 7 - o * 0.6} y={dy + 3} width={6} height={2} rx={1} fill={PAL.metalDeep} />
          </g>
        )
      })}
    </g>
  )
}

function Desk({ x, y, w }: { x: number; y: number; w: number }) {
  return (
    <g>
      <rect x={x + 1} y={y + 3} width={10} height={11} rx={1} fill={PAL.woodDark} />
      <rect x={x + 3} y={y + 7} width={6} height={1} rx={0.5} fill={PAL.woodDeep} />
      <circle cx={x + 6} cy={y + 10.5} r={0.9} fill={PAL.brass} />
      <rect x={x + w - 3} y={y + 3} width={2} height={11} rx={0.8} fill={PAL.woodDeep} />
      <rect x={x} y={y} width={w} height={4} rx={1.5} fill={PAL.wood} />
    </g>
  )
}

/** Cadeira de escritório; `back`: só o encosto, desenhado na frente de quem está sentado de costas. */
export function Chair({ cx, seatY, part }: { cx: number; seatY: number; part: 'all' | 'seat' | 'back' }) {
  return (
    <g>
      {part !== 'back' && (
        <>
          <rect x={cx - 1} y={seatY} width={2} height={5} fill={PAL.ink} />
          <rect x={cx - 4.5} y={seatY + 4} width={9} height={1.4} rx={0.7} fill={PAL.ink} />
          <rect x={cx - 6.5} y={seatY - 3} width={13} height={3.4} rx={1.7} fill={PAL.chair} />
        </>
      )}
      {part !== 'seat' && (
        <>
          <rect x={cx - 6} y={seatY - 8.5} width={12} height={9.5} rx={3} fill={PAL.chair} />
          <rect x={cx - 4.5} y={seatY - 7.2} width={9} height={1.4} rx={0.7} fill={PAL.chairLight} />
        </>
      )}
    </g>
  )
}

export function PcDesk({ on, t }: { on: boolean; t: number }) {
  const x = 54
  const y = FLOOR_BACK - 14
  return (
    <g>
      <Desk x={x} y={y} w={36} />
      <rect x={x + 8} y={y - 15} width={18} height={13} rx={1.5} fill={PAL.ink} />
      <rect x={x + 9} y={y - 14} width={16} height={10} rx={0.8} fill={on ? PAL.screen : PAL.screenOff} />
      {on && (
        // Um globo girando na tela: está na web.
        <g>
          <circle cx={x + 17} cy={y - 9} r={3.6} fill={PAL.screenLight} />
          <ellipse cx={x + 17} cy={y - 9} rx={Math.abs(Math.cos(t * 3)) * 3.6} ry={3.6} fill="none" stroke={PAL.screen} strokeWidth={0.7} />
          <line x1={x + 13.4} x2={x + 20.6} y1={y - 9} y2={y - 9} stroke={PAL.screen} strokeWidth={0.7} />
        </g>
      )}
      <rect x={x + 16} y={y - 2.5} width={2} height={2.5} fill={PAL.ink} />
      <rect x={x + 12} y={y - 1} width={10} height={1} rx={0.5} fill={PAL.ink} />
      <rect x={x + 28} y={y - 10} width={6} height={10} rx={1} fill={PAL.metalDeep} />
      <circle cx={x + 29.8} cy={y - 7.5} r={0.7} fill={on ? PAL.led : PAL.metal} />
    </g>
  )
}

export function Workbench({ on, t }: { on: boolean; t: number }) {
  const x = 94
  const y = FLOOR_BACK - 14
  return (
    <g>
      <Desk x={x} y={y} w={36} />
      <rect x={x + 10} y={y - 9} width={14} height={9} rx={1.2} fill={PAL.ink} />
      <rect x={x + 11} y={y - 8} width={12} height={7} rx={0.6} fill={on ? PAL.screen : PAL.screenOff} />
      {on &&
        // As linhas do código crescendo na tela.
        [0, 1, 2].map((i) => <rect key={i} x={x + 12} y={y - 7 + i * 2} width={1.5 + ((t * 7 + i * 3) % 9)} height={0.9} rx={0.45} fill={PAL.screenLight} />)}
      <rect x={x + 8} y={y - 1} width={18} height={1.2} rx={0.6} fill={PAL.metalDeep} />
      <rect x={x + 26} y={y - 3} width={7} height={3} rx={0.5} fill={PAL.white} />
      <rect x={x + 27} y={y - 4} width={6} height={1} rx={0.5} fill={PAL.paper} />
      <rect x={x + 3} y={y - 8} width={1} height={3.5} rx={0.5} fill={PAL.brass} />
      <rect x={x + 2} y={y - 5} width={4} height={5} rx={1} fill={PAL.red} />
    </g>
  )
}

/** As folhas na pilha ao lado do notebook (uma por arquivo editado). */
export function Papers({ n }: { n: number }) {
  const x = 94 + 26
  const y = FLOOR_BACK - 14 - 4
  return (
    <g>
      {Array.from({ length: Math.min(n, 9) }, (_, i) => (
        <rect key={i} x={x + (i % 2) * 0.8} y={y - i} width={7} height={1} rx={0.3} fill={i % 2 ? PAL.white : PAL.paper} />
      ))}
    </g>
  )
}

export function Whiteboard({ on, t, todos }: { on: boolean; t: number; todos?: OfficeTodos }) {
  const x = 134
  const y = 22
  const frame = (
    <>
      <rect x={x} y={y} width={32} height={24} rx={2} fill={PAL.boardFrame} />
      <rect x={x + 1} y={y + 1} width={30} height={21} rx={1.2} fill={PAL.board} />
      <rect x={x + 2} y={y + 23} width={28} height={2} rx={1} fill={PAL.metalDark} />
    </>
  )
  if (todos && todos.total > 0) {
    // As tarefas da conversa: feitas em verde, a atual em azul, e a barra de progresso embaixo.
    const rows = Math.min(todos.total, 4)
    const start = Math.max(0, Math.min(todos.done - 1, todos.total - rows))
    return (
      <g>
        {frame}
        {Array.from({ length: rows }, (_, i) => {
          const n = start + i
          const ry = y + 3 + i * 4
          const done = n < todos.done
          const current = n === todos.done
          return (
            <g key={n}>
              <circle cx={x + 4} cy={ry + 1} r={1.1} fill={done ? PAL.led : current ? PAL.blue : PAL.metalLight} />
              <rect x={x + 7} y={ry + 0.4} width={[18, 12, 20, 14][n % 4]} height={1.2} rx={0.6} fill={done ? PAL.metalLight : current ? PAL.blue : PAL.metal} />
            </g>
          )
        })}
        <rect x={x + 3} y={y + 19} width={26} height={2} rx={1} fill={PAL.metalLight} />
        <rect x={x + 3} y={y + 19} width={(26 * todos.done) / todos.total} height={2} rx={1} fill={PAL.led} />
        {on && <circle cx={x + 27} cy={y + 4} r={1.2} fill={PAL.red} opacity={wave(t, 0.75)} />}
      </g>
    )
  }
  // Rabiscos: um plano que vai crescendo enquanto alguém está no quadro.
  const grow = on ? (t / 1.2) % 4 : 2
  return (
    <g>
      {frame}
      {[18, 12, 22, 9].map((w, i) => {
        const shown = Math.max(0, Math.min(1, grow - i))
        return shown > 0 ? <rect key={i} x={x + 4} y={y + 4 + i * 4} width={w * shown} height={1.2} rx={0.6} fill={i === 3 ? PAL.red : PAL.blue} /> : null
      })}
      {on && <circle cx={x + 25.5} cy={y + 5.5} r={1.6} fill={PAL.led} />}
    </g>
  )
}

export function Rack({ on, t, alarm = false }: { on: boolean; t: number; alarm?: boolean }) {
  const x = 170
  const y = FLOOR_BACK - 46
  const c = alarm ? PAL.ledRed : PAL.led
  return (
    <g>
      <rect x={x} y={y} width={16} height={46} rx={2} fill={PAL.rack} />
      <rect x={x} y={y} width={16} height={2.5} rx={1.2} fill={PAL.metalDark} />
      <rect x={x + 2} y={y + 4} width={12} height={8} rx={1} fill={PAL.ink} />
      {on && (
        // O terminal: um prompt e o cursor piscando.
        <g>
          <path d={`M${x + 3.2} ${y + 6}l1.6 1.2l-1.6 1.2`} fill="none" stroke={c} strokeWidth={0.7} strokeLinecap="round" strokeLinejoin="round" />
          <rect x={x + 7} y={y + 8.6} width={3} height={0.9} rx={0.45} fill={c} opacity={wave(t, 2) > 0.5 ? 1 : 0.15} />
        </g>
      )}
      {[0, 1, 2, 3, 4].map((i) => {
        const lit = alarm ? wave(t, 3) > 0.5 : on ? wave(t, 2.4, i * 0.37) > 0.4 : i === 0
        const red = alarm || (on && wave(t, 1.7, i * 0.23) > 0.92)
        return (
          <g key={i}>
            <rect x={x + 2} y={y + 15 + i * 6} width={12} height={4} rx={0.8} fill={PAL.rackFront} />
            <circle cx={x + 11.5} cy={y + 17 + i * 6} r={0.7} fill={lit ? (alarm ? PAL.ledRed : PAL.led) : PAL.metalDeep} />
            <circle cx={x + 9.5} cy={y + 17 + i * 6} r={0.7} fill={red ? PAL.ledRed : PAL.metalDeep} />
          </g>
        )
      })}
    </g>
  )
}

/** Semáforo em cima do rack: verde ou vermelho pelo último teste; apagado sem teste recente. */
export function TestLight({ ok }: { ok: boolean | undefined }) {
  const x = 174
  const y = FLOOR_BACK - 46 - 6
  return (
    <g>
      <rect x={x} y={y} width={8} height={6} rx={1.5} fill={PAL.ink} />
      <circle cx={x + 2.2} cy={y + 3} r={1.4} fill={ok === false ? PAL.ledRed : '#4a2a2a'} />
      <circle cx={x + 5.8} cy={y + 3} r={1.4} fill={ok === true ? PAL.led : '#26402f'} />
    </g>
  )
}

export function Coffee({ on, t }: { on: boolean; t: number }) {
  const x = 189
  const y = FLOOR_BACK - 18
  return (
    <g>
      <rect x={x + 1} y={y + 2} width={14} height={16} rx={1} fill={PAL.woodDark} />
      <rect x={x + 3} y={y + 7} width={10} height={1} rx={0.5} fill={PAL.woodDeep} />
      <rect x={x} y={y} width={16} height={3} rx={1.2} fill={PAL.wood} />
      <rect x={x + 3} y={y - 14} width={10} height={14} rx={2} fill="#3a3f47" />
      <rect x={x + 4} y={y - 12} width={8} height={3} rx={1} fill={on ? PAL.ledRed : PAL.metalDeep} />
      <path d={`M${x + 6} ${y - 5}h4v3a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z`} fill={PAL.white} />
      {on &&
        // Vapor subindo da xícara, ondulando e sumindo.
        [0, 0.5].map((d) => {
          const p = (t * 0.6 + d) % 1
          return (
            <path
              key={d}
              d={`M${x + 7.5 + d * 1.5} ${y - 6 - p * 8}q1.2 -1.5 0 -3`}
              fill="none"
              stroke={PAL.steam}
              strokeWidth={0.8}
              strokeLinecap="round"
              opacity={1 - p}
            />
          )
        })}
    </g>
  )
}

/** Sofá; `back` e `front` separam o encosto (atrás de quem senta) dos braços e da frente (na frente dele). */
export function Sofa({ part }: { part: 'all' | 'back' | 'front' }) {
  const x = 210
  const y = FLOOR_BACK - 6
  return (
    <g>
      {part !== 'front' && (
        <>
          <rect x={x + 3} y={y - 8} width={34} height={11} rx={3.5} fill={PAL.sofaDark} />
          <rect x={x + 5} y={y - 6.5} width={30} height={2} rx={1} fill={PAL.sofa} />
          <rect x={x + 3} y={y + 2} width={34} height={6} rx={2} fill={PAL.sofa} />
          <rect x={x + 5} y={y + 2.4} width={30} height={1.2} rx={0.6} fill={PAL.sofaLight} />
        </>
      )}
      {part !== 'back' && (
        <>
          <rect x={x + 3} y={y + 7} width={34} height={5} rx={1.5} fill={PAL.sofaDark} />
          <rect x={x} y={y - 4} width={5} height={15} rx={2.5} fill={PAL.sofaDark} />
          <rect x={x + 35} y={y - 4} width={5} height={15} rx={2.5} fill={PAL.sofaDark} />
        </>
      )}
    </g>
  )
}

export function Tv({ on, t }: { on: boolean; t: number }) {
  const x = 216
  const y = 26
  return (
    <g>
      <rect x={x + 12} y={y + 16} width={4} height={3} fill={PAL.ink} />
      <rect x={x} y={y} width={28} height={18} rx={2} fill={PAL.ink} />
      <rect x={x + 1.2} y={y + 1.2} width={25.6} height={14.6} rx={1} fill={on ? PAL.screen : PAL.screenOff} />
      {on && (
        // Barra de progresso: algo rodando em segundo plano.
        <>
          <rect x={x + 4} y={y + 11} width={20} height={2} rx={1} fill={PAL.screenLight} />
          <rect x={x + 4} y={y + 11} width={2 + ((t * 6) % 18)} height={2} rx={1} fill={PAL.white} />
        </>
      )}
    </g>
  )
}

/** Os móveis de uma área, todos apagados (quem está em uso acende por cima, ver live.tsx). */
export function AreaBack({ sky }: { sky: Sky }) {
  return (
    <g>
      <TallPlant />
      <Shelf x={28} y={10} />
      <WindowPane x={60} y={14} w={24} sky={sky} />
      <WindowPane x={100} y={14} w={24} sky={sky} />
      <Tv on={false} t={0} />
      <Whiteboard on={false} t={0} />
      <Cabinet on={false} t={0} />
      <PcDesk on={false} t={0} />
      <Workbench on={false} t={0} />
      <Rack on={false} t={0} />
      <TestLight ok={undefined} />
      <Coffee on={false} t={0} />
      <Chair cx={SPOTS.web.x} seatY={SPOTS.web.y - 2} part="all" />
      <Chair cx={SPOTS.edit.x} seatY={SPOTS.edit.y - 2} part="all" />
      <Sofa part="all" />
    </g>
  )
}

/** Área sem conversa: caixas de mudança, uma janela e a luz apagada. */
export function FreeArea({ sky }: { sky: Sky }) {
  return (
    <g>
      <WindowPane x={100} y={14} w={24} sky={sky} />
      {[
        [70, 22, 16],
        [94, 18, 12],
        [78, 16, 10],
      ].map(([bx, bw, bh]) => {
        const by = bx === 78 ? FLOOR_BACK - 26 : FLOOR_BACK - bh
        return (
          <g key={bx}>
            <rect x={bx} y={by} width={bw} height={bh} rx={1} fill={PAL.cardboard} />
            <rect x={bx} y={by} width={bw} height={2} rx={1} fill={PAL.cardboardLight} />
            <rect x={bx + bw / 2 - 1} y={by} width={2} height={bh} fill={PAL.cardboardDark} />
          </g>
        )
      })}
      <rect x={0} y={6} width={AREA_W} height={FLOOR_FRONT - 6} fill="#0a0c14" opacity={0.45} />
    </g>
  )
}
