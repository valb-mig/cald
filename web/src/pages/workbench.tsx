import { AppWindow, CircleDot, Columns2, FileDiff, FolderGit2, GitPullRequest, Inbox, MessageSquarePlus, PencilLine, Pin, X } from 'lucide-react'
import { createElement, Fragment, useEffect, useLayoutEffect, useState } from 'react'
import { useLocation, useSearch } from 'wouter'
import { navigate } from 'wouter/use-browser-location'
import { create } from 'zustand'
import { Claudinho } from '@/components/claudinho'
import { ClaudinhoNameDialog } from '@/components/claudinho-name'
import { Crash, ErrorBoundary } from '@/components/error-boundary'
import { GithubItemView } from '@/components/project/github-item'
import { ProjectHub } from '@/components/project/hub'
import { WorkspacePage } from '@/pages/workspace'
import { InboxView } from '@/components/inbox/inbox-view'
import { PrototypeView } from '@/components/prototype/prototype-view'
import { useInboxCount } from '@/lib/inbox'
import { useWorkspaces, workspaceColor } from '@/lib/workspaces'
import { fileIcon, splitPath } from '@/components/project/status'
import { UnsavedDialog } from '@/components/project/unsaved-dialog'
import { ViewerBody } from '@/components/project/viewer'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { claudinhoName } from '@/lib/claudinho'
import { projectName, shortPath } from '@/lib/format'
import { MachineContext } from '@/lib/machines'
import { useProjectPanel, useShowProject } from '@/lib/project-panel'
import { repaintShell } from '@/lib/shell'
import { PaneContext, parseChats, saveSplitSizes, setSplitWeights, useMaxChats, useSplitSizes } from '@/lib/split'
import { useStore } from '@/lib/store'
import { useUnsaved } from '@/lib/unsaved'
import { cn } from '@/lib/utils'
import { useGlass } from '@/lib/wallpaper'
import {
  activateTab,
  activeTab,
  closeTab,
  closeTabs,
  focusedChat,
  focusGroup,
  moveTab,
  openTab,
  pinTab,
  replaceTab,
  splitTab,
  useWorkbench,
  WORKBENCH_PATH,
  type Group,
  type Tab,
} from '@/lib/workbench'
import { useZen } from '@/lib/zen'
import { useArrivals } from '@/components/chat/arrival'
import { NewChatView } from './new-chat'
import { ChatInMachine } from './split'

/** Tipo do arrasto de uma aba; só ele é aceito pelas barras de abas e pelos grupos. */
const TAB_DRAG = 'application/x-cald-tab'
const KEY_STEP = 0.05

/** A aba sendo arrastada, para os grupos saberem mostrar onde ela cai. */
const useDragging = create<{ tab: { group: string; key: string } | null }>(() => ({ tab: null }))
const useDraggingTab = () => useDragging((s) => s.tab)

const isTextField = (target: EventTarget) =>
  target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)

// ---- a URL e as abas ----

/**
 * A URL `/s/A` é o jeito de o resto do app (lista, home, salinha, notificações) pedir uma conversa:
 * ela abre numa aba de prévia do grupo em foco, ou vai para a aba dela, se já está aberta. Na volta,
 * a URL passa a dizer a aba em foco: a conversa (`/s/A`) ou, com um arquivo, issue ou PR na frente,
 * a área das abas (`/abas`). Sem isso a URL ficava na conversa que a prévia acabou de trocar, e
 * clicar nela de novo na lista não mudava a URL — e não reabria nada.
 */
function useUrlSync() {
  const [pathname] = useLocation()
  const search = useSearch()

  useEffect(() => {
    const url = pathname + (search ? `?${search}` : '')
    if (url === useWorkbench.getState().url) return
    const [first, ...rest] = parseChats(pathname, search)
    if (first) openTab({ kind: 'chat', id: first }, { preview: true })
    // `?com=` (link antigo, ou vindo do celular): as outras abrem ao lado.
    for (const id of rest) openTab({ kind: 'chat', id }, { beside: true })
    useWorkbench.setState({ url })
  }, [pathname, search])

  const chat = useWorkbench(focusedChat)
  const empty = useWorkbench((s) => s.groups.length === 0)
  useEffect(() => {
    // Lido na hora: no primeiro efeito, a aba da URL acabou de abrir e a tela ainda não sabe.
    const state = useWorkbench.getState()
    if (!state.groups.length) return navigate('/', { replace: true })
    const now = focusedChat(state)
    const url = now ? `/s/${now}` : WORKBENCH_PATH
    useWorkbench.setState({ url })
    if (location.pathname + location.search !== url) navigate(url, { replace: true })
  }, [chat, empty])
}

/** O arquivo da aba ativa do grupo em foco fica marcado na barra do projeto, como o aberto no VSCode. */
function useViewingSync() {
  const file = useWorkbench((s) => {
    const g = s.groups.find((x) => x.id === s.focused)
    const t = activeTab(g)
    return t?.kind === 'file' ? t : null
  })
  useEffect(() => {
    useProjectPanel.setState({ viewing: file && { machine: file.machine, cwd: file.cwd, path: file.path, diff: file.diff } })
  }, [file])
}

// ---- abas ----

/** O claudinho da conversa, com o estado nele: "…" executando, pensando, "!" esperando você, o joinha ao terminar. */
function ChatTabLabel({ id }: { id: string }) {
  const entry = useStore((s) => s.catalog.find((c) => c.sessionId === id))
  return (
    <>
      <Claudinho seed={id} state={entry?.state} thinking={entry?.thinking} status size={16} />
      <span className="truncate">{entry?.title || 'Conversa'}</span>
    </>
  )
}

function FileTabLabel({ tab }: { tab: Extract<Tab, { kind: 'file' }> }) {
  const { name } = splitPath(tab.path)
  return (
    <>
      {createElement(tab.diff ? FileDiff : fileIcon(name), { className: 'size-3.5 shrink-0 text-muted-foreground' })}
      <span className="truncate">{name}</span>
      {tab.diff && <span className="shrink-0 text-[11px] text-muted-foreground">{tab.diff === 'staged' ? 'preparado' : 'alterações'}</span>}
    </>
  )
}

function GithubTabLabel({ tab }: { tab: Extract<Tab, { kind: 'github' }> }) {
  return (
    <>
      {createElement(tab.item === 'pr' ? GitPullRequest : CircleDot, { className: 'size-3.5 shrink-0 text-muted-foreground' })}
      <span className="shrink-0 text-muted-foreground">#{tab.number}</span>
      <span className="truncate">{tab.title ?? (tab.item === 'pr' ? 'PR' : 'Issue')}</span>
    </>
  )
}

const tabTitle = (tab: Tab, chatTitle?: string) =>
  tab.kind === 'chat'
    ? (chatTitle ?? 'Conversa')
    : tab.kind === 'file'
      ? `${tab.path}${tab.diff ? ` (${tab.diff === 'staged' ? 'alterações preparadas' : 'alterações'})` : ''}`
      : tab.kind === 'github'
        ? `${tab.item === 'pr' ? 'PR' : 'Issue'} #${tab.number}${tab.title ? `: ${tab.title}` : ''}`
        : tab.kind === 'new'
          ? `Nova conversa em ${tab.cwd ? projectName(tab.cwd) : 'sem projeto (~)'}`
          : tab.kind === 'workspace'
            ? 'Workspace'
            : tab.kind === 'inbox'
              ? 'Inbox'
              : tab.kind === 'prototype'
                ? `${tab.title ? `${tab.title}\n` : ''}${shortPath(tab.path)}`
                : `Projeto ${projectName(tab.cwd)}`

/** `alone`: a aba é a única do grupo, e abrir ao lado só trocaria o grupo por outro igual. */
type TabMenuAt = { group: string; tab: Tab; alone: boolean; x: number; y: number }

function TabItem({
  group,
  tab,
  index,
  active,
  fresh,
  drop,
  onDrop,
  onMenu,
}: {
  group: Group
  tab: Tab
  index: number
  active: boolean
  fresh: boolean
  drop: 'before' | 'after' | null
  onDrop: (index: number | null) => void
  onMenu: (at: TabMenuAt) => void
}) {
  const title = useStore((s) => (tab.kind === 'chat' ? s.catalog.find((c) => c.sessionId === tab.id)?.title : undefined))
  const close = () => closeTab(group.id, tab.key)
  // Alteração não salva no editor: um ponto no lugar do X, que volta ao passar o mouse, como no VSCode.
  const dirty = useUnsaved((s) => Boolean(s.dirty[tab.key]))
  // Aberta agora (não com a janela): cresce no lugar dela e empurra as vizinhas, em vez de surgir.
  const [enter] = useState(fresh)
  const glass = useGlass()
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      title={tabTitle(tab, title)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TAB_DRAG, JSON.stringify({ group: group.id, key: tab.key }))
        e.dataTransfer.effectAllowed = 'move'
        useDragging.setState({ tab: { group: group.id, key: tab.key } })
      }}
      onDragEnd={() => useDragging.setState({ tab: null })}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TAB_DRAG)) return
        e.preventDefault()
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        onDrop(e.clientX > r.left + r.width / 2 ? index + 1 : index)
      }}
      onClick={() => activateTab(group.id, tab.key)}
      onDoubleClick={() => pinTab(tab.key)}
      // Botão do meio fecha, como no navegador e no VSCode; o mousedown dele rolaria a página.
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      onAuxClick={(e) => e.button === 1 && close()}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu({ group: group.id, tab, alone: group.tabs.length === 1, x: e.clientX, y: e.clientY })
      }}
      onKeyDown={(e) => {
        if (e.key === 'Delete') close()
      }}
      className={cn(
        'group/tab relative flex max-w-56 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 pr-1 pl-3 text-[13px] outline-none select-none',
        // Trocar de aba: a que abre sobe até a janela e ganha a cor dela, e a que sai desce, suaves.
        'transition-[background-color,color,height,margin] duration-200 ease-out',
        enter && 'tab-enter',
        // A aberta tem a cor da janela e brota dela (ver .tab-merge em index.css), com um fio de luz no alto;
        // as outras são só o texto apagado na casca, e viram pílula ao passar o mouse. Assim a única aba
        // preenchida é a aberta, mesmo com a cena atrás deixando a cor dela parecida com a da casca.
        active
          ? cn(
              'tab-merge h-8 rounded-t-lg text-foreground shadow-[inset_0_1px_0_color-mix(in_oklab,var(--foreground)_12%,transparent)]',
              glass ? 'tab-glass bg-background/70 backdrop-blur-md' : 'bg-background',
            )
          : 'mb-1 h-7 rounded-lg text-muted-foreground hover:bg-tab hover:text-foreground',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
      )}
    >
      {drop && <span aria-hidden className={cn('absolute inset-y-1 w-0.5 rounded-full bg-primary', drop === 'before' ? '-left-1' : '-right-1')} />}
      {/* Prévia em itálico: o próximo clique na lista (ou na árvore) troca esta aba. */}
      <span className={cn('flex min-w-0 items-center gap-1.5', tab.preview && 'italic')}>
        {tab.kind === 'chat' ? (
          <ChatTabLabel id={tab.id} />
        ) : tab.kind === 'file' ? (
          <FileTabLabel tab={tab} />
        ) : tab.kind === 'github' ? (
          <GithubTabLabel tab={tab} />
        ) : tab.kind === 'new' ? (
          <>
            <MessageSquarePlus className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">Nova conversa</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{tab.cwd ? projectName(tab.cwd) : '~'}</span>
          </>
        ) : tab.kind === 'workspace' ? (
          <WorkspaceTabLabel tab={tab} />
        ) : tab.kind === 'inbox' ? (
          <InboxTabLabel />
        ) : tab.kind === 'prototype' ? (
          <>
            <AppWindow className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{tab.title || splitPath(tab.path).name}</span>
          </>
        ) : (
          <>
            <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{projectName(tab.cwd)}</span>
          </>
        )}
      </span>
      <button
        type="button"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation()
          close()
        }}
        aria-label={dirty ? 'Fechar a aba (há alterações não salvas)' : 'Fechar a aba'}
        className={cn(
          'group/close flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
          active || dirty ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100',
        )}
      >
        {dirty ? (
          <>
            <span aria-hidden className="size-2 rounded-full bg-current group-hover/close:hidden" />
            <X className="hidden size-3.5 group-hover/close:block" />
          </>
        ) : (
          <X className="size-3.5" />
        )}
      </button>
    </div>
  )
}

/** Menu da aba: fechar (ela, as outras, as da direita), fixar a prévia, abrir ao lado e, numa conversa, renomear o claudinho. */
function TabMenu({
  at,
  open,
  onOpenChange,
  canSplit,
  onRename,
}: {
  at: TabMenuAt | null
  open: boolean
  onOpenChange: (o: boolean) => void
  canSplit: boolean
  onRename: (session: { sessionId: string; claudinhoName?: string }) => void
}) {
  const chat = at?.tab.kind === 'chat' ? at.tab.id : null
  const custom = useStore((s) => (chat ? s.catalog.find((c) => c.sessionId === chat)?.claudinhoName : undefined))
  return (
    <DropdownMenu open={open && Boolean(at)} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: at?.x ?? 0, top: at?.y ?? 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} collisionPadding={8} className="min-w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
        {at && (
          <>
            <DropdownMenuItem onSelect={() => closeTab(at.group, at.tab.key)}>
              <X /> Fechar
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => closeTabs(at.group, at.tab.key, 'others')}>Fechar as outras</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => closeTabs(at.group, at.tab.key, 'right')}>Fechar as da direita</DropdownMenuItem>
            <DropdownMenuSeparator />
            {at.tab.preview && (
              <DropdownMenuItem onSelect={() => pinTab(at.tab.key)}>
                <Pin /> Manter aberta
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={!canSplit || at.alone} onSelect={() => splitTab(at.group, at.tab.key, at.group, 'right')}>
              <Columns2 /> {!canSplit ? 'Abrir ao lado (sem espaço)' : 'Abrir ao lado'}
            </DropdownMenuItem>
            {chat && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onRename({ sessionId: chat, claudinhoName: custom })}>
                  <PencilLine /> Renomear {claudinhoName(chat, custom)}
                </DropdownMenuItem>
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function TabBar({ group, onMenu }: { group: Group; onMenu: (at: TabMenuAt) => void }) {
  const dragging = useDraggingTab()
  // Onde a aba arrastada entraria nesta barra, se soltar agora.
  const [dropAt, setDropAt] = useState<number | null>(null)
  const isFresh = useArrivals(group.id, group.tabs.map((t) => t.key))
  const drop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData(TAB_DRAG)
    setDropAt(null)
    if (!raw) return
    e.preventDefault()
    e.stopPropagation()
    const from = JSON.parse(raw) as { group: string; key: string }
    moveTab(from.group, from.key, group.id, dropAt ?? group.tabs.length)
  }
  return (
    <div
      role="tablist"
      aria-label="Abas"
      // Na casca, colada no topo da janela. Sem barra de rolagem entre as duas: a roda do mouse anda pelas abas.
      className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
      onWheel={(e) => {
        if (e.deltaY && !e.deltaX) e.currentTarget.scrollLeft += e.deltaY
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TAB_DRAG)) return
        e.preventDefault()
        setDropAt((at) => at ?? group.tabs.length)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null)
      }}
      onDrop={drop}
    >
      {group.tabs.map((tab, i) => (
        <TabItem
          key={tab.key}
          group={group}
          tab={tab}
          index={i}
          active={tab.key === group.active}
          fresh={isFresh(tab.key)}
          drop={dragging && dropAt === i ? 'before' : dragging && dropAt === group.tabs.length && i === group.tabs.length - 1 ? 'after' : null}
          onDrop={setDropAt}
          onMenu={onMenu}
        />
      ))}
      {/* O resto da barra: soltar aqui leva a aba para o fim. */}
      <div className="min-w-8 flex-1" />
    </div>
  )
}

/** Um arquivo como aba: a barra do projeto mostra o projeto dele, e menções vão para a última conversa dele. */
function FileTabContent({ tab, active }: { tab: Extract<Tab, { kind: 'file' }>; active: boolean }) {
  useShowProject(tab.machine, tab.cwd, null, active)
  return (
    <MachineContext value={tab.machine}>
      <ViewerBody viewing={{ machine: tab.machine, cwd: tab.cwd, path: tab.path, diff: tab.diff }} dialog={false} />
    </MachineContext>
  )
}

/**
 * Uma issue ou um PR como aba, para analisar: a barra do projeto mostra o projeto dele, e o "mandar
 * para o chat" vai para a última conversa dele. Busca com a aba à vista, mesmo com o grupo fora de foco.
 */
function GithubTabContent({ tab, visible, focused }: { tab: Extract<Tab, { kind: 'github' }>; visible: boolean; focused: boolean }) {
  useShowProject(tab.machine, tab.cwd, null, focused)
  return <GithubItemView machine={tab.machine} cwd={tab.cwd} kind={tab.item} number={tab.number} title={tab.title} active={visible} />
}

/**
 * A conversa nova como aba, para não tirar da tela o que já estava aberto: a primeira mensagem cria a
 * sessão e a aba vira a dela, no mesmo lugar; trocar o projeto troca a aba pela conversa nova do outro.
 */
function NewTabContent({ tab, focused }: { tab: Extract<Tab, { kind: 'new' }>; focused: boolean }) {
  return (
    <NewChatView
      machine={tab.machine}
      cwd={tab.cwd}
      workspace={tab.workspace}
      showProject={focused}
      onCreated={(id) => replaceTab(tab.key, { kind: 'chat', id })}
      onPick={(cwd, machine, workspace) => replaceTab(tab.key, { kind: 'new', machine, cwd, workspace })}
    />
  )
}

function InboxTabLabel() {
  const count = useInboxCount()
  return (
    <>
      <Inbox className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">Inbox</span>
      {count > 0 && <span className="shrink-0 rounded-full bg-sky-600 px-1.5 text-[10px] leading-4 font-semibold text-white tabular-nums">{count > 99 ? '99+' : count}</span>}
    </>
  )
}

function WorkspaceTabLabel({ tab }: { tab: Extract<Tab, { kind: 'workspace' }> }) {
  const ws = useWorkspaces((s) => s.byMachine[tab.machine]?.find((w) => w.id === tab.id))
  return (
    <>
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: workspaceColor(ws?.color ?? 0) }} />
      <span className="truncate">{ws?.name ?? 'Workspace'}</span>
    </>
  )
}

/**
 * Uma página do Claude como aba, num mini-navegador: a barra do projeto mostra o projeto dela, como um
 * arquivo. Mexer dentro da página não chega ao grupo (o iframe engole o clique): ela avisa, e o grupo vem para o foco.
 */
function PrototypeTabContent({ tab, group, visible, focused }: { tab: Extract<Tab, { kind: 'prototype' }>; group: string; visible: boolean; focused: boolean }) {
  useShowProject(tab.machine, tab.cwd, null, focused)
  return (
    <PrototypeView
      machine={tab.machine}
      path={tab.path}
      cwd={tab.cwd}
      url={tab.url}
      title={tab.title}
      active={visible}
      onInteract={() => focusGroup(group)}
    />
  )
}

/** O hub do projeto como aba: a barra da direita fica nele, e o que se escreve vai para a caixa do hub. */
function ProjectTabContent({ tab, visible, focused }: { tab: Extract<Tab, { kind: 'project' }>; visible: boolean; focused: boolean }) {
  useShowProject(tab.machine, tab.cwd, `new:${tab.cwd}`, focused)
  return (
    <MachineContext value={tab.machine}>
      <ProjectHub machine={tab.machine} cwd={tab.cwd} active={visible} />
    </MachineContext>
  )
}

type Zone = 'left' | 'center' | 'right'

/**
 * Um grupo: a barra de abas, na casca, e embaixo a janela, com o conteúdo das abas. A janela é um
 * recorte na casca (ver ShellPaint): sem fundo próprio, mostra o do app, com a cena animada contínua
 * desde a margem da tela. As abas inativas ficam montadas, fora da pintura.
 */
function GroupView({
  group,
  focused,
  split,
  canSplit,
  grow,
  zenChat,
  onMenu,
}: {
  group: Group
  focused: boolean
  split: boolean
  canSplit: boolean
  grow: number | null
  zenChat: string | null
  onMenu: (at: TabMenuAt) => void
}) {
  const dragging = useDraggingTab()
  const [zone, setZone] = useState<Zone | null>(null)
  // Só monta a aba que já esteve à vista, como no VSCode: as guardadas da última vez esperam a vez,
  // senão cada conversa restaurada pediria histórico, eventos e git ao mesmo tempo ao abrir o app.
  const [seen, setSeen] = useState(() => new Set(group.active ? [group.active] : []))
  if (group.active && !seen.has(group.active)) setSeen(new Set(seen).add(group.active))
  const zoneOf = (e: React.DragEvent<HTMLElement>): Zone => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    // Bordas criam um lado novo (se ainda cabe); o meio leva a aba para este grupo.
    return canSplit && x < 0.25 ? 'left' : canSplit && x > 0.75 ? 'right' : 'center'
  }
  // Só o próprio grupo, com uma aba só, não tem para onde ir no meio.
  const pointless = dragging?.group === group.id && group.tabs.length === 1
  const tabs = !zenChat
  // A primeira aba aberta fica rente à borda da janela: o canto de cima dela some, e a aba desce reta.
  const flush = tabs && group.tabs[0]?.key === group.active
  const glass = useGlass()
  // Uma janela a mais ou a menos na casca: o recorte dela muda junto.
  useLayoutEffect(() => {
    repaintShell()
    return repaintShell
  }, [])

  return (
    <div
      style={grow === null ? undefined : { flex: `${grow} 1 0%` }}
      className={cn('group/pane relative flex min-h-0 min-w-0 flex-col', grow === null && 'flex-1')}
      onPointerDownCapture={() => focusGroup(group.id)}
      onFocus={(e) => isTextField(e.target) && focusGroup(group.id)}
    >
      {tabs && <TabBar group={group} onMenu={onMenu} />}
      <div
        // O valor muda junto com o canto: é o que avisa a casca para refazer o recorte.
        data-hole={flush ? 'flush' : 'round'}
        // Sem cena atrás, a janela pinta a própria cor: pelo recorte apareceria a margem, que no escuro é mais funda.
        className={cn('relative min-h-0 flex-1 overflow-hidden rounded-pane', flush && 'rounded-tl-none', !glass && 'bg-background')}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(TAB_DRAG)) return
          const z = zoneOf(e)
          if (pointless && z === 'center') return setZone(null)
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setZone((old) => (old === z ? old : z))
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setZone(null)
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData(TAB_DRAG)
          const z = zone
          setZone(null)
          if (!raw || !z) return
          e.preventDefault()
          const from = JSON.parse(raw) as { group: string; key: string }
          if (z === 'center') moveTab(from.group, from.key, group.id)
          else splitTab(from.group, from.key, group.id, z)
        }}
      >
        {group.tabs.map((tab) => {
          const active = tab.key === group.active
          return (
            <div
              key={tab.key}
              role="tabpanel"
              inert={!active}
              // Depois de vista, fica fora da pintura mas montada: rolagem, rascunho e o que a conversa está mostrando ficam.
              // A que fica à vista aparece com um fade (a animação recomeça a cada vez que a classe volta).
              // Um arquivo deixa a cena passar como a conversa, com o véu dele por baixo do código (ver ViewerBody).
              className={cn(
                'absolute inset-0 flex flex-col',
                tab.kind === 'file' && !glass && 'bg-background',
                active ? 'tab-panel-in' : 'invisible [content-visibility:hidden]',
              )}
            >
              {/* Uma aba que quebra mostra o erro só nela; as outras, e o resto do app, seguem de pé. */}
              <ErrorBoundary
                fallback={(error, reset) => (
                  <Crash
                    title="Esta aba não conseguiu abrir"
                    error={error}
                    actions={
                      <>
                        <Button size="sm" variant="outline" onClick={reset}>
                          Tentar de novo
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => closeTab(group.id, tab.key)}>
                          Fechar a aba
                        </Button>
                      </>
                    }
                  />
                )}
              >
                {!seen.has(tab.key) ? null : tab.kind === 'chat' ? (
                  <PaneContext value={{ split, focused: focused && active, collapsed: false }}>
                    <ChatInMachine id={tab.id} />
                  </PaneContext>
                ) : tab.kind === 'file' ? (
                  <FileTabContent tab={tab} active={focused && active} />
                ) : tab.kind === 'github' ? (
                  <GithubTabContent tab={tab} visible={active} focused={focused && active} />
                ) : tab.kind === 'new' ? (
                  <NewTabContent tab={tab} focused={focused && active} />
                ) : tab.kind === 'workspace' ? (
                  <MachineContext value={tab.machine}>
                    <WorkspacePage machine={tab.machine} id={tab.id} />
                  </MachineContext>
                ) : tab.kind === 'inbox' ? (
                  <InboxView panel />
                ) : tab.kind === 'prototype' ? (
                  <PrototypeTabContent tab={tab} group={group.id} visible={active} focused={focused && active} />
                ) : (
                  <ProjectTabContent tab={tab} visible={active} focused={focused && active} />
                )}
              </ErrorBoundary>
            </div>
          )
        })}
        {dragging && zone && (
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-y-2 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/75 backdrop-blur-sm',
              zone === 'center' ? 'inset-x-2' : zone === 'left' ? 'left-2 w-[calc(50%-0.75rem)]' : 'right-2 w-[calc(50%-0.75rem)]',
            )}
          >
            <span className="rounded-full bg-primary px-3 py-1 text-sm font-medium text-primary-foreground shadow-md">
              {zone === 'center' ? 'Abrir aqui' : 'Abrir ao lado'}
            </span>
          </div>
        )}
        {split && (
          // Fora de foco, a janela do grupo fica atrás de um véu na cor do fundo (ver pages/split.tsx).
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-0 z-30 bg-background/45 transition-opacity duration-200',
              focused ? 'opacity-0' : 'group-hover/pane:opacity-60',
            )}
          />
        )}
      </div>
    </div>
  )
}

/** A borda entre dois grupos: o mesmo arrasto da divisória entre conversas, com o peso salvo por grupo. */
function GroupDivider({ a, b, groups }: { a: string; b: string; groups: string[] }) {
  const wa = useSplitSizes((s) => s.weights[a] ?? 1)
  const wb = useSplitSizes((s) => s.weights[b] ?? 1)
  const share = (f: number) => setSplitWeights({ [a]: (wa + wb) * f, [b]: (wa + wb) * (1 - f) })
  return (
    <ResizeHandle
      between="windows"
      label="Tamanho dos grupos"
      value={Math.round((wa / (wa + wb)) * 100)}
      reset="meio a meio"
      onStart={(bar) => {
        const before = bar.previousElementSibling?.getBoundingClientRect()
        const after = bar.nextElementSibling?.getBoundingClientRect()
        if (!before || !after) return null
        const total = before.width + after.width
        const lo = Math.min(300, total / 2)
        return (delta) => share(Math.min(total - lo, Math.max(lo, before.width + delta)) / total)
      }}
      onStep={(dir) => share(Math.min(0.85, Math.max(0.15, wa / (wa + wb) + dir * KEY_STEP)))}
      onReset={() => share(0.5)}
      onEnd={() => saveSplitSizes(groups)}
    />
  )
}

/**
 * A tela das conversas no PC: grupos lado a lado, cada um com a sua barra de abas (ver
 * lib/workbench.ts). Arrastar uma aba a leva para outro lugar da barra, para outro grupo, ou, solta na
 * borda de um grupo, abre um grupo novo ao lado. Em modo zen, só a conversa dele fica, sem as abas.
 */
export function Workbench() {
  useUrlSync()
  useViewingSync()
  const groups = useWorkbench((s) => s.groups)
  const focusedId = useWorkbench((s) => s.focused)
  const max = useMaxChats()
  const weights = useSplitSizes((s) => s.weights)
  const zenId = useZen((s) => s.id)
  const [menu, setMenu] = useState<TabMenuAt | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [naming, setNaming] = useState<{ sessionId: string; claudinhoName?: string } | null>(null)
  const [namingOpen, setNamingOpen] = useState(false)

  // Janela que encolheu: os grupos que não cabem ficam fora até ela crescer de novo, como no split.
  const shown = groups.slice(0, max)
  const ids = shown.map((g) => g.id)
  const zenGroup = zenId
    ? shown.find((g) => {
        const t = activeTab(g)
        return t?.kind === 'chat' && t.id === zenId
      })
    : undefined
  const visible = zenGroup ? [zenGroup] : shown
  const raw = visible.map((g) => weights[g.id] ?? 1)
  const total = raw.reduce((sum, w) => sum + w, 0)
  const focused = visible.some((g) => g.id === focusedId) ? focusedId : visible[0]?.id

  return (
    <div className="relative flex min-h-0 flex-1 flex-row">
      {visible.map((g, i) => (
        <Fragment key={g.id}>
          {i > 0 && <GroupDivider a={visible[i - 1]!.id} b={g.id} groups={ids} />}
          <GroupView
            group={g}
            focused={g.id === focused}
            split={visible.length > 1}
            canSplit={groups.length < max}
            grow={visible.length > 1 ? (raw[i]! / total) * visible.length : null}
            zenChat={zenGroup ? zenId : null}
            onMenu={(at) => {
              setMenu(at)
              setMenuOpen(true)
            }}
          />
        </Fragment>
      ))}
      <UnsavedDialog />
      <TabMenu
        at={menu}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        canSplit={groups.length < max}
        onRename={(session) => {
          setNaming(session)
          setNamingOpen(true)
        }}
      />
      <ClaudinhoNameDialog session={naming} open={namingOpen} onOpenChange={setNamingOpen} />
    </div>
  )
}
