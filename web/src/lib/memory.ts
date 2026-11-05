import { useEffect } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from './api'
import type { MemoryList, MemoryRef, MemorySignal } from './types'

/**
 * A memória automática do Claude Code de cada máquina (ver server/src/memory.ts): a de todos os
 * projetos, no painel Computador, ou a de um só (com `cwd`). Apagar tira da tela na
 * hora e manda para a lixeira do cald, com Desfazer no aviso.
 */
/** Os tipos com que o Claude Code grava cada memória. */
export const MEMORY_TYPES: Record<string, string> = { feedback: 'Jeito de trabalhar', project: 'Projeto', reference: 'Referência', user: 'Sobre você' }

type Entry = { list?: MemoryList; error?: string }
const useMemoryCache = create<Record<string, Entry>>(() => ({}))
const loading = new Map<string, Promise<void>>()
// Sem `cwd`: todos os projetos da máquina.
const keyOf = (machine: string, cwd?: string) => `${machine}\n${cwd ?? ''}`

// Só a última leitura de cada lista vale: uma que saiu antes de uma mudança e chega depois traria o de antes.
const latest = new Map<string, number>()
let reads = 0

/** `fresh`: depois de uma mudança, lê de novo mesmo com uma leitura em andamento (ela já é velha). */
export function loadMemory(machine: string, cwd?: string, fresh = false): Promise<void> {
  const key = keyOf(machine, cwd)
  const running = loading.get(key)
  if (running && !fresh) return running
  const n = ++reads
  latest.set(key, n)
  const job: Promise<void> = api
    .memory(machine, cwd)
    .then(
      (list) => {
        if (latest.get(key) === n) useMemoryCache.setState({ [key]: { list } })
      },
      (err) => {
        if (latest.get(key) !== n) return
        useMemoryCache.setState((s) => ({ [key]: { ...s[key], error: isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err) } }))
      },
    )
    .finally(() => loading.get(key) === job && loading.delete(key))
  loading.set(key, job)
  return job
}

/** As listas já abertas desta máquina, para uma mudança numa aparecer nas outras (a do projeto e a de todos). */
function reloadMachine(machine: string): Promise<unknown> {
  const keys = Object.keys(useMemoryCache.getState()).filter((k) => k.startsWith(`${machine}\n`))
  return Promise.all(keys.map((k) => loadMemory(machine, k.slice(machine.length + 1) || undefined, true)))
}

export function useMemory(machine: string, cwd?: string): Entry {
  const key = keyOf(machine, cwd)
  const entry = useMemoryCache((s) => s[key])
  useEffect(() => {
    void loadMemory(machine, cwd)
  }, [machine, cwd])
  return entry ?? {}
}

/**
 * O que pede atenção de verdade (a aba do projeto conta isto): a memória fora do índice, que o Claude
 * não vê, e o índice apontando para o nada. Link sem memória não conta: o Claude marca assim, de
 * propósito, o que vale escrever depois.
 */
export const URGENT: MemorySignal[] = ['unindexed']

export function useMemoryAlerts(machine: string, cwd?: string): number {
  const list = useMemory(machine, cwd).list
  return (list?.folders ?? []).reduce(
    (n, f) => n + f.missing.length + f.memories.filter((m) => m.signals.some((s) => URGENT.includes(s))).length,
    0,
  )
}

const refOf = (r: MemoryRef) => `${r.folder}/${r.file}`

/**
 * Manda para a lixeira e devolve os ids lá, para o Desfazer da própria lista (o de um aviso não
 * serviria: o painel Computador e a folha da barra no celular são modais, e o aviso fica fora deles).
 */
export async function trashMemories(machine: string, items: MemoryRef[]): Promise<string[]> {
  if (!items.length) return []
  const gone = new Set(items.map(refOf))
  useMemoryCache.setState((s) =>
    Object.fromEntries(
      Object.entries(s).map(([k, e]) => [
        k,
        k.startsWith(`${machine}\n`) && e.list
          ? { ...e, list: { ...e.list, folders: e.list.folders.map((f) => ({ ...f, memories: f.memories.filter((m) => !gone.has(refOf({ folder: f.folder, file: m.file }))) })) } }
          : e,
      ]),
    ),
  )
  try {
    return (await api.trashMemories(machine, items)).ids
  } catch (err) {
    toast.error(errorMessage(err))
    return []
  } finally {
    await reloadMachine(machine)
  }
}

export async function restoreMemories(machine: string, ids: string[]): Promise<void> {
  try {
    await api.restoreMemories(machine, ids)
  } catch (err) {
    toast.error(errorMessage(err))
  } finally {
    await reloadMachine(machine)
  }
}

export async function emptyMemoryTrash(machine: string, ids?: string[]): Promise<void> {
  try {
    await api.emptyMemoryTrash(machine, ids)
  } catch (err) {
    toast.error(errorMessage(err))
  } finally {
    await reloadMachine(machine)
  }
}

/** Grava e relê; o erro (o Claude mudou a memória no meio, por exemplo) volta para o editor mostrar. */
export async function saveMemory(machine: string, ref: MemoryRef & { description: string; body: string; mtime: number }): Promise<void> {
  try {
    await api.saveMemory(machine, ref)
  } finally {
    await reloadMachine(machine)
  }
}
