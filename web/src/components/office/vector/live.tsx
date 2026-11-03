import { projectName } from '@/lib/format'
import type { OfficeRoom } from '@/lib/types'
import { ActorShape, Bubble, headTop } from './actor'
import { Elevator } from './backdrop'
import { Cabinet, Chair, Coffee, Papers, PcDesk, Rack, Sofa, TestLight, Tv, Whiteboard, Workbench } from './furniture'
import { AREA_W, CORRIDOR_W, FLOOR_FRONT, LANE_FAR, LANE_NEAR, ROOF_H, SPOTS, WALK_H, groundOf, signBox, type AreaLive, type Layout, type Occupancy } from './layout'
import { PAL } from './palette'
import { seeded, type Sky } from './sky'
import { LEN, type Car, type Street, type Walker } from './street'
import type { Effect, World } from './world'

/**
 * O que se mexe na salinha, desenhado de novo a cada quadro por cima do fundo pronto (backdrop.tsx):
 * o céu vivo, a rua, os móveis em uso, os claudinhos, os balões e as etiquetas. Tudo em unidades do
 * mundo; `k` é quantos pixels de tela vale uma unidade, para os textos terem o tamanho certo na tela.
 */

export type Placed = { room: OfficeRoom; key: string; slot: number }

export type Frame = {
  layout: Layout
  placed: Placed[]
  world: World
  street: Street
  sky: Sky
  /** Segundos: o relógio do mundo (parado com `prefers-reduced-motion` para o que é só enfeite). */
  t: number
  /** Pixels de tela (CSS) por unidade do mundo. */
  k: number
  /** Limite de 5 h estourado: escritório fechado até `reopen`; perto do fim, o letreiro fica âmbar. */
  closed: boolean
  reopen?: string
  warn: boolean
  /** Claudinho tocado há pouco: mostra o que ele faz no lugar do nome. */
  selected?: string
}

export const stateOf = (room: OfficeRoom) => {
  const lead = room.workers[0]?.activity
  if (room.state === 'waiting' || lead === 'ask') return { color: '#f5a623', label: 'Pede você', asking: true }
  if (room.state === 'running') return { color: '#63c7ff', label: 'Trabalhando', asking: false }
  if (lead === 'background') return { color: '#63c7ff', label: 'Em segundo plano', asking: false }
  return { color: '#3ddc84', label: 'Descansando', asking: false }
}

const wave = (t: number, hz: number, phase = 0) => (Math.sin((t * hz + phase) * Math.PI * 2) + 1) / 2

// ---------------------------------------------------------------------------
// Céu: estrelas, nuvens, avião e pássaros (atrás da cidade).
// ---------------------------------------------------------------------------

type Cloud = { seed: number; speed: number; y: number; w: number }
const CLOUDS: Cloud[] = Array.from({ length: 6 }, (_, i) => {
  const r = seeded(101 + i * 17)
  return { seed: r(), speed: 1.5 + r() * 3, y: 6 + r() * 44, w: 18 + Math.floor(r() * 22) }
})

export function SkyLife({ width, ground, sky, t }: { width: number; ground: number; sky: Sky; t: number }) {
  const out: React.ReactNode[] = []
  if (sky.dark > 0.5 && !sky.rain) {
    // Estrelas: cada uma pisca no seu tempo.
    const rnd = seeded(7)
    const fade = Math.min(1, (sky.dark - 0.5) * 2)
    for (let i = 0; i < width / 6; i++) {
      const x = rnd() * width
      const y = rnd() * ground * 0.6
      const phase = rnd()
      const r = 0.35 + rnd() * 0.35
      out.push(<circle key={`s${i}`} cx={x} cy={y} r={r} fill="#e8eefc" opacity={fade * (0.35 + 0.65 * wave(t, 0.15 + phase * 0.3, phase))} />)
    }
  }
  // Nuvens: brancas de dia, escuras à noite, mais cheias com chuva.
  const clouds = sky.rain ? CLOUDS.length : 4
  const color = sky.rain ? '#8d949e' : sky.dark > 0.5 ? '#4a5578' : '#ffffff'
  const alpha = sky.rain ? 0.9 : sky.dark > 0.5 ? 0.35 : 0.85
  for (let i = 0; i < clouds; i++) {
    const c = CLOUDS[i]
    const span = width + c.w * 2
    const x = ((c.seed * span + t * c.speed) % span) - c.w
    out.push(
      <g key={`c${i}`} fill={color} opacity={alpha} transform={`translate(${x.toFixed(2)} ${c.y})`}>
        <rect x={0} y={3} width={c.w} height={4.5} rx={2.25} />
        <circle cx={c.w * 0.38} cy={3.2} r={c.w * 0.18} />
        <circle cx={c.w * 0.64} cy={3.8} r={c.w * 0.13} />
      </g>,
    )
  }
  // Avião cruzando a cada 2 minutos: de noite só as luzinhas.
  const flight = t % 120
  if (flight < 40 && !sky.rain) {
    const x = (flight / 40) * (width + 40) - 20
    const y = 14 + (Math.floor(t / 120) % 3) * 6
    out.push(
      <g key="plane" transform={`translate(${x.toFixed(2)} ${y})`}>
        {sky.dark < 0.5 && (
          <g fill="#e9edf2">
            <rect x={0} y={-0.2} width={12} height={2.2} rx={1.1} />
            <path d="M4 0l1.5 -3h1.5l-0.5 3z" />
            <path d="M4.5 1.8l1.5 2.2h1.2l-0.4 -2.2z" fill="#c5ccd5" />
            <path d="M10 0l1.5 -2.5h0.8v2.5z" fill="#c5ccd5" />
          </g>
        )}
        <circle cx={1} cy={1} r={0.7} fill="#ff4d4d" opacity={wave(t, 1.5) > 0.5 ? 1 : 0.15} />
        <circle cx={10.5} cy={1.2} r={0.6} fill="#ffffff" opacity={wave(t, 1.5, 0.5) > 0.5 ? 1 : 0.15} />
      </g>,
    )
  }
  // Pássaros de dia; morcegos nas noites de Halloween.
  const bats = sky.season === 'halloween' && sky.dark > 0.5
  if ((sky.dark < 0.3 || bats) && !sky.rain) {
    const flock = t % 70
    if (flock < 30) {
      const dir = Math.floor(t / 70) % 2 ? 1 : -1
      const p = flock / 30
      const x0 = dir > 0 ? -10 + p * (width + 20) : width + 10 - p * (width + 20)
      for (let i = 0; i < 3; i++) {
        const x = x0 - dir * i * 7
        const y = 30 + i * 3 + Math.sin(t * 2 + i) * 2
        const flap = Math.sin(t * 9 + i * 2) * 1.6
        out.push(
          <path
            key={`b${i}`}
            d={`M${(x - 2.5).toFixed(2)} ${(y - flap).toFixed(2)}Q${(x - 1).toFixed(2)} ${(y - 0.6).toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)}Q${(x + 1).toFixed(2)} ${(y - 0.6).toFixed(2)} ${(x + 2.5).toFixed(2)} ${(y - flap).toFixed(2)}`}
            fill="none"
            stroke={bats ? '#1a1424' : '#3a3f4a'}
            strokeWidth={0.8}
            strokeLinecap="round"
          />,
        )
      }
    }
  }
  return <g>{out}</g>
}

/** Chuva caindo, menos dentro do prédio em corte (o recorte `office-rain-hole`). */
function Rain({ width, height, t }: { width: number; height: number; t: number }) {
  const rnd = seeded(31)
  const drops: React.ReactNode[] = []
  for (let i = 0; i < width / 3; i++) {
    const x0 = rnd() * width
    const speed = 110 + rnd() * 50
    const y = (rnd() * height + t * speed) % height
    const x = (x0 - y * 0.25 + width) % width
    drops.push(<line key={i} x1={x.toFixed(1)} y1={y.toFixed(1)} x2={(x - 0.75).toFixed(1)} y2={(y + 3).toFixed(1)} />)
  }
  return (
    <g clipPath="url(#office-rain-hole)" stroke="#b9c7dc" strokeWidth={0.6} strokeLinecap="round" opacity={0.6}>
      {drops}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Rua: carros, ônibus, o caminhão das entregas e quem passa na calçada.
// ---------------------------------------------------------------------------

function Wheel({ cx, cy, t, moving }: { cx: number; cy: number; t: number; moving: boolean }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={3.3} fill={PAL.ink} />
      <circle cx={cx} cy={cy} r={1.6} fill="#6a727d" />
      <rect x={cx - 0.35} y={cy - 1.6} width={0.7} height={3.2} fill="#3a3f47" transform={moving ? `rotate(${((t * 540) % 360).toFixed(0)} ${cx} ${cy})` : undefined} />
    </g>
  )
}

/** Um veículo de perfil, com as rodas em `y`, virado para onde anda (o desenho é para a direita e espelha). */
function Vehicle({ c, y, sky, t }: { c: Car; y: number; sky: Sky; t: number }) {
  const len = LEN[c.kind]
  const glass = sky.dark > 0.5 ? '#44618a' : '#a9d7f2'
  const moving = c.stopped === undefined || c.stopped <= 0
  const lit = sky.dark > 0.5
  let body: React.ReactNode
  if (c.kind === 'bus') {
    const windows: React.ReactNode[] = []
    for (let wx = -len / 2 + 4; wx < len / 2 - 14; wx += 11) windows.push(<rect key={wx} x={wx} y={-24} width={8} height={9} rx={1.2} fill={glass} />)
    body = (
      <g>
        <rect x={-len / 2} y={-27} width={len} height={22} rx={3.5} fill={c.color} />
        <rect x={-len / 2 + 2} y={-27} width={len - 4} height={1.6} rx={0.8} fill="#fff2c4" />
        <rect x={-len / 2 + 1} y={-13} width={len - 2} height={1.6} fill="#d9ae2d" />
        {windows}
        <rect x={len / 2 - 8} y={-24} width={6} height={12} rx={1.5} fill={glass} />
        <rect x={-len / 2 + 2} y={-12} width={7} height={7} rx={1} fill="#c8a128" />
        <Wheel cx={-len / 2 + 11} cy={-3} t={t} moving={moving} />
        <Wheel cx={len / 2 - 12} cy={-3} t={t} moving={moving} />
      </g>
    )
  } else if (c.kind === 'truck') {
    // Caminhão de entregas: baú com a caixinha do commit pintada e a cabine na frente.
    const box = len - 17
    body = (
      <g>
        <rect x={-len / 2} y={-24} width={box} height={19} rx={2} fill={c.color} />
        <rect x={-len / 2 + 1} y={-24} width={box - 2} height={1.6} rx={0.8} fill="#e3e7ec" />
        <rect x={-len / 2 + 9} y={-19} width={12} height={10} rx={1} fill={PAL.cardboard} />
        <rect x={-len / 2 + 9} y={-19} width={12} height={2} rx={1} fill={PAL.cardboardLight} />
        <rect x={-len / 2 + 14} y={-19} width={2} height={10} fill={PAL.cardboardDark} />
        <path d={`M${len / 2 - 17} -19h11q6 0 6 6v8h-17z`} fill={PAL.amber} />
        <path d={`M${len / 2 - 13} -17h7q3 0 3 3v4h-10z`} fill={glass} />
        <Wheel cx={-len / 2 + 10} cy={-3} t={t} moving={moving} />
        <Wheel cx={len / 2 - 11} cy={-3} t={t} moving={moving} />
      </g>
    )
  } else {
    const van = c.kind === 'van'
    const cx = -len / 2 + (van ? 6 : 9)
    const cw = len - (van ? 10 : 19)
    const ch = van ? 12 : 9
    body = (
      <g>
        {/* Cabine: na van ela é alta e reta; no carro, menor e recuada. */}
        <path d={`M${cx} -13V${-13 - ch + 3}q0 -3 3 -3h${cw - (van ? 4 : 8)}q${van ? 1 : 3} 0 ${van ? 1 : 4} ${van ? 1 : 3}l0 ${ch - 3}z`} fill={c.color} />
        <path d={`M${cx + 2} -13.5V${-12 - ch + 2}q0 -1.5 1.5 -1.5h${cw / 2 - 3}V-13.5z`} fill={glass} />
        <path d={`M${cx + cw / 2 + 0.8} -13.5V${-13.5 - ch + 3.5}h${cw / 2 - (van ? 4 : 5)}q${van ? 1 : 1.5} 0 ${van ? 1.2 : 2} ${van ? 1 : 1.5}V-13.5z`} fill={glass} />
        <rect x={-len / 2} y={-15} width={len} height={10.5} rx={3.5} fill={c.color} />
        <rect x={-len / 2 + 3} y={-14.5} width={len - 6} height={1} rx={0.5} fill="#fff" opacity={0.35} />
        <rect x={cx + 3} y={-11.5} width={4} height={1} rx={0.5} fill="#000" opacity={0.3} />
        <Wheel cx={-len / 2 + 10} cy={-3} t={t} moving={moving} />
        <Wheel cx={len / 2 - 10} cy={-3} t={t} moving={moving} />
      </g>
    )
  }
  return (
    <g transform={`translate(${c.x.toFixed(2)} ${y}) scale(${c.dir} 1)`}>
      <ellipse cx={0} cy={0.3} rx={len / 2 - 1} ry={1.4} fill="#000" opacity={0.22} />
      {/* O facho do farol abrindo para a frente, até morrer no asfalto. */}
      {lit && <path d={`M${len / 2} -10.5L${len / 2 + 22} -12V1L${len / 2} -7.5z`} fill="url(#office-headlight)" />}
      {body}
      {lit && (
        <>
          <rect x={len / 2 - 1.5} y={-11} width={2} height={3} rx={0.8} fill="#fff2b0" />
          <rect x={-len / 2 - 0.5} y={-11} width={2} height={3} rx={0.8} fill={PAL.ledRed} />
        </>
      )}
    </g>
  )
}

/** Alguém na calçada, com os pés em `y`: pernas e braço balançando, cabelo, mochila e, na chuva, guarda-chuva. */
function Passerby({ w, y, sky }: { w: Walker; y: number; sky: Sky }) {
  const swing = Math.sin(w.stride * Math.PI * 5) * 22
  const bob = -Math.abs(Math.sin(w.stride * Math.PI * 5)) * 0.8
  return (
    <g transform={`translate(${w.x.toFixed(2)} ${y}) scale(${w.dir} 1)`}>
      <ellipse cx={0} cy={0} rx={3.5} ry={0.8} fill="#000" opacity={0.2} />
      <g transform={`translate(0 ${bob.toFixed(2)})`}>
        <rect x={-1.2} y={-6} width={2.2} height={6} rx={1.1} fill={w.pants} transform={`rotate(${swing.toFixed(1)} 0 -5.5)`} />
        <rect x={-1.2} y={-6} width={2.2} height={6} rx={1.1} fill={w.pants} transform={`rotate(${(-swing).toFixed(1)} 0 -5.5)`} />
        {w.bag && <rect x={-5} y={-10} width={3} height={4.5} rx={1} fill="#6e4229" />}
        <rect x={-2.8} y={-11.5} width={5.6} height={6.5} rx={2} fill={w.shirt} />
        <rect x={-0.8} y={-10.5} width={1.6} height={4.5} rx={0.8} fill={w.shirt} transform={`rotate(${(-swing * 0.8).toFixed(1)} 0 -10)`} style={{ filter: 'brightness(0.85)' }} />
        <circle cx={0.3} cy={-14.2} r={2.6} fill={w.skin} />
        <path d="M-2.3 -14.6a2.6 2.6 0 0 1 5.2 0q-1.5 -1 -3.6 -0.4z" fill={w.hair} />
        <circle cx={1.8} cy={-14.2} r={0.45} fill={PAL.ink} />
        {sky.rain && (
          <g>
            <path d="M0.3 -12v-9" stroke={PAL.ink} strokeWidth={0.6} />
            <path d="M-7 -21a7.3 4 0 0 1 14.6 0z" fill={w.shirt} />
          </g>
        )}
      </g>
    </g>
  )
}

function StreetLife({ street, ground, sky, t }: { street: Street; ground: number; sky: Sky; t: number }) {
  // Quem anda na calçada fica atrás dos carros; a mão de lá, atrás da mão de cá.
  return (
    <g>
      {street.walkers.map((w, i) => (
        <Passerby key={`w${i}`} w={w} y={ground + WALK_H - 1} sky={sky} />
      ))}
      {street.cars.map((c, i) => (c.dir < 0 ? <Vehicle key={`f${i}`} c={c} y={ground + LANE_FAR} sky={sky} t={t} /> : null))}
      {street.cars.map((c, i) => (c.dir > 0 ? <Vehicle key={`n${i}`} c={c} y={ground + LANE_NEAR} sky={sky} t={t} /> : null))}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Prédio vivo: antena, elevadores e as luzinhas de Natal.
// ---------------------------------------------------------------------------

function BuildingLive({ layout: l, sky, t, open }: { layout: Layout; sky: Sky; t: number; open: Map<number, number> }) {
  const { x, y, w } = l.building
  const lights: React.ReactNode[] = []
  if (sky.season === 'natal') {
    const colors = ['#e34948', '#f6c945', '#3ddc84', '#63c7ff']
    for (let i = 0, lx = x - 1; lx < x + w + 2; lx += 5, i++) {
      const on = wave(t, 0.5, i / 3) > 0.35
      lights.push(<circle key={i} cx={lx + 1} cy={y + ROOF_H - 6} r={0.9} fill={on ? colors[i % colors.length] : '#555c66'} />)
    }
  }
  const blink = wave(t, 0.75)
  return (
    <g>
      <circle cx={x + w - 21} cy={y - 15.5} r={1.8} fill="#ff4d4d" opacity={blink} />
      <circle cx={x + w - 21} cy={y - 15.5} r={4} fill="#ff4d4d" opacity={blink * 0.25} />
      {[...open].map(([floor, o]) => (
        <Elevator key={floor} layout={l} floor={floor} open={o} />
      ))}
      {lights}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Áreas: móveis em uso, a luz da sala e o que fica na frente de quem senta.
// ---------------------------------------------------------------------------

function AreaOn({ live, t }: { live: AreaLive; t: number }) {
  const on = (a: Parameters<Occupancy['active']['has']>[0]) => live.occ.active.has(a)
  return (
    <g>
      {on('background') && <Tv on t={t} />}
      {(on('plan') || live.todos) && <Whiteboard on={on('plan')} t={t} todos={live.todos} />}
      {(on('files') || on('compact')) && <Cabinet on t={on('compact') ? t * 2 : t} />}
      {on('web') && <PcDesk on t={t} />}
      {on('edit') && <Workbench on t={t} />}
      {live.papers > 0 && <Papers n={live.papers} />}
      {(on('command') || live.alarm) && <Rack on t={t} alarm={live.alarm} />}
      {live.test !== undefined && <TestLight ok={live.test} />}
      {on('think') && <Coffee on t={t} />}
    </g>
  )
}

/** A luz da sala por cima de tudo (menos dos nomes): âmbar pulsando, apagada ou fechada. */
function AreaMood({ mood, t }: { mood: AreaLive['mood']; t: number }) {
  if (!mood) return null
  const opacity = mood === 'ask' ? 0.07 + 0.05 * Math.sin(t * 4) : mood === 'dark' ? 0.28 : 0.42
  return <rect x={0} y={6} width={AREA_W} height={FLOOR_FRONT - 6} fill={mood === 'ask' ? PAL.amber : '#070914'} opacity={opacity} />
}

function AreaFront({ occ }: { occ: Occupancy }) {
  return (
    <g>
      {occ.chairs.has('web') && <Chair cx={SPOTS.web.x} seatY={SPOTS.web.y - 2} part="back" />}
      {occ.chairs.has('edit') && <Chair cx={SPOTS.edit.x} seatY={SPOTS.edit.y - 2} part="back" />}
      {occ.sofa && <Sofa part="front" />}
    </g>
  )
}

function EffectShape({ e, t }: { e: Effect; t: number }) {
  const p = Math.min(1, (t - e.t0) / e.dur)
  const x = e.x0 + (e.x1 - e.x0) * p
  // Folhas e livros voam em arco, girando; fumaça e gotas vão em linha.
  const arc = e.kind === 'paper' || e.kind === 'book' ? Math.sin(Math.PI * p) * 10 : 0
  const y = e.y0 + (e.y1 - e.y0) * p - arc
  const at = `translate(${x.toFixed(2)} ${y.toFixed(2)})`
  if (e.kind === 'paper') {
    return (
      <g transform={`${at} rotate(${(p * 360).toFixed(0)})`}>
        <rect x={-2} y={-1.5} width={4} height={3} rx={0.4} fill={PAL.white} />
        <rect x={-1.2} y={-0.3} width={2.4} height={0.6} rx={0.3} fill={PAL.metalLight} />
      </g>
    )
  }
  if (e.kind === 'book') {
    return (
      <g transform={`${at} rotate(${(Math.sin(p * Math.PI) * 25).toFixed(0)})`}>
        <rect x={-2.5} y={-2} width={5} height={4} rx={0.6} fill={PAL.books[1]} />
        <rect x={-1.5} y={-1} width={3} height={0.8} rx={0.4} fill={PAL.paper} />
      </g>
    )
  }
  if (e.kind === 'drop') return <path d="M0 -1.6q1 1.4 1 2a1 1 0 0 1 -2 0q0 -0.6 1 -2z" fill="#7fc4f0" transform={at} />
  const s = 1.6 + p * 3
  return (
    <g transform={at} fill={PAL.smoke} opacity={0.7 * (1 - p)}>
      <circle cx={0} cy={0} r={s} />
      <circle cx={3} cy={2} r={s * 0.8} />
      <circle cx={-3} cy={1.5} r={s * 0.7} />
    </g>
  )
}

// ---------------------------------------------------------------------------
// Etiquetas: placa das áreas, nomes e letreiro, em tamanho de tela.
// ---------------------------------------------------------------------------

const probe = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
const widths = new Map<string, number>()

/** Largura do texto em pixels de tela, com a fonte da página (medida uma vez e guardada). */
function measure(text: string, size: number, weight: number, font: string): number {
  const key = `${weight}|${size}|${text}`
  let w = widths.get(key)
  if (w === undefined) {
    if (widths.size > 2000) widths.clear()
    if (probe) probe.font = `${weight} ${size}px ${font}`
    w = probe?.measureText(text).width ?? text.length * size * 0.55
    widths.set(key, w)
  }
  return w
}

function clip(text: string, maxW: number, size: number, weight: number, font: string): string {
  let t = text
  while (t.length > 1 && measure(t, size, weight, font) > maxW) t = `${t.slice(0, -2)}…`
  return t
}

type PillOpts = { text: string; size: number; maxW: number; dot?: string; sub?: string; dim?: boolean }

/** Medidas de uma etiqueta escura arredondada, em pixels de tela; com `sub`, uma segunda linha menor. */
function pillBox(o: PillOpts, font: string) {
  const pad = o.size * 0.55
  const dotW = o.dot ? o.size * 0.9 : 0
  const title = clip(o.text, o.maxW - pad * 2 - dotW, o.size, 600, font)
  let w = measure(title, o.size, 600, font) + dotW
  let sub = ''
  if (o.sub) {
    sub = clip(o.sub, o.maxW - pad * 2, o.size * 0.86, 500, font)
    w = Math.max(w, measure(sub, o.size * 0.86, 500, font))
  }
  return { title, sub, pad, dotW, w: w + pad * 2, h: o.size * (o.sub ? 2.75 : 1.55) }
}

/** A etiqueta com o canto de cima à esquerda em (x, y), no mundo; `k` converte as medidas de tela. */
function Pill({ o, box, x, y, k }: { o: PillOpts; box: ReturnType<typeof pillBox>; x: number; y: number; k: number }) {
  const s = 1 / k
  const line1 = o.size * 0.82
  return (
    <g transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${s.toFixed(4)})`}>
      <rect width={box.w} height={box.h} rx={o.size * 0.6} fill="rgb(16,18,28)" opacity={o.dim ? 0.55 : 0.86} />
      {o.dot && <circle cx={box.pad + o.size * 0.3} cy={line1} r={o.size * 0.28} fill={o.dot} />}
      <text x={box.pad + box.dotW} y={line1} dominantBaseline="central" fontSize={o.size} fontWeight={600} fill={o.dim ? 'rgba(242,244,247,0.6)' : '#f2f4f7'}>
        {box.title}
      </text>
      {box.sub && (
        <text x={box.pad} y={o.size * 1.98} dominantBaseline="central" fontSize={o.size * 0.86} fontWeight={500} fill="rgba(190,198,214,0.95)">
          {box.sub}
        </text>
      )}
    </g>
  )
}

function Labels({ f, font }: { f: Frame; font: string }) {
  const { layout: l, world, k } = f
  const areaOf = new Map(f.placed.map((p) => [p.key, l.area(p.slot)]))
  const items: React.ReactNode[] = []

  for (let s = 0; s < l.floors * l.perFloor; s++) {
    const area = l.area(s)
    const p = f.placed.find((q) => q.slot === s)
    if (!p) {
      const o: PillOpts = { text: 'Área livre', size: 10, maxW: AREA_W * 0.5 * k, dim: true }
      items.push(<Pill key={`a${s}`} o={o} box={pillBox(o, font)} x={area.x + 30} y={area.y + 10} k={k} />)
      continue
    }
    const lead = p.room.workers[0]
    const crew = p.room.workers.length - 1
    const sub = [lead?.detail, projectName(p.room.cwd), crew > 0 && `${crew} ${crew === 1 ? 'funcionário' : 'funcionários'}`].filter(Boolean).join(' · ')
    const o: PillOpts = { text: p.room.title, sub, size: 10.5, maxW: (AREA_W - 40) * k, dot: stateOf(p.room).color }
    items.push(<Pill key={`a${s}`} o={o} box={pillBox(o, font)} x={area.x + 30} y={area.y + 9} k={k} />)
  }

  // Nomes: quem está junto de outro tem a etiqueta empurrada para cima, para não se cobrirem.
  const taken: { x: number; y: number; w: number; h: number }[] = []
  const actors = [...world.actors.values()].sort((a, b) => a.x - b.x)
  for (const a of actors) {
    const o0 = areaOf.get(a.room)
    if (!o0) continue
    const chosen = f.selected === a.key && a.detail
    const o: PillOpts = chosen ? { text: a.detail!, size: 9, maxW: 150 * k } : { text: a.name, size: 9, maxW: 70 * k }
    const box = pillBox(o, font)
    const w = box.w / k
    const h = box.h / k
    const x = o0.x + a.x - w / 2
    // Com balão ao lado da cabeça, a etiqueta sobe acima dele, para não se cobrirem.
    const lift = world.bubbleOf(a, Math.floor(f.t * 12)) ? 12 : 0
    let y = o0.y + headTop(world, a) - 2 - lift + world.bob(a) - h
    while (taken.some((r) => x < r.x + r.w + 1 && r.x < x + w + 1 && Math.abs(r.y - y) < h + 0.5)) y -= h + 1
    taken.push({ x, y, w, h })
    items.push(<Pill key={a.key} o={o} box={box} x={x} y={y} k={k} />)
  }

  const sign = signBox(l)
  const signText = f.closed ? (f.reopen ? `VOLTA ÀS ${f.reopen}` : 'FECHADO') : 'CLAUDE REMOTE'
  const signColor = f.closed || f.warn ? '#f5a623' : f.sky.dark > 0.2 ? '#ffd36b' : '#f2f4f7'
  return (
    <g>
      <text
        x={sign.x + sign.w / 2}
        y={sign.y + sign.h / 2 + 0.3}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={Math.min(sign.h * 0.62, 15 / k)}
        fontWeight={700}
        letterSpacing={0.6}
        fill={signColor}
        style={f.sky.dark > 0.2 ? { filter: `drop-shadow(0 0 1.5px ${signColor})` } : undefined}
      >
        {signText}
      </text>
      {items}
    </g>
  )
}

// ---------------------------------------------------------------------------
// O quadro inteiro.
// ---------------------------------------------------------------------------

/** O que se mexe atrás da cidade (vai entre o céu e o fundo pronto). */
export function LiveSky({ f }: { f: Frame }) {
  return <SkyLife width={f.layout.width} ground={groundOf(f.layout)} sky={f.sky} t={f.world.calm ? 0 : f.t} />
}

/** Tudo o que se mexe na frente da cidade. */
export function LiveFront({ f, font }: { f: Frame; font: string }) {
  const { layout: l, world, sky } = f
  const ground = groundOf(l)
  const still = world.calm ? 0 : f.t
  const areaOf = new Map(f.placed.map((p) => [p.key, l.area(p.slot)]))
  const tick = Math.floor(f.t * 12)

  // As portas do elevador abrem conforme alguém chega perto delas (e fecham quando ele se afasta).
  const elevatorX = l.corridorX + CORRIDOR_W / 2
  const open = new Map<number, number>()
  for (const a of world.actors.values()) {
    const area = areaOf.get(a.room)
    if (!area || a.y >= 99) continue
    const o = Math.max(0, Math.min(1, (20 - Math.abs(area.x + a.x - elevatorX)) / 8))
    if (o > (open.get(area.floor) ?? 0)) open.set(area.floor, o)
  }

  const lives = new Map<string, AreaLive>()
  for (const p of f.placed) {
    const rs = world.rooms.get(p.key)
    const lead = world.actors.get(`${p.key}|lead`)
    const asking = stateOf(p.room).asking
    // Descansando à noite, a luz da área apaga (o claudinho da conversa dorme no sofá).
    const sleeping = lead?.activity === 'idle' && !lead.task && sky.dark > 0.6
    lives.set(p.key, {
      occ: world.occupancy(p.key),
      todos: rs?.todos,
      papers: rs?.papers ?? 0,
      test: rs?.test?.ok,
      alarm: (rs?.alarmUntil ?? 0) > f.t,
      mood: asking ? 'ask' : f.closed ? 'off' : sleeping ? 'dark' : null,
    })
  }

  // De trás para a frente: quem está mais perto cobre quem está atrás (e o encosto cobre quem senta).
  const draws: { y: number; key: string; node: React.ReactNode }[] = []
  for (const p of f.placed) {
    const area = l.area(p.slot)
    draws.push({
      y: area.y + 95.5,
      key: `front-${p.key}`,
      node: (
        <g transform={`translate(${area.x} ${area.y})`}>
          <AreaFront occ={lives.get(p.key)!.occ} />
        </g>
      ),
    })
  }
  for (const a of world.actors.values()) {
    const o = areaOf.get(a.room)
    if (!o) continue
    const walking = a.path.length > 0
    const rs = world.rooms.get(a.room)
    draws.push({
      y: o.y + a.y,
      key: a.key,
      node: (
        <ActorShape
          seed={a.seed}
          x={o.x + a.x}
          y={o.y + a.y}
          pose={{
            facing: a.facing,
            step: walking ? Math.sin(a.stride * Math.PI * 8) : 0,
            bob: (walking ? -Math.abs(Math.sin(a.stride * Math.PI * 8)) * 0.9 : 0) + world.bob(a),
            seated: world.seatOf(a),
            arms: world.arms(a, tick),
            blink: world.time < a.blinkUntil,
            slump: world.slumped(a),
            hat: a.lead ? rs?.family : undefined,
            carry: a.task?.carry && a.arrived === null ? a.task.carry : undefined,
          }}
        />
      ),
    })
  }
  draws.sort((a, b) => a.y - b.y)

  return (
    <g>
      <StreetLife street={f.street} ground={ground} sky={sky} t={still} />
      {sky.rain && <Rain width={l.width} height={l.height} t={still} />}
      <BuildingLive layout={l} sky={sky} t={still} open={open} />
      {f.placed.map((p) => {
        const area = l.area(p.slot)
        return (
          <g key={p.key} transform={`translate(${area.x} ${area.y})`}>
            <AreaOn live={lives.get(p.key)!} t={f.t} />
          </g>
        )
      })}
      {draws.map((d) => (
        <g key={d.key}>{d.node}</g>
      ))}
      {world.effects.map((e, i) => {
        const o = areaOf.get(e.room)
        return o ? (
          <g key={i} transform={`translate(${o.x} ${o.y})`}>
            <EffectShape e={e} t={f.t} />
          </g>
        ) : null
      })}
      {f.placed.map((p) => {
        const area = l.area(p.slot)
        return (
          <g key={`mood-${p.key}`} transform={`translate(${area.x} ${area.y})`}>
            <AreaMood mood={lives.get(p.key)!.mood} t={f.t} />
          </g>
        )
      })}
      {[...world.actors.values()].map((a) => {
        const o = areaOf.get(a.room)
        const kind = o && world.bubbleOf(a, tick)
        // Balão ao lado da cabeça; o nome fica em cima dela.
        return kind ? <Bubble key={`b-${a.key}`} x={o.x + a.x + 12} y={o.y + headTop(world, a) + 4 + world.bob(a)} kind={kind} t={f.t} /> : null
      })}
      <Labels f={f} font={font} />
    </g>
  )
}
