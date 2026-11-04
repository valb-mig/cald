import { GitBranch, Loader2 } from 'lucide-react'
import { PeerFaces } from '@/components/peer-faces'
import { Switch } from '@/components/ui/switch'
import { projectName } from '@/lib/format'
import { namesOf } from '@/lib/peers'
import { cn } from '@/lib/utils'
import type { WorktreeChoice } from '@/lib/worktree'

/**
 * A linha acima da caixa de mensagem da conversa nova: quem já mexe no projeto e a chave do worktree
 * (ver `useWorktreeChoice`). Quem trabalha agora aparece com o claudinho e o nome; as abertas e paradas,
 * só na conta, porque também voltam a mexer nos arquivos na próxima mensagem.
 */
export function WorktreeToggle({ choice, cwd, creating, className }: { choice: WorktreeChoice; cwd: string; creating: boolean; className?: string }) {
  if (!choice.available) return null
  const { on, others, working, idle, base } = choice
  const project = projectName(cwd)
  const stopped = `${idle} ${idle === 1 ? 'aberta parada' : 'abertas paradas'}`
  const title = creating
    ? 'Criando o worktree e instalando as dependências…'
    : working.length
      ? `${namesOf(working)} ${working.length === 1 ? 'trabalha' : 'trabalham'} em ${project} agora`
      : idle
        ? `${idle} ${idle === 1 ? 'conversa aberta' : 'conversas abertas'} em ${project}, ${idle === 1 ? 'parada' : 'paradas'}`
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
        <span className={cn('flex items-center gap-1.5 font-medium', on && 'text-foreground')}>
          {working.length > 0 && !creating && <PeerFaces list={working} size={16} />}
          <span className="min-w-0">
            {title}
            {working.length > 0 && idle > 0 && !creating && <span className="font-normal text-muted-foreground"> · {stopped}</span>}
            {others > 0 && !creating && <span className="font-normal text-muted-foreground"> · rodar em worktree</span>}
          </span>
        </span>
        {detail && !creating && <span className="block text-muted-foreground">{detail}</span>}
      </span>
      <Switch checked={on} onCheckedChange={choice.set} disabled={creating} aria-label="Rodar num worktree separado" />
    </label>
  )
}
