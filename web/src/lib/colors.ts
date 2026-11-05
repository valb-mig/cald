/** Uma cor achada num texto: onde está e o valor, pronto para ir num `background`. */
export type ColorMatch = { start: number; end: number; value: string }

// Hex de 3, 4, 6 ou 8 dígitos, solto (não no meio de uma palavra, de um link ou de uma entidade `&#123;`).
const HEX = /(?<![\w&#/])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})\b/gi
// As funções de cor do CSS, sem parênteses dentro (`rgb(var(--x))` não tem cor para mostrar).
const FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()\n]{1,80}\)/gi

const valid = (value: string) => typeof CSS !== 'undefined' && CSS.supports('color', value)

/**
 * As cores escritas num texto, como o "colorize" do VSCode. `prose`: texto corrido, onde `#123` é
 * quase sempre um issue ou PR; ali o hex curto só conta com uma letra (`#fff`, `#0af`).
 */
export function findColors(text: string, prose = false): ColorMatch[] {
  if (!text.includes('#') && !text.includes('(')) return []
  const found: ColorMatch[] = []
  for (const m of text.matchAll(HEX)) {
    if (prose && m[0].length <= 5 && /^#\d+$/.test(m[0])) continue
    if (valid(m[0])) found.push({ start: m.index, end: m.index + m[0].length, value: m[0] })
  }
  for (const m of text.matchAll(FUNCTION)) {
    if (valid(m[0])) found.push({ start: m.index, end: m.index + m[0].length, value: m[0] })
  }
  // Um hex dentro de uma função (`rgb(from #fff r g b)`) já vai com ela.
  let end = 0
  return found
    .sort((a, b) => a.start - b.start)
    .filter((c) => {
      if (c.start < end) return false
      end = c.end
      return true
    })
}
