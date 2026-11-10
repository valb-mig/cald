import { Check, CircleAlert, Clock, Code, Copy, FilePen, FileText, Folder, GitFork, Info, Link2, ListTodo, Monitor, Pause, Play, RotateCw, Smartphone, SquareTerminal, X } from 'lucide-react'
import { toast } from 'sonner'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNow } from '@/components/agents/status'
import { ClaudeMark } from '@/components/claude-mark'
import { ImageThumb } from '@/components/image-viewer'
import { Markdown, StreamingMarkdown } from '@/components/markdown'
import { ReadingLine } from '@/components/reading-line'
import { Button } from '@/components/ui/button'
import { imageUrl, thumbUrl } from '@/lib/api'
import { claudinhoName } from '@/lib/claudinho'
import { duration, messageTime, toolDoing } from '@/lib/format'
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
import { linksOf, turnsOf, type ToolEntry, type TurnInfo } from './turn'
import { TurnDialog, type TurnSection } from './turn-dialog'

/** Um aviso curto no fio, sem os traços de divisória: só o que deu errado chega aqui. */
function Alert({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400', className)}>
      <CircleAlert className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 whitespace-pre-wrap">{children}</span>
    </div>
  )
}

/**
 * Marcos do fio que não aparecem: o turno que acabou bem ou foi interrompido, o contexto compactando, a
 * conversa limpa e o processo do painel que saiu sem erro. Continuam nos itens (os turnos e o
 * resumo contam com eles); na tela, a conversa fica só com as mensagens.
 */
const quiet = (item: Item) =>
  (item.type === 'result' && (item.result.ok || item.result.subtype === 'error_during_execution')) ||
  item.type === 'compacting' ||
  item.type === 'cleared' ||
  (item.type === 'exit' && !item.error)

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
function SentLine({ sent, className }: { sent: Sent; className?: string }) {
  const parts = [sent.via && VIA[sent.via], sent.device, sent.at !== undefined && messageTime(sent.at)].filter(Boolean)
  if (!parts.length) return null
  // Do app sem saber o aparelho (mensagens de antes de o edit.r guardar isso), fica sem ícone.
  const Icon = sent.via === 'terminal' ? SquareTerminal : sent.via === 'vscode' ? Code : sent.mobile ? Smartphone : sent.via === 'desktop' || sent.mobile === false ? Monitor : null
  return (
    <div
      className={cn('flex items-center gap-1 px-1 text-[11px] leading-none text-muted-foreground', className)}
      title={sent.at !== undefined ? new Date(sent.at).toLocaleString('pt-BR') : undefined}
    >
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
  // O bifurcar e o de onde saiu ficam escondidos, para a mensagem vir sozinha: no PC, voltam ao passar o
  // mouse (ou com o foco); no toque, que não tem isso, tocar na mensagem mostra e esconde.
  const [peek, setPeek] = useState(false)
  const toggle = () => {
    if (!matchMedia('(pointer: coarse)').matches || window.getSelection()?.toString()) return
    setPeek((p) => !p)
  }
  const extra = cn(
    'transition-opacity duration-150',
    peek ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:pointer-events-none',
  )
  return (
    <div className="group relative flex scroll-mt-16 flex-col items-end gap-2.5" data-user-msg={anchor}>
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
              className={cn('shrink-0 text-muted-foreground', extra)}
            >
              <GitFork />
            </Button>
          )}
          <div onClick={toggle} className="min-w-0 rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm whitespace-pre-wrap break-words text-primary-foreground">
            {withMentions(text)}
            {text && files?.length ? '\n\n' : null}
            {files?.map((name, i) => <FileChip key={i} name={name} title={name} />)}
          </div>
        </div>
      )}
      {/* Fora do fluxo, no vão até a próxima mensagem: aparecer não empurra nada. */}
      {sent && <SentLine sent={sent} className={cn('absolute top-full right-0 mt-0.5', extra)} />}
    </div>
  )
}

/** Mensagem que ainda não chegou ao PC: relógio enquanto espera, e o motivo se não deu para enviar. */
/**
 * `reason`: o motivo da falha por extenso. Várias seguidas pelo mesmo motivo dizem ele uma vez só, na
 * última; as outras ficam só com o sinal e os botões (o motivo inteiro fica na dica).
 */
function QueuedBubble({ item, sessionId, reason }: { item: OutboxItem; sessionId: string; reason: boolean }) {
  const connection = useStore((s) => s.connections[machineOf(sessionId)] ?? 'connecting')
  const images = item.attachments.flatMap((a) => (a.thumb ? [a.thumb] : []))
  const files = item.attachments.flatMap((a) => (a.thumb ? [] : [a.name]))
  const action = 'font-medium text-foreground underline-offset-2 hover:underline'
  const failed = item.status === 'failed'
  return (
    <div className="chat-pop space-y-1">
      {/* Não enviada fica apagada: ela ainda não faz parte da conversa. */}
      <div className={cn(failed && 'opacity-55')}>
        <UserBubble sessionId={sessionId} text={item.text} images={images} files={files} />
      </div>
      {failed ? (
        <div className="flex items-center justify-end gap-0.5 text-xs">
          <span title={item.error} className="flex min-w-0 items-center gap-1 pr-1 text-red-600 dark:text-red-400">
            <CircleAlert className="size-3.5 shrink-0" />
            <span className="truncate">{reason ? item.error : 'Não enviada'}</span>
          </span>
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={() => retryItem(item.id)} title="Tentar de novo" aria-label="Tentar de novo">
            <RotateCw />
          </Button>
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={() => discard(item.id)} title="Descartar" aria-label="Descartar">
            <X />
          </Button>
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
function CopyMarkdown({ text, compact = false }: { text: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <Button
      variant={compact ? 'ghost' : 'secondary'}
      size={compact ? 'icon-xs' : 'sm'}
      className={compact ? 'rounded-full text-muted-foreground' : 'rounded-full pr-3.5'}
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
      {!compact && (copied ? 'Copiado' : 'Copiar')}
    </Button>
  )
}

/**
 * Resposta do Claude (quem escreveu fica no alto da resposta, ver ReplyHeader). Na última de cada turno,
 * os atalhos do que o turno fez embaixo. Os atalhos, **Ouvir** e **Copiar** (em Markdown) só aparecem
 * com o mouse em cima da resposta (ou o foco do teclado nela), para a conversa ficar limpa; no celular,
 * sem mouse, ficam sempre à vista. Ouvir lê o texto em voz alta, e o trecho sendo lido fica em destaque (a barra
 * de controle fica em cima da caixa de mensagem); lendo, o botão fica à vista. `fresh`: acabou de
 * chegar; o texto já estava na tela pelo streaming, então só os botões entram, logo depois.
 */
function AssistantMessage({
  id,
  sessionId,
  text,
  turn,
  cwd,
  fresh,
}: {
  id: string
  sessionId: string
  text: string
  turn?: TurnInfo
  cwd?: string
  fresh: boolean
}) {
  const state = useSpeech((s) => (s.reading?.key === id ? (s.reading.playing ? 'playing' : 'paused') : null))
  const line = useSpeech((s) => (s.reading?.key === id ? (s.reading.units[s.reading.index]?.line ?? null) : null))
  const links = useMemo(() => (turn ? linksOf(turn).length : 0), [turn])
  // A fileira de baixo só existe com os atalhos do turno.
  const row = Boolean(turn && (turn.files.length > 0 || turn.commands.length > 0 || links > 0))
  const hidden = !state && 'opacity-0 group-hover/answer:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100'
  const actions = (
    <>
      {speechSupported && (
        <Button variant={state ? 'default' : 'secondary'} size="sm" className="rounded-full pr-3.5" onClick={() => toggleSpeech(id, text)}>
          {state === 'playing' ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          {state === 'playing' ? 'Pausar' : state === 'paused' ? 'Continuar' : 'Ouvir'}
        </Button>
      )}
      <CopyMarkdown text={text} />
    </>
  )
  return (
    <div className="group/answer relative">
      <ReadingLine value={line}>
        <Markdown text={text} chat />
      </ReadingLine>
      {row ? (
        <Arrival fresh={fresh} delay={120} className="mt-2 flex flex-wrap items-center gap-1.5">
          {/* Os atalhos do turno vêm junto dos botões: só com o mouse em cima (no toque, sempre). */}
          <span className={cn('flex flex-wrap items-center gap-1.5 transition-opacity duration-150', hidden)}>
            {turn && <TurnShortcuts turn={turn} cwd={cwd} sessionId={sessionId} />}
            {actions}
          </span>
        </Arrival>
      ) : (
        // Sem a fileira (as respostas do meio do turno), os botões guardariam lugar embaixo só para aparecer
        // com o mouse. No PC, viram dois ícones no vão até o que vem depois, no canto de baixo: não cobrem
        // o texto nem empurram nada. No toque, sem mouse, ficam embaixo e sempre à vista, como na fileira.
        <Arrival fresh={fresh} delay={120}>
          <span className="mt-2 flex items-center gap-1.5 pointer-fine:hidden">{actions}</span>
          <span
            className={cn(
              'absolute top-full right-0 -mt-1 flex items-center pointer-coarse:hidden',
              'transition-opacity duration-150',
              !state && 'pointer-events-none opacity-0 group-hover/answer:pointer-events-auto group-hover/answer:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
            )}
          >
            {speechSupported && (
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn('rounded-full', state ? 'text-foreground' : 'text-muted-foreground')}
                onClick={() => toggleSpeech(id, text)}
                aria-label={state === 'playing' ? 'Pausar a leitura' : 'Ouvir a resposta'}
                title={state === 'playing' ? 'Pausar' : state === 'paused' ? 'Continuar' : 'Ouvir'}
              >
                {state === 'playing' ? <Pause className="fill-current" /> : <Play className="fill-current" />}
              </Button>
            )}
            <CopyMarkdown text={text} compact />
          </span>
        </Arrival>
      )}
    </div>
  )
}

/**
 * Com que a resposta foi escrita: a marca do Claude, o modelo e o esforço com que pensou, pequenos na
 * ponta direita do cabeçalho. O id completo do modelo fica na dica, para quando o nome curto não bastar.
 */
function WrittenBy({ model, effort }: { model: string; effort?: string }) {
  return (
    <span title={effort ? `${model} · esforço ${effort}` : model} className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/80">
      <ClaudeMark className="size-3" />
      {prettyModel(model)}
      {effort && ` · ${(EFFORTS[effort] ?? effort).toLowerCase()}`}
    </span>
  )
}

/**
 * Quem responde, no alto de cada resposta, como a foto e o nome de quem posta numa rede social: o
 * claudinho da conversa, o nome dele e, quando já se sabe, o modelo e o esforço do turno.
 */
function ReplyHeader({ sessionId, name, model, effort }: { sessionId: string; name: string; model?: string; effort?: string }) {
  return (
    // Um respiro a mais em cima: a resposta se separa da sua mensagem, como um post respondendo outro.
    <div className="mb-2 flex min-w-0 items-center justify-between gap-3 pt-2">
      <span className="flex min-w-0 items-center gap-2">
        <Claudinho seed={sessionId} size={22} />
        <span className="min-w-0 truncate text-sm font-medium">{name}</span>
      </span>
      {model && <WrittenBy model={model} effort={effort} />}
    </div>
  )
}

type Byline = { model?: string; effort?: string }

/**
 * Onde começa cada resposta (o primeiro item depois de uma mensagem sua, ou do começo da lista) e o
 * modelo com que ela foi escrita: o da última resposta do turno, como era a assinatura no pé dela.
 */
function replyHeads(items: Item[]): Map<string, Byline> {
  const heads = new Map<string, Byline>()
  let open: Byline | null = null
  for (const item of items) {
    if (item.type === 'user') {
      open = null
      continue
    }
    if (!open) heads.set(item.key, (open = {}))
    if (item.type === 'assistant' && item.model) {
      open.model = item.model
      open.effort = item.effort
    }
  }
  return heads
}

const failureLabel = (result: Extract<Item, { type: 'result' }>['result']) =>
  result.subtype === 'error_max_turns' ? 'Parou no limite de turnos' : 'Terminou com erro'

function ItemView({
  item,
  sessionId,
  actionable,
  onBranch,
  turn,
  cwd,
  fresh,
}: {
  item: Item
  sessionId: string
  actionable: boolean
  fresh: boolean
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
      return (
        // Os passos ficam um pouco recuados e um fio em L os liga à mensagem de cima (ou ao avatar, quando
        // abrem a resposta): sobe do centro do avatar (11px) pelo vão entre os dois, desce até o meio da
        // linha deles (16px) e para a 4px do ícone, que fica em 24px de recuo mais os 8px da linha.
        <div className="relative pl-6 before:pointer-events-none before:absolute before:-top-4 before:left-[10.5px] before:h-8 before:w-[17.5px] before:rounded-bl-[10px] before:border-b before:border-l before:border-foreground/15">
          <Activity sessionId={sessionId} entries={item.entries} summary />
        </div>
      )
    case 'approval':
      return <ApprovalCard {...item} sessionId={sessionId} actionable={actionable} />
    case 'question':
      return <QuestionCard {...item} sessionId={sessionId} actionable={actionable} />
    case 'result':
      return <Alert>{failureLabel(item.result)}</Alert>
    case 'exit':
      return <Alert className="text-red-600 dark:text-red-400">O processo do painel caiu: {item.error}</Alert>
    case 'compacting':
    case 'cleared':
      return null
  }
}

/** A tarefa em andamento no último TodoWrite do turno, na frase que o Claude deu a ela ("Corrigindo o arrasto"). */
function currentTask(items: Item[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.type === 'user') return undefined
    if (item.type !== 'activity') continue
    const todo = item.entries.findLast((e): e is ToolEntry => e.kind === 'tool' && e.use.name === 'TodoWrite')
    if (!todo) continue
    const todos = todo.use.input.todos
    const doing = Array.isArray(todos) ? todos.find((t) => t?.status === 'in_progress') : undefined
    return typeof doing?.activeForm === 'string' ? doing.activeForm : undefined
  }
}

/**
 * O que o Claude está fazendo agora, numa frase com uma onda clara passando: a ferramenta em uso
 * ("Lendo markdown.tsx", a descrição do comando) e há quanto tempo, para um comando longo não parecer
 * travado; sem nenhuma, a tarefa em andamento ou "Pensando…".
 */
function WorkingLine({ sessionId, items }: { sessionId: string; items: Item[] }) {
  const last = items.at(-1)
  const running = last?.type === 'activity' ? last.entries.findLast((e): e is ToolEntry => e.kind === 'tool' && !e.result) : undefined
  const task = useMemo(() => currentTask(items), [items])
  const now = useNow(Boolean(running?.at))
  const doing = running ? toolDoing(running.use.name, running.use.input) : (task ?? 'Pensando…')
  return (
    <div className="chat-enter flex min-w-0 items-center gap-2 text-xs text-muted-foreground" role="status">
      {/* O claudinho da conversa no lugar da estrelinha do Claude Code: rodando uma ferramenta, pula com o
          balão de "…"; sem nenhuma, fica com a mão no queixo, pensando. */}
      <Claudinho seed={sessionId} size={18} state="running" status thinking={!running} className={running ? 'claudinho-hop' : undefined} />
      <span className="doing-shimmer min-w-0 truncate">{doing}</span>
      {running?.at && <span className="shrink-0 tabular-nums">{duration(Math.max(0, now - running.at))}</span>}
    </div>
  )
}

/**
 * O fim da conversa enquanto o Claude trabalha: o texto que ele está escrevendo ou o "Trabalhando…".
 * É o único pedaço da lista que acompanha cada delta do streaming; o resto só muda com eventos.
 */
function LiveTail({ sessionId, working, items, head }: { sessionId: string; working: boolean; items: Item[]; head: string | null }) {
  const streaming = useStore((s) => s.streams[sessionId] ?? '')
  // A cada atualização, só o último bloco do markdown é reprocessado (ver StreamingMarkdown), mas a
  // lista dos blocos é refeita e cresce com a resposta: quanto maior ela fica, mais espaçadas as
  // atualizações (de uma por quadro até ~4 por segundo).
  const typed = useTyped(streaming, Math.max(16, Math.min(250, streaming.length / 40)))
  const cheer = useTurnCheer(working, items.findLast((i): i is ResultItem => i.type === 'result'))
  // Ao terminar vai direto para vazio: atrasado, o texto parcial ficaria na tela junto da resposta pronta.
  const text = streaming && typed
  // A resposta sem nenhum item ainda: o cabeçalho dela vem aqui, e fica no lugar quando o item chegar.
  const header = head !== null && <ReplyHeader sessionId={sessionId} name={head} />
  if (text)
    return (
      <div>
        {header}
        <StreamingMarkdown text={text} className="chat-enter opacity-90" chat />
      </div>
    )
  if (working)
    return (
      <div>
        {header}
        <WorkingLine sessionId={sessionId} items={items} />
      </div>
    )
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
export const wipeTime = (items: Item[]) => {
  // Só os que aparecem entram na conta (ver `quiet`).
  const count = items.filter((i) => !quiet(i)).length
  return count ? (count - 1) * WIPE_STEP + WIPE_MS : 0
}

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
  const shown = useMemo(() => items.filter((i) => !quiet(i)), [items])
  const turns = useMemo(() => turnsOf(items), [items])
  const heads = useMemo(() => replyHeads(shown), [shown])
  const name = claudinhoName(sessionId, useStore((s) => s.catalog.find((c) => c.sessionId === sessionId)?.claudinhoName))
  // A resposta que ainda não tem item na lista (o turno acabou de começar) põe o cabeçalho no fim ao vivo.
  const last = shown.at(-1)
  const tailHead = !last || last.type === 'user'
  const isFresh = useArrivals(sessionId, items.map((i) => i.key))
  // Conversa saindo da tela cala a leitura dela; a de outra conversa aberta ao lado segue.
  useEffect(() => () => stopSpeakingIn(sessionId), [sessionId])
  return (
    // Tocar numa imagem abre a tela cheia passando pelas outras do mesmo lado da conversa.
    <GalleryContext value={gallery}>
      <div className="space-y-4 px-4 py-4">
        {shown.map((item, i) => (
          // `data-item`: o "Responder" do agente em foco leva até aqui.
          <div
            key={item.key}
            data-item={item.key}
            className={cn('scroll-mt-16 rounded-xl', wipe !== undefined && 'chat-wipe')}
            style={
              wipe !== undefined
                ? { animationDuration: `${WIPE_MS}ms`, animationDelay: `${(shown.length - 1 - i) * WIPE_STEP - wipe}ms` }
                : undefined
            }
          >
            {/* Parado: ele já estava no fim ao vivo, desde que o turno começou. */}
            {heads.has(item.key) && <ReplyHeader sessionId={sessionId} name={name} {...heads.get(item.key)} />}
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
              />
            </Arrival>
          </div>
        ))}
        {queued.map((item, i) => (
          <QueuedBubble key={item.id} item={item} sessionId={sessionId} reason={item.status === 'failed' && queued[i + 1]?.error !== item.error} />
        ))}
        {wipe === undefined && (
          <>
            <LiveTail sessionId={sessionId} working={working} items={items} head={tailHead && !queued.length ? name : null} />
            {/* Fica na tela também durante os turnos: num monitor, cada novidade acorda o Claude. */}
            <BackgroundTasks sessionId={sessionId} tasks={background} uses={uses} actionable={actionable} />
          </>
        )}
      </div>
    </GalleryContext>
  )
}
