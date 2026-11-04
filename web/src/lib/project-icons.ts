import { create } from 'zustand'
import { projectKey } from './project-groups'

/**
 * Quantas vezes a marca de cada projeto foi trocada neste aparelho, por `projectKey`: entra no endereço
 * da imagem (ver ProjectMark), para a nova aparecer na hora em todo lugar que mostra o projeto.
 */
export const useIconVersions = create<Record<string, number>>(() => ({}))

export function bumpProjectIcon(machine: string, cwd: string): void {
  const key = projectKey(machine, cwd)
  useIconVersions.setState((s) => ({ [key]: (s[key] ?? 0) + 1 }))
}
