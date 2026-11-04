import { useEffect, useRef, useState } from 'react'
import { useDarkMode } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { OPACITY, useWallpaper } from '@/lib/wallpaper'
import { useWallpaperImages, type WallpaperImage } from '@/lib/wallpaper-images'
import { Player, Renderer, glyphAtlas, glyphFont, type Pointer, type Theme } from './engine'
import { imageTheme } from './image'
import type { ToWorker } from './scene-worker'
import { themeOf } from './themes'

// Acima de 2x a densidade não aparece na tela e cada quadro custa o dobro.
const MAX_DPR = 2

/** Quem pinta a cena: um worker ou a própria página (ver `workerPainter`). */
type Painter = {
  resize(w: number, h: number, dpr: number): void
  atlas(atlas: HTMLCanvasElement, dpr: number): void
  pointer(mouse: Pointer | null, mark: boolean): void
  run(on: boolean): void
  close(): void
}

/**
 * A cena pintada num worker, para ela não disputar o main thread com a digitação: um quadro lia a cena
 * e pintava a grade em boa parte dos 33 ms dele. `null` onde o navegador não passa o canvas para um
 * worker; `onFail`, se o worker quebrar depois (o canvas já é dele, então a página monta outro).
 */
function workerPainter(el: HTMLCanvasElement, theme: Theme, dark: boolean, zoom: number, onFail: () => void): Painter | null {
  if (typeof el.transferControlToOffscreen !== 'function') return null
  let worker: Worker
  try {
    worker = new Worker(new URL('./scene-worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
  let closed = false
  const send = (m: ToWorker, transfer: Transferable[] = []) => !closed && worker.postMessage(m, transfer)
  worker.onerror = () => {
    if (closed) return
    closed = true
    worker.terminate()
    onFail()
  }
  const canvas = el.transferControlToOffscreen()
  const init = { type: 'init', canvas, theme: theme.id, dark, zoom } as const
  // A imagem em tinta é copiada para o worker; a da página fica para a miniatura e as próximas vezes.
  if (theme.picture) void createImageBitmap(theme.picture).then((picture) => send({ ...init, picture }, [canvas, picture]))
  else send(init, [canvas])
  return {
    resize: (w, h, dpr) => send({ type: 'resize', w, h, dpr }),
    atlas: (atlas, dpr) =>
      void createImageBitmap(atlas).then((bitmap) => (closed ? bitmap.close() : send({ type: 'atlas', atlas: bitmap, dpr }, [bitmap]))),
    pointer: (mouse, mark) => send({ type: 'pointer', mouse, mark }),
    run: (on) => send({ type: 'run', on }),
    close: () => {
      closed = true
      worker.terminate()
    },
  }
}

/** A cena pintada na própria página, onde não há worker com canvas. */
function pagePainter(el: HTMLCanvasElement, theme: Theme, dark: boolean, zoom: number): Painter {
  const player = new Player(new Renderer(el, theme, dark, zoom), theme.fps)
  return {
    resize: (w, h, dpr) => player.resize(w, h, dpr),
    atlas: (atlas, dpr) => player.atlas(atlas, dpr),
    pointer: (mouse, mark) => player.pointer(mouse, mark),
    run: (on) => player.run(on),
    close: () => player.run(false),
  }
}

/**
 * Uma cena de ASCII animado preenchendo o elemento (ver engine.ts). Ela só gasta quadro enquanto está
 * mesmo à vista: fora da tela e com o app em segundo plano o laço é cancelado, não só ignorado. Com
 * `prefers-reduced-motion` desenha um quadro e para. `interactive` liga o ponteiro: a cena ouve o
 * mouse pela janela inteira, porque fica por baixo do app e nunca recebe o evento direto.
 */
export function Scene({
  theme,
  zoom = 1,
  interactive = false,
  className,
  style,
}: {
  theme: Theme
  /** Multiplica o tamanho da célula; abaixo de 1 cabe mais cena numa miniatura. */
  zoom?: number
  interactive?: boolean
  className?: string
  style?: React.CSSProperties
}) {
  const box = useRef<HTMLDivElement>(null)
  const dark = useDarkMode()

  useEffect(() => {
    const host = box.current
    if (!host) return
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    let alive = true
    let el: HTMLCanvasElement | null = null
    let painter: Painter
    // A última medida (o atlas é feito para a densidade dela) e se a cena está andando.
    let w = 0
    let h = 0
    let dpr = 0
    let running = false
    let mouse: Pointer | null = null

    const atlas = () => {
      if (theme.style === 'glyphs' && dpr) painter.atlas(glyphAtlas(theme, dark, zoom, dpr), dpr)
    }

    // Um canvas novo a cada montagem: o que foi passado ao worker não volta a ser da página.
    const mount = (worker: boolean) => {
      el?.remove()
      el = document.createElement('canvas')
      el.className = 'absolute top-0 left-0 block'
      host.appendChild(el)
      painter = (worker && workerPainter(el, theme, dark, zoom, () => alive && mount(false))) || pagePainter(el, theme, dark, zoom)
      if (w && h) {
        el.style.width = `${w}px`
        el.style.height = `${h}px`
        painter.resize(w, h, dpr)
        atlas()
      }
      painter.run(running)
    }
    mount(true)

    const build = () => {
      if (!host.clientWidth || !host.clientHeight) return
      w = host.clientWidth
      h = host.clientHeight
      el!.style.width = `${w}px`
      el!.style.height = `${h}px`
      const next = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      painter.resize(w, h, next)
      if (next === dpr) return
      dpr = next
      atlas()
    }

    // O atlas pinta os caracteres com a fonte da página: chegando depois, ele é refeito com ela.
    const font = glyphFont(theme.cell.h * zoom)
    if (!document.fonts.check(font)) void document.fonts.load(font).then(() => alive && atlas())

    let onScreen = true
    let awake = !document.hidden
    const update = () => {
      running = !still && onScreen && awake
      painter.run(running)
    }

    const resize = new ResizeObserver(build)
    resize.observe(host)

    const seen = new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting)
      update()
    })
    seen.observe(host)

    const onVisibility = () => {
      awake = !document.hidden
      update()
    }
    document.addEventListener('visibilitychange', onVisibility)

    // Só o mouse: no toque, o dedo passando para rolar a conversa não é um gesto na cena.
    let lastMove = 0
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      const r = host.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      if (x < 0 || y < 0 || x > r.width || y > r.height) {
        if (mouse) painter.pointer(null, false)
        mouse = null
        return
      }
      const now = performance.now()
      const gap = Math.max(1, now - lastMove) / 1000
      const speed = mouse ? Math.hypot(x - mouse.x, y - mouse.y) / gap : 0
      lastMove = now
      mouse = { x, y, speed: mouse ? mouse.speed * 0.7 + speed * 0.3 : 0 }
      painter.pointer(mouse, true)
    }
    const onLeave = () => {
      mouse = null
      painter.pointer(null, false)
    }
    if (interactive && !still) {
      window.addEventListener('pointermove', onMove, { passive: true })
      document.documentElement.addEventListener('pointerleave', onLeave)
    }

    update()

    return () => {
      alive = false
      painter.close()
      el?.remove()
      resize.disconnect()
      seen.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
    }
  }, [theme, dark, zoom, interactive])

  return <div ref={box} aria-hidden className={cn('relative overflow-hidden', className)} style={{ ...style, background: theme.look(dark).backdrop }} />
}

type Layer = { className?: string; style?: React.CSSProperties }

/** Uma imagem sua em caracteres; nada até ela decodificar, o que leva um instante na primeira vez. */
export function ImageScene({ image, ...rest }: { image: WallpaperImage; zoom?: number; interactive?: boolean } & Layer) {
  const [theme, setTheme] = useState<{ id: string; theme: Theme } | null>(null)
  useEffect(() => {
    let alive = true
    imageTheme(image)
      .then((t) => alive && setTheme({ id: image.id, theme: t }))
      .catch(() => {
        // Imagem que o navegador não abre mais: fica sem cena, como se não houvesse fundo.
      })
    return () => {
      alive = false
    }
  }, [image])
  if (theme?.id !== image.id) return null
  return <Scene theme={theme.theme} {...rest} />
}

/** Uma imagem sua como foto, cobrindo o elemento. */
export function Photo({ image, className, style }: { image: WallpaperImage } & Layer) {
  return (
    <div aria-hidden className={cn('overflow-hidden', className)} style={style}>
      <img src={image.url} alt="" draggable={false} decoding="async" className="size-full object-cover" />
    </div>
  )
}

/** O fundo da conversa, com o tema (ou a imagem) e a força escolhidos no painel Computador. */
export function Wallpaper({ className }: { className?: string }) {
  const id = useWallpaper((s) => s.theme)
  const intensity = useWallpaper((s) => s.intensity)
  const image = useWallpaperImages((s) => s.items.find((i) => i.id === id))
  const layer = { className: cn('pointer-events-none absolute inset-0', className), style: { opacity: OPACITY[intensity] } }
  if (image) return image.style === 'photo' ? <Photo image={image} {...layer} /> : <ImageScene image={image} interactive {...layer} />
  const theme = themeOf(id)
  return theme ? <Scene theme={theme} interactive {...layer} /> : null
}
