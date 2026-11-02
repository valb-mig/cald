import {
  ArrowLeft,
  Bot,
  ChevronDown,
  Columns2,
  Copy,
  EllipsisVertical,
  GitFork,
  ListChecks,
  Lock,
  LockOpen,
  Maximize2,
  Minimize2,
  LogOut,
  MessagesSquare,
  Monitor,
  Network,
  Pencil,
  Pin,
  PinOff,
  Smartphone,
  Server,
  Trash2,
  Volume2,
  VolumeOff,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Link } from 'wouter'
import { AgentSheet } from '@/components/agents/agent-sheet'
import { AgentsSheet } from '@/components/agents/agents-sheet'
import { AgentsContext, agentTree } from '@/components/agents/model'
import { ApprovalCard } from '@/components/chat/approval-card'
import { Composer } from '@/components/chat/composer'
import { buildItems, type Item, type Keyed } from '@/components/chat/items'
import { MessageList } from '@/components/chat/message-list'
import { QuestionCard } from '@/components/chat/question-card'
import { SpeechPlayer } from '@/components/chat/speech-player'
import { StickyPrompt } from '@/components/chat/sticky-prompt'
import { SummarySheet } from '@/components/chat/summary-sheet'
import { toolsIn } from '@/components/chat/turn'
import { Claudinho } from '@/components/claudinho'
import { ClaudinhoNameDialog } from '@/components/claudinho-name'
import { DeleteSessionDialog } from '@/components/delete-session-dialog'
import { MindMap } from '@/components/mindmap/mind-map'
import { mindTree } from '@/components/mindmap/model'
import { MapPane } from '@/components/mindmap/pane'
import { ProjectPanelButton } from '@/components/project/panel'
import { useChatDisplay } from '@/components/mindmap/view'
import { RepoLink } from '@/components/repo-link'
import { SessionPicker } from '@/components/session-picker'
import { StateBadge } from '@/components/state-badge'
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { api, errorMessage } from '@/lib/api'
import { dropTools, publishTools } from '@/lib/chat-tools'
import { claudinhoName } from '@/lib/claudinho'
import { projectName, stateInfo } from '@/lib/format'
import { useGitStatus, useHome, usePressMenu, useWide, useWidth } from '@/lib/hooks'
import { useBackToClose } from '@/lib/back-close'
import { useShowProject } from '@/lib/project-panel'
import { keyOf, pinTab } from '@/lib/workbench'
import { useGlass, useScrim } from '@/lib/wallpaper'
import { setZen, useZen } from '@/lib/zen'
import { putDraft } from '@/lib/drafts'
import { enqueue, useOutbox } from '@/lib/outbox'
import { clearNotifications } from '@/lib/push'
import { setAutoSpeech, speakNew, speechSupported, useSpeech } from '@/lib/speech'
import { useMachine, useMachines } from '@/lib/machines'
import { CHAT_DRAG, closeChat, openBeside, swapChat, useDraggingChat, usePane, useSplit } from '@/lib/split'
import { onLiveEvent, selectView, subscribe, unsubscribe, useStore } from '@/lib/store'
import type { ContextUsage, LoggedEvent, RunOptions } from '@/lib/types'
import { backHref } from '@/lib/tabs'
import { cn } from '@/lib/utils'
import { useActivityPing } from '@/lib/wakatime'

/**
 * Histórico salvo da conversa. Com a sessão aberta no painel, o servidor devolve só o que
 * existia antes do processo (o resto vem ao vivo). Aberta no PC, atualiza periodicamente.
 */
function useHistory(id: string, machine: string, panelOpen: boolean, pcOwned: boolean, pcWorking: boolean) {
  const [events, setEvents] = useState<LoggedEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)

  const load = useCallback(async () => {
    const ticket = ++latest.current
    try {
      const result = await api.history(id)
      if (ticket === latest.current) {
        setEvents(result)
        setError(null)
      }
    } catch (err) {
      if (ticket === latest.current) setError(errorMessage(err))
    }
    // A máquina muda quando o catálogo dela chega (conversa aberta por link direto): busca de novo lá.
  }, [id, machine])

  useEffect(() => {
    void load()
  }, [load, panelOpen])

  useEffect(() => {
    if (!pcOwned) return
    const timer = setInterval(load, pcWorking ? 4_000 : 15_000)
    return () => clearInterval(timer)
  }, [load, pcOwned, pcWorking])

  return { events, error }
}

/** Ocupação do contexto da sessão aberta no painel; relida a cada turno concluído. */
function useContextUsage(id: string, enabled: boolean, turns: number): ContextUsage | null {
  const [context, setContext] = useState<ContextUsage | null>(null)
  useEffect(() => {
    if (!enabled) return setContext(null)
    api.context(id).then(setContext, () => {})
  }, [id, enabled, turns])
  return context
}

/**
 * Tarja no topo de uma conversa bifurcada: diz de onde ela veio e que o histórico logo abaixo é
 * herdado — está ali para consulta, e só o que for mandado daqui segue nesta conversa. Tocar leva
 * à original, que continua intacta.
 */
function ForkBanner({ from }: { from: { sessionId: string; title?: string } }) {
  return (
    <Link
      href={`/s/${from.sessionId}`}
      className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50"
    >
      <GitFork className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">
        Bifurcada de <span className="font-medium text-foreground">{from.title || 'outra conversa'}</span>. O histórico abaixo veio de lá,
        só para consulta; o que você mandar daqui segue nesta conversa.
      </span>
    </Link>
  )
}

/** Chave de um evento ao vivo no chat; a resposta lida sozinha precisa da mesma, para o destaque. */
const liveKey = (runId: string | undefined, seq: number) => `l${runId}-${seq}`

// Preferência (o "cadeado") de acompanhar o fim da conversa; vale para todas as sessões.
const FOLLOW_KEY = 'cr:chat-follow'

/**
 * Mantém o feed acompanhando o fim da conversa, de forma robusta.
 * - `follow` (o cadeado) liga/desliga o acompanhamento automático e fica salvo.
 * - Ligado, novas mensagens, streaming, imagens e blocos que crescem grudam no fim. Se o usuário
 *   rola para cima para ler, pausa até ele voltar ao fim (ou tocar em "descer").
 * - `atBottom` diz se já dá para esconder o botão flutuante de "descer".
 */
function useAutoScroll(deps: unknown[]) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [follow, setFollowState] = useState(() => {
    try {
      return localStorage.getItem(FOLLOW_KEY) !== '0'
    } catch {
      return true
    }
  })
  const [atBottom, setAtBottom] = useState(true)
  // Rolou para cima para ler: segura o acompanhamento até voltar ao fim.
  const paused = useRef(false)

  const nearBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior })
  }, [])

  const onScroll = useCallback(() => {
    const near = nearBottom()
    paused.current = !near
    setAtBottom(near)
  }, [nearBottom])

  // Conteúdo cresceu (markdown, imagens, atividade): gruda no fim se estiver acompanhando.
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const observer = new ResizeObserver(() => {
      if (follow && !paused.current) scrollToBottom()
      setAtBottom(nearBottom())
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [follow, nearBottom, scrollToBottom])

  // Novo item/turno/streaming: gruda no fim se estiver acompanhando.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && follow && !paused.current) el.scrollTop = el.scrollHeight
  }, deps)

  const jumpToBottom = useCallback(() => {
    paused.current = false
    scrollToBottom('smooth')
    setAtBottom(true)
  }, [scrollToBottom])

  const setFollow = useCallback(
    (next: boolean) => {
      try {
        localStorage.setItem(FOLLOW_KEY, next ? '1' : '0')
      } catch {
        // localStorage indisponível (modo privado): segue só em memória.
      }
      setFollowState(next)
      if (next) {
        paused.current = false
        scrollToBottom('smooth')
        setAtBottom(true)
      }
    },
    [scrollToBottom],
  )

  return { scrollRef, contentRef, onScroll, atBottom, follow, setFollow, jumpToBottom }
}

/**
 * O véu atrás da conversa, na cor do fundo e com um leve desfoque: puxa a cena de volta para o fundo
 * do app, para o texto ficar legível. Mais largo que a coluna de texto (48rem) para o esfumaçado das
 * laterais cair fora dela, e não atrás das letras.
 */
function Veil({ scrim }: { scrim: string }) {
  return (
    <div
      aria-hidden
      // A máscara esfumaça as laterais: sem ela o véu vira um retângulo com borda dura no meio da cena.
      className={cn(
        'pointer-events-none absolute inset-y-0 left-1/2 w-full max-w-[56rem] -translate-x-1/2 backdrop-blur-[1.5px]',
        '[mask-image:linear-gradient(90deg,transparent,#000_7%,#000_93%,transparent)]',
        scrim,
      )}
    />
  )
}

export function ChatPage({ id }: { id: string }) {
  // Com conversas lado a lado (ver lib/split.ts), cada ação mexe só neste lugar da tela.
  const pane = usePane()
  // No PC as conversas ficam em abas (ver lib/workbench.ts): a aba é que se arrasta, fecha e marca o foco.
  const tabs = useWide()
  const handle = pane.split && !tabs
  const split = useSplit()
  const [besideOpen, setBesideOpen] = useState(false)
  const view = useStore(selectView(id))
  const entry = useStore((s) => s.catalog.find((c) => c.sessionId === id))
  // Máquina da conversa (posta pelo ChatSplit, ver machines.ts): tudo desta tela vai para ela.
  const machine = useMachine()
  const machineLabel = useMachines((s) => (s.machines.length > 1 ? s.machines.find((m) => m.id === machine)?.name : undefined))
  const rekeyed = useStore((s) => s.rekeys[id])
  // O tempo que você passa nesta conversa conta no WakaTime, como o do Claude (ver lib/wakatime.ts).
  useActivityPing(machine, entry?.cwd)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [confirmTakeover, setConfirmTakeover] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  // O nome do claudinho: botão direito (ou o dedo segurado) no claudinho do cabeçalho.
  const [naming, setNaming] = useState(false)
  const nameMenu = usePressMenu(() => setNaming(true))
  const name = claudinhoName(id, entry?.claudinhoName)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [agentId, setAgentId] = useState<string | null>(null)
  const home = useHome(machine)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    subscribe(id)
    return () => unsubscribe(id)
  }, [id])

  // Conversa na tela: os avisos dela na barra de notificações já foram vistos.
  useEffect(() => {
    const clear = () => document.visibilityState === 'visible' && void clearNotifications(id).catch(() => {})
    clear()
    document.addEventListener('visibilitychange', clear)
    return () => document.removeEventListener('visibilitychange', clear)
  }, [id])

  useEffect(() => {
    if (!rekeyed) return
    // Bifurcação: o texto esperava o ID novo para virar rascunho da conversa que nasceu.
    if (branched.current !== null) {
      void putDraft(rekeyed, { text: branched.current, attachments: [] })
      branched.current = null
    }
    swapChat(id, rekeyed, true)
  }, [rekeyed, id])

  // Leitura automática (o alto-falante no topo): as respostas que chegam ao vivo, nunca o histórico.
  const autoSpeech = useSpeech((s) => s.auto.includes(id))
  useEffect(
    () =>
      onLiveEvent((sessionId, runId, e) => {
        if (sessionId === id && e.kind === 'assistant' && !e.parentToolUseId) speakNew(id, `${id}:${liveKey(runId, e.seq)}`, e.text)
      }),
    [id],
  )

  // O WebSocket sabe primeiro quando o processo do painel abre ou fecha; o catálogo cobre o resto.
  const panelOpen = view.open === true || (view.open === null && entry?.owner === 'panel')
  const owner = panelOpen ? 'panel' : entry?.owner === 'pc' ? 'pc' : null
  const state = panelOpen ? view.state : entry?.state
  const waitingFor = panelOpen ? view.waitingFor : entry?.waitingFor
  const working = panelOpen && (state === 'running' || state === 'starting')

  const history = useHistory(id, machine, panelOpen, owner === 'pc', entry?.state === 'running')

  const events: Keyed[] = useMemo(
    () => [
      ...(history.events ?? []).map((e, i) => ({ ...e, key: `h${i}` })),
      ...(panelOpen ? view.events.map((e) => ({ ...e, key: liveKey(view.runId, e.seq) })) : []),
    ],
    [history.events, panelOpen, view.events, view.runId],
  )
  const items = useMemo(() => buildItems(events), [events])
  // O painel de comandos (barra de status, no PC) lê daqui o que esta conversa rodou.
  const tools = useMemo(() => toolsIn(items.flatMap((i) => (i.type === 'activity' ? i.entries : []))), [items])
  useEffect(() => publishTools(id, tools), [id, tools])
  useEffect(() => () => dropTools(id), [id])
  // Subagentes da conversa; sem processo cuidando dela (no painel ou no PC), quem não terminou parou.
  const agents = useMemo(() => agentTree(items, panelOpen || owner === 'pc'), [items, panelOpen, owner])
  const agentsContext = useMemo(() => ({ tree: agents, open: setAgentId }), [agents])
  const agentsWorking = agents.count.running + agents.count.waiting
  // O que roda em segundo plano agora (monitores, comandos, subagentes): a última lista do processo do painel.
  const background = useMemo(() => {
    if (!panelOpen) return []
    const last = view.events.findLast((e) => e.kind === 'tasks')
    return last?.kind === 'tasks' ? last.tasks : []
  }, [panelOpen, view.events])
  // Chamadas de ferramenta, para o cartão de segundo plano mostrar o comando e o tipo de cada tarefa.
  const uses = useMemo(() => new Map(events.flatMap((e) => (e.kind === 'tool_use' ? [[e.id, e] as const] : []))), [events])
  // Turno encerrado com algo em segundo plano: a conversa ainda trabalha (como na lista de conversas).
  const inBackground = state === 'idle' && background.length > 0
  const shownState = state === 'idle' && (agentsWorking || inBackground) ? 'running' : state
  const shownWaiting = inBackground ? 'background' : waitingFor
  const outbox = useOutbox((s) => s.items)
  const queued = useMemo(() => {
    // O evento da mensagem costuma chegar pelo WebSocket antes da resposta do envio: aí ela já saiu da fila.
    const delivered = new Set(view.events.flatMap((e) => (e.kind === 'user' && e.clientId ? [e.clientId] : [])))
    return outbox.filter((i) => i.sessionId === id && !delivered.has(i.id))
  }, [outbox, id, view.events])
  const turns = useMemo(() => view.events.filter((e) => e.kind === 'result').length, [view.events])
  const context = useContextUsage(id, panelOpen, turns)
  // Com projeto (não a pasta pessoal): explorador de arquivos e git no topo.
  const project = entry?.cwd && home && entry.cwd !== home ? entry.cwd : undefined
  const git = useGitStatus(machine, project, turns)
  // A barra do projeto, à direita, mostra o da conversa em foco (ver lib/project-panel.ts).
  useShowProject(machine, project, id, pane.focused)
  // Conversa parada: modelo/esforço/modo escolhidos agora valem quando ela for retomada.
  const [pending, setPending] = useState<RunOptions>({})
  // Texto da mensagem bifurcada, esperando o ID que o rekey vai trazer.
  const branched = useRef<string | null>(null)
  const glass = useGlass()
  const scrim = useScrim()
  const zen = useZen((s) => s.id === id)
  // Esc no PC e o voltar do celular saem do zen antes de sair da conversa.
  useBackToClose(zen, () => setZen(null))
  useEffect(() => {
    if (!zen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setZen(null)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [zen])
  const { scrollRef, contentRef, onScroll, atBottom, follow, setFollow, jumpToBottom } = useAutoScroll([
    items.length,
    queued.length,
    view.streaming,
    history.events === null,
  ])

  // Mapa mental (components/mindmap): no lugar do chat ou, com espaço, ao lado dele.
  const [display, setDisplay] = useChatDisplay()
  const areaRef = useRef<HTMLDivElement>(null)
  const roomy = useWidth(areaRef) >= 1000
  const shown = display === 'both' && !roomy ? 'map' : display
  const stateLabel = stateInfo(shownState, shownWaiting).label
  const mapRoot = useMemo(
    () => (shown === 'chat' ? null : mindTree({ items, title: entry?.title ?? 'Conversa', rootMeta: stateLabel, working, streaming: view.streaming, agents })),
    [shown, items, entry?.title, stateLabel, working, view.streaming, agents],
  )
  // Aprovações e perguntas esperando: com só o mapa na tela, ficam acima do campo de mensagem.
  const requests = useMemo(
    () => items.filter((i): i is Extract<Item, { type: 'approval' | 'question' }> => (i.type === 'approval' || i.type === 'question') && !i.resolution),
    [items],
  )
  const dockRef = useRef<HTMLDivElement>(null)
  const flash = (el: HTMLElement | null | undefined) => {
    if (!el) return
    el.classList.remove('flash-item')
    void el.offsetWidth // recomeça a animação se já estava piscando
    el.classList.add('flash-item')
  }
  // Do mapa para o ponto do chat: o chat continua montado por baixo, então o item já está lá.
  const jumpTo = (key: string) => {
    if (shown === 'map') setDisplay('chat')
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(key)}"]`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      flash(el)
    })
  }
  const openRequest = (key: string) => (shown === 'map' ? flash(dockRef.current) : jumpTo(key))

  /** A aba desta conversa deixa de ser prévia (no celular não há abas, e não faz nada). */
  const pin = () => pinTab(keyOf({ kind: 'chat', id }))

  const resumeCommand = entry?.cwd ? `cd '${entry.cwd}' && claude --resume ${id}` : `claude --resume ${id}`

  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true)
    try {
      await action()
      if (success) toast.success(success)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const release = () =>
    run(async () => {
      const { resumeCommand: cmd } = await api.release(id)
      toast.success('Sessão liberada. No PC, rode:', {
        description: cmd,
        duration: 15_000,
        action: { label: 'Copiar', onClick: () => navigator.clipboard.writeText(cmd) },
      })
    })

  const fork = () =>
    run(async () => {
      const { sessionId } = await api.open(id, { fork: true })
      swapChat(id, sessionId)
    })

  /**
   * Bifurcar numa mensagem sua: nasce uma conversa com o histórico só até antes dela, e o texto
   * volta para o campo para você reescrever e mandar por outro caminho. A original fica intacta na
   * lista, que é a graça — dá para comparar as duas respostas depois.
   *
   * O ID da bifurcação só chega no `init` da sessão, pelo rekey, e não na resposta do POST, que
   * ainda traz o antigo; por isso o texto espera em `branched` até saber onde virar rascunho.
   */
  const branch = (at: string, text: string) =>
    run(async () => {
      branched.current = text
      const { sessionId } = await api.open(id, { fork: true, at })
      if (sessionId !== id) {
        branched.current = null
        // Síncrono em memória, então a conversa nova já abre com o texto no campo.
        void putDraft(sessionId, { text, attachments: [] })
        swapChat(id, sessionId)
      }
      toast.success('Conversa bifurcada', { description: 'A original continua na lista, com tudo o que já estava escrito.' })
    })

  return (
    <AgentsContext value={agentsContext}>
      <div className="flex min-h-0 flex-1 flex-col">
        <header
          // Lado a lado, o topo é a alça: arrastar por ele leva a conversa para outro lugar da tela.
          draggable={handle}
          onDragStart={(e) => {
            e.dataTransfer.setData(CHAT_DRAG, id)
            e.dataTransfer.effectAllowed = 'move'
            useDraggingChat.setState({ id })
          }}
          onDragEnd={() => useDraggingChat.setState({ id: null })}
          className={cn(
            // No PC, sem linha: a aba aberta desce até ele, na mesma cor.
            'flex shrink-0 items-center gap-1 border-b bg-background px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 compact:py-1 wide:border-b-0',
            // Com o fundo animado, a borda de baixo esfumaça para a cena, em vez de cortar reto.
            glass &&
              'wide:relative wide:z-10 wide:after:pointer-events-none wide:after:absolute wide:after:inset-x-0 wide:after:top-full wide:after:h-6 wide:after:bg-linear-to-b wide:after:from-background wide:after:to-transparent',
            zen && 'hidden',
            handle && 'cursor-grab active:cursor-grabbing',
            // Lado a lado: a conversa em foco (a que recebe o que é escolhido na lista) ganha uma faixa no topo.
            handle && pane.focused && 'shadow-[inset_0_2px_0_var(--color-primary)]',
          )}
        >
          {/* No PC a lista de conversas já está ao lado. */}
          <Button variant="ghost" size="icon" asChild aria-label="Voltar" className="wide:hidden">
            <Link href={backHref()}>
              <ArrowLeft />
            </Link>
          </Button>
          <span {...nameMenu} className="mx-1 flex shrink-0 select-none [-webkit-touch-callout:none]">
            <Claudinho seed={id} name={name} state={shownState} size={30} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {/* No cabeçalho porque é o único lugar sempre à vista: a tarja lá embaixo fica no topo
                  de um histórico longo, que a conversa nem chega a mostrar ao abrir. */}
              {entry?.forkedFrom && (
                <GitFork
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-label={`Bifurcada de ${entry.forkedFrom.title || 'outra conversa'}`}
                />
              )}
              <div className="truncate text-sm font-medium">{entry?.title ?? 'Sessão'}</div>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="shrink-0 font-medium text-foreground/70">{name}</span>
              <span>·</span>
              <span className="min-w-0 truncate">{projectName(entry?.cwd)}</span>
              {machineLabel && (
                <span className="flex shrink-0 items-center gap-0.5">
                  <Server className="size-3" />
                  {machineLabel}
                </span>
              )}
              {owner === 'pc' && <Monitor className="size-3 shrink-0" />}
              {owner === 'panel' && <Smartphone className="size-3 shrink-0" />}
              <StateBadge state={shownState} waitingFor={shownWaiting} className="h-5 shrink-0 px-1.5 text-[10px]" />
            </div>
          </div>
          {speechSupported && (
            <Button
              variant={autoSpeech ? 'default' : 'ghost'}
              size="icon"
              className={cn(autoSpeech && 'rounded-full')}
              onClick={() => {
                setAutoSpeech(id, !autoSpeech)
                if (autoSpeech) toast('Leitura automática desligada')
                else toast('Leitura automática ligada', { description: 'As respostas novas do Claude serão lidas em voz alta.' })
              }}
              aria-pressed={autoSpeech}
              aria-label={autoSpeech ? 'Leitura automática ligada: tocar para desligar' : 'Ler as respostas novas em voz alta'}
            >
              {autoSpeech ? <Volume2 /> : <VolumeOff />}
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={() => setZen(id)} aria-label="Modo zen: só esta conversa na tela" title="Modo zen">
            <Minimize2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDisplay(shown === 'chat' ? 'map' : 'chat')}
            aria-pressed={shown !== 'chat'}
            aria-label={shown === 'chat' ? 'Ver como mapa mental' : 'Voltar ao chat'}
            title={shown === 'chat' ? 'Mapa mental' : 'Chat'}
          >
            {shown === 'chat' ? <Network /> : <MessagesSquare />}
          </Button>
          {agents.all.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="relative"
              onClick={() => setAgentsOpen(true)}
              aria-label={`Agentes: ${agentsWorking} trabalhando de ${agents.all.length}`}
            >
              <Bot />
              {agentsWorking > 0 && (
                <span
                  className={cn(
                    'absolute top-0.5 right-0 min-w-4 rounded-full px-1 text-center text-[9px] leading-4 font-semibold text-white',
                    agents.count.waiting ? 'bg-amber-600' : 'bg-sky-600',
                  )}
                >
                  {agentsWorking}
                </span>
              )}
            </Button>
          )}
          {project && git.status?.remote && <RepoLink url={git.status.remote} />}
          {project && <ProjectPanelButton changes={git.status?.files.length ?? 0} />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Mais ações">
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              {owner === 'panel' && (
                <DropdownMenuItem disabled={busy || state === 'running' || state === 'waiting' || agentsWorking > 0} onSelect={release}>
                  <LogOut /> Liberar para o PC
                </DropdownMenuItem>
              )}
              {owner === 'pc' && (
                <DropdownMenuItem disabled={busy || state !== 'idle'} onSelect={() => setConfirmTakeover(true)}>
                  <Smartphone /> Assumir sessão
                </DropdownMenuItem>
              )}
              {owner !== 'panel' && (
                <DropdownMenuItem disabled={busy} onSelect={fork}>
                  <GitFork /> Continuar numa cópia
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setSummaryOpen(true)}>
                <ListChecks /> Resumo da sessão
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  split.canAdd
                    ? setBesideOpen(true)
                    : toast(`Cabem ${split.max} conversas lado a lado nesta tela. Feche uma para abrir outra.`)
                }
              >
                <Columns2 /> Abrir outra ao lado
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={busy || !entry}
                onSelect={() => run(() => api.pin(id, !entry?.pinned), entry?.pinned ? 'Desafixada' : 'Fixada no topo')}
              >
                {entry?.pinned ? <PinOff /> : <Pin />} {entry?.pinned ? 'Desafixar' : 'Fixar no topo'}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onSelect={() => setRenaming(entry?.title ?? '')}>
                <Pencil /> Renomear
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigator.clipboard.writeText(resumeCommand).then(() => toast.success('Comando copiado'))}>
                <Copy /> Copiar comando de retomada
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={busy || owner === 'pc'} onSelect={() => setConfirmDelete(true)}>
                <Trash2 /> {owner === 'pc' ? 'Apagar (feche no PC antes)' : 'Apagar conversa'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {handle && (
            <Button variant="ghost" size="icon" onClick={() => closeChat(id)} aria-label="Tirar esta conversa da tela">
              <X />
            </Button>
          )}
        </header>

        <div
          ref={areaRef}
          className={cn(
            'relative flex min-h-0 flex-1',
            // Sem o cabeçalho, quem segura a conversa longe do entalhe do celular é isto.
            zen && 'pt-[env(safe-area-inset-top)]',
            pane.collapsed && 'hidden',
          )}
        >
          {/* Só o mapa: o chat segue montado por baixo (o mapa pula para os pontos dele), mas some de
              vista, senão apareceria através do mapa quando ele fica transparente sobre o fundo animado. */}
          <div className={cn('relative min-w-0 flex-1', shown === 'map' && 'invisible')} inert={shown === 'map'}>
            {/* A lâmina de vidro embaixo da coluna de mensagens: desfoca a cena atrás do texto, e as
                margens seguem nítidas. Fica fora do scroller de propósito — dentro dele, o desfoque
                seria recalculado a cada quadro de rolagem em vez de só quando a cena muda. */}
            {glass && <Veil scrim={scrim} />}
            <StickyPrompt scrollRef={scrollRef} items={items} />
            <div ref={scrollRef} onScroll={onScroll} className="absolute inset-0 overflow-y-auto">
              <div ref={contentRef} className="mx-auto w-full max-w-3xl">
                {entry?.forkedFrom && <ForkBanner from={entry.forkedFrom} />}
                {history.events === null && !history.error ? (
                  <div className="space-y-4 p-4">
                    <Skeleton className="ml-auto h-10 w-2/3" />
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-16 w-full" />
                  </div>
                ) : (
                  <>
                    {history.error && <p className="p-4 text-sm text-red-600 dark:text-red-400">{history.error}</p>}
                    {items.length === 0 && queued.length === 0 && !working && !history.error && (
                      <p className="p-4 text-center text-sm text-muted-foreground">Nenhuma mensagem ainda.</p>
                    )}
                    <MessageList
                      items={items}
                      queued={queued}
                      sessionId={id}
                      actionable={panelOpen}
                      streaming={view.streaming}
                      working={working}
                      background={background}
                      uses={uses}
                      cwd={entry?.cwd}
                      onBranch={branch}
                    />
                  </>
                )}
              </div>
            </div>

            {zen && (
              // Onde o cabeçalho estava. Fica sempre na tela, só apagado: um botão que some de vez
              // deixaria sem saída quem não sabe do Esc nem do voltar.
              <Button
                variant="secondary"
                size="icon"
                onClick={() => setZen(null)}
                aria-label="Sair do modo zen"
                title="Sair do modo zen"
                className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-3 z-20 size-9 rounded-full border opacity-30 shadow-lg transition-opacity hover:opacity-100 focus-visible:opacity-100"
              >
                <Maximize2 />
              </Button>
            )}
            <div className="pointer-events-none absolute right-3 bottom-3 z-10 flex flex-col items-end gap-2">
              {!atBottom && (
                <Button
                  variant="secondary"
                  size="icon"
                  onClick={jumpToBottom}
                  aria-label="Ir para a última mensagem"
                  className="pointer-events-auto size-10 rounded-full border shadow-lg"
                >
                  <ChevronDown />
                </Button>
              )}
              <Button
                variant="secondary"
                size="icon"
                onClick={() => setFollow(!follow)}
                aria-pressed={follow}
                aria-label={follow ? 'Acompanhando o fim: tocar para soltar o scroll' : 'Scroll solto: tocar para travar no fim'}
                className={cn(
                  'pointer-events-auto size-9 rounded-full border shadow-md backdrop-blur',
                  follow ? 'bg-background/70 text-muted-foreground' : 'bg-background text-foreground',
                )}
              >
                {follow ? <Lock /> : <LockOpen />}
              </Button>
            </div>
          </div>
          {mapRoot && (
            <MapPane beside={shown === 'both'}>
              <MindMap
                root={mapRoot}
                title={entry?.title ?? 'Conversa'}
                onJump={jumpTo}
                onAgent={setAgentId}
                onRequest={openRequest}
                side={roomy ? { on: shown === 'both', toggle: () => setDisplay(shown === 'both' ? 'map' : 'both') } : null}
              />
            </MapPane>
          )}
        </div>

        {/* Encolhida (celular em pé, digitando na outra): some sem desmontar, sem perder rascunho nem leitura. */}
        <div className={cn('relative flex shrink-0 flex-col', pane.collapsed && 'hidden')}>
          {/* O véu continua atrás da barra de texto até o fim da tela; sem isto ele parava no topo dela,
              e em volta da barra a cena aparecia sem escurecer. */}
          {glass && <Veil scrim={scrim} />}
          {/* Posicionado para ficar por cima do véu, que é absoluto. */}
          <div className="relative flex flex-col">
            {shown === 'map' && owner === 'panel' && requests.length > 0 && (
              <div
                ref={dockRef}
                className={cn(
                  'max-h-[45dvh] shrink-0 space-y-3 overflow-y-auto border-t px-4 py-3',
                  glass ? 'bg-background/70 backdrop-blur-md' : 'bg-background',
                )}
              >
                {requests.map((r) =>
                  r.type === 'approval' ? (
                    <ApprovalCard key={r.key} type={r.type} req={r.req} agent={r.agent} sessionId={id} actionable={panelOpen} />
                  ) : (
                    <QuestionCard key={r.key} type={r.type} req={r.req} sessionId={id} actionable={panelOpen} />
                  ),
                )}
              </div>
            )}
            <SpeechPlayer sessionId={id} />

            {owner === 'pc' ? (
              <div
                className={cn(
                  'shrink-0 space-y-2 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
                  glass && 'bg-background/70 backdrop-blur-md',
                )}
              >
                <p className="text-xs text-muted-foreground">
                  {state === 'idle'
                    ? 'Aberta no PC e ociosa. Assumir encerra a sessão no PC e a continua aqui, com todo o contexto.'
                    : 'Aberta no PC e ocupada. Dá para assumir quando ela ficar ociosa.'}
                </p>
                <Button className="h-11 w-full" disabled={busy || state !== 'idle'} onClick={() => setConfirmTakeover(true)}>
                  <Smartphone /> Assumir sessão
                </Button>
              </div>
            ) : owner === 'panel' ? (
              <Composer
                sessionId={id}
                cwd={entry?.cwd}
                branch={git.status?.branch}
                working={working || state === 'waiting'}
                // Logo após retomar, enquanto o primeiro evento de ajustes não chega, vale o que foi escolhido.
                settings={Object.keys(view.settings).length ? view.settings : pending}
                context={context}
                onChangeSettings={async (patch) => {
                  await api.settings(id, patch)
                }}
                onCompact={() => api.send(id, { text: '/compact' }).then(() => undefined)}
                // Escrever ou mandar mensagem numa aba de prévia a deixa aberta, como editar no VSCode.
                onEdit={pin}
                onSend={(text, attachments) => {
                  pin()
                  return enqueue(id, text, attachments)
                }}
                onInterrupt={() => api.interrupt(id).then(() => undefined)}
              />
            ) : (
              <Composer
                sessionId={id}
                cwd={entry?.cwd}
                branch={git.status?.branch}
                working={false}
                hint="Enviar retoma esta conversa aqui pelo celular."
                settings={pending}
                context={null}
                onChangeSettings={(patch) => setPending((p) => ({ ...p, ...patch }))}
                onEdit={pin}
                onSend={(text, attachments) => {
                  pin()
                  return enqueue(id, text, attachments, pending)
                }}
              />
            )}
          </div>
        </div>

        <SummarySheet sessionId={id} events={events} cwd={entry?.cwd} context={context} open={summaryOpen} onOpenChange={setSummaryOpen} />
        <AgentsSheet
          tree={agents}
          rootLabel={stateInfo(shownState, shownWaiting).label}
          open={agentsOpen}
          onOpenChange={setAgentsOpen}
          onOpenAgent={setAgentId}
        />
        <AgentSheet
          sessionId={id}
          node={agentId ? agents.byId.get(agentId) : undefined}
          onOpenChange={(o) => !o && setAgentId(null)}
          onOpen={setAgentId}
        />
        <SessionPicker open={besideOpen} onOpenChange={setBesideOpen} exclude={split.ids} onPick={(other) => openBeside(other, id)} />

        <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Renomear sessão</DialogTitle>
            </DialogHeader>
            <form
              id="rename"
              onSubmit={(e) => {
                e.preventDefault()
                const title = renaming?.trim()
                if (!title) return
                setRenaming(null)
                void run(() => api.rename(id, title), 'Título salvo')
              }}
            >
              <Input value={renaming ?? ''} onChange={(e) => setRenaming(e.target.value)} autoFocus maxLength={200} />
            </form>
            <p className="text-xs text-muted-foreground">O título vale também no /resume do terminal e no VSCode.</p>
            <DialogFooter>
              <Button type="submit" form="rename" disabled={!renaming?.trim()}>
                Salvar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <DeleteSessionDialog sessionId={id} open={confirmDelete} onOpenChange={setConfirmDelete} />
        <ClaudinhoNameDialog session={entry ?? { sessionId: id }} open={naming} onOpenChange={setNaming} />

        <AlertDialog open={confirmTakeover} onOpenChange={setConfirmTakeover}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Assumir esta sessão?</AlertDialogTitle>
              <AlertDialogDescription>
                A sessão aberta no PC será encerrada e a conversa continua aqui, com todo o contexto. Para voltar ao PC depois, use
                “Liberar para o PC”.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction onClick={() => run(() => api.takeover(id), 'Sessão assumida')}>Assumir</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </AgentsContext>
  )
}
