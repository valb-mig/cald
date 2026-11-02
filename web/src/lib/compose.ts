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

/**
 * Anexar arquivos no campo de mensagem de uma conversa de fora dele: soltar imagens em qualquer lugar
 * da conversa, não só em cima da caixa. Mesmo registro por id do rascunho.
 */
const attachers = new Map<string, (files: File[]) => void>()

export function useAttachTarget(id: string, add: (files: File[]) => void): void {
  const latest = useRef(add)
  useEffect(() => {
    latest.current = add
  })
  useEffect(() => {
    const fn = (files: File[]) => latest.current(files)
    attachers.set(id, fn)
    return () => {
      if (attachers.get(id) === fn) attachers.delete(id)
    }
  }, [id])
}

/** Anexa `files` no campo `id`; `false` se o campo não está na tela (conversa só de leitura, por exemplo). */
export function attachInto(id: string, files: File[]): boolean {
  const add = attachers.get(id)
  add?.(files)
  return Boolean(add)
}

/**
 * Os arquivos de uma colagem, sem repetir. `files` e `items` trazem a mesma coisa quase sempre, mas
 * alguns navegadores e programas (capturas, gerenciador de arquivos) põem nos itens o que falta na lista.
 */
export function pastedFiles(data: DataTransfer): File[] {
  const out: File[] = []
  const seen = new Set<string>()
  const push = (f: File | null) => {
    if (!f) return
    const key = `${f.name}\n${f.size}\n${f.type}\n${f.lastModified}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(f)
  }
  for (const f of data.files) push(f)
  for (const item of data.items) if (item.kind === 'file') push(item.getAsFile())
  return out
}
