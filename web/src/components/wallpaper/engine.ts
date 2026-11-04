/**
 * O motor dos fundos animados, adaptado do Claudinho (github.com/Lu1sR0/claudinho, licença MIT, de
 * Luis Roberto). Cada tema desenha a cena em formas vetoriais (traços, elipses, degradês) numa camada
 * pequena, com algumas amostras por célula; cada célula da grade tira a média das amostras dela e vira
 * um caractere — mais denso onde a cena tem mais tinta. Nas cenas de massa (`tiles`), a célula vira
 * um ladrilho arredondado na cor da cena, com o caractere por cima. Por cima de tudo, o ponteiro: as
 * células perto dele acendem e ele deixa um rastro que apaga devagar.
 *
 * Roda na página ou num worker (ver scene-worker.ts): nada aqui depende do `document`, a não ser o
 * atlas dos caracteres, que precisa das fontes da página.
 */

import type { ThemeId } from '@/lib/wallpaper'

export type RGB = [number, number, number]

/** O contexto 2D de um canvas da página ou de um OffscreenCanvas (no worker do fundo). */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
type Surface = HTMLCanvasElement | OffscreenCanvas

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
  bg?(ctx: Ctx2D, env: Env): void
  /** A cena em formas, na camada que vira grade. */
  scene(g: Ctx2D, env: Env): void
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
  /**
   * A cena não muda com o tempo nem com o ponteiro (uma imagem parada): a grade lê ela uma vez por
   * tamanho, e o quadro só se refaz quando algo muda na tela — o caractere troca, o ponteiro anda, o
   * rastro apaga. Parada e sem mouse por perto, quase não gasta.
   */
  still?: boolean
  /** Tema de imagem: a imagem já em tinta, para o worker montar o mesmo tema do lado dele. */
  picture?: HTMLCanvasElement | ImageBitmap
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
// Quantos níveis de opacidade o caractere tem: cada nível é uma linha do atlas.
const LEVELS = 12

/** Canvas fora da tela: OffscreenCanvas onde houver (o worker não tem `document`). */
const surface = (w: number, h: number): Surface =>
  typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h })

/** A fonte do caractere numa célula de `ch` pixels de altura. */
export const glyphFont = (ch: number) => `600 ${Math.round(ch * 0.7)}px 'Cascadia Code Variable', ui-monospace, monospace`

/**
 * Os caracteres do tema já pintados, um retângulo por caractere (colunas) e nível de opacidade
 * (linhas), cada um do tamanho da célula em pixels da tela. Copiar um retângulo por célula sai bem
 * mais barato que um `fillText`, que monta o texto de novo a cada chamada: eram milhares por quadro.
 * Fica na página, que tem as fontes; o worker recebe pronto.
 */
export function glyphAtlas(theme: Theme, dark: boolean, zoom: number, dpr: number): HTMLCanvasElement {
  const cw = theme.cell.w * zoom
  const ch = theme.cell.h * zoom
  const gw = Math.ceil(cw * dpr)
  const gh = Math.ceil(ch * dpr)
  const { ink, alpha } = theme.look(dark)
  const [lo, hi] = alpha
  const canvas = Object.assign(document.createElement('canvas'), { width: theme.ramp.length * gw, height: LEVELS * gh })
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.font = glyphFont(ch)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let lv = 0; lv < LEVELS; lv++) {
    ctx.fillStyle = `rgba(${ink[0]},${ink[1]},${ink[2]},${lo + ((hi - lo) * (lv + 0.5)) / LEVELS})`
    for (let c = 0; c < theme.ramp.length; c++) ctx.fillText(theme.ramp[c], (c * gw) / dpr + cw / 2, (lv * gh) / dpr + ch / 2 + 1)
  }
  return canvas
}

export class Renderer {
  private ctx: Ctx2D
  private oc = surface(1, 1)
  private ox: Ctx2D
  private instance: Instance | null = null
  private look: Look
  private trail = new Float32Array(0)
  /**
   * O que cada célula mostra na tela (nível × caracteres do tema + caractere; -1 vazia): só a que
   * muda é repintada. A cena anda devagar, então a maioria passa de um quadro para o outro igual.
   */
  private drawn = new Int16Array(0)
  /** A tela inteira precisa ser pintada de novo (nova, redimensionada, atlas novo). */
  private full = true
  // As bordas das colunas e das linhas em pixels da tela, para as células se encaixarem sem fresta.
  private xs = new Int32Array(0)
  private ys = new Int32Array(0)
  private atlas: CanvasImageSource | null = null
  private atlasDpr = 0
  // Cena parada (`still`): a leitura da grade e o que o último quadro mostrou.
  private grid: Float32Array | null = null
  private shown: { slot: number; x: number; y: number; lit: boolean } | null = null
  W = 0
  H = 0
  cols = 0
  rows = 0
  cw: number
  ch: number
  k = 1
  private dpr = 1

  private canvas: Surface
  private theme: Theme
  private dark: boolean
  private zoom: number

  /** `zoom` multiplica a célula; abaixo de 1 cabe mais cena numa miniatura. */
  constructor(canvas: Surface, theme: Theme, dark: boolean, zoom = 1) {
    this.canvas = canvas
    this.theme = theme
    this.dark = dark
    this.zoom = zoom
    this.ctx = canvas.getContext('2d') as Ctx2D
    this.ox = this.oc.getContext('2d', { willReadFrequently: true }) as Ctx2D
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
    this.drawn = new Int16Array(n)
    this.full = true
    this.xs = Int32Array.from({ length: this.cols + 1 }, (_, i) => Math.round(i * this.cw * dpr))
    this.ys = Int32Array.from({ length: this.rows + 1 }, (_, j) => Math.round(j * this.ch * dpr))
    this.grid = null
    this.shown = null
    // A escala acompanha a célula: a miniatura tem células menores e o mesmo desenho, só que menor.
    this.k = this.zoom * Math.max(1, Math.min(W, H) / 900)
    this.instance = this.theme.create({ W, H, k: this.k }, this.dark)
  }

  /** O atlas dos caracteres (ver `glyphAtlas`), feito para a densidade de tela `dpr`. */
  setAtlas(atlas: CanvasImageSource, dpr: number): void {
    this.atlas = atlas
    this.atlasDpr = dpr
    this.full = true
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
  private sample(draw: (g: Ctx2D) => void): Float32Array {
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
    // O caractere troca de vez em quando, sozinho: é o que dá a cintilação de ASCII.
    const slot = Math.floor(t * 1.5)
    const last = this.shown
    if (theme.still && !this.full && last && !last.lit && last.slot === slot && last.x === (mouse?.x ?? -1) && last.y === (mouse?.y ?? -1)) return
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

    // Fundo pintado pelo tema, grade ou ladrilhos mudam a tela toda: aí ela é pintada de novo inteira.
    if (this.full || instance.bg || look.grid || theme.style !== 'glyphs') {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      ctx.fillStyle = look.backdrop
      ctx.fillRect(0, 0, W, H)
      instance.bg?.(ctx, env)
      if (look.grid) {
        ctx.fillStyle = look.grid
        for (let x = 0; x < W; x += cw) ctx.fillRect(x, 0, 1, H)
        for (let y = 0; y < H; y += ch) ctx.fillRect(0, y, W, 1)
      }
      this.drawn.fill(-1)
      this.full = false
    }

    const L = theme.still ? (this.grid ??= this.sample((g) => instance.scene(g, env))) : this.sample((g) => instance.scene(g, env))
    const lantern = mouse ? 150 * Math.max(this.zoom, 0.5) : 0
    const ramp = theme.ramp
    const top = ramp.length - 1
    const fade = Math.pow(0.05, dt)
    let trail = 0

    if (theme.style === 'glyphs') {
      // Sem o atlas desta densidade (ainda chegando), fica só o fundo; ele chega e pinta tudo.
      const atlas = this.atlasDpr === this.dpr ? this.atlas : null
      if (!atlas) {
        this.full = true
        return
      }
      const { xs, ys, drawn } = this
      const n = ramp.length
      const gw = Math.ceil(cw * this.dpr)
      const gh = Math.ceil(ch * this.dpr)
      // Em pixels da tela: o retângulo do atlas cai inteiro na célula, sem reamostrar.
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = look.backdrop
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const k = j * cols + i
          const a = L[k * 4 + 3]
          const cx = i * cw + cw / 2
          const cy = j * ch + ch / 2
          const near = lantern ? clamp(1 - Math.hypot(cx - mouse!.x, cy - mouse!.y) / lantern) : 0
          const tr = (this.trail[k] *= fade)
          if (tr > trail) trail = tr
          const lit = Math.max(near * near * 0.45, tr * 0.5)
          const v = a > 0.04 ? clamp(a + lit * 0.6) : lit * 0.7
          let glyph = -1
          if (v >= 0.05) {
            const flick = hash(i, j, slot)
            const c = clamp(Math.floor(v * top + (flick - 0.5) * 1.1), 0, top)
            glyph = Math.min(LEVELS - 1, Math.floor(v * LEVELS)) * n + c
          }
          const before = drawn[k]
          if (glyph === before) continue
          drawn[k] = glyph
          const x = xs[i]
          const y = ys[j]
          if (before !== -1) ctx.fillRect(x, y, xs[i + 1] - x, ys[j + 1] - y)
          if (glyph !== -1) ctx.drawImage(atlas, (glyph % n) * gw, ((glyph / n) | 0) * gh, gw, gh, x, y, gw, gh)
        }
      // Rastro ainda apagando: o próximo quadro muda, mesmo com o ponteiro parado.
      this.shown = { slot, x: mouse?.x ?? -1, y: mouse?.y ?? -1, lit: trail > 0.01 }
      return
    }

    ctx.font = glyphFont(ch)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

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

// Workers sem requestAnimationFrame: um quadro a cada ~16 ms.
const nextFrame: (cb: (now: number) => void) => number =
  typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number
const cancelFrame = (id: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id))

/**
 * A cena andando: o laço de quadros no ritmo do tema, ligado só enquanto `run(true)`. É o mesmo na
 * página e no worker; quem o dirige diz o tamanho, o atlas, o ponteiro e quando ela está à vista.
 */
export class Player {
  private renderer: Renderer
  private fps: number
  private time = 0
  private raf = 0
  private last = 0
  private drawn = 0
  private sized = false
  private mouse: Pointer | null = null

  constructor(renderer: Renderer, fps: number) {
    this.renderer = renderer
    this.fps = fps
  }

  /** Novo tamanho: a cena nasce de novo nele e já desenha um quadro. */
  resize(w: number, h: number, dpr: number): void {
    this.renderer.resize(w, h, dpr)
    this.sized = true
    this.draw(0)
  }

  atlas(atlas: CanvasImageSource, dpr: number): void {
    this.renderer.setAtlas(atlas, dpr)
    if (this.sized) this.draw(0)
  }

  /** Onde o ponteiro está (`null` fora da cena); `mark` deixa o rastro por onde ele passou. */
  pointer(mouse: Pointer | null, mark: boolean): void {
    this.mouse = mouse
    if (mouse && mark) this.renderer.mark(mouse.x, mouse.y)
  }

  run(on: boolean): void {
    if (!on) {
      if (this.raf) cancelFrame(this.raf)
      this.raf = 0
      return
    }
    if (this.raf) return
    this.last = performance.now()
    this.drawn = 0
    this.raf = nextFrame(this.frame)
  }

  private draw(dt: number): void {
    this.time += dt
    this.renderer.frame(this.time, dt, this.mouse)
  }

  private frame = (now: number): void => {
    this.raf = nextFrame(this.frame)
    if (now - this.drawn < 1000 / this.fps - 4) return
    const dt = Math.min((now - this.last) / 1000, 0.25)
    this.last = now
    this.drawn = now
    this.draw(dt)
  }
}
