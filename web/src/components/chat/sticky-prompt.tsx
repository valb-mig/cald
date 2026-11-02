import { ArrowUp, ChevronDown, ChevronUp, ImageIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useGlass } from '@/lib/wallpaper'
import type { Item } from './items'

// Folga para a mensagem contar como "já passou": a faixa cobre o comecinho da conversa.
const PASSED_PX = 8

/** Texto curto da mensagem: menções @caminho viram só o nome do arquivo. */
const plain = (text: string) =>
  text.replace(/(^|\s)@([^\s]+)/g, (_, space: string, path: string) => `${space}@${path.replace(/\/$/, '').split('/').pop()!.replace(/^\d{13}-/, '')}`)

/**
 * Faixa logo abaixo do cabeçalho com a sua mensagem do trecho que está na tela: aparece quando ela
 * rola para cima e sai de vista e, subindo até a resposta anterior, troca para a mensagem de lá.
 */
export function StickyPrompt({ scrollRef, items }: { scrollRef: React.RefObject<HTMLDivElement | null>; items: Item[] }) {
  const [key, setKey] = useState<string | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let frame = 0
    const update = () => {
      frame = 0
      const top = el.getBoundingClientRect().top
      // A última mensagem sua cujo começo já subiu além do topo: é a do trecho na tela.
      let current: HTMLElement | null = null
      for (const node of el.querySelectorAll<HTMLElement>('[data-user-msg]')) {
        if (node.getBoundingClientRect().top < top) current = node
        else break
      }
      // Ainda aparece inteira ou em parte: a faixa só repetiria.
      const passed = current && current.getBoundingClientRect().bottom < top + PASSED_PX
      setKey(passed ? (current!.dataset.userMsg ?? null) : null)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    el.addEventListener('scroll', schedule, { passive: true })
    // Conteúdo que cresce (mensagem nova, resposta chegando) muda quem passou sem rolar.
    const resize = new ResizeObserver(schedule)
    if (el.firstElementChild) resize.observe(el.firstElementChild)
    schedule()
    return () => {
      el.removeEventListener('scroll', schedule)
      resize.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [scrollRef])

  const item = key ? items.find((i): i is Extract<Item, { type: 'user' }> => i.type === 'user' && i.key === key) : undefined
  return item ? <Bar key={item.key} item={item} scrollRef={scrollRef} /> : null
}

/**
 * A faixa em si. Mensagem que não cabe em duas linhas abre inteira ali mesmo, com rolagem própria,
 * para rever o pedido sem perder o ponto da resposta; curta, tocar leva até ela. Trocar de mensagem
 * recria a faixa (a `key`), e ela volta fechada.
 */
function Bar({ item, scrollRef }: { item: Extract<Item, { type: 'user' }>; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const [open, setOpen] = useState(false)
  const [clamped, setClamped] = useState(false)
  const textRef = useRef<HTMLSpanElement>(null)
  const glass = useGlass()
  const text = plain(item.text).trim()
  const images = item.images?.length ?? 0

  // Cortada pelas duas linhas? Muda com a largura da tela.
  useLayoutEffect(() => {
    const el = textRef.current
    if (!el || open) return
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [open, text])

  const goTo = () => {
    setOpen(false)
    scrollRef.current?.querySelector(`[data-user-msg="${CSS.escape(item.key)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 z-10 border-b backdrop-blur',
        // No PC, sem linha: o pé da faixa esfumaça na conversa que rola por baixo.
        'wide:border-b-0 wide:pb-3 wide:[mask-image:linear-gradient(to_bottom,#000_calc(100%-0.75rem),transparent)]',
        glass ? 'bg-background/70' : 'bg-background/90',
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col items-end gap-1.5 px-4 py-1.5">
        {open ? (
          // Aberta: a mensagem inteira, rolando dentro da faixa até metade da tela (dá para selecionar o texto).
          <div className="pointer-events-auto max-h-[45dvh] max-w-[85%] min-w-0 overflow-y-auto rounded-2xl rounded-br-md bg-primary px-3 py-1.5 text-sm break-words whitespace-pre-wrap text-primary-foreground shadow-sm">
            {text || 'Imagem'}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => (clamped ? setOpen(true) : goTo())}
            aria-expanded={clamped ? false : undefined}
            className="pointer-events-auto flex max-w-[85%] min-w-0 items-start gap-1.5 rounded-2xl rounded-br-md bg-primary px-3 py-1.5 text-left text-sm text-primary-foreground shadow-sm transition-[filter] hover:brightness-110"
            aria-label={clamped ? `Sua mensagem: ${text || 'imagem'}. Tocar para ver inteira` : `Sua mensagem: ${text || 'imagem'}. Tocar para ir até ela`}
          >
            {images > 0 && (
              <span className="mt-0.5 flex shrink-0 items-center gap-0.5 text-xs opacity-80">
                <ImageIcon className="size-3.5" />
                {images > 1 && images}
              </span>
            )}
            <span ref={textRef} className="line-clamp-2 min-w-0 break-words whitespace-pre-wrap compact:line-clamp-1">
              {text || 'Imagem'}
            </span>
            {clamped && <ChevronDown className="mt-0.5 size-4 shrink-0 opacity-80" aria-hidden />}
          </button>
        )}
        {open && (
          <div className="pointer-events-auto flex gap-1.5">
            <Button variant="outline" size="xs" onClick={goTo}>
              <ArrowUp /> Ir até a mensagem
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setOpen(false)}>
              <ChevronUp /> Recolher
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
