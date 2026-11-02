import { useEffect, useMemo, useRef } from 'react'
import { useDarkMode } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { OPACITY, useWallpaper, type ThemeId } from '@/lib/wallpaper'
import { Atlas, Grid } from './grid'
import type { Step } from './scene'
import { themeOf } from './themes'

// Quadros por segundo: é uma grade de caracteres, que não ganha nada acima disso.
const FPS = 12
// Teto de células: em tela grande o caractere cresce em vez de a grade multiplicar.
const MAX_CELLS = 11_000
// Acima de 2x a densidade não aparece na tela e o atlas e os blits ficam três vezes mais caros.
const MAX_DPR = 2

/**
 * Uma cena de ASCII animado preenchendo o elemento. Ela só gasta quadro enquanto está mesmo à vista:
 * fora da tela (outra conversa ao lado, rolagem) e com o app em segundo plano o laço é cancelado, não
 * só ignorado. Com `prefers-reduced-motion` desenha um quadro e para.
 */
export function Scene({
  id,
  zoom = 1,
  className,
  style,
}: {
  id: Exclude<ThemeId, 'none'>
  /** Multiplica o tamanho do caractere; abaixo de 1 cabe mais cena numa miniatura. */
  zoom?: number
  className?: string
  style?: React.CSSProperties
}) {
  const box = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLCanvasElement>(null)
  const dark = useDarkMode()
  const theme = themeOf(id)
  const look = useMemo(() => theme?.look(dark), [theme, dark])

  useEffect(() => {
    const host = box.current
    const el = surface.current
    if (!host || !el || !theme || !look) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches

    let grid: Grid | null = null
    let step: Step | null = null
    let time = 0

    const build = () => {
      const w = host.clientWidth
      const h = host.clientHeight
      if (!w || !h) {
        grid = null
        return
      }
      let px = look.size * zoom
      let atlas = new Atlas(look.chars, look.palette, px, dpr, look.tile)
      // Uma coluna e uma linha a mais do que cabe: a sobra fica fora do recorte, sem faixa vazia.
      let cols = Math.ceil((w * dpr) / atlas.cellW)
      let rows = Math.ceil((h * dpr) / atlas.cellH)
      for (let guard = 0; cols * rows > MAX_CELLS && guard < 4; guard++) {
        px *= Math.sqrt((cols * rows) / MAX_CELLS)
        atlas = new Atlas(look.chars, look.palette, px, dpr, look.tile)
        cols = Math.ceil((w * dpr) / atlas.cellW)
        rows = Math.ceil((h * dpr) / atlas.cellH)
      }
      // Mexer no tamanho já limpa o canvas, então o quadro guardado na grade nova (vazio) confere.
      el.width = cols * atlas.cellW
      el.height = rows * atlas.cellH
      el.style.width = `${el.width / dpr}px`
      el.style.height = `${el.height / dpr}px`
      grid = new Grid(atlas, cols, rows)
      step = theme.create(cols, rows, dark)
      time = 0
    }

    const draw = (dt: number) => {
      if (!grid || !step) return
      time += dt
      grid.clear()
      step(grid, dt, time)
      grid.paint(ctx)
    }

    let raf = 0
    let last = 0
    let drawn = 0
    let onScreen = true
    let awake = !document.hidden

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (now - drawn < 1000 / FPS - 4) return
      const dt = Math.min((now - last) / 1000, 0.25)
      last = now
      drawn = now
      draw(dt)
    }

    // A fonte externa do tema (ver `Theme.attach`) segue o laço: liga quando ele liga e desliga
    // junto, para nada ficar sendo capturado no PC com a cena parada.
    let detach: (() => void) | undefined

    const start = () => {
      if (raf || still || !onScreen || !awake) return
      detach ??= theme.attach?.()
      last = performance.now()
      drawn = 0
      raf = requestAnimationFrame(frame)
    }

    const stop = () => {
      detach?.()
      detach = undefined
      if (!raf) return
      cancelAnimationFrame(raf)
      raf = 0
    }

    const resize = new ResizeObserver(() => {
      build()
      if (still) draw(0)
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
    start()

    return () => {
      stop()
      resize.disconnect()
      seen.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [theme, look, dark, zoom])

  if (!look) return null
  return (
    <div ref={box} aria-hidden className={cn('relative overflow-hidden', className)} style={{ ...style, background: look.backdrop }}>
      <canvas ref={surface} className="absolute top-0 left-0 block" />
    </div>
  )
}

/** O fundo da conversa, com o tema e a força escolhidos no painel Computador. */
export function Wallpaper({ className }: { className?: string }) {
  const theme = useWallpaper((s) => s.theme)
  const intensity = useWallpaper((s) => s.intensity)
  if (theme === 'none') return null
  return <Scene id={theme} className={cn('pointer-events-none absolute inset-0', className)} style={{ opacity: OPACITY[intensity] }} />
}
