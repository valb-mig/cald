import { useEffect } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { ApiError, api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from './api'
import { onChanged } from './changes'
import type { Detalhe } from './types'
import { projectOf } from './worktree'

/**
 * Os detalhes de cada projeto (como cada parte dele funciona), guardados no PC (ver
 * server/src/detalhes.ts). O mesmo esquema do TODO (ver lib/todos.ts): cada mudança aparece na hora e
 * vai inteira para o servidor, em fila, com o `rev` que a tela leu.
 */
const useCache = create<Record<string, Detalhe[]>>(() => ({}))
const useErrors = create<Record<string, string | undefined>>(() => ({}))
const loading = new Map<string, Promise<void>>()
const saving = new Map<string, Promise<unknown>>()
const revs = new Map<string, number>()
/** Sobe quando o PC recusa uma lista velha: as gravações que estavam na fila saem sem ir. */
const epochs = new Map<string, number>()
// Um worktree tem os detalhes do projeto de que é cópia: a mesma chave.
const keyOf = (machine: string, cwd: string) => `${machine}\n${projectOf(cwd)}`

export function loadDetalhes(machine: string, cwd: string): Promise<void> {
  const key = keyOf(machine, cwd)
  let request = loading.get(key)
  if (!request) {
    request = api
      .detalhes(machine, cwd)
      .then((r) => {
        revs.set(key, r.rev)
        useCache.setState({ [key]: r.items })
        useErrors.setState({ [key]: undefined })
      })
      .catch((err) => useErrors.setState({ [key]: isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err) }))
      .finally(() => loading.delete(key))
    loading.set(key, request)
  }
  return request
}

export function saveDetalhes(machine: string, cwd: string, items: Detalhe[]): void {
  const key = keyOf(machine, cwd)
  useCache.setState({ [key]: items })
  const previous = saving.get(key) ?? Promise.resolve()
  const epoch = epochs.get(key) ?? 0
  const next: Promise<unknown> = previous.then(() => {
    if ((epochs.get(key) ?? 0) !== epoch) return
    return api.saveDetalhes(machine, cwd, items, revs.get(key)).then(
      // O PC devolve a lista com as chaves; vale se nenhuma mudança veio depois desta.
      (r): void => {
        revs.set(key, r.rev)
        if (saving.get(key) === next) useCache.setState({ [key]: r.items })
      },
      (err) => {
        if (err instanceof ApiError && err.code === 'detalhes_changed') epochs.set(key, epoch + 1)
        toast.error(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err))
        return loadDetalhes(machine, cwd)
      },
    )
  })
  saving.set(key, next)
  void next.finally(() => saving.get(key) === next && saving.delete(key))
}

// Mudou no PC (outro aparelho mexeu): a lista que está na tela vem de novo, como no TODO.
onChanged((machine, c) => {
  if (c.what !== 'detalhes' || !c.cwd) return
  const key = keyOf(machine, c.cwd)
  if (!useCache.getState()[key] || saving.has(key)) return
  const reload = () => (c.rev === undefined || c.rev !== revs.get(key)) && void loadDetalhes(machine, c.cwd!)
  const pending = loading.get(key)
  if (pending) void pending.then(reload)
  else reload()
})

/** Os detalhes do projeto (`null` enquanto carrega). */
export function useDetalhes(machine: string, cwd: string): Detalhe[] | null {
  const items = useCache((s) => s[keyOf(machine, cwd)])
  useEffect(() => {
    void loadDetalhes(machine, cwd)
  }, [machine, cwd])
  return items ?? null
}

/** Por que os detalhes do projeto não carregaram, se não carregaram. */
export const useDetalhesError = (machine: string, cwd: string) => useErrors((s) => s[keyOf(machine, cwd)])
