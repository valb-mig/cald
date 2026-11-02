import { AtSign, Copy, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useMediaQuery } from '@/lib/hooks'
import { mention } from './file-menu'

/**
 * Seleção de linhas do código, própria do app, para mencionar um trecho no chat como o Alt+Ctrl+K da
 * extensão do VSCode (`@caminho#L10-20`). A seleção do navegador não serve: ela apaga quando o menu
 * abre e leva o foco. Esta é desenhada por uma camada só sobre as linhas, sem redesenhar o código.
 *
 * O código marca cada linha com `data-row` (a ordem na tela; no diff, cabeçalhos dos trechos também),
 * `data-line` (o número no arquivo; no diff, só as que existem no arquivo novo) e `data-code` (as que
 * são código, para copiar). Os números da margem são desenhados pelo CSS (`data-n`).
 */

type Span = { anchor: number; head: number }

const LONG_PRESS_MS = 500
// Dedo que andou mais que isso está rolando o código, não segurando.
const MOVE_TOLERANCE = 10

const ordered = (s: Span) => [Math.min(s.anchor, s.head), Math.max(s.anchor, s.head)] as const
const rowOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>('[data-row]') : null)
// O número da linha (a margem): no toque, é onde se escolhe a linha, para o resto do código seguir rolando.
const onGutter = (target: EventTarget | null) => target instanceof Element && target.hasAttribute('data-n')

/** As linhas do arquivo e o texto das linhas na faixa da seleção. */
function readSpan(container: HTMLElement, span: Span) {
  const [a, b] = ordered(span)
  const rows = [...container.querySelectorAll<HTMLElement>('[data-row]')].filter((el) => {
    const i = Number(el.dataset.row)
    return i >= a && i <= b
  })
  const lines = rows.filter((el) => el.dataset.line).map((el) => Number(el.dataset.line))
  // Linha vazia vai como um espaço, para não sumir na tela; ao copiar, volta a ser vazia.
  const text = rows
    .filter((el) => el.hasAttribute('data-code'))
    .map((el) => (el.textContent === ' ' ? '' : (el.textContent ?? '')))
    .join('\n')
  return { lines: lines.length ? ([Math.min(...lines), Math.max(...lines)] as [number, number]) : null, text }
}

const label = ([from, to]: [number, number]) => (from === to ? `linha ${from}` : `linhas ${from}–${to}`)

function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success('Copiado'),
    () => toast.error('Não deu para copiar'),
  )
}

/**
 * Liga o código de `path` à seleção de linhas. No PC: arrastar seleciona, clicar no número escolhe a
 * linha, Shift+clique estende, o botão direito abre o menu (com a seleção, ou a linha clicada), Ctrl+C
 * copia e Esc limpa. No toque: tocar no número escolhe a linha e tocar em outro estende; segurar o dedo
 * numa linha também a escolhe; o botão do rodapé menciona.
 */
export function useCodeSelection(path: string) {
  const container = useRef<HTMLDivElement>(null)
  const band = useRef<HTMLDivElement>(null)
  const touch = useMediaQuery('(pointer: coarse)')
  // A seleção e o que ela tem (linhas do arquivo, texto), lido do código quando ela muda.
  const [selection, setSelection] = useState<{ span: Span; lines: [number, number] | null; text: string } | null>(null)
  const span = selection?.span ?? null
  // Onde foi o último clique sem seleção, para o Shift+clique estender a partir dele, como num editor.
  const cursor = useRef<number | null>(null)
  const pointer = useRef('mouse')
  // Dedo segurado numa linha (no iPhone isso não vira `contextmenu`, então o tempo é contado aqui).
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const held = useRef(false)
  const [menu, setMenu] = useState<{ x: number; y: number; lines: [number, number] | null; text: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuShown = useRef(false)
  useEffect(() => {
    menuShown.current = menuOpen
  }, [menuOpen])

  // A faixa de destaque: do topo da primeira linha ao fim da última, por cima delas.
  useLayoutEffect(() => {
    const el = container.current
    const mark = band.current
    if (!el || !mark) return
    const place = () => {
      const [a, b] = span ? ordered(span) : [-1, -1]
      const first = el.querySelector<HTMLElement>(`[data-row="${a}"]`)
      const last = el.querySelector<HTMLElement>(`[data-row="${b}"]`)
      mark.style.display = first && last ? 'block' : 'none'
      if (!first || !last) return
      mark.style.top = `${first.offsetTop}px`
      mark.style.height = `${last.offsetTop + last.offsetHeight - first.offsetTop}px`
      mark.style.width = `${el.scrollWidth}px`
    }
    place()
    // Quebrar linhas ou mudar a janela muda a altura delas: a faixa acompanha.
    const observer = new ResizeObserver(place)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [span])

  // Esc limpa a seleção antes de fechar o arquivo; Ctrl+C copia as linhas.
  useEffect(() => {
    if (!span) return
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))
      // Com o menu aberto, o Esc é dele: fecha o menu, e a seleção fica.
      if (typing || menuShown.current || !container.current) return
      if (e.key === 'Escape') {
        e.preventDefault()
        setSelection(null)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !getSelection()?.toString()) {
        e.preventDefault()
        copy(selection!.text)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [span, selection])

  const select = (next: Span | null) => {
    const el = container.current
    setSelection(next && el ? { span: next, ...readSpan(el, next) } : null)
    if (next) cursor.current = next.head
  }

  const send = (lines: [number, number]) => {
    setSelection(null)
    mention(path, { lines })
  }

  const release = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    pointer.current = e.pointerType
    if (e.pointerType !== 'mouse') {
      // Segundo dedo é pinça (fonte do código), não dedo segurado.
      if (press.current) return release()
      // Segurar o dedo escolhe a linha (ou estende até ela); mexer o dedo é rolar, e cancela.
      held.current = false
      const row = rowOf(e.target)
      if (!row) return
      const i = Number(row.dataset.row)
      const timer = setTimeout(() => {
        press.current = null
        held.current = true
        navigator.vibrate?.(10)
        select(span ? { anchor: span.anchor, head: i } : { anchor: i, head: i })
      }, LONG_PRESS_MS)
      press.current = { timer, x: e.clientX, y: e.clientY }
      return
    }
    if (e.button !== 0) return
    const row = rowOf(e.target)
    if (!row) return select(null)
    e.preventDefault()
    const start = Number(row.dataset.row)
    const extend = e.shiftKey && (span !== null || cursor.current !== null)
    const anchor = extend ? (span?.anchor ?? cursor.current!) : start
    if (extend || onGutter(e.target)) select({ anchor, head: start })
    else {
      // Clique no texto é como pôr o cursor: nada selecionado até arrastar.
      select(null)
      cursor.current = start
    }
    const el = e.currentTarget
    let head = start
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      // Perto da borda, rola junto, para dar para arrastar além do que está à vista.
      const box = el.getBoundingClientRect()
      if (ev.clientY < box.top + 24) el.scrollTop -= 16
      else if (ev.clientY > box.bottom - 24) el.scrollTop += 16
      // Fora da área do código (à esquerda, acima), vale a linha na mesma altura, dentro dela.
      const x = Math.min(Math.max(ev.clientX, box.left + 8), box.right - 8)
      const y = Math.min(Math.max(ev.clientY, box.top + 1), box.bottom - 1)
      const over = rowOf(document.elementFromPoint(x, y))
      const at = over ? Number(over.dataset.row) : head
      if (at === head) return
      head = at
      select({ anchor, head })
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE) release()
  }

  // No toque, o número da linha escolhe e estende; tocar de novo na linha escolhida sozinha a solta.
  const onClick = (e: React.MouseEvent) => {
    // O toque que segurou o dedo já escolheu a linha: o clique ao soltar não conta.
    if (held.current) {
      held.current = false
      return
    }
    if (pointer.current === 'mouse' || !onGutter(e.target)) return
    const row = rowOf(e.target)
    if (!row) return
    const i = Number(row.dataset.row)
    if (!span) select({ anchor: i, head: i })
    else if (span.anchor === span.head && span.anchor === i) select(null)
    else select({ anchor: span.anchor, head: i })
  }

  const onContextMenu = (e: React.MouseEvent) => {
    const row = rowOf(e.target)
    const el = container.current
    // Fora das linhas do código (Markdown formatado, imagem): fica o menu do navegador.
    if (!row || !el) return
    e.preventDefault()
    // No toque, o dedo segurado já é tratado acima (o Android também manda `contextmenu`).
    if (pointer.current !== 'mouse') return
    const i = Number(row.dataset.row)
    const [a, b] = span ? ordered(span) : [-1, -1]
    // Clicar fora da seleção troca ela pela linha clicada, como num editor.
    const next = span && i >= a && i <= b ? span : { anchor: i, head: i }
    select(next)
    const { lines, text } = readSpan(el, next)
    setMenu({ x: e.clientX, y: e.clientY, lines, text })
    setMenuOpen(true)
  }

  const picked = touch ? selection : null

  // Quem recebe isto precisa ser `relative`: a faixa de destaque se posiciona pelas linhas e rola com elas.
  const bind = { ref: container, onPointerDown, onPointerMove, onPointerUp: release, onPointerCancel: release, onClick, onContextMenu }

  const overlay = (
    <>
      <DropdownMenu open={menuOpen && Boolean(menu)} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4} collisionPadding={8} className="w-auto min-w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
          {menu && (
            <>
              <DropdownMenuLabel className="font-normal text-muted-foreground first-letter:uppercase">
                {menu.lines ? label(menu.lines) : 'Só linhas tiradas'}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {menu.lines && (
                <DropdownMenuItem onSelect={() => send(menu.lines!)}>
                  <AtSign /> Mencionar no chat
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => copy(menu.text)}>
                <Copy /> Copiar
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {picked && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-10 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border bg-background p-1 shadow-lg">
            {picked.lines && (
              <Button size="sm" className="rounded-full" onClick={() => send(picked.lines!)}>
                <AtSign /> Mencionar {label(picked.lines)}
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" className="rounded-full" onClick={() => copy(picked.text)} aria-label="Copiar as linhas">
              <Copy />
            </Button>
            <Button variant="ghost" size="icon-sm" className="rounded-full" onClick={() => select(null)} aria-label="Soltar a seleção">
              <X />
            </Button>
          </div>
        </div>
      )}
    </>
  )

  // A faixa fica dentro do código (ver `bind`), por cima das linhas e sem pegar o ponteiro.
  const highlight = <div ref={band} aria-hidden className="pointer-events-none absolute left-0 hidden bg-sky-500/25" />

  return { bind, overlay, highlight }
}
