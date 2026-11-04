import { useState } from 'react'
import { usePeers } from './peers'
import type { GitStatus } from './types'

const WORKTREE = /\/\.claude\/worktrees\/[^/]+/
const isWorktree = (cwd: string) => WORKTREE.test(cwd)

/** O projeto de que a pasta é cópia, se ela fica num worktree (como `worktreeOf` no servidor); senão, ela mesma. */
export const projectOf = (cwd: string) => cwd.replace(WORKTREE, '')

/**
 * Conversa nova num projeto em que outra já mexe: oferece rodar num worktree separado (ver
 * server/src/worktrees.ts), já ligado quando há outra conversa aberta no mesmo checkout, no painel ou
 * no PC, trabalhando ou parada (a parada volta a mexer na próxima mensagem). Sem ninguém lá, a opção
 * fica à mão, desligada. Não se aplica sem git, sem branch ou numa pasta que já é um worktree (`available`).
 */
export function useWorktreeChoice(machine: string, cwd: string | undefined, git: GitStatus | null) {
  const { working, idle } = usePeers(machine, cwd)
  const others = working.length + idle.length
  // A escolha vale para o projeto em que foi feita: trocar de projeto volta ao padrão dele.
  const [choice, setChoice] = useState<{ cwd?: string; on: boolean }>()
  const available = Boolean(cwd && git?.branch && !isWorktree(cwd))
  const on = available && (choice && choice.cwd === cwd ? choice.on : others > 0)
  return { available, on, others, working, idle: idle.length, base: git?.branch ?? null, set: (value: boolean) => setChoice({ cwd, on: value }) }
}

export type WorktreeChoice = ReturnType<typeof useWorktreeChoice>
