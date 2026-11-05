import {
  ArrowLeft,
  ChevronDown,
  Columns2,
  Copy,
  EllipsisVertical,
  ExternalLink,
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
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Link } from 'wouter'
import { AgentChat } from '@/components/agents/agent-chat'
import { AgentRail } from '@/components/agents/agent-rail'
import { TeamPill } from '@/components/teams/team-pill'
import { WorkspaceMenu, WorkspacePill } from '@/components/workspaces/workspace-pill'
import { AgentsContext, agentTree } from '@/components/agents/model'
import { ApprovalCard } from '@/components/chat/approval-card'
import { Composer } from '@/components/chat/composer'
import { liveKey, useAutoScroll, useConversation } from '@/components/chat/feed'
import { buildItems, type Item, type Keyed } from '@/components/chat/items'
import { MessageList } from '@/components/chat/message-list'
import { ChatTimeline } from '@/components/chat/timeline'
import { DropOverlay, useFileDrop } from '@/components/chat/file-drop'
import { attachInto } from '@/lib/compose'
import { PeerChip } from '@/components/chat/peer-chip'
import { QuestionCard } from '@/components/chat/question-card'
import { SpeechPlayer } from '@/components/chat/speech-player'
import { SummarySheet } from '@/components/chat/summary-sheet'
import { toolsIn } from '@/components/chat/turn'
import { WorktreeMenu } from '@/components/chat/worktree-menu'
import { Claudinho } from '@/components/claudinho'
import { ClaudinhoNameDialog } from '@/components/claudinho-name'
import { DeleteSessionDialog } from '@/components/delete-session-dialog'
import { firstSentence, mindTree } from '@/components/mindmap/model'
import { MapPane } from '@/components/mindmap/pane'
import { useChatDisplay } from '@/components/mindmap/view'
import { ProjectPanelButton } from '@/components/project/panel'
import { RepoLink } from '@/components/repo-link'
import { SessionPicker } from '@/components/session-picker'
import { StateBadge } from '@/components/state-badge'
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
import { Veil } from '@/components/wallpaper/veil'
import { api, errorMessage } from '@/lib/api'
import { dropTools, publishTools } from '@/lib/chat-tools'
import { claudinhoName } from '@/lib/claudinho'
import { workspaceColor } from '@/lib/workspaces'
import { projectOf } from '@/lib/worktree'
import { projectName, stateInfo } from '@/lib/format'
import { PHONE_QUERY, useGitStatus, useHome, useMediaQuery, usePressMenu, useWide, useWidth } from '@/lib/hooks'
import { useBackToClose } from '@/lib/back-close'
import { useShowProject } from '@/lib/project-panel'
import { keyOf, pinTab } from '@/lib/workbench'
import { useGlass, useScrim } from '@/lib/wallpaper'
import { setZen, useZen } from '@/lib/zen'
import { putDraft } from '@/lib/drafts'
import { enqueue } from '@/lib/outbox'
import { clearNotifications } from '@/lib/push'
import { setAutoSpeech, speakNew, speechSupported, useSpeech } from '@/lib/speech'
import { useMachine, useMachines } from '@/lib/machines'
import { CHAT_DRAG, closeChat, openBeside, swapChat, useDraggingChat, usePane, useSplit } from '@/lib/split'
import { onLiveEvent, subscribe, unsubscribe, useStore } from '@/lib/store'
import type { ContextUsage, RunOptions } from '@/lib/types'
import { backHref } from '@/lib/tabs'
import { cn } from '@/lib/utils'
import { useActivityPing } from '@/lib/wakatime'

// O desenho do mapa mental só chega quando ele for aberto; a árvore (model.ts) é leve e fica aqui.
const MindMap = lazy(() => import('@/components/mindmap/mind-map').then((m) => ({ default: m.MindMap })))

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

/** Diálogos, folhas e menus abertos: o Esc deles não sai do agente em foco nem do zen. */
const OVERLAYS = '[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"], [data-slot="dropdown-menu-content"]'

// Os /clear cuja animação já rodou: a conversa remontada (a aba troca para o id novo) não repete.
const fallen = new Set<string>()

/**
 * O /clear que acabou de acontecer: o que estava na tela antes dele, para cair na lixeira (ver
 * `TrashFall`) por menos de um segundo. Só o que chegou agora conta: abrir uma conversa que já foi
 * limpa não anima nada. A troca de aba para o id novo remonta a tela no meio; a nova recomeça a queda.
 */
function useTrashFall(events: Keyed[], cut: number): Item[] | null {
  const marker = cut >= 0 ? events[cut] : undefined
  const [falling, setFalling] = useState<Item[] | null>(null)
  useEffect(() => {
    if (!marker || fallen.has(marker.key) || !marker.ts || Date.now() - marker.ts > 2500) return
    const before = events.slice(0, cut).findLastIndex((e) => e.kind === 'cleared')
    setFalling(buildItems(events.slice(before + 1, cut)))
    const done = setTimeout(() => {
      fallen.add(marker.key)
      setFalling(null)
    }, 1100)
    return () => clearTimeout(done)
    // Só quando chega um marco novo: os eventos seguintes não reiniciam a queda.
  }, [marker?.key])
  return falling
}

/**
 * O que estava na conversa encolhendo e caindo numa lixeira que aparece no pé dela, e a lixeira dando
 * um balanço quando recebe. Por cima das mensagens e sem pegar o ponteiro; a conversa segue embaixo.
 */
function TrashFall({ items, sessionId, cwd }: { items: Item[]; sessionId: string; cwd?: string }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      <div className="chat-trash-fall absolute inset-x-0 bottom-28 mx-auto max-h-full w-full max-w-3xl overflow-hidden">
        <MessageList items={items.slice(-12)} queued={[]} sessionId={sessionId} actionable={false} working={false} background={[]} uses={new Map()} cwd={cwd} />
      </div>
      <div className="chat-trash-can absolute bottom-24 left-1/2 flex size-14 -translate-x-1/2 items-center justify-center rounded-2xl bg-card text-muted-foreground shadow-lg ring-1 ring-foreground/10">
        <Trash2 className="size-6" />
      </div>
    </div>
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
  // Máquina da conversa (posta pelo ChatSplit, ver machines.ts): tudo desta tela vai para ela.
  const machine = useMachine()
  const { view, entry, cwd, panelOpen, owner, state, waitingFor, working, history, events, cut, items, background, uses, queued } = useConversation(
    id,
    machine,
  )
  const machineLabel = useMachines((s) => (s.machines.length > 1 ? s.machines.find((m) => m.id === machine)?.name : undefined))
  const rekeyed = useStore((s) => s.rekeys[id])
  // O tempo que você passa nesta conversa conta no WakaTime, como o do Claude (ver lib/wakatime.ts).
  useActivityPing(machine, cwd)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  // O nome do claudinho: botão direito (ou o dedo segurado) no claudinho do cabeçalho.
  const [naming, setNaming] = useState(false)
  const nameMenu = usePressMenu(() => setNaming(true))
  const name = claudinhoName(id, entry?.claudinhoName)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // O agente em foco: a conversa dele fica no lugar do chat (ver AgentChat). Guarda de qual conversa é,
  // para trocar de conversa sair do foco.
  const [agentFocus, setAgentFocus] = useState<{ session: string; agent: string } | null>(null)
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

  const trash = useTrashFall(events, cut)
  // O painel de comandos (barra de status, no PC) lê daqui o que esta conversa rodou.
  const tools = useMemo(() => toolsIn(items.flatMap((i) => (i.type === 'activity' ? i.entries : []))), [items])
  useEffect(() => publishTools(id, tools), [id, tools])
  useEffect(() => () => dropTools(id), [id])
  // Subagentes da conversa; sem processo cuidando dela (no painel ou no PC), quem não terminou parou.
  const agents = useMemo(() => agentTree(items, panelOpen || owner === 'pc'), [items, panelOpen, owner])
  const agentsWorking = agents.count.running + agents.count.waiting
  // Sumiu da árvore (um /clear), sai do foco junto.
  const focused = agentFocus?.session === id ? agents.byId.get(agentFocus.agent) : undefined
  const leaveAgent = useCallback(() => setAgentFocus(null), [])
  // Turno encerrado com algo em segundo plano: a conversa ainda trabalha (como na lista de conversas).
  const inBackground = state === 'idle' && background.length > 0
  const shownState = state === 'idle' && (agentsWorking || inBackground) ? 'running' : state
  const shownWaiting = inBackground ? 'background' : waitingFor
  const turns = useMemo(() => view.events.filter((e) => e.kind === 'result').length, [view.events])
  const context = useContextUsage(id, panelOpen, turns)
  // Com projeto (não a pasta pessoal): explorador de arquivos e git no topo.
  const project = cwd && home && cwd !== home ? cwd : undefined
  const git = useGitStatus(machine, project, turns)
  // Os workspaces que a conversa pode usar são os do projeto (o de origem, num worktree).
  const wsProject = project ? (entry?.worktree?.project ?? projectOf(project)) : undefined
  // No celular a caixa não tem lugar para o workspace: o trecho dele no topo é que abre o menu.
  const phone = useMediaQuery(PHONE_QUERY)
  const changeWorkspace = (workspaceId: string | undefined) => {
    if ((workspaceId ?? null) === (entry?.workspace?.id ?? null)) return
    toast.promise(api.setWorkspace(id, workspaceId ?? null), {
      loading: workspaceId ? 'Trocando o workspace…' : 'Tirando o workspace…',
      success: workspaceId ? 'Workspace trocado: vale a partir da próxima mensagem.' : 'Conversa sem workspace.',
      error: (err) => errorMessage(err),
    })
  }
  const workspaceLabel = entry?.workspace && (
    <span className="flex min-w-0 shrink items-center gap-1">
      <span className="size-2 shrink-0 rounded-full" style={{ background: workspaceColor(entry.workspace.color) }} />
      <span className="truncate text-foreground/70">{entry.workspace.name}</span>
      <span>·</span>
    </span>
  )
  // A barra do projeto, à direita, mostra o da conversa em foco (ver lib/project-panel.ts).
  useShowProject(machine, project, id, pane.focused)
  // Conversa parada: modelo/esforço/modo escolhidos agora valem quando ela for retomada.
  const [pending, setPending] = useState<RunOptions>({})
  // Texto da mensagem bifurcada, esperando o ID que o rekey vai trazer.
  const branched = useRef<string | null>(null)
  const glass = useGlass()
  const scrim = useScrim()
  const zen = useZen((s) => s.id === id)
  // Esc no PC e o voltar do celular saem do agente em foco e do zen antes de sair da conversa (o Esc, do agente primeiro).
  useBackToClose(zen, () => setZen(null))
  useBackToClose(Boolean(focused), leaveAgent)
  const agentOpen = Boolean(focused)
  useEffect(() => {
    if (!zen && !agentOpen) return
    const onKey = (e: KeyboardEvent) => {
      // O Esc de um diálogo ou menu aberto por cima é só dele.
      if (e.key !== 'Escape' || document.querySelector(OVERLAYS)) return
      if (agentOpen) leaveAgent()
      else setZen(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [zen, agentOpen, leaveAgent])
  // O texto do streaming crescendo não entra aqui: o ResizeObserver do conteúdo já acompanha.
  const { scrollRef, contentRef, onScroll, atBottom, follow, setFollow, jumpToBottom } = useAutoScroll([
    items.length,
    queued.length,
    history.events === null,
  ])

  // Mapa mental (components/mindmap): no lugar do chat ou, com espaço, ao lado dele.
  const [display, setDisplay] = useChatDisplay()
  const areaRef = useRef<HTMLDivElement>(null)
  // Soltar imagens e documentos em qualquer lugar da conversa anexa todos na caixa de mensagem dela.
  const drop = useFileDrop((list) => {
    if (!attachInto(id, list)) toast('Esta conversa não recebe mensagens daqui agora')
  })
  const areaWidth = useWidth(areaRef)
  const roomy = areaWidth >= 1000
  // Estreita (várias lado a lado no PC): só o essencial no topo, o resto vai para o menu. No celular, o
  // topo fica quase como no zen: o voltar, a conversa, o mapa mental e os arquivos e o git, sem menu.
  const slim = areaWidth < 480 || !tabs
  const toggleAutoSpeech = () => {
    setAutoSpeech(id, !autoSpeech)
    if (autoSpeech) toast('Leitura automática desligada')
    else toast('Leitura automática ligada', { description: 'As respostas novas do Claude serão lidas em voz alta.' })
  }
  const shown = display === 'both' && !roomy ? 'map' : display
  const { label: stateLabel, tone: stateTone } = stateInfo(shownState, shownWaiting)
  // Pôr um agente em foco (pelo trilho, pela linha dele no chat, pelo mapa): com só o mapa na tela, volta ao chat.
  const openAgent = useCallback(
    (agent: string) => {
      setAgentFocus({ session: id, agent })
      if (shown === 'map') setDisplay('chat')
    },
    [id, shown, setDisplay],
  )
  const agentsContext = useMemo(() => ({ tree: agents, open: openAgent, team: entry?.team }), [agents, openAgent, entry?.team])
  // O mapa só mostra a primeira frase do que o Claude está escrevendo: assinar o texto inteiro
  // refaria a árvore e o layout a cada delta.
  const streamHead = useStore((s) => {
    const text = shown === 'chat' ? '' : s.streams[id]
    return text ? firstSentence(text) || 'Escrevendo…' : ''
  })
  const mapRoot = useMemo(
    () => (shown === 'chat' ? null : mindTree({ seed: id, items, title: entry?.title ?? 'Conversa', rootMeta: stateLabel, working, streaming: streamHead, agents })),
    [shown, id, items, entry?.title, stateLabel, working, streamHead, agents],
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
    leaveAgent()
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(key)}"]`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      flash(el)
    })
  }
  const openRequest = (key: string) => (shown === 'map' ? flash(dockRef.current) : jumpTo(key))
  // O agente em foco pede aprovação: o cartão de responder fica no chat, e "Responder" leva até ele.
  const answerAgent = () => {
    const own = new Set(focused?.entries.flatMap((e) => (e.kind === 'tool' ? [e.use.id] : [])))
    const request = requests.find((r) => r.type === 'approval' && r.req.toolUseId && own.has(r.req.toolUseId))
    if (request) jumpTo(request.key)
    else leaveAgent()
  }

  /** A aba desta conversa deixa de ser prévia (no celular não há abas, e não faz nada). */
  const pin = () => pinTab(keyOf({ kind: 'chat', id }))

  const resumeCommand = cwd ? `cd '${cwd}' && claude --resume ${id}` : `claude --resume ${id}`

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
        {/* O vidro do cabeçalho, com o fundo animado; sem ele, a cor da aba aberta. */}
        <div className={cn('shrink-0', glass ? 'relative z-10 bg-background/70 backdrop-blur-md' : 'bg-background', zen && 'hidden')}>
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
              // Sem linha: no PC, a aba aberta desce até ele, na mesma cor; no celular, ele é o alto da janela.
              // Sem fundo próprio: o do invólucro é a cor da aba aberta (ou, com o fundo animado, o vidro dela; ver .tab-glass em index.css).
              'flex items-center gap-1 px-2 pt-[max(0.5rem,var(--safe-top))] pb-2 compact:py-1',
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
              {/* Corta o que não couber em vez de vazar para baixo dos botões ao lado. Só na largura: na
                  altura, o toque no workspace (no celular) vai além da linha. */}
              <div className="flex min-w-0 items-center gap-1.5 overflow-x-clip text-xs text-muted-foreground">
                <span className="shrink-0 font-medium text-foreground/70">{name}</span>
                <span>·</span>
                {/* Conversa de um workspace: a cor e o nome dele antes do projeto. No celular, o trecho todo
                    abre o menu do workspace (no PC ele fica na caixa, ao lado do time). */}
                {phone && wsProject ? (
                  <WorkspaceMenu machine={machine} project={wsProject} value={entry?.workspace} onChange={changeWorkspace} label="Trocar o workspace" side="bottom">
                    <button
                      type="button"
                      aria-label={entry?.workspace ? `Workspace: ${entry.workspace.name}` : 'Escolher um workspace'}
                      className="-my-1.5 flex min-w-0 shrink items-center gap-1 py-1.5"
                    >
                      {workspaceLabel}
                      <span className="min-w-0 truncate">{projectName(cwd)}</span>
                      <ChevronDown className="size-3 shrink-0" />
                    </button>
                  </WorkspaceMenu>
                ) : (
                  <>
                    {workspaceLabel}
                    <span className="min-w-0 truncate">{projectName(cwd)}</span>
                  </>
                )}
                {machineLabel && (
                  <span className="flex shrink-0 items-center gap-0.5">
                    <Server className="size-3" />
                    {machineLabel}
                  </span>
                )}
                {owner === 'pc' && <Monitor className="size-3 shrink-0" />}
                {/* No celular, aberta aqui e concluída são o normal: ficam sem marca, como na lista. */}
                {owner === 'panel' && !slim && <Smartphone className="size-3 shrink-0" />}
                {(!slim || stateTone !== 'done') && (
                  <StateBadge state={shownState} waitingFor={shownWaiting} className="h-5 shrink-0 px-1.5 text-[10px]" />
                )}
                {/* Quem mais trabalha agora nos mesmos arquivos; estreito, só os claudinhos. */}
                <PeerChip id={id} machine={machine} cwd={cwd} compact={slim} />
              </div>
            </div>
            {speechSupported && !slim && (
              <Button
                variant={autoSpeech ? 'default' : 'ghost'}
                size="icon"
                className={cn(autoSpeech && 'rounded-full')}
                onClick={toggleAutoSpeech}
                aria-pressed={autoSpeech}
                aria-label={autoSpeech ? 'Leitura automática ligada: tocar para desligar' : 'Ler as respostas novas em voz alta'}
              >
                {autoSpeech ? <Volume2 /> : <VolumeOff />}
              </Button>
            )}
            {!slim && (
              <Button variant="ghost" size="icon" onClick={() => setZen(id)} aria-label="Modo zen: só esta conversa na tela" title="Modo zen">
                <Minimize2 />
              </Button>
            )}
            {/* O mapa mental fica no topo também no celular, ao lado dos arquivos e do git. */}
            {(!slim || !tabs) && (
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
            )}
            {/* Num worktree: o que falta trazer para a de origem, e o "Trazer" e o "Remover" no menu. */}
            {entry?.worktree && cwd && <WorktreeMenu machine={machine} cwd={cwd} tag={entry.worktree} refresh={git.status} />}
            {project && git.status?.remote && !slim && <RepoLink url={git.status.remote} />}
            {/* No PC, os arquivos e o git ficam na barra do projeto, sempre ao lado. */}
            {project && !tabs && <ProjectPanelButton changes={git.status?.files.length ?? 0} />}
            {/* O menu é do PC. No celular, o que ele tinha fica de fora ou em outro lugar: apagar, no toque longo da lista. */}
            {tabs && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Mais ações">
                    <EllipsisVertical />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-56">
                  {/* Estreita, os botões do topo que não couberam. */}
                  {slim && (
                    <>
                      {speechSupported && (
                        <DropdownMenuItem onSelect={toggleAutoSpeech}>
                          {autoSpeech ? <VolumeOff /> : <Volume2 />} {autoSpeech ? 'Desligar a leitura automática' : 'Ler as respostas em voz alta'}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => setDisplay(shown === 'chat' ? 'map' : 'chat')}>
                        {shown === 'chat' ? <Network /> : <MessagesSquare />} {shown === 'chat' ? 'Ver como mapa mental' : 'Voltar ao chat'}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setZen(id)}>
                        <Minimize2 /> Modo zen
                      </DropdownMenuItem>
                      {project && git.status?.remote && (
                        <DropdownMenuItem asChild>
                          <a href={git.status.remote} target="_blank" rel="noreferrer">
                            <ExternalLink /> {new URL(git.status.remote).hostname === 'github.com' ? 'Abrir no GitHub' : 'Abrir o repositório'}
                          </a>
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                    </>
                  )}
                  {owner === 'panel' && (
                    <DropdownMenuItem disabled={busy || state === 'running' || state === 'waiting' || agentsWorking > 0} onSelect={release}>
                      <LogOut /> Liberar para o PC
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
            )}
            {handle && (
              <Button variant="ghost" size="icon" onClick={() => closeChat(id)} aria-label="Tirar esta conversa da tela">
                <X />
              </Button>
            )}
          </header>
        </div>

        <div
          ref={areaRef}
          {...drop.bind}
          className={cn(
            'relative flex min-h-0 flex-1',
            // Sem o cabeçalho, quem segura a conversa longe do entalhe do celular é isto.
            zen && 'pt-[var(--safe-top)]',
            pane.collapsed && 'hidden',
          )}
        >
          <DropOverlay show={drop.over} />
          {trash && <TrashFall items={trash} sessionId={id} cwd={cwd} />}
          {/* Os agentes da conversa: uma aba que sai da borda esquerda (a linha do tempo fica à direita),
              por cima do chat, que fica com a largura toda. Sem nenhum agente, não aparece. */}
          {agents.all.length > 0 && (
            <AgentRail
              sessionId={id}
              name={name}
              state={shownState}
              tree={agents}
              focused={focused?.id ?? null}
              onFocus={(agent) => (agent ? openAgent(agent) : leaveAgent())}
              // No PC a casca em volta da janela é sempre opaca, e a aba é ela; no celular, com a cena, vidro.
              glass={glass && !tabs}
              inert={shown === 'map'}
              className={cn(
                // Logo abaixo do cabeçalho; no zen, abaixo do entalhe. O máximo deixa espaço para a curva de baixo.
                zen ? 'top-[calc(var(--safe-top)+0.5rem)] max-h-[calc(100%-var(--safe-top)-2rem)]' : 'top-2 max-h-[calc(100%-2rem)]',
                shown === 'map' && 'invisible',
              )}
            />
          )}
          {/* Só o mapa: o chat segue montado por baixo (o mapa pula para os pontos dele), mas some de
              vista, senão apareceria através do mapa quando ele fica transparente sobre o fundo animado. */}
          <div className={cn('relative min-w-0 flex-1', shown === 'map' && 'invisible')} inert={shown === 'map'}>
            {/* O escurecido embaixo das mensagens, de lado a lado. Fica fora do scroller para não rolar
                junto com o texto. */}
            {scrim !== null && <Veil dim={scrim} />}
            {/* Com um agente em foco, o chat principal também segue montado por baixo, sem perder a rolagem. */}
            <div className={cn('absolute inset-0', focused && 'invisible')} inert={agentOpen}>
              <div ref={scrollRef} onScroll={onScroll} className="absolute inset-0 overflow-y-auto">
                <div ref={contentRef} className="mx-auto w-full max-w-3xl">
                  {entry?.forkedFrom && <ForkBanner from={entry.forkedFrom} />}
                  {/* Depois de um /clear, o histórico de antes não aparece: carregá-lo só piscaria por cima da queda. */}
                  {history.events === null && !history.error && cut < 0 ? (
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
                        working={working}
                        background={background}
                        uses={uses}
                        cwd={cwd}
                        onBranch={branch}
                      />
                    </>
                  )}
                </div>
              </div>

              {/* Fora do zen: no canto dela fica o botão de sair dele. */}
              {!zen && <ChatTimeline scrollRef={scrollRef} items={items} />}
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
            {focused && (
              <AgentChat
                key={focused.id}
                sessionId={id}
                node={focused}
                task={panelOpen ? background.find((t) => t.toolUseId === focused.id) : undefined}
                onOpen={openAgent}
                onClose={leaveAgent}
                onAnswer={answerAgent}
                // No zen, o botão de sair dele fica no canto de cima.
                headerClassName={zen ? 'pr-14' : undefined}
              />
            )}
            {zen && (
              // Onde o cabeçalho estava. Fica sempre na tela, só apagado: um botão que some de vez
              // deixaria sem saída quem não sabe do Esc nem do voltar.
              <Button
                variant="secondary"
                size="icon"
                onClick={() => setZen(null)}
                aria-label="Sair do modo zen"
                title="Sair do modo zen"
                className="absolute top-[max(0.75rem,var(--safe-top))] right-3 z-20 size-9 rounded-full border opacity-30 shadow-lg transition-opacity hover:opacity-100 focus-visible:opacity-100"
              >
                <Maximize2 />
              </Button>
            )}
          </div>
          {mapRoot && (
            <MapPane beside={shown === 'both'}>
              <Suspense>
                <MindMap
                  sessionId={id}
                  root={mapRoot}
                  title={entry?.title ?? 'Conversa'}
                  onJump={jumpTo}
                  onAgent={openAgent}
                  onRequest={openRequest}
                  side={roomy ? { on: shown === 'both', toggle: () => setDisplay(shown === 'both' ? 'map' : 'both') } : null}
                />
              </Suspense>
            </MapPane>
          )}
        </div>

        {/* Encolhida (celular em pé, digitando na outra): some sem desmontar, sem perder rascunho nem leitura. */}
        <div className={cn('relative flex shrink-0 flex-col', pane.collapsed && 'hidden')}>
          {/* O véu continua atrás da barra de texto até o fim da tela; sem isto ele parava no topo dela,
              e em volta da barra a cena aparecia sem escurecer. */}
          {scrim !== null && <Veil dim={scrim} />}
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

            {owner === 'panel' ? (
              <Composer
                sessionId={id}
                cwd={cwd}
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
                extra={
                  // No celular a barra não tem espaço: o workspace se troca pelo topo, e o que o time faz
                  // aparece no trilho de agentes, ao lado do chat.
                  <>
                    {wsProject && (
                      <WorkspacePill
                        machine={machine}
                        project={wsProject}
                        value={entry?.workspace}
                        label="Trocar o workspace"
                        className="max-sm:hidden"
                        onChange={changeWorkspace}
                      />
                    )}
                    <TeamPill
                      machine={machine}
                      current={entry?.team}
                      className="max-sm:hidden"
                      onChange={(teamId) => {
                        if ((teamId ?? null) === (entry?.team?.id ?? null)) return
                        toast.promise(api.setTeam(id, teamId ?? null), {
                          loading: teamId ? 'Trocando o time…' : 'Tirando o time…',
                          success: teamId ? 'Time trocado: vale a partir da próxima mensagem.' : 'Conversa sem time.',
                          error: (err) => errorMessage(err),
                        })
                      }}
                    />
                  </>
                }
                onSend={(text, attachments) => {
                  pin()
                  return enqueue(id, text, attachments)
                }}
                onInterrupt={() => api.interrupt(id).then(() => undefined)}
              />
            ) : (
              <Composer
                sessionId={id}
                cwd={cwd}
                branch={git.status?.branch}
                working={false}
                // Aberta no PC, enviar a encerra lá (o servidor só faz isso com ela ociosa e no terminal) e a
                // continua aqui; cada mensagem mostra de onde saiu, então não há botão de assumir.
                hint={
                  owner !== 'pc'
                    ? 'Enviar retoma esta conversa aqui pelo celular.'
                    : state === 'idle'
                      ? 'Aberta no PC. Enviar a encerra lá e a continua aqui, com todo o contexto.'
                      : 'Trabalhando no PC. Dá para mandar daqui quando ela parar.'
                }
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

        <SummarySheet sessionId={id} events={events} cwd={cwd} context={context} open={summaryOpen} onOpenChange={setSummaryOpen} />
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
      </div>
    </AgentsContext>
  )
}
