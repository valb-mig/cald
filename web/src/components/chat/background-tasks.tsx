import { ChevronRight, CircleStop, Hourglass, Radar, SquareTerminal, Workflow, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNow } from '@/components/agents/status'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { api, errorMessage } from '@/lib/api'
import { duration } from '@/lib/format'
import type { BackgroundTask, PanelEvent } from '@/lib/types'

type ToolUse = Extract<PanelEvent, { kind: 'tool_use' }>

/** Subagente em segundo plano: aparece no trilho de agentes, ao lado do chat, e não aqui. */
const isAgent = (task: BackgroundTask, use?: ToolUse) => use?.name === 'Agent' || use?.name === 'Task' || task.type === 'local_agent'

/** Tipo da tarefa como a pessoa reconhece, pela ferramenta que a criou. */
function kindOf(task: BackgroundTask, use?: ToolUse): { label: string; icon: LucideIcon } {
  if (use?.name === 'Monitor') return { label: 'Monitor', icon: Radar }
  if (task.type === 'local_workflow') return { label: 'Workflow', icon: Workflow }
  if (task.type === 'local_bash') return { label: 'Comando', icon: SquareTerminal }
  return { label: task.type, icon: Hourglass }
}

/** Fim da saída do comando ou monitor, relido a cada 2,5 s enquanto aberto. */
function Output({ sessionId, taskId }: { sessionId: string; taskId: string }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pre = useRef<HTMLPreElement>(null)
  useEffect(() => {
    let alive = true
    const load = () =>
      api.taskOutput(sessionId, taskId).then(
        (r) => {
          if (!alive) return
          setText(r.output)
          setError(null)
        },
        (err) => alive && setError(errorMessage(err)),
      )
    void load()
    const timer = setInterval(load, 2_500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [sessionId, taskId])
  // Sempre no fim, como um terminal.
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [text])
  if (error) return <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
  return (
    <pre
      ref={pre}
      className="max-h-56 overflow-auto rounded border bg-background/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-muted-foreground"
    >
      {text === null ? 'Lendo a saída…' : text.trim() || 'Nada escrito ainda.'}
    </pre>
  )
}

function TaskRow({
  sessionId,
  task,
  use,
  now,
  actionable,
  onStop,
}: {
  sessionId: string
  task: BackgroundTask
  use?: ToolUse
  now: number
  actionable: boolean
  onStop: () => void
}) {
  const [open, setOpen] = useState(false)
  const { label, icon: Icon } = kindOf(task, use)
  const command = typeof use?.input.command === 'string' ? use.input.command : ''
  // Saída só de comandos e monitores (o Claude Code não guarda a de workflows assim).
  const hasOutput = task.type === 'local_bash'
  return (
    <li className="space-y-1.5 py-2 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-sky-700 dark:text-sky-300" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-xs font-medium text-sky-700 dark:text-sky-300">{label}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{task.description}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums" title="Há quanto tempo roda">
              {duration(Math.max(0, now - task.startedAt))}
            </span>
          </div>
          {command && command !== task.description && (
            <div className="truncate font-mono text-[11px] text-muted-foreground" title={command}>
              {command}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 pl-6">
        {hasOutput && (
          <Button variant="outline" size="xs" onClick={() => setOpen(!open)} aria-expanded={open}>
            <ChevronRight className={open ? 'rotate-90 transition-transform' : 'transition-transform'} />
            {open ? 'Esconder saída' : 'Ver saída'}
          </Button>
        )}
        {actionable && (
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onStop}>
            <CircleStop /> Parar
          </Button>
        )}
      </div>
      {open && hasOutput && (
        <div className="pl-6">
          <Output sessionId={sessionId} taskId={task.taskId} />
        </div>
      )}
    </li>
  )
}

/**
 * A confirmação de parar uma tarefa em segundo plano: encerrada no PC, o Claude recebe o aviso. Serve
 * ao cartão daqui e à conversa de um subagente em segundo plano (ver agents/agent-chat.tsx).
 */
export function StopTaskDialog({
  sessionId,
  task,
  open,
  onOpenChange,
}: {
  sessionId: string
  task: BackgroundTask | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  async function stop(task: BackgroundTask) {
    try {
      await api.stopTask(sessionId, task.taskId)
      toast.success('Tarefa parada', { description: 'O Claude recebe o aviso e pode continuar a partir daí.' })
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="line-clamp-3 break-words">Parar “{task?.description}”?</AlertDialogTitle>
          <AlertDialogDescription>A tarefa é encerrada no PC, e o Claude recebe o aviso de que ela foi parada.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Deixar rodando</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => task && void stop(task)}>
            Parar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * O que o Claude deixou rodando em segundo plano: monitores, comandos, workflows. O turno acabou, mas
 * ele não terminou: volta sozinho quando cada um termina (num monitor, a cada novidade). Os
 * subagentes ficam de fora: eles têm o trilho de agentes, ao lado do chat.
 */
export function BackgroundTasks({
  sessionId,
  tasks,
  uses,
  actionable,
}: {
  sessionId: string
  tasks: BackgroundTask[]
  /** Chamadas de ferramenta da conversa, para achar o comando e o tipo de cada tarefa. */
  uses: Map<string, ToolUse>
  /** Parar só com a conversa aberta no painel. */
  actionable: boolean
}) {
  const callOf = (task: BackgroundTask) => (task.toolUseId ? uses.get(task.toolUseId) : undefined)
  const shown = tasks.filter((t) => !isAgent(t, callOf(t)))
  const now = useNow(shown.length > 0)
  const [stopping, setStopping] = useState<BackgroundTask | null>(null)
  const [confirm, setConfirm] = useState(false)
  if (!shown.length) return null
  const monitors = shown.some((t) => callOf(t)?.name === 'Monitor')

  return (
    <section className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2.5" aria-label="Em segundo plano">
      <div className="mb-2 space-y-0.5">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Hourglass className="size-4 text-sky-700 dark:text-sky-300" />
          Em segundo plano
        </h3>
        <p className="text-xs text-muted-foreground">
          O Claude deixou {shown.length === 1 ? 'isto rodando' : `${shown.length} coisas rodando`}. Ele
          volta sozinho quando {shown.length === 1 ? 'terminar' : 'cada uma terminar'}
          {monitors ? ' e, num monitor, a cada novidade que aparecer' : ''}; você pode mandar mensagem enquanto isso.
        </p>
      </div>
      <ul className="divide-y divide-sky-500/15">
        {shown.map((task) => (
          <TaskRow
            key={task.taskId}
            sessionId={sessionId}
            task={task}
            use={callOf(task)}
            now={now}
            actionable={actionable}
            onStop={() => {
              setStopping(task)
              setConfirm(true)
            }}
          />
        ))}
      </ul>

      <StopTaskDialog sessionId={sessionId} task={stopping} open={confirm} onOpenChange={setConfirm} />
    </section>
  )
}
