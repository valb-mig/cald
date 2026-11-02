import { create } from 'zustand'

/**
 * Tamanho da fonte do código aberto pela barra do projeto (arquivo e diff). É deste aparelho, como o
 * tema: no celular dá vontade de ler maior que no PC.
 */
export const CODE_FONT = 12
export const CODE_FONT_MIN = 9
export const CODE_FONT_MAX = 24

const KEY = 'cr:code-font'

function load(): number {
  try {
    const saved = Number(localStorage.getItem(KEY))
    return saved >= CODE_FONT_MIN && saved <= CODE_FONT_MAX ? saved : CODE_FONT
  } catch {
    return CODE_FONT
  }
}

export const useCodeFont = create<{ size: number }>(() => ({ size: load() }))

/** Muda o tamanho (em px, arredondado a meio pixel, dentro dos limites) e guarda. */
export function setCodeFont(size: number): void {
  const next = Math.min(CODE_FONT_MAX, Math.max(CODE_FONT_MIN, Math.round(size * 2) / 2))
  if (next === useCodeFont.getState().size) return
  useCodeFont.setState({ size: next })
  try {
    localStorage.setItem(KEY, String(next))
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}

export const stepCodeFont = (by: number) => setCodeFont(useCodeFont.getState().size + by)
