import { create } from 'zustand'
import { api } from './api'
import type { Workspace } from './types'

/**
 * Os workspaces de cada máquina, carregados uma vez e atualizados a cada mudança feita pelo app: a
 * lista em Projetos, a página de cada um, a aba no PC e a conversa nova leem daqui.
 */
type State = { byMachine: Record<string, Workspace[] | undefined> }

export const useWorkspaces = create<State>(() => ({ byMachine: {} }))

const loading = new Map<string, Promise<Workspace[]>>()

/** Busca de novo (ou pela primeira vez) os workspaces da máquina. */
export function loadWorkspaces(machine: string): Promise<Workspace[]> {
  let request = loading.get(machine)
  if (!request) {
    request = api.workspaces(machine).then(
      (list) => {
        loading.delete(machine)
        useWorkspaces.setState((s) => ({ byMachine: { ...s.byMachine, [machine]: list } }))
        return list
      },
      (err: unknown) => {
        loading.delete(machine)
        // Servidor antigo, sem workspaces: a lista fica vazia.
        useWorkspaces.setState((s) => ({ byMachine: { ...s.byMachine, [machine]: s.byMachine[machine] ?? [] } }))
        throw err
      },
    )
    loading.set(machine, request)
  }
  return request
}

/** Põe na lista o workspace que acabou de ser salvo (ou tira, com `null` e o id). */
export function putWorkspace(machine: string, ws: Workspace | null, id?: string): void {
  useWorkspaces.setState((s) => {
    const list = (s.byMachine[machine] ?? []).filter((w) => w.id !== (ws?.id ?? id))
    const next = ws ? [...list, ws].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')) : list
    return { byMachine: { ...s.byMachine, [machine]: next } }
  })
}

/** Cores dos workspaces: as dos claudinhos, que aparecem bem no claro e no escuro. */
export const WORKSPACE_COLORS = ['#3aa8ff', '#2fc677', '#8b5cf6', '#ff7a3d', '#ff4fa3', '#14b8a6', '#f5a524', '#6366f1', '#ff5a5a', '#d946ef']
export const workspaceColor = (i: number) => WORKSPACE_COLORS[i % WORKSPACE_COLORS.length]!
