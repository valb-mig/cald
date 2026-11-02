import { useEffect, useRef } from 'react'
import { useDarkMode } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { OPACITY, useWallpaper, type ThemeId } from '@/lib/wallpaper'
import { Renderer, type Pointer } from './engine'
import { themeOf } from './themes'

// Acima de 2x a densidade não aparece na tela e cada quadro custa o dobro.
const MAX_DPR = 2

/**
 * Uma cena de ASCII animado preenchendo o elemento (ver engine.ts). Ela só gasta quadro enquanto está
 * mesmo à vista: fora da tela e com o app em segundo plano o laço é cancelado, não só ignorado. Com
 * `prefers-reduced-motion` desenha um quadro e para. `interactive` liga o ponteiro: a cena ouve o
 * mouse pela janela inteira, porque fica por baixo do app e nunca recebe o evento direto.
 */
export function Scene({
  id,
  zoom = 1,
  interactive = false,
  className,
  style,
}: {
  id: Exclude<ThemeId, 'none'>
  /** Multiplica o tamanho da célula; abaixo de 1 cabe mais cena numa miniatura. */
  zoom?: number
  interactive?: boolean
  className?: string
  style?: React.CSSProperties
}) {
  const box = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLCanvasElement>(null)
  const dark = useDarkMode()
  const theme = themeOf(id)

  useEffect(() => {
    const host = box.current
    const el = surface.current
    if (!host || !el || !theme) return
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    const renderer = new Renderer(el, theme, dark, zoom)
    let time = 0
    let mouse: Pointer | null = null

    const build = () => {
      const w = host.clientWidth
      const h = host.clientHeight
      if (!w || !h) return
      el.style.width = `${w}px`
      el.style.height = `${h}px`
      renderer.resize(w, h, Math.min(window.devicePixelRatio || 1, MAX_DPR))
    }

    const draw = (dt: number) => {
      time += dt
      renderer.frame(time, dt, mouse)
    }

    let raf = 0
    let last = 0
    let drawn = 0
    let onScreen = true
    let awake = !document.hidden

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (now - drawn < 1000 / theme.fps - 4) return
      const dt = Math.min((now - last) / 1000, 0.25)
      last = now
      drawn = now
      draw(dt)
    }

    const start = () => {
      if (raf || still || !onScreen || !awake) return
      last = performance.now()
      drawn = 0
      raf = requestAnimationFrame(frame)
    }

    const stop = () => {
      if (!raf) return
      cancelAnimationFrame(raf)
      raf = 0
    }

    const resize = new ResizeObserver(() => {
      build()
      draw(0)
    })
    resize.observe(host)

    const seen = new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting)
      if (onScreen) start()
      else stop()
    })
    seen.observe(host)

    const onVisibility = () => {
      awake = !document.hidden
      if (awake) start()
      else stop()
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
        mouse = null
        return
      }
      const now = performance.now()
      const gap = Math.max(1, now - lastMove) / 1000
      const speed = mouse ? Math.hypot(x - mouse.x, y - mouse.y) / gap : 0
      lastMove = now
      mouse = { x, y, speed: mouse ? mouse.speed * 0.7 + speed * 0.3 : 0 }
      renderer.mark(x, y)
    }
    const onLeave = () => {
      mouse = null
    }
    if (interactive && !still) {
      window.addEventListener('pointermove', onMove, { passive: true })
      document.documentElement.addEventListener('pointerleave', onLeave)
    }

    start()

    return () => {
      stop()
      resize.disconnect()
      seen.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
    }
  }, [theme, dark, zoom, interactive])

  if (!theme) return null
  return (
    <div ref={box} aria-hidden className={cn('relative overflow-hidden', className)} style={{ ...style, background: theme.look(dark).backdrop }}>
      <canvas ref={surface} className="absolute top-0 left-0 block" />
    </div>
  )
}

/** O fundo da conversa, com o tema e a força escolhidos no painel Computador. */
export function Wallpaper({ className }: { className?: string }) {
  const theme = useWallpaper((s) => s.theme)
  const intensity = useWallpaper((s) => s.intensity)
  if (theme === 'none') return null
  return <Scene id={theme} interactive className={cn('pointer-events-none absolute inset-0', className)} style={{ opacity: OPACITY[intensity] }} />
}
