import { useLayoutEffect, useRef } from 'react'
import { SHELL_REPAINT } from '@/lib/shell'

const px = (n: number) => Math.round(n * 2) / 2

/** O retângulo arredondado de uma janela, relativo à casca, com o raio de cada canto que ela tem agora. */
function roundedRect(el: Element, shell: DOMRect): string {
  const r = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const x0 = px(r.left - shell.left)
  const y0 = px(r.top - shell.top)
  const x1 = px(x0 + r.width)
  const y1 = px(y0 + r.height)
  const tl = parseFloat(style.borderTopLeftRadius) || 0
  const tr = parseFloat(style.borderTopRightRadius) || 0
  const br = parseFloat(style.borderBottomRightRadius) || 0
  const bl = parseFloat(style.borderBottomLeftRadius) || 0
  return (
    `M${x0 + tl} ${y0}H${x1 - tr}A${tr} ${tr} 0 0 1 ${x1} ${y0 + tr}` +
    `V${y1 - br}A${br} ${br} 0 0 1 ${x1 - br} ${y1}` +
    `H${x0 + bl}A${bl} ${bl} 0 0 1 ${x0} ${y1 - bl}` +
    `V${y0 + tl}A${tl} ${tl} 0 0 1 ${x0 + tl} ${y0}Z`
  )
}

/**
 * A cor da casca no PC, por trás de tudo o que fica nela (abas, barra do projeto), com um
 * recorte em cada janela de conversa (`data-hole`). Pelos recortes aparece o fundo do app, o mesmo da
 * margem em volta das ilhas: a cena animada fica uma só, contínua da borda da tela até a conversa.
 * Pintar a casca em cada parte não daria: as curvas das janelas e as folgas entre elas ficariam de fora.
 *
 * O recorte é refeito quando uma janela muda de tamanho (lista recolhida, outra conversa ao lado,
 * divisória arrastada), quando o canto dela muda (`data-hole`, ver GroupView) e quando uma entra ou sai
 * (`repaintShell`, em lib/shell.ts).
 */
export function ShellPaint() {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const paint = ref.current
    const shell = paint?.parentElement
    if (!paint || !shell) return
    let watched: Element[] = []
    let last = ''

    const update = () => {
      const holes = [...shell.querySelectorAll('[data-hole]')]
      for (const el of watched) if (!holes.includes(el)) sizes.unobserve(el)
      for (const el of holes) if (!watched.includes(el)) sizes.observe(el)
      watched = holes
      const box = shell.getBoundingClientRect()
      const path = `M0 0H${px(box.width)}V${px(box.height)}H0Z` + holes.map((el) => roundedRect(el, box)).join('')
      if (path === last) return
      last = path
      paint.style.clipPath = `path(evenodd, '${path}')`
    }

    // Depois do layout e antes da pintura: o recorte acompanha o arrasto sem atrasar um quadro.
    const sizes = new ResizeObserver(update)
    sizes.observe(shell)
    const corners = new MutationObserver(update)
    corners.observe(shell, { subtree: true, attributes: true, attributeFilter: ['data-hole'] })
    window.addEventListener(SHELL_REPAINT, update)
    update()
    return () => {
      sizes.disconnect()
      corners.disconnect()
      window.removeEventListener(SHELL_REPAINT, update)
    }
  }, [])

  return <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 -z-10 rounded-island bg-shell shadow-island" />
}
