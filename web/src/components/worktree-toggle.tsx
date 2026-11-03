import { GitBranch, Loader2 } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { projectName } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { WorktreeChoice } from '@/lib/worktree'

/**
 * A linha acima da caixa de mensagem da conversa nova: quantas conversas já mexem no projeto e a chave
 * do worktree (ver `useWorktreeChoice`).
 */
export function WorktreeToggle({ choice, cwd, creating, className }: { choice: WorktreeChoice; cwd: string; creating: boolean; className?: string }) {
  if (!choice.available) return null
  const { on, others, base } = choice
  const title = creating
    ? 'Criando o worktree e instalando as dependências…'
    : others
      ? `${others} ${others === 1 ? 'conversa aberta' : 'conversas abertas'} em ${projectName(cwd)}`
      : 'Rodar num worktree separado'
  const detail = on
    ? `Esta conversa roda numa cópia só dela, numa branch nova a partir de ${base}. O "Trazer" leva o trabalho de volta.`
    : others
      ? `Desligado: esta conversa vai mexer nos mesmos arquivos que ${others === 1 ? 'a outra' : 'as outras'}.`
      : null
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-xs transition-colors',
        on ? 'border-primary/40 bg-primary/5' : 'bg-background/60 text-muted-foreground',
        creating && 'cursor-progress',
        className,
      )}
    >
      {creating ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <GitBranch className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1 text-left">
        <span className={cn('block font-medium', on && 'text-foreground')}>
          {title}
          {others > 0 && !creating && <span className="font-normal text-muted-foreground"> · rodar em worktree</span>}
        </span>
        {detail && !creating && <span className="block text-muted-foreground">{detail}</span>}
      </span>
      <Switch checked={on} onCheckedChange={choice.set} disabled={creating} aria-label="Rodar num worktree separado" />
    </label>
  )
}
