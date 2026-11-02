import { cn } from '@/lib/utils'

/**
 * As peças do painel Computador (ver computer-sheet.tsx): sem cartões nem bordas, como o resto do app.
 * Um bloco é um fundo um tom acima da janela; dentro dele, linhas com o nome à esquerda e o controle à direita.
 */

/** Um assunto dentro da seção: um título pequeno e o bloco embaixo. */
export function Group({ title, note, children, className }: { title?: string; note?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className="space-y-2">
      {title && <h3 className="px-1 text-xs font-medium text-muted-foreground">{title}</h3>}
      <div className={cn('rounded-xl bg-foreground/[0.04] p-1', className)}>{children}</div>
      {note && <p className="px-1 text-xs text-muted-foreground">{note}</p>}
    </section>
  )
}

/** Uma linha do bloco: o nome (e uma dica curta) à esquerda, o controle à direita. */
export function SettingRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  /** O controle que a linha liga: clicar no nome aciona ele. */
  htmlFor?: string
  children?: React.ReactNode
}) {
  const Label = htmlFor ? 'label' : 'div'
  return (
    <div className="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2">
      <Label htmlFor={htmlFor} className={cn('min-w-0 flex-1', htmlFor && 'cursor-pointer')}>
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </Label>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </div>
  )
}

/** Escolha de uma opção entre poucas, como as abas do app: a escolhida ganha a cor da janela. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T
  options: { key: T; label: string; icon?: React.ReactNode }[]
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <div className={cn('grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-foreground/[0.05] p-1', className)}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          className="flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-xs dark:aria-pressed:bg-sidebar-accent [&_svg]:size-4"
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}
