import { memo } from 'react'
import { AreaBack, FreeArea } from './furniture'
import { AREA_W, CORRIDOR_W, FLOOR_BACK, FLOOR_FRONT, FLOOR_H, GROUND_H, ROOF_H, WALK_H, groundOf, signBox, type Layout } from './layout'
import { PAL } from './palette'
import { seeded, type Sky } from './sky'

/**
 * O que não muda de um quadro para outro: o céu (atrás de tudo), a cidade, a rua e o prédio com os
 * móveis apagados. São componentes memorizados: só voltam a ser desenhados quando a luz do dia
 * (`sky.key`, a cada 5 min) ou as áreas ocupadas mudam. O que se mexe entra por cima (ver live.tsx).
 */

const WALL_W = 10

/** Gradientes usados pelo resto da salinha (os ids são únicos na página: só há uma salinha). */
function Defs({ sky, ground }: { sky: Sky; ground: number }) {
  return (
    <defs>
      <linearGradient id="office-sky" x1="0" y1="0" x2="0" y2={ground} gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor={sky.top} />
        <stop offset="1" stopColor={sky.bottom} />
      </linearGradient>
      <linearGradient id="office-pane" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={sky.pane[0]} />
        <stop offset="1" stopColor={sky.pane[1]} />
      </linearGradient>
      {/* Facho de luz: forte junto da lâmpada, sumindo para baixo. */}
      <linearGradient id="office-beam" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff2b0" stopOpacity="0.9" />
        <stop offset="1" stopColor="#fff2b0" stopOpacity="0" />
      </linearGradient>
      {/* Farol: o facho vai para a frente do carro (o desenho do carro é para a direita). */}
      <linearGradient id="office-headlight" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#fff2b0" stopOpacity="0.35" />
        <stop offset="1" stopColor="#fff2b0" stopOpacity="0" />
      </linearGradient>
    </defs>
  )
}

/** O sol cruza das 6h às 18h; a lua, das 19h às 5h, no arco de céu que aparece acima do prédio. */
function SunMoon({ sky, width }: { sky: Sky; width: number }) {
  if (sky.rain) return null
  const arc = (p: number) => ({ x: width * (0.08 + 0.84 * p), y: 7 + (1 - Math.sin(Math.PI * p)) * 36 })
  const moonP = sky.hour >= 19 ? (sky.hour - 19) / 10 : sky.hour <= 5 ? (sky.hour + 5) / 10 : -1
  return (
    <g>
      {sky.hour >= 6 && sky.hour <= 18 &&
        (() => {
          const { x, y } = arc((sky.hour - 6) / 12)
          const sun = sky.dark > 0.2 ? '#ffb86b' : '#ffe27a'
          return (
            <g>
              <circle cx={x} cy={y} r={14} fill={sun} opacity={0.18} />
              <circle cx={x} cy={y} r={9} fill={sun} opacity={0.25} />
              <circle cx={x} cy={y} r={5.5} fill={sun} />
            </g>
          )
        })()}
      {moonP >= 0 &&
        (() => {
          const { x, y } = arc(moonP)
          return (
            <g>
              <circle cx={x} cy={y} r={11} fill="#f3f0d8" opacity={0.1} />
              <circle cx={x} cy={y} r={4.8} fill="#f3f0d8" />
              <circle cx={x - 1.4} cy={y - 1.2} r={1.1} fill="#ddd9c0" />
              <circle cx={x + 1.6} cy={y + 1.5} r={0.9} fill="#ddd9c0" />
            </g>
          )
        })()}
    </g>
  )
}

/** O céu: degradê da hora, sol e lua. Atrás das nuvens e da cidade. */
export const SkyBack = memo(function SkyBack({ layout, sky }: { layout: Layout; sky: Sky }) {
  const ground = groundOf(layout)
  return (
    <g>
      <Defs sky={sky} ground={ground} />
      <rect x={0} y={0} width={layout.width} height={ground + 1} fill="url(#office-sky)" />
      <SunMoon sky={sky} width={layout.width} />
    </g>
  )
})

function Skyline({ layout, sky }: { layout: Layout; sky: Sky }) {
  const ground = groundOf(layout)
  const out: React.ReactNode[] = []
  for (const [layer, color, maxH] of [
    [11, sky.far, 0.55],
    [23, sky.near, 0.38],
  ] as const) {
    const r = seeded(layer)
    for (let x = -10; x < layout.width; ) {
      const w = 18 + Math.floor(r() * 30)
      const h = Math.floor((0.15 + r() * maxH) * ground)
      const top = ground - h
      out.push(<path key={`${layer}-${x}`} d={`M${x} ${ground}V${top + 2}q0 -2 2 -2h${w - 4}q2 0 2 2V${ground}z`} fill={color} />)
      for (let wy = top + 4; wy < ground - 4; wy += 6) {
        for (let wx = x + 3; wx < x + w - 3; wx += 5) {
          if (r() < 0.35 * sky.dark) out.push(<rect key={`${layer}-${wx}-${wy}`} x={wx} y={wy} width={2} height={2} rx={0.4} fill={sky.lit} />)
        }
      }
      x += w + 2 + Math.floor(r() * 6)
    }
  }
  return <g>{out}</g>
}

function Tree({ x, ground }: { x: number; ground: number }) {
  return (
    <g>
      <rect x={x + 8} y={ground - 22} width={5} height={24} rx={1.5} fill="#6b4a2f" />
      <circle cx={x + 6} cy={ground - 28} r={7} fill={PAL.leafDark} />
      <circle cx={x + 15} cy={ground - 29} r={7.5} fill={PAL.leafDark} />
      <circle cx={x + 10.5} cy={ground - 38} r={8.5} fill={PAL.leaf} />
      <circle cx={x + 8} cy={ground - 40} r={2.5} fill="#fff" opacity={0.12} />
    </g>
  )
}

/** Calçada, meio-fio, asfalto, postes, árvores e os enfeites da época. */
function Street({ layout: l, sky }: { layout: Layout; sky: Sky }) {
  const ground = groundOf(l)
  const lit = sky.dark > 0.4
  const outside = (x: number) => x > 2 && x < l.width - 8 && (x < l.building.x - 6 || x > l.building.x + l.building.w + 2)
  const poles = [l.building.x - 40, l.building.x + l.building.w + 34, 34, l.width - 42].filter(outside)
  const trees = [14, l.width - 36]
  if (l.building.x > 30) trees.push(l.building.x - 26, l.building.x + l.building.w + 8)
  const joints: React.ReactNode[] = []
  for (let x = 0; x < l.width; x += 26) joints.push(<rect key={`j${x}`} x={x} y={ground + 1} width={0.8} height={WALK_H - 2} fill={sky.rain ? '#989da5' : '#aab0b8'} />)
  const marks: React.ReactNode[] = []
  for (let x = 6; x < l.width; x += 34) marks.push(<rect key={`m${x}`} x={x} y={ground + 42} width={16} height={2} rx={1} fill="#e7d17a" />)
  return (
    <g>
      <rect x={0} y={ground} width={l.width} height={WALK_H} fill={sky.rain ? '#a4a9b1' : '#b9bec6'} />
      {joints}
      <rect x={0} y={ground + WALK_H} width={l.width} height={3} fill="#8b929c" />
      <rect x={0} y={ground + WALK_H + 3} width={l.width} height={GROUND_H - WALK_H - 3} fill={sky.rain ? '#343840' : '#3d424b'} />
      {sky.rain && <rect x={0} y={ground + WALK_H + 3} width={l.width} height={GROUND_H - WALK_H - 3} fill="url(#office-sky)" opacity={0.08} />}
      {marks}
      {poles.map((px) => (
        <g key={px}>
          {lit && <path d={`M${px + 2} ${ground - 41}L${px - 24} ${ground + 3}H${px + 30}z`} fill="url(#office-beam)" opacity={0.22 * sky.dark} />}
          <rect x={px} y={ground - 44} width={2} height={46} rx={1} fill="#4a505a" />
          <path d={`M${px} ${ground - 44}q0 -2.5 3 -2.5h4q1.5 0 1.5 1.5v1h-8.5z`} fill="#4a505a" />
          <rect x={px + 1.5} y={ground - 43} width={5} height={1.8} rx={0.9} fill={lit ? '#fff2b0' : '#8a9099'} />
          {lit && <circle cx={px + 4} cy={ground - 42} r={5} fill="#fff2b0" opacity={0.25} />}
        </g>
      ))}
      {trees.map((tx) => (
        <Tree key={tx} x={tx} ground={ground} />
      ))}
      {sky.season === 'halloween' &&
        // Abóboras na calçada, de cara acesa à noite.
        trees.map((tx) => {
          const x = tx + 27
          return (
            <g key={`p${tx}`}>
              <rect x={x - 0.8} y={ground - 1.5} width={1.6} height={2.5} rx={0.6} fill={PAL.leafDark} />
              <ellipse cx={x} cy={ground + 5} rx={5.2} ry={4} fill="#ef7d1a" />
              <ellipse cx={x} cy={ground + 5} rx={2} ry={4} fill="#d96a10" />
              {lit && (
                <>
                  <path d={`M${x - 3} ${ground + 4.5}l1 -1.6l1 1.6z M${x + 1} ${ground + 4.5}l1 -1.6l1 1.6z`} fill={PAL.gold} />
                  <path d={`M${x - 2.4} ${ground + 6.4}h4.8q-2.4 2 -4.8 0z`} fill={PAL.gold} />
                </>
              )}
            </g>
          )
        })}
    </g>
  )
}

function Facade({ layout: l, sky }: { layout: Layout; sky: Sky }) {
  const { x, y, w, h } = l.building
  const sign = signBox(l)
  return (
    <g>
      <rect x={x} y={y + ROOF_H - 4} width={w} height={h - ROOF_H + 4} fill="#9ea6b1" />
      <rect x={x} y={y + ROOF_H - 4} width={2} height={h - ROOF_H + 4} fill="#c5ccd5" />
      <rect x={x + w - 2} y={y + ROOF_H - 4} width={2} height={h - ROOF_H + 4} fill="#7c8592" />
      {/* Telhado: caixa d'água, letreiro e antena atrás da mureta. */}
      <rect x={x + 12} y={y + 20} width={2} height={5} fill="#5d4a3d" />
      <rect x={x + 24} y={y + 20} width={2} height={5} fill="#5d4a3d" />
      <rect x={x + 10} y={y + 4} width={18} height={18} rx={2.5} fill="#8a6f5a" />
      <rect x={x + 10} y={y + 4} width={18} height={3.5} rx={1.75} fill="#a38670" />
      <rect x={sign.x + 10} y={y + 18} width={3} height={7} fill="#555c66" />
      <rect x={sign.x + sign.w - 13} y={y + 18} width={3} height={7} fill="#555c66" />
      <rect x={sign.x} y={sign.y} width={sign.w} height={sign.h} rx={3} fill="#20242c" />
      <rect x={sign.x + 1.2} y={sign.y + 1.2} width={sign.w - 2.4} height={sign.h - 2.4} rx={2} fill={sky.dark > 0.2 ? '#2d3340' : '#2a2f39'} />
      <rect x={x + w - 22} y={y - 14} width={2} height={38} rx={1} fill="#6b727c" />
      <rect x={x + w - 26} y={y - 4} width={10} height={2} rx={1} fill="#6b727c" />
      <rect x={x - 3} y={y + ROOF_H - 6} width={w + 6} height={4.5} rx={1.5} fill="#c5ccd5" />
      <rect x={x - 3} y={y + ROOF_H - 2} width={w + 6} height={2} fill="#7c8592" />
      {sky.season === 'junina' && <Flags x={x} y={y} w={w} />}
    </g>
  )
}

/** Bandeirinhas de festa junina de um lado a outro da mureta, em duas fileiras caídas. */
function Flags({ x, y, w }: { x: number; y: number; w: number }) {
  const colors = ['#e34948', '#f6c945', '#2a78d6', '#1baf7a', '#e87ba4']
  const sag = (p: number) => Math.sin(Math.PI * p) * 5
  return (
    <g>
      {[0, 1].map((row) => {
        const base = y + ROOF_H - 4 + row * 7
        const flags: React.ReactNode[] = []
        for (let i = 0, fx = x + 2; fx < x + w - 4; fx += 6, i++) {
          const fy = base + sag((fx - x) / w)
          flags.push(<path key={fx} d={`M${fx} ${fy}h4l-2 4z`} fill={colors[(i + row * 2) % colors.length]} />)
        }
        return (
          <g key={row}>
            <path d={`M${x} ${base}Q${x + w / 2} ${base + 10} ${x + w} ${base}`} fill="none" stroke="#555c66" strokeWidth={0.5} />
            {flags}
          </g>
        )
      })}
    </g>
  )
}

/** O miolo de um andar: teto com luminárias, parede, chão de tacos e laje. Pinta a largura toda. */
function Storey({ layout: l, floor, sky }: { layout: Layout; floor: number; sky: Sky }) {
  const x = l.building.x + WALL_W
  const w = l.building.w - WALL_W * 2
  const y = l.floorTop(floor)
  const lamps: React.ReactNode[] = []
  for (let lx = x + 20; lx < x + w - 10; lx += 48) {
    lamps.push(
      <g key={lx}>
        {sky.dark > 0.2 && <path d={`M${lx} ${y + 7}L${lx - 15} ${y + 29}H${lx + 29}L${lx + 14} ${y + 7}z`} fill="url(#office-beam)" opacity={0.14 * sky.dark} />}
        <rect x={lx} y={y + 5} width={14} height={2} rx={1} fill="#eef2f6" />
      </g>,
    )
  }
  const planks: React.ReactNode[] = []
  for (let fy = FLOOR_BACK + 5; fy < FLOOR_FRONT; fy += 6) planks.push(<rect key={`h${fy}`} x={x} y={y + fy} width={w} height={0.8} fill={PAL.floorLine} />)
  for (let fx = 6; fx < w; fx += 16) {
    for (let row = 0; row < 3; row++) planks.push(<rect key={`v${fx}-${row}`} x={x + fx + (row % 2) * 8} y={y + FLOOR_BACK + row * 6} width={0.8} height={5} fill={PAL.floorLine} />)
  }
  return (
    <g>
      <rect x={x} y={y} width={w} height={FLOOR_BACK} fill={PAL.wall} />
      <rect x={x} y={y + FLOOR_BACK - 16} width={w} height={16} fill={PAL.wallLow} />
      <rect x={x} y={y + FLOOR_BACK - 3} width={w} height={3} fill={PAL.wallLine} />
      <rect x={x} y={y} width={w} height={5} fill="#d5dbe2" />
      <rect x={x} y={y + 5} width={w} height={1} fill="#aab3bf" />
      {lamps}
      <rect x={x} y={y + FLOOR_BACK} width={w} height={FLOOR_FRONT - FLOOR_BACK} fill={PAL.floor} />
      {planks}
      <rect x={x} y={y + FLOOR_FRONT} width={w} height={3} fill={PAL.floorEdge} />
      <rect x={x} y={y + FLOOR_FRONT + 3} width={w} height={FLOOR_H - FLOOR_FRONT - 3} fill="#6f7782" />
      <rect x={x} y={y + FLOOR_FRONT + 3} width={w} height={1} fill="#89919c" />
    </g>
  )
}

/** Portas do elevador; `open` vai de 0 (fechadas) a 1 (abertas), para abrirem deslizando. */
export function Elevator({ layout: l, floor, open }: { layout: Layout; floor: number; open: number }) {
  const ex = l.corridorX + CORRIDOR_W / 2 - 13
  const ey = l.floorTop(floor) + FLOOR_BACK - 44
  const gap = open * 9
  return (
    <g>
      <rect x={ex - 3} y={ey - 3} width={32} height={47} rx={2.5} fill="#8e98a4" />
      <rect x={ex} y={ey} width={26} height={44} rx={1} fill="#2b2f38" />
      <rect x={ex + 1} y={ey + 1} width={12 - gap} height={43} fill="#b6c0cb" />
      <rect x={ex + 13 + gap} y={ey + 1} width={12 - gap} height={43} fill="#a7b1bc" />
      {open < 0.05 && <rect x={ex + 12.5} y={ey + 1} width={1} height={43} fill="#8e98a4" />}
      <rect x={ex + 8} y={ey - 9.5} width={10} height={5.5} rx={1.2} fill={PAL.ink} />
      <rect x={ex + 29} y={ey + 20} width={3} height={5} rx={1} fill="#5a636e" />
      <circle cx={ex + 30.5} cy={ey + 21.6} r={0.8} fill={open > 0 ? PAL.amber : PAL.led} />
    </g>
  )
}

/** Corredor de um andar: lajotas, elevador, bebedouro, planta e o número do andar. */
function Corridor({ layout: l, floor }: { layout: Layout; floor: number }) {
  const x = l.corridorX
  const y = l.floorTop(floor)
  const tiles: React.ReactNode[] = []
  for (let fx = 0; fx < CORRIDOR_W; fx += 9) tiles.push(<rect key={`v${fx}`} x={x + fx} y={y + FLOOR_BACK} width={0.8} height={FLOOR_FRONT - FLOOR_BACK} fill="#a3aab4" />)
  for (let fy = FLOOR_BACK + 6; fy < FLOOR_FRONT; fy += 6) tiles.push(<rect key={`h${fy}`} x={x} y={y + fy} width={CORRIDOR_W} height={0.8} fill="#a3aab4" />)
  const px = x + CORRIDOR_W - 10
  return (
    <g>
      <rect x={x} y={y + 6} width={CORRIDOR_W} height={FLOOR_BACK - 6} fill="#5a6380" />
      <rect x={x} y={y + FLOOR_BACK - 16} width={CORRIDOR_W} height={16} fill="#525a75" />
      <rect x={x} y={y + FLOOR_BACK} width={CORRIDOR_W} height={FLOOR_FRONT - FLOOR_BACK} fill="#b9bfc8" />
      {tiles}
      <Elevator layout={l} floor={floor} open={0} />
      <text x={x + CORRIDOR_W / 2} y={y + FLOOR_BACK - 50.5} textAnchor="middle" dominantBaseline="central" fontSize={4.2} fontWeight={700} fill="#3ddc84">
        {floor + 1}
      </text>
      {/* Bebedouro. */}
      <rect x={x + 6} y={y + FLOOR_BACK - 22} width={9} height={22} rx={1.5} fill="#e3e8ee" />
      <rect x={x + 6.5} y={y + FLOOR_BACK - 32} width={8} height={10} rx={2.5} fill="#7fc4f0" />
      <rect x={x + 7.6} y={y + FLOOR_BACK - 31} width={1.6} height={8} rx={0.8} fill="#bfe3fb" />
      {/* Planta. */}
      <ellipse cx={px - 3} cy={y + FLOOR_BACK - 15} rx={2.8} ry={7} fill={PAL.leafDark} transform={`rotate(-15 ${px - 3} ${y + FLOOR_BACK - 9})`} />
      <ellipse cx={px + 3} cy={y + FLOOR_BACK - 13} rx={2.5} ry={6} fill={PAL.leafDark} transform={`rotate(18 ${px + 3} ${y + FLOOR_BACK - 8})`} />
      <ellipse cx={px} cy={y + FLOOR_BACK - 17} rx={2.8} ry={9} fill={PAL.leaf} />
      <path d={`M${px - 4.5} ${y + FLOOR_BACK - 8}h9l-1.2 8h-6.6z`} fill={PAL.pot} />
    </g>
  )
}

/** Divisória de cubículo entre a área e o corredor (meia altura; a frente do chão fica livre para passar). */
function Partition({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y + 45} width={4} height={FLOOR_BACK - 45 + 8} rx={1} fill="#7f8aa3" />
      <rect x={x} y={y + 44} width={4} height={3} rx={1.5} fill="#c3cad6" />
      <rect x={x + 1.2} y={y + 50} width={1.6} height={FLOOR_BACK - 54} rx={0.8} fill="#95a0b8" />
    </g>
  )
}

/**
 * Cidade, rua e prédio, na frente do céu. `occupied` diz quais áreas têm conversa (as outras ficam
 * livres), como texto (ex.: "0,1,3") para a memorização comparar.
 */
export const CityBack = memo(function CityBack({ layout: l, sky, occupied }: { layout: Layout; sky: Sky; occupied: string }) {
  const used = new Set(occupied ? occupied.split(',').map(Number) : [])
  const floors = Array.from({ length: l.floors }, (_, f) => f)
  return (
    <g>
      <Skyline layout={l} sky={sky} />
      <Street layout={l} sky={sky} />
      <Facade layout={l} sky={sky} />
      {floors.map((f) => (
        <g key={f}>
          <Storey layout={l} floor={f} sky={sky} />
          <Corridor layout={l} floor={f} />
        </g>
      ))}
      {Array.from({ length: l.floors * l.perFloor }, (_, s) => {
        const area = l.area(s)
        return (
          <g key={s}>
            <g transform={`translate(${area.x} ${area.y})`}>{used.has(s) ? <AreaBack sky={sky} /> : <FreeArea sky={sky} />}</g>
            <Partition x={area.side === 'left' ? area.x + AREA_W - 2 : area.x - 2} y={area.y} />
          </g>
        )
      })}
    </g>
  )
})
