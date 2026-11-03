import { useMemo, useState } from 'react'
import { HOME } from './machines'
import { useStore } from './store'
import type { GitStatus } from './types'

const isWorktree = (cwd: string) => /\/\.claude\/worktrees\/[^/]+/.test(cwd)

/**
 * Conversa nova num projeto em que outra já mexe: oferece rodar num worktree separado (ver
 * server/src/worktrees.ts), já ligado quando há outra conversa aberta no mesmo checkout, no painel ou
 * no PC. Sem ninguém lá, a opção fica à mão, desligada. Não se aplica sem git, sem branch ou numa
 * pasta que já é um worktree (`available`).
 */
export function useWorktreeChoice(machine: string, cwd: string | undefined, git: GitStatus | null) {
  const catalog = useStore((s) => s.catalog)
  const others = useMemo(
    () => (cwd ? catalog.filter((c) => (c.machine ?? HOME) === machine && c.owner && c.cwd === cwd).length : 0),
    [catalog, machine, cwd],
  )
  // A escolha vale para o projeto em que foi feita: trocar de projeto volta ao padrão dele.
  const [choice, setChoice] = useState<{ cwd?: string; on: boolean }>()
  const available = Boolean(cwd && git?.branch && !isWorktree(cwd))
  const on = available && (choice && choice.cwd === cwd ? choice.on : others > 0)
  return { available, on, others, base: git?.branch ?? null, set: (value: boolean) => setChoice({ cwd, on: value }) }
}

export type WorktreeChoice = ReturnType<typeof useWorktreeChoice>
