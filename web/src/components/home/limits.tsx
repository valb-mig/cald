import { ChevronRight, TriangleAlert } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { Meter } from '@/components/pc-status'
import { Skeleton } from '@/components/ui/skeleton'
import { setComputerOpen } from '@/lib/computer'
import { bytes } from '@/lib/format'
import { HOME, useMachines } from '@/lib/machines'
import { useStore } from '@/lib/store'
import type { UsageWindow } from '@/lib/types'
import { HomeCard } from './card'

const HOUR = 3_600_000
const minute = () => Math.floor(Date.now() / 60_000) * 60_000
const everyMinute = (onChange: () => void) => {
  const timer = setInterval(onChange, 30_000)
  return () => clearInterval(timer)
}

/** "hoje às 16:40", "amanhã às 09:00", "qui. às 14:00". */
function whenAt(ms: number): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const day = new Date()
  if (d.toDateString() === day.toDateString()) return `hoje às ${time}`
  day.setDate(day.getDate() + 1)
  if (d.toDateString() === day.toDateString()) return `amanhã às ${time}`
  return `${d.toLocaleDateString('pt-BR', { weekday: 'short' })} às ${time}`
}

type Forecast = { text: string; short: boolean }

/**
 * Previsão pelo ritmo desde o começo da janela (ela começa `span` antes de renovar): se nesse
 * ritmo o limite acaba antes de renovar, quando; senão, onde ele chega.
 */
function forecast(w: UsageWindow | null | undefined, span: number, now: number): Forecast | null {
  if (!w || w.utilization === null || !w.resetsAt) return null
  if (w.utilization >= 100) return { text: `Limite atingido · renova ${whenAt(Date.parse(w.resetsAt))}`, short: true }
  const reset = Date.parse(w.resetsAt)
  const elapsed = now - (reset - span)
  // Logo no começo da janela, qualquer ritmo parece enorme.
  if (elapsed < span * 0.1 || w.utilization < 1) return { text: `Renova ${whenAt(reset)}`, short: false }
  const rate = w.utilization / elapsed
  const atReset = w.utilization + rate * (reset - now)
  if (atReset < 100) return { text: `No ritmo atual, chega a ~${Math.round(atReset)}% · renova ${whenAt(reset)}`, short: false }
  return { text: `No ritmo atual, acaba ${whenAt(now + (100 - w.utilization) / rate)} · renova ${whenAt(reset)}`, short: true }
}

function Window({ label, window, span, now }: { label: string; window: UsageWindow | null | undefined; span: number; now: number }) {
  const f = forecast(window, span, now)
  const value = window?.utilization ?? null
  return (
    <div className="space-y-1">
      <Meter label={label} value={value === null ? '—' : `${Math.round(value)}%`} percent={value ?? 0} />
      {f && (
        <p className={f.short ? 'flex items-start gap-1 text-[11px] text-[#9a6700] dark:text-[#fab219]' : 'text-[11px] text-muted-foreground'}>
          {f.short && <TriangleAlert className="mt-px size-3 shrink-0" aria-label="atenção" />}
          {f.text}
        </p>
      )}
    </div>
  )
}

/** Limites do plano com previsão e, embaixo, o PC num relance (toque abre o painel Computador). */
export function Limits({ className }: { className?: string }) {
  const now = useSyncExternalStore(everyMinute, minute)
  const usage = useStore((s) => s.usages[HOME])
  const system = useStore((s) => s.systems[HOME])
  const name = useMachines((s) => (s.machines.length > 1 ? s.machines.find((m) => m.id === HOME)?.name : undefined))
  const plan = usage?.plan

  return (
    <HomeCard title="Limites do plano" description="Quanto já foi usado e, no ritmo atual, até onde vai." className={className}>
      {plan?.available ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Window label="5 horas" window={plan.fiveHour} span={5 * HOUR} now={now} />
            <Window label="Semana (todos os modelos)" window={plan.sevenDay} span={7 * 24 * HOUR} now={now} />
          </div>
          {plan.models.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              {plan.models.map((m) => (
                <Window key={m.name} label={`Semana · ${m.name}`} window={m} span={7 * 24 * HOUR} now={now} />
              ))}
            </div>
          )}
        </div>
      ) : usage?.planError || plan ? (
        <p className="text-sm text-muted-foreground">Limites do plano indisponíveis no momento.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      )}

      <button
        type="button"
        onClick={() => setComputerOpen(true)}
        className="-mx-4 -mb-4 mt-4 flex w-[calc(100%+2rem)] items-center gap-3 border-t px-4 py-2.5 text-left text-xs text-muted-foreground hover:bg-muted/50"
      >
        <span className="shrink-0 font-medium text-foreground">{name ?? 'PC'}</span>
        {system ? (
          <span className="min-w-0 flex-1 truncate">
            CPU {Math.round(system.cpu.percent)}% · memória {bytes(system.memory.used)} de {bytes(system.memory.total)} ·{' '}
            {system.claude.processes} {system.claude.processes === 1 ? 'processo' : 'processos'} do Claude
          </span>
        ) : (
          <Skeleton className="h-3 flex-1" />
        )}
        <ChevronRight className="size-4 shrink-0" />
      </button>
    </HomeCard>
  )
}
