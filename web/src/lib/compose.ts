import { useEffect, useRef } from 'react'

/**
 * Escrever no campo de mensagem de uma conversa de fora dele, como mencionar um arquivo pela barra
 * do projeto. Cada campo na tela se registra pelo id do rascunho dele (o da conversa, ou `new:...`
 * na conversa nova).
 */
const fields = new Map<string, (text: string) => void>()

/** Registra o campo `id` enquanto ele está na tela. */
export function useInsertTarget(id: string, insert: (text: string) => void): void {
  const latest = useRef(insert)
  useEffect(() => {
    latest.current = insert
  })
  useEffect(() => {
    const fn = (text: string) => latest.current(text)
    fields.set(id, fn)
    return () => {
      if (fields.get(id) === fn) fields.delete(id)
    }
  }, [id])
}

/** Põe `text` onde está o cursor do campo `id` e o deixa em foco; `false` se o campo não está na tela. */
export function insertInto(id: string, text: string): boolean {
  const insert = fields.get(id)
  insert?.(text)
  return Boolean(insert)
}
