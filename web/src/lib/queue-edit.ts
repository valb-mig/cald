import { create } from 'zustand'
import { api } from './api'
import { contentOf, type ComposerContent } from './compose'

/**
 * A mensagem da fila aberta na caixa para editar, por conversa: o id, o modelo e o esforço dela (o
 * seletor da caixa mostra e muda estes) e o que a caixa tinha antes, que volta quando ela fecha.
 */
export type QueueEdit = { id: string; model?: string; effort?: string; stash: ComposerContent }

export const useQueueEdit = create<Record<string, QueueEdit | undefined>>(() => ({}))

const put = (sessionId: string, edit: QueueEdit | undefined) => useQueueEdit.setState({ [sessionId]: edit })

/** A aberta, com o que está na caixa agora: o que se grava nela. */
const saving = (edit: QueueEdit, content: ComposerContent) => ({ id: edit.id, ...content, model: edit.model, effort: edit.effort })

/**
 * Abre a mensagem `itemId` da fila na caixa da conversa, sem tirá-la da fila: a que estava aberta é
 * gravada antes, e o que a caixa tinha antes da primeira fica guardado. Abrir a que já está aberta fecha.
 */
export async function openQueued(sessionId: string, itemId: string): Promise<void> {
  const edit = useQueueEdit.getState()[sessionId]
  if (edit?.id === itemId) return closeQueued(sessionId)
  const box = contentOf(sessionId)
  if (!box) throw new Error('A caixa de mensagem não está aberta aqui.')
  const content = box.get()
  try {
    const { message } = await api.editQueued(sessionId, itemId, edit && saving(edit, content))
    if (!message) return
    box.set({ text: message.text, attachments: message.attachments })
    put(sessionId, { id: itemId, model: message.model, effort: message.effort, stash: edit?.stash ?? content })
  } catch (err) {
    // A de antes já foi gravada (ou nada mudou): a caixa volta ao que era.
    if (edit) {
      box.set(edit.stash)
      put(sessionId, undefined)
    }
    throw err
  }
}

/** Fecha a mensagem aberta, gravando nela o que está na caixa, e devolve à caixa o que ela tinha antes. */
export async function closeQueued(sessionId: string): Promise<void> {
  const edit = useQueueEdit.getState()[sessionId]
  if (!edit) return
  const box = contentOf(sessionId)
  await api.editQueued(sessionId, null, box && saving(edit, box.get()))
  box?.set(edit.stash)
  put(sessionId, undefined)
}

/** O seletor da caixa com uma mensagem da fila aberta: muda o modelo e o esforço dela. */
export function setQueuedSettings(sessionId: string, patch: { model?: string; effort?: string }): void {
  const edit = useQueueEdit.getState()[sessionId]
  if (!edit) return
  put(sessionId, { ...edit, ...(patch.model ? { model: patch.model } : {}), ...(patch.effort ? { effort: patch.effort } : {}) })
}
