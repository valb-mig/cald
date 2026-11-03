import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import { Pending } from '@/components/home/now'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { claudinhoName, useLooks } from '@/lib/claudinho'
import { projectName } from '@/lib/format'
import { useWidth } from '@/lib/hooks'
import { HOME } from '@/lib/machines'
import { useStore } from '@/lib/store'
import type { CatalogEntry, OfficeRoom } from '@/lib/types'
import { headTop } from './actor'
import { CityBack, SkyBack } from './backdrop'
import { AREA_W, FLOOR_H, ROOF_H, buildingWidth, deliveryX, layoutFor, type Layout } from './layout'
import { LiveFront, LiveSky, stateOf, type Frame, type Placed } from './live'
import { skyAt, type Sky } from './sky'
import { Street } from './street'
import { World } from './world'

/** Cada conversa fica na área em que apareceu; a de quem fechou vira vaga para a próxima. */
class Slots {
  private readonly bySession = new Map<string, number>()

  assign(rooms: OfficeRoom[]): Placed[] {
    const keys = new Set(rooms.map(keyOf))
    for (const k of [...this.bySession.keys()]) if (!keys.has(k)) this.bySession.delete(k)
    const used = new Set(this.bySession.values())
    return rooms.map((room) => {
      const key = keyOf(room)
      let slot = this.bySession.get(key)
      if (slot === undefined) {
        slot = 0
        while (used.has(slot)) slot++
        used.add(slot)
        this.bySession.set(key, slot)
      }
      return { room, key, slot }
    })
  }
}

const keyOf = (r: OfficeRoom) => `${r.machine ?? HOME}|${r.sessionId}`

// Pixels de tela (CSS) por unidade do mundo: com duas áreas por andar abaixo disso os claudinhos ficam
// miúdos, e o prédio passa a ter uma área por andar; acima do máximo, o prédio vira outdoor.
const MIN_CSS = 1.2
const MAX_CSS = 3.5
// Quadros por segundo: as posições são contínuas, então 30 já anda liso; parado (ninguém andando nem
// nada no ar), o bastante para luzes, nuvens e a rua. A salinha fica de fundo por horas, num tablet.
const FPS = 30
const FPS_STILL = 20
const FPS_CALM = 4

// Cidade de cada lado do prédio: no mínimo um respiro, no máximo o que cabe sem virar paisagem.
const MIN_SIDE = 6
const MAX_SIDE = 60

/** Duas áreas por andar se couberem legíveis; senão uma. A cidade em volta preenche o resto da largura. */
function fit(width: number, slots: number): { layout: Layout; scale: number } {
  for (const perFloor of [2, 1] as const) {
    const bw = buildingWidth(perFloor)
    const scale = Math.min(width / (bw + MIN_SIDE * 2), MAX_CSS)
    if (scale < MIN_CSS && perFloor === 2) continue
    const side = Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.floor((width / scale - bw) / 2)))
    return { layout: layoutFor(slots, perFloor, side), scale }
  }
  return { layout: layoutFor(slots, 1, MIN_SIDE), scale: 1 }
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * O escritório em SVG: um prédio numa cidade, cada andar com áreas (uma por conversa aberta) dos
 * lados do corredor. Os claudinhos (os mesmos dos avatares das conversas) saem do elevador e vão até a
 * estação do que estão fazendo. Tocar num claudinho mostra o que ele faz (e ele pula); tocar na área
 * abre a conversa, ou os pedidos dela, se estiver pedindo você.
 */
export function VectorOffice({ rooms, clock }: { rooms: OfficeRoom[]; clock?: { hour?: number; rain?: boolean } }) {
  const box = useRef<HTMLDivElement>(null)
  const width = useWidth(box)
  const [, navigate] = useLocation()
  const [street] = useState(() => new Street())
  const [world] = useState(() => {
    const w = new World()
    w.calm = reducedMotion()
    w.onPush = () => street.deliver()
    return w
  })
  const [slots] = useState(() => new Slots())
  const placed = useMemo(() => slots.assign(rooms), [slots, rooms])
  const total = Math.max(1, ...placed.map((p) => p.slot + 1))
  const { layout, scale } = useMemo(() => fit(width, total), [width, total])
  const fiveHour = useStore((s) => s.usages[HOME]?.plan?.fiveHour)
  const catalog = useStore((s) => s.catalog)
  // O claudinho que cada conversa veste (as que continuam outra herdam o de lá).
  const looks = useLooks()
  const [askingId, setAskingId] = useState<string | null>(null)
  const asking = askingId ? placed.find((p) => p.room.sessionId === askingId)?.room : undefined
  // Respondido (aqui ou em outro lugar): a folha dos pedidos fecha sozinha.
  if (askingId && !(asking && stateOf(asking).asking)) setAskingId(null)
  const [font] = useState(() => (typeof document === 'undefined' ? 'sans-serif' : getComputedStyle(document.body).fontFamily))

  /** Claudinho tocado há pouco: mostra o que ele faz no lugar do nome. */
  const [chosen, setChosen] = useState<{ key: string; until: number }>()

  useEffect(() => {
    const names = new Map(catalog.map((c) => [c.sessionId, c.claudinhoName]))
    world.sync(
      placed.map((p) => {
        const side = layout.area(p.slot).side
        const id = p.room.sessionId
        return {
          key: p.key,
          workers: p.room.workers,
          events: p.room.events ?? [],
          todos: p.room.todos,
          model: p.room.model,
          state: p.room.state,
          seed: looks[id] ?? id,
          leadName: claudinhoName(id, names.get(id)),
          entryX: layout.entryX(side),
          askX: layout.askX(side),
          coolerX: layout.coolerX(side),
        }
      }),
    )
  }, [world, placed, layout, catalog, looks])

  // Quem passa a pedir você: a salinha rola até a área dele, se estiver fora da tela.
  const svg = useRef<SVGSVGElement>(null)
  const askingKeys = useRef(new Set<string>())
  useEffect(() => {
    const now = new Set(placed.filter((p) => stateOf(p.room).asking).map((p) => p.key))
    const fresh = placed.find((p) => now.has(p.key) && !askingKeys.current.has(p.key))
    askingKeys.current = now
    const el = svg.current
    const scroller = el?.closest('main')
    if (!fresh || !el || !scroller) return
    const r = el.getBoundingClientRect()
    const k = r.height / layout.height
    const area = layout.area(fresh.slot)
    const top = r.top + area.y * k
    const bottom = top + FLOOR_H * k
    const view = scroller.getBoundingClientRect()
    if (top >= view.top && bottom <= view.bottom) return
    scroller.scrollBy({ top: (top + bottom) / 2 - (view.top + view.bottom) / 2, behavior: 'smooth' })
  }, [placed, layout])

  // O céu muda devagar: um novo só quando a luz (ou o tempo) vira, para o fundo pronto não ser refeito à toa.
  // Hora pedida na URL (`?hora=21`): o relógio anda a partir dela.
  const hour = clock?.hour
  const offset = useMemo(() => (hour === undefined ? 0 : (hour - new Date().getHours()) * 3_600_000), [hour])
  const [sky, setSky] = useState<Sky>(() => skyAt(new Date(Date.now() + offset), clock?.rain))
  useEffect(() => {
    const check = () => setSky((old) => {
      const next = skyAt(new Date(Date.now() + offset), clock?.rain)
      return next.key === old.key ? old : next
    })
    check()
    const timer = setInterval(check, 10_000)
    return () => clearInterval(timer)
  }, [offset, clock?.rain])

  // O laço: anda o mundo e a rua e pede um quadro novo.
  const [, setTick] = useState(0)
  const skyRef = useRef(sky)
  useEffect(() => {
    skyRef.current = sky
  }, [sky])
  useEffect(() => {
    if (!width) return
    let last = performance.now()
    let drawn = 0
    let raf = 0
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const fps = world.calm ? (world.busy ? FPS_STILL : FPS_CALM) : world.busy ? FPS : FPS_STILL
      if (now - drawn < 1000 / fps - 2) return
      drawn = now
      const dt = Math.min((now - last) / 1000, 0.5)
      last = now
      world.step(dt)
      if (!world.calm) street.step(dt, layout.width, skyRef.current, deliveryX(layout))
      setTick((n) => (n + 1) % 1_000_000)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [world, street, layout, width])

  const used = fiveHour?.utilization ?? 0
  const reset = fiveHour?.resetsAt ? new Date(fiveHour.resetsAt) : undefined
  const frame: Frame = {
    layout,
    placed,
    world,
    street,
    sky,
    t: world.time,
    k: scale,
    closed: used >= 100,
    reopen: reset && !Number.isNaN(reset.getTime()) ? reset.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : undefined,
    warn: used >= 90,
    selected: chosen && chosen.until > world.time ? chosen.key : undefined,
  }
  const occupied = useMemo(() => placed.map((p) => p.slot).sort((a, b) => a - b).join(','), [placed])
  const b = layout.building
  const hole = { x: b.x - 3, y: b.y + ROOF_H - 6, w: b.w + 6, h: b.h }

  /** O claudinho ou a área sob o dedo, em unidades do mundo. */
  const hit = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const wx = ((e.clientX - r.left) / r.width) * layout.width
    const wy = ((e.clientY - r.top) / r.height) * layout.height
    const areaOf = new Map(placed.map((p) => [p.key, layout.area(p.slot)]))
    let actor: string | undefined
    let front = -Infinity
    for (const a of world.actors.values()) {
      const o = areaOf.get(a.room)
      if (!o || a.leaving) continue
      const x = o.x + a.x
      const y = o.y + a.y
      if (Math.abs(wx - x) <= 10 && wy >= o.y + headTop(world, a) - 3 && wy <= y + 2 && y > front) {
        actor = a.key
        front = y
      }
    }
    const room = placed.find((p) => {
      const a = layout.area(p.slot)
      return wx >= a.x && wx < a.x + AREA_W && wy >= a.y && wy < a.y + FLOOR_H
    })
    return { actor, room }
  }

  const entryOf = (room: OfficeRoom): CatalogEntry =>
    catalog.find((c) => c.sessionId === room.sessionId) ?? {
      sessionId: room.sessionId,
      title: room.title,
      cwd: room.cwd,
      state: room.state,
      owner: room.owner,
      lastModified: 0,
      machine: room.machine,
    }

  return (
    <div ref={box} className="flex w-full justify-center">
      {width > 0 && (
        <svg
          ref={svg}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width * scale}
          height={layout.height * scale}
          role="img"
          aria-label={`Escritório com ${rooms.length} ${rooms.length === 1 ? 'área' : 'áreas'}: ${rooms.map((r) => `${r.title} (${stateOf(r).label})`).join(', ')}`}
          className="block select-none"
          onClick={(e) => {
            const { actor, room } = hit(e)
            if (actor) {
              world.poke(actor)
              setChosen({ key: actor, until: world.time + 5 })
              return
            }
            if (!room || room.room.sessionId.startsWith('demo-')) return
            // Pedindo você numa conversa do painel: os pedidos abrem aqui mesmo, para responder sem sair.
            if (stateOf(room.room).asking && room.room.owner === 'panel') setAskingId(room.room.sessionId)
            else navigate(`/s/${room.room.sessionId}`)
          }}
          onMouseMove={(e) => {
            const { actor, room } = hit(e)
            e.currentTarget.style.cursor = actor || room ? 'pointer' : 'default'
          }}
        >
          <defs>
            <clipPath id="office-rain-hole">
              <path clipRule="evenodd" d={`M0 0H${layout.width}V${layout.height}H0z M${hole.x} ${hole.y}v${hole.h}h${hole.w}v${-hole.h}z`} />
            </clipPath>
          </defs>
          <SkyBack layout={layout} sky={sky} />
          <LiveSky f={frame} />
          <CityBack layout={layout} sky={sky} occupied={occupied} />
          <LiveFront f={frame} font={font} />
        </svg>
      )}
      <Sheet open={Boolean(asking)} onOpenChange={(o) => !o && setAskingId(null)}>
        <SheetContent side="bottom" className="max-h-[85dvh] gap-0 overflow-y-auto pb-[max(1rem,env(safe-area-inset-bottom))]">
          <SheetHeader>
            <SheetTitle>Pedindo você</SheetTitle>
            <SheetDescription>{asking ? `${asking.title} · ${projectName(asking.cwd)}` : ''}</SheetDescription>
          </SheetHeader>
          {asking && (
            <div className="px-4">
              <Pending s={entryOf(asking)} />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
