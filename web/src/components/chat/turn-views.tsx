import { AtSign, Check, CheckCircle2, ChevronRight, Copy, ExternalLink, FileSearch, FilePen, Globe, Link2, Loader2, Search, SquareTerminal, XCircle, type LucideIcon } from 'lucide-react'
import { createElement, memo, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Chip, Chips, SearchField } from '@/components/claude/bits'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { TEST_COMMAND, shortPath, toolSummary, took } from '@/lib/format'
import { mentionInChat, openViewer } from '@/lib/project-panel'
import { cn } from '@/lib/utils'
import { LineCounts, ToolDetails, toolIcon } from './activity'
import { hostOf, linksOf, type LinkEntry, type ToolEntry, type TurnInfo } from './turn'

/**
 * As listas do que o Claude fez (arquivos, comandos, links, erros), as mesmas no modal de cada
 * atalho da resposta (ver turn-dialog.tsx) e no resumo da sessão (ver summary-dialog.tsx). Cada uma
 * tem busca e filtros no topo, fixos, e só a lista rola; com poucos itens, é só a lista.
 */

/** Acima de tantos itens a lista ganha busca e filtros; até aqui, dá para achar de olho. */
export const SEARCH_FROM = 5

/**
 * As margens da visão na janela que a recebe. `dialog`: numa ilha de janela só, com o cabeçalho na
 * casca (os modais do turno). `window`: abaixo do cabeçalho de uma ilha com navegação, que some no
 * celular (o resumo da sessão).
 */
const INSETS = {
  dialog: { x: 'px-5 max-sm:px-4', top: 'pt-5 max-sm:pt-4', bottom: 'pb-5 max-sm:pb-4' },
  window: { x: 'px-6 max-sm:px-4', top: 'max-sm:pt-4', bottom: 'pb-6 max-sm:pb-4' },
}

type Common = { inset?: keyof typeof INSETS; autoFocus?: boolean }

const str = (v: unknown) => (typeof v === 'string' ? v : '')
// Sem acento e sem caixa: "funcao" acha "função".
const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
/**
 * O texto de busca de uma ferramenta, normalizado uma vez por evento de origem (o resultado, ou a
 * chamada enquanto roda): a conversa ao vivo refaz as listas a cada evento, e a saída de um comando
 * pode ter milhares de linhas, mas o evento em si não muda. Um cache por lista, que o texto difere.
 */
function toolSearch(text: (t: ToolEntry) => string): (t: ToolEntry) => string {
  const cache = new WeakMap<object, string>()
  return (tool) => {
    const source = tool.result ?? tool.use
    let found = cache.get(source)
    if (found === undefined) cache.set(source, (found = norm(text(tool))))
    return found
  }
}
/** Uma linha de ferramenta só muda com a chamada, o resultado ou os horários (a entrada é refeita a cada evento). */
const sameTool = (a: ToolEntry, b: ToolEntry) => a.use === b.use && a.result === b.result && a.started === b.started && a.finished === b.finished && a.answer === b.answer
const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''
const ICON = 'size-4 shrink-0 text-muted-foreground'

type Filter<T> = { key: string; label: string; test: (row: T) => boolean }

/**
 * A lista com a busca e os filtros (um ligado por vez; tocar no ligado desliga). Um filtro só aparece
 * se separa alguma coisa: nem vazio, nem igual à lista toda. `text`: onde a busca procura, já
 * normalizado (ver `norm`), de fora do componente (estável), para o índice da busca não ser refeito a
 * cada letra.
 */
function FilterList<T>({
  rows,
  text,
  filters,
  initial,
  placeholder,
  empty,
  render,
  inset: where = 'dialog',
  autoFocus,
}: Common & {
  rows: T[]
  text: (row: T) => string
  filters: Filter<T>[]
  initial?: string
  placeholder: string
  empty: React.ReactNode
  render: (row: T) => React.ReactNode
}) {
  const inset = INSETS[where]
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<string | null>(initial ?? null)
  // O índice só existe buscando: a conversa ao vivo troca a lista a cada evento, e as saídas podem ser longas.
  const searching = query.trim() !== ''
  const index = useMemo(() => (searching ? rows.map(text) : null), [rows, text, searching])
  if (rows.length === 0) return <div className={cn('flex min-h-0 flex-1 flex-col', inset.x, inset.top, inset.bottom)}>{empty}</div>

  const chips = filters
    .map((f) => ({ ...f, count: rows.filter(f.test).length }))
    .filter((f) => (f.count > 0 && f.count < rows.length) || f.key === filter)
  // Com um filtro já ligado ao abrir (os testes, vindo do resumo), o topo aparece para dar para desligar.
  const tools = rows.length > SEARCH_FROM || filter !== null
  const active = filters.find((f) => f.key === filter)
  const q = norm(query.trim())
  const shown = rows.filter((r, i) => (!active || active.test(r)) && (!q || !index || index[i]!.includes(q)))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tools && (
        <div className={cn('shrink-0 space-y-2 pb-3', inset.x, inset.top)}>
          <SearchField value={query} onChange={setQuery} placeholder={placeholder} autoFocus={autoFocus} />
          {chips.length > 0 && (
            <Chips>
              {chips.map((f) => (
                <Chip key={f.key} on={filter === f.key} onClick={() => setFilter(filter === f.key ? null : f.key)} label={f.label} count={f.count} />
              ))}
            </Chips>
          )}
        </div>
      )}
      <div className={cn('min-h-0 flex-1 overflow-y-auto', inset.x, inset.bottom, !tools && inset.top)}>
        {shown.length > 0 ? (
          <div className="rounded-xl bg-foreground/[0.04] p-1">{shown.map(render)}</div>
        ) : (
          <p className="px-1 py-2 text-xs text-muted-foreground">{q ? `Nada com “${query.trim()}”` : 'Nada com esse filtro'}</p>
        )}
      </div>
    </div>
  )
}

/** Lista vazia: o ícone grande e apagado e uma linha. */
function Empty({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
      <Icon className="size-8 opacity-40" strokeWidth={1.5} />
      {text}
    </div>
  )
}

const ROW = 'flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-foreground/[0.04]'

/** O meio de uma linha: o título e, embaixo, um detalhe em cinza; os dois cortados no fim. */
function Lines({ title, sub }: { title: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm">{title}</div>
      {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

/** Uma linha que abre para os detalhes (o diff, a saída do comando); a seta gira ao abrir. */
function Expandable({ lead, title, sub, meta, children }: { lead: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className={cn(ROW, 'group data-[state=open]:bg-foreground/[0.04]')}>
        {lead}
        <Lines title={title} sub={sub} />
        {meta}
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1.5 px-3 pt-1.5 pb-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/** Copia um texto; o ícone vira um visto por um instante. Sem `label` visível, fica só o ícone. */
function CopyButton({ text, title, label }: { text: string; title: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <Button
      variant="ghost"
      size={label ? 'xs' : 'icon-sm'}
      title={title}
      aria-label={title}
      className="shrink-0 text-muted-foreground"
      onClick={(e) => {
        // Na linha de um link, copiar não abre a página.
        e.preventDefault()
        e.stopPropagation()
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => toast.error('Não deu para copiar: o navegador não liberou a área de transferência.'),
        )
      }}
    >
      {copied ? <Check /> : <Copy />}
      {label && (copied ? 'Copiado' : label)}
    </Button>
  )
}

/** As ações pequenas no topo de uma linha aberta, antes dos detalhes (que podem ser longos). */
function Actions({ children }: { children: React.ReactNode }) {
  return <div className="-ml-2 flex flex-wrap items-center gap-0.5">{children}</div>
}

// --- Arquivos ---

type FileChange = TurnInfo['files'][number]

const filePath = (f: FileChange) => norm(f.path)
const extOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** Um filtro por extensão, das mais comuns para as raras; com uma extensão só, não há o que filtrar. */
function extensionFilters(files: FileChange[]): Filter<FileChange>[] {
  const counts = new Map<string, number>()
  for (const f of files) {
    const ext = extOf(f.path)
    if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1)
  }
  if (counts.size < 2) return []
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([ext]) => ({ key: ext, label: ext, test: (f: FileChange) => extOf(f.path) === ext }))
}

/**
 * Os arquivos que o Claude mudou. Aberto, cada um mostra as edições e dá para abrir o arquivo,
 * mencioná-lo na conversa ou copiar o caminho. `onDone`: fecha quem mostra a lista, para o arquivo
 * aberto ou a caixa de mensagem aparecerem.
 */
export function FilesView({ files, cwd, machine, onDone, ...common }: Common & { files: FileChange[]; cwd?: string; machine?: string; onDone: () => void }) {
  const filters = useMemo(() => extensionFilters(files), [files])
  return (
    <FilterList
      {...common}
      rows={files}
      text={filePath}
      filters={filters}
      placeholder="Buscar arquivo"
      empty={<Empty icon={FilePen} text="Nenhum arquivo mudou" />}
      render={(f) => <FileRow key={f.path} file={f} cwd={cwd} machine={machine} onDone={onDone} />}
    />
  )
}

function FileRow({ file, cwd, machine, onDone }: { file: FileChange; cwd?: string; machine?: string; onDone: () => void }) {
  // Dentro do projeto, o caminho a partir dele: é o que o visualizador e a menção entendem.
  const inside = Boolean(cwd && file.path.startsWith(`${cwd}/`))
  const rel = inside ? file.path.slice(cwd!.length + 1) : shortPath(file.path)
  const slash = rel.lastIndexOf('/')
  return (
    <Expandable
      lead={<FilePen className={ICON} />}
      title={<span className="font-mono text-[13px]">{rel.slice(slash + 1)}</span>}
      sub={slash > 0 && <span className="font-mono">{rel.slice(0, slash)}</span>}
      meta={<LineCounts added={file.added} removed={file.removed} />}
    >
      <Actions>
        {/* A máquina deste PC é a de id vazio: o que falta é não saber de qual máquina é. */}
        {inside && machine !== undefined && (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => {
              onDone()
              openViewer({ machine, cwd: cwd!, path: rel })
            }}
          >
            <FileSearch /> Abrir
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          onClick={() => {
            if (mentionInChat(inside ? rel : file.path)) onDone()
            else toast('Nenhuma conversa com onde escrever agora')
          }}
        >
          <AtSign /> Mencionar
        </Button>
        <CopyButton text={file.path} title="Copiar o caminho" />
      </Actions>
      {file.changes.map((c) => (
        <div key={c.key} className="space-y-1">
          <ToolDetails use={c.use} result={c.result} />
        </div>
      ))}
    </Expandable>
  )
}

// --- Comandos ---

export type CommandFilter = 'failed' | 'tests' | 'running'

const COMMAND_FILTERS: (Filter<ToolEntry> & { key: CommandFilter })[] = [
  { key: 'failed', label: 'Falharam', test: (c) => Boolean(c.result?.isError) },
  { key: 'tests', label: 'Testes', test: (c) => TEST_COMMAND.test(str(c.use.input.command)) },
  { key: 'running', label: 'Rodando', test: (c) => !c.result },
]

// A busca acha também pela saída: "onde apareceu aquele erro?".
const commandText = toolSearch((c) => `${str(c.use.input.description)}\n${str(c.use.input.command)}\n${c.result?.text ?? ''}`)

function Status({ tool }: { tool: ToolEntry }) {
  if (!tool.result) return <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
  return tool.result.isError ? (
    <XCircle className="size-4 shrink-0 text-red-600 dark:text-red-400" />
  ) : (
    <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
  )
}

/** Os comandos do terminal, com o resultado de cada um; `filter`: já abre com esse filtro ligado. */
export function CommandsView({ commands, filter, ...common }: Common & { commands: ToolEntry[]; filter?: CommandFilter }) {
  return (
    <FilterList
      {...common}
      rows={commands}
      text={commandText}
      filters={COMMAND_FILTERS}
      initial={filter}
      placeholder="Buscar comando ou saída"
      empty={<Empty icon={SquareTerminal} text="Nenhum comando" />}
      render={(c) => <CommandRow key={c.key} tool={c} />}
    />
  )
}

// Cada letra da busca e cada evento da conversa redesenham a lista: as linhas que não mudaram ficam.
const CommandRow = memo(
  function CommandRow({ tool }: { tool: ToolEntry }) {
    const description = str(tool.use.input.description)
    const command = str(tool.use.input.command)
    const time = tool.result && tool.started && tool.finished ? took(tool.finished - tool.started) : ''
    return (
      <Expandable
        lead={<Status tool={tool} />}
        // Sem descrição, o próprio comando é o título.
        title={description || <span className="font-mono text-[13px]">{firstLine(command)}</span>}
        sub={description && <span className="font-mono">{command}</span>}
        meta={time && <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{time}</span>}
      >
        <Actions>
          <CopyButton text={command} title="Copiar o comando" label="Copiar" />
        </Actions>
        <ToolDetails use={tool.use} result={tool.result} />
      </Expandable>
    )
  },
  (a, b) => sameTool(a.tool, b.tool),
)

// --- Links ---

const LINK_FILTERS: Filter<LinkEntry>[] = [
  { key: 'cited', label: 'Citados', test: (l) => l.kind === 'cited' },
  { key: 'opened', label: 'Abertos', test: (l) => l.kind === 'opened' },
  { key: 'search', label: 'Pesquisas', test: (l) => l.kind === 'search' },
]

const linkText = (l: LinkEntry) => norm(l.kind === 'search' ? l.query : l.kind === 'cited' ? `${l.label}\n${l.url}` : l.url)

/** As páginas que o Claude abriu, as pesquisas que fez e os links que citou na resposta. */
export function LinksView({ visited, cited, ...common }: Common & Pick<TurnInfo, 'visited' | 'cited'>) {
  const links = useMemo(() => linksOf({ visited, cited }), [visited, cited])
  return (
    <FilterList
      {...common}
      rows={links}
      text={linkText}
      filters={LINK_FILTERS}
      placeholder="Buscar link ou pesquisa"
      empty={<Empty icon={Link2} text="Nenhum link" />}
      render={(l) => <LinkRow key={l.key} link={l} />}
    />
  )
}

function LinkRow({ link }: { link: LinkEntry }) {
  if (link.kind === 'search') {
    return (
      <Expandable lead={<Search className={ICON} />} title={`“${link.query}”`}>
        <ToolDetails use={link.tool.use} result={link.tool.result} />
      </Expandable>
    )
  }
  const Icon = link.kind === 'cited' ? ExternalLink : Globe
  return (
    // O link e o copiar lado a lado: um botão dentro do <a> abriria a página junto.
    <div className="flex min-h-11 items-center gap-1 rounded-lg pr-1.5 transition-colors hover:bg-foreground/[0.04]">
      <a href={link.url} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-center gap-3 self-stretch py-2 pl-3">
        <Icon className={ICON} />
        <Lines title={link.kind === 'cited' ? link.label : hostOf(link.url)} sub={<span className="font-mono">{link.url}</span>} />
      </a>
      <CopyButton text={link.url} title="Copiar o link" />
    </div>
  )
}

// --- Erros ---

const toolName = (name: string) => (name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : name)
const errorText = toolSearch((t) => `${t.use.name}\n${toolSummary(t.use.name, t.use.input)}\n${t.result?.text ?? ''}`)

/** Um filtro por ferramenta, das que mais falharam para as que menos; com uma só, não há o que filtrar. */
function toolFilters(tools: ToolEntry[]): Filter<ToolEntry>[] {
  const counts = new Map<string, number>()
  for (const t of tools) counts.set(t.use.name, (counts.get(t.use.name) ?? 0) + 1)
  if (counts.size < 2) return []
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => ({ key: name, label: toolName(name), test: (t: ToolEntry) => t.use.name === name }))
}

/** As ferramentas que falharam (ver `failedTools`), com a primeira linha do erro à vista. */
export function ErrorsView({ tools, ...common }: Common & { tools: ToolEntry[] }) {
  const filters = useMemo(() => toolFilters(tools), [tools])
  return (
    <FilterList
      {...common}
      rows={tools}
      text={errorText}
      filters={filters}
      placeholder="Buscar erro"
      empty={<Empty icon={CheckCircle2} text="Nenhum erro" />}
      render={(t) => <ErrorRow key={t.key} tool={t} />}
    />
  )
}

const ErrorRow = memo(
  function ErrorRow({ tool: t }: { tool: ToolEntry }) {
    return (
      <Expandable
        lead={createElement(toolIcon(t.use.name), { className: ICON })}
        title={toolSummary(t.use.name, t.use.input) || toolName(t.use.name)}
        sub={firstLine(t.result?.text ?? '')}
        meta={<XCircle className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />}
      >
        <ToolDetails use={t.use} result={t.result} answer={t.answer} />
      </Expandable>
    )
  },
  (a, b) => sameTool(a.tool, b.tool),
)
