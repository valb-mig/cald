import { CircleDot, FolderTree, GitBranch, GitPullRequest, ListTodo, PanelRight, PanelRightClose, PanelRightOpen, Search, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { ClaudeMark } from '@/components/claude-mark'
import { ClaudeTab } from '@/components/claude/claude-tab'
import { RailItem } from '@/components/sidebar-rail'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { SlidePanel } from '@/components/ui/slide-panel'
import { TooltipProvider } from '@/components/ui/tooltip'
import { projectName } from '@/lib/format'
import { useGithubCounts } from '@/lib/github'
import { useGitStatus, useWide } from '@/lib/hooks'
import { MachineContext } from '@/lib/machines'
import { useMemoryAlerts } from '@/lib/memory'
import {
  isPanelShown,
  PANEL_MAX,
  PANEL_MIN,
  PANEL_RAIL,
  PANEL_WIDTH,
  savePanel,
  setPanelShown,
  setPanelTab,
  setPanelWidth,
  togglePanel,
  useProjectPanel,
  type PanelProject,
  type PanelTab,
} from '@/lib/project-panel'
import { broughtFocus, GAP, MIN_CHAT, useMainWidth, usePane, useSplit } from '@/lib/split'
import { useTodos } from '@/lib/todos'
import { cn } from '@/lib/utils'
import { FilesTab } from './files'
import { SearchTab } from './search'
import { IssuesTab, PullsTab } from './github'
import { SourceControlTab } from './source-control'
import { TodoTab } from './todo'

/** Quanto cada toque nas setas do teclado muda a largura da barra. */
const KEY_STEP = 24

/**
 * O arrasto da divisória, como no VSCode: abaixo da metade da largura mínima a barra recolhe (e guarda
 * a largura de antes do arrasto, `before`, para o botão a reabrir como estava); puxada de volta, reabre
 * já na largura do arrasto.
 */
function toward(width: number, fit: (w: number) => number, before: number): void {
  const open = useProjectPanel.getState().open
  if (width < PANEL_MIN / 2) {
    setPanelWidth(before)
    if (open) setPanelShown(false)
    return
  }
  if (!open) setPanelShown(true)
  setPanelWidth(fit(width))
}

// A marca do Claude na cor das outras abas: o laranja dela ficaria aceso o tempo todo na alça.
const ClaudeIcon = ({ className }: { className?: string }) => <ClaudeMark className={cn('fill-current', className)} />

const TABS: { tab: PanelTab; label: string; title: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { tab: 'files', label: 'Arquivos', title: 'Arquivos do projeto', icon: FolderTree },
  { tab: 'search', label: 'Buscar', title: 'Buscar nos arquivos · Ctrl+Shift+F', icon: Search },
  { tab: 'git', label: 'Git', title: 'Controle de código-fonte', icon: GitBranch },
  { tab: 'pulls', label: 'PRs', title: 'Pull requests abertos', icon: GitPullRequest },
  { tab: 'issues', label: 'Issues', title: 'Issues abertas', icon: CircleDot },
  { tab: 'todo', label: 'TODO', title: 'TODO do projeto', icon: ListTodo },
  { tab: 'claude', label: 'Claude', title: 'Memória, skills e MCP do Claude', icon: ClaudeIcon },
]

/** Contador cinza: quantidade, não alerta (o azul com brilho fica para os arquivos alterados). */
const COUNT_BADGE = 'bg-zinc-500'

/**
 * O conteúdo da aba aberta. Na folha (celular, janela estreita), com as abas e o X no topo; ao lado das
 * conversas, as abas estão na alça, e o topo fica só com o nome da aba, como no VSCode.
 */
function PanelBody({ project, tabs }: { project: PanelProject; tabs: boolean }) {
  const tab = useProjectPanel((s) => s.tab)
  // Abrir a barra relê o git: o que ela mostra é o de agora.
  const git = useGitStatus(project.machine, project.cwd, null)
  const changes = git.status?.files.length ?? 0
  return (
    <MachineContext value={project.machine}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Na folha, a altura do cabeçalho da conversa; ao lado das conversas, na altura das abas delas
            (ver pages/workbench.tsx), sem linha: a casca já separa. */}
        <div
          className={cn(
            'flex shrink-0 items-center gap-1 px-2',
            tabs ? 'border-b pt-[max(0.5rem,env(safe-area-inset-top))] pb-2' : 'mt-gap h-9',
          )}
          role={tabs ? 'tablist' : undefined}
        >
          {tabs ? (
            <>
              {/* Sete abas não cabem em todo celular: a fileira rola de lado. */}
              <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
                {TABS.map(({ tab: t, label, title, icon: Icon }) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => setPanelTab(t)}
                    title={title}
                    className={cn(
                      'flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors',
                      tab === t ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <Icon className="size-4" />
                    {label}
                    {t === 'git' && changes > 0 && (
                      <span className="min-w-4 rounded-full bg-sky-600 px-1 text-center text-[10px] leading-4 font-semibold text-white tabular-nums">
                        {changes > 99 ? '99+' : changes}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <Button variant="ghost" size="icon" onClick={() => setPanelShown(false)} aria-label="Fechar a barra do projeto" title="Fechar">
                <X />
              </Button>
            </>
          ) : (
            <h2 className="px-1 text-[13px] font-medium">{TABS.find((t) => t.tab === tab)!.title}</h2>
          )}
        </div>
        {tab === 'files' ? (
          <FilesTab project={project} status={git.status} />
        ) : tab === 'search' ? (
          <SearchTab project={project} />
        ) : tab === 'git' ? (
          <SourceControlTab project={project} status={git.status} loading={git.loading} />
        ) : tab === 'pulls' ? (
          <PullsTab project={project} />
        ) : tab === 'issues' ? (
          <IssuesTab project={project} />
        ) : tab === 'todo' ? (
          <TodoTab project={project} />
        ) : (
          <ClaudeTab project={project} />
        )}
      </div>
    </MachineContext>
  )
}

/**
 * A alça da barra do projeto, sempre à direita no PC, como a da esquerda: o botão do topo abre e
 * recolhe a barra, e os ícones embaixo são as abas (tocar na aberta recolhe, como no VSCode).
 */
function ProjectRail({ project }: { project: PanelProject }) {
  const shown = useProjectPanel(isPanelShown)
  const tab = useProjectPanel((s) => s.tab)
  const changes = useGitStatus(project.machine, project.cwd, null).status?.files.length ?? 0
  // PRs e issues: só o que as abas já buscaram (a alça não consulta o GitHub). O TODO é local e leve.
  const github = useGithubCounts(project.machine, project.cwd)
  const todo = useTodos(project.machine, project.cwd)?.filter((t) => !t.done).length ?? 0
  // A memória: só o que o Claude não chega a ver (fora do índice, link quebrado), não as só antigas.
  const memory = useMemoryAlerts(project.machine, project.cwd)
  const counts: Record<PanelTab, { n: number; badge: string; tip: (n: number) => string } | null> = {
    files: null,
    search: null,
    git: { n: changes, badge: 'bg-sky-600 shadow-[0_0_10px_-1px_rgb(14_165_233/0.8)]', tip: (n) => `${n} ${n === 1 ? 'alterado' : 'alterados'}` },
    pulls: github && { n: github.pulls, badge: COUNT_BADGE, tip: (n) => `${n} ${n === 1 ? 'aberto' : 'abertos'}` },
    issues: github && { n: github.issues, badge: COUNT_BADGE, tip: (n) => `${n} ${n === 1 ? 'aberta' : 'abertas'}` },
    todo: { n: todo, badge: COUNT_BADGE, tip: (n) => `${n} por fazer` },
    claude: { n: memory, badge: 'bg-amber-500', tip: (n) => `${n} ${n === 1 ? 'memória pede' : 'memórias pedem'} atenção` },
  }
  const pick = (t: PanelTab) => {
    if (shown && tab === t) return setPanelShown(false)
    setPanelTab(t)
    setPanelShown(true)
  }
  return (
    <TooltipProvider delayDuration={200}>
      <aside aria-label="Alça da barra do projeto" style={{ width: PANEL_RAIL }} className="flex shrink-0 flex-col items-center gap-1 py-3">
        <RailItem side="left" label={shown ? 'Recolher a barra do projeto' : 'Abrir a barra do projeto'} onClick={togglePanel}>
          {shown ? <PanelRightClose /> : <PanelRightOpen />}
        </RailItem>
        <div className="my-1 h-px w-6 bg-foreground/10" />
        {TABS.map(({ tab: t, title, icon: Icon }) => {
          const count = counts[t]
          return (
            <RailItem
              key={t}
              side="left"
              label={count?.n ? `${title} · ${count.tip(count.n)}` : title}
              active={shown && tab === t}
              badge={count ? Math.min(count.n, 99) : undefined}
              badgeClassName={count?.badge}
              onClick={() => pick(t)}
            >
              <Icon />
            </RailItem>
          )
        })}
      </aside>
    </TooltipProvider>
  )
}

/**
 * A barra do projeto à direita (ver lib/project-panel.ts). No PC, a alça fica sempre na borda, e a
 * barra entre ela e as conversas, com a divisória para mudar a largura, enquanto sobra espaço para
 * cada conversa na largura mínima; senão, e no celular, a barra abre por cima como folha. No modo zen
 * some tudo, alça incluída.
 */
export function ProjectBar({ hidden }: { hidden: boolean }) {
  const project = useProjectPanel((s) => s.project)
  const open = useProjectPanel((s) => s.open)
  const sheet = useProjectPanel((s) => s.sheet)
  const width = useProjectPanel((s) => s.width)
  const wide = useWide()
  // Já sem a alça (ver useMainWidth).
  const main = useMainWidth()
  const { panes, max } = useSplit()
  // O que sobra para a barra com cada lado da tela na largura mínima (e a folga da divisória).
  const room = main - MIN_CHAT * Math.max(1, Math.min(panes, max)) - GAP
  const docked = wide && room >= PANEL_MIN

  useEffect(() => {
    useProjectPanel.setState({ docked })
  }, [docked])
  // Saiu da conversa: a folha fecha junto, para não reabrir sozinha na próxima.
  useEffect(() => {
    if (!project) useProjectPanel.setState({ sheet: false })
  }, [project])

  if (!project || (wide && hidden)) return null
  const key = `${project.machine}\n${project.cwd}`
  const rail = wide && <ProjectRail project={project} />

  if (docked) {
    const shown = Math.min(width, room)
    const hi = Math.min(PANEL_MAX, room)
    const fit = (w: number) => Math.min(hi, Math.max(PANEL_MIN, w))
    // A divisória fica também com a barra recolhida, para puxá-la de volta pela borda (ver `toward`).
    const handle = (
      <ResizeHandle
        between="windows"
        label="Largura da barra do projeto"
        value={open ? Math.round(((main - shown) / main) * 100) : 0}
        onStart={() => {
          const start = open ? shown : 0
          return (delta) => toward(start - delta, fit, width)
        }}
        onStep={(dir) => (open ? setPanelWidth(fit(shown - dir * KEY_STEP)) : dir < 0 && setPanelShown(true))}
        onReset={() => {
          setPanelWidth(PANEL_WIDTH)
          setPanelShown(true)
        }}
        onEnd={savePanel}
      />
    )
    return (
      <>
        {handle}
        {/* Na casca, sem fundo próprio: a cor vem dela (ver ShellPaint). */}
        <SlidePanel open={open} size={shown} side="right" label={`Projeto ${projectName(project.cwd)}`}>
          <PanelBody key={key} project={project} tabs={false} />
        </SlidePanel>
        {rail}
      </>
    )
  }

  return (
    <>
      {rail}
      <Sheet open={sheet} onOpenChange={setPanelShown}>
        <SheetContent
          side="right"
          showCloseButton={false}
          // Mencionar um arquivo fecha a folha e põe o cursor no campo de mensagem: o foco fica lá.
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="gap-0 p-0 data-[side=right]:w-[94vw] data-[side=right]:max-w-md data-[side=right]:sm:max-w-md"
        >
          <SheetTitle className="sr-only">Projeto {projectName(project.cwd)}</SheetTitle>
          <SheetDescription className="sr-only">Arquivos e controle de código-fonte do projeto</SheetDescription>
          <PanelBody key={key} project={project} tabs />
        </SheetContent>
      </Sheet>
    </>
  )
}

/**
 * O botão do cabeçalho que abre e fecha a barra do projeto, com quantos arquivos o git vê alterados.
 * Só no celular: no PC quem faz isso é a alça da direita. Lado a lado, tocar nele numa conversa fora de
 * foco com a barra já aberta só traz o projeto dela.
 */
export function ProjectPanelButton({ changes }: { changes: number }) {
  const shown = useProjectPanel(isPanelShown)
  // Lado a lado, só a conversa em foco aparece como a da barra aberta.
  const focused = usePane().focused
  const bringing = useRef(false)
  return (
    <Button
      variant={shown && focused ? 'secondary' : 'ghost'}
      size="icon"
      className="relative wide:hidden"
      onPointerDown={(e) => (bringing.current = broughtFocus(e.nativeEvent))}
      onClick={() => {
        const bring = shown && bringing.current
        bringing.current = false
        if (!bring) togglePanel()
      }}
      aria-pressed={shown && focused}
      aria-label={`Arquivos e git do projeto${changes ? `: ${changes} alterados` : ''}`}
      title="Arquivos e git do projeto"
    >
      <PanelRight />
      {changes > 0 && (
        <span className="absolute top-0.5 right-0 min-w-4 rounded-full bg-sky-600 px-1 text-center text-[9px] leading-4 font-semibold text-white">
          {changes > 99 ? '99+' : changes}
        </span>
      )}
    </Button>
  )
}
