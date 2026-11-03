import { duration } from '@/lib/format'
import type { Box, Layout } from './layout'
import { KIND_LABEL, STATE_LABEL, type MindStatus } from './model'

/**
 * O mapa como imagem: um SVG desenhado a partir do layout (os cartões na tela são HTML), com as cores
 * do tema em rgb para abrir fora do navegador também; o PNG sai dele, em resolução dobrada. O
 * claudinho de cada cartão vira uma bolinha da cor dele com os dois olhos.
 */

export type ImageFormat = 'png' | 'svg'

/** O consumo da conversa, para o cartão do topo (o mesmo que a tela mostra). */
export type RootSpend = { model?: string; line: string; usd: string }

type Theme = Record<'background' | 'card' | 'foreground' | 'muted' | 'border', string>

/** Variável do tema (oklch no shadcn) convertida para rgb pelo próprio navegador. */
function themeColor(ctx: CanvasRenderingContext2D, value: string, fallback: string): string {
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = fallback
  if (value) ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  return a === 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`
}

/** Uma cor da tela (hex do claudinho ou `var(--…)`) em rgb. */
function resolve(ctx: CanvasRenderingContext2D, color: string, fallback: string): string {
  const name = color.match(/^var\((--[\w-]+)\)$/)?.[1]
  const value = name ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : color
  return themeColor(ctx, value, fallback)
}

const STATE_COLOR: Partial<Record<MindStatus, string>> = { running: '#0ea5e9', waiting: '#f59e0b', failed: '#ef4444' }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Quebra o texto em até `max` linhas que caibam em `width`; o que sobra vira reticências. */
function fitLines(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let i = 0
  while (i < words.length && lines.length < max) {
    let line = words[i++]!
    while (i < words.length && ctx.measureText(`${line} ${words[i]}`).width <= width) line += ` ${words[i++]}`
    lines.push(line)
  }
  const cut = (s: string) => {
    while (s && ctx.measureText(`${s}…`).width > width) s = s.slice(0, -1)
    return `${s.trimEnd()}…`
  }
  return lines.map((l, n) => (ctx.measureText(l).width > width || (n === lines.length - 1 && i < words.length) ? cut(l) : l))
}

type Draw = { ctx: CanvasRenderingContext2D; font: string; mono: string; theme: Theme }

function text(d: Draw, s: string, x: number, y: number, size: number, opts: { weight?: number; color: string; anchor?: 'end' | 'middle'; mono?: boolean; width?: number; upper?: boolean }): string {
  const family = opts.mono ? d.mono : d.font
  d.ctx.font = `${opts.weight ?? 400} ${size}px ${family}`
  const value = opts.upper ? s.toUpperCase() : s
  const line = opts.width ? fitLines(d.ctx, value, opts.width, 1)[0] ?? '' : value
  const anchor = opts.anchor ? ` text-anchor="${opts.anchor}"` : ''
  const spacing = opts.upper ? ' letter-spacing="0.8"' : ''
  return `<text x="${x}" y="${y.toFixed(1)}" font-size="${size}" font-weight="${opts.weight ?? 400}" fill="${opts.color}"${anchor}${spacing}${opts.mono ? ` font-family="${esc(d.mono)}"` : ''}>${esc(line)}</text>`
}

/** O claudinho simplificado: a bolinha da cor dele com dois olhos brancos. */
function face(cx: number, cy: number, r: number, color: string): string {
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>` +
    `<ellipse cx="${cx - r * 0.33}" cy="${cy - r * 0.05}" rx="${r * 0.14}" ry="${r * 0.22}" fill="#fff"/>` +
    `<ellipse cx="${cx + r * 0.33}" cy="${cy - r * 0.05}" rx="${r * 0.14}" ry="${r * 0.22}" fill="#fff"/>`
  )
}

function card(d: Draw, b: Box, color: string, spend: RootSpend | null): string {
  const n = b.node
  const { x, y, w, h } = b
  const t = d.theme
  const state = STATE_COLOR[n.status]

  if (n.kind === 'notice') {
    return (
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="${h / 2}" fill="none" stroke="${t.border}" stroke-dasharray="4 3"/>` +
      text(d, n.label, x + w / 2, y + h / 2 + 4, 11.5, { color: t.muted, anchor: 'middle', width: w - 24 })
    )
  }
  if (n.kind === 'option') {
    const took = n.chosen === true
    const dropped = n.chosen === false
    const cy = y + h / 2
    const mark = took
      ? `<path d="M${x + 12} ${cy} l3 3 l6 -6" fill="none" stroke="${color}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>`
      : dropped
        ? `<path d="M${x + 13} ${cy - 3.5} l7 7 M${x + 20} ${cy - 3.5} l-7 7" stroke="${t.muted}" stroke-width="1.5" stroke-linecap="round"/>`
        : `<polygon points="${x + 16},${cy - 4} ${x + 20},${cy} ${x + 16},${cy + 4} ${x + 12},${cy}" fill="none" stroke="${t.muted}"/>`
    return (
      `<g opacity="${dropped ? 0.6 : 1}">` +
      `<rect x="${x + 0.75}" y="${y + 0.75}" width="${w - 1.5}" height="${h - 1.5}" rx="12" fill="${dropped ? 'none' : t.card}" stroke="${took ? color : t.border}" stroke-width="${took ? 1.5 : 1}"${dropped ? ' stroke-dasharray="4 3"' : ''}/>` +
      mark +
      text(d, n.label, x + 28, cy + 4, 12, { weight: took ? 500 : 400, color: dropped ? t.muted : t.foreground, width: w - 40 }) +
      `</g>`
    )
  }

  const pad = 14
  const left = x + pad + 28 + 12
  const right = x + w - pad
  const type = KIND_LABEL[n.kind] ?? ''
  d.ctx.font = `500 10px ${d.font}`
  const typeW = type ? d.ctx.measureText(type.toUpperCase()).width + 10 : 0
  const outline = state && n.status !== 'failed' ? state : t.border
  let out =
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="${n.kind === 'root' ? 18 : 14}" fill="${t.card}" stroke="${outline}"/>` +
    `<line x1="${x + 16}" y1="${y + 0.5}" x2="${x + w - 16}" y2="${y + 0.5}" stroke="${color}"/>`

  // O ícone: o claudinho de quem fez, um rosto neutro para você, o losango da pergunta.
  const icx = x + pad + 14
  const icy = y + 26
  if (n.kind === 'turn') out += `<circle cx="${icx}" cy="${icy}" r="13" fill="${t.muted}" fill-opacity="0.18"/><circle cx="${icx}" cy="${icy - 2.5}" r="3" fill="${t.muted}"/><path d="M${icx - 5} ${icy + 6} a5 4 0 0 1 10 0" fill="${t.muted}"/>`
  else if (n.kind === 'decision') out += `<rect x="${icx - 5}" y="${icy - 5}" width="10" height="10" rx="2" transform="rotate(45 ${icx} ${icy})" fill="${state ?? color}"/>`
  else if (n.kind === 'approval') out += `<circle cx="${icx}" cy="${icy}" r="11" fill="none" stroke="${state ?? t.muted}" stroke-width="1.75"/><text x="${icx}" y="${icy + 4.5}" font-size="13" font-weight="700" fill="${state ?? t.muted}" text-anchor="middle">!</text>`
  else out += face(icx, icy, n.kind === 'root' ? 15 : n.kind === 'agent' ? 13 : 12, color)

  // O título (uma ou duas linhas) com o tipo no canto.
  const titleLines = n.kind === 'agent' ? 1 : 2
  d.ctx.font = `600 13px ${d.font}`
  const lines = fitLines(d.ctx, n.label, right - left - typeW, titleLines)
  let ty = y + 12 + 13
  for (const l of lines) {
    out += `<text x="${left}" y="${ty}" font-size="13" font-weight="600" fill="${t.foreground}">${esc(l)}</text>`
    ty += 17
  }
  if (type) out += text(d, type, right, y + 12 + 11, 10, { weight: 500, color: t.muted, anchor: 'end', upper: true })

  const foot = y + h - 13
  const status = (time?: string) => {
    const label = STATE_LABEL[n.status].toUpperCase()
    d.ctx.font = `400 10.5px ${d.font}`
    const timeW = time ? d.ctx.measureText(time).width + 6 : 0
    return (
      (time ? text(d, time, right, foot, 10.5, { color: t.muted, anchor: 'end' }) : '') +
      text(d, label, right - timeW, foot, 10.5, { weight: 500, color: state ?? t.muted, anchor: 'end' })
    )
  }
  const sub = (s: string, at: number) => text(d, s, left, at, 12, { color: t.muted, width: right - left })
  const mono = (s: string, at: number, width = right - left) => text(d, s, left, at, 11, { color: t.foreground, mono: true, width })

  if (n.kind === 'root') {
    if (spend?.model ?? n.meta) out += mono(spend?.model ?? n.meta ?? '', ty + 2)
    if (spend) out += mono(spend.line, foot, right - left - 60) + text(d, spend.usd, right, foot, 12, { weight: 600, color: t.foreground, anchor: 'end' })
    return out
  }
  if (n.kind === 'turn') {
    if (n.meta) out += sub(n.meta, ty + 1)
    const s = n.stats
    return out + status(n.status === 'done' && s?.durationMs ? duration(s.durationMs) : undefined) + (s?.costUsd ? mono(`US$ ${s.costUsd.toFixed(2)}`, foot, 90) : '')
  }
  if (n.kind === 'agent') {
    const s = n.stats
    out += sub(n.detail ?? (n.meta || 'Subagente'), ty + 1)
    if (s?.model) out += mono(s.model, ty + 18)
    return out + (s?.tokens ? mono(`${Math.round(s.tokens / 1000)}k tokens`, foot, (right - left) / 2) : '') + status(s?.durationMs ? duration(s.durationMs) : undefined)
  }
  if (n.status !== 'done') return out + (n.meta ? text(d, n.meta, left, foot, 12, { color: t.muted, width: (right - left) / 2 }) : '') + status()
  return out + (n.meta ? sub(n.meta, ty + 1) : '')
}

export function mapSvg(g: Layout, spend: RootSpend | null): string {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const theme: Theme = {
    background: themeColor(ctx, css('--background'), '#ffffff'),
    card: themeColor(ctx, css('--card'), '#ffffff'),
    foreground: themeColor(ctx, css('--foreground'), '#111111'),
    muted: themeColor(ctx, css('--muted-foreground'), '#6b7280'),
    border: themeColor(ctx, css('--border'), '#e5e7eb'),
  }
  const font = getComputedStyle(document.body).fontFamily || 'sans-serif'
  const d: Draw = { ctx, font, mono: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme }
  const color = (c: string) => resolve(ctx, c, theme.muted)

  const groups = g.groups
    .map(
      (gr) =>
        `<rect x="${gr.x + 0.5}" y="${gr.y + 0.5}" width="${gr.w - 1}" height="${gr.h - 1}" rx="16" fill="none" stroke="${theme.muted}" stroke-opacity="0.35" stroke-dasharray="4 4"/>` +
        text(d, gr.label, gr.x + 14, gr.y + 16, 10, { weight: 500, color: theme.muted, upper: true }),
    )
    .join('')
  const edges = g.edges
    .map((e) => {
      const c = color(e.color)
      const dash = e.dash === 'dot' ? ' stroke-dasharray="1.5 5"' : e.dash === 'dash' ? ' stroke-dasharray="5 5"' : ''
      return (
        `<g opacity="${e.dim ? 0.4 : 1}"><path d="${e.d}" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"${dash}/>` +
        `<polygon points="${e.arrow}" fill="${c}"/></g>`
      )
    })
    .join('')
  const labels = g.edges
    .filter((e) => e.label)
    .map((e) => {
      const l = e.label!
      ctx.font = `400 10.5px ${d.mono}`
      const w = ctx.measureText(l.text).width + 20
      return (
        `<rect x="${l.x - w / 2}" y="${l.y - 9}" width="${w}" height="18" rx="9" fill="${theme.background}" stroke="${color(e.color)}"/>` +
        text(d, l.text, l.x, l.y + 3.5, 10.5, { color: theme.foreground, anchor: 'middle', mono: true })
      )
    })
    .join('')
  const cards = g.boxes.map((b) => card(d, b, color(b.color), spend)).join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${g.width}" height="${g.height}" viewBox="0 0 ${g.width} ${g.height}" font-family="${esc(font)}">` +
    `<rect width="100%" height="100%" fill="${theme.background}"/>${groups}${edges}${labels}${cards}</svg>`
  )
}

async function toPng(svg: string, width: number, height: number): Promise<Blob> {
  // Dobro da resolução, sem passar do limite de tamanho de canvas dos celulares.
  const scale = Math.min(2, 8000 / Math.max(width, height))
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext('2d')!
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0, width, height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png_failed'))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

function slug(title: string): string {
  const s = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return s.slice(0, 48) || 'conversa'
}

export async function mapImage(g: Layout, title: string, format: ImageFormat, spend: RootSpend | null): Promise<File> {
  const svg = mapSvg(g, spend)
  const name = `mapa-${slug(title)}.${format}`
  if (format === 'svg') return new File([svg], name, { type: 'image/svg+xml' })
  return new File([await toPng(svg, g.width, g.height)], name, { type: 'image/png' })
}

/** O celular sabe compartilhar arquivos (WhatsApp, Drive, Fotos…)? */
export function canShareImage(): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([''], 'mapa.png', { type: 'image/png' })] })
  } catch {
    return false
  }
}

export function download(file: File): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
