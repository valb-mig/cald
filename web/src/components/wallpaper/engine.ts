/**
 * O motor dos fundos animados, adaptado do Claudinho (github.com/Lu1sR0/claudinho, licença MIT, de
 * Luis Roberto). Cada tema desenha a cena em formas vetoriais (traços, elipses, degradês) numa camada
 * pequena, com algumas amostras por célula; cada célula da grade tira a média das amostras dela e vira
 * um caractere — mais denso onde a cena tem mais tinta. Nas cenas de massa (`tiles`), a célula vira
 * um ladrilho arredondado na cor da cena, com o caractere por cima. Por cima de tudo, o ponteiro: as
 * células perto dele acendem e ele deixa um rastro que apaga devagar.
 */

import type { ThemeId } from '@/lib/wallpaper'

export type RGB = [number, number, number]

/** O ponteiro sobre a cena, em pixels de CSS, e a velocidade dele em px/s. */
export type Pointer = { x: number; y: number; speed: number }

/** O que o tema recebe a cada quadro. */
export type Env = {
  W: number
  H: number
  /** Segundos desde que a cena nasceu, e desde o quadro anterior. */
  t: number
  dt: number
  /** Tamanho da célula em pixels de CSS. */
  cw: number
  ch: number
  /** Escala da cena: 1 na tela cheia; menor numa miniatura, para caber o mesmo desenho. */
  k: number
  mouse: Pointer | null
  /** 0 a 1: quão perto o ponteiro está do ponto, até `R` pixels. */
  near(x: number, y: number, R?: number): number
}

export type Look = {
  /** A cor de fundo, em CSS. */
  backdrop: string
  /** A cor dos caracteres (`glyphs`) e do brilho do ponteiro. */
  ink: RGB
  /** Opacidade do caractere na célula mais fraca e na mais forte. */
  alpha: [number, number]
  /** Linhas da grade, em CSS; sem elas, a grade não aparece. */
  grid?: string
}

/** Uma cena viva: nasce com os sorteios dela e desenha a cada quadro. */
export type Instance = {
  /** O fundo, direto na tela, antes dos caracteres. */
  bg?(ctx: CanvasRenderingContext2D, env: Env): void
  /** A cena em formas, na camada que vira grade. */
  scene(g: CanvasRenderingContext2D, env: Env): void
}

export type Theme = {
  id: Exclude<ThemeId, 'none'>
  name: string
  hint: string
  /** Célula em pixels de CSS na tela cheia. */
  cell: { w: number; h: number }
  /** Os caracteres, do mais fraco ao mais forte. */
  ramp: string
  /** `glyphs`: só o caractere, na tinta do tema; `tiles`: ladrilho na cor da cena, com o caractere por cima. */
  style: 'glyphs' | 'tiles'
  /** Quadros por segundo: cena lenta não ganha nada com mais. */
  fps: number
  /**
   * Se a conversa põe o véu (cor do fundo com desfoque) entre a cena e o texto. Cena cheia e colorida
   * precisa dele para o texto ler; caracteres finos e discretos somem no desfoque, e dispensam.
   */
  veil: boolean
  look(dark: boolean): Look
  create(env: Pick<Env, 'W' | 'H' | 'k'>, dark: boolean): Instance
}

const clamp = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v)

/** Ruído estável: as mesmas entradas dão sempre o mesmo número entre 0 e 1. */
export const hash = (a: number, b: number, c = 0) => {
  const h = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453
  return h - Math.floor(h)
}

export const between = (min: number, max: number) => min + Math.random() * (max - min)

// Amostras por lado da célula: 3 × 3 já dá a borda suave sem pesar no getImageData.
const SS = 3
// Quantos níveis de opacidade o caractere tem: agrupar por nível troca o estilo do pincel poucas vezes por quadro.
const LEVELS = 12

export class Renderer {
  private ctx: CanvasRenderingContext2D
  private oc = document.createElement('canvas')
  private ox: CanvasRenderingContext2D
  private instance: Instance | null = null
  private look: Look
  private trail = new Float32Array(0)
  private level = new Int8Array(0)
  private chars = new Int8Array(0)
  W = 0
  H = 0
  cols = 0
  rows = 0
  cw: number
  ch: number
  k = 1
  private dpr = 1

  private canvas: HTMLCanvasElement
  private theme: Theme
  private dark: boolean
  private zoom: number

  /** `zoom` multiplica a célula; abaixo de 1 cabe mais cena numa miniatura. */
  constructor(canvas: HTMLCanvasElement, theme: Theme, dark: boolean, zoom = 1) {
    this.canvas = canvas
    this.theme = theme
    this.dark = dark
    this.zoom = zoom
    this.ctx = canvas.getContext('2d')!
    this.ox = this.oc.getContext('2d', { willReadFrequently: true })!
    this.look = theme.look(dark)
    this.cw = theme.cell.w * zoom
    this.ch = theme.cell.h * zoom
  }

  resize(W: number, H: number, dpr: number): void {
    this.W = W
    this.H = H
    this.dpr = dpr
    this.canvas.width = Math.round(W * dpr)
    this.canvas.height = Math.round(H * dpr)
    this.cols = Math.ceil(W / this.cw)
    this.rows = Math.ceil(H / this.ch)
    this.oc.width = this.cols * SS
    this.oc.height = this.rows * SS
    const n = this.cols * this.rows
    this.trail = new Float32Array(n)
    this.level = new Int8Array(n)
    this.chars = new Int8Array(n)
    // A escala acompanha a célula: a miniatura tem células menores e o mesmo desenho, só que menor.
    this.k = this.zoom * Math.max(1, Math.min(W, H) / 900)
    this.instance = this.theme.create({ W, H, k: this.k }, this.dark)
  }

  /** O ponteiro passou por aqui: acende as células em volta, que apagam devagar. */
  mark(x: number, y: number): void {
    const ci = Math.floor(x / this.cw)
    const cj = Math.floor(y / this.ch)
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const i = ci + di
        const j = cj + dj
        if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) continue
        const k = j * this.cols + i
        this.trail[k] = Math.max(this.trail[k], 1 - (Math.abs(di) + Math.abs(dj)) * 0.3)
      }
  }

  /** A cena na camada pequena; devolve, por célula, a cor média e quanto dela tem tinta. */
  private sample(draw: (g: CanvasRenderingContext2D) => void): Float32Array {
    const { cols, rows, cw, ch, ox, oc } = this
    ox.setTransform(1, 0, 0, 1, 0, 0)
    ox.clearRect(0, 0, oc.width, oc.height)
    ox.globalCompositeOperation = 'source-over'
    ox.globalAlpha = 1
    ox.setTransform(SS / cw, 0, 0, SS / ch, 0, 0)
    draw(ox)
    const d = ox.getImageData(0, 0, oc.width, oc.height).data
    const out = new Float32Array(cols * rows * 4)
    const rw = oc.width * 4
    const n = SS * SS
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        let r = 0
        let g = 0
        let b = 0
        let a = 0
        for (let v = 0; v < SS; v++)
          for (let u = 0, p = (j * SS + v) * rw + i * SS * 4; u < SS; u++, p += 4) {
            const al = d[p + 3]
            r += d[p] * al
            g += d[p + 1] * al
            b += d[p + 2] * al
            a += al
          }
        const o = (j * cols + i) * 4
        if (a > 0) {
          out[o] = r / a
          out[o + 1] = g / a
          out[o + 2] = b / a
          out[o + 3] = a / (255 * n)
        }
      }
    return out
  }

  frame(t: number, dt: number, mouse: Pointer | null): void {
    const { ctx, cw, ch, cols, rows, W, H, look, theme, instance } = this
    if (!instance || !cols || !rows) return
    const env: Env = {
      W,
      H,
      t,
      dt,
      cw,
      ch,
      k: this.k,
      mouse,
      near: (x, y, R = 220) => (mouse ? clamp(1 - Math.hypot(x - mouse.x, y - mouse.y) / R) : 0),
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.fillStyle = look.backdrop
    ctx.fillRect(0, 0, W, H)
    instance.bg?.(ctx, env)
    if (look.grid) {
      ctx.fillStyle = look.grid
      for (let x = 0; x < W; x += cw) ctx.fillRect(x, 0, 1, H)
      for (let y = 0; y < H; y += ch) ctx.fillRect(0, y, W, 1)
    }

    const L = this.sample((g) => instance.scene(g, env))
    const lantern = mouse ? 150 * Math.max(this.zoom, 0.5) : 0
    const ramp = theme.ramp
    const top = ramp.length - 1
    // O caractere troca de vez em quando, sozinho: é o que dá a cintilação de ASCII.
    const slot = Math.floor(t * 1.5)
    const fade = Math.pow(0.05, dt)

    ctx.font = `600 ${Math.round(ch * 0.7)}px 'Cascadia Code Variable', ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    if (theme.style === 'glyphs') {
      // Primeiro decide o nível e o caractere de cada célula; depois pinta nível por nível.
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const k = j * cols + i
          const a = L[k * 4 + 3]
          const cx = i * cw + cw / 2
          const cy = j * ch + ch / 2
          const near = lantern ? clamp(1 - Math.hypot(cx - mouse!.x, cy - mouse!.y) / lantern) : 0
          const tr = (this.trail[k] *= fade)
          const lit = Math.max(near * near * 0.45, tr * 0.5)
          const v = a > 0.04 ? clamp(a + lit * 0.6) : lit * 0.7
          if (v < 0.05) {
            this.level[k] = -1
            continue
          }
          const flick = hash(i, j, slot)
          this.chars[k] = clamp(Math.floor(v * top + (flick - 0.5) * 1.1), 0, top)
          this.level[k] = Math.min(LEVELS - 1, Math.floor(v * LEVELS))
        }
      const [lo, hi] = look.alpha
      const [r, g, b] = look.ink
      for (let lv = 0; lv < LEVELS; lv++) {
        ctx.fillStyle = `rgba(${r},${g},${b},${lo + ((hi - lo) * (lv + 0.5)) / LEVELS})`
        for (let k = 0; k < cols * rows; k++) {
          if (this.level[k] !== lv) continue
          const i = k % cols
          const j = (k - i) / cols
          ctx.fillText(ramp[this.chars[k]], i * cw + cw / 2, j * ch + ch / 2 + 1)
        }
      }
      return
    }

    // Ladrilhos: a célula ganha a cor média da cena, e o caractere vai por cima, um tom contrastante.
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i
        const o = k * 4
        const a = L[o + 3]
        if (a < 0.2) continue
        const x = i * cw
        const y = j * ch
        const c = `rgb(${L[o] | 0},${L[o + 1] | 0},${L[o + 2] | 0})`
        const s = a < 0.5 ? 0.45 + a * 0.5 : 1
        ctx.globalAlpha = a < 0.5 ? clamp(a * 1.8) : 1
        ctx.fillStyle = c
        ctx.beginPath()
        ctx.roundRect(x + cw / 2 - ((cw - 3) * s) / 2, y + ch / 2 - ((ch - 3) * s) / 2, (cw - 3) * s, (ch - 3) * s, 3)
        ctx.fill()
        ctx.globalAlpha = 1
        if (a < 0.5) continue
        const l = (0.299 * L[o] + 0.587 * L[o + 1] + 0.114 * L[o + 2]) / 255
        const flick = hash(i, j, slot)
        ctx.fillStyle = l < 0.45 ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'
        ctx.fillText(ramp[clamp(Math.floor(1 + l * (top - 2) + flick * 2), 0, top)], x + cw / 2, y + ch / 2 + 1)
      }
  }
}
