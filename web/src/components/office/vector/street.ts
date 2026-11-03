import { PAL } from './palette'
import type { Sky } from './sky'

/**
 * A rua em frente ao prédio: carros nas duas mãos, ônibus de vez em quando, gente na calçada e,
 * quando a conversa dá push, o caminhão de entregas. Tudo na escala dos claudinhos: quem anda na
 * calçada tem a altura de um deles, e um carro, umas duas vezes e meia isso de comprimento.
 * As medidas saem de `ground`, o topo da calçada (ver GROUND_H em layout.ts).
 */

export type Kind = 'car' | 'van' | 'bus' | 'truck'
export type Car = { kind: Kind; x: number; dir: 1 | -1; speed: number; color: string; stopAt?: number; stopped?: number }
export type Walker = { x: number; dir: 1 | -1; speed: number; shirt: string; pants: string; skin: string; hair: string; stride: number; bag: boolean }

// Cores de carro que se separam do asfalto: cinza-escuro sumiria nele.
const CARS = ['#e34948', '#3f8ae0', '#f6c945', '#25c08a', '#e8e1d0', '#9b86f0', '#eb6834', '#49b6c9']
const SHIRTS = ['#d9534f', '#5bc0de', '#f0ad4e', '#5cb85c', '#9b59b6', '#e87ba4', '#3a3f4a', '#e8e1d0']
const PANTS = ['#3a4a6b', '#2f3b63', '#4a4f58', '#6e4229', '#55607a']
const SKINS = ['#f1c7a5', '#d9a27c', '#a86f4c', '#6e4a33']
const HAIRS = ['#2b2118', '#4a2f1c', '#6b4a2f', '#9a8468', '#c9a227', '#20242c']
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]

/** Comprimento de cada veículo; a altura sai do desenho (ver `vehicle`). */
export const LEN: Record<Kind, number> = { car: 40, van: 46, bus: 74, truck: 54 }

export class Street {
  cars: Car[] = []
  walkers: Walker[] = []
  private nextCar = 2
  private nextWalker = 1
  /** Caminhões pedidos (um por push), saindo um de cada vez. */
  private deliveries = 0

  /** Alguém deu push: o caminhão passa e para na frente do prédio. */
  deliver(): void {
    this.deliveries = Math.min(this.deliveries + 1, 3)
  }

  step(dt: number, width: number, sky: Sky, stopX: number): void {
    const busy = sky.dark > 0.7 ? 0.45 : 1
    this.nextCar -= dt
    if (this.deliveries > 0 && !this.cars.some((c) => c.kind === 'truck')) {
      this.deliveries--
      this.cars.push({ kind: 'truck', x: -LEN.truck, dir: 1, speed: 52, color: PAL.white, stopAt: stopX })
    } else if (this.nextCar <= 0) {
      const dir = Math.random() < 0.5 ? 1 : -1
      const r = Math.random()
      const kind: Kind = r < 0.08 ? 'bus' : r < 0.26 ? 'van' : 'car'
      const len = LEN[kind]
      const x = dir > 0 ? -len : width + len
      // Só entra com a mão livre na entrada: dois carros sobrepostos ficariam um borrão.
      const blocked = this.cars.some((o) => o.dir === dir && Math.abs(o.x - x) < len + LEN[o.kind])
      if (!blocked) {
        this.cars.push({ kind, x, dir, speed: kind === 'bus' ? 42 : kind === 'van' ? 52 : 58 + Math.random() * 26, color: kind === 'bus' ? '#f6c945' : pick(CARS) })
      }
      this.nextCar = (blocked ? 1 : 1.8 + Math.random() * 5) / busy
    }
    this.nextWalker -= dt
    if (this.nextWalker <= 0) {
      const dir = Math.random() < 0.5 ? 1 : -1
      this.walkers.push({
        x: dir > 0 ? -8 : width + 8,
        dir,
        speed: 11 + Math.random() * 7,
        shirt: pick(SHIRTS),
        pants: pick(PANTS),
        skin: pick(SKINS),
        hair: pick(HAIRS),
        stride: Math.random(),
        bag: Math.random() < 0.35,
      })
      this.nextWalker = (3 + Math.random() * 7) / busy
    }
    for (const c of this.cars) {
      if (c.stopAt !== undefined && c.stopped === undefined && c.x >= c.stopAt) c.stopped = 2.5
      if (c.stopped !== undefined && c.stopped > 0) {
        c.stopped -= dt
        continue
      }
      // Quem alcança o da frente na mesma mão vai no ritmo dele, em vez de passar por cima.
      const gap = (o: Car) => (o.x - c.x) * c.dir
      const ahead = this.cars.filter((o) => o !== c && o.dir === c.dir && gap(o) > 0).sort((a, b) => gap(a) - gap(b))[0]
      const close = ahead && gap(ahead) < (LEN[c.kind] + LEN[ahead.kind]) / 2 + 12
      c.x += c.dir * (close ? Math.min(c.speed, ahead.stopped ? 0 : ahead.speed) : c.speed) * dt
    }
    for (const w of this.walkers) {
      w.x += w.dir * w.speed * dt
      w.stride += dt
    }
    const out = (x: number, margin: number) => x > -margin && x < width + margin
    this.cars = this.cars.filter((c) => out(c.x, LEN[c.kind] + 10))
    this.walkers = this.walkers.filter((w) => out(w.x, 12))
  }
}
