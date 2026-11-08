import { useEffect } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { ApiError, api, errorMessage } from './api'
import { onChanged } from './changes'
import { useStore } from './store'
import type { AgentProviderInfo, SessionSettings } from './types'

/**
 * Os agentes de cada máquina (ver server/src/providers): quem conduz as conversas, o Claude Code hoje e
 * outros depois. Cada um diz se está ligado, se é o padrão das conversas novas, se está pronto no PC e
 * o que oferece (as abas da página dele no Computador, o esforço e os modos da caixa de mensagem).
 * Não confundir com os subagentes de uma conversa (components/agents/). Uma cópia por máquina, que o
 * painel, a conversa nova e a caixa de mensagem dividem; o PC avisa cada mudança pelo WebSocket.
 */
type Entry = { list?: AgentProviderInfo[]; error?: string }
const useProvidersCache = create<Record<string, Entry>>(() => ({}))
const loading = new Map<string, Promise<void>>()
const EMPTY: Entry = {}

/** O id do Claude Code, que vale também para as conversas sem `provider` (de servidor antigo). */
export const CLAUDE = 'claude'

/** Os modos de permissão que o app oferecia antes dos agentes, na ordem do seletor. */
export const CLAUDE_MODES = ['default', 'acceptEdits', 'plan', 'auto']

/**
 * Servidor de antes dos agentes (sem `/api/agents`): a máquina só sabe conduzir o Claude Code, que é
 * então o único ligado, o padrão, pronto e com tudo o que o app já mostrava.
 */
const LEGACY: AgentProviderInfo[] = [
  {
    id: CLAUDE,
    name: 'Claude Code',
    description: 'O agente da Anthropic, no terminal do PC.',
    enabled: true,
    default: true,
    available: true,
    features: { usage: true, memory: true, skills: true, mcp: true, effort: true, permissionModes: CLAUDE_MODES, fork: true, pcSessions: true },
  },
]

// Só a última leitura vale: uma que saiu antes de uma mudança e chega depois traria o de antes.
const latest = new Map<string, number>()
let reads = 0

/** `fresh`: depois de uma mudança, lê de novo mesmo com uma leitura em andamento (ela já é velha). */
export function loadProviders(machine: string, fresh = false): Promise<void> {
  const running = loading.get(machine)
  if (running && !fresh) return running
  const n = ++reads
  latest.set(machine, n)
  const job: Promise<void> = api
    .agents(machine)
    .then(
      (list) => {
        if (latest.get(machine) === n) useProvidersCache.setState({ [machine]: { list } })
      },
      (err) => {
        if (latest.get(machine) !== n) return
        // Rota que o servidor não tem: ele é de antes dos agentes, e só conduz o Claude.
        if (err instanceof ApiError && err.status === 404) return useProvidersCache.setState({ [machine]: { list: LEGACY } })
        useProvidersCache.setState((s) => ({ [machine]: { ...s[machine], error: errorMessage(err) } }))
      },
    )
    .finally(() => loading.get(machine) === job && loading.delete(machine))
  loading.set(machine, job)
  return job
}

// Ligou ou desligou um agente (outro aparelho, a instalação de um no PC): a máquina que já tem a lista lê de novo.
onChanged((machine, c) => {
  if (c.what === 'agents' && useProvidersCache.getState()[machine]) void loadProviders(machine, true)
})

// De volta à conexão (o PC reiniciou, talvez numa versão nova): o que mudou no meio não chegou.
useStore.subscribe((s, prev) => {
  for (const machine of Object.keys(useProvidersCache.getState())) {
    if (s.connections[machine] === 'open' && prev.connections[machine] !== 'open') void loadProviders(machine, true)
  }
})

/** Os agentes da máquina, na ordem do servidor; `list` falta até a primeira leitura chegar. */
export function useProviders(machine: string): Entry {
  const entry = useProvidersCache((s) => s[machine])
  useEffect(() => {
    if (!useProvidersCache.getState()[machine]?.list) void loadProviders(machine)
  }, [machine])
  return entry ?? EMPTY
}

/** Os ligados e prontos: os que a conversa nova oferece. */
export const enabledProviders = (list: AgentProviderInfo[] | undefined): AgentProviderInfo[] =>
  (list ?? []).filter((p) => p.enabled && p.available)

/**
 * Um agente da máquina; sem `id`, o padrão. Até a lista chegar, o Claude é presumido pelo mesmo jeito
 * de servidor antigo (as conversas de hoje são todas dele), para a caixa de mensagem não piscar.
 */
export function useProvider(machine: string, id?: string): AgentProviderInfo | undefined {
  const { list } = useProviders(machine)
  if (!list) return !id || id === CLAUDE ? LEGACY[0] : undefined
  return id ? list.find((p) => p.id === id) : (list.find((p) => p.default) ?? list[0])
}

/** O que falta para um agente sem informação (de outra máquina, ou que saiu da lista): nada além de modelo. */
const BARE: AgentProviderInfo['features'] = {
  usage: false,
  memory: false,
  skills: false,
  mcp: false,
  effort: false,
  permissionModes: [],
  fork: false,
  pcSessions: false,
}

export const featuresOf = (info: AgentProviderInfo | undefined): AgentProviderInfo['features'] => info?.features ?? BARE

/** O que um agente da máquina oferece (sem `id`, o padrão); até a lista chegar, o do Claude. */
export function useFeatures(machine: string, id?: string): AgentProviderInfo['features'] {
  return featuresOf(useProvider(machine, id))
}

/** O modo de permissão vigente, ou o que o agente usa quando nenhum foi escolhido: o Manual, se ele tiver. */
export const currentMode = (settings: SessionSettings, modes: string[]): string =>
  settings.permissionMode ?? (modes.includes('default') || !modes.length ? 'default' : modes[0]!)

/**
 * Liga, desliga ou faz padrão um agente. Muda na tela na hora e fica com a lista que o PC devolve;
 * recusado (o último ligado, um que não está pronto), volta como estava e avisa.
 */
export async function setProvider(machine: string, id: string, patch: { enabled?: boolean; default?: boolean }): Promise<void> {
  const before = useProvidersCache.getState()[machine]?.list
  if (before) {
    const next = before.map((p) => {
      if (p.id === id) return { ...p, ...patch }
      // Só um é o padrão: fazer este o padrão tira o de outro.
      return patch.default ? { ...p, default: false } : p
    })
    useProvidersCache.setState((s) => ({ [machine]: { ...s[machine], list: next } }))
  }
  latest.set(machine, ++reads)
  try {
    const list = await api.setAgent(machine, id, patch)
    useProvidersCache.setState({ [machine]: { list } })
  } catch (err) {
    toast.error(errorMessage(err))
    if (before) useProvidersCache.setState((s) => ({ [machine]: { ...s[machine], list: before } }))
    void loadProviders(machine, true)
  }
}
