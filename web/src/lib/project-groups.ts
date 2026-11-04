import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { api } from './api'
import { projectName } from './format'
import { HOME } from './machines'
import { isWorking } from './peers'
import type { CatalogEntry, GitSummary } from './types'

/**
 * As conversas agrupadas por projeto: a pasta onde o Claude roda, em cada máquina (a mesma pasta em
 * outra máquina é outro projeto). A lista de conversas mostra os projetos e, dentro de cada um, as
 * conversas dele.
 */
export type ProjectGroup = {
  key: string
  machine: string
  cwd?: string
  name: string
  /** Fixadas primeiro, depois da mais recente para a mais antiga. */
  sessions: CatalogEntry[]
  /** A conversa mais recente: os projetos vêm nesta ordem. */
  last: number
  /** Quantas esperam você. */
  waiting: number
}

export const projectKey = (machine: string, cwd?: string) => `${machine}\n${cwd ?? ''}`

/** Fixadas primeiro, depois da mais recente para a mais antiga. */
export const bySession = (a: CatalogEntry, b: CatalogEntry) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.lastModified - a.lastModified

export function groupByProject(list: CatalogEntry[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const s of list) {
    const machine = s.machine ?? HOME
    // A conversa num worktree fica no projeto de que ele é cópia, com o nome do worktree na linha dela.
    const cwd = s.worktree?.project ?? s.cwd
    const key = projectKey(machine, cwd)
    let group = groups.get(key)
    if (!group) {
      group = { key, machine, cwd, name: cwd ? projectName(cwd) : 'Sem projeto', sessions: [], last: 0, waiting: 0 }
      groups.set(key, group)
    }
    group.sessions.push(s)
    group.last = Math.max(group.last, s.lastModified)
    if (s.state === 'waiting') group.waiting++
  }
  const result = [...groups.values()]
  for (const g of result) g.sessions.sort(bySession)
  return result.sort((a, b) => b.last - a.last)
}

/** Quantas conversas um projeto aberto mostra antes do "mostrar mais". */
const SHOWN = 4

/** Fixada, esperando você, trabalhando ou aberta no painel ou no PC: aparece sempre, mesmo além das primeiras. */
const live = (s: CatalogEntry) => Boolean(s.pinned || s.owner) || s.state === 'waiting' || s.state === 'running'

/**
 * O que um projeto mostra: as mais recentes e as vivas; com `all`, todas. Recolhido, só as que esperam
 * você — essas não podem ficar escondidas.
 */
export function shownSessions(group: ProjectGroup, closed: boolean, all: boolean): CatalogEntry[] {
  if (closed) return group.sessions.filter((s) => s.state === 'waiting')
  if (all) return group.sessions
  return group.sessions.filter((s, i) => i < SHOWN || live(s))
}

/**
 * Onde uma conversa fica no trilho do projeto (ver RailMark em pages/sessions.tsx). `above`/`below`: o
 * trilho chega de cima e segue para baixo. `node`: aberta no checkout do projeto, um nó na linha (pelo
 * estado); aberta num worktree, um desvio da linha (`branch`); sem nó, fechada, o trilho só passa por
 * ela. `liveAbove`/`liveBelow`: o trecho entre duas ou mais trabalhando agora no checkout, os mesmos
 * arquivos mudando por mais de uma.
 */
export type RailSpot = {
  above: boolean
  below: boolean
  node?: 'working' | 'waiting' | 'open' | 'branch'
  liveAbove: boolean
  liveBelow: boolean
}

/**
 * O trilho que liga as conversas abertas (no painel ou no PC) de um projeto, como um grafo do git: as
 * do checkout ficam na linha, as de worktree saem num desvio, cada uma na sua cópia. Só existe com
 * duas ou mais abertas entre as mostradas; um item por conversa de `shown`.
 */
export function railOf(group: ProjectGroup, shown: CatalogEntry[]): (RailSpot | undefined)[] {
  const first = shown.findIndex((s) => s.owner)
  const last = shown.findLastIndex((s) => s.owner)
  if (first === last) return shown.map(() => undefined)
  const inCheckout = (s: CatalogEntry) => s.cwd === group.cwd
  const working = shown.flatMap((s, i) => (s.owner && inCheckout(s) && isWorking(s) ? [i] : []))
  // Da primeira à última trabalhando no checkout; com uma só, nenhum trecho vivo.
  const [from, to] = working.length > 1 ? [working[0]!, working.at(-1)!] : [-1, -1]
  return shown.map((s, i) =>
    i < first || i > last
      ? undefined
      : {
          above: i > first,
          below: i < last,
          node: !s.owner ? undefined : !inCheckout(s) ? 'branch' : s.state === 'waiting' ? 'waiting' : isWorking(s) ? 'working' : 'open',
          liveAbove: i > from && i <= to,
          liveBelow: i >= from && i < to,
        },
  )
}

// ---- projetos recolhidos ----

const CLOSED_KEY = 'cr:closed-projects'

function loadClosed(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]')
    return Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

/** Os projetos recolhidos na lista; escolha deste aparelho, como a lista recolhida (ver lib/sidebar.ts). */
export const useClosedProjects = create<{ keys: string[] }>(() => ({ keys: loadClosed() }))

export function toggleProject(key: string): void {
  const keys = useClosedProjects.getState().keys
  const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]
  useClosedProjects.setState({ keys: next })
  try {
    localStorage.setItem(CLOSED_KEY, JSON.stringify(next))
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}

// ---- abas de projeto do celular ----

/** A aba de todas as conversas, antes das dos projetos. */
export const ALL_TAB = 'all'

/**
 * A aba aberta na lista do celular (ver pages/sessions.tsx): a de todas ou a `projectKey` de um projeto.
 * Fica na memória, para voltar de uma conversa na mesma aba; ao reabrir o app, começa em todas.
 */
export const useProjectTab = create<{ key: string }>(() => ({ key: ALL_TAB }))

export const setProjectTab = (key: string) => useProjectTab.setState({ key })

// ---- git dos projetos ----

/** De quanto em quanto tempo a lista relê o git: as conversas mexem nos arquivos enquanto ela está aberta. */
const GIT_EVERY_MS = 60_000

/**
 * O git dos projetos das máquinas da lista, por `projectKey`, para as etiquetas dos grupos. Só o git
 * local: consultar o remoto (git fetch) fica com a página de Projetos.
 */
export function useProjectsGit(machines: string[]): Record<string, GitSummary> {
  const [git, setGit] = useState<Record<string, GitSummary>>({})
  const list = [...new Set(machines)].sort().join(',')

  useEffect(() => {
    let alive = true
    const load = () => {
      for (const machine of list.split(',')) {
        api
          .projectsGit(machine)
          .then((byCwd) => {
            if (!alive) return
            setGit((old) => {
              const next = { ...old }
              for (const [cwd, summary] of Object.entries(byCwd)) next[projectKey(machine, cwd)] = summary
              return next
            })
          })
          // Máquina com servidor antigo, sem a rota: os grupos dela seguem sem as etiquetas.
          .catch(() => {})
      }
    }
    load()
    const timer = setInterval(load, GIT_EVERY_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [list])

  return git
}
