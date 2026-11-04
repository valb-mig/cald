import { create } from 'zustand'

/**
 * Onde está o cursor de cada editor aberto (por aba, a chave dela em lib/workbench.ts), para a barra de
 * status mostrar a do arquivo em foco, como o VSCode: linha e coluna, a indentação, a quebra de linha e
 * a linguagem. Fica fora do editor, que é carregado só quando um arquivo abre.
 */
export type EditorCursor = {
  line: number
  col: number
  /** Caracteres selecionados (somando os vários cursores); 0 sem seleção. */
  selected: number
  /** "Espaços: 2" ou "Tabs: 4". */
  indent: string
  eol: 'LF' | 'CRLF'
  language: string | null
}

export const useEditorCursor = create<Record<string, EditorCursor>>(() => ({}))

export function setEditorCursor(key: string, cursor: EditorCursor | null): void {
  useEditorCursor.setState((s) => {
    const next = { ...s }
    if (cursor) next[key] = cursor
    else delete next[key]
    return next
  }, true)
}

/** O que a barra de status pede ao editor de cada aba: abrir o "ir para a linha" (o clique em Ln/Col). */
export const editorCommands = new Map<string, { gotoLine: () => void }>()
