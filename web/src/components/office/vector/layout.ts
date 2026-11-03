import type { OfficeActivity, OfficeTodos } from '@/lib/types'

export type Facing = 'front' | 'back' | 'left' | 'right'
/** O que o claudinho leva nas mãos. */
export type Carry = 'folder' | 'box' | 'book'
export type BubbleKind = 'dots' | 'alert' | 'sleep' | 'check' | 'error' | 'heart' | 'bulb'
/** Família do modelo, pelo nome (ex.: "claude-opus-5-5", "sonnet"): define o chapéu do claudinho da conversa. */
export type Family = 'fable' | 'opus' | 'sonnet' | 'haiku'
export const familyOf = (model?: string): Family | undefined => /fable|opus|sonnet|haiku/i.exec(model ?? '')?.[0].toLowerCase() as Family | undefined

/**
 * A planta do escritório em corte: cada andar tem áreas (uma por conversa, separadas por divisórias
 * de cubículo) e o corredor com o elevador; o prédio fica numa cidade, com o céu da hora do dia.
 * Medidas em unidades do mundo (o viewBox do SVG); o desenho fica nos .tsx ao lado.
 */
export const AREA_W = 256
export const FLOOR_H = 112
export const CORRIDOR_W = 72
/** Paredes de fora do prédio. */
const WALL_W = 10
/** Telhado (mureta, letreiro, caixa d'água, antena) e céu acima dele. */
export const ROOF_H = 30
const SKY_H = 36
/**
 * Calçada e rua embaixo do prédio, na mesma escala dos claudinhos: quem anda na calçada tem a
 * altura de um deles, e um carro tem umas duas vezes e meia isso de comprimento.
 */
export const GROUND_H = 56
/** A partir do topo da calçada: altura dela, e onde as rodas de cada mão da rua tocam o asfalto. */
export const WALK_H = 10
export const LANE_FAR = 32
export const LANE_NEAR = 54
/** Linha onde a parede encontra o chão; o chão vai daqui até FLOOR_FRONT. */
export const FLOOR_BACK = 84
export const FLOOR_FRONT = 102
/** Faixa da frente do chão por onde se anda (pelo corredor também). */
export const LANE_Y = 100

type Seat = 'chair' | 'sofa'
/** `chair`: qual cadeira ele ocupa (o encosto passa a ser desenhado na frente); `slump`: caído, dormindo. */
export type Spot = { x: number; y: number; facing: Facing; seated?: Seat; arms?: boolean; chair?: 'web' | 'edit'; slump?: boolean }

/** Estação de cada atividade: compactar a conversa é no gaveteiro, como ler arquivos. */
export type Station = Exclude<OfficeActivity, 'ask' | 'compact' | 'background'>
export const stationOf = (a: OfficeActivity): Station | 'ask' =>
  a === 'compact' ? 'files' : a === 'background' ? 'idle' : a

/** Onde cada claudinho fica (os pés) em cada estação da área. `ask` é no corredor (ver layout). */
export const SPOTS: Record<Station, Spot> = {
  files: { x: 39, y: 94, facing: 'back' },
  web: { x: 71, y: 95, facing: 'back', seated: 'chair', chair: 'web', arms: true },
  edit: { x: 111, y: 95, facing: 'back', seated: 'chair', chair: 'edit', arms: true },
  plan: { x: 149, y: 92, facing: 'back', arms: true },
  command: { x: 177, y: 95, facing: 'back', arms: true },
  think: { x: 197, y: 96, facing: 'back' },
  idle: { x: 222, y: 88, facing: 'front', seated: 'sofa' },
}

/**
 * O n-ésimo na mesma estação: ao lado (e, sem cadeira sobrando, de pé atrás de quem está sentado).
 * Quem pede você sai da área e espera no corredor (`askX`), virado para a tela.
 */
export function spotFor(activity: OfficeActivity, n: number, askX: number): Spot {
  const station = stationOf(activity)
  if (station === 'ask') return { x: askX + (askX > AREA_W / 2 ? 1 : -1) * n * 16, y: 97, facing: 'front' }
  const s = SPOTS[station]
  if (n === 0) return s
  if (s.seated === 'sofa' && n === 1) return { ...s, x: s.x + 18 }
  const side = n % 2 === 1 ? 1 : -1
  const dx = side * Math.ceil(n / 2) * 18
  return { x: s.x + dx, y: Math.min(LANE_Y, s.y + 3), facing: s.facing, arms: s.arms && !s.seated }
}

/**
 * Os jeitos de descansar: o sofá (que cabe dois), um cochilo na cadeira da bancada, a janela, a
 * planta para regar, a estante, o café, o quadro, uma espreguiçada e o dois a dois da conversa.
 * O bebedouro fica no corredor, e por isso o x dele vem do andar (ver world.ts).
 */
export const REST_SPOTS = {
  sofa: { x: 222, y: 88, facing: 'front', seated: 'sofa' },
  sofaEnd: { x: 240, y: 88, facing: 'front', seated: 'sofa' },
  nap: { x: 111, y: 95, facing: 'back', seated: 'chair', chair: 'edit', slump: true },
  window: { x: 112, y: 89, facing: 'back' },
  plant: { x: 27, y: 96, facing: 'left' },
  shelf: { x: 40, y: 95, facing: 'back' },
  board: { x: 149, y: 93, facing: 'back', arms: true },
  coffee: { x: 197, y: 96, facing: 'back' },
  stretch: { x: 232, y: 97, facing: 'front', arms: true },
  chatLeft: { x: 178, y: 99, facing: 'right' },
  chatRight: { x: 197, y: 99, facing: 'left' },
} satisfies Record<string, Spot>

// ---------------------------------------------------------------------------
// Planta: andares de baixo para cima; com espaço, área | corredor | área; no estreito, corredor | área.
// ---------------------------------------------------------------------------

export type Area = { x: number; y: number; floor: number; side: 'left' | 'right' }

export type Layout = {
  perFloor: 1 | 2
  floors: number
  width: number
  height: number
  building: { x: number; y: number; w: number; h: number }
  /** Topo do andar `floor` (0 é o térreo). */
  floorTop: (floor: number) => number
  corridorX: number
  area: (slot: number) => Area
  /** Elevador, lugar de espera e bebedouro no corredor, em coordenadas da área (fora dela). */
  entryX: (side: Area['side']) => number
  askX: (side: Area['side']) => number
  coolerX: (side: Area['side']) => number
}

/** Largura do prédio (sem a cidade em volta). */
export const buildingWidth = (perFloor: 1 | 2) => (perFloor === 2 ? AREA_W * 2 + CORRIDOR_W : CORRIDOR_W + AREA_W) + WALL_W * 2

/** `side`: quanto de cidade aparece de cada lado do prédio. */
export function layoutFor(slots: number, perFloor: 1 | 2, side: number): Layout {
  const floors = Math.max(1, Math.ceil(slots / perFloor))
  const bw = buildingWidth(perFloor)
  const bx = side
  const by = SKY_H
  const bh = ROOF_H + floors * FLOOR_H
  const corridorX = bx + WALL_W + (perFloor === 2 ? AREA_W : 0)
  const floorTop = (floor: number) => by + ROOF_H + (floors - 1 - floor) * FLOOR_H
  return {
    perFloor,
    floors,
    width: bw + side * 2,
    height: by + bh + GROUND_H,
    building: { x: bx, y: by, w: bw, h: bh },
    floorTop,
    corridorX,
    area: (slot) => {
      const floor = Math.floor(slot / perFloor)
      const left = perFloor === 2 && slot % 2 === 0
      return { x: left ? bx + WALL_W : corridorX + CORRIDOR_W, y: floorTop(floor), floor, side: left ? 'left' : 'right' }
    },
    entryX: (s) => (s === 'left' ? AREA_W + CORRIDOR_W / 2 : -CORRIDOR_W / 2),
    askX: (s) => (s === 'left' ? AREA_W + 14 : -14),
    coolerX: (s) => (s === 'left' ? AREA_W + 11 : -CORRIDOR_W + 11),
  }
}

/** Letreiro do telhado. */
export function signBox(l: Layout): { x: number; y: number; w: number; h: number } {
  const w = Math.min(150, l.building.w - 80)
  return { x: l.building.x + (l.building.w - w) / 2, y: l.building.y + 2, w, h: 17 }
}

/** Onde o caminhão de entregas para: na frente do prédio. */
export const deliveryX = (l: Layout) => l.building.x + l.building.w / 2

/** Topo da calçada. */
export const groundOf = (l: Layout) => l.height - GROUND_H

/** Onde as folhas editadas pousam: a pilha ao lado do notebook (ver world.ts). */
export const PILE = { x: 120 + 3, y: FLOOR_BACK - 18 }

export type Occupancy = { active: Set<OfficeActivity>; chairs: Set<'web' | 'edit'>; sofa: boolean }

/** O que a área mostra além dos móveis: tarefas no quadro, papéis na bancada, testes e a luz da sala. */
export type AreaLive = {
  occ: Occupancy
  todos?: OfficeTodos
  /** Folhas na pilha da bancada (uma por arquivo editado). */
  papers: number
  /** Resultado do último teste, enquanto o semáforo fica aceso. */
  test?: boolean
  /** Comando com erro: o rack pisca vermelho. */
  alarm: boolean
  /** Âmbar pulsando (pede você), luz apagada (descansando à noite) ou fora do expediente (limite do plano). */
  mood: 'ask' | 'dark' | 'off' | null
}
