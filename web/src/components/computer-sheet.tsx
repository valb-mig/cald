import { Activity, Armchair, Bell, Brain, ChevronRight, Gauge, GitBranch, Info, Lock, Monitor, MonitorSmartphone, Moon, Palette, Plug, RefreshCw, Sparkles, Sun, X } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'wouter'
import { AccessSettings } from '@/components/access-settings'
import { MemoryView } from '@/components/claude/memory-view'
import { McpView, SkillsView } from '@/components/claude/setup-view'
import { WorktreesView } from '@/components/claude/worktrees-view'
import { MachineFilter } from '@/components/machine-filter'
import { Meter, WindowMeter } from '@/components/pc-status'
import { PushSettings } from '@/components/push-settings'
import { Group, Segmented, SettingRow } from '@/components/settings-ui'
import { SoundSettings } from '@/components/sound-settings'
import { WallpaperSettings } from '@/components/wallpaper-settings'
import { UpdateCard } from '@/components/update-card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useOthersConnected } from '@/lib/access'
import { api } from '@/lib/api'
import { setComputerOpen, setComputerSection, useComputer, type ComputerSection } from '@/lib/computer'
import { AUTOLOCK_MINUTES, lockNow, setAutoLock, useAutoLock, useLock } from '@/lib/lock'
import { bytes, relativeTime, uptime } from '@/lib/format'
import { HOME, baseOf, useMachineFilter } from '@/lib/machines'
import { useMemoryAlerts } from '@/lib/memory'
import { reconnectNow, useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

const CONNECTION = {
  open: { label: 'Conectado', dot: 'bg-emerald-500' },
  connecting: { label: 'Conectando…', dot: 'bg-amber-500 animate-pulse' },
  closed: { label: 'Desconectado', dot: 'bg-red-500' },
} as const

type Section = ComputerSection

/** `machine`: a seção é de uma máquina, e o filtro delas aparece no topo (com mais de uma). */
const SECTIONS: { key: Section; label: string; description: string; icon: typeof Activity; machine?: boolean }[] = [
  { key: 'status', label: 'Status', description: 'O PC que roda as conversas.', icon: Activity, machine: true },
  { key: 'usage', label: 'Uso do Claude', description: 'Os limites do seu plano.', icon: Gauge, machine: true },
  { key: 'memory', label: 'Memória', description: 'O que o Claude guardou sobre cada projeto.', icon: Brain, machine: true },
  { key: 'skills', label: 'Skills', description: 'Skills, comandos e agentes que valem em todo projeto.', icon: Sparkles, machine: true },
  { key: 'mcp', label: 'MCP', description: 'Os servidores que o Claude usa, e onde.', icon: Plug, machine: true },
  { key: 'worktrees', label: 'Worktrees', description: 'Os worktrees de cada projeto, para trazer o trabalho ou apagar.', icon: GitBranch, machine: true },
  { key: 'access', label: 'Acesso', description: 'Conectar o celular e ver quem está usando.', icon: MonitorSmartphone, machine: true },
  { key: 'alerts', label: 'Avisos', description: 'Notificações e sons deste aparelho.', icon: Bell },
  { key: 'look', label: 'Aparência', description: 'Tema e fundo, só neste aparelho.', icon: Palette },
  { key: 'about', label: 'Sobre', description: 'Versão, atualização e segurança.', icon: Info, machine: true },
]

/**
 * O painel Computador, por cima da tela em que você está (ver lib/computer.ts). Abre da alça, dos
 * anéis, do quadro do PC no início e da aba no celular. Desenhado como o próprio app: uma ilha na cor
 * da casca, com as seções à esquerda (como a barra lateral) e a escolhida numa janela à direita, um
 * assunto por vez. No celular, as seções viram uma fileira de pílulas em cima da janela.
 */
export function ComputerSheet() {
  const open = useComputer((s) => s.open)
  return (
    <Dialog open={open} onOpenChange={setComputerOpen}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(38rem,calc(100dvh-2rem))] w-[min(52rem,calc(100vw-1.5rem))] max-w-none flex-col gap-0 overflow-hidden rounded-island bg-shell p-0 shadow-island ring-0 max-sm:h-[calc(100dvh-6rem)] sm:max-w-none sm:flex-row"
      >
        <Computer />
      </DialogContent>
    </Dialog>
  )
}

function Computer() {
  // A seção fica no store: quem abre o painel pode pedir uma (o aviso de aparelho novo abre no Acesso).
  const section = useComputer((s) => s.section)
  const current = SECTIONS.find((s) => s.key === section)!
  const nav = useRef<HTMLElement>(null)
  // No celular, as pílulas rolam de lado: a escolhida de fora (pelo aviso, por um atalho) entra na vista.
  useEffect(() => {
    nav.current?.querySelector('[aria-current=page]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [section])
  return (
    <>
      <nav ref={nav} className="flex shrink-0 flex-col gap-1 p-3 max-sm:pb-2 sm:w-52">
        <div className="flex items-center justify-between px-2 pt-1 pb-2 sm:pb-3">
          <DialogTitle className="text-sm">Computador</DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="sm:hidden" aria-label="Fechar">
              <X />
            </Button>
          </DialogClose>
        </div>
        <DialogDescription className="sr-only">O PC, os limites do Claude, o que ele carrega e os ajustes deste aparelho.</DialogDescription>
        <div className="flex gap-1 max-sm:overflow-x-auto max-sm:[scrollbar-width:none] sm:flex-col">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-current={section === s.key ? 'page' : undefined}
              onClick={() => setComputerSection(s.key)}
              className="flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-foreground aria-[current=page]:shadow-xs [&_svg]:size-4 [&_svg]:shrink-0"
            >
              <s.icon />
              <span className="flex-1 text-left">{s.label}</span>
              <NavMeta section={s.key} />
            </button>
          ))}
        </div>
      </nav>

      {/* A janela, como a da conversa: um tom acima da casca no claro, e mais clara que ela no escuro. */}
      <div className="m-gap flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-pane bg-background max-sm:mt-0 sm:ml-0">
        {/* No celular, a pílula escolhida já diz a seção: o cabeçalho sai para sobrar espaço. */}
        <header className="flex items-start gap-3 px-6 pt-5 pb-4 max-sm:hidden">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-medium">{current.label}</h2>
            <p className="text-xs text-muted-foreground">{current.description}</p>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-2 max-sm:hidden" aria-label="Fechar">
              <X />
            </Button>
          </DialogClose>
        </header>
        {current.machine && <MachineFilter all={false} className="px-6 pb-4 max-sm:px-4 max-sm:pt-4 max-sm:pb-0" />}
        <div key={section} className="tab-panel-in min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6 max-sm:px-4 max-sm:pt-4">
          {section === 'status' ? (
            <StatusSection />
          ) : section === 'usage' ? (
            <UsageSection />
          ) : section === 'memory' || section === 'skills' || section === 'mcp' || section === 'worktrees' ? (
            <ClaudeSection section={section} />
          ) : section === 'access' ? (
            <AccessSection />
          ) : section === 'alerts' ? (
            <>
              <PushSettings />
              <SoundSettings />
            </>
          ) : section === 'look' ? (
            <LookSection />
          ) : (
            <AboutSection />
          )}
        </div>
      </div>
    </>
  )
}

/** Um relance na própria navegação: a conexão no Status, a janela de 5 h no Uso, os outros aparelhos no Acesso. */
function NavMeta({ section }: { section: Section }) {
  const machine = useMachineFilter() ?? HOME
  const connection = useStore((s) => s.connections[machine] ?? 'connecting')
  const fiveHour = useStore((s) => s.usages[machine]?.plan?.fiveHour?.utilization)
  if (section === 'status') return <span className={cn('size-1.5 rounded-full', CONNECTION[connection].dot)} />
  if (section === 'usage' && fiveHour != null) return <span className="text-xs text-muted-foreground tabular-nums max-sm:hidden">{Math.round(fiveHour)}%</span>
  if (section === 'memory') return <MemoryAlerts machine={machine} />
  if (section === 'access') return <OthersConnected machine={machine} />
  return null
}

/** Quantos outros aparelhos estão com o app aberto agora; nada quando é só este. */
function OthersConnected({ machine }: { machine: string }) {
  const n = useOthersConnected(machine)
  if (!n) return null
  return (
    <span className="text-xs text-muted-foreground tabular-nums" title={n === 1 ? 'Outro aparelho conectado' : `${n} outros aparelhos conectados`}>
      {n}
    </span>
  )
}

/** Memórias que o Claude não chega a ver (fora do índice, link quebrado), em todos os projetos. */
function MemoryAlerts({ machine }: { machine: string }) {
  const n = useMemoryAlerts(machine)
  if (!n) return null
  return (
    <span className="min-w-4 rounded-full bg-amber-500 px-1 text-center text-[10px] leading-4 font-semibold text-white tabular-nums" title={`${n} ${n === 1 ? 'memória pede' : 'memórias pedem'} atenção`}>
      {n > 99 ? '99+' : n}
    </span>
  )
}

function StatusSection() {
  // Com várias máquinas, o status é o da escolhida no topo (sem "Todas").
  const machine = useMachineFilter() ?? HOME
  const connection = useStore((s) => s.connections[machine] ?? 'connecting')
  const all = useStore((s) => s.catalog)
  const system = useStore((s) => s.systems[machine])
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null)

  useEffect(() => {
    api.health(machine).then(setHealth, () => setHealth(null))
  }, [machine, connection])

  const counts = useMemo(() => {
    const catalog = all.filter((c) => (c.machine ?? HOME) === machine)
    const pc = catalog.filter((c) => c.owner === 'pc')
    return {
      pc: pc.length,
      busy: catalog.filter((c) => c.state === 'running').length,
      waiting: catalog.filter((c) => c.state === 'waiting').length,
      saved: catalog.length,
    }
  }, [all, machine])

  const c = CONNECTION[connection]
  return (
    <>
      <Group>
        <SettingRow
          label={
            <span className="flex items-center gap-2">
              <span className={cn('size-2 rounded-full', c.dot)} />
              {c.label}
            </span>
          }
          hint={
            <>
              <span className="font-mono">{health?.tailnetHost ?? (baseOf(machine) || location.host)}</span>
              {health && ` · servidor iniciado ${relativeTime(health.startedAt)}`}
            </>
          }
        >
          <Button variant="ghost" size="sm" onClick={() => reconnectNow(true)}>
            <RefreshCw /> Reconectar
          </Button>
        </SettingRow>
      </Group>

      <Group
        title="Sistema"
        className="grid grid-cols-2 gap-x-6 gap-y-4 p-4 max-sm:grid-cols-1"
        note={system && `Ligado há ${uptime(system.uptimeSec)} · Claude Code: ${system.claude.processes} processos, ${bytes(system.claude.rss)}`}
      >
        {system ? (
          <>
            <Meter
              label={`CPU · ${system.cpu.cores} núcleos`}
              value={`${Math.round(system.cpu.percent)}%`}
              percent={system.cpu.percent}
              detail={`carga ${system.cpu.load.map((l) => l.toLocaleString('pt-BR')).join(' · ')}`}
            />
            <Meter
              label="Memória"
              value={`${bytes(system.memory.used)} de ${bytes(system.memory.total)}`}
              percent={(system.memory.used / system.memory.total) * 100}
            />
            {system.memory.swapTotal > 0 && (
              <Meter
                label="Swap"
                value={`${bytes(system.memory.swapUsed)} de ${bytes(system.memory.swapTotal)}`}
                percent={(system.memory.swapUsed / system.memory.swapTotal) * 100}
              />
            )}
          </>
        ) : (
          <p className="col-span-2 text-sm text-muted-foreground">Lendo o PC…</p>
        )}
      </Group>

      <Group title="Conversas" className="grid grid-cols-4 gap-1 p-1 max-sm:grid-cols-2">
        <Stat value={counts.busy} label="trabalhando" />
        <Stat value={counts.waiting} label="esperando você" />
        <Stat value={counts.pc} label="abertas no PC" />
        <Stat value={counts.saved} label="salvas" />
      </Group>

      {/* Link próprio, para deixar de fundo num tablet ou monitor (ver pages/office.tsx). */}
      <Group>
        <Link
          href="/salinha"
          // A salinha toma a tela toda: o painel fecha, para não estar aberto por cima ao voltar dela.
          onClick={() => setComputerOpen(false)}
          className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-foreground/5"
        >
          <Armchair className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm">Salinha</div>
            <div className="text-xs text-muted-foreground">Seus claudinhos num mini escritório, para deixar de fundo.</div>
          </div>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      </Group>
    </>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg px-3 py-2.5">
      <div className="text-lg leading-tight font-medium tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function UsageSection() {
  const machine = useMachineFilter() ?? HOME
  const usage = useStore((s) => s.usages[machine])
  const plan = usage?.plan
  const name = plan?.subscription ? `Plano ${plan.subscription.charAt(0).toUpperCase()}${plan.subscription.slice(1)}` : 'Limites do plano'
  return (
    <Group
      title={name}
      className={cn(plan?.available && 'grid grid-cols-2 gap-x-6 gap-y-4 p-4 max-sm:grid-cols-1')}
      note={`${usage?.planAt ? `Atualizado ${relativeTime(usage.planAt)}. ` : ''}Mesmo dado do /usage do Claude Code, a cada 90 s.`}
    >
      {plan?.available ? (
        <>
          <WindowMeter label="Sessão (5 h)" window={plan.fiveHour} />
          <WindowMeter label="Semana" window={plan.sevenDay} />
          {plan.models.map((m) => (
            <WindowMeter key={m.name} label={`Semana · ${m.name}`} window={m} />
          ))}
          {plan.extraUsage && <WindowMeter label="Uso extra (mês)" window={{ utilization: plan.extraUsage.utilization, resetsAt: null }} />}
        </>
      ) : (
        <SettingRow
          label={
            plan && !plan.available
              ? 'Esta conta não tem limites de plano (chave de API).'
              : usage?.planError
                ? `Indisponível: ${usage.planError}`
                : 'Consultando…'
          }
        />
      )}
    </Group>
  )
}

/**
 * O que o Claude Code carrega na máquina escolhida no topo (a memória de todos os projetos e o que vale
 * em todos) e os worktrees de cada projeto dela.
 */
function ClaudeSection({ section }: { section: 'memory' | 'skills' | 'mcp' | 'worktrees' }) {
  const machine = useMachineFilter() ?? HOME
  const leave = () => setComputerOpen(false)
  if (section === 'memory') return <MemoryView key={machine} machine={machine} onLeave={leave} />
  if (section === 'skills') return <SkillsView key={machine} machine={machine} />
  if (section === 'worktrees') return <WorktreesView key={machine} machine={machine} onLeave={leave} />
  return <McpView key={machine} machine={machine} />
}

function AccessSection() {
  const machine = useMachineFilter() ?? HOME
  return <AccessSettings key={machine} machine={machine} />
}

function LookSection() {
  const { theme, setTheme } = useTheme()
  return (
    <>
      <Group title="Tema" className="bg-transparent p-0">
        <Segmented
          value={(theme ?? 'system') as 'system' | 'light' | 'dark'}
          onChange={setTheme}
          options={[
            { key: 'system', label: 'Sistema', icon: <Monitor /> },
            { key: 'light', label: 'Claro', icon: <Sun /> },
            { key: 'dark', label: 'Escuro', icon: <Moon /> },
          ]}
        />
      </Group>
      <WallpaperSettings />
    </>
  )
}

function AboutSection() {
  const machine = useMachineFilter() ?? HOME
  return (
    <>
      {/* Uma por máquina: trocar de máquina recomeça a consulta. */}
      <UpdateCard key={machine} machine={machine} />
      <Group title="Segurança" note={`Versão ${__BUILD_TIME__}`}>
        <SettingRow label="Só pela sua rede Tailscale" hint="E apenas para a conta dona do PC." />
        <PinSettings />
        <SettingRow label="Credenciais no PC" hint="As do Claude Code não saem de lá." />
      </Group>
    </>
  )
}

/** O PIN (ver lib/lock.ts): definido no PC, com `cald -pin`; aqui, quando o app trava sozinho. Vale para este aparelho. */
function PinSettings() {
  const enabled = useLock((s) => s.enabled)
  const { on, minutes } = useAutoLock()
  if (!enabled) return <SettingRow label="PIN desligado" hint={<>Para pedir um PIN ao abrir, rode <code>cald -pin</code> no PC.</>} />
  return (
    <>
      <SettingRow label="PIN ao abrir" hint={<>Troque com <code>cald -pin</code> no PC.</>}>
        <Button variant="ghost" size="sm" onClick={lockNow}>
          <Lock />
          Travar agora
        </Button>
      </SettingRow>
      <SettingRow label="Travar sozinho" hint="Sem uso ou com o app no fundo, neste aparelho." htmlFor="autolock">
        <Switch id="autolock" checked={on} onCheckedChange={(checked) => setAutoLock({ on: checked })} />
      </SettingRow>
      {on && (
        <div className="px-1 pb-1">
          <Segmented
            value={String(minutes)}
            onChange={(v) => setAutoLock({ minutes: Number(v) })}
            options={AUTOLOCK_MINUTES.map((m) => ({ key: String(m), label: m === 0 ? 'Ao sair' : `${m} min` }))}
          />
        </div>
      )}
    </>
  )
}
