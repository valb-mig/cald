import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useLock } from './lock'
import type { AttachmentPayload } from './types'

/**
 * Os campos na tela por id do rascunho. A mesma conversa pode ter dois (a aba dela e a miniatura na
 * mesa do projeto, ver project/hub.tsx): vale o último que apareceu, e quando ele sai volta o de antes.
 */
type Registry<T> = Map<string, ((value: T) => void)[]>

// Quem acompanha os campos entrando e saindo da tela (ver `useHasInsertTarget`).
const watchers = new Set<() => void>()
const watch = (fn: () => void) => {
  watchers.add(fn)
  return () => void watchers.delete(fn)
}

function useRegister<T>(registry: Registry<T>, id: string, handler: (value: T) => void): void {
  const latest = useRef(handler)
  useEffect(() => {
    latest.current = handler
  })
  useEffect(() => {
    const fn = (value: T) => latest.current(value)
    registry.set(id, [...(registry.get(id) ?? []), fn])
    watchers.forEach((w) => w())
    return () => {
      const rest = (registry.get(id) ?? []).filter((f) => f !== fn)
      if (rest.length) registry.set(id, rest)
      else registry.delete(id)
      watchers.forEach((w) => w())
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
const fields: Registry<{ text: string; replacing?: string }> = new Map()

/** Registra o campo `id` enquanto ele está na tela. */
export function useInsertTarget(id: string, insert: (text: string, replacing?: string) => void): void {
  useRegister(fields, id, ({ text, replacing }) => insert(text, replacing))
}

/**
 * Põe `text` onde está o cursor do campo `id` e o deixa em foco; `false` se o campo não está na tela.
 * Com `replacing`, troca esse texto, se ele ainda está no campo, em vez de pôr mais um: escolher outra
 * opção de uma resposta (ver OptionItem, em components/markdown.tsx) não junta as duas.
 */
export function insertInto(id: string, text: string, replacing?: string): boolean {
  return deliver(fields, id, { text, replacing })
}

/** Se o campo `id` está na tela: a conversa aberta em outro app, por exemplo, fica sem ele. */
export function useHasInsertTarget(id: string): boolean {
  return useSyncExternalStore(watch, () => fields.has(id))
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

/** O que está escrito e anexado numa caixa de mensagem. */
export type ComposerContent = { text: string; attachments: AttachmentPayload[] }

/** Ler e trocar tudo o que está numa caixa: abrir uma mensagem da fila nela para editar (ver lib/queue-edit.ts). */
export type ContentHandle = { get: () => ComposerContent; set: (content: ComposerContent) => void }

const contents: Registry<(handle: ContentHandle) => void> = new Map()

export function useContentTarget(id: string, handle: ContentHandle): void {
  useRegister(contents, id, (visit: (handle: ContentHandle) => void) => visit(handle))
}

/** A caixa `id`, se ela está na tela. */
export function contentOf(id: string): ContentHandle | undefined {
  let found: ContentHandle | undefined
  deliver(contents, id, (handle) => (found = handle))
  return found
}

/** Onde o Tab segue o de sempre: um campo (o terminal e o editor de código também são) e o que abre por cima. */
const FIELDS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-composer]'
const OVERLAYS = '[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"], [data-slot="dropdown-menu-content"]'

/** O texto de uma caixa de mensagem à vista em `scope`; as das abas guardadas ficam de fora (`inert`, invisíveis). */
function composerIn(scope: ParentNode): HTMLTextAreaElement | undefined {
  return [...scope.querySelectorAll<HTMLTextAreaElement>('[data-composer] textarea')].find(
    (el) => !el.disabled && !el.closest('[inert]') && el.checkVisibility({ visibilityProperty: true }),
  )
}

let shortcut = false

/**
 * Tab, fora de um campo, abre a caixa de mensagem para escrever: a do grupo de abas em foco no PC (com
 * um arquivo nele, a da conversa ao lado) ou a da tela, no celular com teclado. Sem caixa à vista, ou
 * com um diálogo ou menu aberto, o Tab segue o de sempre.
 */
export function startComposeShortcut(): void {
  if (shortcut) return
  shortcut = true
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented) return
    if (useLock.getState().status === 'locked' || document.querySelector(OVERLAYS)) return
    if (e.target instanceof Element && e.target.closest(FIELDS)) return
    const group = document.querySelector('[data-focused]')
    const box = (group && composerIn(group)) || composerIn(document)
    if (!box) return
    e.preventDefault()
    box.focus()
  })
}

/**
 * Os arquivos de uma colagem, sem repetir. `files` e `items` trazem a mesma coisa quase sempre, mas
 * alguns navegadores e programas (capturas, gerenciador de arquivos) põem nos itens o que falta na lista.
 * A chave não usa `lastModified`: imagem copiada não tem data, o navegador cria um `File` novo a cada
 * leitura com a hora de agora, e a mesma imagem vinha duas vezes.
 */
export function pastedFiles(data: DataTransfer): File[] {
  const out: File[] = []
  const seen = new Set<string>()
  const push = (f: File | null) => {
    if (!f) return
    const key = `${f.name}\n${f.size}\n${f.type}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(f)
  }
  for (const f of data.files) push(f)
  for (const item of data.items) if (item.kind === 'file') push(item.getAsFile())
  return out
}
