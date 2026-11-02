import { ChevronsRight, ListOrdered } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { setMinimap, useMinimap } from '@/lib/minimap'
import { cn } from '@/lib/utils'
import type { Item } from './items'

/** Texto curto do pedido: menções @caminho viram só o nome do arquivo. */
const plain = (text: string) =>
  text
    .replace(/(^|\s)@([^\s]+)/g, (_, space: string, path: string) => `${space}@${path.replace(/\/$/, '').split('/').pop()!.replace(/^\d{13}-/, '')}`)
    .trim()

// Abaixo disso a coluna da conversa encosta na borda, e a linha do tempo ficaria por cima do texto.
const MIN_WIDTH = 860
// Onde a mensagem fica ao pular até ela: logo abaixo do topo, sem colar.
const LAND = 12
// O que a coluna deixa de fora da altura do chat: 12 px no alto, o botão de recolher (24 + 6) e 80 px embaixo,
// onde ficam os botões de descer e de seguir. Calculado, e não medido, para valer já no primeiro desenho.
const TRACK_INSET = 12 + 24 + 6 + 80

type Stop = { key: string; top: number }
type Layout = { stops: Stop[]; height: number; view: number; top: number; track: number; width: number }

/**
 * A linha do tempo da conversa, na borda direita do chat, como o minimapa do VSCode: a coluna inteira é
 * a conversa toda, cada pedido seu é um traço na altura proporcional dele (mais comprido quanto mais
 * longo o pedido), e a faixa clara é o trecho que está na tela. Passar o mouse num traço mostra o
 * pedido; clicar leva até ele; arrastar a faixa rola junto; clicar no vazio pula para aquela altura.
 * Pode ser recolhida num botão, e a escolha fica salva neste aparelho.
 */
export function ChatTimeline({ scrollRef, items }: { scrollRef: React.RefObject<HTMLDivElement | null>; items: Item[] }) {
  // Cada conversa tem a sua: recolher aqui não mexe na da conversa ao lado; a última escolha vale para as próximas.
  const [open, setOpen] = useState(() => useMinimap.getState().timeline)
  const toggle = (next: boolean) => {
    setOpen(next)
    setMinimap({ timeline: next })
  }
  const track = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<Layout | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const drag = useRef<{ y: number; top: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const prompts = useMemo(() => {
    const list = items.filter((i): i is Extract<Item, { type: 'user' }> => i.type === 'user')
    return new Map(list.map((i, n) => [i.key, { n: n + 1, text: plain(i.text) || (i.images?.length ? 'Imagem' : 'Mensagem') }]))
  }, [items])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let frame = 0
    let stops: Stop[] = []
    // As posições só mudam quando o conteúdo muda de tamanho; rolar só move a faixa.
    const measure = () => {
      const base = el.getBoundingClientRect().top - el.scrollTop
      stops = [...el.querySelectorAll<HTMLElement>('[data-user-msg]')].map((node) => ({
        key: node.dataset.userMsg ?? '',
        top: node.getBoundingClientRect().top - base,
      }))
    }
    const update = () => {
      frame = 0
      setLayout({
        stops,
        height: el.scrollHeight,
        view: el.clientHeight,
        top: el.scrollTop,
        track: Math.max(0, el.clientHeight - TRACK_INSET),
        width: el.clientWidth,
      })
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    const resized = () => {
      measure()
      schedule()
    }
    el.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(resized)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    resized()
    return () => {
      el.removeEventListener('scroll', schedule)
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [scrollRef, items])

  const el = scrollRef.current
  // Conversa curta, que cabe na tela, ou coluna estreita: a linha do tempo não ajuda e só atrapalha.
  const useful = layout && layout.width >= MIN_WIDTH && layout.stops.length >= 2 && layout.height > layout.view * 1.2
  if (!useful || !el) return null

  if (!open)
    return (
      <button
        type="button"
        onClick={() => toggle(true)}
        aria-label="Mostrar a linha do tempo da conversa"
        title="Linha do tempo"
        className="pointer-events-auto absolute top-3 right-3 z-10 flex h-7 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <ListOrdered className="size-3.5" />
        <span className="tabular-nums">{layout.stops.length}</span>
      </button>
    )

  const scale = layout.track / Math.max(1, layout.height)
  const viewTop = layout.top * scale
  const viewHeight = Math.max(18, layout.view * scale)
  // O pedido do trecho na tela: o último cujo começo já passou da metade da vista. No fim da conversa,
  // o último que aparece, senão o pedido final, curto e já à vista, nunca acenderia.
  const atEnd = layout.top + layout.view >= layout.height - 4
  const line = atEnd ? layout.top + layout.view : layout.top + layout.view * 0.5
  const reading = layout.stops.reduce<string | null>((at, s) => (s.top <= line ? s.key : at), null)
  const shown = hover ? prompts.get(hover) : undefined
  const shownStop = hover ? layout.stops.find((s) => s.key === hover) : undefined

  const jumpTo = (stop: Stop) => el.scrollTo({ top: Math.max(0, stop.top - LAND), behavior: 'smooth' })

  return (
    <div className="pointer-events-none absolute top-3 right-2 bottom-20 z-10 flex w-8 flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={() => toggle(false)}
        aria-label="Recolher a linha do tempo"
        title="Recolher a linha do tempo"
        className="pointer-events-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <ChevronsRight className="size-3.5" />
      </button>
      <div
        ref={track}
        role="navigation"
        aria-label="Linha do tempo da conversa"
        className="group/timeline pointer-events-auto relative w-full min-h-0 flex-1 cursor-pointer"
        onPointerDown={(e) => {
          // No vazio: pula para aquela altura, com a altura no meio da tela.
          if (e.target !== e.currentTarget || e.button !== 0) return
          const y = e.clientY - e.currentTarget.getBoundingClientRect().top
          el.scrollTo({ top: y / scale - layout.view / 2, behavior: 'smooth' })
        }}
      >
        {/* O trilho: um fio no meio, para a coluna existir mesmo entre os pedidos. */}
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-2 w-px bg-foreground/10" />
        {/* O trecho na tela. Arrastar rola a conversa na mesma proporção. */}
        <span
          aria-hidden
          className={cn(
            'absolute right-0 w-4 rounded-md transition-colors',
            dragging ? 'bg-foreground/20' : 'bg-foreground/[0.08] group-hover/timeline:bg-foreground/[0.12]',
          )}
          style={{ top: viewTop, height: viewHeight }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { y: e.clientY, top: layout.top }
            setDragging(true)
          }}
          onPointerMove={(e) => {
            if (!drag.current) return
            el.scrollTop = drag.current.top + (e.clientY - drag.current.y) / scale
          }}
          onPointerUp={() => {
            drag.current = null
            setDragging(false)
          }}
          onPointerCancel={() => {
            drag.current = null
            setDragging(false)
          }}
        />
        {layout.stops.map((s) => {
          const info = prompts.get(s.key)
          const long = (info?.text.length ?? 0) > 160 ? 2 : (info?.text.length ?? 0) > 50 ? 1 : 0
          const active = s.key === reading
          return (
            <button
              key={s.key}
              type="button"
              aria-label={info ? `Pedido ${info.n}: ${info.text.slice(0, 80)}` : 'Pedido'}
              onClick={() => jumpTo(s)}
              onPointerEnter={() => setHover(s.key)}
              onPointerLeave={() => setHover((h) => (h === s.key ? null : h))}
              onFocus={() => setHover(s.key)}
              onBlur={() => setHover((h) => (h === s.key ? null : h))}
              className="absolute right-0 flex h-3 w-full -translate-y-1/2 items-center justify-end outline-none"
              style={{ top: s.top * scale }}
            >
              <span
                className={cn(
                  'h-[3px] rounded-full transition-[width,background-color] duration-200',
                  active ? 'bg-foreground' : 'bg-foreground/35',
                  hover === s.key && 'bg-foreground',
                  [active ? 'w-5' : 'w-3', active ? 'w-6' : 'w-4', active ? 'w-7' : 'w-5'][long],
                )}
              />
            </button>
          )
        })}
        {shown && shownStop && (
          <div
            className="pointer-events-none absolute right-full mr-2 w-72 -translate-y-1/2 animate-in rounded-lg bg-popover px-3 py-2 text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-150 fade-in-0 zoom-in-95"
            style={{ top: Math.min(Math.max(shownStop.top * scale, 24), layout.track - 24) }}
          >
            <div className="text-[11px] text-muted-foreground tabular-nums">
              Pedido {shown.n} de {prompts.size}
            </div>
            <div className="line-clamp-3 text-xs whitespace-pre-wrap">{shown.text}</div>
          </div>
        )}
      </div>
    </div>
  )
}
