import { useSyncExternalStore } from 'react'
import { duration } from '@/lib/format'
import type { AgentNode, AgentStatus } from './model'

/** Rótulo e cores de cada estado; os mesmos tons do resto do app (ver state-badge.tsx). */
export const STATUS: Record<AgentStatus, { label: string; badge: string; node: string }> = {
  running: {
    label: 'Trabalhando',
    badge: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
    node: 'border-sky-500/60 ring-3 ring-sky-500/15',
  },
  waiting: {
    label: 'Pede aprovação',
    badge: 'bg-amber-500/20 text-amber-800 dark:text-amber-300',
    node: 'border-amber-500/70 ring-3 ring-amber-500/20',
  },
  done: {
    label: 'Concluído',
    badge: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    node: 'border-emerald-500/40',
  },
  failed: {
    label: 'Falhou',
    badge: 'bg-red-500/15 text-red-700 dark:text-red-300',
    node: 'border-red-500/50',
  },
  stopped: {
    label: 'Interrompido',
    badge: 'text-muted-foreground',
    node: 'border-dashed',
  },
}

const second = () => Math.floor(Date.now() / 1_000) * 1_000
const everySecond = (onChange: () => void) => {
  const timer = setInterval(onChange, 1_000)
  return () => clearInterval(timer)
}
const still = () => () => {}

/** Relógio que anda a cada segundo enquanto `active`; parado, vale a hora de cada renderização. */
export function useNow(active: boolean): number {
  return useSyncExternalStore(active ? everySecond : still, second)
}

/** Há quanto tempo trabalha (ao vivo) ou quanto levou; vazio se não se sabe. */
export function elapsed(node: AgentNode, now: number): string {
  const working = node.status === 'running' || node.status === 'waiting'
  if (working && node.startedAt) return duration(Math.max(0, now - node.startedAt))
  return node.durationMs ? duration(node.durationMs) : ''
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "Explore · 12 ferramentas · 1min 3s · segundo plano" */
export function agentMeta(node: AgentNode, now: number, { type = true, label }: { type?: boolean; label?: string } = {}): string {
  return [
    type && (label ?? node.type),
    node.tools > 0 && plural(node.tools, 'ferramenta', 'ferramentas'),
    elapsed(node, now),
    node.background && 'segundo plano',
  ]
    .filter(Boolean)
    .join(' · ')
}
