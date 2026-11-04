import { toast } from 'sonner'
import { create } from 'zustand'
import { api, errorMessage } from './api'

/**
 * O que foi editado no editor do PC e ainda não foi salvo, por aba de arquivo (a chave dela em
 * lib/workbench.ts). Fica fora do editor, que é carregado só quando se abre um arquivo: as abas
 * precisam saber disso para mostrar o ponto e perguntar antes de fechar, como no VSCode.
 *
 * Levar a aba para outro grupo monta o editor de novo: o texto não salvo passa por `drafts` e volta
 * igual. Recarregar a página ainda perde, e por isso o navegador pergunta antes (ver o fim do arquivo).
 */

type State = {
  /** As abas com alteração não salva. */
  dirty: Record<string, true>
  /** A pergunta aberta ao fechar abas com alteração (ver UnsavedDialog). */
  asking: { keys: string[]; answer: (close: boolean) => void } | null
}

export const useUnsaved = create<State>(() => ({ dirty: {}, asking: null }))

/** O texto e a versão do disco de onde ele partiu, guardados quando o editor sai da tela sem salvar. */
export const drafts = new Map<string, { text: string; base: string }>()

/** Quem salva cada aba aberta no editor; `false` se não deu (o editor já avisou o porquê). */
const savers = new Map<string, () => Promise<boolean>>()

export function setDirty(key: string, dirty: boolean): void {
  const now = useUnsaved.getState().dirty
  if (Boolean(now[key]) === dirty) return
  const next = { ...now }
  if (dirty) next[key] = true
  else delete next[key]
  useUnsaved.setState({ dirty: next })
}

/** O editor da aba se oferece para salvar quando a pergunta de fechar pedir; devolve quem tira a oferta. */
export function registerSaver(key: string, save: () => Promise<boolean>): () => void {
  savers.set(key, save)
  return () => {
    if (savers.get(key) === save) savers.delete(key)
  }
}

/** O nome do arquivo de uma aba (`f:máquina\npasta\ncaminho\nlado`). */
export const fileNameOf = (key: string) => key.split('\n')[2]?.split('/').pop() ?? ''

/**
 * Fechar `keys`: sem alteração pendente, fecha na hora (`close`); com, pergunta antes, e fecha se a
 * resposta for salvar (e salvou) ou não salvar.
 */
export function closeGuarded(keys: string[], close: () => void): void {
  const { dirty, asking } = useUnsaved.getState()
  const pending = keys.filter((k) => dirty[k])
  if (pending.length === 0) return close()
  // Uma pergunta por vez: outro pedido enquanto ela está aberta conta como cancelado.
  if (asking) return
  useUnsaved.setState({
    asking: {
      keys: pending,
      answer: (ok) => {
        useUnsaved.setState({ asking: null })
        if (ok) close()
      },
    },
  })
}

/** Salva as abas da pergunta; `true` se todas salvaram. */
export async function saveAll(keys: string[]): Promise<boolean> {
  const results = await Promise.all(keys.map((k) => savers.get(k)?.() ?? saveDraft(k)))
  return results.every(Boolean)
}

/** A aba sem editor na tela (o Markdown formatado à vista, por exemplo): grava o rascunho guardado. */
async function saveDraft(key: string): Promise<boolean> {
  const draft = drafts.get(key)
  const [machine, cwd, path] = key.slice(2).split('\n')
  if (!draft || machine === undefined || !cwd || !path) return false
  try {
    await api.saveFile(machine, cwd, path, draft.text, draft.base)
    discard([key])
    return true
  } catch (err) {
    toast.error(`Não deu para salvar ${fileNameOf(key)}`, { description: errorMessage(err) })
    return false
  }
}

/** Esquece o que não foi salvo nas abas (a resposta "Não salvar"). */
export function discard(keys: string[]): void {
  for (const k of keys) {
    drafts.delete(k)
    setDirty(k, false)
  }
}

// Recarregar ou fechar a janela com algo não salvo: o navegador pergunta (com o texto dele, não o nosso).
window.addEventListener('beforeunload', (e) => {
  if (Object.keys(useUnsaved.getState().dirty).length > 0) e.preventDefault()
})
