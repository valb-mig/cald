import { useEffect, useRef } from 'react'

/**
 * O que mudou numa máquina, pelo app ou pelo Claude de uma conversa (o MCP do cald, ver
 * server/src/cald-mcp.ts): o TODO de um projeto, os times, os workspaces ou as habilidades. Chega pelo
 * WebSocket (ver store.ts), e quem tem isso na tela recarrega.
 */
export type Changed = { what: 'todos' | 'teams' | 'workspaces' | 'habilidades' | 'saved-commands'; cwd?: string; rev?: number }

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
