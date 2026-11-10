import type { ExtraProps } from 'react-markdown'

type HastElement = NonNullable<ExtraProps['node']>
type HastChild = HastElement['children'][number]

// O que, dentro de um item, já é bloco: o título é só o que vem antes do primeiro deles.
const BLOCKS = new Set(['p', 'ul', 'ol', 'pre', 'table', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'div'])

// Entre o título e o resto da linha: dois pontos, travessão, hífen solto ou uma quebra de linha.
const SEPARATOR = /^[ \t]*(?::|—|–|\s-\s|\n)\s*/
const COLON = /\s*:\s*$/

const blank = (c: HastChild) => c.type === 'text' && !c.value.trim()
const element = (c: HastChild | undefined, tag?: string): c is HastElement => c?.type === 'element' && (!tag || c.tagName === tag)
const textOf = (c: HastChild): string => (c.type === 'text' ? c.value : c.type === 'element' ? c.children.map(textOf).join('') : '')

/** Uma cópia da lista com o texto do nó em `i` mudado, se ele for de texto. */
const editText = (nodes: HastChild[], i: number, edit: (value: string) => string) =>
  nodes.map((c, j) => (j === i && c.type === 'text' ? { ...c, value: edit(c.value) } : c))

/** O título, o resto da linha dele e os blocos de baixo (a sublista, outros parágrafos). */
type Lead = { title: HastChild[]; rest: HastChild[]; blocks: HastChild[] }

/**
 * O item que abre com um título em negrito: `**Início**`, `**Início:**`, `**Início** — o resto` ou
 * `**Início:** o resto`. `null` se o negrito é só o começo de uma frase (`**Instale** o pacote`).
 */
function leadOf(li: HastElement): Lead | null {
  const first = li.children.find((c) => !blank(c))
  // Lista solta: o título vem num parágrafo; justa, solto no item, até o primeiro bloco.
  const holder = element(first, 'p') ? first : null
  const found = li.children.findIndex((c) => element(c) && BLOCKS.has(c.tagName))
  const end = holder ? li.children.indexOf(holder) + 1 : found < 0 ? li.children.length : found
  const line = holder ? holder.children : li.children.slice(0, end)

  const at = line.findIndex((c) => !blank(c))
  const strong = line[at]
  if (!element(strong, 'strong') || !textOf(strong).trim()) return null
  const colon = COLON.test(textOf(strong))
  let rest = line.slice(at + 1)
  if (rest.every(blank)) rest = []
  else if (rest[0]?.type === 'text' && (colon || SEPARATOR.test(rest[0].value))) {
    rest = editText(rest, 0, (v) => (colon ? v.trimStart() : v.replace(SEPARATOR, '')))
    rest = editText(rest, rest.length - 1, (v) => v.trimEnd())
  } else return null

  // Os dois pontos do fim do título saem: o desenho já separa título e corpo.
  const title = editText(strong.children, strong.children.length - 1, (v) => v.replace(COLON, ''))
  return { title, rest, blocks: li.children.slice(end) }
}

function outline(list: HastElement) {
  const items = list.children.filter((c) => element(c, 'li'))
  const leads = items.map(leadOf)
  if (!items.length || !leads.every((l) => l !== null)) return
  // Sem nada embaixo de nenhum título, é uma lista de "**termo:** descrição", que já se lê bem assim.
  if (!leads.some((l) => l.blocks.some((c) => !blank(c)))) return
  const start = typeof list.properties.start === 'number' ? list.properties.start : 1
  list.properties.dataOutline = ''
  items.forEach((li, i) => {
    const { title, rest, blocks } = leads[i]!
    // O resto da linha fica nela, depois do título (`data-outline-note`).
    const note: HastElement = { type: 'element', tagName: 'span', properties: { dataOutlineNote: '' }, children: rest }
    li.children = [
      { type: 'element', tagName: 'div', properties: { dataOutlineTitle: list.tagName === 'ol' ? String(start + i) : '' }, children: [...title, ...(rest.length ? [note] : [])] },
      ...(blocks.some((c) => !blank(c)) ? [{ type: 'element' as const, tagName: 'div', properties: { dataOutlineBody: '' }, children: blocks }] : []),
    ]
  })
}

/**
 * Plugin do rehype para o vício de "tópicos e pontos": uma lista em que todo item abre com um título em
 * negrito e algum tem uma sublista (ou outro bloco) embaixo vira um sumário de seções. Cada item fica
 * com um `div` de título (`data-outline-title`, com o número na lista numerada e o resto da linha) e
 * um de corpo (`data-outline-body`), que o Markdown desenha. Qualquer outra lista fica como está.
 */
export function rehypeOutline() {
  const walk = (node: { children: HastChild[] }) => {
    for (const child of node.children) {
      if (!element(child)) continue
      walk(child)
      if (child.tagName === 'ul' || child.tagName === 'ol') outline(child)
    }
  }
  return walk
}
