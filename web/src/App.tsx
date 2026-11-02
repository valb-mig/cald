import { useEffect } from 'react'
import { Redirect, Route, Switch, useLocation } from 'wouter'
import { ComputerSheet } from '@/components/computer-sheet'
import { BottomNav, ConnectionBanner } from '@/components/layout'
import { ProjectBar } from '@/components/project/panel'
import { ProjectViewer } from '@/components/project/viewer'
import { ShellPaint } from '@/components/shell-paint'
import { SidebarMeters, SidebarRail } from '@/components/sidebar-rail'
import { BottomPanel, StatusBar } from '@/components/status-bar'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { Wallpaper } from '@/components/wallpaper/wallpaper'
import { setComputerOpen } from '@/lib/computer'
import { useWide } from '@/lib/hooks'
import { loadMachines } from '@/lib/machines'
import {
  saveSidebarWidth,
  setSidebarCollapsed,
  setSidebarWidth,
  showSidebarView,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_WIDTH,
  useSidebar,
} from '@/lib/sidebar'
import { useZen } from '@/lib/zen'
import { MIN_CHAT, useMainWidth, useMaxChats, useSplit } from '@/lib/split'
import { startOutbox } from '@/lib/outbox'
import { startSounds } from '@/lib/sounds'
import { startTitle } from '@/lib/title'
import { syncPush } from '@/lib/push'
import { connect } from '@/lib/store'
import { watchUpdates } from '@/lib/update'
import { rememberTab } from '@/lib/tabs'
import { cn } from '@/lib/utils'
import { HomePage } from '@/pages/home'
import { NewChatPage } from '@/pages/new-chat'
import { OfficePage } from '@/pages/office'
import { ProjectsPage } from '@/pages/projects'
import { SessionsPage } from '@/pages/sessions'
import { SharePage } from '@/pages/share'
import { ChatSplit } from '@/pages/split'
import { Workbench } from '@/pages/workbench'

/** Quanto cada toque nas setas do teclado muda a largura da lista. */
const KEY_STEP = 24

export default function App() {
  const [location, navigate] = useLocation()
  const wide = useWide()
  // Modo zen: vale enquanto a conversa em que ele foi ligado estiver na tela (ver lib/zen.ts).
  const zenId = useZen((s) => s.id)
  const open = useSplit().ids
  const zen = zenId !== null && open.includes(zenId)

  useEffect(() => {
    // Outras máquinas suas com o Claude Remote (ver lib/machines.ts); a lista guardada vale até a resposta.
    const refresh = () => void loadMachines().catch(() => {})
    refresh()
    const machines = setInterval(refresh, 60_000)
    connect()
    startOutbox()
    startSounds()
    startTitle()
    watchUpdates()
    void syncPush().catch(() => {})
    return () => clearInterval(machines)
  }, [])

  // Toque numa notificação com o app já aberto: o service worker pede a troca de tela.
  useEffect(() => {
    const onMessage = (e: MessageEvent<{ type?: string; url?: string }>) => {
      if (e.data?.type === 'navigate' && e.data.url) navigate(e.data.url)
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [navigate])

  // A salinha fica sozinha na tela, sem a lista nem as abas: é para deixar de fundo.
  if (location === '/salinha') {
    return (
      <div className="flex h-dvh flex-col bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
        <ConnectionBanner />
        <OfficePage />
      </div>
    )
  }

  return (
    // Na horizontal, o entalhe da câmera fica num dos lados.
    <div
      className={cn(
        'relative isolate flex h-dvh bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]',
        // No PC, ilhas soltas sobre o fundo: a barra lateral e a casca, com a mesma margem em volta e entre elas.
        'wide:py-frame wide:pr-[max(var(--frame),env(safe-area-inset-right))] wide:pl-[max(var(--frame),env(safe-area-inset-left))]',
      )}
    >
      {/* No PC, a cena animada é o fundo do app inteiro: aparece na margem e, pelo recorte da casca, na
          janela das conversas, contínua. No celular ela fica só atrás da conversa (ver pages/split.tsx). */}
      {wide && <Wallpaper className="-z-10" />}
      {wide && !zen && (
        <>
          <Sidebar />
          <SidebarHandle />
        </>
      )}
      {/* A casca (ver index.css): as conversas e a barra do projeto numa ilha só. No celular não há casca. */}
      <div className="relative isolate flex min-w-0 flex-1 wide:overflow-hidden wide:rounded-island wide:shadow-island">
        {wide && <ShellPaint />}
        {/* Relativo para o arquivo aberto pela barra do projeto cobrir só a área das conversas. */}
        <div className={cn('relative flex min-w-0 flex-1 flex-col', wide ? 'p-gap' : 'mx-auto max-w-2xl compact:max-w-none')}>
          <ConnectionBanner />
          <Switch>
            <Route path="/s/:id">
              {/* No PC, abas como no VSCode (ver lib/workbench.ts); no celular, a tela segue a URL. */}
              {wide ? <Workbench /> : <ChatSplit />}
            </Route>
            {/* As abas com um arquivo, issue ou PR em foco (ver WORKBENCH_PATH); no celular não há abas. */}
            <Route path="/abas">{wide ? <Workbench /> : <Redirect to="/" />}</Route>
            <Route path="/nova">
              <Pane>
                <NewChatPage />
              </Pane>
            </Route>
            <Route path="/compartilhar">
              <Pane>
                <SharePage />
              </Pane>
            </Route>
            <Route path="/">
              {wide ? (
                <Pane>
                  <WideHome />
                </Pane>
              ) : (
                <TabPages wide={false} />
              )}
            </Route>
            <Route>
              <Pane>
                <TabPages wide={wide} />
              </Pane>
            </Route>
          </Switch>
          {/* No PC, embaixo das conversas: o painel de comandos e a barra de status, como no VSCode. */}
          {wide && <BottomPanel />}
          {wide && <StatusBar />}
          <ProjectViewer />
        </div>
        {/* Arquivos e git do projeto da conversa em foco, à direita como no VSCode. */}
        <ProjectBar hidden={zen} />
      </div>
      <ComputerSheet />
    </div>
  )
}

/**
 * PC e tablet deitado: a barra lateral, uma ilha só com a alça (abas e métricas) e, ao lado dela, a
 * lista escolhida na alça (conversas ou projetos), que recolhe pelo botão do topo dela, com as
 * métricas no pé. Recolhida, a ilha fica só com a alça, e as métricas voltam para ela.
 */
function Sidebar() {
  const collapsed = useSidebar((s) => s.collapsed)
  const width = useSidebar((s) => s.width)
  const view = useSidebar((s) => s.view)
  return (
    <div className="relative flex shrink-0 overflow-hidden rounded-island bg-shell shadow-island-ring">
      <SidebarRail />
      {!collapsed && (
        <aside style={{ width }} className="flex shrink-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
            {view === 'projects' ? <ProjectsPage sidebar /> : <SessionsPage sidebar />}
          </div>
          <SidebarMeters />
        </aside>
      )}
      {/* O fio de luz da borda de cima, por cima de tudo: na ilha mesmo, o cabeçalho fixo da lista (com
          fundo próprio) pintava em cima dele, e a borda sumia na parte da lista. */}
      <span aria-hidden className="pointer-events-none absolute inset-0 z-20 rounded-island shadow-island-shine" />
    </div>
  )
}

/**
 * A margem entre a barra lateral e a casca: arrastar muda a largura da lista, até onde a conversa ao
 * lado (ou cada uma, lado a lado) ainda cabe na largura mínima. Como no VSCode, abaixo da metade da
 * largura mínima a lista recolhe, e puxar a margem de volta a reabre já na largura do arrasto.
 */
function SidebarHandle() {
  const collapsed = useSidebar((s) => s.collapsed)
  const width = useSidebar((s) => s.width)
  const main = useMainWidth()
  const panes = Math.max(1, Math.min(useSplit().panes, useMaxChats()))
  // O que a lista e as conversas dividem: recolhida, a lista não ocupa nada.
  const total = (collapsed ? 0 : width) + main
  const hi = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, total - MIN_CHAT * panes))
  const set = (w: number) => setSidebarWidth(Math.round(Math.min(hi, Math.max(SIDEBAR_MIN, w))))
  // `before`: a largura de antes do arrasto, que fica guardada ao recolher, para o botão reabrir como estava.
  const toward = (w: number, before: number) => {
    const closed = useSidebar.getState().collapsed
    if (w < SIDEBAR_MIN / 2) {
      setSidebarWidth(before)
      if (!closed) setSidebarCollapsed(true)
      return
    }
    if (closed) setSidebarCollapsed(false)
    set(w)
  }
  return (
    <ResizeHandle
      between="islands"
      label="Largura da lista de conversas"
      value={collapsed ? 0 : Math.round((width / total) * 100)}
      onStart={() => {
        const start = collapsed ? 0 : width
        return (delta) => toward(start + delta, width)
      }}
      onStep={(dir) => (collapsed ? dir > 0 && setSidebarCollapsed(false) : set(width + dir * KEY_STEP))}
      onReset={() => {
        setSidebarWidth(SIDEBAR_WIDTH)
        setSidebarCollapsed(false)
      }}
      onEnd={saveSidebarWidth}
    />
  )
}

/** No PC, cada tela fica numa janela dentro da casca, como as conversas; no celular, a tela já é a janela. */
function Pane({ children }: { children: React.ReactNode }) {
  const wide = useWide()
  if (!wide) return children
  return <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-pane bg-background">{children}</div>
}

/** Início, Conversas e Projetos (o Computador abre por cima); no celular deitado, as abas viram uma coluna na lateral. */
function TabPages({ wide }: { wide: boolean }) {
  const [location] = useLocation()
  // O "voltar" de uma conversa leva de volta à aba de onde ela foi aberta.
  useEffect(() => rememberTab(location), [location])
  return (
    <div className="flex min-h-0 flex-1 flex-col compact:flex-row-reverse">
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl">
          <Switch>
            <Route path="/">
              <HomePage />
            </Route>
            <Route path="/conversas">
              <SessionsPage />
            </Route>
            <Route path="/projetos">{wide ? <OpenProjects /> : <ProjectsPage />}</Route>
            <Route path="/computador">
              <OpenComputer />
            </Route>
            <Route>
              <Redirect to="/" />
            </Route>
          </Switch>
        </div>
      </main>
      {!wide && <BottomNav />}
    </div>
  )
}

/** No PC, os projetos ficam na barra lateral: o endereço deles (link da home, favoritos) abre ela neles. */
function OpenProjects() {
  const [, navigate] = useLocation()
  useEffect(() => {
    showSidebarView('projects')
    navigate('/', { replace: true })
  }, [navigate])
  return null
}

/** O endereço da antiga aba Computador (favoritos, histórico): abre o painel por cima do início. */
function OpenComputer() {
  const [, navigate] = useLocation()
  useEffect(() => {
    setComputerOpen(true)
    navigate('/', { replace: true })
  }, [navigate])
  return null
}

/** Tela larga sem conversa aberta: a home, com a lista de conversas ao lado (ou recolhida na alça). */
function WideHome() {
  useEffect(() => rememberTab('/'), [])
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <HomePage />
    </main>
  )
}
