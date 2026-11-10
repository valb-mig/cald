import {
  AppWindow,
  Bot,
  Brain,
  ChevronRight,
  ClipboardList,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Lightbulb,
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
import { CopyButton, Markdown } from '@/components/markdown'
import { ArtefatoCard } from '@/components/artefatos/artefato-card'
import { PrototypeCard } from '@/components/prototype/prototype-card'
import { Button } from '@/components/ui/button'
import { imageUrl, thumbUrl } from '@/lib/api'
import { ArtefatoIcon, isPublishTool, publishedArtefato, type Publicacao } from '@/lib/artefatos'
import { FILE_TOOLS, shortPath, toolSummary, took } from '@/lib/format'
import { tokenStyle, useTokens } from '@/lib/highlight'
import { isMemoryHeld, isMemorySuggested, openMemorySuggestions, useMemorySuggestions } from '@/lib/memory-suggestions'
import { publishedPage, type PublishedPage } from '@/lib/prototype'
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
  Artifact: AppWindow,
}

export function toolIcon(name: string): LucideIcon {
  // As do MCP do edit.r com artefatos (publicar e listar) levam o ícone deles.
  if (isPublishTool(name) || (name.startsWith('mcp__') && name.endsWith('__listar_artefatos'))) return ArtefatoIcon
  return ICONS[name] ?? (name.startsWith('mcp__') ? Plug : Wrench)
}

// A seta das linhas que abrem: na ponta direita, só com o mouse em cima (ou o foco, ou aberta, para fechar).
const CHEVRON = 'size-3.5 shrink-0 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100'

/** O ícone já diz qual é a ferramenta (o terminal é o Bash, o lápis é a edição): o nome dela pode sair da linha. */
const iconSays = (name: string) => ![Plug, Wrench].includes(toolIcon(name))

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
 * enquanto elas carregam, ou sem rede, o texto puro. O copiar no canto leva o comando sem o `$ `.
 */
export function ShellCommand({ command, className }: { command: string; className?: string }) {
  const lines = useTokens(command, 'comando.sh')
  return (
    <div className="relative">
      <pre className={cn(PRE, 'pr-8', className)}>
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
      <CopyButton text={command} label="Copiar o comando" className="absolute top-1 right-1 text-muted-foreground" />
    </div>
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
  published,
}: Pick<ToolEntry, 'use' | 'result' | 'answer' | 'at' | 'started' | 'finished'> & { sessionId: string; published?: Published }) {
  const pending = !result
  const time = useTook({ result, at, started, finished })
  // Pergunta que você recusou volta como erro, mas não é falha: a linha diz o que houve, sem o X.
  const ask = use.name === 'AskUserQuestion' ? askOf(use.input, result, answer) : undefined
  // Memória que virou sugestão, ou a linha dela no índice (ver lib/memory-suggestions.ts): negada de propósito, não falhou.
  const suggested = isMemorySuggested(result)
  const held = isMemoryHeld(result)
  const failed = result?.isError && !ask?.note && !held
  const name = use.name.startsWith('mcp__') ? use.name.split('__').slice(1).join(' · ') : use.name
  const { claude } = useGallery()
  // Edição que deu certo: quantas linhas entraram e saíram, como no diff.
  const counts = FILE_TOOLS.has(use.name) && result && !failed && !held ? lineCounts(use) : null
  // A sugestão ainda espera você? Já salva ou recusada, a lista não tem mais o que mostrar dela.
  const waiting = useMemorySuggestions((st) => suggested && (st.bySession[sessionId]?.some((x) => x.file === memoryFile(use.input)) ?? true))
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60">
        {createElement(suggested ? Lightbulb : toolIcon(use.name), {
          className: cn('size-4 shrink-0 text-muted-foreground', failed && 'text-red-600 dark:text-red-400'),
        })}
        {suggested || !iconSays(use.name) ? (
          <span className="shrink-0 font-medium">{suggested ? 'Sugeriu uma memória' : name}</span>
        ) : (
          <span className="sr-only">{name}</span>
        )}
        {/* Pergunta respondida (ou recusada): no lugar das perguntas, o que houve com elas. */}
        {suggested ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{memoryName(use.input)}</span>
        ) : ask?.answers || ask?.note ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{ask.answers ? <AskSummary {...ask} /> : ask.note}</span>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{toolSummary(use.name, use.input)}</span>
        )}
        {counts && <LineCounts {...counts} />}
        {time && <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{time}</span>}
        {pending && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
        {failed && <XCircle className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />}
        <ChevronRight className={cn(CHEVRON, 'text-muted-foreground')} />
      </CollapsibleTrigger>
      {/* Imagens devolvidas (prints, arquivos lidos) ficam à vista, sem precisar expandir. */}
      {result?.images && result.images.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto px-2 pb-1.5">
          {result.images.map((key) => (
            <ImageThumb key={key} src={imageUrl(sessionId, key)} thumb={thumbUrl(sessionId, key)} gallery={claude} from="Claude" className="h-24 max-w-44" />
          ))}
        </div>
      )}
      {/* A página publicada pela Artifact (ou o artefato do edit.r) também: o abrir fica à mão. */}
      {published && (
        <div className="px-2 pb-1.5">
          <PublishedCard sessionId={sessionId} published={published} />
        </div>
      )}
      <CollapsibleContent className="space-y-1.5 px-2 pt-1 pb-2">
        {suggested ? (
          <>
            {/* O que ela ia gravar, sem o recado ao Claude, e o caminho para decidir. */}
            <ToolDetails use={use} />
            {waiting && (
              <Button variant="ghost" size="xs" onClick={() => openMemorySuggestions(sessionId)}>
                <Lightbulb /> Ver sugestões
              </Button>
            )}
          </>
        ) : held ? (
          <>
            <ToolDetails use={use} />
            <p className="text-xs text-muted-foreground">A linha entra no índice quando a sugestão for salva.</p>
          </>
        ) : (
          <ToolDetails use={use} result={result} answer={answer} />
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

// O arquivo da memória, e ele sem o .md, que é o nome dela.
const memoryFile = (input: Record<string, unknown>) => s(input.file_path).split('/').pop() ?? ''
const memoryName = (input: Record<string, unknown>) => memoryFile(input).replace(/\.md$/, '')

function ThinkingRow({ text }: { text: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/60">
        <Brain className="size-4 shrink-0" />
        <span className="flex-1">Raciocínio</span>
        <ChevronRight className={CHEVRON} />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2 pt-1 pb-2">
        <p className="text-xs whitespace-pre-wrap text-muted-foreground">{text}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** O que uma ferramenta publicou: a página no claude.ai (a Artifact) ou um artefato do edit.r (`publicar_artefato`). */
type Published = { kind: 'page'; page: PublishedPage } | { kind: 'artefato'; pub: Publicacao }

const publishedKey = (p: Published) => (p.kind === 'page' ? `p:${p.page.path}` : `a:${p.pub.id}`)

function PublishedCard({ sessionId, published: p }: { sessionId: string; published: Published }) {
  return p.kind === 'page' ? <PrototypeCard sessionId={sessionId} page={p.page} /> : <ArtefatoCard sessionId={sessionId} pub={p.pub} />
}

/**
 * O que foi publicado no bloco, pela chave da entrada: uma página por arquivo e um artefato por id, o da
 * última publicação (a que está no claude.ai agora, ou a versão mais nova do artefato).
 */
function publishedIn(entries: ActivityEntry[]): Map<string, Published> {
  const byWhat = new Map<string, { key: string; published: Published }>()
  for (const e of entries) {
    if (e.kind !== 'tool') continue
    const page = publishedPage(e.use.name, e.use.input, e.result)
    const pub = page ? null : publishedArtefato(e.use.name, e.use.input, e.result)
    const published: Published | null = page ? { kind: 'page', page } : pub ? { kind: 'artefato', pub } : null
    if (!published) continue
    const what = publishedKey(published)
    byWhat.delete(what)
    byWhat.set(what, { key: e.key, published })
  }
  return new Map([...byWhat.values()].map(({ key, published }) => [key, published]))
}

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
  const pages = publishedIn(steps)
  // `cards`: as páginas vão na linha de quem as publicou; no bloco resumido, já estão debaixo do resumo.
  const list = (shown: ActivityEntry[], cards: boolean) => (
    <div className="rounded-lg border bg-muted/30 p-1">
      {shown.map((entry) => (
        <Arrival key={entry.key} fresh={isFresh(entry.key)}>
          <EntryRow sessionId={sessionId} entry={entry} agents={agents} published={cards ? pages.get(entry.key) : undefined} />
        </Arrival>
      ))}
    </div>
  )
  if (!summary) return list(entries, true)
  const others = entries.filter(isAgent)
  return (
    <div className="space-y-1">
      {/* Um passo só já é uma linha: o resumo dele não economizaria nada. */}
      {steps.length === 1 ? (
        <EntryRow sessionId={sessionId} entry={steps[0]!} agents={agents} published={pages.get(steps[0]!.key)} />
      ) : (
        steps.length > 1 && (
          <Collapsible>
            <StepsSummary sessionId={sessionId} steps={steps} pages={[...pages.values()]} />
            <CollapsibleContent className="pt-1">{list(steps, false)}</CollapsibleContent>
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
 * As imagens devolvidas (prints, arquivos lidos) e as páginas publicadas continuam à vista, como na linha aberta.
 */
function StepsSummary({ sessionId, steps, pages }: { sessionId: string; steps: ActivityEntry[]; pages: Published[] }) {
  const { claude } = useGallery()
  const tools = steps.filter((e): e is ToolEntry => e.kind === 'tool')
  const thoughts = steps.filter((e) => e.kind === 'thinking').length
  const running = tools.find((t) => !t.result)
  const failed = tools.filter((t) => t.result?.isError && !isMemoryHeld(t.result)).length
  // A linha do índice segurada vem logo depois da memória sugerida: na ponta, a sugestão, que é o que importa.
  const end = tools.at(-1)
  const shown = running ?? (end && isMemoryHeld(end.result) ? (tools.findLast((t) => isMemorySuggested(t.result)) ?? end) : end)
  const suggested = isMemorySuggested(shown?.result)
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
      {/* Um tom abaixo do resto, para os passos não disputarem com a resposta; o mouse em cima traz o tom de volta. */}
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-muted-foreground">
        {running ? (
          <Loader2 className="size-4 shrink-0 animate-spin" />
        ) : (
          shown && createElement(suggested ? Lightbulb : toolIcon(shown.use.name), { className: 'size-4 shrink-0' })
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
            {suggested || !iconSays(shown.use.name) ? <span className="font-medium">{suggested ? 'Sugeriu uma memória' : name}</span> : <span className="sr-only">{name}</span>}{' '}
            <span className="font-mono">{suggested ? memoryName(shown.use.input) : toolSummary(shown.use.name, shown.use.input)}</span>
          </span>
        )}
        <ChevronRight className={cn(CHEVRON, 'ml-auto')} />
      </CollapsibleTrigger>
      {images.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto px-2 pb-1.5">
          {images.map((key) => (
            <ImageThumb key={key} src={imageUrl(sessionId, key)} thumb={thumbUrl(sessionId, key)} gallery={claude} from="Claude" className="h-24 max-w-44" />
          ))}
        </div>
      )}
      {pages.length > 0 && (
        <div className="space-y-1 px-2 pb-1.5">
          {pages.map((p) => (
            <PublishedCard key={publishedKey(p)} sessionId={sessionId} published={p} />
          ))}
        </div>
      )}
    </>
  )
}

function EntryRow({
  sessionId,
  entry,
  agents,
  published,
}: {
  sessionId: string
  entry: ActivityEntry
  agents: ReturnType<typeof useAgents>
  /** A página (ou o artefato) que esta entrada publicou, com o cartão dela debaixo da linha. */
  published?: Published
}) {
  // Subagente: uma linha com o andamento; o que ele fez fica no painel dele.
  const agent = entry.kind === 'tool' && entry.inner ? agents?.tree.byId.get(entry.use.id) : undefined
  if (agent) return <AgentRow node={agent} onOpen={() => agents!.open(agent.id)} />
  if (entry.kind === 'tool') {
    const { use, result, answer, at, started, finished } = entry
    return <ToolRow sessionId={sessionId} use={use} result={result} answer={answer} at={at} started={started} finished={finished} published={published} />
  }
  if (entry.kind === 'thinking') return <ThinkingRow text={entry.text} />
  return (
    <div className="mx-2 my-1 border-l-2 pl-2 text-xs text-muted-foreground">
      <span className="font-medium">subagente: </span>
      {entry.text.slice(0, 400)}
    </div>
  )
}
