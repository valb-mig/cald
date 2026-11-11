import { toast } from 'sonner'
import { navigate } from 'wouter/use-browser-location'
import { api, ApiError, errorMessage } from './api'
import { HOME, noteSession } from './machines'
import { useStore } from './store'
import type { RunOptions } from './types'
import { projectOf } from './worktree'

/** Sem como abrir um worktree ali: a conversa roda no checkout, como faria a conversa nova. */
const NO_WORKTREE = new Set(['not_a_repository', 'detached_head', 'no_commits', 'already_in_worktree'])

/**
 * Cria a conversa já com `prompt` como primeira mensagem e vai para ela: a paleta de comandos e os
 * "Pedir a um agente" das telas. `options`: o agente que conduz (`provider`, ver lib/providers.ts), o
 * modelo e o esforço; sem eles, os padrões da máquina. Com outra conversa aberta no mesmo checkout, ela
 * abre num worktree à parte, o mesmo padrão da tela de conversa nova (ver lib/worktree.ts).
 */
export async function askAgent(
  { machine, cwd }: { machine: string; cwd: string | undefined },
  prompt: string,
  options: RunOptions & { provider?: string } = {},
): Promise<void> {
  const shared = Boolean(
    cwd && projectOf(cwd) === cwd && useStore.getState().catalog.some((c) => c.owner && c.cwd === cwd && (c.machine ?? HOME) === machine),
  )
  const create = (worktree: boolean) => api.create(machine, { cwd, prompt, ...options, worktree: worktree || undefined })
  const id = toast.loading('Criando a conversa…')
  try {
    const { sessionId } = await create(shared).catch((err: unknown) => {
      if (shared && err instanceof ApiError && NO_WORKTREE.has(err.code)) return create(false)
      throw err
    })
    // Antes do catálogo da máquina chegar, a conversa já sabe para onde ir.
    noteSession(sessionId, machine)
    toast.dismiss(id)
    navigate(`/s/${sessionId}`)
  } catch (err) {
    toast.error(errorMessage(err), { id })
  }
}
