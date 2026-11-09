import { useEffect } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from './api'
import type { ClaudeSetup, McpScope, McpStatus } from './types'

/**
 * As skills, os agentes e os servidores MCP de uma pasta (ver server/src/claude-config.ts). Sem
 * conversa do painel aberta ali, o servidor sobe uma sonda do Claude Code (alguns segundos) e guarda o
 * resultado por 10 min; "Atualizar" pede de novo.
 */
type Entry = { setup?: ClaudeSetup; error?: string; loading?: boolean }
const useSetupCache = create<Record<string, Entry>>(() => ({}))
const running = new Map<string, Promise<void>>()
// Sem `cwd`: a pasta pessoal, o que vale em todo projeto.
const keyOf = (machine: string, cwd?: string) => `${machine}\n${cwd ?? ''}`

// Só a última consulta de cada pasta vale: duas trocas seguidas de MCP não podem chegar fora de ordem.
const latest = new Map<string, number>()
let asks = 0

export function loadSetup(machine: string, cwd?: string, refresh = false): Promise<void> {
  const key = keyOf(machine, cwd)
  const current = running.get(key)
  if (current && !refresh) return current
  const n = ++asks
  latest.set(key, n)
  useSetupCache.setState((s) => ({ [key]: { ...s[key], loading: true } }))
  const job: Promise<void> = api
    .claudeSetup(machine, cwd, refresh)
    .then(
      (setup) => {
        if (latest.get(key) === n) useSetupCache.setState({ [key]: { setup } })
      },
      (err) => {
        if (latest.get(key) !== n) return
        useSetupCache.setState((s) => ({ [key]: { ...s[key], loading: false, error: isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err) } }))
      },
    )
    .finally(() => running.get(key) === job && running.delete(key))
  running.set(key, job)
  return job
}

export function useClaudeSetup(machine: string, cwd?: string): Entry {
  const key = keyOf(machine, cwd)
  const entry = useSetupCache((s) => s[key])
  useEffect(() => {
    if (!useSetupCache.getState()[key]?.setup) void loadSetup(machine, cwd)
  }, [machine, cwd, key])
  return entry ?? {}
}

/** As consultas já abertas desta máquina: ligar ou desligar algo muda o que vale nas outras pastas também. */
function reloadMachine(machine: string): Promise<unknown> {
  const keys = Object.keys(useSetupCache.getState()).filter((k) => k.startsWith(`${machine}\n`))
  return Promise.all(keys.map((k) => loadSetup(machine, k.slice(machine.length + 1) || undefined, true)))
}

/** Muda o que está na tela na hora (`patch`), chama o servidor e relê do Claude Code; recusado, volta como estava. */
async function act(machine: string, cwd: string | undefined, patch: (s: ClaudeSetup) => ClaudeSetup, call: () => Promise<unknown>): Promise<boolean> {
  const key = keyOf(machine, cwd)
  const before = useSetupCache.getState()[key]?.setup
  if (before) useSetupCache.setState((s) => ({ [key]: { ...s[key], setup: patch(before) } }))
  try {
    await call()
    return true
  } catch (err) {
    toast.error(errorMessage(err))
    if (before) useSetupCache.setState((s) => ({ [key]: { ...s[key], setup: before } }))
    return false
  } finally {
    await reloadMachine(machine)
  }
}

/** Liga ou desliga uma skill: sem `cwd`, em todo projeto; com, só nele. */
export const toggleSkill = (machine: string, cwd: string | undefined, name: string, enabled: boolean) =>
  act(machine, cwd, (s) => ({ ...s, items: s.items.map((i) => (i.name === name && i.kind !== 'agent' ? { ...i, enabled } : i)) }), () =>
    api.toggleSkill(machine, cwd, name, enabled),
  )

/** Liga ou desliga um plugin inteiro: as skills, os agentes e os servidores dele. */
export const togglePlugin = (machine: string, cwd: string | undefined, key: string, enabled: boolean) =>
  act(
    machine,
    cwd,
    (s) => ({
      ...s,
      plugins: s.plugins.map((p) => (p.key === key ? { ...p, enabled } : p)),
      mcp: s.mcp.map((m) => (m.plugin === key ? { ...m, status: enabled ? 'pending' : 'disabled' } : m)),
    }),
    () => api.togglePlugin(machine, key, enabled),
  )

/** Para a lixeira do edit.r; devolve o id lá, para o Desfazer da própria lista. */
export async function trashClaude(machine: string, cwd: string | undefined, what: { path: string } | { mcp: { name: string; scope: McpScope; project?: string } }): Promise<string | null> {
  let id: string | null = null
  await act(
    machine,
    cwd,
    (s) =>
      'path' in what
        ? { ...s, items: s.items.filter((i) => i.path !== what.path) }
        : { ...s, mcp: s.mcp.filter((m) => m.name !== what.mcp.name), elsewhere: s.elsewhere.filter((e) => e.name !== what.mcp.name || e.projects.some((p) => p !== what.mcp.project)) },
    async () => {
      id = ('path' in what ? await api.trashClaudeItem(machine, cwd, what.path) : await api.trashMcp(machine, what.mcp)).id
    },
  )
  return id
}

export const restoreClaude = (machine: string, cwd: string | undefined, ids: string[]) =>
  act(machine, cwd, (s) => ({ ...s, trash: s.trash.filter((t) => !ids.includes(t.id)) }), () => api.restoreClaude(machine, ids))

export const emptyClaudeTrash = (machine: string, cwd: string | undefined, ids?: string[]) =>
  act(machine, cwd, (s) => ({ ...s, trash: ids ? s.trash.filter((t) => !ids.includes(t.id)) : [] }), () => api.emptyClaudeTrash(machine, ids))

/** Liga ou desliga um servidor nesta pasta (sem `cwd`, na pessoal); a lista mostra a mudança na hora e relê do Claude Code. */
export async function toggleMcp(machine: string, cwd: string | undefined, name: string, enabled: boolean): Promise<void> {
  const key = keyOf(machine, cwd)
  const setStatus = (status: (old: McpStatus) => McpStatus) =>
    useSetupCache.setState((s) => {
      const setup = s[key]?.setup
      if (!setup) return s
      return { [key]: { ...s[key], setup: { ...setup, mcp: setup.mcp.map((m) => (m.name === name ? { ...m, status: status(m.status) } : m)) } } }
    })
  const before = useSetupCache.getState()[key]?.setup?.mcp.find((m) => m.name === name)?.status
  setStatus(() => (enabled ? 'pending' : 'disabled'))
  try {
    await api.toggleMcp(machine, cwd, name, enabled)
  } catch (err) {
    toast.error(errorMessage(err))
    // Recusado: volta como estava, sem esperar a releitura (que também pode falhar).
    if (before) setStatus(() => before)
  }
  await loadSetup(machine, cwd, true)
}
