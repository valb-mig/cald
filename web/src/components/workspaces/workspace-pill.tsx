import { ChevronDown, Layers, Pin, Plus, Settings2 } from 'lucide-react'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { footerButton } from '@/components/chat/composer-controls'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { projectName } from '@/lib/format'
import type { WorkspaceTag } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  createProjectWorkspace,
  defaultWorkspace,
  loadWorkspaces,
  projectWorkspaces,
  setProjectWorkspace,
  useOpenWorkspace,
  useWorkspaces,
  workspaceColor,
  workspaceFailed,
} from '@/lib/workspaces'

const NONE = '__sem-workspace__'

/** A bolinha da cor do workspace. */
export function WorkspaceDot({ color, className }: { color: number; className?: string }) {
  return <span className={cn('size-2.5 shrink-0 rounded-full', className)} style={{ background: workspaceColor(color) }} />
}

/** O workspace como está agora (nome e cor podem ter mudado) ou, fora da lista, a etiqueta que a conversa guardou. */
function useShown(machine: string, value?: WorkspaceTag): WorkspaceTag | undefined {
  const fresh = useWorkspaces((s) => (value ? s.byMachine[machine]?.find((w) => w.id === value.id) : undefined))
  return fresh ?? value
}

/**
 * O menu de workspace da conversa: "Sem workspace" e os que têm o projeto, com o padrão dele marcado. Na
 * conversa nova, `value` é o escolhido; numa que já começou, o dela, que aparece mesmo se foi apagado ou
 * não tem mais o projeto. O gatilho é o `children`: a pílula da caixa de mensagem ou, no celular, o topo do chat.
 */
export function WorkspaceMenu({
  machine,
  project,
  value,
  onChange,
  label = 'Workspace',
  side = 'top',
  children,
}: {
  machine: string
  /** O projeto da conversa (o de origem, num worktree). */
  project: string
  value?: WorkspaceTag
  onChange: (workspaceId: string | undefined) => void
  label?: string
  side?: 'top' | 'bottom'
  children: React.ReactNode
}) {
  const list = useWorkspaces((s) => s.byMachine[machine])
  useEffect(() => {
    // Servidor antigo, sem workspaces: o menu só oferece criar (e o PC avisa que precisa atualizar).
    if (!list) loadWorkspaces(machine).catch(() => {})
  }, [list, machine])
  const shown = useShown(machine, value)
  const options = projectWorkspaces(list, project)
  const main = defaultWorkspace(list, project)
  const items: WorkspaceTag[] = shown && !options.some((w) => w.id === shown.id) ? [...options, shown] : options
  const saved = shown ? list?.find((w) => w.id === shown.id) : undefined
  const open = useOpenWorkspace(machine)

  const create = () => createProjectWorkspace(machine, project).then((ws) => open(ws.id), workspaceFailed)
  const pin = (id: string, name: string) =>
    setProjectWorkspace(machine, project, id).then(() => toast.success(`${name} é o padrão de ${projectName(project)}`), workspaceFailed)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align="start" className="w-64" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={shown?.id ?? NONE} onValueChange={(v) => onChange(v === NONE ? undefined : v)}>
          <DropdownMenuRadioItem value={NONE}>Sem workspace</DropdownMenuRadioItem>
          {items.map((w) => (
            <DropdownMenuRadioItem key={w.id} value={w.id} className="gap-2">
              <WorkspaceDot color={w.color} />
              <span className="truncate">{w.name}</span>
              {w.id === main?.id && <span className="ml-auto shrink-0 text-xs text-muted-foreground">padrão</span>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {saved ? (
          <>
            {saved.projects.includes(project) && saved.id !== main?.id && (
              <DropdownMenuItem onSelect={() => void pin(saved.id, saved.name)}>
                <Pin /> Padrão do projeto
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => open(saved.id)}>
              <Settings2 /> Editar workspace
            </DropdownMenuItem>
          </>
        ) : (
          !options.length && (
            <DropdownMenuItem onSelect={() => void create()}>
              <Plus /> Criar workspace do projeto
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * O workspace na barra da caixa de mensagem, ao lado do time: a bolinha da cor e o nome. Na caixa estreita
 * (o celular, a mesa do projeto) fica só a bolinha, e o nome vai no menu.
 */
export function WorkspacePill({
  className,
  ...props
}: Omit<React.ComponentProps<typeof WorkspaceMenu>, 'children' | 'side'> & { className?: string }) {
  const shown = useShown(props.machine, props.value)
  return (
    <WorkspaceMenu {...props}>
      <button
        type="button"
        className={cn(footerButton, 'min-w-0 max-w-40', className)}
        aria-label={shown ? `Workspace: ${shown.name}` : 'Escolher um workspace'}
        title="Workspace"
      >
        {shown ? <WorkspaceDot color={shown.color} className="size-3" /> : <Layers className="size-4 shrink-0" />}
        {shown && <span className="truncate text-foreground/80 max-sm:hidden @max-[26rem]:hidden">{shown.name}</span>}
        <ChevronDown className="size-3 shrink-0 max-sm:hidden @max-[26rem]:hidden" />
      </button>
    </WorkspaceMenu>
  )
}
