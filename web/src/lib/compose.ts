import { useEffect, useRef } from 'react'

/**
 * Os campos na tela por id do rascunho. A mesma conversa pode ter dois (a aba dela e a miniatura na
 * mesa do projeto, ver project/hub.tsx): vale o último que apareceu, e quando ele sai volta o de antes.
 */
type Registry<T> = Map<string, ((value: T) => void)[]>

function useRegister<T>(registry: Registry<T>, id: string, handler: (value: T) => void): void {
  const latest = useRef(handler)
  useEffect(() => {
    latest.current = handler
  })
  useEffect(() => {
    const fn = (value: T) => latest.current(value)
    registry.set(id, [...(registry.get(id) ?? []), fn])
    return () => {
      const rest = (registry.get(id) ?? []).filter((f) => f !== fn)
      if (rest.length) registry.set(id, rest)
      else registry.delete(id)
    }
  }, [registry, id])
}

function deliver<T>(registry: Registry<T>, id: string, value: T): boolean {
  const fn = registry.get(id)?.at(-1)
  fn?.(value)
  return Boolean(fn)
}

/**
 * Escrever no campo de mensagem de uma conversa de fora dele, como mencionar um arquivo pela barra
 * do projeto. Cada campo na tela se registra pelo id do rascunho dele (o da conversa, ou `new:...`
 * na conversa nova).
 */
const fields: Registry<string> = new Map()

/** Registra o campo `id` enquanto ele está na tela. */
export function useInsertTarget(id: string, insert: (text: string) => void): void {
  useRegister(fields, id, insert)
}

/** Põe `text` onde está o cursor do campo `id` e o deixa em foco; `false` se o campo não está na tela. */
export function insertInto(id: string, text: string): boolean {
  return deliver(fields, id, text)
}

/**
 * Anexar arquivos no campo de mensagem de uma conversa de fora dele: soltar imagens em qualquer lugar
 * da conversa, não só em cima da caixa. Mesmo registro por id do rascunho.
 */
const attachers: Registry<File[]> = new Map()

export function useAttachTarget(id: string, add: (files: File[]) => void): void {
  useRegister(attachers, id, add)
}

/** Anexa `files` no campo `id`; `false` se o campo não está na tela (conversa só de leitura, por exemplo). */
export function attachInto(id: string, files: File[]): boolean {
  return deliver(attachers, id, files)
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
