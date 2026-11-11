/**
 * Um arquivo em conflito em pedaços (ver server/src/conflicts.ts): o que é igual nos dois lados e cada
 * trecho em conflito, com a versão da branch e a da base. Vem do texto com as marcas do git.
 */
export type Segment = { kind: 'same'; text: string } | { kind: 'conflict'; branch: string; base: string }

/** O que fica num trecho em conflito: um lado, os dois (a branch primeiro) ou um texto escrito à mão. */
export type Pick = 'branch' | 'base' | 'both' | { text: string }

// As marcas, sempre no começo da linha: `<<<<<<< rótulo`, `||||||| rótulo` (com o ancestral), `=======`, `>>>>>>> rótulo`.
const OPEN = /^<{7}(?: |\r?\n|$)/
const ANCESTOR = /^\|{7}(?: |\r?\n|$)/
const MIDDLE = /^={7}(?:\r?\n|$)/
const CLOSE = /^>{7}(?: |\r?\n|$)/

/** Os pedaços do texto com as marcas, cada um com as quebras de linha dele. */
export function segmentsOf(text: string): Segment[] {
  const out: Segment[] = []
  let same = ''
  let block: { branch: string; base: string; at: 'branch' | 'ancestor' | 'base' } | null = null
  for (const line of text.split(/(?<=\n)/)) {
    if (!block) {
      if (!OPEN.test(line)) {
        same += line
        continue
      }
      if (same) out.push({ kind: 'same', text: same })
      same = ''
      block = { branch: '', base: '', at: 'branch' }
    } else if (block.at === 'branch' && ANCESTOR.test(line)) block.at = 'ancestor'
    else if (block.at !== 'base' && MIDDLE.test(line)) block.at = 'base'
    else if (block.at === 'base' && CLOSE.test(line)) {
      out.push({ kind: 'conflict', branch: block.branch, base: block.base })
      block = null
    } else if (block.at === 'branch') block.branch += line
    else if (block.at === 'base') block.base += line
  }
  if (block) out.push({ kind: 'conflict', branch: block.branch, base: block.base })
  if (same) out.push({ kind: 'same', text: same })
  return out
}

/** Um depois do outro, com a quebra de linha entre os dois quando o primeiro termina sem ela. */
const joined = (a: string, b: string) => (a && b && !a.endsWith('\n') ? `${a}\n${b}` : a + b)

/** O texto de um trecho com a escolha feita. O escrito à mão ganha a quebra do fim, se o trecho tinha. */
export function picked(s: Extract<Segment, { kind: 'conflict' }>, pick: Pick): string {
  if (pick === 'branch') return s.branch
  if (pick === 'base') return s.base
  if (pick === 'both') return joined(s.branch, s.base)
  const ends = s.branch.endsWith('\n') || s.base.endsWith('\n')
  return pick.text && ends && !pick.text.endsWith('\n') ? `${pick.text}\n` : pick.text
}

/** O arquivo resolvido, com uma escolha por trecho em conflito; `null` se falta escolher algum. */
export function resolved(segments: Segment[], picks: (Pick | null)[]): string | null {
  let at = 0
  let out = ''
  for (const s of segments) {
    if (s.kind === 'same') {
      out += s.text
      continue
    }
    const pick = picks[at++]
    if (!pick) return null
    out += picked(s, pick)
  }
  return out
}
