import { lookOf, seedOf } from '@/lib/claudinho'
import { duration } from '@/lib/format'
import { KIND_LABEL, type MindKind, type MindNode } from './model'

/**
 * O mapa como um fluxo, de cima para baixo: a conversa no topo, e embaixo dela, numa linha só, cada
 * mensagem sua seguida dos passos do Claude. Os subagentes que um passo chama ficam lado a lado numa
 * moldura logo abaixo dele, e o fluxo segue depois que todos voltam; uma pergunta abre as opções
 * numa moldura, e o fluxo segue pela que você escolheu. As ações de cada passo (arquivos, comandos)
 * não viram cartão: ficam no resumo do passo.
 */

export type Box = { node: MindNode; x: number; y: number; w: number; h: number; color: string }
/** A moldura tracejada em volta dos subagentes de um passo ou das opções de uma pergunta. */
export type Group = { x: number; y: number; w: number; h: number; label: string }
/** A pílula no meio de uma ligação, centrada em `x`, `y`. */
export type EdgeLabel = { text: string; x: number; y: number }
export type Edge = {
  id: string
  /** O traço, sem a seta. */
  d: string
  /** A ponta da seta, um triângulo apontando para baixo. */
  arrow: string
  color: string
  /** `dot`: da conversa ao primeiro turno; `dash`: uma opção que ficou para trás. */
  dash?: 'dot' | 'dash'
  dim?: boolean
  /** Leva a um nó trabalhando ou esperando: o traço anda. */
  live: boolean
  label?: EdgeLabel
}
export type Layout = { boxes: Box[]; edges: Edge[]; groups: Group[]; width: number; height: number }

type Size = { w: number; h: number }

const WIDTH: Record<MindKind, number> = {
  root: 300,
  turn: 280,
  step: 280,
  answer: 280,
  approval: 280,
  decision: 280,
  agent: 280,
  option: 184,
  notice: 200,
  file: 0,
  command: 0,
  search: 0,
  web: 0,
  tool: 0,
}

// As medidas do cartão na tela (ver Card, em mind-map.tsx): o respiro em volta, a coluna do ícone e a
// altura de cada linha de texto, com a folga do espaço entre elas.
const CARD_PAD_Y = 24
const CARD_PAD_X = 28
const ICON_COL = 28 + 12
const TITLE_LINE = 18
const SUB_LINE = 18 + 4
const FOOT_LINE = 17 + 4

let measurer: CanvasRenderingContext2D | null | undefined
/** Largura de um texto na fonte do app; sem navegador (testes), uma estimativa por letra. */
function measure(text: string, size: number, weight: number): number {
  if (measurer === undefined) measurer = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  if (!measurer) return text.length * size * 0.55
  measurer.font = `${weight} ${size}px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`
  return measurer.measureText(text).width
}

/** Em quantas linhas (até `max`) o título quebra na largura dada, como o navegador quebraria. */
function titleLines(text: string, width: number, max: number): number {
  let lines = 1
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (line && measure(next, 13, 600) > width) {
      if (++lines >= max) return max
      line = word
    } else {
      line = next
    }
  }
  return lines
}

/**
 * O tamanho de cada cartão: a largura é a do tipo, e a altura acompanha o texto (o título em uma ou
 * duas linhas, e as linhas de baixo que o nó tiver), para nenhum ficar cortado ou com sobra.
 */
function sizeOf(n: MindNode): Size {
  const w = WIDTH[n.kind]
  if (n.kind === 'option') return { w, h: 40 }
  if (n.kind === 'notice') return { w, h: 34 }
  const type = KIND_LABEL[n.kind]
  // O tipo divide a primeira linha com o título; o espaçamento das letras dele soma ~0,8 px cada.
  const typeW = type ? measure(type.toUpperCase(), 10, 500) + type.length * 0.8 + 8 : 0
  const lines = n.kind === 'agent' ? 1 : titleLines(n.label, w - CARD_PAD_X - ICON_COL - typeW - 4, 2)
  const title = CARD_PAD_Y + lines * TITLE_LINE
  if (n.kind === 'root') return { w, h: title + FOOT_LINE * 2 + 4 }
  if (n.kind === 'agent') return { w, h: title + SUB_LINE + FOOT_LINE * 2 }
  if (n.kind === 'turn') return { w, h: title + (n.meta ? SUB_LINE : 0) + FOOT_LINE }
  // Passo, resposta, aprovação e pergunta: concluídos, o resumo; ainda em curso, o estado no pé.
  return { w, h: title + (n.status !== 'done' ? FOOT_LINE : n.meta ? SUB_LINE : 0) }
}

/** Margem em volta do desenho. */
const PAD = 40
/** Entre dois cartões seguidos; com pílula na ligação, mais. */
const GAP = 36
const LABEL_GAP = 56
/** Antes de cada mensagem sua: o respiro entre um turno e o outro. */
const TURN_GAP = 64
/** Do passo até a moldura dos subagentes (ou da pergunta até as opções). */
const FAN_GAP = 56
const GROUP_PAD = 12
/** Espaço no alto da moldura para o rótulo dela. */
const GROUP_TOP = 26
const ROW_GAP = 12
/** Raio da curva de cada cotovelo. */
const BEND = 8
const ARROW = 7

/** Você fala em cinza; o resto tem a cor do claudinho que fez (o da conversa ou o de cada subagente). */
export function colorOf(n: MindNode): string {
  if (n.kind === 'turn' || (n.kind === 'option' && n.chosen === false) || !n.seed) return 'var(--muted-foreground)'
  return lookOf(seedOf(n.seed)).color
}

/** O resultado de um turno, na pílula da ligação até o próximo. */
function turnResult(t: MindNode): string | undefined {
  if (t.status === 'stopped') return 'interrompido'
  if (t.status === 'failed') return 'terminou com erro'
  return t.status === 'done' && t.stats?.durationMs ? duration(t.stats.durationMs) : undefined
}

type Link = {
  from: Box
  to: Box
  /** A altura em que o traço dobra para o lado, se precisar. */
  bend: number
  label?: string
  /** A pílula fica no tronco, antes de abrir para os lados (a ligação até uma moldura). */
  trunk?: boolean
  /** Os traços de uma moldura se juntando: a pílula fica depois da junção, mesmo no que desce reto. */
  merge?: boolean
  dash?: Edge['dash']
  dim?: boolean
  color?: string
}

export function layout(root: MindNode): Layout {
  const boxes: Box[] = []
  const groups: Group[] = []
  const links: Link[] = []
  let y = 0

  const put = (node: MindNode, x: number, top: number, h?: number): Box => {
    const s = sizeOf(node)
    const b: Box = { node, x, y: top, w: s.w, h: h ?? s.h, color: colorOf(node) }
    boxes.push(b)
    return b
  }

  /** De onde sai a próxima ligação: um cartão, ou todos os de uma moldura (o fluxo junta de novo). */
  let tail: Box[] = []
  let tailColor: string | undefined
  /** Onde termina o que veio antes: o pé do cartão, ou o da moldura. */
  let tailBottom = 0

  /** Um cartão na linha do meio, ligado ao que veio antes. */
  const single = (node: MindNode, opts: { gap?: number; label?: string; dash?: Edge['dash'] } = {}): Box => {
    const label = opts.label
    if (boxes.length) y += Math.max(opts.gap ?? 0, label ? LABEL_GAP : GAP)
    const b = put(node, -WIDTH[node.kind] / 2, y)
    y += b.h
    // Saindo de uma moldura, os traços se juntam a meio caminho entre o pé dela e o cartão.
    const bend = (tailBottom + b.y) / 2
    const merge = tail.length > 1
    tail.forEach((from, i) => links.push({ from, to: b, bend, merge, label: i === 0 ? label : undefined, dash: opts.dash, color: tailColor }))
    tail = [b]
    tailColor = undefined
    tailBottom = b.y + b.h
    return b
  }

  /** Vários cartões lado a lado numa moldura, abertos a partir de `parent`. */
  const row = (nodes: MindNode[], parent: Box, label: string, look: (n: MindNode) => Partial<Link> = () => ({})): Box[] => {
    y += FAN_GAP
    const inner = nodes.reduce((sum, n) => sum + WIDTH[n.kind], 0) + ROW_GAP * (nodes.length - 1)
    // Lado a lado, todos da altura do mais alto, como numa fileira.
    const tall = Math.max(...nodes.map((n) => sizeOf(n).h))
    const group: Group = { x: -inner / 2 - GROUP_PAD, y, w: inner + GROUP_PAD * 2, h: GROUP_TOP + tall + GROUP_PAD, label }
    groups.push(group)
    let x = -inner / 2
    const bend = parent.y + parent.h + FAN_GAP / 2
    const out = nodes.map((n, i) => {
      const b = put(n, x, y + GROUP_TOP, tall)
      x += b.w + ROW_GAP
      links.push({ from: parent, to: b, bend, trunk: true, label: i === 0 && nodes.length > 1 ? `${nodes.length} ${n.kind === 'agent' ? 'em paralelo' : 'caminhos'}` : undefined, ...look(n) })
      return b
    })
    y += group.h
    tailBottom = group.y + group.h
    return out
  }

  /** Uma pergunta e as opções dela; o fluxo segue pela escolhida (ou por todas, sem resposta ainda). */
  const decision = (d: MindNode) => {
    const box = single(d)
    const options = d.children.filter((c) => c.kind === 'option')
    if (!options.length) return
    const placed = row(options, box, 'opções', (o) =>
      o.chosen === false ? { dash: 'dash', dim: true, color: 'var(--muted-foreground)' } : o.chosen === undefined ? { color: 'var(--muted-foreground)' } : {},
    )
    const chosen = placed.filter((b) => b.node.chosen)
    tail = chosen.length ? chosen : placed
    tailColor = chosen.length ? undefined : 'var(--muted-foreground)'
  }

  single(root)

  let previous: MindNode | undefined
  for (const turn of root.children) {
    single(turn, { gap: TURN_GAP, label: previous && turnResult(previous), dash: previous ? undefined : 'dot' })
    previous = turn
    for (const c of turn.children) {
      if (c.kind === 'decision') {
        decision(c)
        continue
      }
      const box = single(c)
      const agents = c.children.filter((k) => k.kind === 'agent')
      if (agents.length) {
        tail = row(agents, box, agents.length === 1 ? 'subagente' : 'subagentes')
        // Todos voltam para o passo seguinte na cor de quem os chamou.
        tailColor = box.color
      }
      for (const d of c.children.filter((k) => k.kind === 'decision')) decision(d)
    }
  }

  // Do centro (x = 0) para coordenadas a partir da margem.
  const minX = Math.min(...boxes.map((b) => b.x), ...groups.map((g) => g.x))
  const dx = PAD - minX
  for (const b of boxes) {
    b.x += dx
    b.y += PAD
  }
  for (const g of groups) {
    g.x += dx
    g.y += PAD
  }
  const edges = links.map((l) => edge({ ...l, bend: l.bend + PAD }))
  return {
    boxes,
    edges,
    groups,
    width: Math.max(...boxes.map((b) => b.x + b.w), ...groups.map((g) => g.x + g.w)) + PAD,
    height: Math.max(...boxes.map((b) => b.y + b.h), ...groups.map((g) => g.y + g.h)) + PAD,
  }
}

/** O traço de uma ligação: desce do meio de baixo de um cartão até o meio de cima do outro, em cotovelos arredondados. */
function edge(l: Link): Edge {
  const x1 = l.from.x + l.from.w / 2
  const y1 = l.from.y + l.from.h
  const x2 = l.to.x + l.to.w / 2
  const y2 = l.to.y
  const end = y2 - ARROW
  const dx = x2 - x1
  let d: string
  let labelY: number
  if (Math.abs(dx) < 0.5) {
    d = `M ${x1} ${y1} V ${end}`
    labelY = l.merge ? (l.bend + end) / 2 : (y1 + end) / 2
  } else {
    const r = Math.min(BEND, Math.abs(dx) / 2)
    const s = Math.sign(dx)
    d = `M ${x1} ${y1} V ${l.bend - r} Q ${x1} ${l.bend}, ${x1 + s * r} ${l.bend} H ${x2 - s * r} Q ${x2} ${l.bend}, ${x2} ${l.bend + r} V ${end}`
    labelY = l.trunk ? (y1 + l.bend) / 2 : (l.bend + end) / 2
  }
  const labelX = l.trunk ? x1 : x2
  return {
    id: `${l.from.node.id}>${l.to.node.id}`,
    d,
    arrow: `${x2 - 4.5},${end} ${x2 + 4.5},${end} ${x2},${y2}`,
    color: l.color ?? l.from.color,
    dash: l.dash,
    dim: l.dim,
    live: l.to.node.status === 'running' || l.to.node.status === 'waiting',
    label: l.label ? { text: l.label, x: labelX, y: labelY } : undefined,
  }
}
