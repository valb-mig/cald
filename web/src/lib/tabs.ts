/**
 * Última aba visitada (Conversas, Projetos): o "voltar" de uma conversa leva para onde a
 * pessoa estava, não sempre para a mesma lista. Sem aba ainda, `/`: no PC, o início; no
 * celular, as conversas.
 */
let last = '/'

export function rememberTab(path: string): void {
  last = path
}

export const backHref = (): string => last
