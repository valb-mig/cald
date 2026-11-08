import { Activity, Armchair, Bell, Blocks, ChevronLeft, ChevronRight, GitBranch, Info, Lock, Monitor, MonitorSmartphone, Moon, Palette, RefreshCw, Sun, X } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'wouter'
import { AccessSettings } from '@/components/access-settings'
import { MemoryView } from '@/components/claude/memory-view'
import { McpView, SkillsView } from '@/components/claude/setup-view'
import { WorktreesView } from '@/components/claude/worktrees-view'
import { MachineFilter } from '@/components/machine-filter'
import { Meter, WindowMeter } from '@/components/pc-status'
import { ProviderMark } from '@/components/provider-mark'
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
import { setAgentTab, setComputerAgent, setComputerOpen, setComputerSection, useComputer, type AgentTab, type ComputerSection } from '@/lib/computer'
import { AUTOLOCK_MINUTES, lockNow, setAutoLock, useAutoLock, useLock } from '@/lib/lock'
import { bytes, relativeTime, uptime } from '@/lib/format'
import { HOME, baseOf, useMachineFilter } from '@/lib/machines'
import { useMemoryAlerts } from '@/lib/memory'
import { CLAUDE, setProvider, useProvider, useProviders } from '@/lib/providers'
import { reconnectNow, useStore } from '@/lib/store'
import type { AgentProviderInfo } from '@/lib/types'
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
  { key: 'agents', label: 'Agentes', description: 'Quem conduz as conversas, e o que é de cada um.', icon: Blocks, machine: true },
  { key: 'worktrees', label: 'Worktrees', description: 'Os worktrees de cada projeto, para trazer o trabalho ou apagar.', icon: GitBranch, machine: true },
  { key: 'access', label: 'Acesso', description: 'Conectar o celular e ver quem está usando.', icon: MonitorSmartphone, machine: true },
  { key: 'alerts', label: 'Avisos', description: 'Notificações e sons deste aparelho.', icon: Bell },
  { key: 'look', label: 'Aparência', description: 'Tema e fundo, só neste aparelho.', icon: Palette },
  { key: 'about', label: 'Sobre', description: 'Versão, atualização e segurança.', icon: Info, machine: true },
]

type Feature = 'usage' | 'memory' | 'skills' | 'mcp'

/**
 * As abas da página de um agente, na seção Agentes: a Geral sempre, e cada outra só quando ele oferece
 * aquilo (ver `features` em lib/providers.ts) e está pronto no PC. A de uso é o que era a seção "Uso
 * do Claude", e as outras eram as seções Memória, Skills e MCP.
 */
const AGENT_TABS: { key: AgentTab; label: string; description: string; feature?: Feature }[] = [
  { key: 'geral', label: 'Geral', description: '' },
  { key: 'usage', label: 'Uso', description: 'Os limites do seu plano.', feature: 'usage' },
  { key: 'memory', label: 'Memória', description: 'O que ele guardou sobre cada projeto.', feature: 'memory' },
  { key: 'skills', label: 'Skills', description: 'Skills, comandos e agentes que valem em todo projeto.', feature: 'skills' },
  { key: 'mcp', label: 'MCP', description: 'Os servidores que ele usa, e onde.', feature: 'mcp' },
]

/** O agente aberto na seção Agentes (`null` na lista), as abas que ele tem e a escolhida entre elas. */
function useAgentPage(machine: string) {
  const id = useComputer((s) => (s.section === 'agents' ? s.agent : null))
  const wanted = useComputer((s) => s.agentTab)
  // Sem `id`, o hook acharia o padrão: só vale com um agente aberto.
  const found = useProvider(machine, id ?? undefined)
  const agent = id ? found : undefined
  const tabs = AGENT_TABS.filter((t) => !t.feature || (agent?.available && agent.features[t.feature]))
  // Pedida uma aba que ele não tem (um link antigo, outra máquina), fica na Geral.
  const tab = tabs.find((t) => t.key === wanted) ?? AGENT_TABS[0]!
  return { id, agent, tabs, tab }
}

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
  const machine = useMachineFilter() ?? HOME
  const page = useAgentPage(machine)
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
        <DialogDescription className="sr-only">O PC, os agentes e o que é de cada um, e os ajustes deste aparelho.</DialogDescription>
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
          {/* Na página de um agente, o título é o caminho de volta à lista, e a descrição é a dele (ou a da aba). */}
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-medium">{page.id ? <AgentCrumb name={page.agent?.name ?? page.id} /> : current.label}</h2>
            <p className="text-xs text-muted-foreground">{page.id ? page.tab.description || page.agent?.description : current.description}</p>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-2 max-sm:hidden" aria-label="Fechar">
              <X />
            </Button>
          </DialogClose>
        </header>
        {current.machine && <MachineFilter all={false} className="px-6 pb-4 max-sm:px-4 max-sm:pt-4 max-sm:pb-0" />}
        {page.id && (
          // Fora da rolagem, como o filtro: as abas ficam à vista enquanto a lista de memórias ou skills desce.
          // No celular, sem o cabeçalho, o caminho de volta vem aqui; no PC, com uma aba só, nada sobra.
          <div className={cn('space-y-3 px-6 pb-4 max-sm:px-4 max-sm:pt-4 max-sm:pb-0', page.tabs.length < 2 && 'sm:hidden')}>
            <AgentCrumb name={page.agent?.name ?? page.id} className="text-sm sm:hidden" />
            {page.tabs.length > 1 && <AgentTabs tabs={page.tabs} tab={page.tab.key} machine={machine} claude={page.id === CLAUDE} />}
          </div>
        )}
        <div
          key={page.id ? `agents:${page.id}:${page.tab.key}` : section}
          className="tab-panel-in min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6 max-sm:px-4 max-sm:pt-4"
        >
          {section === 'status' ? (
            <StatusSection />
          ) : section === 'agents' ? (
            page.id ? (
              <AgentPage id={page.id} agent={page.agent} tab={page.tab.key} machine={machine} />
            ) : (
              <AgentsSection machine={machine} />
            )
          ) : section === 'worktrees' ? (
            <WorktreesView key={machine} machine={machine} onLeave={() => setComputerOpen(false)} />
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

/** Um relance na própria navegação: a conexão no Status, as memórias que pedem atenção em Agentes, os outros aparelhos no Acesso. */
function NavMeta({ section }: { section: Section }) {
  const machine = useMachineFilter() ?? HOME
  const connection = useStore((s) => s.connections[machine] ?? 'connecting')
  if (section === 'status') return <span className={cn('size-1.5 rounded-full', CONNECTION[connection].dot)} />
  if (section === 'agents') return <AgentsMeta machine={machine} />
  if (section === 'access') return <OthersConnected machine={machine} />
  return null
}

/** A memória que o app lê é a do Claude Code: o selo só conta com ele pronto e com memória. */
function AgentsMeta({ machine }: { machine: string }) {
  const { list } = useProviders(machine)
  if (!list?.some(hasMemory)) return null
  return <MemoryAlerts machine={machine} />
}

const hasMemory = (a: AgentProviderInfo) => a.id === CLAUDE && a.available && a.features.memory

/** A janela de 5 h do plano, na aba Uso, como ficava no item "Uso do Claude" da navegação. */
function FiveHour({ machine }: { machine: string }) {
  const fiveHour = useStore((s) => s.usages[machine]?.plan?.fiveHour?.utilization)
  if (fiveHour == null) return null
  return <span className="text-xs font-normal text-muted-foreground tabular-nums">{Math.round(fiveHour)}%</span>
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
 * Os agentes da máquina escolhida no topo, um por linha: a marca, o nome, um relance (a versão, se é o
 * padrão, ou o que falta no PC), a chave de ligado e, tocando, a página dele.
 */
function AgentsSection({ machine }: { machine: string }) {
  const { list, error } = useProviders(machine)
  if (!list) {
    return (
      <Group>
        <SettingRow label={error ? `Indisponível: ${error}` : 'Lendo os agentes…'} />
      </Group>
    )
  }
  const on = list.filter((p) => p.enabled)
  const only = on.length === 1 ? on[0]! : null
  return (
    <Group
      note={
        list.length === 1
          ? 'As conversas precisam de um agente ligado: com um só, ele não desliga.'
          : only
            ? `Ao menos um agente fica ligado: ligue outro para desligar o ${only.name}.`
            : 'O padrão é o agente com que as conversas novas começam; dá para escolher outro na própria conversa nova.'
      }
    >
      {list.map((a) => (
        <AgentRow key={a.id} agent={a} machine={machine} only={a === only} />
      ))}
    </Group>
  )
}

/** Por que a chave de ligado não mexe: o único ligado não desliga, e o que não está pronto não liga. */
function lockOf(a: AgentProviderInfo, only: boolean): string | null {
  if (a.enabled) return only ? 'Ao menos um agente fica ligado.' : null
  return a.available ? null : (a.problem ?? 'Não está pronto no PC.')
}

/**
 * Uma linha da lista. Tocar em qualquer lugar abre a página do agente (o botão do nome se estende por
 * cima da linha), menos na chave, que fica acima dele.
 */
function AgentRow({ agent: a, machine, only }: { agent: AgentProviderInfo; machine: string; only: boolean }) {
  const lock = lockOf(a, only)
  const hint = a.available ? [a.version, a.default && 'padrão'].filter(Boolean).join(' · ') : (a.problem ?? 'Não está pronto no PC.')
  return (
    <div className="relative flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-foreground/5">
      <ProviderMark id={a.id} className="size-4.5" />
      <button
        type="button"
        onClick={() => setComputerAgent(a.id)}
        className="min-w-0 flex-1 text-left after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring/50"
      >
        <div className="text-sm">{a.name}</div>
        {/* Indisponível é estado: o âmbar, como nas outras coisas que pedem atenção. */}
        {hint && <div className={cn('truncate text-xs text-muted-foreground', !a.available && 'text-amber-600 dark:text-amber-400')}>{hint}</div>}
      </button>
      {hasMemory(a) && <MemoryAlerts machine={machine} />}
      {/* O `title` fica no invólucro: chave desabilitada não recebe o ponteiro. */}
      <span className="relative flex" title={lock ?? undefined}>
        <Switch
          checked={a.enabled}
          disabled={lock !== null}
          onCheckedChange={(enabled) => void setProvider(machine, a.id, { enabled })}
          aria-label={a.enabled ? `Desligar o ${a.name}` : `Ligar o ${a.name}`}
        />
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </div>
  )
}

/** "‹ Agentes / Claude Code": o caminho de volta para a lista, com o nome do agente aberto. */
function AgentCrumb({ name, className }: { name: string; className?: string }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <button
        type="button"
        onClick={() => setComputerAgent(null)}
        className="-ml-1.5 flex h-7 shrink-0 items-center gap-0.5 rounded-md pr-1.5 pl-0.5 font-normal text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Agentes
      </button>
      <span className="text-muted-foreground/50" aria-hidden>
        /
      </span>
      <span className="truncate">{name}</span>
    </div>
  )
}

/** As abas em pílula da página do agente; no celular rolam de lado. Os relances (5 h, memórias) são do Claude. */
function AgentTabs({ tabs, tab, machine, claude }: { tabs: typeof AGENT_TABS; tab: AgentTab; machine: string; claude: boolean }) {
  return (
    <div role="tablist" aria-label="O que é do agente" className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={tab === t.key}
          onClick={() => setAgentTab(t.key)}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground aria-selected:bg-foreground/[0.08] aria-selected:font-medium aria-selected:text-foreground"
        >
          {t.label}
          {claude && t.key === 'usage' && <FiveHour machine={machine} />}
          {claude && t.key === 'memory' && <MemoryAlerts machine={machine} />}
        </button>
      ))}
    </div>
  )
}

/**
 * A página de um agente, na aba escolhida. Uso, Memória, Skills e MCP são as telas que já existiam
 * (do Claude Code, na máquina escolhida no topo); só mudaram de lugar.
 */
function AgentPage({ id, agent, tab, machine }: { id: string; agent: AgentProviderInfo | undefined; tab: AgentTab; machine: string }) {
  const { list, error } = useProviders(machine)
  const leave = () => setComputerOpen(false)
  if (!agent) {
    return (
      <Group>
        <SettingRow label={!list ? (error ? `Indisponível: ${error}` : 'Lendo os agentes…') : `A máquina não tem o agente ${id}.`}>
          {list && (
            <Button variant="ghost" size="sm" onClick={() => setComputerAgent(null)}>
              Ver os agentes
            </Button>
          )}
        </SettingRow>
      </Group>
    )
  }
  // Essas telas leem o que é do Claude Code (o `usage` do WebSocket, /api/memory, /api/claude/setup): para
  // outro agente que diga ter o recurso, o servidor ainda não tem de onde dar o dele.
  if (tab !== 'geral' && agent.id !== CLAUDE) {
    return (
      <Group>
        <SettingRow label={`O app ainda não mostra esta parte do ${agent.name}.`} />
      </Group>
    )
  }
  if (tab === 'usage') return <UsageSection />
  if (tab === 'memory') return <MemoryView key={machine} machine={machine} onLeave={leave} />
  if (tab === 'skills') return <SkillsView key={machine} machine={machine} />
  if (tab === 'mcp') return <McpView key={machine} machine={machine} />
  return <AgentGeneral agent={agent} list={list} machine={machine} />
}

/** A aba Geral: ligar, fazer padrão, e como ele está no PC. */
function AgentGeneral({ agent: a, list, machine }: { agent: AgentProviderInfo; list: AgentProviderInfo[] | undefined; machine: string }) {
  const only = a.enabled && (list ?? [a]).filter((p) => p.enabled).length <= 1
  const lock = lockOf(a, only)
  return (
    <>
      {/* No celular o cabeçalho sai, e com ele a descrição: ela vem aqui (o `mb` toma o lugar do espaço da seção). */}
      <p className="mb-3 px-1 text-xs text-muted-foreground sm:hidden">{a.description}</p>
      <Group>
        <SettingRow
          label="Ligado"
          hint={lock ?? (a.enabled ? 'A conversa nova oferece ele.' : 'Desligado: a conversa nova não oferece ele.')}
          htmlFor="agent-enabled"
        >
          <Switch id="agent-enabled" checked={a.enabled} disabled={lock !== null} onCheckedChange={(enabled) => void setProvider(machine, a.id, { enabled })} />
        </SettingRow>
        <SettingRow
          label="Padrão nas conversas novas"
          hint={
            a.default
              ? 'As conversas novas começam com ele. Para trocar, faça outro o padrão.'
              : !a.enabled
                ? 'Ligue antes de fazer dele o padrão.'
                : 'As conversas novas começam com o padrão, e dá para escolher outro nelas.'
          }
          htmlFor="agent-default"
        >
          {/* Só um é o padrão, sempre um dos ligados: desmarcar não existe, escolhe-se outro. */}
          <Switch
            id="agent-default"
            checked={a.default}
            disabled={a.default || !a.enabled || !a.available}
            onCheckedChange={() => void setProvider(machine, a.id, { default: true })}
          />
        </SettingRow>
      </Group>
      <Group title="No PC">
        <SettingRow
          label={
            <span className="flex items-center gap-2">
              <span className={cn('size-2 rounded-full', a.available ? 'bg-emerald-500' : 'bg-amber-500')} />
              {a.available ? 'Pronto' : 'Indisponível'}
            </span>
          }
          hint={a.available ? 'Instalado e pronto para conversar.' : (a.problem ?? 'Não está pronto no PC.')}
        />
        {a.version && (
          <SettingRow label="Versão">
            <span className="font-mono text-xs text-muted-foreground">{a.version}</span>
          </SettingRow>
        )}
      </Group>
    </>
  )
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
