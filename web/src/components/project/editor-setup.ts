import { completeAnyWord, completeFromList, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete'
import { ensureSyntaxTree, HighlightStyle, syntaxTree } from '@codemirror/language'
import { linter, setDiagnosticsEffect, type Diagnostic } from '@codemirror/lint'
import { diff } from '@codemirror/merge'
import { EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField, Text, type Extension } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { highlightTree, tagHighlighter, tags as t, type Tag } from '@lezer/highlight'
import type { Block, Mark } from './changes'

/**
 * As peças do editor do PC (ver editor.tsx) que são do CodeMirror: o tema, as cores de sintaxe, as
 * marcas do que mudou desde o último commit, o peek de uma mudança, o lampejo nas linhas que o Claude
 * mudou e os erros de sintaxe. Fica num arquivo à parte, carregado junto com o editor, só no PC.
 */

// ---- cores ----

/**
 * As cores do GitHub (Primer), as mesmas que o Shiki usa no diff e no chat (ver lib/highlight.ts). Aqui
 * quem colore é o parser do próprio editor, que reparsa só o trecho editado; os nomes das partes do
 * código são outros, e por isso o casamento com as do Shiki é aproximado.
 */
const PALETTE = {
  dark: {
    comment: '#9198a1',
    keyword: '#ff7b72',
    string: '#a5d6ff',
    constant: '#79c0ff',
    fn: '#d2a8ff',
    type: '#ffa657',
    tag: '#7ee787',
    list: '#f2cc60',
    invalid: '#ffa198',
  },
  light: {
    comment: '#59636e',
    keyword: '#cf222e',
    string: '#0a3069',
    constant: '#0550ae',
    fn: '#6639ba',
    type: '#953800',
    tag: '#116329',
    list: '#3b2300',
    invalid: '#82071e',
  },
}

type Color = keyof (typeof PALETTE)['dark']

const RULES: { tag: Tag | readonly Tag[]; color?: Color; style?: Record<string, string> }[] = [
  { tag: t.comment, color: 'comment' },
  { tag: [t.keyword, t.operator, t.modifier], color: 'keyword' },
  { tag: [t.string, t.special(t.string), t.character, t.attributeValue, t.url], color: 'string' },
  { tag: [t.number, t.bool, t.null, t.atom, t.self, t.escape, t.attributeName, t.unit, t.constant(t.name), t.monospace], color: 'constant' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName, t.annotation], color: 'fn' },
  { tag: [t.typeName, t.className, t.namespace, t.changed], color: 'type' },
  { tag: [t.tagName, t.regexp, t.quote, t.inserted], color: 'tag' },
  { tag: t.list, color: 'list' },
  { tag: [t.invalid, t.deleted], color: 'invalid' },
  { tag: t.heading, color: 'constant', style: { fontWeight: '600' } },
  { tag: t.strong, style: { fontWeight: '600' } },
  { tag: t.emphasis, style: { fontStyle: 'italic' } },
  { tag: t.link, color: 'string', style: { textDecoration: 'underline' } },
  { tag: t.strikethrough, style: { textDecoration: 'line-through' } },
]

/** As cores de sintaxe do editor, no tema do app agora. */
export function highlightStyle(dark: boolean): HighlightStyle {
  const p = dark ? PALETTE.dark : PALETTE.light
  return HighlightStyle.define(RULES.map((r) => ({ tag: r.tag, ...(r.color ? { color: p[r.color] } : {}), ...r.style })))
}

/** As mesmas cores, como texto, para o minimapa (ver `minimapTokens`). */
function colorHighlighter(dark: boolean) {
  const p = dark ? PALETTE.dark : PALETTE.light
  return tagHighlighter(RULES.filter((r) => r.color).map((r) => ({ tag: r.tag, class: p[r.color!] })))
}

/**
 * As linhas do arquivo em pedaços com cor, no formato que o minimapa lê (o mesmo dos tokens do Shiki).
 * Só o que o parser já leu sai colorido; o resto vai em cinza até ele chegar lá.
 */
export function minimapTokens(state: EditorState, dark: boolean): { content: string; color?: string }[][] {
  const doc = state.doc
  const rows: { content: string; color?: string }[][] = Array.from({ length: doc.lines }, () => [])
  let pos = 0
  // Do ponto onde parou até `to`, na cor dada (ou sem cor), quebrando nas linhas.
  const emit = (to: number, color?: string) => {
    while (pos < to) {
      const line = doc.lineAt(pos)
      const end = Math.min(to, line.to)
      if (end > pos) rows[line.number - 1]!.push({ content: doc.sliceString(pos, end), color })
      pos = end < line.to ? end : line.to + 1
    }
  }
  highlightTree(syntaxTree(state), colorHighlighter(dark), (from, to, color) => {
    emit(from)
    emit(to, color)
  })
  emit(doc.length)
  return rows
}

// ---- autocomplete ----

type AutocompleteData = CompletionSource | readonly (string | Completion)[]

/**
 * As sugestões sem LSP: o que a linguagem já sabe (nomes do escopo, palavras-chave, propriedades do
 * CSS) mais as palavras do próprio arquivo, numa lista só e sem repetir o nome que as duas acham.
 */
export async function completions(ctx: CompletionContext): Promise<CompletionResult | null> {
  const data = ctx.state.languageDataAt<AutocompleteData>('autocomplete', ctx.pos)
  const sources = data.map((d) => (typeof d === 'function' ? d : completeFromList(d)))
  const results = (await Promise.all([...sources, completeAnyWord].map((source) => source(ctx)))).filter((r): r is CompletionResult => Boolean(r))
  if (results.length === 0) return null
  // Só as que começam no mesmo ponto se juntam: cada lista filtra a partir do seu começo.
  const from = results[0]!.from
  const seen = new Set<string>()
  const options: Completion[] = []
  for (const r of results) {
    if (r.from !== from) continue
    for (const o of r.options) {
      if (seen.has(o.label)) continue
      seen.add(o.label)
      options.push(o)
    }
  }
  return { from, options, validFor: /^[\w$]*$/ }
}

// ---- tema ----

/**
 * O editor com a cara do resto do código no app: a fonte e o tamanho do código (`--code-font`, ver
 * lib/code-font.ts), a margem dos números esmaecida, o fundo transparente e a seleção azul. O cursor
 * desliza de um lugar para o outro e pisca suave, como o `smooth caret` do VSCode: o CodeMirror reaproveita
 * o elemento do cursor, então a transição pega.
 */
export const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--code-font)', backgroundColor: 'transparent', color: 'var(--foreground)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.667' },
  '.cm-content': { padding: '0.5rem 0' },
  // A margem fica parada na rolagem para o lado, e o texto passa por baixo dela: precisa de fundo. Com a
  // cena atrás, o mesmo vidro do topo (`--code-gutter`, ver viewer.tsx); sem, a cor da janela.
  '.cm-gutters': {
    backgroundColor: 'var(--code-gutter, var(--background))',
    backdropFilter: 'blur(12px)',
    border: 'none',
    color: 'color-mix(in oklab, var(--muted-foreground) 60%, transparent)',
  },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '3.6em', padding: '0 0.4em 0 0' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--foreground) 4%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '.cm-cursor, .cm-dropCursor': {
    borderLeft: '2px solid var(--foreground)',
    marginLeft: '-1px',
    transition: 'left 80ms ease-out, top 80ms ease-out, height 80ms ease-out',
  },
  // O CodeMirror pisca em degrau (`steps(1)`); em curva, o cursor some e volta devagar.
  '&.cm-focused > .cm-scroller > .cm-cursorLayer': { animationTimingFunction: 'ease-in-out' },
  '.cm-selectionBackground': { background: 'rgb(14 165 233 / 0.18) !important' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { background: 'rgb(14 165 233 / 0.3) !important' },
  '.cm-selectionMatch': { backgroundColor: 'rgb(14 165 233 / 0.14)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'transparent',
    outline: '1px solid color-mix(in oklab, var(--foreground) 35%, transparent)',
    borderRadius: '2px',
  },
  '.cm-nonmatchingBracket': { color: 'var(--destructive)' },
  '.cm-searchMatch': { backgroundColor: 'rgb(234 179 8 / 0.25)', borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgb(234 179 8 / 0.5)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--muted)', border: 'none', color: 'var(--muted-foreground)', padding: '0 0.4em' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 0.3em', cursor: 'pointer', opacity: '0', transition: 'opacity 150ms' },
  '.cm-gutters:hover .cm-foldGutter .cm-gutterElement': { opacity: '1' },
  // Os painéis (buscar e substituir, ir para a linha) e as dicas, com a cara dos menus do app.
  '.cm-panels': { backgroundColor: 'var(--popover)', color: 'var(--popover-foreground)', fontFamily: 'var(--font-sans)', fontSize: '12px' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '6px 28px 6px 8px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 6px' },
  '.cm-panel.cm-search br': { flexBasis: '100%', height: '0' },
  '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--muted-foreground)' },
  '.cm-panel.cm-search [name=close]': { top: '6px', right: '8px', fontSize: '16px', color: 'var(--muted-foreground)' },
  '.cm-textfield': {
    backgroundColor: 'transparent',
    border: '1px solid var(--input)',
    borderRadius: '6px',
    padding: '3px 8px',
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
    color: 'inherit',
    margin: '0',
  },
  '.cm-textfield:focus': { outline: '2px solid var(--ring)', outlineOffset: '-1px' },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'color-mix(in oklab, var(--foreground) 6%, transparent)',
    border: 'none',
    borderRadius: '6px',
    padding: '3px 8px',
    fontSize: '12px',
    color: 'inherit',
    margin: '0',
    cursor: 'pointer',
  },
  '.cm-button:hover': { backgroundColor: 'color-mix(in oklab, var(--foreground) 12%, transparent)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    overflow: 'hidden',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.25)',
  },
  '.cm-diagnostic': { padding: '6px 10px', borderLeftWidth: '3px' },
  '.cm-diagnosticAction': {
    backgroundColor: 'var(--primary)',
    color: 'var(--primary-foreground)',
    borderRadius: '6px',
    padding: '2px 8px',
    marginLeft: '10px',
    font: 'inherit',
  },
  '.cm-diagnosticSource': { display: 'none' },
  // As marcas do que mudou desde o commit, como as do arquivo só leitura (ver viewer.tsx).
  '.cm-changes .cm-gutterElement': { position: 'relative', width: '0.9em', cursor: 'pointer' },
  '.cm-change-bar': { position: 'absolute', top: '0', bottom: '0', left: '0.2em', width: '3px', transition: 'width 120ms' },
  '.cm-changes .cm-gutterElement:hover .cm-change-bar': { width: '5px' },
  '.cm-change-add': { backgroundColor: 'var(--color-emerald-500)' },
  '.cm-change-mod': { backgroundColor: 'var(--color-sky-500)' },
  '.cm-change-del': {
    position: 'absolute',
    left: '0.2em',
    width: '0',
    height: '0',
    borderTop: '5px solid transparent',
    borderBottom: '5px solid transparent',
    borderLeft: '6px solid var(--color-red-500)',
  },
  '.cm-change-del-top': { top: '-5px' },
  // O que mudou no disco (ver `diskGutter`), na cor do Claude, à esquerda das marcas do git.
  '.cm-disk .cm-gutterElement': { position: 'relative', width: '0.45em', cursor: 'pointer' },
  '.cm-disk-bar': { position: 'absolute', top: '0', bottom: '0', left: '0.1em', width: '3px', backgroundColor: '#d97757', borderRadius: '1px' },
  '.cm-disk .cm-gutterElement:hover .cm-disk-bar': { width: '5px' },
  '.cm-disk-del': {
    position: 'absolute',
    top: '-4px',
    left: '0.1em',
    width: '0',
    height: '0',
    borderTop: '4px solid transparent',
    borderBottom: '4px solid transparent',
    borderLeft: '5px solid #d97757',
  },
  // As sugestões do autocomplete, com a cara dos menus do app.
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: 'var(--code-font)', maxHeight: '16em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '1px 8px', lineHeight: '1.6' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'rgb(14 165 233 / 0.3)', color: 'inherit' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600', color: 'var(--color-sky-500)' },
  '.cm-completionDetail': { fontStyle: 'normal', opacity: '0.6', marginLeft: '0.75em' },
  '.cm-change-del-bottom': { bottom: '-5px' },
  // O lampejo nas linhas que mudaram por fora (o Claude gravou) ou onde a seta de mudança parou.
  '.cm-flash': { animation: 'cm-flash 1.2s ease-out' },
  '@keyframes cm-flash': { from: { backgroundColor: 'rgb(14 165 233 / 0.28)' }, to: { backgroundColor: 'transparent' } },
  '.cm-peek': { whiteSpace: 'normal', cursor: 'default' },
  // O erro no fim da linha (ver `errorLens`), num vermelho puxado para a cor do texto: claro no escuro, escuro no claro.
  '.cm-lens-line': { backgroundColor: 'rgb(239 68 68 / 0.07)' },
  '.cm-lens': {
    marginLeft: '2.5em',
    fontSize: '0.92em',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    color: 'color-mix(in oklab, var(--color-red-500) 80%, var(--foreground))',
  },
  '.cm-lens-msg': { fontStyle: 'italic', opacity: '0.85' },
  '.cm-lens-ask': {
    marginLeft: '0.75em',
    padding: '0.05em 0.7em',
    borderRadius: '999px',
    border: '1px solid rgb(239 68 68 / 0.4)',
    backgroundColor: 'rgb(239 68 68 / 0.12)',
    color: 'inherit',
    font: 'inherit',
    fontFamily: 'var(--font-sans)',
    fontStyle: 'normal',
    fontSize: '0.88em',
    cursor: 'pointer',
  },
  '.cm-lens-ask:hover': { backgroundColor: 'rgb(239 68 68 / 0.25)' },
})

/** O texto dos painéis do CodeMirror em português. */
export const phrases = EditorState.phrases.of({
  Find: 'Buscar',
  Replace: 'Substituir',
  next: 'próximo',
  previous: 'anterior',
  all: 'todos',
  'match case': 'maiúsculas',
  regexp: 'regex',
  'by word': 'palavra inteira',
  replace: 'substituir',
  'replace all': 'substituir todos',
  close: 'fechar',
  'current match': 'resultado atual',
  'on line': 'na linha',
  'replaced $ matches': '$ trocados',
  'replaced match on line $': 'trocado na linha $',
  'Go to line': 'Ir para a linha',
  go: 'ir',
  'Fold line': 'Dobrar',
  'Unfold line': 'Desdobrar',
  'folded code': 'código dobrado',
  unfold: 'desdobrar',
  to: 'até',
  Diagnostics: 'Erros',
  'No diagnostics': 'Nenhum erro',
  'Selection deleted': 'Seleção apagada',
  'Control character': 'Caractere de controle',
  Completions: 'Sugestões',
})

/**
 * A indentação do arquivo, pelo que já está nele: tab, se a maioria das linhas indentadas começa com
 * tab; senão espaços, de 2 em 2 se há linhas na metade de um passo de 4, ou de 4 em 4.
 */
export function detectIndent(text: string): string {
  let tabs = 0
  let spaces = 0
  let half = 0
  const lines = text.split('\n', 5_000)
  for (const line of lines) {
    const m = /^(\t+| +)\S/.exec(line)
    if (!m) continue
    if (m[1]![0] === '\t') tabs++
    else {
      spaces++
      if (m[1]!.length % 4 === 2) half++
    }
  }
  if (tabs > spaces) return '\t'
  if (spaces === 0) return '  '
  return half > spaces * 0.1 ? '  ' : '    '
}

// ---- o que mudou desde o último commit ----

/**
 * Uma mudança contra o último commit, em linhas (contando de 1, o fim fora): as linhas `fromA` até
 * `toA - 1` do commit viraram as `fromB` até `toB - 1` de agora. Numa que só tirou linhas, `fromB` é a
 * que ficou logo depois do que saiu (ou uma depois da última, se saiu o fim do arquivo).
 */
export type Hunk = { fromA: number; toA: number; fromB: number; toB: number }

type Changes = {
  /** O arquivo no último commit; `null` fora do git (sem marcas). */
  base: Text | null
  hunks: Hunk[]
  markers: RangeSet<GutterMarker>
}

/** Troca a versão do último commit (chega depois de o arquivo abrir, e de novo a cada commit). */
export const setBase = StateEffect.define<Text | null>()
/** As mudanças refeitas agora (ver `rediff`, e o editor, antes de usá-las). */
export const setHunks = StateEffect.define<Hunk[]>()

// Cada linha diferente vira um caractere, e o diff dos dois textos assim é o diff das linhas, como o
// do git. Os caracteres pulam a faixa dos pares substitutos, que o diff partiria ao meio.
const MAX_DISTINCT = 0xffff - 0x800

/** As mudanças linha a linha de `base` para `doc`; `null` com linhas diferentes demais para comparar assim. */
export function hunksOf(base: Text, doc: Text): Hunk[] | null {
  const ids = new Map<string, number>()
  const encode = (text: Text) => {
    const codes: number[] = []
    for (let i = 1; i <= text.lines; i++) {
      const line = text.line(i).text
      let id = ids.get(line)
      if (id === undefined) {
        id = ids.size
        ids.set(line, id)
      }
      codes.push(id < 0xd800 ? id : id + 0x800)
    }
    return codes
  }
  const a = encode(base)
  const b = encode(doc)
  if (ids.size > MAX_DISTINCT) return null
  const str = (codes: number[]) => {
    let out = ''
    for (let i = 0; i < codes.length; i += 8_192) out += String.fromCharCode(...codes.slice(i, i + 8_192))
    return out
  }
  return diff(str(a), str(b), { scanLimit: 5_000, timeout: 80 }).map((c) => ({ fromA: c.fromA + 1, toA: c.toA + 1, fromB: c.fromB + 1, toB: c.toB + 1 }))
}

export const hunkKind = (h: Hunk): Block['kind'] => (h.toB > h.fromB ? (h.toA > h.fromA ? 'mod' : 'add') : 'del')

/** A linha onde a mudança aparece: a primeira dela, ou a que ficou depois do que saiu (a última, no fim do arquivo). */
export const hunkLine = (h: Hunk, doc: Text) => Math.min(h.fromB, doc.lines)

class ChangeMarker extends GutterMarker {
  readonly kind: 'add' | 'mod' | 'del-top' | 'del-bottom'
  constructor(kind: ChangeMarker['kind']) {
    super()
    this.kind = kind
  }
  eq(other: ChangeMarker) {
    return other.kind === this.kind
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = this.kind.startsWith('del') ? `cm-change-del cm-${this.kind.replace('del', 'change-del')}` : `cm-change-bar cm-change-${this.kind}`
    return el
  }
}

const MARKERS = {
  add: new ChangeMarker('add'),
  mod: new ChangeMarker('mod'),
  'del-top': new ChangeMarker('del-top'),
  'del-bottom': new ChangeMarker('del-bottom'),
}

function markersOf(hunks: Hunk[], doc: Text): RangeSet<GutterMarker> {
  const b = new RangeSetBuilder<GutterMarker>()
  for (const h of hunks) {
    const kind = hunkKind(h)
    if (kind !== 'del') {
      for (let n = h.fromB; n < h.toB; n++) b.add(doc.line(n).from, doc.line(n).from, MARKERS[kind])
    } else {
      // Só saíram linhas: o triângulo fica entre a linha de cima e a de baixo; no fim do arquivo, no pé da última.
      const n = hunkLine(h, doc)
      b.add(doc.line(n).from, doc.line(n).from, MARKERS[h.fromB > doc.lines ? 'del-bottom' : 'del-top'])
    }
  }
  return b.finish()
}

export const changesField = StateField.define<Changes>({
  create: () => ({ base: null, hunks: [], markers: RangeSet.empty }),
  update(value, tr) {
    let next = tr.docChanged ? { ...value, markers: value.markers.map(tr.changes) } : value
    for (const e of tr.effects) {
      if (e.is(setBase)) {
        const hunks = (e.value && hunksOf(e.value, tr.newDoc)) ?? []
        next = { base: e.value, hunks, markers: markersOf(hunks, tr.newDoc) }
      } else if (e.is(setHunks)) {
        next = { ...next, hunks: e.value, markers: markersOf(e.value, tr.newDoc) }
      }
    }
    return next
  },
})

/**
 * Refaz a comparação depois de uma pausa na digitação, e não a cada tecla. Enquanto isso, as marcas
 * acompanham o texto onde estão.
 */
const rediff = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | undefined
    update(u: ViewUpdate) {
      if (!u.docChanged || !u.state.field(changesField).base) return
      clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        const { base } = u.view.state.field(changesField)
        if (base) u.view.dispatch({ effects: setHunks.of(hunksOf(base, u.view.state.doc) ?? []) })
      }, 150)
    }
    destroy() {
      clearTimeout(this.timer)
    }
  },
)

/** A mudança `h` no formato do peek e das marcas do arquivo só leitura (ver changes.tsx). */
export function blockOf(h: Hunk, base: Text, doc: Text): Block {
  const lines = (text: Text, from: number, to: number) => Array.from({ length: to - from }, (_, k) => text.line(from + k).text)
  const kind = hunkKind(h)
  const start = hunkLine(h, doc)
  return { kind, start, end: kind === 'del' ? start : h.toB - 1, removed: lines(base, h.fromA, h.toA), added: lines(doc, h.fromB, h.toB) }
}

/** Quanto entrou e saiu, em linhas, e a marca de cada linha (para o minimapa). */
export function changeStats(state: EditorState): { added: number; removed: number; marks: (Mark | undefined)[] } {
  const { hunks } = state.field(changesField)
  const marks: (Mark | undefined)[] = []
  let added = 0
  let removed = 0
  for (const h of hunks) {
    added += h.toB - h.fromB
    removed += h.toA - h.fromA
    const kind = hunkKind(h)
    if (kind === 'del') marks[hunkLine(h, state.doc) - 1] ??= 'del'
    else for (let n = h.fromB; n < h.toB; n++) marks[n - 1] = kind
  }
  return { added, removed, marks }
}

/** A mudança que tem uma marca na linha que começa em `from` (para o clique na margem). */
export function hunkAtLine(state: EditorState, from: number): number {
  const n = state.doc.lineAt(from).number
  return state.field(changesField).hunks.findIndex((h) => (h.toB > h.fromB ? h.fromB <= n && n < h.toB : hunkLine(h, state.doc) === n))
}

/** A margem com as marcas; clicar numa abre (ou fecha) a mudança dela, em `onOpen`. */
export function changeGutter(onOpen: (index: number) => void): Extension {
  return [
    changesField,
    rediff,
    gutter({
      class: 'cm-changes',
      markers: (view) => view.state.field(changesField).markers,
      domEventHandlers: {
        mousedown: (view, line) => {
          const k = hunkAtLine(view.state, line.from)
          if (k < 0) return false
          onOpen(k)
          return true
        },
      },
    }),
  ]
}

// ---- o que mudou no disco desde que o arquivo abriu ----

/**
 * Um trecho que mudou por fora (o Claude, outro editor, um `git checkout`) desde que o arquivo abriu:
 * as linhas de `from` a `to` de agora, e o que havia antes da última troca ali. Numa troca que só tirou
 * linhas, `from` é o começo da linha que ficou logo depois (ou o fim do arquivo).
 */
export type DiskMark = { from: number; to: number; removed: string[] }

/** Novos trechos mudados no disco (posições no texto já trocado). */
export const addDiskMarks = StateEffect.define<DiskMark[]>()
/** Tira a marca `index` (o "Visto" do peek), ou todas com `'all'`. */
export const clearDiskMark = StateEffect.define<number | 'all'>()

/** Os trechos de `next` que mudaram em relação a `prev`, linha a linha, como marcas. */
export function diskMarksOf(prev: Text, next: Text): DiskMark[] {
  return (hunksOf(prev, next) ?? []).map((h) => {
    const removed = Array.from({ length: h.toA - h.fromA }, (_, k) => prev.line(h.fromA + k).text)
    if (h.toB === h.fromB) {
      const at = h.fromB <= next.lines ? next.line(h.fromB).from : next.length
      return { from: at, to: at, removed }
    }
    return { from: next.line(h.fromB).from, to: next.line(h.toB - 1).to, removed }
  })
}

export const diskField = StateField.define<DiskMark[]>({
  create: () => [],
  update(marks, tr) {
    if (tr.docChanged) marks = marks.map((m) => ({ ...m, from: tr.changes.mapPos(m.from, -1), to: Math.max(tr.changes.mapPos(m.from, -1), tr.changes.mapPos(m.to, 1)) }))
    for (const e of tr.effects) {
      if (e.is(clearDiskMark)) marks = e.value === 'all' ? [] : marks.filter((_, i) => i !== e.value)
      if (!e.is(addDiskMarks)) continue
      // Uma troca nova em cima de uma marca antiga fica no lugar dela: o "antes" passa a ser o da última troca.
      const added = e.value
      marks = marks.filter((m) => !added.some((n) => n.from <= m.to && m.from <= n.to)).concat(added)
      marks.sort((a, b) => a.from - b.from)
    }
    return marks
  },
})

class DiskMarker extends GutterMarker {
  readonly kind: 'bar' | 'del'
  constructor(kind: DiskMarker['kind']) {
    super()
    this.kind = kind
  }
  eq(other: DiskMarker) {
    return other.kind === this.kind
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = this.kind === 'bar' ? 'cm-disk-bar' : 'cm-disk-del'
    return el
  }
}
const DISK_BAR = new DiskMarker('bar')
const DISK_DEL = new DiskMarker('del')

/** A marca do disco que cobre a linha que começa em `from`. */
export function diskMarkAtLine(state: EditorState, from: number): number {
  const line = state.doc.lineAt(from)
  return state.field(diskField).findIndex((m) => (m.from === m.to ? state.doc.lineAt(m.from).number === line.number : m.from <= line.to && line.from <= m.to))
}

/**
 * A coluna laranja (a cor do Claude) à esquerda das marcas do git: o que mudou no disco desde que o
 * arquivo abriu, até você marcar como visto. Clicar abre o antes e o depois (`onOpen`).
 */
export function diskGutter(onOpen: (index: number) => void): Extension {
  return [
    diskField,
    gutter({
      class: 'cm-disk',
      markers: (view) => {
        const b = new RangeSetBuilder<GutterMarker>()
        const { doc } = view.state
        for (const m of view.state.field(diskField)) {
          if (m.from === m.to) {
            const line = doc.lineAt(m.from)
            b.add(line.from, line.from, DISK_DEL)
            continue
          }
          const last = doc.lineAt(m.to).number
          for (let n = doc.lineAt(m.from).number; n <= last; n++) b.add(doc.line(n).from, doc.line(n).from, DISK_BAR)
        }
        return b.finish()
      },
      domEventHandlers: {
        mousedown: (view, line) => {
          const k = diskMarkAtLine(view.state, line.from)
          if (k < 0) return false
          onOpen(k)
          return true
        },
      },
    }),
  ]
}

/** A marca do disco no formato do peek (ver changes.tsx). */
export function diskBlockOf(m: DiskMark, doc: Text): Block {
  const start = doc.lineAt(m.from).number
  if (m.from === m.to) return { kind: 'del', start, end: start, removed: m.removed, added: [] }
  const end = doc.lineAt(m.to).number
  const added = Array.from({ length: end - start + 1 }, (_, k) => doc.line(start + k).text)
  return { kind: m.removed.length ? 'mod' : 'add', start, end, removed: m.removed, added }
}

// ---- os símbolos do arquivo (Ctrl+Shift+O) ----

export type SymbolKind = 'function' | 'method' | 'class' | 'type' | 'heading'
export type CodeSymbol = { name: string; kind: SymbolKind; from: number; line: number; depth: number }

// Os nomes dos nós das gramáticas do CodeMirror (JavaScript/TypeScript, Python, Rust, Go, Java, PHP...).
const SYMBOL_KINDS: [RegExp, SymbolKind][] = [
  [/^(FunctionDeclaration|FunctionDefinition|FunctionItem|FunctionDecl)$/, 'function'],
  [/^(MethodDeclaration|MethodDecl|MethodDefinition)$/, 'method'],
  [/^(ClassDeclaration|ClassDefinition|InterfaceDeclaration|EnumDeclaration|StructItem|EnumItem|TraitItem|ImplItem)$/, 'class'],
  [/^(TypeAliasDeclaration|TypeSpec|TypeItem)$/, 'type'],
  [/^(ATXHeading\d|SetextHeading\d)$/, 'heading'],
]
const NAME_NODES = new Set(['VariableDefinition', 'PropertyDefinition', 'TypeDefinition', 'VariableName', 'Definition', 'Identifier', 'TypeIdentifier', 'BoundIdentifier', 'FieldIdentifier', 'PropertyName', 'Name'])

/**
 * As funções, classes, métodos e tipos do arquivo (no Markdown, os títulos), na ordem, tirados do parser
 * do editor: nada de LSP. Uma constante de nível de cima que guarda uma função (`const Foo = () =>`)
 * também conta, que é como se escreve componente React.
 */
export function symbolsOf(state: EditorState): CodeSymbol[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 300) ?? syntaxTree(state)
  const out: CodeSymbol[] = []
  // Os símbolos ainda abertos (onde terminam e o nó), para os métodos ficarem dentro da classe.
  const open: { to: number; name: string }[] = []
  tree.iterate({
    enter: (node) => {
      let kind = SYMBOL_KINDS.find(([re]) => re.test(node.name))?.[1]
      // `const Foo = () => ...` no topo do arquivo (ou exportada).
      if (!kind && node.name === 'VariableDeclaration') {
        const parent = node.node.parent
        const top = parent?.name === 'Script' || (parent?.name === 'ExportDeclaration' && parent.parent?.name === 'Script')
        const fn = top && node.node.getChildren('ArrowFunction').length + node.node.getChildren('FunctionExpression').length > 0
        if (fn) kind = 'function'
      }
      if (!kind) return
      let name: string
      if (kind === 'heading') name = state.sliceDoc(node.from, node.to).split('\n')[0]!.replace(/^#+\s*/, '').replace(/\s*#*$/, '')
      else {
        let child = node.node.firstChild
        while (child && !NAME_NODES.has(child.name)) child = child.nextSibling
        name = child ? state.sliceDoc(child.from, child.to) : ''
      }
      if (!name.trim()) return
      out.push({ name: name.trim(), kind: kind === 'function' && open.length > 0 ? 'method' : kind, from: node.from, line: state.doc.lineAt(node.from).number, depth: kind === 'heading' ? Number(/\d/.exec(node.name)?.[0] ?? 1) - 1 : open.length })
      if (kind !== 'heading') open.push({ to: node.to, name: node.name })
    },
    leave: (node) => {
      const top = open.at(-1)
      if (top && top.to === node.to && top.name === node.name) open.pop()
    },
  })
  return out
}

// ---- o peek de uma mudança ----

/** Um lugar no meio das linhas onde o React desenha o peek (ver editor.tsx), por um portal. */
class HostWidget extends WidgetType {
  readonly host: HTMLElement
  constructor(host: HTMLElement) {
    super()
    this.host = host
  }
  eq(other: HostWidget) {
    return other.host === this.host
  }
  toDOM() {
    return this.host
  }
  ignoreEvent() {
    return true
  }
}

/** Abre o peek em `pos` (debaixo da linha, ou acima dela com `above`), ou fecha com `null`. */
export const setPeek = StateEffect.define<{ pos: number; above: boolean; host: HTMLElement } | null>()

export const peekField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setPeek)) continue
      deco = e.value
        ? Decoration.set(Decoration.widget({ widget: new HostWidget(e.value.host), block: true, side: e.value.above ? -1 : 1 }).range(e.value.pos))
        : Decoration.none
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

// ---- lampejo ----

/** Faz piscar as linhas de `from` a `to` (posições), como o lampejo do arquivo só leitura. */
export const flash = StateEffect.define<{ from: number; to: number }[]>()
const unflash = StateEffect.define<null>()

const flashLine = Decoration.line({ class: 'cm-flash' })

export const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(unflash)) deco = Decoration.none
      if (!e.is(flash)) continue
      const b = new RangeSetBuilder<Decoration>()
      const seen = new Set<number>()
      for (const { from, to } of e.value) {
        const last = tr.state.doc.lineAt(Math.min(to, tr.state.doc.length)).number
        for (let n = tr.state.doc.lineAt(from).number; n <= last; n++) {
          const line = tr.state.doc.line(n)
          if (!seen.has(line.from)) b.add(line.from, line.from, flashLine)
          seen.add(line.from)
        }
      }
      deco = b.finish()
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** Pisca e, quando a animação acaba, tira a marca, para a próxima vez piscar de novo. */
export function flashLines(view: EditorView, ranges: { from: number; to: number }[]): void {
  if (ranges.length === 0) return
  view.dispatch({ effects: flash.of(ranges) })
  setTimeout(() => {
    if (view.dom.isConnected) view.dispatch({ effects: unflash.of(null) })
  }, 1300)
}

// ---- erros de sintaxe ----

/**
 * O trecho a sublinhar: a palavra do erro inteira, porque um ponto só não dá para achar com o mouse. No
 * erro vazio ("falta alguma coisa"), a palavra logo antes dele; sem palavra, o resto da linha.
 */
function errorSpan(state: EditorState, from: number, to: number): [number, number] {
  const line = state.doc.lineAt(from)
  const end = Math.min(to, line.to)
  const word = state.wordAt(from) ?? (from > line.from ? state.wordAt(from - 1) : null)
  const a = Math.min(from, word?.from ?? from)
  const b = Math.max(end, word?.to ?? end)
  if (b - a >= 2) return [a, b]
  const text = line.text.trimEnd()
  const indent = text.length - text.trimStart().length
  return text ? [Math.min(a, line.from + indent), Math.max(b, line.from + text.length)] : [from, from]
}

/**
 * A mensagem do erro no fim da linha, como a extensão Error Lens do VSCode, com o "Pedir ao Claude"
 * à mão: um botão de verdade, e não só o da dica que aparece ao passar o mouse no sublinhado.
 */
class LensWidget extends WidgetType {
  readonly message: string
  readonly onAsk: (line: number, message: string) => void
  constructor(message: string, onAsk: (line: number, message: string) => void) {
    super()
    this.message = message
    this.onAsk = onAsk
  }
  eq(other: LensWidget) {
    return other.message === this.message
  }
  toDOM(view: EditorView) {
    const el = document.createElement('span')
    el.className = 'cm-lens'
    const msg = document.createElement('span')
    msg.className = 'cm-lens-msg'
    msg.textContent = this.message
    const ask = document.createElement('button')
    ask.type = 'button'
    ask.className = 'cm-lens-ask'
    ask.textContent = 'Pedir ao Claude'
    ask.title = 'Mandar a linha e o erro para o chat'
    // O clique não tira o cursor de onde estava.
    ask.onmousedown = (e) => e.preventDefault()
    ask.onclick = () => this.onAsk(view.state.doc.lineAt(view.posAtDOM(el)).number, this.message)
    el.append(msg, ask)
    return el
  }
  ignoreEvent() {
    return true
  }
}

/** A linha com erro ganha um fundo vermelho leve e a mensagem no fim, a cada vez que a checagem roda. */
function errorLens(onAsk: (line: number, message: string) => void) {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      deco = deco.map(tr.changes)
      for (const e of tr.effects) {
        if (!e.is(setDiagnosticsEffect)) continue
        const marks = e.value.flatMap((d) => {
          const line = tr.state.doc.lineAt(Math.min(d.from, tr.state.doc.length))
          return [Decoration.line({ class: 'cm-lens-line' }).range(line.from), Decoration.widget({ widget: new LensWidget(d.message, onAsk), side: 1 }).range(line.to)]
        })
        deco = Decoration.set(marks, true)
      }
      return deco
    },
    provide: (f) => EditorView.decorations.from(f),
  })
}

/**
 * Os erros de sintaxe que o parser do editor acha, só no trecho na tela: nada de ler o projeto, nem de
 * rodar nada no PC. Um por linha, para uma chave aberta não sublinhar o arquivo todo. Cada um tem o
 * "Pedir ao Claude", no fim da linha e na dica, que leva a linha e o erro para o chat (`onAsk`).
 */
export function syntaxErrors(onAsk: (line: number, message: string) => void): Extension {
  return [
    linter(
      (view) => {
        const found: Diagnostic[] = []
        const lines = new Set<number>()
        const tree = syntaxTree(view.state)
        for (const { from, to } of view.visibleRanges) {
          tree.iterate({
            from,
            to,
            enter: (node) => {
              if (!node.type.isError) return
              const line = view.state.doc.lineAt(node.from)
              if (lines.has(line.number)) return false
              lines.add(line.number)
              const text = view.state.sliceDoc(node.from, Math.min(node.to, line.to)).trim()
              const message = text ? `Não era para ter “${text.length > 40 ? `${text.slice(0, 40)}…` : text}” aqui.` : 'Falta alguma coisa aqui.'
              const [a, b] = errorSpan(view.state, node.from, node.to)
              found.push({
                from: a,
                to: b,
                severity: 'error',
                source: 'sintaxe',
                message,
                actions: [{ name: 'Pedir ao Claude', apply: () => onAsk(line.number, message) }],
              })
              return false
            },
          })
        }
        return found
      },
      // Ao rolar, o trecho na tela muda: confere o novo.
      { delay: 600, needsRefresh: (update) => update.viewportChanged },
    ),
    errorLens(onAsk),
  ]
}
