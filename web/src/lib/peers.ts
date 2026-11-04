import { useMemo } from 'react'
import { claudinhoName } from './claudinho'
import { HOME } from './machines'
import { useStore } from './store'
import type { CatalogEntry } from './types'

/**
 * Conversas que mexem no mesmo checkout ao mesmo tempo: a lista de conversas liga as do mesmo projeto
 * num trilho (ver pages/sessions.tsx), o chat diz com quem divide os arquivos (ver chat/peer-chip.tsx)
 * e a conversa nova conta quem já trabalha lá (ver worktree-toggle.tsx).
 */

/**
 * Mexendo agora: executando ou com algo em segundo plano que vai trazer o Claude de volta. A que espera
 * você fica de fora: parada até a sua resposta, às vezes há horas.
 */
export const isWorking = (s: CatalogEntry) => s.state === 'running' || (s.state === 'idle' && Boolean(s.tasks?.length))

/** Trabalhando primeiro; dentro de cada parte, da mais recente para a mais antiga. */
const byActivity = (a: CatalogEntry, b: CatalogEntry) => Number(isWorking(b)) - Number(isWorking(a)) || b.lastModified - a.lastModified

/** "Lulu", "Lulu e Hana", "Lulu, Hana e Tuca", "Lulu, Hana +2". */
export function namesOf(list: CatalogEntry[], max = 3): string {
  const names = list.map((s) => claudinhoName(s.sessionId, s.claudinhoName))
  if (names.length <= 1) return names[0] ?? ''
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`
  return `${names.slice(0, max - 1).join(', ')} +${names.length - max + 1}`
}

/**
 * As outras conversas abertas (no painel ou no PC) no mesmo checkout: a mesma pasta, na mesma máquina.
 * Um worktree é outro checkout, então quem roda nele não divide os arquivos. `working`: mexendo
 * agora; `idle`: abertas, paradas ou esperando você, mas podem voltar a mexer na próxima mensagem.
 */
export function usePeers(machine: string, cwd: string | undefined, exclude?: string) {
  const catalog = useStore((s) => s.catalog)
  return useMemo(() => {
    const open = cwd
      ? catalog.filter((c) => c.owner && c.cwd === cwd && (c.machine ?? HOME) === machine && c.sessionId !== exclude).sort(byActivity)
      : []
    return { working: open.filter(isWorking), idle: open.filter((s) => !isWorking(s)) }
  }, [catalog, machine, cwd, exclude])
}
