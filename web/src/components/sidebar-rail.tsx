import { FolderGit2, House, MessagesSquare, OctagonAlert, PanelLeftClose, PanelLeftOpen, TriangleAlert } from 'lucide-react'
import { Link, useLocation } from 'wouter'
import { ClaudeMark } from '@/components/chat/claude-spinner'
import { severityOf } from '@/components/pc-status'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { setComputerOpen, useComputer } from '@/lib/computer'
import { bytes, resetTime, shortDuration } from '@/lib/format'
import { HOME, useMachineFilter, useMachines } from '@/lib/machines'
import { setSidebarCollapsed, toggleSidebarView, useSidebar } from '@/lib/sidebar'
import { useStore } from '@/lib/store'
import { useWakatimeToday } from '@/lib/wakatime'
import type { UsageWindow } from '@/lib/types'
import { cn } from '@/lib/utils'

// Mesmas cores do quadro do PC (pc-status.tsx): padrão → alerta → crítico, trilho no tom mais claro.
const RING = {
  normal: { stroke: 'stroke-sky-500', track: 'stroke-sky-500/20' },
  warning: { stroke: 'stroke-[#fab219]', track: 'stroke-[#fab219]/25' },
  critical: { stroke: 'stroke-[#d03b3b]', track: 'stroke-[#d03b3b]/25' },
  // Horas de hoje: encher é bom, e bater a meta fica em verde (ver o anel do WakaTime).
  done: { stroke: 'stroke-emerald-500', track: 'stroke-emerald-500/20' },
}
const R = 15
const CIRCUMFERENCE = 2 * Math.PI * R

/**
 * Anel de progresso com a porcentagem no meio; alerta e crítico vêm com ícone, para não depender
 * só da cor. `text` troca o que vai no meio e `level` desliga a escala de severidade, para o anel
 * em que encher não é problema nenhum.
 */
function Ring({
  label,
  percent,
  tip,
  text,
  level: fixed,
}: {
  label: string
  percent: number | null
  tip: string
  text?: string
  level?: keyof typeof RING
}) {
  const known = percent !== null
  const level = fixed ?? (known ? severityOf(percent) : 'normal')
  const Icon = level === 'critical' ? OctagonAlert : level === 'warning' ? TriangleAlert : null
  const fill = known ? Math.min(100, Math.max(0, percent)) : 0
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setComputerOpen(true)}
          aria-label={tip}
          className="flex w-13 flex-col items-center gap-0.5 rounded-xl py-1 transition-colors hover:bg-foreground/5"
        >
          <span className="relative size-10">
            <svg viewBox="0 0 36 36" className="size-10 -rotate-90" aria-hidden>
              <circle cx="18" cy="18" r={R} fill="none" strokeWidth="3.5" className={known ? RING[level].track : 'stroke-muted'} />
              {known && (
                <circle
                  cx="18"
                  cy="18"
                  r={R}
                  fill="none"
                  strokeWidth="3.5"
                  strokeLinecap="round"
                  strokeDasharray={CIRCUMFERENCE}
                  strokeDashoffset={CIRCUMFERENCE * (1 - fill / 100)}
                  className={cn('transition-[stroke-dashoffset] duration-500', RING[level].stroke)}
                />
              )}
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold tabular-nums">
              {text ?? (known ? `${Math.round(percent)}%` : '—')}
            </span>
          </span>
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            {Icon && (
              <Icon className={cn('size-2.5', level === 'critical' ? 'text-[#d03b3b]' : 'text-[#c98a00] dark:text-[#fab219]')} aria-hidden />
            )}
            {label}
          </span>
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
    // O ativo tem a cor da janela, como a aba aberta: um pedaço dela na ilha.
    active && 'bg-background text-foreground shadow-xs hover:bg-background',
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

/**
 * Alça do PC, sempre à esquerda, como a barra de atividades do VS Code: o botão do topo abre e recolhe a
 * barra lateral; Sessões (com o contador das que precisam de você) e Projetos escolhem o que ela
 * mostra. Embaixo, o tempo de hoje, CPU, memória e os limites do Claude em anéis e, por último, a
 * marca do Claude, que abre o painel Computador.
 */
export function SidebarRail() {
  const [location] = useLocation()
  const attention = useStore((s) => s.catalog.reduce((n, c) => n + (c.state === 'waiting' ? 1 : 0), 0))
  const machine = useMachineFilter() ?? HOME
  const system = useStore((s) => s.systems[machine])
  const usage = useStore((s) => s.usages[machine])
  // Com várias máquinas, os anéis dizem de qual é (a do filtro das Sessões).
  const name = useMachines((s) => (s.machines.length > 1 ? s.machines.find((m) => m.id === machine)?.name : undefined))
  const of = (text: string) => (name ? `${name} · ${text}` : text)
  const collapsed = useSidebar((s) => s.collapsed)
  const view = useSidebar((s) => s.view)
  const computer = useComputer((s) => s.open)
  const toggle = () => setSidebarCollapsed(!collapsed)
  const coding = useWakatimeToday(machine)
  const plan = usage?.plan?.available ? usage.plan : null
  const memory = system ? (system.memory.used / system.memory.total) * 100 : null

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
        <RailItem label="Projetos" shown={!collapsed && view === 'projects'} onClick={() => toggleSidebarView('projects')}>
          <FolderGit2 />
        </RailItem>

        <div className="mt-auto flex flex-col items-center gap-1.5">
          {coding && (
            <Ring
              label="Hoje"
              percent={(coding.seconds / (coding.goalHours * 3600)) * 100}
              level={coding.seconds >= coding.goalHours * 3600 ? 'done' : 'normal'}
              text={shortDuration(coding.seconds)}
              tip={of(`Codando hoje: ${coding.text} · meta de ${coding.goalHours} h (WakaTime)`)}
            />
          )}
          <Ring
            label="CPU"
            percent={system ? system.cpu.percent : null}
            tip={of(system ? `CPU: ${Math.round(system.cpu.percent)}% · carga ${system.cpu.load[0].toLocaleString('pt-BR')}` : 'CPU: carregando')}
          />
          <Ring
            label="Mem."
            percent={memory}
            tip={of(system ? `Memória: ${bytes(system.memory.used)} de ${bytes(system.memory.total)}` : 'Memória: carregando')}
          />
          <Ring label="5 h" percent={plan?.fiveHour?.utilization ?? null} tip={of(windowTip('Claude · 5 h', plan?.fiveHour))} />
          <Ring label="Semana" percent={plan?.sevenDay?.utilization ?? null} tip={of(windowTip('Claude · semana', plan?.sevenDay))} />
          {/* O painel Computador: o PC, os limites do Claude e os ajustes deste aparelho. Abre por cima,
              sem tirar você da conversa (ver lib/computer.ts). */}
          <RailItem label="Computador: o PC, os limites e os ajustes" onClick={() => setComputerOpen(true)} active={computer}>
            <ClaudeMark className="text-foreground dark:text-white" />
          </RailItem>
        </div>
      </aside>
    </TooltipProvider>
  )
}
