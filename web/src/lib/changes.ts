import { useEffect, useRef } from 'react'

/**
 * O que mudou numa máquina, pelo app ou pelo Claude de uma conversa (o MCP do cald, ver
 * server/src/cald-mcp.ts): o TODO ou os detalhes de um projeto, os times, os workspaces, as habilidades, os artefatos
 * ou as sugestões de memória de uma conversa; quem acessa o app (ver lib/access.ts); ou os agentes
 * ligados (ver lib/providers.ts). Chega pelo WebSocket (ver store.ts), e quem tem isso na tela recarrega.
 */
export type Changed = {
  what: 'todos' | 'detalhes' | 'teams' | 'workspaces' | 'habilidades' | 'saved-commands' | 'memory-suggestions' | 'access' | 'artefatos' | 'agents'
  cwd?: string
  rev?: number
  /** A conversa, nas sugestões de memória. */
  session?: string
}

type Listener = (machine: string, change: Changed) => void
const listeners = new Set<Listener>()

export function onChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitChanged(machine: string, change: Changed): void {
  for (const listener of listeners) listener(machine, change)
}

/** Chama `reload` quando `what` muda em `machine`, enquanto o componente está na tela. */
export function useOnChanged(machine: string, what: Changed['what'], reload: () => void): void {
  const latest = useRef(reload)
  useEffect(() => {
    latest.current = reload
  })
  useEffect(() => onChanged((m, c) => m === machine && c.what === what && latest.current()), [machine, what])
}
