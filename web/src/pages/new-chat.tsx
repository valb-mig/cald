import { ArrowLeft, ChevronDown, MessageSquarePlus } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useSearch } from 'wouter'
import { Composer } from '@/components/chat/composer'
import { DropOverlay, useFileDrop } from '@/components/chat/file-drop'
import { ProjectPanelButton } from '@/components/project/panel'
import { ProjectPicker } from '@/components/project-picker'
import { RepoLink } from '@/components/repo-link'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { attachInto } from '@/lib/compose'
import { projectName } from '@/lib/format'
import { useGitStatus, useHome } from '@/lib/hooks'
import { HOME, MachineContext, newChatUrl, noteSession, useMachines } from '@/lib/machines'
import { useShowProject } from '@/lib/project-panel'
import type { RunOptions } from '@/lib/types'
import { backHref } from '@/lib/tabs'

/**
 * A nova conversa como tela (no celular), com a máquina (`?maquina=`) e o projeto (`?cwd=`) da URL. No
 * PC ela abre como aba (ver `NewChatView` e pages/workbench.tsx), e a URL só leva até lá.
 */
export function NewChatPage() {
  const search = new URLSearchParams(useSearch())
  const machine = search.get('maquina') ?? HOME
  const cwd = search.get('cwd') ?? undefined
  const [, navigate] = useLocation()
  return (
    <NewChatView
      machine={machine}
      cwd={cwd}
      showProject
      onCreated={(sessionId) => navigate(`/s/${sessionId}`, { replace: true })}
      onPick={(dir, m) => navigate(newChatUrl(dir, m), { replace: true })}
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
  showProject: boolean
  onCreated: (sessionId: string) => void
  onPick: (cwd: string | undefined, machine: string) => void
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
  showProject,
  onCreated,
  onPick,
}: {
  machine: string
  cwd?: string
  showProject: boolean
  onCreated: (sessionId: string) => void
  onPick: (cwd: string | undefined, machine: string) => void
}) {
  const home = useHome(machine)
  // Com várias máquinas, o cabeçalho diz em qual a conversa vai rodar.
  const machineLabel = useMachines((s) => (s.machines.length > 1 ? s.machines.find((m) => m.id === machine)?.name : undefined))
  const [pending, setPending] = useState<RunOptions>({})
  const [picker, setPicker] = useState(false)
  const git = useGitStatus(machine, cwd, null)
  useShowProject(machine, cwd, `new:${cwd ?? '~'}`, showProject)
  const project = cwd ? projectName(cwd) : 'Sem projeto (~)'
  const label = machineLabel ? `${project} · ${machineLabel}` : project

  const draftId = `new:${cwd ?? '~'}`
  const drop = useFileDrop((list) => void attachInto(draftId, list))

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...drop.bind}>
      <DropOverlay show={drop.over} />
      <header className="flex shrink-0 items-center gap-1 px-2 pt-[max(0.5rem,var(--safe-top))] pb-2 compact:py-1">
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

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <MessageSquarePlus className="size-8 text-muted-foreground" />
        <p className="text-sm">
          Nova conversa em <span className="font-medium">{label}</span>
        </p>
        <p className="text-xs text-muted-foreground">
          Escolha modelo e modo na caixa abaixo. Use / para comandos e skills, @ para arquivos, # para issues e PRs e + para anexar.
        </p>
        <Button variant="outline" size="sm" onClick={() => setPicker(true)}>
          Trocar projeto
        </Button>
      </div>

      <Composer
        key={cwd ?? '~'}
        sessionId={`new:${cwd ?? '~'}`}
        cwd={cwd ?? home}
        branch={cwd ? git.status?.branch : undefined}
        working={false}
        settings={pending}
        context={null}
        onChangeSettings={(patch) => setPending((p) => ({ ...p, ...patch }))}
        onSend={async (text, attachments) => {
          const { sessionId } = await api.create(machine, { cwd, prompt: text, attachments, ...pending })
          // Antes do catálogo da máquina chegar, a conversa já sabe para onde ir.
          noteSession(sessionId, machine)
          onCreated(sessionId)
        }}
      />

      <ProjectPicker
        open={picker}
        onOpenChange={setPicker}
        machine={machine}
        onPick={onPick}
      />
    </div>
  )
}
