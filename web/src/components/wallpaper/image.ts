import type { ImageId, WallpaperImage } from '@/lib/wallpaper-images'
import type { Theme } from './engine'

// A grade lê no máximo umas 1300 amostras de largura (4K, ver engine.ts): guardar mais é só memória.
const MAX_SIDE = 960

/**
 * Uma imagem sua como tema: a cena é a própria imagem, já em tinta (ver `ink`), recortada como
 * `object-fit: cover`. A grade faz dela caracteres, como faz das formas de um tema; o ponteiro acende
 * e deixa rastro do mesmo jeito. A célula é menor que a das Ondas: um retrato precisa de mais detalhe
 * que uma faixa.
 */
function build(id: ImageId, inked: HTMLCanvasElement): Theme {
  return {
    id,
    name: 'Imagem',
    hint: 'Sua imagem em caracteres, que acendem perto do ponteiro.',
    cell: { w: 8, h: 12 },
    ramp: '.:-=+*#%@',
    style: 'glyphs',
    fps: 30,
    veil: false,
    still: true,
    // Mais forte que as Ondas: aqui o desenho é o assunto, e uma foto em caracteres finos some fácil.
    look: (dark) =>
      dark
        ? { backdrop: '#121212', ink: [235, 235, 235], alpha: [0.18, 0.8] }
        : { backdrop: '#f4f4f4', ink: [24, 24, 24], alpha: [0.16, 0.72] },
    create({ W, H }) {
      const s = Math.max(W / inked.width, H / inked.height)
      const sw = W / s
      const sh = H / s
      const sx = (inked.width - sw) / 2
      const sy = (inked.height - sh) / 2
      return {
        scene(g) {
          g.imageSmoothingEnabled = true
          g.imageSmoothingQuality = 'high'
          g.drawImage(inked, sx, sy, sw, sh, 0, 0, W, H)
        },
      }
    },
  }
}

/**
 * A imagem em tinta: branca, com a opacidade de quanto cada ponto deve virar caractere. Vira caractere
 * o lado que está em minoria: numa foto escura (a duna à noite), o claro; numa clara (o retrato no
 * fundo branco), o escuro. Assim o fundo da foto fica vazio e a figura aparece, no tema claro e no
 * escuro — inverter pelo tema enchia a tela de caracteres atrás do texto. Os tons são esticados entre
 * os 2% mais escuros e os 2% mais claros, para uma foto lavada não virar uma parede cinza, e o meio-tom
 * é puxado para baixo. Num PNG recortado, a figura é o que não é transparente: ela fica densa, pelo
 * lado que ela mais tem, e o transparente fica vazio.
 */
function ink(source: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = source.width
  out.height = source.height
  const g = out.getContext('2d', { willReadFrequently: true })!
  g.drawImage(source, 0, 0)
  const img = g.getImageData(0, 0, out.width, out.height)
  const d = img.data
  const n = d.length / 4
  const lum = new Uint8Array(n)
  const hist = new Uint32Array(256)
  let seen = 0
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const l = Math.round(0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2])
    lum[i] = l
    // Só o que aparece entra na conta dos tons.
    if (d[p + 3] < 128) continue
    hist[l]++
    seen++
  }
  const at = (share: number) => {
    let sum = 0
    for (let v = 0; v < 256; v++) if ((sum += hist[v]) >= seen * share) return v
    return 255
  }
  const lo = at(0.02)
  const span = Math.max(24, at(0.98) - lo)
  const tone = (l: number) => Math.min(1, Math.max(0, (l - lo) / span))
  let mean = 0
  for (let v = 0; v < 256; v++) mean += hist[v] * tone(v)
  const light = mean / (seen || 1) > 0.5
  const cutout = seen < n * 0.9
  const invert = cutout ? !light : light
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const t = tone(lum[i])
    const a = d[p + 3] / 255
    d[p] = d[p + 1] = d[p + 2] = 255
    d[p + 3] = Math.round((invert ? 1 - t : t) ** 1.3 * a * 255)
  }
  g.putImageData(img, 0, 0)
  return out
}

async function decode(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(bitmap.width * scale))
    out.height = Math.max(1, Math.round(bitmap.height * scale))
    const g = out.getContext('2d')!
    g.imageSmoothingQuality = 'high'
    g.drawImage(bitmap, 0, 0, out.width, out.height)
    return out
  } finally {
    bitmap.close()
  }
}

// Uma decodificação por imagem, dividida entre o fundo e a miniatura dos ajustes.
const cache = new Map<ImageId, Promise<Theme>>()

/** O tema de uma imagem sua; a imagem de um id não muda, então ele fica guardado enquanto o app roda. */
export function imageTheme(image: WallpaperImage): Promise<Theme> {
  let theme = cache.get(image.id)
  if (!theme) {
    theme = decode(image.blob).then((source) => build(image.id, ink(source)))
    cache.set(image.id, theme)
    theme.catch(() => cache.delete(image.id))
  }
  return theme
}

/** Solta a imagem apagada: o tema dela não volta a ser pedido. */
export const forgetImageTheme = (id: ImageId) => cache.delete(id)
