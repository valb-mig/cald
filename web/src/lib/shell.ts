/** O pedido para a casca do PC refazer o recorte das janelas (ver components/shell-paint.tsx). */
export const SHELL_REPAINT = 'cr:shell-repaint'

/** Uma janela entrou ou saiu da casca: o recorte precisa ser refeito. */
export function repaintShell(): void {
  window.dispatchEvent(new Event(SHELL_REPAINT))
}
