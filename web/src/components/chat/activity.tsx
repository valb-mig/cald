import {
  Bot,
  Brain,
  ChevronRight,
  ClipboardList,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  ListTodo,
  Loader2,
  MessageCircleQuestion,
  Plug,
  Radar,
  Search,
  Sparkles,
  SquareTerminal,
  TextSearch,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { createElement, Fragment } from 'react'
import { AgentRow } from '@/components/agents/agent-row'
import { useAgents } from '@/components/agents/model'
import { useNow } from '@/components/agents/status'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ImageThumb } from '@/components/image-viewer'
import { Markdown } from '@/components/markdown'
import { imageUrl, thumbUrl } from '@/lib/api'
import { duration, FILE_TOOLS, shortPath, toolSummary } from '@/lib/format'
import { tokenStyle, useTokens } from '@/lib/highlight'
import { cn } from '@/lib/utils'
import { Arrival, useArrivals } from './arrival'
import { useGallery } from './gallery'
import type { ActivityEntry } from './items'
import { QuestionAnswers } from './question-card'
import { askOf, RECOMMENDED, type Ask } from './questions'
import { lineCounts } from './turn'

const ICONS: Record<string, LucideIcon> = {
  Bash: SquareTerminal,
  Read: FileText,
  Edit: FilePen,
  MultiEdit: FilePen,
  NotebookEdit: FilePen,
  Write: FilePlus,
  Grep: TextSearch,
  Glob: FolderSearch,
  WebFetch: Globe,
  WebSearch: Search,
  Agent: Bot,
  Task: Bot,
  TodoWrite: ListTodo,
  Skill: Sparkles,
  Monitor: Radar,
  ToolSearch: Search,
  ExitPlanMode: ClipboardList,
  AskUserQuestion: MessageCircleQuestion,
}

export function toolIcon(name: string): LucideIcon {
  return ICONS[name] ?? (name.startsWith('mcp__') ? Plug : Wrench)
}

const PRE = 'max-h-72 overflow-auto rounded border bg-background/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all'

function Pre({ children, tone }: { children: string; tone?: 'add' | 'del' | 'error' }) {
  return (
    <pre
      className={cn(
        PRE,
        tone === 'add' && 'border-emerald-500/30 bg-emerald-500/10',
        tone === 'del' && 'border-red-500/30 bg-red-500/10',
        tone === 'error' && 'border-red-500/30 text-red-700 dark:text-red-300',
      )}
    >
      {children}
    </pre>
  )
}

/**
 * Um comando do terminal com as cores de sintaxe do shell (as do VSCode, ver lib/highlight.ts);
 * enquanto elas carregam, ou sem rede, o texto puro.
 */
export function ShellCommand({ command, className }: { command: string; className?: string }) {
  const lines = useTokens(command, 'comando.sh')
  return (
    <pre className={cn(PRE, className)}>
      <span className="text-muted-foreground select-none">$ </span>
      {lines
        ? lines.map((line, i) => (
            <Fragment key={i}>
              {i > 0 && '\n'}
              {line.map((t, j) => (
                <span key={j} style={tokenStyle(t)}>
                  {t.content}
                </span>
              ))}
            </Fragment>
          ))
        : command}
    </pre>
  )
}

/** Linhas colocadas (verde) e tiradas (vermelho), como no diff; a parte que é zero não aparece. */
export function LineCounts({ added, removed, className }: { added: number; removed: number; className?: string }) {
  if (!added && !removed) return null
  return (
    <span className={cn('shrink-0 font-mono text-[11px] tabular-nums', className)}>
      {added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="text-red-600 dark:text-red-400">−{removed}</span>}
    </span>
  )
}

type ToolEntry = Extract<ActivityEntry, { kind: 'tool' }>
const s = (v: unknown) => (typeof v === 'string' ? v : '')

export function ToolDetails({ use, result, answer }: Pick<ToolEntry, 'use' | 'result' | 'answer'>) {
  const input = use.input
  const output = result && (result.text ? <Pre tone={result.isError ? 'error' : undefined}>{result.text}</Pre> : null)

  switch (use.name) {
    case 'Bash':
      return (
        <>
          <ShellCommand command={s(input.command)} />
          {output}
        </>
      )
    case 'Edit':
      return (
        <>
          <div className="font-mono text-[11px] text-muted-foreground">{shortPath(s(input.file_path))}</div>
          {s(input.old_string) && <Pre tone="del">{s(input.old_string)}</Pre>}
          <Pre tone="add">{s(input.new_string)}</Pre>
          {result?.isError && output}
        </>
      )
    case 'MultiEdit':
      return (
        <>
          <div className="font-mono text-[11px] text-muted-foreground">{shortPath(s(input.file_path))}</div>
          {(Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []).map((e, i) => (
            <div key={i} className="space-y-1">
              {s(e.old_string) && <Pre tone="del">{s(e.old_string)}</Pre>}
              <Pre tone="add">{s(e.new_string)}</Pre>
            </div>
          ))}
          {result?.isError && output}
        </>
      )
    case 'Write':
      return (
        <>
          <div className="font-mono text-[11px] text-muted-foreground">{shortPath(s(input.file_path))}</div>
          <Pre tone="add">{s(input.content)}</Pre>
          {result?.isError && output}
        </>
      )
    case 'ExitPlanMode':
      return <Markdown text={s(input.plan)} className="rounded border bg-background/60 p-2" />
    case 'AskUserQuestion': {
      const ask = askOf(input, result, answer)
      if (!ask.questions.length) break
      return (
        <>
          <QuestionAnswers {...ask} />
          {/* Resposta que não deu para recortar, ou erro: o texto do resultado, como veio. */}
          {!ask.answers && !ask.note && output}
        </>
      )
    }
  }
  return (
    <>
      <Pre>{JSON.stringify(input, null, 2)}</Pre>
      {output}
    </>
  )
}

/** O resumo da AskUserQuestion respondida: o rótulo de cada pergunta e a resposta, em destaque. */
function AskSummary({ questions, answers }: Ask) {
  return questions
    .filter((q) => answers?.[q.question])
    .map((q, i) => (
      <Fragment key={q.question}>
        {i > 0 && ' · '}
        {q.header || q.question} → <span className="font-medium text-foreground">{answers![q.question]!.replace(RECOMMENDED, '')}</span>
      </Fragment>
    ))
}

/** Quanto uma ferramenta levou: com décimo abaixo de 10 s, que é onde quase todas terminam. */
function took(ms: number): string {
  if (ms >= 10_000) return duration(ms)
  return `${(Math.max(0, ms) / 1000).toFixed(1).replace('.', ',')}s`
}

/** Quanto levou ou, rodando agora, há quanto tempo roda; vazio se não se sabe. */
function useTook({ result, at, started, finished }: Pick<ToolEntry, 'result' | 'at' | 'started' | 'finished'>): string {
  // Só o que chegou ao vivo conta o tempo correndo: sem resultado no histórico, ela foi interrompida.
  const now = useNow(!result && Boolean(at))
  if (result) return started && finished ? took(finished - started) : ''
  return at ? took(now - at) : ''
}

function ToolRow({
  sessionId,
  use,
  result,
  answer,
  at,
  started,
  finished,
}: Pick<ToolEntry, 'use' | 'result' | 'answer' | 'at' | 'started' | 'finished'> & { sessionId: string }) {
  const pending = !result
  const time = useTook({ result, at, started, finished })
  // Pergunta que você recusou volta como erro, mas não é falha: a linha diz o que houve, sem o X.
  const ask = use.name === 'AskUserQuestion' ? askOf(use.input, result, answer) : undefined
  const failed = result?.isError && !ask?.note
  const name = use.name.startsWith('mcp__') ? use.name.split('__').slice(1).join(' · ') : use.name
  const { claude } = useGallery()
  // Edição que deu certo: quantas linhas entraram e saíram, como no diff.
  const counts = FILE_TOOLS.has(use.name) && result && !failed ? lineCounts(use) : null
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60">
        {createElement(toolIcon(use.name), {
          className: cn('size-4 shrink-0 text-muted-foreground', failed && 'text-red-600 dark:text-red-400'),
        })}
        <span className="shrink-0 font-medium">{name}</span>
        {/* Pergunta respondida (ou recusada): no lugar das perguntas, o que houve com elas. */}
        {ask?.answers || ask?.note ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{ask.answers ? <AskSummary {...ask} /> : ask.note}</span>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{toolSummary(use.name, use.input)}</span>
        )}
        {counts && <LineCounts {...counts} />}
        {time && <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{time}</span>}
        {pending && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
        {failed && <XCircle className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />}
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      {/* Imagens devolvidas (prints, arquivos lidos) ficam à vista, sem precisar expandir. */}
      {result?.images && result.images.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto px-2 pb-1.5">
          {result.images.map((key) => (
            <ImageThumb key={key} src={imageUrl(sessionId, key)} thumb={thumbUrl(sessionId, key)} gallery={claude} from="Claude" className="h-24 max-w-44" />
          ))}
        </div>
      )}
      <CollapsibleContent className="space-y-1.5 px-2 pt-1 pb-2">
        <ToolDetails use={use} result={result} answer={answer} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function ThinkingRow({ text }: { text: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/60">
        <Brain className="size-4 shrink-0" />
        <span className="flex-1">Raciocínio</span>
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2 pt-1 pb-2">
        <p className="text-xs whitespace-pre-wrap text-muted-foreground">{text}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Bloco de eventos de execução, visualmente separado das mensagens. `summary` (o chat): o bloco vira
 * uma linha só, que abre ao tocar, para os passos não ocuparem a conversa entre um texto e outro. Os
 * subagentes ficam à vista embaixo dela: o andamento deles é assunto, não passo.
 */
export function Activity({ sessionId, entries, summary = false }: { sessionId: string; entries: ActivityEntry[]; summary?: boolean }) {
  const agents = useAgents()
  // Cada ferramenta nova do turno entra animada; as que já estavam quando o bloco apareceu, não.
  const isFresh = useArrivals(sessionId, entries.map((e) => e.key))
  const isAgent = (e: ActivityEntry) => e.kind === 'tool' && Boolean(e.inner && agents?.tree.byId.get(e.use.id))
  const steps = summary ? entries.filter((e) => !isAgent(e)) : entries
  const list = (shown: ActivityEntry[]) => (
    <div className="rounded-lg border bg-muted/30 p-1">
      {shown.map((entry) => (
        <Arrival key={entry.key} fresh={isFresh(entry.key)}>
          <EntryRow sessionId={sessionId} entry={entry} agents={agents} />
        </Arrival>
      ))}
    </div>
  )
  if (!summary) return list(entries)
  const others = entries.filter(isAgent)
  return (
    <div className="space-y-1">
      {/* Um passo só já é uma linha: o resumo dele não economizaria nada. */}
      {steps.length === 1 ? (
        <EntryRow sessionId={sessionId} entry={steps[0]!} agents={agents} />
      ) : (
        steps.length > 1 && (
          <Collapsible>
            <StepsSummary sessionId={sessionId} steps={steps} />
            <CollapsibleContent className="pt-1">{list(steps)}</CollapsibleContent>
          </Collapsible>
        )
      )}
      {others.map((entry) => (
        <Arrival key={entry.key} fresh={isFresh(entry.key)}>
          <EntryRow sessionId={sessionId} entry={entry} agents={agents} />
        </Arrival>
      ))}
    </div>
  )
}

/**
 * "▸ 5 ferramentas · 2 raciocínios · +12 −3 · 8,4s   Bash  pnpm build": quantos passos, o que mudou
 * nos arquivos, quanto levou do primeiro ao último e, na ponta, o passo rodando agora ou o último.
 * As imagens devolvidas (prints, arquivos lidos) continuam à vista, como na linha aberta.
 */
function StepsSummary({ sessionId, steps }: { sessionId: string; steps: ActivityEntry[] }) {
  const { claude } = useGallery()
  const tools = steps.filter((e): e is ToolEntry => e.kind === 'tool')
  const thoughts = steps.filter((e) => e.kind === 'thinking').length
  const running = tools.find((t) => !t.result)
  const failed = tools.filter((t) => t.result?.isError).length
  const shown = running ?? tools.at(-1)
  const edits = tools
    .filter((t) => FILE_TOOLS.has(t.use.name) && t.result && !t.result.isError)
    .reduce((n, t) => {
      const c = lineCounts(t.use)
      return { added: n.added + c.added, removed: n.removed + c.removed }
    }, { added: 0, removed: 0 })
  // Do primeiro passo ao último resultado; rodando ao vivo, até agora.
  const now = useNow(Boolean(running?.at))
  const first = tools.find((t) => t.started)?.started
  const last = running ? (running.at ? now : undefined) : Math.max(0, ...tools.map((t) => t.finished ?? 0)) || undefined
  const time = first && last ? took(last - first) : ''
  const images = tools.flatMap((t) => t.result?.images ?? [])
  const name = shown && (shown.use.name.startsWith('mcp__') ? shown.use.name.split('__').slice(1).join(' · ') : shown.use.name)
  return (
    <>
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/60">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        {running ? (
          <Loader2 className="size-4 shrink-0 animate-spin" />
        ) : (
          shown && createElement(toolIcon(shown.use.name), { className: 'size-4 shrink-0' })
        )}
        <span className="shrink-0">
          {[tools.length > 0 && plural(tools.length, 'ferramenta', 'ferramentas'), thoughts > 0 && plural(thoughts, 'raciocínio', 'raciocínios')]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {failed > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-red-600 dark:text-red-400">
            <XCircle className="size-3.5" />
            {failed}
          </span>
        )}
        {(edits.added > 0 || edits.removed > 0) && <LineCounts {...edits} />}
        {time && <span className="shrink-0 font-mono text-[11px] tabular-nums">{time}</span>}
        {shown && (
          // O que está rodando (ou foi o último): some quando o bloco abre, porque a lista já mostra.
          <span className="min-w-0 flex-1 truncate text-xs group-data-[state=open]:invisible">
            <span className="font-medium text-foreground/80">{name}</span>{' '}
            <span className="font-mono">{toolSummary(shown.use.name, shown.use.input)}</span>
          </span>
        )}
      </CollapsibleTrigger>
      {images.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto px-2 pb-1.5">
          {images.map((key) => (
            <ImageThumb key={key} src={imageUrl(sessionId, key)} thumb={thumbUrl(sessionId, key)} gallery={claude} from="Claude" className="h-24 max-w-44" />
          ))}
        </div>
      )}
    </>
  )
}

function EntryRow({ sessionId, entry, agents }: { sessionId: string; entry: ActivityEntry; agents: ReturnType<typeof useAgents> }) {
  // Subagente: uma linha com o andamento; o que ele fez fica no painel dele.
  const agent = entry.kind === 'tool' && entry.inner ? agents?.tree.byId.get(entry.use.id) : undefined
  if (agent) return <AgentRow node={agent} onOpen={() => agents!.open(agent.id)} />
  if (entry.kind === 'tool') {
    const { use, result, answer, at, started, finished } = entry
    return <ToolRow sessionId={sessionId} use={use} result={result} answer={answer} at={at} started={started} finished={finished} />
  }
  if (entry.kind === 'thinking') return <ThinkingRow text={entry.text} />
  return (
    <div className="mx-2 my-1 border-l-2 pl-2 text-xs text-muted-foreground">
      <span className="font-medium">subagente: </span>
      {entry.text.slice(0, 400)}
    </div>
  )
}
