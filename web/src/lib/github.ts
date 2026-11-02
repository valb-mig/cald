import { useEffect } from 'react'
import { create } from 'zustand'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from './api'
import type { GithubInfo, GithubItem } from './types'

/**
 * PRs e issues do GitHub por projeto: uma busca só para as duas abas da barra do projeto e para os
 * contadores da alça dela. Busca apenas com uma das abas aberta — nada fica consultando em segundo
 * plano —, e o servidor ainda guarda a resposta por 2 minutos (ver server/src/github.ts).
 */
/** Por que não deu para buscar, com o que fazer (ver server/src/github.ts). */
export const GITHUB_REASON: Record<Extract<GithubInfo, { ok: false }>['reason'], string> = {
  no_remote: 'Este projeto não tem um remoto no git.',
  not_github: 'O remoto deste projeto não é do GitHub.',
  no_gh: 'Instale o GitHub CLI (gh) no PC para ver os PRs e as issues aqui.',
  gh_auth: 'Entre no GitHub pelo terminal do PC com gh auth login.',
  error: 'Não deu para falar com o GitHub agora.',
}

type Entry = { info: GithubInfo | null; loading: boolean; error: string | null }

const useGithubCache = create<Record<string, Entry>>(() => ({}))
const requests = new Map<string, Promise<void>>()
const keyOf = (machine: string, cwd: string) => `${machine}\n${cwd}`

/** Uma resposta vale aqui o mesmo que no servidor: reabrir a aba antes disso não pede outra. */
const FRESH_MS = 2 * 60_000

/** Busca (pedidos ao mesmo tempo viram um só); `refresh` pede ao servidor uma resposta nova. */
export function loadGithub(machine: string, cwd: string, refresh = false): Promise<void> {
  const key = keyOf(machine, cwd)
  const current = useGithubCache.getState()[key]
  if (!refresh && current?.info && Date.now() - current.info.fetchedAt < FRESH_MS) return Promise.resolve()
  let request = requests.get(key)
  if (request) return request
  useGithubCache.setState({ [key]: { info: current?.info ?? null, loading: true, error: null } })
  request = api
    .github(machine, cwd, refresh)
    .then(
      (info) => useGithubCache.setState({ [key]: { info, loading: false, error: null } }),
      (err) =>
        useGithubCache.setState({
          [key]: { info: current?.info ?? null, loading: false, error: isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err) },
        }),
    )
    .finally(() => requests.delete(key))
  requests.set(key, request)
  return request
}

/** PRs e issues do projeto para quem não é tela (as sugestões de `#` no campo de mensagem); mesmo cache. */
export async function getGithub(machine: string, cwd: string): Promise<GithubInfo | null> {
  await loadGithub(machine, cwd)
  return useGithubCache.getState()[keyOf(machine, cwd)]?.info ?? null
}

/** PRs e issues do projeto; `active`: a aba está à vista, e só então busca. */
export function useGithub(machine: string, cwd: string, active: boolean) {
  const entry = useGithubCache((s) => s[keyOf(machine, cwd)])
  useEffect(() => {
    if (active) void loadGithub(machine, cwd)
  }, [machine, cwd, active])
  return {
    info: entry?.info ?? null,
    loading: entry?.loading ?? active,
    error: entry?.error ?? null,
    refresh: () => void loadGithub(machine, cwd, true),
  }
}

/** Os totais do que já foi buscado: os contadores da alça não fazem busca nenhuma por conta própria. */
export function useGithubCounts(machine: string, cwd: string): { pulls: number; issues: number } | null {
  const info = useGithubCache((s) => s[keyOf(machine, cwd)]?.info)
  return info?.ok ? { pulls: info.pullCount, issues: info.issueCount } : null
}

// ---- uma issue ou um PR, para a aba de análise ----

type ItemEntry = { item: GithubItem | null; loading: boolean; error: string | null }

const useItemCache = create<Record<string, ItemEntry>>(() => ({}))
const itemRequests = new Map<string, Promise<void>>()

function loadItem(machine: string, cwd: string, kind: 'issue' | 'pr', number: number, refresh = false): Promise<void> {
  const key = `${keyOf(machine, cwd)}\n${kind}\n${number}`
  const current = useItemCache.getState()[key]
  if (!refresh && current?.item && Date.now() - current.item.fetchedAt < FRESH_MS) return Promise.resolve()
  let request = itemRequests.get(key)
  if (request) return request
  useItemCache.setState({ [key]: { item: current?.item ?? null, loading: true, error: null } })
  request = api
    .githubItem(machine, cwd, kind, number, refresh)
    .then(
      (item) => useItemCache.setState({ [key]: { item, loading: false, error: null } }),
      (err) =>
        useItemCache.setState({
          [key]: { item: current?.item ?? null, loading: false, error: isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err) },
        }),
    )
    .finally(() => itemRequests.delete(key))
  itemRequests.set(key, request)
  return request
}

/** Uma issue ou um PR inteiro; busca ao abrir a aba dele (e de novo só depois dos 2 min, ou pelo atualizar). */
export function useGithubItem(machine: string, cwd: string, kind: 'issue' | 'pr', number: number, active: boolean) {
  const entry = useItemCache((s) => s[`${keyOf(machine, cwd)}\n${kind}\n${number}`])
  useEffect(() => {
    if (active) void loadItem(machine, cwd, kind, number)
  }, [machine, cwd, kind, number, active])
  return {
    item: entry?.item ?? null,
    loading: entry?.loading ?? active,
    error: entry?.error ?? null,
    refresh: () => void loadItem(machine, cwd, kind, number, true),
  }
}
