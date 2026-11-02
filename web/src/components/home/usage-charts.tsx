import { useMemo, useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { dayKey, noon, useToday } from '@/lib/activity'
import { projectName } from '@/lib/format'
import type { Activity } from '@/lib/types'
import { cn } from '@/lib/utils'
import { HomeCard, Legend } from './card'
import { BAR, LEVELS, compact, dayLabel, levelOf, plural, usd } from './scale'

const SPAN = 30
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/50 px-3 py-2">
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate text-lg font-semibold">{value}</div>
    </div>
  )
}

/** Custo estimado de cada dia, em colunas; tocar ou passar o mouse numa mostra o dia. */
function DailyCost({ days }: { days: { date: string; costUsd: number; prompts: number; sessions: number }[] }) {
  const [picked, setPicked] = useState<number | null>(null)
  const max = Math.max(0, ...days.map((d) => d.costUsd))
  const top = days.findIndex((d) => d.costUsd === max && max > 0)
  const shown = days[picked ?? days.length - 1]
  return (
    <div>
      <div className="mb-1 text-xs font-medium">Custo estimado por dia</div>
      {/* Espaço em cima para o valor da maior coluna, escrito sobre ela. */}
      <div className="relative flex h-32 items-end gap-[2px] border-b border-border pt-5" onPointerLeave={() => setPicked(null)}>
        {days.map((d, i) => (
          <button
            key={d.date}
            type="button"
            aria-label={`${dayLabel(d.date)}: ${usd(d.costUsd)}`}
            onPointerEnter={() => setPicked(i)}
            onFocus={() => setPicked(i)}
            onClick={() => setPicked(i)}
            // A área de toque é a coluna inteira; a barra é só a parte pintada.
            className="group flex h-full min-w-0 flex-1 items-end justify-center outline-none"
          >
            <span
              className={cn(
                'block w-full max-w-6 rounded-t-[4px] transition-opacity',
                BAR,
                picked !== null && picked !== i && 'opacity-50',
                'group-focus-visible:ring-2 group-focus-visible:ring-ring',
              )}
              style={{ height: max > 0 ? `${Math.max(d.costUsd > 0 ? 3 : 0, (d.costUsd / max) * 100)}%` : 0 }}
            />
          </button>
        ))}
        {top >= 0 && picked === null && (
          <span
            className="pointer-events-none absolute top-0.5 text-[10px] font-medium whitespace-nowrap"
            // Perto da borda direita, o texto alinha pela direita para não sair do gráfico.
            style={top > days.length * 0.7 ? { right: `${((days.length - top - 1) / days.length) * 100}%` } : { left: `${(top / days.length) * 100}%` }}
          >
            {usd(max)}
          </span>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{dayLabel(days[0].date)}</span>
        <span>hoje</span>
      </div>
      <p className="mt-1 text-xs" aria-live="polite">
        <span className="font-medium first-letter:uppercase">{dayLabel(shown.date)}</span>
        <span className="text-muted-foreground">
          {' '}
          · {usd(shown.costUsd)} · {plural(shown.prompts, 'mensagem', 'mensagens')} · {plural(shown.sessions, 'sessão', 'sessões')}
        </span>
      </p>
    </div>
  )
}

/** Mensagens suas por dia da semana e hora: quando você mais usa. */
function HoursGrid({ hours }: { hours: number[][] }) {
  const [picked, setPicked] = useState<[number, number] | null>(null)
  const max = Math.max(0, ...hours.flat())
  const busiest = useMemo(() => {
    let best: [number, number] = [0, 0]
    hours.forEach((row, w) => row.forEach((n, h) => n > hours[best[0]][best[1]] && (best = [w, h])))
    return best
  }, [hours])
  const [w, h] = picked ?? busiest
  return (
    <div>
      <div
        className="grid grid-cols-[1.75rem_repeat(24,minmax(0,1fr))] gap-[2px] text-[10px] text-muted-foreground"
        onPointerLeave={() => setPicked(null)}
      >
        {hours.map((row, wd) => [
          <span key={`l${wd}`} className="flex h-3.5 items-center">
            {WEEKDAYS[wd]}
          </span>,
          ...row.map((n, hr) => (
            <button
              key={`${wd}-${hr}`}
              type="button"
              aria-label={`${WEEKDAYS[wd]}, ${hr}h: ${n} ${n === 1 ? 'mensagem' : 'mensagens'}`}
              onPointerEnter={() => setPicked([wd, hr])}
              onFocus={() => setPicked([wd, hr])}
              onClick={() => setPicked([wd, hr])}
              className={cn('h-3.5 rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-ring', LEVELS[levelOf(n, max)], picked?.[0] === wd && picked[1] === hr && 'ring-2 ring-foreground/50')}
            />
          )),
        ])}
        <span />
        {Array.from({ length: 24 }, (_, hr) => (
          <span key={hr} className="text-center">
            {hr % 6 === 0 ? `${hr}h` : ''}
          </span>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="text-xs" aria-live="polite">
          <span className="font-medium">
            {WEEKDAYS[w]}, {h}h
          </span>
          <span className="text-muted-foreground">
            {' '}
            · {plural(hours[w][h], 'mensagem', 'mensagens')}
            {!picked && max > 0 && ' · o horário em que você mais usa'}
          </span>
        </p>
        <Legend />
      </div>
    </div>
  )
}

/** Os projetos que mais consumiram, em barras deitadas com o valor na ponta. */
function ProjectBars({ projects }: { projects: Activity['projects'] }) {
  const top = projects.slice(0, 5)
  const max = Math.max(0, ...top.map((p) => p.costUsd))
  if (!top.length) return <p className="text-xs text-muted-foreground">Nenhum projeto usou o Claude nestes 30 dias.</p>
  return (
    <div>
      {/* Uma grade só: as barras de todos começam no mesmo ponto e se comparam pelo comprimento. */}
      <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 text-xs">
        {top.map((p) => (
          <div key={p.cwd} className="contents" title={p.cwd}>
            <span className="truncate">{projectName(p.cwd)}</span>
            <span className={cn('h-3 rounded-r-[4px]', BAR)} style={{ width: `${max > 0 ? Math.max(2, (p.costUsd / max) * 100) : 0}%` }} />
            <span className="text-right text-muted-foreground tabular-nums">
              {usd(p.costUsd)} · {plural(p.prompts, 'msg', 'msgs')}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Os últimos 30 dias: os totais e o custo de cada dia. Os horários e os projetos têm cards próprios, abaixo. */
export function UsageCharts({ activity, className }: { activity: Activity | null; className?: string }) {
  const today = useToday()
  const days = useMemo(() => {
    if (!activity) return null
    const byDate = new Map(activity.days.map((d) => [d.date, d]))
    const day = noon(today)
    day.setDate(day.getDate() - (SPAN - 1))
    return Array.from({ length: SPAN }, () => {
      const key = dayKey(day)
      day.setDate(day.getDate() + 1)
      return byDate.get(key) ?? { date: key, sessions: 0, remote: 0, prompts: 0, costUsd: 0, tokens: 0 }
    })
  }, [activity, today])

  const totals = useMemo(
    () =>
      days && {
        cost: days.reduce((n, d) => n + d.costUsd, 0),
        prompts: days.reduce((n, d) => n + d.prompts, 0),
        active: days.filter((d) => d.sessions > 0).length,
        tokens: days.reduce((n, d) => n + d.tokens, 0),
      },
    [days],
  )

  return (
    <HomeCard
      title="Últimos 30 dias"
      description="Custo a preço de tabela da API: no plano de assinatura, o uso conta nos limites e não é cobrado à parte."
      className={className}
    >
      {!activity || !days || !totals ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="Custo estimado" value={usd(totals.cost)} />
            <Tile label="Mensagens suas" value={totals.prompts.toLocaleString('pt-BR')} />
            <Tile label="Dias de uso" value={`${totals.active} de ${SPAN}`} />
            <Tile label="Tokens" value={compact(totals.tokens)} />
          </div>
          <DailyCost days={days} />
        </div>
      )}
    </HomeCard>
  )
}

/** Quando você mais usa: suas mensagens dos últimos 30 dias por dia da semana e hora. */
export function UsageHours({ activity, className }: { activity: Activity | null; className?: string }) {
  return (
    <HomeCard title="Quando você usa" description="Suas mensagens dos últimos 30 dias, por dia da semana e hora." className={className}>
      {activity ? <HoursGrid hours={activity.hours} /> : <Skeleton className="h-36 w-full" />}
    </HomeCard>
  )
}

/** Os projetos que mais consumiram nos últimos 30 dias. */
export function TopProjects({ activity, className }: { activity: Activity | null; className?: string }) {
  return (
    <HomeCard title="Projetos que mais consumiram" description="Custo estimado e mensagens suas nos últimos 30 dias." className={className}>
      {activity ? <ProjectBars projects={activity.projects} /> : <Skeleton className="h-32 w-full" />}
    </HomeCard>
  )
}
