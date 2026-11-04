import { ChevronRight, RotateCcw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * Peças das telas do que o Claude carrega (memória, skills, MCP), no painel Computador e na aba
 * Claude da barra do projeto: as mesmas nas duas larguras.
 */

/** A busca do topo, como a do TODO: sem borda, um tom acima do fundo. */
export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-8 rounded-lg border-transparent bg-foreground/[0.05] pl-8 text-[13px] shadow-none dark:bg-foreground/[0.05]"
      />
    </div>
  )
}

/** Um filtro de liga e desliga, com a contagem; some quando não há nada dele. */
export function Chip({ on, onClick, label, count, title }: { on: boolean; onClick: () => void; label: string; count?: number; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={title}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs whitespace-nowrap text-muted-foreground ring-1 ring-foreground/10 transition-colors hover:text-foreground aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:ring-foreground"
    >
      {label}
      {count !== undefined && <span className="tabular-nums opacity-70">{count}</span>}
    </button>
  )
}

/** Uma fileira de filtros que rola de lado no celular. */
export function Chips({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">{children}</div>
}

/** Um grupo que abre e fecha: o título com a contagem à esquerda e, à direita, o que mais couber. */
export function Fold({
  title,
  count,
  open,
  onOpenChange,
  aside,
  children,
}: {
  title: React.ReactNode
  count?: number
  open: boolean
  onOpenChange: (open: boolean) => void
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="flex min-w-0 items-center gap-1">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
          <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
          <span className="min-w-0 truncate">{title}</span>
          {count !== undefined && <span className="shrink-0 font-normal tabular-nums opacity-70">{count}</span>}
        </CollapsibleTrigger>
        {aside && <div className="flex shrink-0 items-center gap-1">{aside}</div>}
      </div>
      <CollapsibleContent className="space-y-0.5 pt-0.5">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/** Um selo pequeno numa linha: o tom diz se é aviso (`warn`), problema (`bad`) ou só informação. */
export function Tag({ tone = 'muted', title, children, className }: { tone?: 'muted' | 'warn' | 'bad' | 'ok'; title?: string; children: React.ReactNode; className?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center rounded px-1.5 text-[10.5px] leading-none whitespace-nowrap',
        tone === 'muted' && 'bg-foreground/[0.06] text-muted-foreground',
        tone === 'warn' && 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
        tone === 'bad' && 'bg-red-500/15 text-red-700 dark:text-red-400',
        tone === 'ok' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** O pé da lista, por cima dela: o que acabou de ir para a lixeira, com Desfazer (ver lib/undo.ts). */
export function UndoBar({ text, onUndo }: { text: string; onUndo: () => void }) {
  return (
    <div role="status" className="sticky bottom-0 z-10 -mx-1 flex items-center gap-2 rounded-xl bg-popover/95 p-2 pl-3 shadow-lg ring-1 ring-foreground/10 backdrop-blur">
      <span className="min-w-0 flex-1 text-sm">{text}</span>
      <Button variant="ghost" size="sm" onClick={onUndo}>
        <RotateCcw /> Desfazer
      </Button>
    </div>
  )
}
