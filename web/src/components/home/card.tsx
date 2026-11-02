import { cn } from '@/lib/utils'
import { LEVELS } from './scale'

/** Moldura dos painéis da home: título, uma linha de explicação e, à direita, uma ação. */
export function HomeCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('min-w-0 rounded-2xl border bg-card p-4', className)}>
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

/** Legenda das escalas de cor: do vazio ao mais intenso. */
export function Legend() {
  return (
    <div className="flex items-center gap-1 text-[11px] text-muted-foreground" aria-hidden>
      menos
      {LEVELS.map((c) => (
        <span key={c} className={`size-2.5 rounded-[3px] ${c}`} />
      ))}
      mais
    </div>
  )
}
