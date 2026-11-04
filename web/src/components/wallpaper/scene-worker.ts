import type { ImageId } from '@/lib/wallpaper-images'
import { Player, Renderer, type Pointer } from './engine'
import { imageThemeFrom } from './image'
import { themeOf } from './themes'

/**
 * O fundo animado fora do main thread: o worker desenha a cena no canvas que a página passou para ele
 * (`transferControlToOffscreen`). Ler a cena (`getImageData`) e pintar a grade tomavam boa parte de
 * cada quadro, e o que a página digitava esperava na fila; aqui, a página só repassa o tamanho, o
 * ponteiro e quando a cena está à vista (ver `Scene`).
 */
export type ToWorker =
  | { type: 'init'; canvas: OffscreenCanvas; theme: string; picture?: ImageBitmap; dark: boolean; zoom: number }
  | { type: 'resize'; w: number; h: number; dpr: number }
  | { type: 'atlas'; atlas: ImageBitmap; dpr: number }
  | { type: 'pointer'; mouse: Pointer | null; mark: boolean }
  | { type: 'run'; on: boolean }

let player: Player | null = null
// O que chega antes do `init` (a imagem do tema pode demorar a copiar) fica guardado para ele.
let size: Extract<ToWorker, { type: 'resize' }> | null = null
let atlas: Extract<ToWorker, { type: 'atlas' }> | null = null
let running = false

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data
  switch (m.type) {
    case 'init': {
      const theme = m.picture ? imageThemeFrom(m.theme as ImageId, m.picture) : themeOf(m.theme)
      if (!theme) return
      player = new Player(new Renderer(m.canvas, theme, m.dark, m.zoom), theme.fps)
      if (size) player.resize(size.w, size.h, size.dpr)
      if (atlas) player.atlas(atlas.atlas, atlas.dpr)
      player.run(running)
      return
    }
    case 'resize':
      size = m
      return player?.resize(m.w, m.h, m.dpr)
    case 'atlas':
      atlas?.atlas.close()
      atlas = m
      return player?.atlas(m.atlas, m.dpr)
    case 'pointer':
      return player?.pointer(m.mouse, m.mark)
    case 'run':
      running = m.on
      return player?.run(m.on)
  }
}
