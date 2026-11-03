import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { dayKey, noon, useToday } from '@/lib/activity'
import type { ActivityDay } from '@/lib/types'
import { cn } from '@/lib/utils'
import { HomeCard, Legend } from './card'
import { LEVELS, dayLabel, levelOf, plural, usd } from './scale'

type Metric = 'remote' | 'all'
const WEEKS = 53
const WEEKDAYS = ['', 'seg', '', 'qua', '', 'sex', '']

/** Dias seguidos com uso terminando hoje (ou ontem, se hoje ainda não teve) e o maior trecho. */
function streaks(active: Set<string>, today: string): { current: number; best: number } {
  const day = noon(today)
  if (!active.has(dayKey(day))) day.setDate(day.getDate() - 1)
  let current = 0
  while (active.has(dayKey(day))) {
    current++
    day.setDate(day.getDate() - 1)
  }
  let best = 0
  let run = 0
  let prev: number | null = null
  for (const key of [...active].sort()) {
    const t = noon(key).getTime()
    run = prev !== null && Math.round((t - prev) / 86_400_000) === 1 ? run + 1 : 1
    best = Math.max(best, run)
    prev = t
  }
  return { current, best }
}

/**
 * O ano em quadradinhos, como o grid de contribuições do GitHub: cada coluna uma semana (domingo
 * em cima), a cor diz quantas conversas houve no dia. Tocar ou passar o mouse mostra o dia.
 */
export function ActivityGrid({ days, className }: { days: ActivityDay[] | null; className?: string }) {
  const [metric, setMetric] = useState<Metric>('remote')
  const [picked, setPicked] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const todayKey = useToday()

  const grid = useMemo(() => {
    const byDate = new Map((days ?? []).map((d) => [d.date, d]))
    const valueOf = (d?: ActivityDay) => (d ? (metric === 'remote' ? d.remote : d.sessions) : 0)
    const today = noon(todayKey)
    const start = noon(todayKey)
    start.setDate(today.getDate() - today.getDay() - (WEEKS - 1) * 7)
    const cells: { date: string; value: number; future: boolean }[] = []
    const months: (string | null)[] = []
    const cursor = new Date(start)
    for (let w = 0; w < WEEKS; w++) {
      // Nome do mês na primeira semana que começa nele (a primeira coluna, quase sempre pela metade, fica sem).
      const month = cursor.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')
      months.push(w > 0 && cursor.getDate() <= 7 ? month : null)
      for (let d = 0; d < 7; d++) {
        const key = dayKey(cursor)
        cells.push({ date: key, value: valueOf(byDate.get(key)), future: key > todayKey })
        cursor.setDate(cursor.getDate() + 1)
      }
    }
    const visible = cells.filter((c) => !c.future)
    const active = new Set(visible.filter((c) => c.value > 0).map((c) => c.date))
    return { byDate, cells, months, max: Math.max(0, ...visible.map((c) => c.value)), active, streak: streaks(active, todayKey) }
  }, [days, metric, todayKey])

  // Começa mostrando as semanas mais recentes (no celular o ano não cabe).
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [days])

  const shown = picked ?? todayKey
  const d = grid.byDate.get(shown)
  const detail = d
    ? [
        metric === 'remote' ? plural(d.remote, 'sessão pelo cald', 'sessões pelo cald') : plural(d.sessions, 'sessão', 'sessões'),
        metric === 'remote' && d.sessions !== d.remote && `${d.sessions} no total`,
        d.prompts > 0 && plural(d.prompts, 'mensagem sua', 'mensagens suas'),
        d.costUsd > 0 && usd(d.costUsd),
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Sem uso'

  return (
    <HomeCard
      className={className}
      title={metric === 'remote' ? 'Dias com o cald' : 'Dias com o Claude Code'}
      description={
        days
          ? `${plural(grid.active.size, 'dia', 'dias')} de uso no último ano · sequência atual: ${plural(grid.streak.current, 'dia', 'dias')} · recorde: ${plural(grid.streak.best, 'dia', 'dias')}`
          : 'Carregando o histórico…'
      }
      action={
        <div className="flex shrink-0 rounded-lg border p-0.5 text-xs" role="radiogroup" aria-label="O que contar">
          {(
            [
              ['remote', 'cald'],
              ['all', 'Tudo'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={metric === value}
              onClick={() => setMetric(value)}
              className={cn('rounded-md px-2 py-1', metric === value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      {!days ? (
        <Skeleton className="h-28 w-full" />
      ) : (
        <>
          <div ref={scroller} className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
            <div className="inline-grid grid-cols-[auto_1fr] gap-x-1.5">
              <span />
              <div className="grid grid-flow-col gap-[3px] [grid-auto-columns:11px] sm:[grid-auto-columns:12px]">
                {grid.months.map((m, i) => (
                  <span key={i} className="h-4 overflow-visible text-[10px] whitespace-nowrap text-muted-foreground">
                    {m}
                  </span>
                ))}
              </div>
              <div className="grid grid-rows-7 gap-[3px] text-[10px] leading-none text-muted-foreground [grid-auto-rows:11px] sm:[grid-auto-rows:12px]">
                {WEEKDAYS.map((w, i) => (
                  <span key={i} className="flex items-center">
                    {w}
                  </span>
                ))}
              </div>
              <div
                className="grid grid-flow-col grid-rows-7 gap-[3px] [grid-auto-columns:11px] [grid-template-rows:repeat(7,11px)] sm:[grid-auto-columns:12px] sm:[grid-template-rows:repeat(7,12px)]"
                onPointerLeave={() => setPicked(null)}
              >
                {grid.cells.map((c) =>
                  c.future ? (
                    <span key={c.date} />
                  ) : (
                    <button
                      key={c.date}
                      type="button"
                      aria-label={`${dayLabel(c.date)}: ${c.value} ${c.value === 1 ? 'sessão' : 'sessões'}`}
                      onPointerEnter={() => setPicked(c.date)}
                      onFocus={() => setPicked(c.date)}
                      onClick={() => setPicked(c.date)}
                      className={cn(
                        'rounded-[3px] outline-offset-1 hover:outline-2 hover:outline-foreground/40 focus-visible:outline-2 focus-visible:outline-ring',
                        LEVELS[levelOf(c.value, grid.max)],
                        c.date === shown && 'outline-2 outline-foreground/60',
                      )}
                    />
                  ),
                )}
              </div>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <p className="min-w-0 text-xs" aria-live="polite">
              <span className="font-medium first-letter:uppercase">{dayLabel(shown)}</span>
              <span className="text-muted-foreground"> · {detail}</span>
            </p>
            <Legend />
          </div>
        </>
      )}
    </HomeCard>
  )
}
