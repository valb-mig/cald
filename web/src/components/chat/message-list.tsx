import { Check, CircleAlert, Clock, Copy, FilePen, FileText, Folder, GitFork, Info, Link2, Pause, Play, SquareTerminal } from 'lucide-react'
import { toast } from 'sonner'
import { useEffect, useMemo, useState } from 'react'
import { toolLine } from '@/components/agents/model'
import { useNow } from '@/components/agents/status'
import { ImageThumb } from '@/components/image-viewer'
import { Markdown } from '@/components/markdown'
import { ReadingLine } from '@/components/reading-line'
import { Button } from '@/components/ui/button'
import { imageUrl, thumbUrl } from '@/lib/api'
import { duration } from '@/lib/format'
import { discard, retryItem, type OutboxItem } from '@/lib/outbox'
import { machineOf } from '@/lib/machines'
import { speechSupported, stopSpeakingIn, toggleSpeech, useSpeech } from '@/lib/speech'
import { useStore } from '@/lib/store'
import type { BackgroundTask, PanelEvent } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Activity, LineCounts } from './activity'
import { ApprovalCard } from './approval-card'
import { BackgroundTasks } from './background-tasks'
import { ClaudeSpinner } from './claude-spinner'
import { GalleryContext, galleryOf, useGallery } from './gallery'
import type { Item } from './items'
import { QuestionCard } from './question-card'
import { turnsOf, type ToolEntry, type TurnInfo } from './turn'
import { TurnSheet, type TurnSection } from './turn-sheet'

function Divider({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center gap-3 text-xs text-muted-foreground', className)}>
      <div className="h-px flex-1 bg-border" />
      <span className="shrink-0">{children}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

// Menção a arquivo: "@" no início ou depois de espaço (não pega e-mails).
const MENTION = /(^|\s)(@[^\s]+)/g

function FileChip({ name, title, dir }: { name: string; title: string; dir?: boolean }) {
  const Icon = dir ? Folder : FileText
  return (
    <span title={title} className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded bg-primary-foreground/15 px-1.5 align-bottom font-mono text-[0.85em]">
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  )
}

/** Texto do usuário com as menções @caminho viradas etiquetas com o nome do arquivo. */
function withMentions(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(MENTION)) {
    const at = m.index + m[1].length
    out.push(text.slice(last, at))
    const path = m[2].slice(1)
    const dir = path.endsWith('/')
    // Anexos ganham um prefixo de timestamp no PC; ele não interessa aqui.
    const name = path.replace(/\/$/, '').split('/').pop()!.replace(/^\d{13}-/, '')
    out.push(<FileChip key={at} name={name} title={path} dir={dir} />)
    last = at + m[2].length
  }
  out.push(text.slice(last))
  return out
}

/**
 * `files`: anexos que ainda não viraram @caminho no PC (mensagem na fila). `anchor`: chave da mensagem,
 * para a faixa do topo saber qual mensagem já passou (ver sticky-prompt.tsx).
 */
function UserBubble({
  sessionId,
  text,
  images,
  files,
  anchor,
  onBranch,
}: {
  sessionId: string
  text: string
  images?: string[]
  files?: string[]
  anchor?: string
  /** Bifurcar a conversa nesta mensagem; ausente quando não dá (a primeira, ou histórico sem UUID). */
  onBranch?: () => void
}) {
  const { mine } = useGallery()
  return (
    <div className="group flex scroll-mt-16 flex-col items-end gap-1.5" data-user-msg={anchor}>
      {images && images.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {images.map((key) => (
            <ImageThumb key={key} src={imageUrl(sessionId, key)} thumb={thumbUrl(sessionId, key)} gallery={mine} from="Você" className="h-28 max-w-40" />
          ))}
        </div>
      )}
      {(text || files?.length) && (
        <div className="flex max-w-[85%] items-end gap-1">
          {onBranch && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onBranch}
              title="Bifurcar daqui"
              aria-label="Bifurcar a conversa nesta mensagem"
              // No celular não há "passar o mouse": o botão fica sempre lá, só apagado.
              className="shrink-0 text-muted-foreground opacity-40 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            >
              <GitFork />
            </Button>
          )}
          <div className="min-w-0 rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm whitespace-pre-wrap break-words text-primary-foreground">
            {withMentions(text)}
            {text && files?.length ? '\n\n' : null}
            {files?.map((name, i) => <FileChip key={i} name={name} title={name} />)}
          </div>
        </div>
      )}
    </div>
  )
}

/** Mensagem que ainda não chegou ao PC: relógio enquanto espera, e o motivo se não deu para enviar. */
function QueuedBubble({ item, sessionId }: { item: OutboxItem; sessionId: string }) {
  const connection = useStore((s) => s.connections[machineOf(sessionId)] ?? 'connecting')
  const images = item.attachments.flatMap((a) => (a.thumb ? [a.thumb] : []))
  const files = item.attachments.flatMap((a) => (a.thumb ? [] : [a.name]))
  const action = 'font-medium text-foreground underline-offset-2 hover:underline'
  return (
    <div className="space-y-1">
      <UserBubble sessionId={sessionId} text={item.text} images={images} files={files} />
      {item.status === 'failed' ? (
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs">
          <span className="flex min-w-0 items-center gap-1 text-red-600 dark:text-red-400">
            <CircleAlert className="size-3.5 shrink-0" />
            Não enviada: {item.error}
          </span>
          <button type="button" className={action} onClick={() => retryItem(item.id)}>
            Tentar de novo
          </button>
          <button type="button" className={action} onClick={() => discard(item.id)}>
            Descartar
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
          <Clock className="size-3" />
          {item.status === 'sending' || connection === 'open' ? 'Enviando…' : 'Aguardando conexão'}
          {item.status === 'queued' && (
            <button type="button" className={cn(action, 'ml-2')} onClick={() => discard(item.id)}>
              Cancelar
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** O que o turno fez: arquivos alterados, comandos e links; cada atalho abre o painel na seção dele. */
function TurnShortcuts({ turn, cwd }: { turn: TurnInfo; cwd?: string }) {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<TurnSection>('files')
  const show = (s: TurnSection) => {
    setSection(s)
    setOpen(true)
  }
  const links = turn.visited.length + turn.cited.length
  const chip = 'rounded-full text-muted-foreground'
  return (
    <>
      {turn.files.length > 0 && (
        <Button variant="outline" size="sm" className={chip} onClick={() => show('files')}>
          <FilePen /> {plural(turn.files.length, 'arquivo', 'arquivos')}
          <LineCounts added={turn.files.reduce((n, f) => n + f.added, 0)} removed={turn.files.reduce((n, f) => n + f.removed, 0)} />
        </Button>
      )}
      {turn.commands.length > 0 && (
        <Button variant="outline" size="sm" className={chip} onClick={() => show('commands')}>
          <SquareTerminal /> {plural(turn.commands.length, 'comando', 'comandos')}
        </Button>
      )}
      {links > 0 && (
        <Button variant="outline" size="sm" className={chip} onClick={() => show('links')}>
          <Link2 /> {plural(links, 'link', 'links')}
        </Button>
      )}
      <TurnSheet turn={turn} cwd={cwd} section={section} open={open} onOpenChange={setOpen} />
    </>
  )
}

/** Copia a resposta como o Claude escreveu, em Markdown, para colar num issue, num doc ou em outro chat. */
function CopyMarkdown({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <Button
      variant="secondary"
      size="sm"
      className="rounded-full pr-3.5"
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => toast.error('Não deu para copiar: o navegador não liberou a área de transferência.'),
        )
      }
      aria-label="Copiar a resposta em Markdown"
      title="Copiar a resposta em Markdown"
    >
      {copied ? <Check /> : <Copy />}
      {copied ? 'Copiado' : 'Copiar'}
    </Button>
  )
}

/**
 * Resposta do Claude, com **Ouvir** e **Copiar** (em Markdown) embaixo: Ouvir lê o texto em voz alta
 * com a voz do aparelho, e o trecho sendo lido fica em destaque (a barra de controle fica em cima da
 * caixa de mensagem). Na última resposta de cada turno, os atalhos do que o turno fez.
 */
function AssistantMessage({ id, text, turn, cwd }: { id: string; text: string; turn?: TurnInfo; cwd?: string }) {
  const state = useSpeech((s) => (s.reading?.key === id ? (s.reading.playing ? 'playing' : 'paused') : null))
  const line = useSpeech((s) => (s.reading?.key === id ? (s.reading.units[s.reading.index]?.line ?? null) : null))
  return (
    <div>
      <ReadingLine value={line}>
        <Markdown text={text} />
      </ReadingLine>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {speechSupported && (
          <Button variant={state ? 'default' : 'secondary'} size="sm" className="rounded-full pr-3.5" onClick={() => toggleSpeech(id, text)}>
            {state === 'playing' ? <Pause className="fill-current" /> : <Play className="fill-current" />}
            {state === 'playing' ? 'Pausar' : state === 'paused' ? 'Continuar' : 'Ouvir'}
          </Button>
        )}
        <CopyMarkdown text={text} />
        {turn && <TurnShortcuts turn={turn} cwd={cwd} />}
      </div>
    </div>
  )
}

function resultLabel(result: Extract<Item, { type: 'result' }>['result']): string {
  if (result.ok) return `Concluído em ${duration(result.durationMs)}`
  if (result.subtype === 'error_during_execution') return 'Interrompido'
  if (result.subtype === 'error_max_turns') return 'Parou no limite de turnos'
  return 'Terminou com erro'
}

function ItemView({
  item,
  sessionId,
  actionable,
  onBranch,
  turn,
  cwd,
}: {
  item: Item
  sessionId: string
  actionable: boolean
  onBranch?: (at: string, text: string) => void
  turn?: TurnInfo
  cwd?: string
}) {
  switch (item.type) {
    case 'user':
      return (
        <UserBubble
          sessionId={sessionId}
          text={item.text}
          images={item.images}
          anchor={item.key}
          onBranch={item.from && onBranch ? () => onBranch(item.from!, item.text) : undefined}
        />
      )
    case 'assistant':
      return <AssistantMessage id={`${sessionId}:${item.key}`} text={item.text} turn={turn} cwd={cwd} />
    case 'notice':
      return (
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-4 whitespace-pre-wrap">{item.text}</span>
        </div>
      )
    case 'activity':
      return <Activity sessionId={sessionId} entries={item.entries} />
    case 'approval':
      return <ApprovalCard {...item} sessionId={sessionId} actionable={actionable} />
    case 'question':
      return <QuestionCard {...item} sessionId={sessionId} actionable={actionable} />
    case 'result':
      return <Divider className={cn(!item.result.ok && 'text-amber-700 dark:text-amber-400')}>{resultLabel(item.result)}</Divider>
    case 'exit':
      return (
        <div className="space-y-1">
          <Divider>Processo do painel encerrado</Divider>
          {item.error && <p className="text-xs whitespace-pre-wrap text-red-600 dark:text-red-400">{item.error}</p>}
        </div>
      )
    case 'compacting':
      return <Divider>Compactando o contexto…</Divider>
  }
}

/**
 * "Trabalhando…" com o que está rodando agora: a ferramenta em uso no turno (um comando longo, um
 * subagente) e há quanto tempo, para não parecer travado.
 */
function WorkingLine({ items }: { items: Item[] }) {
  const last = items.at(-1)
  const running = last?.type === 'activity' ? last.entries.findLast((e): e is ToolEntry => e.kind === 'tool' && !e.result) : undefined
  const now = useNow(Boolean(running?.at))
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" role="status">
      <ClaudeSpinner className="size-4" />
      {running ? (
        <>
          <span className="shrink-0">Rodando</span>
          <span className="min-w-0 truncate font-mono text-[11px]">{toolLine(running)}</span>
          {running.at && <span className="shrink-0 tabular-nums">{duration(Math.max(0, now - running.at))}</span>}
        </>
      ) : (
        'Trabalhando…'
      )}
    </div>
  )
}

export function MessageList({
  items,
  queued,
  sessionId,
  actionable,
  streaming,
  working,
  background,
  uses,
  cwd,
  onBranch,
}: {
  items: Item[]
  /** Bifurcar a conversa numa mensagem: nasce uma conversa nova com o histórico só até ali. */
  onBranch?: (at: string, text: string) => void
  /** Mensagens na fila do celular, ainda não entregues ao PC. */
  queued: OutboxItem[]
  sessionId: string
  /** Aprovações e perguntas só podem ser respondidas com a sessão aberta no painel. */
  actionable: boolean
  streaming: string
  working: boolean
  /** O que ficou rodando em segundo plano depois da resposta (monitores, comandos, subagentes). */
  background: BackgroundTask[]
  uses: Map<string, Extract<PanelEvent, { kind: 'tool_use' }>>
  /** Pasta do projeto: os arquivos alterados aparecem com o caminho a partir dela. */
  cwd?: string
}) {
  const gallery = useMemo(() => galleryOf(items, sessionId), [items, sessionId])
  const turns = useMemo(() => turnsOf(items), [items])
  // Conversa saindo da tela cala a leitura dela; a de outra conversa aberta ao lado segue.
  useEffect(() => () => stopSpeakingIn(sessionId), [sessionId])
  return (
    // Tocar numa imagem abre a tela cheia passando pelas outras do mesmo lado da conversa.
    <GalleryContext value={gallery}>
      <div className="space-y-4 px-4 py-4">
        {items.map((item) => (
          // `data-item`: o mapa mental leva até aqui ao tocar num nó.
          <div key={item.key} data-item={item.key} className="scroll-mt-16 rounded-xl">
            <ItemView item={item} sessionId={sessionId} actionable={actionable} onBranch={onBranch} turn={turns.get(item.key)} cwd={cwd} />
          </div>
        ))}
        {queued.map((item) => (
          <QueuedBubble key={item.id} item={item} sessionId={sessionId} />
        ))}
        {streaming && <Markdown text={streaming} className="opacity-90" />}
        {working && !streaming && <WorkingLine items={items} />}
        {/* Fica na tela também durante os turnos: num monitor, cada novidade acorda o Claude. */}
        <BackgroundTasks sessionId={sessionId} tasks={background} uses={uses} actionable={actionable} />
      </div>
    </GalleryContext>
  )
}
