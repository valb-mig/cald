import { createContext, useContext } from 'react'
import { create } from 'zustand'

/**
 * Várias máquinas suas com o Claude Remote no mesmo app (ver server/src/machines.ts). A desta
 * página (de onde o app foi aberto) tem id `''` e fala pela mesma origem; as outras, pelo endereço
 * delas no Tailscale. Cada conversa pertence a uma máquina, e as chamadas dela vão para lá.
 */
export type Machine = { id: string; name: string; base: string }

export const HOME = ''

const CACHE_KEY = 'cr:machines'

// A lista fica guardada: com a máquina desta página fora do ar, o app (em cache) segue falando com as outras.
function cached(): Machine[] {
  try {
    const list = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '[]') as unknown
    return Array.isArray(list) ? (list as Machine[]) : []
  } catch {
    return []
  }
}

export const useMachines = create<{ machines: Machine[] }>(() => {
  const list = cached()
  return { machines: list.length ? list : [{ id: HOME, name: 'Este PC', base: '' }] }
})

/** Pergunta à máquina desta página o nome dela e quais outras existem; sem resposta, fica a lista guardada. */
export async function loadMachines(): Promise<void> {
  const res = await fetch('/api/machines')
  // Servidor sem a rota (versão antiga): só esta máquina.
  if (res.status === 404) return
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { name: string; machines: Machine[] }
  const machines = [{ id: HOME, name: body.name, base: '' }, ...body.machines.filter((m) => m.base !== location.origin)]
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(machines))
  } catch {
    // localStorage indisponível (modo privado): segue só em memória.
  }
  useMachines.setState({ machines })
}

// ---- filtro do topo (lista de sessões, projetos, computador) ----

const FILTER_KEY = 'cr:machine-filter'

/** Máquina escolhida no filtro do topo; `null` = todas. Fica salva no aparelho. */
const useFilter = create<{ machine: string | null }>(() => {
  try {
    const saved = localStorage.getItem(FILTER_KEY)
    return { machine: saved === null ? null : saved }
  } catch {
    return { machine: null }
  }
})

export function setMachineFilter(machine: string | null): void {
  try {
    if (machine === null) localStorage.removeItem(FILTER_KEY)
    else localStorage.setItem(FILTER_KEY, machine)
  } catch {
    // localStorage indisponível (modo privado): segue só em memória.
  }
  useFilter.setState({ machine })
}

/** O filtro do topo, se a máquina dele ainda estiver na lista; senão, todas. */
export function useMachineFilter(): string | null {
  const machine = useFilter((s) => s.machine)
  const exists = useMachines((s) => machine === null || s.machines.some((m) => m.id === machine))
  return exists ? machine : null
}

/** Endereço da nova conversa num projeto (`undefined` = pasta pessoal) de uma máquina. */
export function newChatUrl(cwd?: string, machine: string = HOME, workspace?: string): string {
  const params = new URLSearchParams()
  if (cwd) params.set('cwd', cwd)
  if (workspace) params.set('workspace', workspace)
  if (machine !== HOME) params.set('maquina', machine)
  const query = params.toString()
  return query ? `/nova?${query}` : '/nova'
}

export const baseOf = (machine: string) => useMachines.getState().machines.find((m) => m.id === machine)?.base ?? ''

export const machineName = (machine: string) => useMachines.getState().machines.find((m) => m.id === machine)?.name ?? machine

// ---- de qual máquina é cada conversa ----

// Pelo catálogo de cada máquina (ver store.ts) e, antes dele chegar, pelo que o app acabou de criar lá.
const owners = new Map<string, string>()

/** Conversas que uma máquina listou no catálogo dela. */
export function noteSessions(machine: string, sessionIds: string[]): void {
  for (const id of sessionIds) owners.set(id, machine)
}

/** Conversa criada (ou copiada) agora numa máquina, antes de aparecer no catálogo. */
export const noteSession = (sessionId: string, machine: string) => owners.set(sessionId, machine)

export const machineOf = (sessionId: string) => owners.get(sessionId) ?? HOME

/** Máquina da tela atual (a da conversa aberta, a escolhida na nova conversa), para quem está dentro dela. */
export const MachineContext = createContext<string>(HOME)

export const useMachine = () => useContext(MachineContext)
