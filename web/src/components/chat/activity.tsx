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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ImageThumb } from '@/components/image-viewer'
import { Markdown } from '@/components/markdown'
import { imageUrl, thumbUrl } from '@/lib/api'
import { FILE_TOOLS, shortPath, toolSummary } from '@/lib/format'
import { tokenStyle, useTokens } from '@/lib/highlight'
import { cn } from '@/lib/utils'
import { useGallery } from './gallery'
import type { ActivityEntry } from './items'
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

export function ToolDetails({ use, result }: Pick<ToolEntry, 'use' | 'result'>) {
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
    default:
      return (
        <>
          <Pre>{JSON.stringify(input, null, 2)}</Pre>
          {output}
        </>
      )
  }
}

function ToolRow({ sessionId, use, result }: Pick<ToolEntry, 'use' | 'result'> & { sessionId: string }) {
  const pending = !result
  const failed = result?.isError
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
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{toolSummary(use.name, use.input)}</span>
        {counts && <LineCounts {...counts} />}
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
        <ToolDetails use={use} result={result} />
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

/** Bloco de eventos de execução, visualmente separado das mensagens. */
export function Activity({ sessionId, entries }: { sessionId: string; entries: ActivityEntry[] }) {
  const agents = useAgents()
  return (
    <div className="rounded-lg border bg-muted/30 p-1">
      {entries.map((entry) => {
        // Subagente: uma linha com o andamento; o que ele fez fica no painel dele.
        const agent = entry.kind === 'tool' && entry.inner ? agents?.tree.byId.get(entry.use.id) : undefined
        if (agent) return <AgentRow key={entry.key} node={agent} onOpen={() => agents!.open(agent.id)} />
        if (entry.kind === 'tool') return <ToolRow key={entry.key} sessionId={sessionId} use={entry.use} result={entry.result} />
        if (entry.kind === 'thinking') return <ThinkingRow key={entry.key} text={entry.text} />
        return (
          <div key={entry.key} className="mx-2 my-1 border-l-2 pl-2 text-xs text-muted-foreground">
            <span className="font-medium">subagente: </span>
            {entry.text.slice(0, 400)}
          </div>
        )
      })}
    </div>
  )
}
