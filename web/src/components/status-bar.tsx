import { ArrowDown, ArrowUp, Bug, Check, Eye, GitBranch, Loader2, PanelRight, Plus, Sparkles, SquareTerminal, X, XCircle } from 'lucide-react'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ToolDetails } from '@/components/chat/activity'
import type { ToolEntry } from '@/components/chat/turn'
import { TerminalCommands } from '@/components/terminal-commands'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { SlidePanel } from '@/components/ui/slide-panel'
import { PANEL_HEIGHT, PANEL_MIN_HEIGHT, saveBottomPanel, setBottomHeight, toggleBottomPanel, useBottomPanel, type BottomTab } from '@/lib/bottom-panel'
import { useChatTools } from '@/lib/chat-tools'
import { setChatView, useChatView } from '@/lib/chat-view'
import { editorCommands, useEditorCursor } from '@/lib/editor-cursor'
import { projectName, toolSummary } from '@/lib/format'
import { useGitStatus, useHome } from '@/lib/hooks'
import { useLock } from '@/lib/lock'
import { HOME, machineOf } from '@/lib/machines'
import { setPanelShown, setPanelTab, useProjectPanel } from '@/lib/project-panel'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { closeTerminal, newTerminal, selectTerminal, toggleCommandsBar, useCommandsBar, useTermActivity, useTerminals, type TermActivity, type TermTab } from '@/lib/terminals'
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
      {chat && <ViewToggle chat={chat} />}
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
      <CursorItems />
      <PanelButton tab="terminal" label="Terminal" title="O terminal do projeto, na pasta dele · Ctrl+J" icon={SquareTerminal} />
      <PanelButton tab="commands" label="Comandos" title="Os comandos que o Claude rodou nesta conversa, com a resposta de cada um" icon={Bug} count={commands} />
    </footer>
  )
}

/** O modo de ver a conversa em foco: vibing (o chat de sempre) ou coding (com os passos ao lado do chat). */
function ViewToggle({ chat }: { chat: string }) {
  const coding = useChatView(chat) === 'coding'
  return (
    <button
      type="button"
      className={cn(ITEM, coding && 'bg-foreground/5 text-foreground')}
      onClick={() => setChatView(chat, coding ? 'vibing' : 'coding')}
      aria-pressed={coding}
      title={coding ? 'Modo coding: os passos do Claude ao lado do chat. Tocar volta ao vibing' : 'Modo vibing. Tocar passa ao coding, com os passos do Claude ao lado'}
    >
      {coding ? <Eye /> : <Sparkles />}
      {coding ? 'coding' : 'vibing'}
    </button>
  )
}

/**
 * Do arquivo em foco no editor, como o VSCode: linha e coluna (clicar abre o "ir para a linha"), a
 * indentação, a quebra de linha e a linguagem (ver lib/editor-cursor.ts).
 */
function CursorItems() {
  const key = useWorkbench((s) => {
    const tab = activeTab(focusedGroup(s))
    return tab?.kind === 'file' && !tab.diff ? tab.key : null
  })
  const cursor = useEditorCursor((s) => (key ? s[key] : undefined))
  if (!key || !cursor) return null
  return (
    <>
      <button type="button" className={ITEM} onClick={() => editorCommands.get(key)?.gotoLine()} title="Ir para a linha · Ctrl+G">
        <span className="tabular-nums">
          Ln {cursor.line}, Col {cursor.col}
          {cursor.selected > 0 && ` (${cursor.selected} selecionados)`}
        </span>
      </button>
      <span className={cn(ITEM, 'cursor-default hover:bg-transparent')}>{cursor.indent}</span>
      <span className={cn(ITEM, 'cursor-default hover:bg-transparent')}>{cursor.eol}</span>
      {cursor.language && <span className={cn(ITEM, 'cursor-default hover:bg-transparent')}>{cursor.language}</span>}
    </>
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

/**
 * Onde o "+" abre um terminal: a pasta do projeto da barra ou, sem ele (a pasta pessoal não põe projeto
 * na barra), a da conversa em foco nas abas; sem conversa, a pasta pessoal da máquina dela (ou do PC).
 */
function useTerminalPlace(): Place | null {
  const project = useProjectPanel((s) => s.project)
  const tab = useWorkbench((s) => activeTab(focusedGroup(s)))
  const chat = tab?.kind === 'chat' ? tab.id : null
  const entry = useStore((s) => (chat ? s.catalog.find((c) => c.sessionId === chat) : undefined))
  const machine = tab?.kind === 'new' ? tab.machine : chat ? (entry?.machine ?? machineOf(chat)) : HOME
  const home = useHome(machine)
  if (project) return { machine: project.machine, cwd: project.cwd }
  const cwd = (chat ? entry?.cwd : tab?.kind === 'new' ? tab.cwd : undefined) ?? home
  return cwd ? { machine, cwd } : null
}

/**
 * O fundo da aba à vista, que desliza de uma aba para a outra em vez de pular: mede o item marcado com
 * `data-pill` igual a `active` dentro de `list` e acompanha quando qualquer item muda de tamanho (o
 * nome da pasta muda, uma aba nova cresce, a fechada encolhe). `layout` muda quando os itens mudam.
 */
function usePill(list: React.RefObject<HTMLElement | null>, active: string | null, layout: string): React.CSSProperties | undefined {
  const [box, setBox] = useState<{ x: number; w: number; moved: boolean } | null>(null)
  useLayoutEffect(() => {
    const items = list.current?.querySelectorAll<HTMLElement>('[data-pill]') ?? []
    const el = [...items].find((item) => item.dataset.pill === active)
    if (!el) return setBox(null)
    // A primeira medida (ou a de quando volta a aparecer) só põe no lugar; daí em diante, desliza.
    const measure = () => setBox((b) => (el.offsetWidth ? { x: el.offsetLeft, w: el.offsetWidth, moved: b !== null } : null))
    measure()
    const resize = new ResizeObserver(measure)
    for (const item of items) resize.observe(item)
    return () => resize.disconnect()
  }, [list, active, layout])
  if (!box) return undefined
  return { transform: `translateX(${box.x}px)`, width: box.w, transitionProperty: box.moved ? 'transform, width' : 'none' }
}

function Pill({ style }: { style: React.CSSProperties | undefined }) {
  if (!style) return null
  return (
    <span
      aria-hidden
      style={style}
      className="pointer-events-none absolute inset-y-0 left-0 rounded-lg bg-foreground/[0.06] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-0"
    />
  )
}

/** O último comando da aba: rodando, uma bolinha laranja pulsando; com erro, vermelha; senão, o ícone. */
function ActivityMark({ state }: { state: TermActivity | undefined }) {
  if (state === 'running') return <span className="cr-term-dot size-1.5 shrink-0 rounded-full bg-[#d97757]" title="Rodando um comando" />
  if (state === 'fail') return <span className="cr-fade-in size-1.5 shrink-0 rounded-full bg-red-500" title="O último comando falhou" />
  return <SquareTerminal className="size-3.5 shrink-0 opacity-70" />
}

const termLabel = (t: TermTab, home: string | undefined) => {
  const dir = t.here ?? t.cwd
  return dir === home ? '~' : projectName(dir)
}

/**
 * As abas do terminal, no cabeçalho do painel (ver lib/terminals.ts): uma por shell, com o nome da
 * pasta em que ele está e a bolinha do último comando. Clicar mostra, o botão do meio ou o × fecha (o
 * shell junto), o "+" abre outro na pasta em foco. A aba nova cresce no lugar dela e a fechada encolhe
 * até sumir; o fundo da aberta desliza entre elas.
 */
function TerminalTabs({ place }: { place: Place | null }) {
  const tabs = useTerminals((s) => s.tabs)
  const active = useTerminals((s) => s.active)
  const activity = useTermActivity()
  const home = useHome(HOME)
  const list = useRef<HTMLDivElement>(null)
  // As que já existiam ao abrir o app aparecem paradas; só as criadas agora crescem.
  const [initial] = useState(() => new Set(tabs.map((t) => t.id)))
  const [leaving, setLeaving] = useState<string[]>([])
  const pill = usePill(list, active, tabs.map((t) => `${t.id}:${t.here ?? ''}`).join() + leaving.join())

  const close = (id: string) => {
    if (leaving.includes(id)) return
    const rest = tabs.filter((t) => t.id !== id && !leaving.includes(t.id))
    // A vizinha aparece já, enquanto a fechada encolhe.
    if (active === id) {
      const index = tabs.findIndex((t) => t.id === id)
      const next = tabs.slice(index + 1).find((t) => rest.includes(t)) ?? tabs.slice(0, index).reverse().find((t) => rest.includes(t))
      if (next) selectTerminal(next.id)
    }
    // Encolhe a partir da largura de agora (ver .cr-tab-leave em index.css).
    const el = [...(list.current?.querySelectorAll<HTMLElement>('[data-pill]') ?? [])].find((item) => item.dataset.pill === id)
    el?.style.setProperty('--tab-w', `${el.offsetWidth}px`)
    setLeaving((l) => [...l, id])
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    setTimeout(() => {
      setLeaving((l) => l.filter((x) => x !== id))
      closeTerminal(id)
      // Era a última: o painel fecha, como no VSCode; abrir de novo já traz um terminal novo.
      if (!rest.length) {
        useBottomPanel.setState({ open: false })
        saveBottomPanel()
      }
    }, reduced ? 0 : 200)
  }

  return (
    <div ref={list} role="tablist" aria-label="Terminais" className="relative flex min-w-0 items-center overflow-x-auto [scrollbar-width:none]">
      <Pill style={pill} />
      {tabs.map((t) => {
        const shown = t.id === active
        return (
          <div
            key={t.id}
            role="tab"
            tabIndex={0}
            aria-selected={shown}
            data-pill={t.id}
            title={t.here ?? t.cwd}
            onClick={() => selectTerminal(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') selectTerminal(t.id)
              if (e.key === 'Delete') close(t.id)
            }}
            // Botão do meio fecha, como no navegador e no VSCode; o mousedown dele rolaria a página.
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onAuxClick={(e) => e.button === 1 && close(t.id)}
            className={cn(
              'group/term relative flex h-7 max-w-44 shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg pr-1 pl-2.5 text-xs whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring',
              shown ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              !initial.has(t.id) && 'tab-enter',
              leaving.includes(t.id) && 'cr-tab-leave',
            )}
          >
            <ActivityMark state={activity[t.id]} />
            <span className="truncate">{termLabel(t, home)}</span>
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation()
                close(t.id)
              }}
              aria-label="Fechar o terminal"
              title="Fechar (encerra o shell)"
              className={cn(
                'grid size-4.5 shrink-0 place-items-center rounded-md transition-opacity hover:bg-foreground/10 [&_svg]:size-3',
                shown ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover/term:opacity-70',
              )}
            >
              <X />
            </button>
          </div>
        )
      })}
      <Button
        variant="ghost"
        size="icon-xs"
        className="ml-0.5 shrink-0"
        disabled={!place}
        onClick={() => place && newTerminal(place)}
        aria-label="Novo terminal"
        title={place ? `Novo terminal em ${place.cwd === home ? '~' : projectName(place.cwd)}` : 'Novo terminal'}
      >
        <Plus />
      </Button>
    </div>
  )
}

/**
 * O painel de baixo, no PC (ver lib/bottom-panel.ts): uma janela embaixo das conversas, com a altura
 * na divisória de cima. Na aba Comandos, o que o Claude rodou na conversa da barra de status; na aba
 * Terminal, os terminais abertos, cada um numa aba própria. Fica montado mesmo fechado, para os
 * terminais não morrerem ao fechar o painel; e eles não seguem a conversa em foco, então trocar de
 * aba nas conversas deixa o terminal como está. À direita do terminal, a barra dos comandos salvos
 * (ver terminal-commands.tsx), que liga e desliga no cabeçalho.
 */
export function BottomPanel() {
  const open = useBottomPanel((s) => s.open)
  const tab = useBottomPanel((s) => s.tab)
  const height = useBottomPanel((s) => s.height)
  const chat = useStatusChat()
  const place = useTerminalPlace()
  const [all, setAll] = useState(false)
  const terms = useTerminals((s) => s.tabs)
  const activeTerm = useTerminals((s) => s.active)
  const commandsBar = useCommandsBar((s) => s.open)
  const panelTabs = useRef<HTMLDivElement>(null)
  const panelPill = usePill(panelTabs, tab, '')
  // Para o terminal que entra vir do lado da aba dele: da direita, se ela fica depois da que saiu.
  const index = terms.findIndex((t) => t.id === activeTerm)
  const [order, setOrder] = useState<{ id: string | null; index: number; from: 'left' | 'right' }>({ id: activeTerm, index, from: 'right' })
  if (order.id !== activeTerm) setOrder({ id: activeTerm, index, from: index < order.index ? 'left' : 'right' })

  // Terminal à vista sem nenhum aberto: abre um na pasta em foco.
  const none = terms.length === 0
  const [placeMachine, placeCwd] = [place?.machine, place?.cwd]
  useEffect(() => {
    // A máquina desta página é `''`: o que diz se há lugar é a pasta.
    if (open && tab === 'terminal' && none && placeCwd) newTerminal({ machine: placeMachine ?? HOME, cwd: placeCwd })
  }, [open, tab, none, placeMachine, placeCwd])

  // Ctrl+J, como no VSCode: abre o painel no terminal (que já chega com o foco) e, nele, fecha. Vale
  // também de dentro do terminal, onde o Ctrl+J seria só uma quebra de linha para o shell.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'j') return
      if (useLock.getState().status === 'locked') return
      // No lugar dos downloads do navegador.
      e.preventDefault()
      e.stopPropagation()
      const closing = useBottomPanel.getState().open && useBottomPanel.getState().tab === 'terminal'
      // Fechado com o foco nele, o foco não fica preso num terminal escondido.
      if (closing && document.activeElement instanceof HTMLElement && document.activeElement.closest('.xterm')) document.activeElement.blur()
      toggleBottomPanel('terminal')
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  const fit = (h: number) => Math.round(Math.min(window.innerHeight * 0.7, Math.max(PANEL_MIN_HEIGHT, h)))
  const tabClass = (t: BottomTab) =>
    cn(
      'relative flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors [&_svg]:size-3.5',
      tab === t ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
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
          <div ref={panelTabs} className="relative flex shrink-0 items-center gap-1">
            <Pill style={panelPill} />
            <button type="button" data-pill="commands" className={tabClass('commands')} onClick={() => useBottomPanel.setState({ tab: 'commands' })}>
              <Bug /> Comandos
            </button>
            <button type="button" data-pill="terminal" className={tabClass('terminal')} onClick={() => useBottomPanel.setState({ tab: 'terminal' })}>
              <SquareTerminal /> Terminal
            </button>
          </div>
          {tab === 'terminal' && (
            <>
              <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-foreground/10" />
              <TerminalTabs place={place} />
            </>
          )}
          <span className="flex-1" />
          {tab === 'commands' && (
            <label className="flex cursor-pointer items-center gap-1.5 px-1 text-xs text-muted-foreground select-none">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="accent-foreground" />
              Todas as ferramentas
            </label>
          )}
          {tab === 'terminal' && !none && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={toggleCommandsBar}
              aria-pressed={commandsBar}
              aria-label="Comandos salvos"
              title="Comandos salvos"
              className="text-muted-foreground aria-pressed:bg-foreground/[0.06] aria-pressed:text-foreground"
            >
              <PanelRight />
            </Button>
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
        {tab === 'terminal' && none && !place && <p className="p-4 text-sm text-muted-foreground">Abra uma conversa ou um projeto para ter o terminal na pasta dele.</p>}
        {/* Sempre montado, mesmo em outra aba do painel: os terminais vivem aqui dentro. */}
        <div className={cn('flex min-h-0 flex-1 gap-1', (tab !== 'terminal' || none) && 'hidden')}>
          {/* Recorta a entrada do terminal, que desliza de lado, para não passar por cima da barra. */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {terms.map((t) => {
              const shown = tab === 'terminal' && t.id === activeTerm
              return (
                <div
                  key={t.id}
                  className={cn('flex min-h-0 flex-1 flex-col', shown ? (order.from === 'left' ? 'cr-term-in-left' : 'cr-term-in-right') : 'hidden')}
                >
                  <Suspense>
                    <TerminalView id={t.id} machine={t.machine} cwd={t.cwd} active={open && shown} />
                  </Suspense>
                </div>
              )
            })}
          </div>
          {tab === 'terminal' && !none && commandsBar && <TerminalCommands />}
        </div>
      </SlidePanel>
    </div>
  )
}
