import { Check, CircleAlert, Clock, Code, Copy, FilePen, FileText, Folder, GitFork, Info, Link2, ListTodo, Monitor, Pause, Play, Smartphone, SquareTerminal } from 'lucide-react'
import { toast } from 'sonner'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toolLine } from '@/components/agents/model'
import { useNow } from '@/components/agents/status'
import { ClaudeMark } from '@/components/claude-mark'
import { ImageThumb } from '@/components/image-viewer'
import { Markdown, StreamingMarkdown } from '@/components/markdown'
import { ReadingLine } from '@/components/reading-line'
import { Button } from '@/components/ui/button'
import { imageUrl, thumbUrl } from '@/lib/api'
import { duration, messageTime } from '@/lib/format'
import { discard, retryItem, type OutboxItem } from '@/lib/outbox'
import { machineOf } from '@/lib/machines'
import { speechSupported, stopSpeakingIn, toggleSpeech, useSpeech } from '@/lib/speech'
import { useStore } from '@/lib/store'
import type { BackgroundTask, PanelEvent, Sent } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Activity, LineCounts } from './activity'
import { ApprovalCard } from './approval-card'
import { Arrival, useArrivals } from './arrival'
import { BackgroundTasks } from './background-tasks'
import { CHEER_MS, Claudinho } from '@/components/claudinho'
import { EFFORTS, prettyModel } from './composer-controls'
import { GalleryContext, galleryOf, useGallery } from './gallery'
import type { Item } from './items'
import { QuestionCard } from './question-card'
import { lastAnswersOf, linksOf, turnsOf, type ToolEntry, type TurnInfo } from './turn'
import { TurnDialog, type TurnSection } from './turn-dialog'

function Divider({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center gap-3 text-xs text-muted-foreground', className)}>
      <div className="h-px flex-1 bg-border" />
      <span className="shrink-0">{children}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

// Menção a arquivo: "@" no início ou depois de espaço (não pega e-mails); ou a um item do TODO, "TODO:3".
const MENTION = /(^|\s)(@[^\s]+|TODO:\d+\b)/gi

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
    if (/^todo:/i.test(m[2])) {
      out.push(
        <span key={at} title="Item do TODO do projeto: o Claude recebeu a descrição e os anexos" className="mx-0.5 inline-flex items-center gap-1 rounded bg-primary-foreground/15 px-1.5 align-bottom font-mono text-[0.85em]">
          <ListTodo className="size-3 shrink-0" />
          {m[2].toUpperCase()}
        </span>,
      )
      last = at + m[2].length
      continue
    }
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

const VIA: Record<NonNullable<Sent['via']>, string> = { editr: 'edit.r', cald: 'edit.r', terminal: 'Terminal', vscode: 'VSCode', desktop: 'Claude Desktop' }

/**
 * Por onde, de que máquina e quando a mensagem saiu: "Terminal · archlinux · 14:32". Com isso não
 * precisa de "assumir": a conversa pode ir do terminal para o celular e voltar, e cada mensagem diz de onde veio.
 */
function SentLine({ sent }: { sent: Sent }) {
  const parts = [sent.via && VIA[sent.via], sent.device, sent.at !== undefined && messageTime(sent.at)].filter(Boolean)
  if (!parts.length) return null
  // Do app sem saber o aparelho (mensagens de antes de o edit.r guardar isso), fica sem ícone.
  const Icon = sent.via === 'terminal' ? SquareTerminal : sent.via === 'vscode' ? Code : sent.mobile ? Smartphone : sent.via === 'desktop' || sent.mobile === false ? Monitor : null
  return (
    <div className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground" title={sent.at !== undefined ? new Date(sent.at).toLocaleString('pt-BR') : undefined}>
      {Icon && <Icon className="size-3 shrink-0" />}
      <span className="truncate">{parts.join(' · ')}</span>
    </div>
  )
}

/**
 * `files`: anexos que ainda não viraram @caminho no PC (mensagem na fila). `anchor`: chave da mensagem,
 * para a faixa do topo saber qual mensagem já passou (ver sticky-prompt.tsx). `sent`: de onde ela saiu.
 */
function UserBubble({
  sessionId,
  text,
  images,
  files,
  anchor,
  sent,
  onBranch,
}: {
  sessionId: string
  text: string
  images?: string[]
  files?: string[]
  anchor?: string
  sent?: Sent
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
      {sent && <SentLine sent={sent} />}
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
    <div className="chat-pop space-y-1">
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

/** O que o turno fez: arquivos alterados, comandos e links; cada atalho abre o modal do seu assunto. */
function TurnShortcuts({ turn, cwd, sessionId }: { turn: TurnInfo; cwd?: string; sessionId: string }) {
  const [open, setOpen] = useState<TurnSection | null>(null)
  // Os assuntos já abertos neste turno. O modal só monta na primeira vez que abre: a conversa ao vivo
  // refaz todos os turnos a cada evento, e um Dialog fechado por atalho (até três por turno) pesava em
  // todos eles. Depois de aberto fica montado, para fechar com a animação.
  const [mounted, setMounted] = useState<TurnSection[]>([])
  const show = (kind: TurnSection) => {
    setOpen(kind)
    if (!mounted.includes(kind)) setMounted([...mounted, kind])
  }
  // A mesma página aberta duas vezes conta uma, como no modal.
  const links = useMemo(() => linksOf(turn).length, [turn])
  const chip = 'rounded-full text-muted-foreground'
  // Um modal por assunto, cada um com o seu: fechando, o que sai continua o mesmo até sumir.
  const dialog = (kind: TurnSection) =>
    mounted.includes(kind) && (
      <TurnDialog kind={kind} turn={turn} cwd={cwd} sessionId={sessionId} open={open === kind} onOpenChange={(o) => setOpen(o ? kind : null)} />
    )
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
      {turn.files.length > 0 && dialog('files')}
      {turn.commands.length > 0 && dialog('commands')}
      {links > 0 && dialog('links')}
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
 * Resposta do Claude. Na última de cada turno, quem escreveu e os atalhos do que o turno fez
 * embaixo. **Ouvir** e **Copiar** (em Markdown) vêm no fim da fileira e só aparecem com o mouse em
 * cima da resposta (ou o foco do teclado nela), para a conversa ficar limpa; no celular, sem mouse,
 * ficam sempre à vista. Ouvir lê o texto em voz alta, e o trecho sendo lido fica em destaque (a barra
 * de controle fica em cima da caixa de mensagem); lendo, o botão fica à vista. `fresh`: acabou de
 * chegar; o texto já estava na tela pelo streaming, então só os botões entram, logo depois.
 */
function AssistantMessage({
  id,
  sessionId,
  text,
  model,
  effort,
  turn,
  cwd,
  fresh,
}: {
  id: string
  sessionId: string
  text: string
  model?: string
  effort?: string
  turn?: TurnInfo
  cwd?: string
  fresh: boolean
}) {
  const state = useSpeech((s) => (s.reading?.key === id ? (s.reading.playing ? 'playing' : 'paused') : null))
  const line = useSpeech((s) => (s.reading?.key === id ? (s.reading.units[s.reading.index]?.line ?? null) : null))
  return (
    <div className="group/answer">
      <ReadingLine value={line}>
        <Markdown text={text} chat />
      </ReadingLine>
      <Arrival fresh={fresh} delay={120} className="mt-2 flex flex-wrap items-center gap-1.5">
        {model && <WrittenBy model={model} effort={effort} />}
        {turn && <TurnShortcuts turn={turn} cwd={cwd} sessionId={sessionId} />}
        <span
          className={cn(
            'flex items-center gap-1.5 transition-opacity duration-150',
            !state && 'opacity-0 group-hover/answer:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100',
          )}
        >
          {speechSupported && (
            <Button variant={state ? 'default' : 'secondary'} size="sm" className="rounded-full pr-3.5" onClick={() => toggleSpeech(id, text)}>
              {state === 'playing' ? <Pause className="fill-current" /> : <Play className="fill-current" />}
              {state === 'playing' ? 'Pausar' : state === 'paused' ? 'Continuar' : 'Ouvir'}
            </Button>
          )}
          <CopyMarkdown text={text} />
        </span>
      </Arrival>
    </div>
  )
}

/**
 * Quem escreveu a resposta: a marca do Claude, o modelo e o esforço com que pensou, discretos no começo
 * da fileira. O id completo do modelo fica na dica, para quando o nome curto não bastar.
 */
function WrittenBy({ model, effort }: { model: string; effort?: string }) {
  return (
    <span title={effort ? `${model} · esforço ${effort}` : model} className="flex items-center gap-1 pr-1.5 text-xs text-muted-foreground">
      <ClaudeMark className="size-3.5" />
      {prettyModel(model)}
      {effort && ` · ${(EFFORTS[effort] ?? effort).toLowerCase()}`}
    </span>
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
  fresh,
  signed,
}: {
  item: Item
  sessionId: string
  actionable: boolean
  fresh: boolean
  /** Resposta com quem a escreveu: só a última de cada turno, para o modelo não se repetir na tela toda. */
  signed: boolean
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
          sent={item.sent}
          onBranch={item.from && onBranch ? () => onBranch(item.from!, item.text) : undefined}
        />
      )
    case 'assistant':
      return (
        <AssistantMessage
          id={`${sessionId}:${item.key}`}
          sessionId={sessionId}
          text={item.text}
          model={signed ? item.model : undefined}
          effort={item.effort}
          turn={turn}
          cwd={cwd}
          fresh={fresh}
        />
      )
    case 'notice':
      return (
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-4 whitespace-pre-wrap">{item.text}</span>
        </div>
      )
    case 'activity':
      return <Activity sessionId={sessionId} entries={item.entries} summary />
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
    case 'cleared':
      return <Divider>Conversa limpa</Divider>
  }
}

/**
 * "Trabalhando…" com o que está rodando agora: a ferramenta em uso no turno (um comando longo, um
 * subagente) e há quanto tempo, para não parecer travado.
 */
function WorkingLine({ sessionId, items }: { sessionId: string; items: Item[] }) {
  const last = items.at(-1)
  const running = last?.type === 'activity' ? last.entries.findLast((e): e is ToolEntry => e.kind === 'tool' && !e.result) : undefined
  const now = useNow(Boolean(running?.at))
  return (
    <div className="chat-enter flex min-w-0 items-center gap-2 text-xs text-muted-foreground" role="status">
      {/* O claudinho da conversa no lugar da estrelinha do Claude Code: rodando uma ferramenta, pula com o
          balão de "…"; sem nenhuma, fica com a mão no queixo, pensando. */}
      <Claudinho seed={sessionId} size={18} state="running" status thinking={!running} className={running ? 'claudinho-hop' : undefined} />
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

/**
 * O fim da conversa enquanto o Claude trabalha: o texto que ele está escrevendo ou o "Trabalhando…".
 * É o único pedaço da lista que acompanha cada delta do streaming; o resto só muda com eventos.
 */
function LiveTail({ sessionId, working, items }: { sessionId: string; working: boolean; items: Item[] }) {
  const streaming = useStore((s) => s.streams[sessionId] ?? '')
  // A cada atualização, só o último bloco do markdown é reprocessado (ver StreamingMarkdown), mas a
  // lista dos blocos é refeita e cresce com a resposta: quanto maior ela fica, mais espaçadas as
  // atualizações (de uma por quadro até ~4 por segundo).
  const typed = useTyped(streaming, Math.max(16, Math.min(250, streaming.length / 40)))
  const cheer = useTurnCheer(working, items.findLast((i): i is ResultItem => i.type === 'result'))
  // Ao terminar vai direto para vazio: atrasado, o texto parcial ficaria na tela junto da resposta pronta.
  const text = streaming && typed
  if (text) return <StreamingMarkdown text={text} className="chat-enter opacity-90" chat />
  if (working) return <WorkingLine sessionId={sessionId} items={items} />
  // O turno acabou bem: o claudinho do "Trabalhando…" faz o joinha e sai.
  return cheer ? (
    <div className="claudinho-bye flex items-center" aria-hidden>
      <Claudinho seed={sessionId} size={18} pose="done" />
    </div>
  ) : null
}

type ResultItem = Extract<Item, { type: 'result' }>

/**
 * A hora do joinha no fim do chat: um turno visto rodando acabou bem. O fim chega em dois sinais, o
 * estado parando de trabalhar e o resultado do turno, e o estado costuma vir antes; o joinha espera
 * os dois, senão leria o resultado do turno anterior.
 */
function useTurnCheer(working: boolean, result?: ResultItem): boolean {
  // O turno em andamento, com a chave do último resultado de antes dele; `null` sem turno.
  const [turn, setTurn] = useState<{ after?: string } | null>(null)
  const [cheer, setCheer] = useState(false)
  if (working && !turn) {
    setTurn({ after: result?.key })
    setCheer(false)
  } else if (!working && turn && result && result.key !== turn.after) {
    setTurn(null)
    setCheer(result.result.ok)
  }
  useEffect(() => {
    if (!cheer) return
    const timer = setTimeout(() => setCheer(false), CHEER_MS)
    return () => clearTimeout(timer)
  }, [cheer])
  return cheer
}

/**
 * O texto do streaming saindo aos poucos, palavra a palavra, em vez dos saltos de cada delta: a cada
 * atualização (no máximo uma a cada `ms`) entra uma fração do que falta, para alcançar o recebido em
 * ~1/4 s. Com `ms` alto (resposta longa), cada atualização já mostra tudo, como antes.
 */
function useTyped(text: string, ms: number): string {
  const [shown, setShown] = useState(text)
  const last = useRef(0)
  // Outro trecho (ou o fim, vazio): não há o que digitar por cima, vai direto.
  if (!text.startsWith(shown)) setShown(text)
  useEffect(() => {
    if (shown === text || !text.startsWith(shown)) return
    const timer = setTimeout(
      () => {
        last.current = performance.now()
        let end = shown.length + Math.max(3, Math.ceil(((text.length - shown.length) * ms) / 250))
        // Para no fim de uma palavra, se estiver perto, para não cortar no meio dela.
        const space = text.indexOf(' ', end)
        if (space !== -1 && space - end < 12) end = space + 1
        setShown(text.slice(0, end))
      },
      Math.max(0, last.current + ms - performance.now()),
    )
    return () => clearTimeout(timer)
  }, [text, ms, shown])
  return shown
}

// O /clear apaga a tela de baixo para cima: cada item some em WIPE_MS, e o de cima começa WIPE_STEP depois.
const WIPE_STEP = 35
const WIPE_MS = 180
/** Quanto dura apagar `count` itens. */
export const wipeTime = (count: number) => (count ? (count - 1) * WIPE_STEP + WIPE_MS : 0)

export function MessageList({
  items,
  wipe,
  queued,
  sessionId,
  actionable,
  working,
  background,
  uses,
  cwd,
  onBranch,
}: {
  items: Item[]
  /** Um /clear apagando estes itens (ver `useWipe` em pages/chat.tsx): há quantos ms começou. */
  wipe?: number
  /** Bifurcar a conversa numa mensagem: nasce uma conversa nova com o histórico só até ali. */
  onBranch?: (at: string, text: string) => void
  /** Mensagens na fila do celular, ainda não entregues ao PC. */
  queued: OutboxItem[]
  sessionId: string
  /** Aprovações e perguntas só podem ser respondidas com a sessão aberta no painel. */
  actionable: boolean
  working: boolean
  /** O que ficou rodando em segundo plano depois da resposta (monitores, comandos, subagentes). */
  background: BackgroundTask[]
  uses: Map<string, Extract<PanelEvent, { kind: 'tool_use' }>>
  /** Pasta do projeto: os arquivos alterados aparecem com o caminho a partir dela. */
  cwd?: string
}) {
  const gallery = useMemo(() => galleryOf(items, sessionId), [items, sessionId])
  const turns = useMemo(() => turnsOf(items), [items])
  const lastAnswers = useMemo(() => lastAnswersOf(items), [items])
  const isFresh = useArrivals(sessionId, items.map((i) => i.key))
  // Conversa saindo da tela cala a leitura dela; a de outra conversa aberta ao lado segue.
  useEffect(() => () => stopSpeakingIn(sessionId), [sessionId])
  return (
    // Tocar numa imagem abre a tela cheia passando pelas outras do mesmo lado da conversa.
    <GalleryContext value={gallery}>
      <div className="space-y-4 px-4 py-4">
        {items.map((item, i) => (
          // `data-item`: o mapa mental leva até aqui ao tocar num nó.
          <div
            key={item.key}
            data-item={item.key}
            className={cn('scroll-mt-16 rounded-xl', wipe !== undefined && 'chat-wipe')}
            style={
              wipe !== undefined
                ? { animationDuration: `${WIPE_MS}ms`, animationDelay: `${(items.length - 1 - i) * WIPE_STEP - wipe}ms` }
                : undefined
            }
          >
            {/* A mensagem do usuário substitui o balão da fila, que já entrou animado, e a resposta, o texto
                do streaming: as duas entram paradas, para não piscar. O resto chega com animação. */}
            <Arrival fresh={item.type !== 'user' && item.type !== 'assistant' && isFresh(item.key)}>
              <ItemView
                item={item}
                sessionId={sessionId}
                actionable={actionable}
                onBranch={onBranch}
                turn={turns.get(item.key)}
                cwd={cwd}
                fresh={isFresh(item.key)}
                signed={lastAnswers.has(item.key)}
              />
            </Arrival>
          </div>
        ))}
        {queued.map((item) => (
          <QueuedBubble key={item.id} item={item} sessionId={sessionId} />
        ))}
        {wipe === undefined && (
          <>
            <LiveTail sessionId={sessionId} working={working} items={items} />
            {/* Fica na tela também durante os turnos: num monitor, cada novidade acorda o Claude. */}
            <BackgroundTasks sessionId={sessionId} tasks={background} uses={uses} actionable={actionable} />
          </>
        )}
      </div>
    </GalleryContext>
  )
}
