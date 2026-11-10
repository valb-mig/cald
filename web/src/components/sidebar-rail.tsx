import { FolderGit2, House, Inbox, MessagesSquare, OctagonAlert, PanelLeftClose, PanelLeftOpen, TriangleAlert } from 'lucide-react'
import { Link, useLocation } from 'wouter'
import { useShallow } from 'zustand/react/shallow'
import { EditrMark, Claudinho, DevTag } from '@/components/claudinho'
import { severityOf } from '@/components/pc-status'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { openComputerAgent, setComputerOpen, useComputer } from '@/lib/computer'
import { claudinhoName } from '@/lib/claudinho'
import { bytes, resetTime, shortDuration } from '@/lib/format'
import { HOME, useMachineFilter, useMachines } from '@/lib/machines'
import { useInboxCount } from '@/lib/inbox'
import { CLAUDE } from '@/lib/providers'
import { setSidebarCollapsed, toggleSidebarView, useSidebar } from '@/lib/sidebar'
import { chatKey, useStore } from '@/lib/store'
import { useWakatimeToday } from '@/lib/wakatime'
import type { UsageWindow } from '@/lib/types'
import { cn } from '@/lib/utils'
import { focusedChat, onWorkbench, openInbox, useWorkbench, WORKBENCH_PATH } from '@/lib/workbench'

// As medidas ficam no cinza da ilha: a cor (a do quadro do PC, pc-status.tsx) é só para o alerta e o
// crítico, e o verde para a meta de horas batida, em que encher é bom.
const BAR = {
  normal: { fill: 'bg-foreground/40', text: 'text-foreground' },
  warning: { fill: 'bg-[#fab219]', text: 'text-[#c98a00] dark:text-[#fab219]' },
  critical: { fill: 'bg-[#d03b3b]', text: 'text-[#d03b3b]' },
  done: { fill: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
}

type Level = keyof typeof BAR
type Metric = {
  label: string
  percent: number | null
  tip: string
  /** O que vai no lugar da porcentagem. */
  text?: string
  /** Fixo: desliga a escala de severidade, para a medida em que encher não é problema nenhum. */
  level?: Level
  /** Onde o toque leva; sem ele, o painel Computador no Status. */
  open?: () => void
}

const openOf = ({ open }: Metric) => open ?? (() => setComputerOpen(true))

const levelOf = ({ percent, level }: Metric): Level => level ?? (percent !== null ? severityOf(percent) : 'normal')
const valueOf = ({ percent, text }: Metric) => text ?? (percent !== null ? `${Math.round(percent)}%` : '—')
const clamp = (percent: number | null) => (percent === null ? 0 : Math.min(100, Math.max(0, percent)))

function AlertIcon({ level }: { level: Level }) {
  const Icon = level === 'critical' ? OctagonAlert : level === 'warning' ? TriangleAlert : null
  if (!Icon) return null
  return <Icon className={cn('size-2.5 shrink-0', level === 'critical' ? 'text-[#d03b3b]' : 'text-[#c98a00] dark:text-[#fab219]')} aria-hidden />
}

/** O traço fino de uma medida: o trilho apagado e o preenchido no cinza, ou na cor do alerta. */
function Track({ percent, level, className }: { percent: number | null; level: Level; className?: string }) {
  return (
    <span className={cn('h-1 overflow-hidden rounded-full bg-foreground/10', className)}>
      <span className={cn('block h-full rounded-full transition-[width] duration-500', BAR[level].fill)} style={{ width: `${clamp(percent)}%` }} />
    </span>
  )
}

const valueColor = (metric: Metric) => (metric.percent !== null ? BAR[levelOf(metric)].text : 'text-muted-foreground')

/** Na alça estreita, com a lista recolhida: o valor, um traço curto embaixo e o nome. */
function RailMeter(metric: Metric) {
  const level = levelOf(metric)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={openOf(metric)}
          aria-label={metric.tip}
          className="flex w-12 flex-col items-center gap-1 rounded-lg py-1.5 transition-colors hover:bg-foreground/5"
        >
          <span className={cn('text-[11px] leading-none font-medium tabular-nums', valueColor(metric))}>{valueOf(metric)}</span>
          <Track percent={metric.percent} level={level} className="w-7" />
          <span className="flex items-center gap-0.5 text-[10px] leading-none text-muted-foreground">
            <AlertIcon level={level} />
            {metric.label}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{metric.tip}</TooltipContent>
    </Tooltip>
  )
}

/** Uma medida numa linha: nome, traço fino e valor. */
function BarRow(metric: Metric) {
  const { label, percent, tip } = metric
  const level = levelOf(metric)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={openOf(metric)}
          aria-label={tip}
          className="grid w-full grid-cols-[3.75rem_1fr_2.5rem] items-center gap-2 rounded-lg px-2 py-1 text-[11px] transition-colors hover:bg-foreground/5"
        >
          <span className="flex items-center gap-1 text-muted-foreground">
            <AlertIcon level={level} />
            {label}
          </span>
          <Track percent={percent} level={level} />
          <span className={cn('text-right font-medium tabular-nums', valueColor(metric))}>{valueOf(metric)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{tip}</TooltipContent>
    </Tooltip>
  )
}

function windowTip(name: string, w: UsageWindow | null | undefined): string {
  if (!w || w.utilization === null) return `${name}: sem dado`
  return `${name}: ${Math.round(w.utilization)}%${w.resetsAt ? ` · reseta ${resetTime(w.resetsAt)}` : ''}`
}

/** Ícone da alça, com o nome ao passar o mouse; serve também à alça da barra do projeto, à direita. */
export function RailItem({
  label,
  active,
  shown,
  badge,
  badgeClassName = 'bg-amber-500 shadow-[0_0_10px_-1px_rgb(245_158_11/0.8)]',
  side = 'right',
  href,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  /** Uma lista da barra lateral à vista: o traço à esquerda, como no VS Code (o fundo fica para a tela aberta). */
  shown?: boolean
  badge?: number
  /** Cor do contador, com o brilho dela: âmbar pede atenção; a alça da direita usa azul, para os arquivos alterados. */
  badgeClassName?: string
  /** De que lado o nome aparece: o de dentro da tela. */
  side?: 'left' | 'right'
  href?: string
  onClick?: () => void
  children: React.ReactNode
}) {
  const className = cn(
    'relative flex size-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground [&_svg]:size-5',
    // O ativo ganha o destaque da barra lateral (no claro, a cor da janela, como a aba aberta).
    active && 'bg-sidebar-accent text-foreground shadow-xs hover:bg-sidebar-accent',
  )
  const content = (
    <>
      {shown && <span aria-hidden className="absolute top-1/2 -left-2.5 h-5 w-[3px] -translate-y-1/2 rounded-full bg-foreground" />}
      {children}
      {badge ? (
        <span className={cn('absolute -top-0.5 -right-0.5 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-semibold text-white', badgeClassName)}>
          {badge}
        </span>
      ) : null}
    </>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {href ? (
          <Link href={href} aria-label={label} className={className}>
            {content}
          </Link>
        ) : (
          <button type="button" aria-label={label} onClick={onClick} className={className}>
            {content}
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}

const openUsage = () => openComputerAgent(CLAUDE, 'usage')

/** O tempo de hoje, CPU, memória e os limites do Claude, da máquina do filtro das Sessões. */
function useMetrics(): Metric[] {
  const machine = useMachineFilter() ?? HOME
  const system = useStore((s) => s.systems[machine])
  const usage = useStore((s) => s.usages[machine])
  // Com várias máquinas, as medidas dizem de qual é (a do filtro das Sessões).
  const name = useMachines((s) => (s.machines.length > 1 ? s.machines.find((m) => m.id === machine)?.name : undefined))
  const of = (text: string) => (name ? `${name} · ${text}` : text)
  const coding = useWakatimeToday(machine)
  const plan = usage?.plan?.available ? usage.plan : null
  const goal = coding ? coding.goalHours * 3600 : 0
  return [
    ...(coding
      ? [
          {
            label: 'Hoje',
            percent: (coding.seconds / goal) * 100,
            level: coding.seconds >= goal ? ('done' as const) : ('normal' as const),
            text: shortDuration(coding.seconds),
            tip: of(`Codando hoje: ${coding.text} · meta de ${coding.goalHours} h (WakaTime)`),
          },
        ]
      : []),
    {
      label: 'CPU',
      percent: system ? system.cpu.percent : null,
      tip: of(system ? `CPU: ${Math.round(system.cpu.percent)}% · carga ${system.cpu.load[0].toLocaleString('pt-BR')}` : 'CPU: carregando'),
    },
    {
      label: 'Mem.',
      percent: system ? (system.memory.used / system.memory.total) * 100 : null,
      tip: of(system ? `Memória: ${bytes(system.memory.used)} de ${bytes(system.memory.total)}` : 'Memória: carregando'),
    },
    // Os limites são do Claude: abrem o uso na página dele, na seção Agentes.
    { label: '5 h', percent: plan?.fiveHour?.utilization ?? null, tip: of(windowTip('Claude · 5 h', plan?.fiveHour)), open: openUsage },
    { label: 'Semana', percent: plan?.sevenDay?.utilization ?? null, tip: of(windowTip('Claude · semana', plan?.sevenDay)), open: openUsage },
  ]
}

/** Na alça (com a lista recolhida), as medidas empilhadas; tocar em uma abre o painel Computador. */
function RailMeters() {
  const metrics = useMetrics()
  return (
    // Entram suaves enquanto a lista recolhe, um pouco depois de ela começar a fechar.
    <div className="chat-enter flex flex-col items-center gap-1.5 [animation-delay:120ms]">
      {metrics.map((m) => (
        <RailMeter key={m.label} {...m} />
      ))}
    </div>
  )
}

/**
 * Com a lista aberta, as medidas saem da coluna estreita da alça para o pé dela, uma por linha, soltas
 * na ilha como as conversas (ver App.tsx). Recolhida a lista, voltam para a alça, no mesmo traço.
 */
/** `className`: no celular, no alto da lista de conversas, as medidas vão em duas colunas. */
export function SidebarMeters({ className }: { className?: string }) {
  const metrics = useMetrics()
  return (
    <TooltipProvider delayDuration={200}>
      <div className={cn('shrink-0 px-2 pt-2 pb-3', className)}>
        {metrics.map((m) => (
          <BarRow key={m.label} {...m} />
        ))}
      </div>
    </TooltipProvider>
  )
}

/** Uma conversa aberta em aba, na alça: o claudinho dela, com o estado, e o nome e o título ao passar o mouse. */
function RailChat({ id, active }: { id: string; active: boolean }) {
  const entry = useStore((s) => s.catalog.find((c) => c.sessionId === id))
  const name = claudinhoName(id, entry?.claudinhoName)
  return (
    <RailItem label={entry?.title ? `${name} · ${entry.title}` : name} href={`/s/${id}`} active={active}>
      <Claudinho seed={id} state={entry?.state} thinking={entry?.thinking} status size={20} />
    </RailItem>
  )
}

/**
 * Com a lista recolhida, as conversas abertas em abas (de todos os grupos, na ordem da tela) ficam na
 * alça, para trocar de conversa sem abrir a lista; a que está em foco ganha o destaque.
 */
function RailChats() {
  const [location] = useLocation()
  const ids = useWorkbench(useShallow((s) => s.groups.flatMap((g) => g.tabs.flatMap((t) => (t.kind === 'chat' ? [t.id] : [])))))
  const focused = useWorkbench((s) => (onWorkbench(location) ? focusedChat(s) : null))
  if (!ids.length) return null
  return (
    <>
      <div className="my-1 h-px w-6 shrink-0 bg-foreground/10" />
      <div className="chat-enter flex min-h-0 flex-col items-center gap-1 overflow-y-auto [scrollbar-width:none] [animation-delay:120ms]">
        {ids.map((id) => (
          <RailChat key={chatKey(id)} id={id} active={id === focused} />
        ))}
      </div>
    </>
  )
}

/**
 * Alça do PC, sempre à esquerda, como a barra de atividades do VS Code: o botão do topo abre e recolhe a
 * barra lateral; Sessões (com o contador das que precisam de você) e Projetos escolhem o que ela
 * mostra. Embaixo, com a lista recolhida, as medidas (com ela aberta, elas ficam no pé dela) e, por
 * último, a marca do Claude, que abre o painel Computador.
 */
export function SidebarRail() {
  const [location] = useLocation()
  const attention = useStore((s) => s.catalog.reduce((n, c) => n + (c.state === 'waiting' ? 1 : 0), 0))
  const inbox = useInboxCount()
  // A aba da inbox em foco: o ícone fica marcado, como o Início na página inicial.
  const inboxOpen = useWorkbench((w) => location === WORKBENCH_PATH && w.groups.find((g) => g.id === w.focused)?.active === 'i:')
  const collapsed = useSidebar((s) => s.collapsed)
  const view = useSidebar((s) => s.view)
  const computer = useComputer((s) => s.open)
  const toggle = () => setSidebarCollapsed(!collapsed)

  return (
    <TooltipProvider delayDuration={200}>
      {/* Na ilha da barra lateral, junto da lista de conversas (ver App.tsx). */}
      <aside className="flex w-16 shrink-0 flex-col items-center gap-1 py-3">
        <RailItem label={collapsed ? 'Abrir a barra lateral' : 'Recolher a barra lateral'} onClick={toggle}>
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </RailItem>
        <div className="my-1 h-px w-6 bg-foreground/10" />
        <RailItem label="Início" href="/" active={location === '/'}>
          <House />
        </RailItem>
        <RailItem
          label={'Sessões' + (attention ? ` · ${attention} ${attention === 1 ? 'precisa' : 'precisam'} de você` : '')}
          shown={!collapsed && view === 'sessions'}
          badge={attention}
          onClick={() => toggleSidebarView('sessions')}
        >
          <MessagesSquare />
        </RailItem>
        <RailItem
          label={'Inbox' + (inbox ? ` · ${inbox} ${inbox === 1 ? 'novo' : 'novos'}` : '')}
          active={inboxOpen}
          badge={inbox}
          badgeClassName="bg-sky-600"
          onClick={openInbox}
        >
          <Inbox />
        </RailItem>
        <RailItem label="Projetos" shown={!collapsed && view === 'projects'} onClick={() => toggleSidebarView('projects')}>
          <FolderGit2 />
        </RailItem>
        {collapsed && <RailChats />}

        <div className="mt-auto flex shrink-0 flex-col items-center gap-1.5 pt-2">
          {collapsed && <RailMeters />}
          {/* O painel Computador: o PC, os limites do Claude e os ajustes deste aparelho. Abre por cima,
              sem tirar você da conversa (ver lib/computer.ts). */}
          <RailItem label="Computador: o PC, os limites e os ajustes" onClick={() => setComputerOpen(true)} active={computer}>
            <EditrMark className="text-foreground dark:text-white" />
            <DevTag className="right-0 bottom-0.5" />
          </RailItem>
        </div>
      </aside>
    </TooltipProvider>
  )
}
