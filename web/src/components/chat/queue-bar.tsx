import { ArrowUp, Check, ChevronDown, GripVertical, ListEnd, Paperclip, Pause, Play, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { ProviderMark } from '@/components/provider-mark'
import { api, errorMessage } from '@/lib/api'
import { closeQueued, openQueued, useQueueEdit } from '@/lib/queue-edit'
import type { QueueItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { EFFORTS, prettyModel } from './composer-controls'

/** Quanto o ponteiro anda, com o botão apertado, antes de virar arrasto: menos que isso é um clique. */
const DRAG_FROM = 4
/** O deslizar das linhas que abrem espaço, e o encaixe da que foi solta. */
const SLIDE = 'transform 160ms ease-out'

/** Os botões de cada linha: no celular, estreitos o bastante para caberem quatro sem esmagar o texto. */
const ACTION =
  'flex h-11 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground wide:size-8'

const FOLDED_KEY = 'cr:queue-folded'

/** A fila recolhida, só no cabeçalho: uma preferência do aparelho, para ela não ocupar a vista. */
const useFolded = create<{ folded: boolean }>(() => {
  try {
    return { folded: localStorage.getItem(FOLDED_KEY) === '1' }
  } catch {
    return { folded: false }
  }
})

function toggleFolded(): void {
  const folded = !useFolded.getState().folded
  useFolded.setState({ folded })
  try {
    localStorage.setItem(FOLDED_KEY, folded ? '1' : '0')
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}

const idsOf = (queue?: QueueItem[]) => queue?.map((q) => q.id).join() ?? ''

/** Modelo e esforço com que a mensagem vai; vazio se nenhum foi escolhido. */
function settingsLabel(item: Pick<QueueItem, 'model' | 'effort'>): string {
  return [item.model && prettyModel(item.model), item.effort && (EFFORTS[item.effort] ?? item.effort)].filter(Boolean).join(' · ')
}

/**
 * O arrasto de uma linha. `y`: o ponteiro, a partir do topo da lista; `grab`: onde ele pegou a linha,
 * a partir do topo dela; `ids`: a ordem enquanto ela anda. Só vira arrasto depois de `DRAG_FROM`.
 */
type Drag = { id: string; pointer: number; startY: number; y: number; grab: number; ids: string[]; moved: boolean }

/** A linha arrastada sob o ponteiro, sem passar da primeira nem da última posição da lista. */
function lift(el: HTMLElement, d: Drag): void {
  const tops = [...(el.parentElement?.children ?? [])].map((r) => (r as HTMLElement).offsetTop)
  const y = Math.max(Math.min(...tops), Math.min(Math.max(...tops), d.y - d.grab))
  el.style.transition = 'none'
  el.style.transform = `translateY(${y - el.offsetTop}px)`
}

/**
 * A fila de mensagens, no alto da casca da caixa (o `above` do Composer): o que foi escrito com o Claude
 * trabalhando e sai sozinho no fim do turno. O cabeçalho diz quantas são e recolhe a lista. Cada linha
 * se arrasta (ponteiro, não o arrastar do HTML5, que não solta no app do PC), se pausa (fica no lugar e a
 * fila passa por ela), se envia na hora ou se tira, com desfazer. Tocar no texto abre a mensagem na caixa, sem tirá-la da fila (ver lib/queue-edit.ts):
 * tocar em outra troca, e tocar de novo, ou no ✓, grava e fecha.
 */
export function QueueBar({
  sessionId,
  provider,
  queue,
  paused,
}: {
  sessionId: string
  /** O agente da conversa: a marca dele vai no selo de cada mensagem. */
  provider: string
  queue?: QueueItem[]
  paused?: boolean
}) {
  // A ordem do arrasto, sobre a fila `of` de quando ele começou: vale enquanto o catálogo ainda traz a ordem
  // de antes; quando chega outra (a nova, ou a de outro aparelho), o catálogo volta a mandar.
  const [custom, setOrder] = useState<{ ids: string[]; of: QueueItem[] | undefined } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())
  // Onde cada linha estava no último desenho, para as que mudam de lugar deslizarem até o novo.
  const tops = useRef(new Map<string, number>())
  const drag = useRef<Drag | null>(null)
  const folded = useFolded((s) => s.folded)
  const editing = useQueueEdit((s) => s[sessionId])
  // Abrindo ou recolhendo: só então a lista é cortada, para a linha levantada no arrasto não ser.
  const [sliding, setSliding] = useState(false)
  const order = custom && idsOf(custom.of) === idsOf(queue) ? custom.ids : null

  // A linha arrastada fica sob o ponteiro; as outras saem do lugar antigo e deslizam até o novo (FLIP).
  useLayoutEffect(() => {
    for (const [id, el] of rows.current) {
      const before = tops.current.get(id)
      const now = el.offsetTop
      tops.current.set(id, now)
      const d = drag.current
      if (d?.moved && d.id === id) {
        lift(el, d)
        continue
      }
      if (before === undefined || before === now) continue
      el.style.transition = 'none'
      el.style.transform = `translateY(${before - now}px)`
      requestAnimationFrame(() => {
        el.style.transition = SLIDE
        el.style.transform = ''
      })
    }
  })

  if (!queue?.length) return null
  const items = order ? order.flatMap((id) => queue.find((q) => q.id === id) ?? []) : queue

  const fail = (title: string) => (err: unknown) => toast.error(title, { description: errorMessage(err) })

  const take = async (item: QueueItem) => api.takeQueued(sessionId, item.id)

  const remove = async (item: QueueItem, index: number) => {
    try {
      const message = await take(item)
      toast('Tirada da fila', {
        action: { label: 'Desfazer', onClick: () => void api.restoreQueued(sessionId, message, index).catch(fail('Não deu para desfazer')) },
      })
    } catch (err) {
      fail('Não deu para tirar da fila')(err)
    }
  }

  const edit = (item: QueueItem) => openQueued(sessionId, item.id).catch(fail('Não deu para abrir a mensagem'))

  const start = (e: React.PointerEvent, id: string) => {
    const target = e.target as HTMLElement
    if (e.button !== 0 || target.closest('[data-no-drag]')) return
    // No toque, só pela alça: no resto da linha o dedo rola a tela.
    if (e.pointerType === 'touch' && !target.closest('[data-grip]')) return
    const el = rows.current.get(id)
    const top = list.current?.getBoundingClientRect().top
    if (!el || top === undefined) return
    // Sem isto, apertar e arrastar seleciona o texto das linhas.
    e.preventDefault()
    const y = e.clientY - top
    drag.current = { id, pointer: e.pointerId, startY: e.clientY, y, grab: y - el.offsetTop, ids: items.map((q) => q.id), moved: false }
  }

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const el = d && rows.current.get(d.id)
    const top = list.current?.getBoundingClientRect().top
    if (!d || !el || top === undefined || e.pointerId !== d.pointer) return
    if (!d.moved) {
      if (Math.abs(e.clientY - d.startY) < DRAG_FROM) return
      // Só agora o ponteiro fica preso, e na lista, não na linha: o React move a linha no DOM a cada troca de
      // lugar, e isso soltaria o ponteiro. Antes, soltar ainda é o clique do texto (editar).
      d.moved = true
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(d.id)
    }
    d.y = e.clientY - top
    // Onde ela cai: as linhas têm a mesma altura, então é onde o topo dela está, em linhas a partir da primeira.
    const first = Math.min(...[...rows.current.values()].map((r) => r.offsetTop))
    const at = Math.max(0, Math.min(d.ids.length - 1, Math.round((d.y - d.grab - first) / el.offsetHeight)))
    const next = d.ids.filter((i) => i !== d.id)
    next.splice(at, 0, d.id)
    if (next.join() !== d.ids.join()) {
      d.ids = next
      setOrder({ ids: next, of: queue })
    } else lift(el, d)
  }

  const finish = (commit: boolean) => {
    const d = drag.current
    drag.current = null
    if (!d?.moved) return
    // Solta: ela encaixa no lugar novo.
    const el = rows.current.get(d.id)
    if (el) {
      el.style.transition = SLIDE
      el.style.transform = ''
    }
    setDragging(null)
    if (!commit) {
      setOrder(null)
      return
    }
    if (d.ids.join() === idsOf(queue)) return
    api.orderQueue(sessionId, d.ids).catch((err: unknown) => {
      setOrder(null)
      fail('Não deu para reordenar')(err)
    })
  }

  return (
    <div className="pb-1">
      {/* O cabeçalho, no jeito da linha da branch logo abaixo: quantas esperam, se a fila está pausada, e recolher. */}
      <button
        type="button"
        onClick={() => {
          // Com movimento reduzido não há transição, nem o fim dela para tirar o corte.
          if (!matchMedia('(prefers-reduced-motion: reduce)').matches) setSliding(true)
          toggleFolded()
        }}
        aria-expanded={!folded}
        title={paused ? 'Pausada: segue quando você mandar uma' : folded ? 'Mostrar a fila' : 'Recolher a fila'}
        className="flex h-8 w-full items-center gap-1.5 rounded-lg pl-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ListEnd className="size-3 shrink-0" />
        <span className="truncate">
          {queue.length} na fila
          {paused && ' · pausada'}
        </span>
        <span className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md">
          <ChevronDown className={cn('size-3.5 transition-transform', folded && '-rotate-90')} />
        </span>
      </button>
      <div
        className={cn(
          // Coluna `minmax(0,1fr)`: o texto longo de uma linha corta nela em vez de alargar a lista toda.
          'grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
          folded ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
        )}
        inert={folded}
        onTransitionEnd={(e) => e.target === e.currentTarget && setSliding(false)}
      >
        <div className={cn('min-h-0 min-w-0', (folded || sliding) && 'overflow-hidden')}>
          <div
            ref={list}
            onPointerMove={move}
            onPointerUp={() => finish(true)}
            onPointerCancel={() => finish(false)}
            onLostPointerCapture={() => finish(true)}
            className="relative select-none"
          >
            {items.map((item, i) => {
              const open = editing?.id === item.id
              // Aberta na caixa, o selo acompanha o seletor de lá.
              const label = settingsLabel(open ? editing : item)
              const thumbs = item.attachments.filter((a) => a.thumb)
              const others = item.attachments.length - thumbs.length
              const lifted = dragging === item.id
              return (
                <div
                  key={item.id}
                  ref={(el) => {
                    if (!el) return
                    rows.current.set(item.id, el)
                    return () => void rows.current.delete(item.id)
                  }}
                  onPointerDown={(e) => start(e, item.id)}
                  className={cn(
                    'relative flex min-h-11 items-center gap-1 rounded-xl wide:min-h-9 wide:cursor-grab hover:bg-foreground/[0.04]',
                    // A aberta na caixa: um tom acima das outras.
                    open && 'bg-foreground/[0.08] hover:bg-foreground/[0.08]',
                    // Levantada: sobre as outras, com sombra, seguindo o ponteiro.
                    lifted && 'z-10 scale-[1.02] cursor-grabbing bg-popover shadow-lg ring-1 ring-foreground/10 wide:cursor-grabbing',
                  )}
                >
                  <span
                    data-grip
                    aria-hidden
                    className="flex h-11 w-8 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground wide:h-9 wide:w-6"
                  >
                    <GripVertical className="size-4" />
                  </span>
                  <button
                    type="button"
                    onClick={() => void edit(item)}
                    aria-pressed={open}
                    title={open ? 'Salvar e fechar' : 'Abrir na caixa'}
                    className={cn('min-w-0 flex-1 truncate text-left text-sm wide:cursor-[inherit]', item.paused && 'text-muted-foreground')}
                  >
                    {item.text || <span className="text-muted-foreground">Só anexos</span>}
                  </button>
                  {thumbs.slice(0, 2).map((a, n) => (
                    <img key={n} src={a.thumb} alt="" className="size-6 shrink-0 rounded-md object-cover" />
                  ))}
                  {(others > 0 || thumbs.length > 2) && (
                    <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                      <Paperclip className="size-3.5" />
                      {others + Math.max(0, thumbs.length - 2)}
                    </span>
                  )}
                  <span className="flex max-w-36 shrink-0 items-center gap-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-muted-foreground">
                    <ProviderMark id={provider} className="size-3" />
                    {label && <span className="truncate">{label}</span>}
                  </span>
                  {open ? (
                    // Aberta, o que vale é o que está na caixa: no lugar de enviar e tirar, gravar e fechar.
                    <button
                      type="button"
                      data-no-drag
                      title="Salvar e fechar"
                      aria-label="Salvar e fechar"
                      onClick={() => closeQueued(sessionId).catch(fail('Não deu para salvar na fila'))}
                      className={cn(ACTION, 'text-foreground')}
                    >
                      <Check className="size-4" />
                    </button>
                  ) : (
                    <>
                      {/* Pausada, ela espera você: o ▷ em âmbar solta, e ela vai na vez dela (ou já, com a conversa parada). */}
                      <button
                        type="button"
                        data-no-drag
                        title={item.paused ? 'Retomar' : 'Pausar'}
                        aria-label={item.paused ? 'Retomar' : 'Pausar'}
                        aria-pressed={Boolean(item.paused)}
                        onClick={() => api.pauseQueued(sessionId, item.id, !item.paused).catch(fail(item.paused ? 'Não deu para retomar' : 'Não deu para pausar'))}
                        className={cn(ACTION, item.paused && 'text-amber-600 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-400')}
                      >
                        {item.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                      </button>
                      <button
                        type="button"
                        data-no-drag
                        title="Enviar agora"
                        aria-label="Enviar agora"
                        onClick={() => api.sendQueued(sessionId, item.id).catch(fail('Não deu para enviar'))}
                        className={ACTION}
                      >
                        <ArrowUp className="size-4" />
                      </button>
                      <button
                        type="button"
                        data-no-drag
                        title="Tirar da fila"
                        aria-label="Tirar da fila"
                        onClick={() => void remove(item, i)}
                        className={ACTION}
                      >
                        <X className="size-4" />
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
