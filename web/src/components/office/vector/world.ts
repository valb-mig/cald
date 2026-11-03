import type { CatalogState, OfficeActivity, OfficeEvent, OfficeTodos, OfficeWorker } from '@/lib/types'
import { LANE_Y, PILE, REST_SPOTS, familyOf, spotFor, stationOf, type BubbleKind, type Carry, type Facing, type Family, type Occupancy, type Spot } from './layout'

type Point = { x: number; y: number }

// Pixels do mundo por segundo: atravessar a sala leva uns 4 s.
const SPEED = 58
const ELEVATOR_Y = 96
// O servidor responde a cada 2,5 s: sem um tempo mínimo na estação, quem troca rápido de ferramenta só anda.
const MIN_DWELL = 1.6
const rand = (a: number, b: number) => a + Math.random() * (b - a)

/** Ida temporária a outro lugar: levar a caixa do commit ao elevador, entregar a pasta ao claudinho da conversa. */
type Task = { kind: 'errand' | 'deliver'; spot: Spot; stay: number; carry?: Carry }

/** Jeitos de descansar; `near` são os que valem com algo rodando em segundo plano (não se afasta). */
export type RestKind = 'sofa' | 'nap' | 'window' | 'plant' | 'shelf' | 'board' | 'coffee' | 'stretch' | 'cooler' | 'chat'
type Rest = { kind: RestKind; until: number; mate?: string }
const RESTS: { kind: RestKind; weight: number; uses?: OfficeActivity; stay: [number, number]; near?: boolean }[] = [
  { kind: 'sofa', weight: 3, stay: [14, 28], near: true },
  { kind: 'window', weight: 3, stay: [10, 20], near: true },
  { kind: 'coffee', weight: 3, uses: 'think', stay: [8, 16], near: true },
  { kind: 'chat', weight: 3, stay: [12, 22] },
  { kind: 'nap', weight: 2, stay: [16, 30] },
  { kind: 'shelf', weight: 2, uses: 'files', stay: [10, 18] },
  { kind: 'plant', weight: 2, stay: [7, 12] },
  { kind: 'cooler', weight: 2, stay: [7, 14] },
  { kind: 'board', weight: 1, uses: 'plan', stay: [7, 12] },
  { kind: 'stretch', weight: 1, stay: [3, 5], near: true },
]
const restOf = (kind: RestKind) => RESTS.find((r) => r.kind === kind)

export type Actor = {
  key: string
  room: string
  name: string
  lead: boolean
  /** De onde sai o claudinho dele (ver lib/claudinho.ts): o da conversa, ou um sorteado para o subagente. */
  seed: string
  activity: OfficeActivity
  detail?: string
  /** Estação e posição nela (o n-ésimo), que ficam enquanto a atividade não muda. */
  station: string
  slot: number
  /** Lugar da atividade, como o servidor manda; descansando, `work` é o lugar do descanso. */
  base: Spot
  work: Spot
  /** Como ele está descansando agora (só quando a conversa está parada). */
  rest?: Rest
  task?: Task
  /** Posição dos pés, dentro da área. */
  x: number
  y: number
  path: Point[]
  facing: Facing
  /** Indo embora pelo elevador (o subagente terminou). */
  leaving: boolean
  /** Onde fica o elevador do andar, em coordenadas da área (no corredor, fora dela). */
  entry: number
  speed: number
  /** Fase do passo, para as perninhas alternarem. */
  stride: number
  /** Quando chegou ao lugar atual (`null` andando) e se o lugar mudou desde então. */
  arrived: number | null
  dirty: boolean
  urgent: boolean
  // Gestos: piscar, olhar para a tela, rajadas de digitação, andar pensando, folga, cutucão, balões.
  blinkAt: number
  blinkUntil: number
  nextLook: number
  lookUntil: number
  typing: boolean
  typingSwitch: number
  phase: number
  nextPace: number
  paceOff: number
  jumpAt: number
  emote?: { kind: BubbleKind; until: number }
}

/** O que a área guarda entre um quadro e outro: pilha de papéis, semáforo, alarme, tarefas, chapéu. */
export type RoomState = {
  papers: number
  test?: { ok: boolean; until: number }
  alarmUntil: number
  todos?: OfficeTodos
  family?: Family
  entryX: number
  askX: number
  coolerX: number
  seen: Set<string>
  state?: CatalogState
  leadActivity?: OfficeActivity
  nextTidy: number
}

export type Effect = {
  kind: 'paper' | 'book' | 'smoke' | 'drop'
  room: string
  x0: number
  y0: number
  x1: number
  y1: number
  t0: number
  dur: number
  done?: () => void
}

export type RoomInput = {
  key: string
  workers: OfficeWorker[]
  events: OfficeEvent[]
  todos?: OfficeTodos
  model?: string
  state: CatalogState
  /** O claudinho da conversa (o que ela veste) e o nome dele. */
  seed: string
  leadName: string
  entryX: number
  askX: number
  coolerX: number
}

/** Os claudinhos de todas as áreas: saem do elevador, andam até a estação e voltam a ele quando terminam. */
export class World {
  readonly actors = new Map<string, Actor>()
  readonly rooms = new Map<string, RoomState>()
  effects: Effect[] = []
  /** Segundos desde que a salinha abriu. */
  time = 0
  /** `prefers-reduced-motion`: sem folga, sem andar pensando, sem olhar em volta. */
  calm = false
  /** Alguém deu push (o caminhão passa na rua). */
  onPush?: () => void

  sync(rooms: RoomInput[]): void {
    const present = new Set<string>()
    const roomKeys = new Set(rooms.map((r) => r.key))
    for (const key of [...this.rooms.keys()]) if (!roomKeys.has(key)) this.rooms.delete(key)

    for (const room of rooms) {
      let rs = this.rooms.get(room.key)
      const fresh = !rs
      rs ??= { papers: 0, alarmUntil: 0, seen: new Set(), entryX: 0, askX: 0, coolerX: 0, nextTidy: 0 }
      this.rooms.set(room.key, rs)
      Object.assign(rs, { entryX: room.entryX, askX: room.askX, coolerX: room.coolerX, todos: room.todos, family: familyOf(room.model) })

      // Lugares: quem continua na mesma estação mantém a posição nela; os outros pegam a primeira livre.
      const taken = new Map<string, Set<number>>()
      const take = (station: string, slot: number) => {
        const set = taken.get(station) ?? new Set<number>()
        set.add(slot)
        taken.set(station, set)
      }
      const keyOf = (w: OfficeWorker) => `${room.key}|${w.id}`
      for (const w of room.workers) {
        const a = this.actors.get(keyOf(w))
        if (a && !a.leaving && a.station === stationOf(w.activity)) take(a.station, a.slot)
      }

      for (const w of room.workers) {
        const key = keyOf(w)
        present.add(key)
        const station = stationOf(w.activity)
        let a = this.actors.get(key)
        let slot = a && !a.leaving && a.station === station ? a.slot : -1
        if (slot < 0) {
          slot = 0
          while (taken.get(station)?.has(slot)) slot++
          take(station, slot)
        }
        const base = spotFor(w.activity, slot, room.askX)
        const lead = w.role === 'gestor'
        const name = lead ? room.leadName : w.name
        if (!a) {
          a = {
            key,
            room: room.key,
            name,
            lead,
            seed: lead ? room.seed : `${room.seed}:${w.id}`,
            activity: w.activity,
            station,
            slot,
            base,
            work: base,
            x: room.entryX,
            y: ELEVATOR_Y,
            path: [],
            facing: 'front',
            leaving: false,
            entry: room.entryX,
            speed: SPEED * (w.role === 'Explore' ? 1.2 : 1) * rand(0.9, 1.1),
            stride: 0,
            arrived: null,
            dirty: true,
            urgent: true,
            blinkAt: this.time + rand(1, 4),
            blinkUntil: 0,
            nextLook: this.time + rand(6, 16),
            lookUntil: 0,
            typing: true,
            typingSwitch: this.time + rand(0.5, 2),
            phase: Math.floor(rand(0, 2)),
            nextPace: this.time + rand(2, 4),
            paceOff: 0,
            jumpAt: -10,
          }
          this.actors.set(key, a)
        }
        a.entry = room.entryX
        a.name = name
        if (lead) a.seed = room.seed
        a.detail = w.detail
        const changed = a.leaving || a.activity !== w.activity || a.base.x !== base.x || a.base.y !== base.y
        if (changed) {
          // Voltou ao trabalho (ou pedem você): larga o descanso e vai já para a estação.
          if (w.activity === 'ask' || a.leaving) {
            a.task = undefined
            a.urgent = true
          }
          a.activity = w.activity
          a.station = station
          a.slot = slot
          a.base = base
          a.work = base
          a.rest = undefined
          a.leaving = false
          a.paceOff = 0
          a.dirty = true
        }
      }

      this.react(room, rs, fresh)
    }

    for (const a of [...this.actors.values()]) {
      // A conversa fechou: a área some do mapa, e quem estava nela também.
      if (!roomKeys.has(a.room)) this.actors.delete(a.key)
      else if (!present.has(a.key) && !a.leaving) this.leave(a)
    }
  }

  /** O subagente terminou: leva a pasta até o claudinho da conversa e sai pelo elevador. */
  private leave(a: Actor): void {
    a.leaving = true
    a.urgent = true
    a.dirty = true
    a.task = undefined
    const lead = [...this.actors.values()].find((b) => b.room === a.room && b.lead && !b.leaving)
    if (lead && !this.calm) {
      const side = lead.work.x > a.x ? -16 : 16
      a.task = { kind: 'deliver', spot: { x: lead.work.x + side, y: LANE_Y - 1, facing: side < 0 ? 'right' : 'left' }, stay: 1.2, carry: 'folder' }
    }
  }

  /** Eventos novos da conversa viram animação; mudanças de estado viram balão no claudinho da conversa. */
  private react(room: RoomInput, rs: RoomState, fresh: boolean): void {
    const lead = this.actors.get(`${room.key}|lead`)
    const leadActivity = room.workers[0]?.activity
    if (!fresh && lead) {
      // Turno acabou: ✓; você respondeu o pedido: ✓ também.
      if (rs.state === 'running' && (room.state === 'idle' || room.state === 'stopped')) this.emote(lead, 'check', 2.5)
      if (rs.leadActivity === 'ask' && leadActivity !== 'ask') this.emote(lead, 'check', 2)
    }
    rs.state = room.state
    rs.leadActivity = leadActivity

    for (const e of room.events) {
      if (rs.seen.has(e.id)) continue
      rs.seen.add(e.id)
      // Ao abrir a salinha, o que já tinha acontecido não é animado de novo.
      if (fresh) continue
      const a = this.actors.get(`${room.key}|${e.worker}`) ?? lead
      if (!a) continue
      const hands = { x: a.x, y: a.y - 12 }
      switch (e.kind) {
        case 'edit':
          this.effects.push({
            kind: 'paper',
            room: room.key,
            x0: hands.x,
            y0: hands.y,
            x1: PILE.x,
            y1: PILE.y - rs.papers,
            t0: this.time,
            dur: 0.7,
            done: () => (rs.papers = Math.min(rs.papers + 1, 9)),
          })
          break
        case 'error':
          this.smoke(room.key, a.x, a.y - 22)
          this.emote(a, 'error', 2.2)
          if (a.station === 'command') rs.alarmUntil = this.time + 2.5
          break
        case 'test-pass':
        case 'test-fail': {
          const ok = e.kind === 'test-pass'
          rs.test = { ok, until: this.time + 8 }
          this.emote(a, ok ? 'check' : 'error', 2.5)
          if (!ok) this.smoke(room.key, 178, 30)
          break
        }
        case 'commit':
          if (!a.leaving && a.activity !== 'ask') {
            a.task = { kind: 'errand', spot: { x: rs.entryX, y: ELEVATOR_Y, facing: 'back' }, stay: 0.7, carry: 'box' }
            a.urgent = true
            a.dirty = true
          }
          break
        case 'push':
          this.onPush?.()
          this.emote(a, 'check', 2)
          break
        case 'skill':
          this.effects.push({ kind: 'book', room: room.key, x0: 38, y0: 18, x1: hands.x, y1: hands.y - 4, t0: this.time, dur: 0.8, done: () => this.emote(a, 'bulb', 2) })
          break
      }
    }
    // Ids de 30 s atrás não voltam mais: a lista não cresce sem fim.
    if (rs.seen.size > 300) rs.seen = new Set(room.events.map((e) => e.id))
  }

  private emote(a: Actor, kind: BubbleKind, seconds: number): void {
    a.emote = { kind, until: this.time + seconds }
  }

  private smoke(room: string, x: number, y: number): void {
    this.effects.push({ kind: 'smoke', room, x0: x, y0: y, x1: x + rand(-3, 3), y1: y - 14, t0: this.time, dur: 1.6 })
  }

  /**
   * Escolhe (e troca) o jeito de descansar. Dois não ocupam o mesmo canto, menos o sofá, que cabe
   * dois, e a conversa, que precisa de alguém livre para o par.
   */
  private rest(a: Actor, rs: RoomState, t: number): void {
    const mates = [...this.actors.values()].filter((b) => b.room === a.room && b.key !== a.key && !b.leaving)
    const busy = new Set(mates.flatMap((b) => (b.rest ? [b.rest.kind] : [])))
    const sofas = mates.filter((b) => b.rest?.kind === 'sofa').length
    const free = mates.filter((b) => (b.activity === 'idle' || b.activity === 'background') && !b.rest?.mate && !b.task && !b.path.length)
    const list = RESTS.filter((r) => {
      if (a.activity === 'background' && !r.near) return false
      // Repetir o mesmo seria ficar parado: a troca tem que aparecer.
      if (r.kind === a.rest?.kind) return false
      if (r.kind === 'sofa') return sofas < 2
      if (r.kind === 'chat') return free.length > 0
      return !busy.has(r.kind)
    })
    if (!list.length) return
    let n = Math.random() * list.reduce((sum, r) => sum + r.weight, 0)
    const choice = list.find((r) => (n -= r.weight) <= 0) ?? list[0]
    const kind = choice.kind
    const until = t + rand(...choice.stay)
    const sit = (b: Actor, kind: RestKind, spot: Spot, mate?: string) => {
      b.rest = { kind, until, mate }
      b.work = spot
      b.dirty = true
      b.urgent = true
    }
    if (kind === 'chat') {
      // Os dois se encontram no meio da sala e ficam de frente um para o outro.
      const other = free[Math.floor(Math.random() * free.length)]
      sit(a, 'chat', REST_SPOTS.chatLeft, other.key)
      sit(other, 'chat', REST_SPOTS.chatRight, a.key)
      return
    }
    if (kind === 'cooler') return sit(a, 'cooler', { x: rs.coolerX, y: 97, facing: 'back' })
    if (kind === 'sofa') return sit(a, 'sofa', sofas === 0 ? REST_SPOTS.sofa : REST_SPOTS.sofaEnd)
    sit(a, kind, REST_SPOTS[kind])
  }

  /** Tocaram no claudinho: ele pula e manda um coração. */
  poke(key: string): void {
    const a = this.actors.get(key)
    if (!a) return
    a.jumpAt = this.time
    this.emote(a, 'heart', 1.6)
  }

  /** Onde o claudinho quer estar agora: a tarefa da vez, o elevador (indo embora) ou a estação. */
  target(a: Actor): Spot {
    if (a.task) return a.task.spot
    if (a.leaving) return { x: a.entry, y: ELEVATOR_Y, facing: 'back' }
    return a.work
  }

  /** Parado no lugar e sentado nele (cadeira ou sofá). */
  seatOf(a: Actor): Spot['seated'] {
    return a.path.length || a.arrived === null ? undefined : this.target(a).seated
  }

  step(dt: number): void {
    this.time += dt
    const t = this.time
    for (const a of [...this.actors.values()]) {
      const rs = this.rooms.get(a.room)
      // Troca de lugar: na hora, se está andando ou é urgente; parado, só depois de um tempo na estação.
      if (a.dirty && (a.urgent || a.arrived === null || t - a.arrived >= MIN_DWELL)) {
        a.path = route(a, this.target(a), LANE_Y - Math.floor(rand(0, 3)))
        a.arrived = null
        a.dirty = false
        a.urgent = false
      }
      let budget = a.speed * dt
      while (budget > 0 && a.path.length) {
        const p = a.path[0]
        const dx = p.x - a.x
        const dy = p.y - a.y
        const dist = Math.hypot(dx, dy)
        a.facing = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'front' : 'back'
        if (dist <= budget) {
          a.x = p.x
          a.y = p.y
          a.path.shift()
          budget -= dist
        } else {
          a.x += (dx / dist) * budget
          a.y += (dy / dist) * budget
          budget = 0
        }
      }
      a.stride += dt
      if (a.path.length) continue
      const here = this.target(a)
      if (a.arrived === null) {
        a.arrived = t
        a.facing = here.facing
        // A pasta chegou: o claudinho da conversa agradece.
        if (a.task?.kind === 'deliver') {
          const lead = this.actors.get(`${a.room}|lead`)
          if (lead) this.emote(lead, 'check', 1.5)
        }
      }

      if (a.task) {
        if (t - a.arrived >= a.task.stay) {
          a.task = undefined
          a.dirty = true
          a.urgent = true
        }
        continue
      }
      if (a.leaving) {
        this.actors.delete(a.key)
        continue
      }

      // Gestos de quem está na estação.
      if (t > a.blinkAt) {
        a.blinkUntil = t + 0.14
        a.blinkAt = t + rand(2, 6)
      }
      if (t > a.typingSwitch) {
        a.typing = !a.typing
        a.typingSwitch = t + (a.typing ? rand(0.8, 2.5) : rand(0.3, 1.2))
      }
      if (this.calm) continue
      const standing = !here.seated
      if (standing && here.facing === 'back' && t > a.nextLook) {
        a.lookUntil = t + rand(1, 2)
        a.nextLook = t + rand(8, 22)
      }
      a.facing = t < a.lookUntil ? 'front' : here.facing
      // Pensando: anda de lá para cá entre o café e o rack.
      if (a.activity === 'think' && t > a.nextPace) {
        a.paceOff = a.paceOff ? 0 : -14
        a.path = [{ x: a.work.x + a.paceOff, y: a.work.y }]
        a.nextPace = t + rand(2.5, 5.5)
        a.arrived = null
      }
      // Compactando: as folhas voam para o gaveteiro.
      if (a.activity === 'compact' && Math.random() < dt * 2) {
        this.effects.push({ kind: 'paper', room: a.room, x0: a.x, y0: a.y - 12, x1: 40, y1: 52, t0: t, dur: 0.5 })
      }
      // Regando a planta: as gotinhas caem enquanto ele está lá.
      if (a.rest?.kind === 'plant' && Math.random() < dt * 3) {
        this.effects.push({ kind: 'drop', room: a.room, x0: a.x - 9, y0: a.y - 12, x1: a.x - 11, y1: a.y - 2, t0: t, dur: 0.5 })
      }
      // Parado: descansa de um jeito por um tempo e depois troca (sofá, cochilo, janela, café, conversa…).
      if (rs && (a.activity === 'idle' || a.activity === 'background')) {
        const mate = a.rest?.mate ? this.actors.get(a.rest.mate) : undefined
        // O parceiro da conversa foi trabalhar: não dá para conversar sozinho.
        if (a.rest?.mate && mate?.rest?.mate !== a.key) a.rest = undefined
        if (!a.rest || t > a.rest.until) this.rest(a, rs, t)
      }
    }

    for (const rs of this.rooms.values()) {
      if (rs.test && t > rs.test.until) rs.test = undefined
      // Sem ninguém editando, a pilha de papéis vai sendo arquivada aos poucos.
      if (rs.papers > 0 && rs.leadActivity !== 'edit' && t > rs.nextTidy) {
        rs.nextTidy = t + 25
        if (rs.leadActivity === 'idle') rs.papers--
      }
    }
    this.effects = this.effects.filter((e) => {
      if (t - e.t0 < e.dur) return true
      e.done?.()
      return false
    })
  }

  /** Algo se mexendo: andando, pulando ou com efeito no ar (a salinha desenha mais quadros). */
  get busy(): boolean {
    if (this.effects.length) return true
    for (const a of this.actors.values()) if (a.path.length || this.time - a.jumpAt < 0.7) return true
    return false
  }

  /** Altura do pulo do cutucão (dois pulinhos) e do "pede você" (um pulinho de vez em quando). */
  bob(a: Actor): number {
    const j = this.time - a.jumpAt
    if (j < 0.6) return -Math.abs(Math.sin((j / 0.6) * Math.PI * 2)) * 5
    if (a.activity === 'ask' && !a.path.length && !this.calm) {
      const p = (this.time + a.phase) % 1.4
      return p < 0.3 ? -Math.sin((p / 0.3) * Math.PI) * 2.5 : 0
    }
    return 0
  }

  /** Bracinhos para cima: apontando no quadro, digitando em rajadas, se espreguiçando. */
  arms(a: Actor, tick: number): boolean {
    if (a.path.length) return false
    const spot = this.target(a)
    if (!spot.arms) return false
    if (a.rest) return a.rest.kind === 'stretch' ? tick % 8 < 5 : tick % 4 < 2
    if (a.activity === 'plan') return true
    return a.typing && (tick + a.phase) % 2 === 0
  }

  /** Dormindo com a cabeça caída (no cochilo da cadeira). */
  slumped(a: Actor): boolean {
    return !a.path.length && a.arrived !== null && Boolean(this.target(a).slump)
  }

  /** O que vai no balão: o do momento (✓, !?, coração) ou o do que ele faz (pensando, dormindo, conversando). */
  bubbleOf(a: Actor, tick: number): BubbleKind | null {
    if (a.emote && this.time < a.emote.until) return a.emote.kind
    if (a.path.length || a.leaving || a.task) return null
    if (a.activity === 'think') return 'dots'
    if (a.activity === 'ask') return 'alert'
    if (a.rest) {
      // Conversando, um fala enquanto o outro escuta; no sofá e no cochilo, dorme de vez em quando.
      if (a.rest.kind === 'chat') return Math.floor(this.time / 2.2) % 2 === a.phase ? 'dots' : null
      if (a.rest.kind === 'sofa' || a.rest.kind === 'nap') return tick % 40 < 26 ? 'sleep' : null
      return null
    }
    if (a.activity === 'idle' && tick % 40 < 26) return 'sleep'
    return null
  }

  /** Quem já chegou acende o móvel; sentados escondem as pernas atrás da cadeira ou do sofá. */
  occupancy(room: string): Occupancy {
    const occ: Occupancy = { active: new Set(), chairs: new Set(), sofa: false }
    for (const a of this.actors.values()) {
      if (a.room !== room || a.path.length || a.leaving || a.arrived === null) continue
      if (a.task) continue
      // Descansando, quem acende o móvel é o lugar (café, estante, quadro), não a atividade.
      const uses = a.rest ? restOf(a.rest.kind)?.uses : a.activity
      if (uses) occ.active.add(uses)
      if (a.work.seated === 'chair' && a.work.chair) occ.chairs.add(a.work.chair)
      if (a.work.seated === 'sofa') occ.sofa = true
    }
    return occ
  }
}

/** Sai até a faixa da frente do chão, anda por ela e entra no lugar: ninguém atravessa os móveis. */
function route(from: Point, to: Point, lane: number): Point[] {
  const pts = [{ x: from.x, y: lane }, { x: to.x, y: lane }, to]
  const out: Point[] = []
  let last = from
  for (const p of pts) {
    if (Math.abs(p.x - last.x) < 0.5 && Math.abs(p.y - last.y) < 0.5) continue
    out.push(p)
    last = p
  }
  return out
}

