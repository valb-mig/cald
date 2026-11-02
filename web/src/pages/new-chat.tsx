import { ArrowLeft, ChevronDown, MessageSquarePlus } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useSearch } from 'wouter'
import { Composer } from '@/components/chat/composer'
import { ProjectPanelButton } from '@/components/project/panel'
import { ProjectPicker } from '@/components/project-picker'
import { RepoLink } from '@/components/repo-link'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { projectName } from '@/lib/format'
import { useGitStatus, useHome, WIDE_QUERY } from '@/lib/hooks'
import { HOME, MachineContext, newChatUrl, noteSession, useMachines } from '@/lib/machines'
import { useShowProject } from '@/lib/project-panel'
import type { RunOptions } from '@/lib/types'
import { backHref } from '@/lib/tabs'
import { openTab } from '@/lib/workbench'

/** A nova conversa com a máquina escolhida (`?maquina=`) no contexto: `@`, comandos e arquivos vêm de lá. */
export function NewChatPage() {
  const machine = new URLSearchParams(useSearch()).get('maquina') ?? HOME
  return (
    <MachineContext value={machine}>
      <NewChat machine={machine} />
    </MachineContext>
  )
}

/**
 * Conversa nova direto no formato de chat: a primeira mensagem (com modelo, modo, /, @ e anexos)
 * cria a sessão e leva ao chat dela.
 */
function NewChat({ machine }: { machine: string }) {
  const cwd = new URLSearchParams(useSearch()).get('cwd') ?? undefined
  const home = useHome(machine)
  // Com várias máquinas, o cabeçalho diz em qual a conversa vai rodar.
  const machineLabel = useMachines((s) => (s.machines.length > 1 ? s.machines.find((m) => m.id === machine)?.name : undefined))
  const [, navigate] = useLocation()
  const [pending, setPending] = useState<RunOptions>({})
  const [picker, setPicker] = useState(false)
  const git = useGitStatus(machine, cwd, null)
  useShowProject(machine, cwd, `new:${cwd ?? '~'}`, true)
  const project = cwd ? projectName(cwd) : 'Sem projeto (~)'
  const label = machineLabel ? `${project} · ${machineLabel}` : project

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
          // No PC, a conversa nova já nasce aba fixa, como um arquivo novo no VSCode: o próximo clique na
          // lista não a troca. A URL só leva até ela.
          if (matchMedia(WIDE_QUERY).matches) openTab({ kind: 'chat', id: sessionId })
          navigate(`/s/${sessionId}`, { replace: true })
        }}
      />

      <ProjectPicker
        open={picker}
        onOpenChange={setPicker}
        machine={machine}
        onPick={(dir, m) => navigate(newChatUrl(dir, m), { replace: true })}
      />
    </div>
  )
}
