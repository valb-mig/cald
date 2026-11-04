import { toast } from 'sonner'
import { create } from 'zustand'
import { api, errorMessage } from './api'
import { idb, kvDel, kvGet, kvSet } from './db'

/**
 * O que foi editado no editor do PC e ainda não foi salvo, por aba de arquivo (a chave dela em
 * lib/workbench.ts). Fica fora do editor, que é carregado só quando se abre um arquivo: as abas
 * precisam saber disso para mostrar o ponto e perguntar antes de fechar, como no VSCode.
 *
 * Levar a aba para outro grupo monta o editor de novo: o texto não salvo passa por `drafts` e volta
 * igual. Ele também vai para o banco do aparelho (IndexedDB) depois de uma pausa na digitação, e por
 * isso sobrevive a recarregar a página ou fechar o app: a aba volta com o ponto e o texto.
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
  // Salvo ou descartado: o rascunho guardado no aparelho sai junto.
  if (!dirty) forgetDraft(key)
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

// ---- o rascunho no aparelho ----

const DRAFT = 'draft:'
// Rascunho esquecido (a aba sumiu de outro jeito) não fica para sempre no aparelho.
const DRAFT_MAX_AGE = 14 * 24 * 60 * 60 * 1000
type Stored = { text: string; base: string; at: number }

/** As gravações ainda esperando a pausa na digitação. */
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; write: () => void }>()

/** Guarda no aparelho o texto não salvo da aba, depois de uma pausa; `text` é lido só na hora de gravar. */
export function persistDraft(key: string, text: () => string, base: string): void {
  clearTimeout(pending.get(key)?.timer)
  const write = () => {
    pending.delete(key)
    void kvSet(DRAFT + key, { text: text(), base, at: Date.now() } satisfies Stored).catch(() => {})
  }
  pending.set(key, { timer: setTimeout(write, 800), write })
}

function forgetDraft(key: string): void {
  clearTimeout(pending.get(key)?.timer)
  pending.delete(key)
  void kvDel(DRAFT + key).catch(() => {})
}

/**
 * Os rascunhos guardados no aparelho, lidos ao abrir o app: voltam para `drafts` (o editor pega o da
 * aba dele ao montar, ou quando isto termina, se montou antes) e deixam a aba com o ponto.
 */
export const draftsLoaded: Promise<void> = (async () => {
  try {
    const keys = await idb<IDBValidKey[]>('kv', 'readonly', (s) => s.getAllKeys())
    for (const k of keys) {
      if (typeof k !== 'string' || !k.startsWith(DRAFT)) continue
      const stored = await kvGet<Stored>(k)
      const key = k.slice(DRAFT.length)
      if (!stored || Date.now() - stored.at > DRAFT_MAX_AGE) {
        void kvDel(k)
        continue
      }
      if (!drafts.has(key)) drafts.set(key, { text: stored.text, base: stored.base })
      setDirty(key, true)
    }
  } catch {
    // Sem IndexedDB (modo privado): o rascunho vale só enquanto a página está aberta.
  }
})()

// Recarregar ou fechar a janela com um rascunho ainda por gravar: grava já, e o navegador pergunta.
window.addEventListener('beforeunload', (e) => {
  if (pending.size === 0) return
  for (const p of [...pending.values()]) {
    clearTimeout(p.timer)
    p.write()
  }
  e.preventDefault()
})
