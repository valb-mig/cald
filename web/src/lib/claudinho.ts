import { create } from 'zustand'
/**
 * O claudinho de cada conversa: um bichinho de forma simples, cantos arredondados, numa cor, com dois
 * olhinhos brancos, e um nome de duas sílabas. Os dois saem do id da conversa, sempre os mesmos para
 * ela — no celular e no PC, sem guardar nada. O que muda de um para outro: a forma, a cor, o jeito dos
 * olhos (a expressão), o tamanho e a distância entre eles e, em alguns, uma leve inclinação. O nome
 * pode ser trocado (fica no PC, ver `claudinhoName` no catálogo); a aparência, não.
 */

export type Shape = 'square' | 'wide' | 'circle' | 'tall' | 'hex' | 'drop' | 'arch'
export type Eyes = 'oval' | 'dot' | 'big' | 'happy' | 'sleepy' | 'focused' | 'wink'

export type Look = {
  shape: Shape
  color: string
  eyes: Eyes
  /** Escala dos olhos (1 = o tamanho normal). */
  eyeScale: number
  /** Distância entre o centro dos dois olhos, no desenho de 32 × 32. */
  gap: number
  /** Altura do centro dos olhos, no mesmo desenho. */
  eyeY: number
  /** Inclinação do corpo, em graus. */
  tilt: number
}

/** Cores vivas, que seguram o branco dos olhos e aparecem bem no claro e no escuro. */
const COLORS = ['#2fc677', '#ff4fa3', '#8b5cf6', '#ff5a5a', '#f5a524', '#3aa8ff', '#14b8a6', '#ff7a3d', '#6366f1', '#d946ef']

const SHAPES: Shape[] = ['square', 'wide', 'circle', 'tall', 'hex', 'drop', 'arch']
const EYES: Eyes[] = ['oval', 'oval', 'dot', 'big', 'happy', 'sleepy', 'focused', 'wink']

/** Onde ficam os olhos em cada forma: a altura e a distância máxima entre eles. */
const FACE: Record<Shape, { y: number; gap: number }> = {
  square: { y: 15, gap: 9 },
  wide: { y: 16, gap: 11 },
  circle: { y: 15, gap: 9 },
  tall: { y: 13, gap: 8 },
  hex: { y: 15.5, gap: 9 },
  drop: { y: 19.5, gap: 9 },
  arch: { y: 15, gap: 9 },
}

/** FNV-1a: o id vira um número, sempre o mesmo. */
function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Mulberry32: uma sequência de sorteios a partir do número do id. */
function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const cache = new Map<string, Look>()

export function lookOf(seed: string): Look {
  const hit = cache.get(seed)
  if (hit) return hit
  const next = random(hash(seed))
  const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)]!
  const shape = pick(SHAPES)
  const face = FACE[shape]
  const eyeScale = 0.85 + next() * 0.3
  const look: Look = {
    shape,
    color: pick(COLORS),
    eyes: pick(EYES),
    eyeScale,
    // Nunca tão perto que os dois olhos (ou os dois arcos do sorriso) se encostem.
    gap: Math.max(face.gap - next() * 2.5, 8.2 * eyeScale),
    eyeY: face.y + (next() - 0.5) * 1.5,
    // Um em cada três inclina um pouco, para lado nenhum ficar igual.
    tilt: next() < 0.33 ? (next() - 0.5) * 16 : 0,
  }
  cache.set(seed, look)
  return look
}

/** Um número de 0 a 1 do id, para o que não faz parte da aparência (o atraso da piscada, por exemplo). */
export const phaseOf = (seed: string) => (hash(`${seed}:fase`) % 1000) / 1000

/**
 * Nomes de duas sílabas, escolhidos à mão: juntar sílabas ao acaso faz nome bonito, mas de vez em
 * quando também faz palavrão.
 */
const NAMES = [
  'Vita', 'Cloe', 'Malu', 'Nina', 'Theo', 'Iris', 'Bia', 'Duda', 'Nico', 'Tito', 'Lila', 'Lulu', 'Mimi', 'Juju',
  'Kiko', 'Bento', 'Caio', 'Davi', 'Gael', 'Ivo', 'Joca', 'Leo', 'Luca', 'Lino', 'Mila', 'Nara', 'Noa', 'Pipa',
  'Pipo', 'Rafa', 'Remi', 'Rita', 'Sami', 'Sara', 'Tati', 'Teca', 'Tobi', 'Vini', 'Yuri', 'Zeca', 'Zoe', 'Zuza',
  'Cacau', 'Dora', 'Edu', 'Fifi', 'Gabi', 'Guto', 'Bubi', 'Jade', 'Juca', 'Kika', 'Lola', 'Mabel', 'Nilo', 'Nuno',
  'Otto', 'Paco', 'Pepe', 'Rubi', 'Sofi', 'Yago', 'Zara', 'Yoshi', 'Momo', 'Nemo', 'Lumi', 'Nami', 'Taro', 'Hana',
  'Koda', 'Suki', 'Miko', 'Riko', 'Tofu', 'Pingo', 'Bingo', 'Dengo', 'Pudim', 'Mochi', 'Caju', 'Kiwi', 'Figo',
  'Lupi', 'Dudu', 'Neno', 'Tuca', 'Babi', 'Didi', 'Gigi', 'Lelo', 'Mano', 'Nana', 'Vivi', 'Nino', 'Tilo', 'Vavá',
  'Zico', 'Lori', 'Bolo', 'Biju', 'Chico', 'Dino', 'Faro', 'Kuma', 'Lalo', 'Mira', 'Tina', 'Ozzy', 'Pita', 'Tuti',
]

/** O nome sorteado do claudinho da conversa. */
export const nameOf = (seed: string) => NAMES[hash(`${seed}:nome`) % NAMES.length]!

/**
 * De onde vem o claudinho de cada conversa que continua outra (o /clear dá um id novo à mesma conversa):
 * o id que ele veste. Vem do PC (ver server/src/meta.ts), no catálogo e no aviso de id novo.
 */
export const useLooks = create<Record<string, string>>(() => ({}))

/** O id cujo claudinho a conversa veste: o herdado, ou o dela mesma. */
export const seedOf = (id: string) => useLooks.getState()[id] ?? id

/** O nome do claudinho: o que você deu, ou o sorteado (pelo claudinho que ela veste). */
export const claudinhoName = (id: string, custom?: string) => custom || nameOf(seedOf(id))
