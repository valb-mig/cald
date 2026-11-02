import { useEffect, useRef } from 'react'
import type { ThemedToken } from 'shiki/core'
import { useDarkMode } from '@/lib/hooks'
import type { Mark } from './changes'

// Largura do mapa e o tamanho de cada caractere nele, em pixels de CSS: um traço por caractere, como o
// minimapa do VSCode sem letras.
const WIDTH = 96
const LINE = 2
const CHAR = 0.9
const TAB = 4
// As marcas de mudança: no diff tingem a linha toda; no arquivo, uma faixa na borda, como no VSCode.
const MARK_RGB: Record<Mark, string> = { add: '16 185 129', del: '239 68 68', mod: '14 165 233', hunk: '14 165 233' }
const STRIP = 3

/** Desenha os trechos sem espaço de `text` a partir da coluna `col`; devolve a coluna em que parou. */
function paint(ctx: CanvasRenderingContext2D, text: string, col: number, y: number): number {
  let start = -1
  for (let k = 0; k <= text.length; k++) {
    const ch = text[k]
    const blank = ch === undefined || ch === ' ' || ch === '\t'
    if (!blank && start < 0) start = col
    if (blank && start >= 0) {
      ctx.fillRect(start * CHAR, y, (col - start) * CHAR, LINE - 0.6)
      start = -1
    }
    if (ch === undefined) break
    col += ch === '\t' ? TAB - (col % TAB) : 1
    if (col * CHAR > WIDTH) {
      if (start >= 0) ctx.fillRect(start * CHAR, y, WIDTH - start * CHAR, LINE - 0.6)
      return col
    }
  }
  return col
}

/**
 * O minimapa do código aberto, à direita, como o do VSCode: o arquivo inteiro em traços finos com as
 * cores do realce, e a faixa clara mostrando o trecho na tela. Arquivo mais alto que o mapa faz o mapa
 * rolar junto, na proporção. Clicar leva até aquele ponto (no meio da tela); arrastar a faixa rola o
 * código. Só redesenha quando o código rola ou muda de tamanho. `marks` pinta as mudanças: com `tint`
 * (o diff), a linha toda; sem, uma faixa na borda esquerda (o arquivo, com o que mudou desde o commit).
 */
export function CodeMinimap({
  scrollRef,
  lines,
  tokens,
  marks,
  tint = false,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  lines: string[]
  tokens: (ThemedToken[] | undefined)[] | null
  marks?: (Mark | undefined)[]
  tint?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLCanvasElement>(null)
  const dark = useDarkMode()

  useEffect(() => {
    const el = scrollRef.current
    const host = box.current
    const cv = surface.current
    if (!el || !host || !cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const ink = dark ? 'rgb(225 225 225)' : 'rgb(40 40 40)'
    const content = lines.length * LINE
    let mapH = 0
    let dpr = 1
    let frame = 0
    let hover = false
    let drag: { y: number; top: number } | null = null
    // A geometria do último desenho, para o ponteiro saber onde está a faixa.
    const geo = { offset: 0, sliderTop: 0, sliderH: 0 }

    const draw = () => {
      frame = 0
      const H = el.scrollHeight
      const V = el.clientHeight
      const T = el.scrollTop
      const ratio = H > V ? T / (H - V) : 0
      geo.offset = Math.max(0, content - mapH) * ratio
      geo.sliderH = Math.max(8, (V / Math.max(1, H)) * content)
      geo.sliderTop = (T / Math.max(1, H)) * content - geo.offset

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, WIDTH, mapH)
      ctx.globalAlpha = 0.8
      const first = Math.floor(geo.offset / LINE)
      const last = Math.min(lines.length, Math.ceil((geo.offset + mapH) / LINE))
      // As marcas primeiro, por baixo dos traços. Num trecho comprido, linhas vizinhas viram uma faixa só.
      if (marks) {
        for (let i = first; i < last; i++) {
          const mark = marks[i]
          if (!mark) continue
          const y = i * LINE - geo.offset
          ctx.globalAlpha = 1
          ctx.fillStyle = `rgb(${MARK_RGB[mark]} / ${tint ? (mark === 'hunk' ? 0.5 : 0.3) : 0.9})`
          if (tint) ctx.fillRect(0, y, WIDTH, mark === 'hunk' ? 1 : LINE)
          else ctx.fillRect(0, y, STRIP, LINE)
        }
        ctx.globalAlpha = 0.8
      }
      for (let i = first; i < last; i++) {
        const y = i * LINE - geo.offset
        const row = tokens?.[i]
        if (row?.length) {
          let col = tint || !marks ? 0 : 3
          for (const t of row) {
            ctx.fillStyle = t.color ?? ink
            col = paint(ctx, t.content, col, y)
            if (col * CHAR > WIDTH) break
          }
        } else {
          ctx.globalAlpha = 0.35
          ctx.fillStyle = ink
          paint(ctx, lines[i] ?? '', tint || !marks ? 0 : 3, y)
          ctx.globalAlpha = 0.8
        }
      }
      ctx.globalAlpha = 1
      ctx.fillStyle = dark ? `rgb(255 255 255 / ${drag ? 0.16 : hover ? 0.12 : 0.07})` : `rgb(0 0 0 / ${drag ? 0.14 : hover ? 0.1 : 0.06})`
      ctx.fillRect(0, geo.sliderTop, WIDTH, geo.sliderH)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw)
    }
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      mapH = host.clientHeight
      cv.width = Math.round(WIDTH * dpr)
      cv.height = Math.round(mapH * dpr)
      cv.style.width = `${WIDTH}px`
      cv.style.height = `${mapH}px`
      schedule()
    }

    const local = (e: PointerEvent) => e.clientY - cv.getBoundingClientRect().top
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const y = local(e)
      // Fora da faixa: leva o ponto clicado para o meio da tela, e segue arrastando dali.
      if (y < geo.sliderTop || y > geo.sliderTop + geo.sliderH) {
        const line = (y + geo.offset) / LINE
        el.scrollTop = (line / Math.max(1, lines.length)) * el.scrollHeight - el.clientHeight / 2
      }
      cv.setPointerCapture(e.pointerId)
      drag = { y: e.clientY, top: el.scrollTop }
      schedule()
    }
    const onMove = (e: PointerEvent) => {
      const y = local(e)
      const over = y >= geo.sliderTop && y <= geo.sliderTop + geo.sliderH
      if (over !== hover) {
        hover = over
        schedule()
      }
      if (!drag) return
      // A faixa anda pelo trecho visível do mapa; o código, por tudo o que dá para rolar.
      const room = Math.max(1, Math.min(content, mapH) - geo.sliderH)
      el.scrollTop = drag.top + ((e.clientY - drag.y) * (el.scrollHeight - el.clientHeight)) / room
    }
    const onUp = () => {
      drag = null
      schedule()
    }
    const onLeave = () => {
      hover = false
      schedule()
    }

    el.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    cv.addEventListener('pointerdown', onDown)
    cv.addEventListener('pointermove', onMove)
    cv.addEventListener('pointerup', onUp)
    cv.addEventListener('pointercancel', onUp)
    cv.addEventListener('pointerleave', onLeave)
    resize()
    return () => {
      el.removeEventListener('scroll', schedule)
      observer.disconnect()
      cv.removeEventListener('pointerdown', onDown)
      cv.removeEventListener('pointermove', onMove)
      cv.removeEventListener('pointerup', onUp)
      cv.removeEventListener('pointercancel', onUp)
      cv.removeEventListener('pointerleave', onLeave)
      cancelAnimationFrame(frame)
    }
  }, [scrollRef, lines, tokens, marks, tint, dark])

  return (
    <div ref={box} aria-hidden className="relative w-24 shrink-0 cursor-default overflow-hidden">
      <canvas ref={surface} className="absolute top-0 left-0 block touch-none" />
    </div>
  )
}
