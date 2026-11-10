// Seleção do editor como no VSCode: pinta só o texto selecionado de cada linha (não a largura toda), com cantos arredondados.
// O `drawSelection` segue cuidando do cursor e de esconder a seleção nativa; a camada dele de seleção fica escondida e esta a substitui.
import { EditorSelection, type SelectionRange } from '@codemirror/state'
import { EditorView, layer, RectangleMarker, type LayerMarker } from '@codemirror/view'

// Pedaço de uma linha só, com `more` quando a seleção continua na linha de baixo (a quebra entra, como um respiro à direita).
function markersOf(view: EditorView, range: SelectionRange): LayerMarker[] {
  const { doc } = view.state
  const out: LayerMarker[] = []
  const gap = view.defaultCharacterWidth * 0.5
  const box = view.scrollDOM.getBoundingClientRect()
  const sx = box.width / view.scrollDOM.offsetWidth || 1
  const sy = box.height / view.scrollDOM.offsetHeight || 1
  const left = box.left - view.scrollDOM.scrollLeft * sx
  const top = box.top - view.scrollDOM.scrollTop * sy
  for (const vr of view.visibleRanges) {
    const start = Math.max(vr.from, range.from)
    const end = Math.min(vr.to, range.to)
    if (start > end) continue
    for (let pos = start; pos <= end; ) {
      const line = doc.lineAt(pos)
      const from = Math.max(start, line.from)
      const to = Math.min(end, line.to)
      const more = line.to < range.to
      if (from < to) {
        const parts = [...RectangleMarker.forRange(view, 'cm-sel', EditorSelection.range(from, to))]
        if (more && parts.length) {
          const last = parts[parts.length - 1]
          parts[parts.length - 1] = new RectangleMarker('cm-sel', last.left, last.top, (last.width ?? 0) + gap, last.height)
        }
        out.push(...parts)
      } else if (more) {
        // Linha vazia (ou seleção que começa no fim da linha): só o respiro.
        const c = view.coordsAtPos(from, 1)
        if (c) out.push(new RectangleMarker('cm-sel', c.left - left, c.top - top, gap, c.bottom - c.top))
      }
      pos = line.to + 1
    }
  }
  return out
}

export const lineSelection = [
  layer({
    above: false,
    class: 'cm-lineSelectionLayer',
    markers: (view) => view.state.selection.ranges.filter((r) => !r.empty).flatMap((r) => markersOf(view, r)),
    update: (u) => u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged || u.focusChanged,
  }),
  EditorView.theme({
    '.cm-selectionLayer': { display: 'none' },
    '.cm-sel': { background: 'rgb(14 165 233 / 0.18)', borderRadius: '4px', position: 'absolute' },
    '&.cm-focused .cm-sel': { background: 'rgb(14 165 233 / 0.3)' },
  }),
]
