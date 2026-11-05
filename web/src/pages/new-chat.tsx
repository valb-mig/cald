import { ArrowLeft, ChevronDown, MessageSquarePlus } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useSearch } from 'wouter'
import { Composer } from '@/components/chat/composer'
import { TeamPill } from '@/components/teams/team-pill'
import { WorkspaceDot, WorkspacePill } from '@/components/workspaces/workspace-pill'
import { DropOverlay, useFileDrop } from '@/components/chat/file-drop'
import { ProjectPanelButton } from '@/components/project/panel'
import { ProjectPicker } from '@/components/project-picker'
import { RepoLink } from '@/components/repo-link'
import { Button } from '@/components/ui/button'
import { Veil } from '@/components/wallpaper/veil'
import { WorktreeToggle } from '@/components/worktree-toggle'
import { projectOf, useWorktreeChoice } from '@/lib/worktree'
import { api } from '@/lib/api'
import { attachInto } from '@/lib/compose'
import { projectName } from '@/lib/format'
import { useGitStatus, useHome } from '@/lib/hooks'
import { HOME, MachineContext, newChatUrl, noteSession, useMachines } from '@/lib/machines'
import { useShowProject } from '@/lib/project-panel'
import type { RunOptions } from '@/lib/types'
import { useNewChatWorkspace } from '@/lib/workspaces'
import { backHref } from '@/lib/tabs'
import { cn } from '@/lib/utils'
import { useGlass, useScrim } from '@/lib/wallpaper'

/**
 * A nova conversa como tela (no celular), com a máquina (`?maquina=`) e o projeto (`?cwd=`) da URL. No
 * PC ela abre como aba (ver `NewChatView` e pages/workbench.tsx), e a URL só leva até lá.
 */
export function NewChatPage() {
  const search = new URLSearchParams(useSearch())
  const machine = search.get('maquina') ?? HOME
  const cwd = search.get('cwd') ?? undefined
  const workspace = search.get('workspace') ?? undefined
  const [, navigate] = useLocation()
  return (
    <NewChatView
      machine={machine}
      cwd={cwd}
      workspace={workspace}
      showProject
      onCreated={(sessionId) => navigate(`/s/${sessionId}`, { replace: true })}
      onPick={(dir, m, ws) => navigate(newChatUrl(dir, m, ws), { replace: true })}
    />
  )
}

/**
 * Conversa nova direto no formato de chat: a primeira mensagem (com modelo, modo, /, @ e anexos)
 * cria a sessão, e quem mostra decide para onde ir (`onCreated`). Com a máquina no contexto: `@`,
 * comandos e arquivos vêm de lá. `showProject`: a barra do projeto mostra o dele (a aba só quando à vista).
 */
export function NewChatView(props: {
  machine: string
  cwd?: string
  /** O workspace já escolhido (vindo da página dele); sem ele, vale o padrão do projeto. */
  workspace?: string
  showProject: boolean
  onCreated: (sessionId: string) => void
  /** Trocar o projeto leva junto o workspace escolhido, que fica se também tiver o novo. */
  onPick: (cwd: string | undefined, machine: string, workspace?: string) => void
}) {
  return (
    <MachineContext value={props.machine}>
      <NewChat {...props} />
    </MachineContext>
  )
}

function NewChat({
  machine,
  cwd,
  workspace,
  showProject,
  onCreated,
  onPick,
}: {
  machine: string
  cwd?: string
  workspace?: string
  showProject: boolean
  onCreated: (sessionId: string) => void
  onPick: (cwd: string | undefined, machine: string, workspace?: string) => void
}) {
  const home = useHome(machine)
  // Com várias máquinas, o cabeçalho diz em qual a conversa vai rodar.
  const machineLabel = useMachines((s) => (s.machines.length > 1 ? s.machines.find((m) => m.id === machine)?.name : undefined))
  const [pending, setPending] = useState<RunOptions>({})
  // O projeto de um worktree é o de origem: os workspaces são dele. Sem projeto, sem workspace.
  const project = cwd && cwd !== home ? projectOf(cwd) : undefined
  // O workspace vem no padrão do projeto, e o time no do workspace (os dois dá para trocar na caixa).
  const { workspace: ws, choose, teamId, setTeamId } = useNewChatWorkspace(machine, project, workspace)
  const [picker, setPicker] = useState(false)
  const git = useGitStatus(machine, cwd, null)
  const worktree = useWorktreeChoice(machine, cwd, git.status)
  const [creating, setCreating] = useState(false)
  const glass = useGlass()
  const scrim = useScrim()
  useShowProject(machine, cwd, `new:${cwd ?? '~'}`, showProject)
  const where = cwd ? projectName(cwd) : 'Sem projeto (~)'
  const label = machineLabel ? `${where} · ${machineLabel}` : where

  const draftId = `new:${cwd ?? '~'}`
  const drop = useFileDrop((list) => void attachInto(draftId, list))

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...drop.bind}>
      <DropOverlay show={drop.over} />
      {/* Como no chat: o cabeçalho em vidro e o resto sob o véu, senão a cena aparecia crua atrás do texto. */}
      <header
        className={cn(
          'flex shrink-0 items-center gap-1 px-2 pt-[max(0.5rem,var(--safe-top))] pb-2 compact:py-1',
          glass && 'relative z-10 bg-background/70 backdrop-blur-md',
        )}
      >
        {/* No PC a lista de conversas já está ao lado. */}
        <Button variant="ghost" size="icon" asChild aria-label="Voltar" className="wide:hidden">
          <Link href={backHref()}>
            <ArrowLeft />
          </Link>
        </Button>
        <button type="button" onClick={() => setPicker(true)} className="min-w-0 flex-1 text-left">
          <div className="text-sm font-medium">Nova conversa</div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="truncate">{label}</span>
            <ChevronDown className="size-3 shrink-0" />
          </div>
        </button>
        {cwd && git.status?.remote && <RepoLink url={git.status.remote} />}
        {cwd && <ProjectPanelButton changes={git.status?.files.length ?? 0} />}
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {scrim !== null && <Veil dim={scrim} />}
        {/* Posicionado para ficar por cima do véu, que é absoluto. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
            <MessageSquarePlus className="size-8 text-muted-foreground" />
            <p className="text-sm">
              Nova conversa em <span className="font-medium">{label}</span>
            </p>
            {/* O workspace escolhido na caixa, por extenso: no celular a caixa só mostra a bolinha. */}
            {ws && (
              <p className="-mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <WorkspaceDot color={ws.color} />
                {ws.name}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Escolha modelo e modo na caixa abaixo. Use / para comandos e skills, @ para arquivos, # para issues e PRs e + para anexar.
            </p>
            <Button variant="outline" size="sm" onClick={() => setPicker(true)}>
              Trocar projeto
            </Button>
          </div>

          {cwd && (
            <div className="mx-auto w-full max-w-3xl px-2 wide:px-4">
              <WorktreeToggle choice={worktree} cwd={cwd} creating={creating} />
            </div>
          )}

          <Composer
            key={cwd ?? '~'}
            sessionId={`new:${cwd ?? '~'}`}
            cwd={cwd ?? home}
            branch={cwd ? git.status?.branch : undefined}
            working={false}
            settings={pending}
            context={null}
            onChangeSettings={(patch) => setPending((p) => ({ ...p, ...patch }))}
            extra={
              <>
                {project && <WorkspacePill machine={machine} project={project} value={ws} onChange={choose} />}
                <TeamPill machine={machine} value={teamId} onChange={setTeamId} />
              </>
            }
            onSend={async (text, attachments) => {
              setCreating(worktree.on)
              try {
                const { sessionId } = await api.create(machine, {
                  cwd,
                  prompt: text,
                  attachments,
                  teamId,
                  workspaceId: ws?.id,
                  worktree: worktree.on || undefined,
                  ...pending,
                })
                // Antes do catálogo da máquina chegar, a conversa já sabe para onde ir.
                noteSession(sessionId, machine)
                onCreated(sessionId)
              } finally {
                setCreating(false)
              }
            }}
          />
        </div>
      </div>

      <ProjectPicker
        open={picker}
        onOpenChange={setPicker}
        machine={machine}
        onPick={(dir, m) => onPick(dir, m, ws?.id)}
      />
    </div>
  )
}
