import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useLocation } from 'wouter'
import { create } from 'zustand'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from './api'
import { onChanged } from './changes'
import { projectName } from './format'
import { useWide } from './hooks'
import { HOME } from './machines'
import type { Workspace } from './types'
import { openWorkspace } from './workbench'

/**
 * Os workspaces de cada máquina, carregados uma vez e atualizados a cada mudança feita pelo app: o
 * cartão no hub do projeto, a página de cada um, a aba no PC e a escolha na conversa leem daqui.
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

// Mudou no PC (o Claude criou um, outro aparelho editou): a máquina que já tem a lista busca de novo.
onChanged((machine, c) => {
  if (c.what === 'workspaces' && useWorkspaces.getState().byMachine[machine]) loadWorkspaces(machine).catch(() => {})
})

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

/** O workspace padrão do projeto (um no máximo), com que a conversa nova dele já vem. */
export const defaultWorkspace = (list: Workspace[] | undefined, project: string): Workspace | undefined =>
  list?.find((w) => w.defaultFor?.includes(project))

/** Os workspaces que têm o projeto, como principal ou não: os que a conversa dele pode usar, o padrão primeiro. */
export function projectWorkspaces(list: Workspace[] | undefined, project: string): Workspace[] {
  const main = defaultWorkspace(list, project)
  const rest = (list ?? []).filter((w) => w !== main && w.projects.includes(project))
  return main ? [main, ...rest] : rest
}

/** Faz do workspace o padrão do projeto (`null`: o projeto fica sem); a lista volta do PC já com a troca. */
export async function setProjectWorkspace(machine: string, project: string, id: string | null): Promise<void> {
  const list = await api.setProjectWorkspace(machine, project, id)
  useWorkspaces.setState((s) => ({ byMachine: { ...s.byMachine, [machine]: list } }))
}

/**
 * Cria um workspace com o projeto, com o nome dele se não vier outro. Projeto ainda sem padrão: o novo
 * vira o padrão (o PC já faz isso ao criar; se não fez, o app pede).
 */
export async function createProjectWorkspace(machine: string, project: string, name = projectName(project)): Promise<Workspace> {
  const list = useWorkspaces.getState().byMachine[machine] ?? []
  const hadDefault = Boolean(defaultWorkspace(list, project))
  const ws = await api.saveWorkspace(machine, { name, color: list.length % WORKSPACE_COLORS.length, projects: [project], instructions: '', rules: [], commands: [] })
  putWorkspace(machine, ws)
  // Servidor antigo, sem padrão por projeto: o workspace foi criado, e é o que importa.
  if (!hadDefault && !ws.defaultFor?.includes(project)) await setProjectWorkspace(machine, project, ws.id).catch(() => {})
  return ws
}

/**
 * O workspace e o time da conversa nova num projeto. O workspace começa no `initial` (vindo da página de
 * um workspace) ou no padrão do projeto; trocando de projeto, o que estava fica se também tiver o novo,
 * senão vale o padrão do novo. Escolher um workspace traz o time padrão dele, até você mexer no time;
 * "Sem workspace" não mexe no time.
 */
export function useNewChatWorkspace(machine: string, project: string | undefined, initial?: string) {
  const list = useWorkspaces((s) => s.byMachine[machine])
  useEffect(() => {
    // Servidor antigo, sem workspaces: a lista fica vazia, e a conversa nova, sem workspace.
    if (!list) loadWorkspaces(machine).catch(() => {})
  }, [list, machine])
  // `id: null` é o "Sem workspace", que vale só no projeto em que foi escolhido.
  const [choice, setChoice] = useState<{ id: string | null; project?: string } | undefined>(() => (initial ? { id: initial, project } : undefined))
  const pick = (p: string | undefined): Workspace | undefined => {
    if (!p) return undefined
    const picked = choice?.id ? projectWorkspaces(list, p).find((w) => w.id === choice.id) : undefined
    const none = choice?.id === null && choice.project === p
    return picked ?? (none ? undefined : defaultWorkspace(list, p))
  }
  // Trocou de projeto: o workspace que estava (escolhido ou o padrão do outro) fica, se também tiver o novo.
  const [at, setAt] = useState(project)
  if (project !== at) {
    setAt(project)
    const before = pick(at)
    if (before) setChoice({ id: before.id, project: at })
  }
  const workspace = pick(project)

  const [team, setTeam] = useState<{ id?: string; manual: boolean }>({ manual: false })
  // Ajustado no render (o jeito do React de seguir o que mudou): cada workspace novo traz o time dele uma vez.
  const [seen, setSeen] = useState<string>()
  if (workspace && workspace.id !== seen) {
    setSeen(workspace.id)
    if (!team.manual) setTeam({ id: workspace.teamId, manual: false })
  }

  const choose = useCallback((id: string | undefined) => setChoice({ id: id ?? null, project }), [project])
  const setTeamId = useCallback((id: string | undefined) => setTeam({ id, manual: true }), [])
  return { workspace, choose, teamId: team.id, setTeamId }
}

export const workspaceFailed = (err: unknown) => toast.error(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err))

/** Abre a página do workspace: no PC, numa aba; no celular, na tela dele. */
export function useOpenWorkspace(machine: string) {
  const wide = useWide()
  const [, navigate] = useLocation()
  return (id: string) => (wide ? openWorkspace(machine, id) : navigate(`/w/${id}${machine === HOME ? '' : `?maquina=${encodeURIComponent(machine)}`}`))
}
