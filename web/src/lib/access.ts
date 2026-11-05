import { useEffect } from 'react'
import { create } from 'zustand'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from './api'
import { onChanged } from './changes'
import { useStore } from './store'
import type { AccessInfo, LinkCheck } from './types'

/**
 * Quem acessa o app em cada máquina (ver a seção Acesso do painel Computador): o link remoto, os
 * aparelhos conectados agora, os bloqueados e o histórico. Uma cópia por máquina, que a seção e o
 * relance na navegação do painel dividem; o PC avisa cada mudança pelo WebSocket.
 */
type Entry = { info?: AccessInfo; error?: string }
const useAccessCache = create<Record<string, Entry>>(() => ({}))
const loading = new Map<string, Promise<void>>()
const EMPTY: Entry = {}

// Só a última leitura vale: uma que saiu antes de uma mudança e chega depois traria o de antes.
const latest = new Map<string, number>()
let reads = 0

/** `fresh`: depois de uma mudança, lê de novo mesmo com uma leitura em andamento (ela já é velha). */
export function loadAccess(machine: string, fresh = false): Promise<void> {
  const running = loading.get(machine)
  if (running && !fresh) return running
  const n = ++reads
  latest.set(machine, n)
  const job: Promise<void> = api
    .access(machine)
    .then(
      (info) => {
        if (latest.get(machine) === n) useAccessCache.setState({ [machine]: { info } })
      },
      (err) => {
        if (latest.get(machine) !== n) return
        useAccessCache.setState((s) => ({ [machine]: { ...s[machine], error: isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err) } }))
      },
    )
    .finally(() => loading.get(machine) === job && loading.delete(machine))
  loading.set(machine, job)
  return job
}

/** O link como o PC respondeu ao ligar ou desligar, antes do aviso de mudança chegar. */
export function setAccessLink(machine: string, link: LinkCheck): void {
  useAccessCache.setState((s) => {
    const info = s[machine]?.info
    return info ? { [machine]: { ...s[machine], info: { ...info, link } } } : s
  })
}

// Quantos na tela olham cada máquina: só elas releem a cada mudança.
const watching = new Map<string, number>()

onChanged((machine, change) => {
  if (change.what === 'access' && watching.has(machine)) void loadAccess(machine, true)
})

// De volta à conexão (o app voltou do fundo, o PC reiniciou): o que mudou no meio não chegou.
useStore.subscribe((s, prev) => {
  for (const machine of watching.keys()) {
    if (s.connections[machine] === 'open' && prev.connections[machine] !== 'open') void loadAccess(machine, true)
  }
})

export function useAccess(machine: string): Entry {
  const entry = useAccessCache((s) => s[machine])
  useEffect(() => {
    watching.set(machine, (watching.get(machine) ?? 0) + 1)
    void loadAccess(machine)
    return () => {
      const n = (watching.get(machine) ?? 1) - 1
      if (n > 0) watching.set(machine, n)
      else watching.delete(machine)
    }
  }, [machine])
  return entry ?? EMPTY
}

/** Quantos outros aparelhos (fora este) estão com o app aberto agora. */
export function useOthersConnected(machine: string): number {
  return useAccess(machine).info?.connected.filter((c) => !c.self).length ?? 0
}
