import { ArrowDown, ArrowUp, Bug, Check, GitBranch, Loader2, SquareTerminal, X, XCircle } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import { ToolDetails } from '@/components/chat/activity'
import type { ToolEntry } from '@/components/chat/turn'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { SlidePanel } from '@/components/ui/slide-panel'
import { PANEL_HEIGHT, PANEL_MIN_HEIGHT, saveBottomPanel, setBottomHeight, toggleBottomPanel, useBottomPanel, type BottomTab } from '@/lib/bottom-panel'
import { useChatTools } from '@/lib/chat-tools'
import { projectName, toolSummary } from '@/lib/format'
import { useGitStatus, useHome } from '@/lib/hooks'
import { HOME, machineOf } from '@/lib/machines'
import { setPanelShown, setPanelTab, useProjectPanel } from '@/lib/project-panel'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { activeTab, focusedChat, focusedGroup, useWorkbench } from '@/lib/workbench'

// O xterm é o maior pedaço do app e só serve a quem abre o terminal: chega na primeira vez.
const TerminalView = lazy(() => import('@/components/terminal').then((m) => ({ default: m.TerminalView })))

/**
 * A conversa da barra de status: a em foco nas abas ou, com um arquivo, issue ou PR na frente, a
 * última do projeto deles (a da barra do projeto). O hub e a nova conversa ainda não têm conversa.
 */
function useStatusChat(): string | null {
  const focused = useWorkbench(focusedChat)
  const chat = useProjectPanel((s) => s.project?.chat)
  return focused ?? (chat && !chat.startsWith('new:') ? chat : null)
}

const isCommand = (t: ToolEntry) => t.use.name === 'Bash'

const ITEM =
  'flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5'

function PanelButton({ tab, label, title, icon: Icon, count }: { tab: BottomTab; label: string; title: string; icon: typeof Bug; count?: number }) {
  const shown = useBottomPanel((s) => s.open && s.tab === tab)
  return (
    <button type="button" className={cn(ITEM, shown && 'bg-foreground/5 text-foreground')} onClick={() => toggleBottomPanel(tab)} aria-pressed={shown} title={title}>
      <Icon />
      {label}
      {count ? <span className="tabular-nums">{count}</span> : null}
    </button>
  )
}

/**
 * A barra de status no pé da casca, no PC, como a do VSCode: à esquerda a branch do projeto em foco
 * (com o que falta enviar e receber e quantos arquivos mudaram; tocar abre o git na barra da
 * direita); à direita, o painel de baixo, no terminal do projeto ou nos comandos que o Claude rodou.
 */
export function StatusBar() {
  const project = useProjectPanel((s) => s.project)
  const git = useGitStatus(project?.machine ?? HOME, project?.cwd, null).status
  const chat = useStatusChat()
  const commands = useChatTools((s) => (chat ? (s[chat]?.filter(isCommand).length ?? 0) : 0))
  return (
    <footer className="mt-1 -mb-0.5 flex h-6 shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground" aria-label="Barra de status">
      {project && git?.branch && (
        <button
          type="button"
          className={ITEM}
          onClick={() => {
            setPanelTab('git')
            setPanelShown(true)
          }}
          title="Controle de código-fonte do projeto"
        >
          <GitBranch />
          <span className="max-w-48 truncate">{git.branch}</span>
          {git.ahead > 0 && (
            <span className="flex items-center tabular-nums">
              <ArrowUp className="size-3!" />
              {git.ahead}
            </span>
          )}
          {git.behind > 0 && (
            <span className="flex items-center tabular-nums">
              <ArrowDown className="size-3!" />
              {git.behind}
            </span>
          )}
          {git.files.length > 0 && <span className="tabular-nums">· {git.files.length} alterados</span>}
        </button>
      )}
      <span className="flex-1" />
      <PanelButton tab="terminal" label="Terminal" title="O terminal do projeto, na pasta dele" icon={SquareTerminal} />
      <PanelButton tab="commands" label="Comandos" title="Os comandos que o Claude rodou nesta conversa, com a resposta de cada um" icon={Bug} count={commands} />
    </footer>
  )
}

// ---- comandos ----

const clock = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const titleOf = (t: ToolEntry) => (typeof t.use.input.description === 'string' && t.use.input.description) || toolSummary(t.use.name, t.use.input)

function StatusIcon({ tool, running }: { tool: ToolEntry; running: boolean }) {
  if (!tool.result) {
    return running ? (
      <Loader2 className="size-3.5 shrink-0 animate-spin text-sky-600 dark:text-sky-400" />
    ) : (
      // Sem resposta e a conversa parada: foi interrompido.
      <span className="mx-[3px] size-2 shrink-0 rounded-full bg-muted-foreground/40" />
    )
  }
  return tool.result.isError ? (
    <XCircle className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />
  ) : (
    <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
  )
}

/** Uma linha da lista à direita: o estado, o que o comando faz e a hora. */
function CommandItem({ tool, running, selected, onSelect }: { tool: ToolEntry; running: boolean; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-xs transition-colors',
        selected ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      <StatusIcon tool={tool} running={running} />
      {!isCommand(tool) && <span className="shrink-0 font-medium text-foreground">{tool.use.name}</span>}
      <span className="min-w-0 flex-1 truncate">{titleOf(tool)}</span>
      {tool.at && <span className="shrink-0 text-[10px] tabular-nums opacity-70">{clock(tool.at).slice(0, 5)}</span>}
    </button>
  )
}

/**
 * Os comandos da conversa: o escolhido no meio, inteiro (o comando com as cores e a resposta), e
 * todos na lista à direita — os que estão rodando agora no topo, depois do mais novo ao mais velho.
 * Sem nenhum escolhido, o do meio acompanha o mais recente.
 */
function CommandsView({ chat, all }: { chat: string | null; all: boolean }) {
  const tools = useChatTools((s) => (chat ? s[chat] : undefined))
  const state = useStore((s) => (chat ? s.catalog.find((c) => c.sessionId === chat)?.state : undefined))
  // O escolhido vale só na conversa em que foi escolhido: em outra, volta a acompanhar o mais recente.
  const [choice, setChoice] = useState<{ chat: string | null; key: string } | null>(null)
  const picked = choice?.chat === chat ? choice.key : null
  const setPicked = (key: string | null) => setChoice(key ? { chat, key } : null)

  const list = (tools ?? []).filter((t) => all || isCommand(t))
  const live = state === 'running' || state === 'waiting'
  const running = live ? list.filter((t) => !t.result) : []
  const rest = [...list].reverse().filter((t) => !running.includes(t))
  const shown = list.find((t) => t.key === picked) ?? running.at(-1) ?? list.at(-1)

  const empty = !chat
    ? 'Abra uma conversa para ver o que o Claude rodou nela.'
    : !tools
      ? 'A conversa em foco não está aberta numa aba.'
      : !list.length
        ? all
          ? 'O Claude ainda não usou nenhuma ferramenta nesta conversa.'
          : 'O Claude ainda não rodou nenhum comando nesta conversa.'
        : null
  if (empty) return <p className="p-4 text-sm text-muted-foreground">{empty}</p>

  return (
    <div className="flex min-h-0 flex-1 gap-1.5 pr-1.5 pb-1.5">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 pb-2">
        {shown && (
          <div className="space-y-1.5">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <StatusIcon tool={shown} running={live} />
              {shown.at && <span className="shrink-0 text-muted-foreground tabular-nums">{clock(shown.at)}</span>}
              {!isCommand(shown) && <span className="shrink-0 font-medium">{shown.use.name}</span>}
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{titleOf(shown)}</span>
              {picked && (
                <button type="button" onClick={() => setPicked(null)} className="shrink-0 text-muted-foreground hover:text-foreground">
                  Seguir o mais recente
                </button>
              )}
            </div>
            <ToolDetails use={shown.use} result={shown.result} />
          </div>
        )}
      </div>
      {/* A lista: um recorte na cor da casca, como a barra lateral, sem linha separando. */}
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto rounded-xl bg-foreground/[0.03] p-1" aria-label="Comandos da conversa">
        {running.length > 0 && (
          <>
            <h3 className="px-2 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">Rodando agora</h3>
            {running.map((t) => (
              <CommandItem key={t.key} tool={t} running selected={t === shown} onSelect={() => setPicked(t.key)} />
            ))}
            <div className="h-2" />
          </>
        )}
        <h3 className="px-2 pt-1 pb-1 text-[11px] font-medium text-muted-foreground">
          {all ? 'Todas' : 'Todos'} · {list.length}
        </h3>
        {rest.map((t) => (
          <CommandItem key={t.key} tool={t} running={live} selected={t === shown} onSelect={() => setPicked(t.key)} />
        ))}
      </aside>
    </div>
  )
}

// ---- o painel ----

type Place = { machine: string; cwd: string }
type Shell = Place & { key: string }

/**
 * A pasta do terminal: a do projeto da barra ou, sem ele (a pasta pessoal não põe projeto na barra),
 * a da conversa em foco nas abas; a conversa nova sem projeto abre na pasta pessoal da máquina dela.
 */
function useTerminalPlace(): Place | null {
  const project = useProjectPanel((s) => s.project)
  const tab = useWorkbench((s) => activeTab(focusedGroup(s)))
  const chat = tab?.kind === 'chat' ? tab.id : null
  const entry = useStore((s) => (chat ? s.catalog.find((c) => c.sessionId === chat) : undefined))
  const machine = tab?.kind === 'new' ? tab.machine : chat ? (entry?.machine ?? machineOf(chat)) : HOME
  const home = useHome(machine)
  if (project) return { machine: project.machine, cwd: project.cwd }
  const cwd = chat ? entry?.cwd : tab?.kind === 'new' ? (tab.cwd ?? home) : undefined
  return cwd ? { machine, cwd } : null
}

/**
 * O painel de baixo, no PC (ver lib/bottom-panel.ts): uma janela embaixo das conversas, com a altura
 * na divisória de cima. Na aba Comandos, o que o Claude rodou na conversa da barra de status; na aba
 * Terminal, o shell na pasta dela. Fica montado mesmo fechado, para os terminais abertos (um por
 * pasta) não morrerem ao fechar o painel ou trocar de aba.
 */
export function BottomPanel() {
  const open = useBottomPanel((s) => s.open)
  const tab = useBottomPanel((s) => s.tab)
  const height = useBottomPanel((s) => s.height)
  const chat = useStatusChat()
  const place = useTerminalPlace()
  const [all, setAll] = useState(false)
  // Os terminais já abertos, um por pasta; o da pasta em foco é o que aparece.
  const [shells, setShells] = useState<Shell[]>([])
  const current = place && `${place.machine}\n${place.cwd}`
  // Terminal à vista numa pasta que ainda não tem: abre o dela (ajuste na renderização, sem efeito).
  if (open && tab === 'terminal' && place && current && !shells.some((s) => s.key === current)) {
    setShells([...shells, { key: current, ...place }])
  }

  const fit = (h: number) => Math.round(Math.min(window.innerHeight * 0.7, Math.max(PANEL_MIN_HEIGHT, h)))
  const tabClass = (t: BottomTab) =>
    cn(
      'flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors [&_svg]:size-3.5',
      tab === t ? 'bg-foreground/[0.06] font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
    )
  return (
    <div className="flex shrink-0 flex-col">
      {open && (
      <ResizeHandle
        between="windows"
        stacked
        label="Altura do painel de baixo"
        value={Math.round((height / window.innerHeight) * 100)}
        onStart={() => {
          const start = height
          return (delta) => setBottomHeight(fit(start - delta))
        }}
        onStep={(dir) => setBottomHeight(fit(height - dir * 24))}
        onReset={() => setBottomHeight(PANEL_HEIGHT)}
        onEnd={saveBottomPanel}
      />
      )}
      {/* Sobe da barra de status ao abrir e desce ao fechar; fechado, só some, com os terminais vivos. */}
      <SlidePanel open={open} size={height} side="bottom" keepMounted className="overflow-hidden rounded-pane bg-background" label="Painel de baixo">
        <header className="flex h-10 shrink-0 items-center gap-1 pr-1.5 pl-2">
          <button type="button" className={tabClass('commands')} onClick={() => useBottomPanel.setState({ tab: 'commands' })}>
            <Bug /> Comandos
          </button>
          <button type="button" className={tabClass('terminal')} onClick={() => useBottomPanel.setState({ tab: 'terminal' })}>
            <SquareTerminal /> Terminal
            {tab === 'terminal' && place && <span className="font-normal text-muted-foreground">· {projectName(place.cwd)}</span>}
          </button>
          <span className="flex-1" />
          {tab === 'commands' && (
            <label className="flex cursor-pointer items-center gap-1.5 px-1 text-xs text-muted-foreground select-none">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="accent-foreground" />
              Todas as ferramentas
            </label>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              useBottomPanel.setState({ open: false })
              saveBottomPanel()
            }}
            aria-label="Fechar o painel"
            title="Fechar"
          >
            <X />
          </Button>
        </header>
        {tab === 'commands' && (
          <div className="tab-panel-in flex min-h-0 flex-1 flex-col">
            <CommandsView chat={chat} all={all} />
          </div>
        )}
        {tab === 'terminal' && !place && <p className="p-4 text-sm text-muted-foreground">Abra uma conversa ou um projeto para ter o terminal na pasta dele.</p>}
        {shells.map((s) => (
          <div key={s.key} className={cn('flex min-h-0 flex-1 flex-col', tab === 'terminal' && s.key === current ? 'tab-panel-in' : 'hidden')}>
            <Suspense>
              <TerminalView machine={s.machine} cwd={s.cwd} active={open && tab === 'terminal' && s.key === current} />
            </Suspense>
          </div>
        ))}
      </SlidePanel>
    </div>
  )
}
