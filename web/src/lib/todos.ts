import { useEffect } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from './api'
import type { Todo } from './types'

/**
 * O TODO de cada projeto, a lista simples do próprio Claude Remote, guardada no PC (ver
 * server/src/todos.ts): a mesma no celular e no PC. Cada mudança aparece na hora e vai inteira para o
 * servidor, em fila, para uma não passar na frente da outra.
 */
const useTodoCache = create<Record<string, Todo[]>>(() => ({}))
/** Por que a lista não carregou (servidor antigo, PC fora do ar); some quando carrega. */
const useTodoErrors = create<Record<string, string | undefined>>(() => ({}))
const loading = new Map<string, Promise<void>>()
const saving = new Map<string, Promise<unknown>>()
const keyOf = (machine: string, cwd: string) => `${machine}\n${cwd}`

export function loadTodos(machine: string, cwd: string): Promise<void> {
  const key = keyOf(machine, cwd)
  let request = loading.get(key)
  if (!request) {
    request = api
      .todos(machine, cwd)
      .then((r) => {
        useTodoCache.setState({ [key]: r.items })
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
  const next = previous.then(() =>
    api.saveTodos(machine, cwd, items).catch((err) => {
      toast.error(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err))
      // O que está no PC volta para a tela: o que não salvou não fica parecendo salvo.
      return loadTodos(machine, cwd)
    }),
  )
  saving.set(key, next)
  void next.finally(() => saving.get(key) === next && saving.delete(key))
}

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
