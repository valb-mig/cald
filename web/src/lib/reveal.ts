import { create } from 'zustand'
import { openViewer, type PanelProject } from './project-panel'

/**
 * Abrir um arquivo já numa linha (a busca nos arquivos, o `arquivo:12` do Ctrl+P): o pedido fica aqui
 * até o arquivo aparecer, no editor do PC ou no arquivo só leitura do celular, que o atende e tira.
 */

/** A linha (contando de 1) e, se houver, o trecho dela a selecionar (coluna e tamanho, em caracteres). */
export type RevealAt = { line: number; col?: number; len?: number }

export const revealKey = (machine: string, cwd: string, path: string) => `${machine}\n${cwd}\n${path}`

export const useReveal = create<Record<string, RevealAt>>(() => ({}))

/** Abre `path` em `at`; já aberto, só vai até lá. */
export function openAt(project: PanelProject, path: string, at: RevealAt, pin = false): void {
  useReveal.setState({ [revealKey(project.machine, project.cwd, path)]: at })
  openViewer({ machine: project.machine, cwd: project.cwd, path }, pin)
}

/** Atendido: sai da fila. */
export function doneReveal(key: string): void {
  useReveal.setState((s) => {
    const next = { ...s }
    delete next[key]
    return next
  }, true)
}
