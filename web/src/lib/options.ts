import { blank, editText, element, lineOf, textOf, type HastChild, type HastElement } from './outline'

const WORDS = '(?:op[çc][õo]es|caminhos|alternativas|abordagens|escolhas|options)'
// O que anuncia as opções logo antes da lista: "**Opções:**", "Vejo dois caminhos:" ou um título "## Alternativas".
const LABEL = new RegExp(`\\b${WORDS}\\b[^:]*:$`, 'i')
const HEADING = new RegExp(`\\b${WORDS}\\b`, 'i')
// A pergunta que fecha a resposta: "Qual opção você quer?", "Prefere a 1 ou a 2?", "Qual delas?".
const ASK = /(?:op[çc][ãaõo]|caminho|prefer|escolh|qual (?:delas|deles|das|dos|segu|sig|voc))[^?]*\?$/i

// "(Recomendado)" no título ou logo depois dele: a sugestão do Claude, que vira um selo.
const RECOMMENDED = /\s*\((?:recomendad[oa]|recommended|minha sugestão)\)/i
// O título fecha com pontuação dentro do negrito: "**Só o pedido.** o resto".
const CLOSED = /[.:!?]\s*$/
// Ou o resto da linha abre com ela: dois pontos, ponto, travessão, hífen solto ou uma quebra de linha.
const SEPARATOR = /^[ \t]*(?:[:.—–]|-\s|\n)\s*/
// A opção com nome próprio no começo do título: "**A**", "**Opção B:** …", "**Opção 2 — Só o pedido**".
const NAMED = /^(?:[Oo]p[çc][ãa]o\s+)?([A-Z]|\d{1,2})(?:$|\s*[:.)—–-]\s*)/

/**
 * A opção: o nome dela, se o título começa com um ("A", "Opção 2"), o título em negrito (se sobra
 * algum), com o selo, e a descrição (o resto da linha e os blocos de baixo).
 */
type Option = { name?: string; title: HastChild[] | null; recommended: boolean; body: HastChild[] }

function optionOf(li: HastElement): Option {
  const { line, blocks } = lineOf(li)
  const plain = { title: null, recommended: false, body: [...line, ...blocks] }
  const at = line.findIndex((c) => !blank(c))
  const strong = line[at]
  if (!element(strong, 'strong') || !textOf(strong).trim()) return plain

  let rest = line.slice(at + 1)
  let recommended = RECOMMENDED.test(textOf(strong))
  if (rest[0]?.type === 'text' && new RegExp(`^${RECOMMENDED.source}`, 'i').test(rest[0].value)) {
    recommended = true
    rest = editText(rest, 0, (v) => v.replace(RECOMMENDED, ''))
  }
  const closed = CLOSED.test(textOf(strong))
  if (rest.every(blank)) rest = []
  else if (rest[0]?.type === 'text' && (closed || SEPARATOR.test(rest[0].value))) {
    rest = editText(rest, 0, (v) => v.replace(SEPARATOR, '').trimStart())
    rest = editText(rest, rest.length - 1, (v) => v.trimEnd())
  } else if (!closed) return plain // O negrito é só o começo de uma frase: "**Mantenha** o atalho".

  let title = editText(
    strong.children.map((c) => (c.type === 'text' ? { ...c, value: c.value.replace(RECOMMENDED, '') } : c)),
    strong.children.length - 1,
    (v) => v.replace(/\s*[.:]\s*$/, ''),
  )
  // O nome vai para a bolinha; só ele no título, a descrição é o texto da opção.
  const name = title[0]?.type === 'text' ? NAMED.exec(title[0].value) : null
  if (name) title = editText(title, 0, (v) => v.slice(name[0].length))
  const named = name?.[1]
  return { name: named, title: title.some((c) => !blank(c)) ? title : null, recommended, body: [...rest, ...blocks] }
}

const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text)

function options(list: HastElement, announced: boolean) {
  const items = list.children.filter((c) => element(c, 'li'))
  const classes = list.properties.className
  if (items.length < 2 || items.length > 9 || (Array.isArray(classes) && classes.includes('contains-task-list'))) return
  const all = items.map(optionOf)
  // Sem o anúncio, só a pergunta do fim: cada item tem que abrir com um título, para não pegar qualquer lista.
  if (!announced && !all.every((o) => o.title || o.name)) return
  const start = typeof list.properties.start === 'number' ? list.properties.start : 1
  list.properties.dataOptions = ''
  items.forEach((li, i) => {
    const { name, title, recommended, body } = all[i]!
    const mark = name ?? (list.tagName === 'ol' ? String(start + i) : '')
    const heading = title?.map(textOf).join('').trim()
    // O que tocar na opção escreve na caixa de mensagem (ver OptionItem, em components/markdown.tsx).
    const pick = mark ? `Opção ${mark}${heading ? `: ${heading}` : ''}` : heading || clip(body.map(textOf).join('').trim())
    li.properties = { ...li.properties, dataOption: mark, dataPick: pick }
    li.children = [
      ...(title ? [{ type: 'element' as const, tagName: 'div', properties: { dataOptionTitle: '', ...(recommended ? { dataRecommended: '' } : {}) }, children: title }] : []),
      ...(body.some((c) => !blank(c)) ? [{ type: 'element' as const, tagName: 'div', properties: { dataOptionBody: title ? 'note' : '' }, children: body }] : []),
    ]
  })
}

/** O parágrafo ou o título logo antes da lista anuncia opções: "**Opções:**", "## Caminhos". */
function announces(node: HastElement | undefined): boolean {
  if (!node) return false
  const text = textOf(node).trim()
  if (node.tagName === 'p') return text.length <= 80 && LABEL.test(text)
  return /^h[1-6]$/.test(node.tagName) && text.length <= 60 && HEADING.test(text)
}

/**
 * Plugin do rehype para a resposta que termina pedindo uma escolha: a lista de opções vira um bloco
 * em que cada opção é uma linha de escolha, como numa pergunta do Claude. É de opções a lista logo
 * depois de um anúncio ("**Opções:**") ou, quando a resposta fecha com uma pergunta de escolha ("Qual
 * opção você quer?"), a última lista dela, se todo item abre com um título em negrito. Cada item fica
 * com o número (`data-option`), o texto que tocar nele escreve (`data-pick`), um `div` de título
 * (`data-option-title`, com `data-recommended` no "(Recomendado)") e um de descrição (`data-option-body`).
 * Só olha as listas do primeiro nível; vem antes do `rehypeOutline`, que deixa estas como estão.
 */
export function rehypeOptions() {
  return (root: { children: HastChild[] }) => {
    const nodes = root.children.filter((c): c is HastElement => element(c))
    const lists = nodes.filter((c) => c.tagName === 'ol' || c.tagName === 'ul')
    const end = nodes.at(-1)
    const asked = element(end, 'p') && ASK.test(textOf(end).trim())
    for (const list of lists) {
      const announced = announces(nodes[nodes.indexOf(list) - 1])
      if (announced || (asked && list === lists.at(-1))) options(list, announced)
    }
  }
}

// "Opção 2…" (como tocar escreve), ou só o nome: "2", "B.", "2, mas…".
const CHOICE = /^\s*(?:op[çc][ãa]o\s*([a-z]|\d+)\b|([a-z]|\d+)(?=\s*(?:[.:,;)!]|$)))/i

/** Se `answer`, a sua mensagem depois da resposta, escolheu a opção `mark` (o número ou a letra) de texto `pick`. */
export function chose(answer: string, mark: string, pick: string): boolean {
  if (answer.trim().startsWith(pick)) return true
  const m = CHOICE.exec(answer)
  return mark !== '' && (m?.[1] ?? m?.[2])?.toUpperCase() === mark.toUpperCase()
}
