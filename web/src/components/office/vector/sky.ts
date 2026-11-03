/**
 * O céu da salinha segue o relógio: as cores passam devagar de uma hora para outra, o sol e a lua
 * cruzam o céu, e às vezes chove. Datas comemorativas enfeitam a cidade.
 */

export type Season = 'halloween' | 'junina' | 'natal' | null

export type Sky = {
  top: string
  bottom: string
  far: string
  near: string
  lit: string
  /** 0 de dia, 1 de noite: quanto escuro está (janelas acesas, luminárias, estrelas). */
  dark: number
  night: boolean
  dusk: boolean
  /** O céu visto de uma janela do prédio, lá em cima: mais perto do topo que do horizonte. */
  pane: [string, string]
  rain: boolean
  season: Season
  /** Hora com fração (14,5 = 14h30). */
  hour: number
  /** Muda a cada 5 minutos ou quando o tempo vira: o fundo pronto é refeito só então. */
  key: string
}

type Stop = { h: number; top: string; bottom: string; far: string; near: string }
const NIGHT = { top: '#0b1430', bottom: '#253463', far: '#1d2747', near: '#121a31' }
const STOPS: Stop[] = [
  { h: 0, ...NIGHT },
  { h: 4.5, ...NIGHT },
  { h: 5.75, top: '#5b5fb5', bottom: '#ffb37a', far: '#8b6f92', near: '#5e4c6e' },
  { h: 7, top: '#7cc4f5', bottom: '#ffe2b8', far: '#a9bfd3', near: '#8aa0b8' },
  { h: 12, top: '#6ec6ff', bottom: '#cdeeff', far: '#a8c4d8', near: '#86a4bc' },
  { h: 16.5, top: '#78b6ec', bottom: '#ffd9a0', far: '#a6b4c8', near: '#8496ad' },
  { h: 18, top: '#4b4fa5', bottom: '#ff9e6b', far: '#7d6188', near: '#574565' },
  { h: 19.5, ...NIGHT },
  { h: 24, ...NIGHT },
]

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
const mix = (a: string, b: string, t: number) => {
  const ca = rgb(a)
  const cb = rgb(b)
  return hex(ca.map((v, i) => v + (cb[i] - v) * t))
}

/** Gerador repetível: a cidade é sempre a mesma, só a luz muda. */
export function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

/** Número de 0 a 1 que só depende do texto: o mesmo dia e hora dão sempre a mesma chuva. */
function hashed(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return ((h >>> 0) % 10_000) / 10_000
}

function seasonOf(d: Date): Season {
  const m = d.getMonth() + 1
  const day = d.getDate()
  if ((m === 10 && day >= 15) || (m === 11 && day <= 2)) return 'halloween'
  if (m === 6 || (m === 7 && day <= 15)) return 'junina'
  if (m === 12 || (m === 1 && day <= 6)) return 'natal'
  return null
}

/** `forceRain`: para ver a chuva sem esperar por ela (`/salinha?chuva`). */
export function skyAt(d: Date, forceRain = false): Sky {
  const hour = d.getHours() + d.getMinutes() / 60
  const i = STOPS.findIndex((s) => s.h > hour)
  const a = STOPS[i - 1]
  const b = STOPS[i]
  const t = (hour - a.h) / (b.h - a.h)
  // Chove em uma de cada nove horas, sempre as mesmas para o mesmo dia.
  const rain = forceRain || hashed(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`) < 0.11
  const grey = (c: string) => (rain ? mix(c, '#6c7480', 0.45) : c)
  const dark = hour < 4.5 || hour >= 19.5 ? 1 : hour < 7 ? 1 - (hour - 4.5) / 2.5 : hour >= 17 ? (hour - 17) / 2.5 : 0
  const top = grey(mix(a.top, b.top, t))
  const bottom = grey(mix(a.bottom, b.bottom, t))
  return {
    top,
    bottom,
    pane: [mix(top, bottom, 0.15), mix(top, bottom, 0.45)],
    far: grey(mix(a.far, b.far, t)),
    near: grey(mix(a.near, b.near, t)),
    lit: dark > 0.7 ? '#ffd36b' : '#ffd88a',
    dark,
    night: dark > 0.7,
    dusk: dark > 0.2 && dark <= 0.7,
    rain,
    season: seasonOf(d),
    hour,
    key: `${Math.floor((d.getHours() * 60 + d.getMinutes()) / 5)}|${rain ? 1 : 0}|${seasonOf(d)}`,
  }
}

export { mix }
