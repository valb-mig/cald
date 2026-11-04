import { useEffect } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { ApiError, api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from './api'
import { onChanged } from './changes'
import type { Todo } from './types'
import { projectOf } from './worktree'

/**
 * O TODO de cada projeto, a lista simples do próprio cald, guardada no PC (ver
 * server/src/todos.ts): a mesma no celular e no PC. Cada mudança aparece na hora e vai inteira para o
 * servidor, em fila, para uma não passar na frente da outra.
 */
const useTodoCache = create<Record<string, Todo[]>>(() => ({}))
/** Por que a lista não carregou (servidor antigo, PC fora do ar); some quando carrega. */
const useTodoErrors = create<Record<string, string | undefined>>(() => ({}))
const loading = new Map<string, Promise<void>>()
const saving = new Map<string, Promise<unknown>>()
/** O `rev` da lista no PC que a tela tem: vai junto ao salvar (ver server/src/todos.ts). */
const revs = new Map<string, number>()
/** Sobe quando o PC recusa uma lista velha: as gravações que estavam na fila saem sem ir (eram da lista velha). */
const epochs = new Map<string, number>()
// Um worktree tem a lista do projeto (ver server/src/todos.ts): a mesma chave, para a mudança avisada com
// a pasta do projeto chegar também à barra da conversa que roda no worktree.
const keyOf = (machine: string, cwd: string) => `${machine}\n${projectOf(cwd)}`

/**
 * O servidor de antes de reiniciar manda o item só com `text`, sem título, descrição nem anexos: o
 * texto vira o título, e o resto fica vazio, para a tela não quebrar até o PC rodar a versão nova.
 */
type OldTodo = { id: string; text: string; done: boolean; createdAt: number }
const normalize = (items: (Todo | OldTodo)[]): Todo[] =>
  items.map((t) => {
    const { text, ...item } = t as Partial<Todo> & Partial<OldTodo> & { id: string }
    return { ...item, title: item.title ?? text ?? '', body: item.body ?? '', files: item.files ?? [], done: !!item.done, createdAt: item.createdAt ?? 0 }
  })

export function loadTodos(machine: string, cwd: string): Promise<void> {
  const key = keyOf(machine, cwd)
  let request = loading.get(key)
  if (!request) {
    request = api
      .todos(machine, cwd)
      .then((r) => {
        if (r.rev !== undefined) revs.set(key, r.rev)
        useTodoCache.setState({ [key]: normalize(r.items) })
        useTodoErrors.setState({ [key]: undefined })
      })
      .catch((err) => useTodoErrors.setState({ [key]: isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err) }))
      .finally(() => loading.delete(key))
    loading.set(key, request)
  }
  return request
}

export function saveTodos(machine: string, cwd: string, items: Todo[]): void {
  const key = keyOf(machine, cwd)
  useTodoCache.setState({ [key]: items })
  const previous = saving.get(key) ?? Promise.resolve()
  const epoch = epochs.get(key) ?? 0
  const next: Promise<unknown> = previous.then(() => {
    if ((epochs.get(key) ?? 0) !== epoch) return
    return api.saveTodos(machine, cwd, items, revs.get(key)).then(
      // O PC devolve a lista com o número dos itens novos; vale se nenhuma mudança veio depois desta.
      (r): void => {
        if (r.rev !== undefined) revs.set(key, r.rev)
        if (saving.get(key) === next) useTodoCache.setState({ [key]: normalize(r.items) })
      },
      (err) => {
        if (err instanceof ApiError && err.code === 'todos_changed') epochs.set(key, epoch + 1)
        toast.error(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err))
        // O que está no PC volta para a tela: o que não salvou não fica parecendo salvo.
        return loadTodos(machine, cwd)
      },
    )
  })
  saving.set(key, next)
  void next.finally(() => saving.get(key) === next && saving.delete(key))
}

// Mudou no PC (o Claude criou ou marcou um item, outro aparelho mexeu): a lista que está na tela vem de
// novo. A que tem gravação na fila espera a resposta dela, e a que já está no mesmo `rev` não precisa.
onChanged((machine, c) => {
  if (c.what !== 'todos' || !c.cwd) return
  const key = keyOf(machine, c.cwd)
  if (!useTodoCache.getState()[key] || saving.has(key)) return
  const reload = () => (c.rev === undefined || c.rev !== revs.get(key)) && void loadTodos(machine, c.cwd!)
  // Uma leitura já em andamento pode ter saído antes da mudança: confere de novo quando ela voltar.
  const pending = loading.get(key)
  if (pending) void pending.then(reload)
  else reload()
})

/** O TODO do projeto (`null` enquanto carrega), lido de novo a cada vez que o projeto aparece. */
export function useTodos(machine: string, cwd: string): Todo[] | null {
  const items = useTodoCache((s) => s[keyOf(machine, cwd)])
  useEffect(() => {
    void loadTodos(machine, cwd)
  }, [machine, cwd])
  return items ?? null
}

/** Por que o TODO do projeto não carregou, se não carregou. */
export const useTodoError = (machine: string, cwd: string) => useTodoErrors((s) => s[keyOf(machine, cwd)])

/** Um id novo para um item; `randomUUID` só existe em página segura (https ou localhost). */
export const newTodoId = () =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/** Os itens que já estão na tela, sem buscar: as sugestões de `TODO:` no campo de mensagem. */
export async function getTodos(machine: string, cwd: string): Promise<Todo[]> {
  const key = keyOf(machine, cwd)
  if (!useTodoCache.getState()[key]) await loadTodos(machine, cwd)
  return useTodoCache.getState()[key] ?? []
}

/** Os arquivos mencionados com `@caminho` numa descrição, na ordem e sem repetir. */
export function mentionsOf(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(/(?:^|\s)@([^\s]+)/g)) {
    const path = m[1]!.replace(/[.,;:!?)]+$/, '')
    if (path && !out.includes(path)) out.push(path)
  }
  return out
}
