import { ChevronRight, CircleDot, Ellipsis, FolderGit2, GitBranch, GitPullRequest, Layers, LayoutGrid, ListTodo, Loader2, PinOff, Plus, Server } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { Composer } from '@/components/chat/composer'
import { WorktreesView } from '@/components/claude/worktrees-view'
import { Claudinho } from '@/components/claudinho'
import { GitBadges } from '@/components/git-badges'
import { BAR, plural, usd } from '@/components/home/scale'
import { PeerFaces } from '@/components/peer-faces'
import { ProjectMark } from '@/components/project-mark'
import { Segmented } from '@/components/settings-ui'
import { StateBadge } from '@/components/state-badge'
import { TeamFaces } from '@/components/teams/team-faces'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Veil } from '@/components/wallpaper/veil'
import { NewWorkspaceDialog } from '@/components/workspaces/new-workspace-dialog'
import { WorkspaceDot, WorkspacePill } from '@/components/workspaces/workspace-pill'
import { useWorktreeChoice, type WorktreeChoice } from '@/lib/worktree'
import { dayKey, noon, useToday } from '@/lib/activity'
import { api, OUTDATED_SERVER } from '@/lib/api'
import { useOnChanged } from '@/lib/changes'
import { claudinhoName } from '@/lib/claudinho'
import { insertInto } from '@/lib/compose'
import { projectName, relativeTime, shortPath } from '@/lib/format'
import { GITHUB_REASON, useGithub } from '@/lib/github'
import { useGitStatus } from '@/lib/hooks'
import { HOME, noteSession, useMachines } from '@/lib/machines'
import { isWorking } from '@/lib/peers'
import { setPanelShown, setPanelTab } from '@/lib/project-panel'
import { useStore } from '@/lib/store'
import { saveTodos, useTodos } from '@/lib/todos'
import type { Activity, CatalogEntry, GitStatus, RunOptions, Team, Workspace } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useGlass, useScrim } from '@/lib/wallpaper'
import { keyOf, openPanelTab, pinTab } from '@/lib/workbench'
import {
  createProjectWorkspace,
  defaultWorkspace,
  loadWorkspaces,
  projectWorkspaces,
  setProjectWorkspace,
  useNewChatWorkspace,
  useOpenWorkspace,
  useWorkspaces,
  workspaceFailed,
} from '@/lib/workspaces'
import { MiniChat } from './mini-chat'

const SPAN = 30
/** Quantos claudinhos das conversas fechadas aparecem antes do "ver todos". */
const TEAM = 8
/** Uma vaga da mesa: alta o bastante para ler a conversa, sem passar da tela. */
const CELL = 'h-[min(36rem,calc(100dvh-12rem))] min-h-80'

/** Trabalhando e esperando você primeiro; depois, do mais recente ao mais antigo. */
const liveFirst = (a: CatalogEntry, b: CatalogEntry) => {
  const rank = (c: CatalogEntry) => (c.state === 'waiting' ? 0 : c.state === 'running' ? 1 : 2)
  return rank(a) - rank(b) || b.lastModified - a.lastModified
}

/** O fundo de um bloco do hub: com a cena atrás, o vidro da barra do chat; sem ela, um tom acima. */
function useSurface(): string {
  return useGlass() ? 'bg-background/70 backdrop-blur-md' : 'bg-foreground/[0.04]'
}

/**
 * A ordem da mesa: cada conversa fica no lugar enquanto está aberta, sem pular quando muda de estado; a
 * que abre agora entra na frente, logo depois da caixa da nova. A que trocou de id (um /clear) fica onde estava.
 */
function useDeskOrder(ids: string[]): string[] {
  const rekeys = useStore((s) => s.rekeys)
  const [order, setOrder] = useState<string[]>([])
  const live = new Set(ids)
  const kept = order.map((id) => rekeys[id] ?? id).filter((id) => live.has(id))
  const seen = new Set(kept)
  const next = [...new Set([...ids.filter((id) => !seen.has(id)), ...kept])]
  // Guardada já no render (o jeito do React de ajustar estado ao que mudou), para a próxima comparar com ela.
  if (next.join() !== order.join()) setOrder(next)
  return next
}

/** O uso do projeto (só com o hub à vista). `outdated`: o servidor do PC ainda ignora o filtro de projeto. */
function useProjectActivity(machine: string, cwd: string, active: boolean) {
  const [data, setData] = useState<Activity | null>(null)
  useEffect(() => {
    if (!active) return
    let alive = true
    api.activity(machine, cwd).then(
      (a) => alive && setData(a),
      () => alive && setData(null),
    )
    return () => {
      alive = false
    }
  }, [machine, cwd, active])
  return { activity: data, outdated: Boolean(data?.projects.some((p) => p.cwd !== cwd)) }
}

function Card({ title, icon: Icon, action, children }: { title: React.ReactNode; icon: typeof FolderGit2; action?: React.ReactNode; children: React.ReactNode }) {
  const surface = useSurface()
  return (
    <section className={cn('flex min-w-0 flex-col rounded-xl p-4', surface)}>
      <header className="mb-2 flex items-center gap-1.5">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  )
}

const quiet = 'py-2 text-xs text-muted-foreground'
const ROW = 'flex min-w-0 items-start gap-2 rounded-lg px-1.5 py-1 text-left text-[13px] transition-colors hover:bg-foreground/[0.04]'

/** PRs e issues do projeto: os três mais mexidos de cada, que abrem como aba. */
function GithubCards({ machine, cwd, active }: { machine: string; cwd: string; active: boolean }) {
  const { info, error } = useGithub(machine, cwd, active)
  const note = error ?? (info && !info.ok ? (info.message ?? GITHUB_REASON[info.reason]) : null)
  const open = (item: 'issue' | 'pr', number: number, title: string) => openPanelTab({ kind: 'github', machine, cwd, item, number, title }, { preview: true })
  const body = (kind: 'pr' | 'issue') => {
    if (note) return <p className={quiet}>{note}</p>
    if (!info?.ok) return <Loader2 className="my-2 size-4 animate-spin text-muted-foreground" />
    const items = kind === 'pr' ? info.pulls : info.issues
    if (!items.length) return <p className={quiet}>{kind === 'pr' ? 'Nenhum PR aberto.' : 'Nenhuma issue aberta.'}</p>
    return (
      <div className="space-y-0.5">
        {items.slice(0, 3).map((g) => (
          <button key={g.number} type="button" onClick={() => open(kind, g.number, g.title)} className={cn(ROW, 'w-full')}>
            <span className="shrink-0 text-muted-foreground tabular-nums">#{g.number}</span>
            <span className="line-clamp-2 min-w-0">{g.title}</span>
          </button>
        ))}
      </div>
    )
  }
  const count = (n: number | undefined) => (info?.ok && n ? ` · ${n}` : '')
  return (
    <>
      <Card title={`PRs abertos${count(info?.ok ? info.pullCount : 0)}`} icon={GitPullRequest}>
        {body('pr')}
      </Card>
      <Card title={`Issues abertas${count(info?.ok ? info.issueCount : 0)}`} icon={CircleDot}>
        {body('issue')}
      </Card>
    </>
  )
}

/** O TODO do projeto: os três primeiros que faltam, marcáveis daqui; o resto, na barra da direita. */
function TodoCard({ machine, cwd }: { machine: string; cwd: string }) {
  const items = useTodos(machine, cwd)
  const pending = items?.filter((t) => !t.done) ?? []
  const openBar = () => {
    setPanelTab('todo')
    setPanelShown(true)
  }
  return (
    <Card
      title={`TODO${pending.length ? ` · ${pending.length}` : ''}`}
      icon={ListTodo}
      action={
        <button type="button" onClick={openBar} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
          Abrir
        </button>
      }
    >
      {!items ? (
        <Loader2 className="my-2 size-4 animate-spin text-muted-foreground" />
      ) : !pending.length ? (
        <p className={quiet}>Nada por fazer.</p>
      ) : (
        <div className="space-y-0.5">
          {pending.slice(0, 3).map((t) => (
            <label key={t.id} className={cn(ROW, 'cursor-pointer items-center')}>
              <Checkbox checked={false} onCheckedChange={() => saveTodos(machine, cwd, items.map((x) => (x.id === t.id ? { ...x, done: true } : x)))} />
              <span className="line-clamp-2 min-w-0">{t.title}</span>
            </label>
          ))}
        </div>
      )}
    </Card>
  )
}

/** O que o workspace leva, numa linha: o time, as regras, os comandos e os arquivos. */
function workspaceSummary(ws: Workspace, team?: Team): string {
  const parts = [
    team?.name,
    ws.rules.length ? plural(ws.rules.length, 'regra', 'regras') : '',
    ws.commands.length ? plural(ws.commands.length, 'comando', 'comandos') : '',
    ws.files.length ? plural(ws.files.length, 'arquivo', 'arquivos') : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : ws.instructions ? 'Só o contexto' : 'Vazio por enquanto'
}

/**
 * O workspace do projeto: o padrão (com que a conversa nova daqui já vem), que abre a página dele, e os
 * outros que têm o projeto, cada um a um toque de virar o padrão. Sem nenhum, o botão de criar o dele.
 */
function WorkspaceCard({ machine, cwd }: { machine: string; cwd: string }) {
  const list = useWorkspaces((s) => s.byMachine[machine])
  useEffect(() => {
    if (!list) loadWorkspaces(machine).catch(() => {})
  }, [list, machine])
  const open = useOpenWorkspace(machine)
  const [naming, setNaming] = useState(false)
  const [busy, setBusy] = useState(false)
  const main = defaultWorkspace(list, cwd)
  const others = projectWorkspaces(list, cwd).filter((w) => w !== main)
  // O time padrão do workspace, para os claudinhos e o nome dele.
  const [teams, setTeams] = useState<Team[]>([])
  const teamId = main?.teamId
  const loadTeams = () => {
    if (teamId) api.teams(machine).then(setTeams, () => {})
  }
  useEffect(loadTeams, [machine, teamId])
  useOnChanged(machine, 'teams', loadTeams)
  const team = teamId ? teams.find((t) => t.id === teamId) : undefined

  const create = async () => {
    setBusy(true)
    try {
      open((await createProjectWorkspace(machine, cwd)).id)
    } catch (err) {
      workspaceFailed(err)
    } finally {
      setBusy(false)
    }
  }
  const pin = (id: string | null) => void setProjectWorkspace(machine, cwd, id).catch(workspaceFailed)

  return (
    <Card
      title="Workspace"
      icon={Layers}
      action={
        (main || others.length > 0) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="-my-1 text-muted-foreground" aria-label="Mais ações" title="Mais ações">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto">
              <DropdownMenuItem onSelect={() => setNaming(true)}>
                <Plus /> Novo workspace
              </DropdownMenuItem>
              {main && (
                <DropdownMenuItem onSelect={() => pin(null)}>
                  <PinOff /> Deixar sem padrão
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      }
    >
      {!list ? (
        <Loader2 className="my-2 size-4 animate-spin text-muted-foreground" />
      ) : main ? (
        <button type="button" onClick={() => open(main.id)} className={cn(ROW, 'w-full items-center')}>
          <WorkspaceDot color={main.color} className="size-3" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{main.name}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {team && <TeamFaces team={team} size={14} max={3} />}
              <span className="truncate">{workspaceSummary(main, team)}</span>
            </span>
          </span>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      ) : others.length ? (
        <p className={quiet}>Sem padrão: a conversa nova vem sem workspace.</p>
      ) : (
        <div className="flex flex-col items-start gap-2 py-1">
          <p className="text-xs text-muted-foreground">Contexto, regras, comandos e um time para toda conversa daqui.</p>
          {/* No hub do projeto, "do projeto" já está dito; o card é estreito na grade de quatro. */}
          <Button variant="outline" size="sm" className="max-w-full" onClick={() => void create()} disabled={busy} title="Criar workspace do projeto">
            {busy ? <Loader2 className="animate-spin" /> : <Plus />} Criar workspace
          </Button>
        </div>
      )}
      {others.length > 0 && (
        <div className="mt-2 space-y-0.5">
          <h3 className="px-1.5 text-xs text-muted-foreground">{main ? 'Outros' : 'Com o projeto'}</h3>
          {others.map((w) => (
            <div key={w.id} className={cn(ROW, 'items-center')}>
              <button type="button" onClick={() => open(w.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <WorkspaceDot color={w.color} />
                <span className="truncate">{w.name}</span>
              </button>
              <button type="button" onClick={() => pin(w.id)} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
                Tornar padrão
              </button>
            </div>
          ))}
        </div>
      )}
      <NewWorkspaceDialog machine={machine} project={cwd} open={naming} onOpenChange={setNaming} onCreated={(ws) => open(ws.id)} />
    </Card>
  )
}

/** Mensagens suas por dia nos últimos 30 dias, com os totais do projeto. */
function UsageCard({ activity, outdated }: { activity: Activity | null; outdated: boolean }) {
  const today = useToday()
  const surface = useSurface()
  const days = useMemo(() => {
    if (!activity) return null
    const byDate = new Map(activity.days.map((d) => [d.date, d]))
    const day = noon(today)
    day.setDate(day.getDate() - (SPAN - 1))
    return Array.from({ length: SPAN }, () => {
      const key = dayKey(day)
      day.setDate(day.getDate() + 1)
      return { date: key, prompts: byDate.get(key)?.prompts ?? 0, cost: byDate.get(key)?.costUsd ?? 0 }
    })
  }, [activity, today])
  const max = Math.max(1, ...(days ?? []).map((d) => d.prompts))
  const total = activity?.projects[0]
  return (
    <section className={cn('rounded-xl p-4', surface)}>
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">Últimos 30 dias</h2>
        {total && !outdated && (
          <p className="text-xs text-muted-foreground">
            {plural(total.prompts, 'mensagem sua', 'mensagens suas')} · {plural(total.sessions, 'conversa', 'conversas')} · {usd(total.costUsd)} a preço de API
          </p>
        )}
      </header>
      {outdated ? (
        <p className={quiet}>{OUTDATED_SERVER}</p>
      ) : !days ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : (
        <div className="flex h-20 items-end gap-[3px]" aria-label="Mensagens suas por dia">
          {days.map((d) => (
            <span
              key={d.date}
              title={`${d.date}: ${plural(d.prompts, 'mensagem', 'mensagens')}`}
              className={cn('min-w-0 flex-1 rounded-t-[3px]', d.prompts ? BAR : 'bg-muted')}
              style={{ height: d.prompts ? `${Math.max(6, (d.prompts / max) * 100)}%` : 3 }}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/** Um claudinho de uma conversa fechada: tocar abre a conversa dele. */
function Member({ s }: { s: CatalogEntry }) {
  const name = claudinhoName(s.sessionId, s.claudinhoName)
  const surface = useSurface()
  return (
    <Link
      href={`/s/${s.sessionId}`}
      className={cn('flex min-w-0 items-center gap-2.5 rounded-xl p-2.5 ring-foreground/10 transition-shadow hover:ring-1', surface)}
    >
      <Claudinho seed={s.sessionId} name={name} state={s.state} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{name}</span>
          {s.state === 'running' || s.state === 'waiting' ? (
            <StateBadge state={s.state} waitingFor={s.waitingFor} className="h-4 shrink-0 px-1 text-[10px]" />
          ) : (
            <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(s.lastModified)}</span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">{s.title}</div>
      </div>
    </Link>
  )
}

/**
 * A chave do worktree da conversa nova, numa linha: se ela vai para uma cópia só dela e quem já trabalha
 * no projeto (os claudinhos e a conta), sem explicação; o detalhe fica no `title`.
 */
function WorktreeLine({ choice, working, creating }: { choice: WorktreeChoice; working: CatalogEntry[]; creating: boolean }) {
  if (!choice.available) return null
  const { on, others, base } = choice
  return (
    <label
      title={
        on
          ? `Uma cópia só dela, numa branch nova a partir de ${base}. O "Trazer" leva o trabalho de volta.`
          : others
            ? `Vai mexer nos mesmos arquivos que ${others === 1 ? 'a outra conversa aberta' : `as outras ${others} conversas abertas`} em ${base}.`
            : `Direto em ${base}, no checkout do projeto.`
      }
      className={cn('mx-2 mb-1 flex min-h-9 items-center gap-2 rounded-lg px-2 text-xs text-muted-foreground', creating ? 'cursor-progress' : 'cursor-pointer')}
    >
      {creating ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <GitBranch className="size-3.5 shrink-0" />}
      <span className={cn('min-w-0 flex-1 truncate', on && 'text-foreground/80')}>
        {creating ? 'Criando o worktree…' : on ? 'Worktree próprio' : `Direto em ${base}`}
        {!on && others > 0 && !creating && <span className="text-amber-700 dark:text-amber-300"> · com mais {others}</span>}
      </span>
      {working.length > 0 && !creating && (
        <span className="flex shrink-0 items-center gap-1">
          <PeerFaces list={working} size={16} />
          {working.length} trabalhando
        </span>
      )}
      <Switch checked={on} onCheckedChange={choice.set} disabled={creating} aria-label="Rodar num worktree próprio" />
    </label>
  )
}

/**
 * A caixa da conversa nova. Sem conversa aberta no projeto, é o herói da página (a pergunta do dia e
 * os atalhos); com a mesa cheia, a primeira vaga dela. É o mesmo elemento nas duas formas, para a caixa
 * não remontar no meio do envio (ela só limpa o texto quando o envio volta).
 */
function NewChat({
  machine,
  cwd,
  git,
  hero,
  working,
  shortcuts,
  onPin,
}: {
  machine: string
  cwd: string
  git: GitStatus | null
  hero: boolean
  working: CatalogEntry[]
  shortcuts: { key: string; label: string; act: () => void }[]
  onPin: () => void
}) {
  const name = projectName(cwd)
  const surface = useSurface()
  const worktree = useWorktreeChoice(machine, cwd, git, true)
  const [creating, setCreating] = useState(false)
  const [pending, setPending] = useState<RunOptions>({})
  // Vem com o workspace padrão do projeto e o time dele; a pílula na caixa troca.
  const { workspace, choose, teamId } = useNewChatWorkspace(machine, cwd)

  const chips = shortcuts.length > 0 && (
    <div className={cn('flex flex-wrap justify-center gap-2', hero ? 'mt-1 px-4' : 'px-2')}>
      {shortcuts.map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={s.act}
          className={cn('max-w-72 truncate rounded-full px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground', surface)}
        >
          {s.label}
        </button>
      ))}
    </div>
  )

  return (
    <section className={cn(hero ? 'col-span-full mx-auto mt-[8vh] mb-6 w-full max-w-3xl' : cn('flex flex-col overflow-hidden rounded-xl', CELL, surface))}>
      <div className={hero ? 'mb-6' : 'flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden px-4 text-center'}>
        <ProjectMark machine={machine} cwd={cwd} name={name} className={hero ? 'mx-auto mb-4 size-12 rounded-xl text-xl' : 'size-10 rounded-xl text-lg'} />
        <h2 className={cn('text-center tracking-tight text-balance', hero ? 'text-3xl font-medium' : 'text-lg font-medium')}>
          {hero ? `O que vamos fazer no ${name} hoje?` : 'O que mais vamos fazer?'}
        </h2>
        {!hero && chips}
      </div>
      <WorktreeLine choice={worktree} working={working} creating={creating} />
      <Composer
        sessionId={`new:${cwd}`}
        cwd={cwd}
        branch={hero ? git?.branch : undefined}
        working={false}
        settings={pending}
        context={null}
        onChangeSettings={(patch) => setPending((p) => ({ ...p, ...patch }))}
        extra={<WorkspacePill machine={machine} project={cwd} value={workspace} onChange={choose} />}
        // Escrever aqui deixa o hub aberto, como editar no VSCode.
        onEdit={onPin}
        onSend={async (text, attachments) => {
          setCreating(worktree.on)
          try {
            const { sessionId } = await api.create(machine, {
              cwd,
              prompt: text,
              attachments,
              workspaceId: workspace?.id,
              teamId,
              worktree: worktree.on || undefined,
              ...pending,
            })
            noteSession(sessionId, machine)
            // Fica na mesa: a conversa nova aparece ao lado, e a caixa já serve para a próxima.
            onPin()
          } finally {
            setCreating(false)
          }
        }}
      />
      {hero && chips}
    </section>
  )
}

/**
 * O hub do projeto, aberto como aba pelo nome dele (na lista de sessões ou na de projetos). No alto, a
 * mesa: as conversas abertas no projeto (inclusive nos worktrees dele) lado a lado, em miniatura, e a
 * caixa de uma nova, que já nasce num worktree próprio para não atropelar as outras. Ao lado da mesa, os
 * worktrees do projeto, com o que falta trazer. Embaixo, as conversas fechadas, as pendências e o uso dos
 * últimos 30 dias. A barra da direita fica no projeto, com os arquivos e o git à mão.
 */
export function ProjectHub({ machine, cwd, active }: { machine: string; cwd: string; active: boolean }) {
  const name = projectName(cwd)
  const composerId = `new:${cwd}`
  const [, navigate] = useLocation()
  const [everyone, setEveryone] = useState(false)
  const [view, setView] = useState<'desk' | 'worktrees'>('desk')
  const git = useGitStatus(machine, cwd, null)
  const machineLabel = useMachines((s) => (s.machines.length > 1 ? s.machines.find((m) => m.id === machine)?.name : undefined))
  const scrim = useScrim()
  const surface = useSurface()
  const all = useStore((s) => s.catalog)
  // As dos worktrees do projeto também são dele.
  const team = useMemo(
    () => all.filter((c) => (c.machine ?? HOME) === machine && (c.worktree?.project ?? c.cwd) === cwd).sort(liveFirst),
    [all, machine, cwd],
  )
  // Na mesa, as abertas (no painel ou no PC); embaixo, as fechadas.
  const openIds = useMemo(() => team.filter((c) => c.owner).map((c) => c.sessionId), [team])
  const desk = useDeskOrder(openIds)
  const closed = useMemo(() => team.filter((c) => !c.owner), [team])
  const working = useMemo(() => team.filter((c) => c.owner && isWorking(c)), [team])
  const { info } = useGithub(machine, cwd, active)
  const todo = useTodos(machine, cwd)?.find((t) => !t.done)
  const { activity, outdated } = useProjectActivity(machine, cwd, active)
  const pin = () => pinTab(keyOf({ kind: 'project', machine, cwd }))

  // Atalhos: continuar a última conversa fechada (as abertas já estão na mesa), ou começar uma nova já
  // com a issue ou o item do TODO no texto.
  const recent = useMemo(() => [...closed].sort((a, b) => b.lastModified - a.lastModified)[0], [closed])
  const shortcuts: { key: string; label: string; act: () => void }[] = []
  if (recent && !desk.length)
    shortcuts.push({ key: 'recent', label: `Continuar com ${claudinhoName(recent.sessionId, recent.claudinhoName)}: ${recent.title}`, act: () => navigate(`/s/${recent.sessionId}`) })
  if (info?.ok)
    for (const i of info.issues.slice(0, 2))
      shortcuts.push({ key: `i${i.number}`, label: `issue #${i.number}: ${i.title}`, act: () => insertInto(composerId, `issue #${i.number} `) })
  // Com o número, o Claude recebe o item inteiro (descrição e anexos); sem ele (ainda salvando), o título.
  if (todo)
    shortcuts.push({
      key: 'todo',
      label: todo.n ? `TODO:${todo.n}: ${todo.title}` : `TODO: ${todo.title}`,
      act: () => insertInto(composerId, todo.n ? `TODO:${todo.n} ` : `${todo.title} `),
    })

  return (
    <div className="absolute inset-0">
      {/* O escurecido da cena atrás, como no chat e no código; fora da rolagem, para não rolar junto. */}
      {scrim !== null && <Veil dim={scrim} />}
      <div className="absolute inset-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-7xl px-4 pb-16 wide:px-6">
          <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 pt-4 text-xs text-muted-foreground">
            <FolderGit2 className="size-4 shrink-0" />
            <span className="text-sm font-medium text-foreground">{name}</span>
            <span className="truncate">{shortPath(cwd)}</span>
            {machineLabel && (
              <span className="flex items-center gap-0.5">
                <Server className="size-3" />
                {machineLabel}
              </span>
            )}
            {git.status?.branch && (
              <span className="flex items-center gap-1">
                <GitBranch className="size-3" />
                {git.status.branch}
              </span>
            )}
            {git.status && <GitBadges g={{ branch: git.status.branch, upstream: git.status.upstream, changed: git.status.files.length, ahead: git.status.ahead, behind: git.status.behind }} />}
            <Segmented
              value={view}
              onChange={setView}
              className="ml-auto w-60 shrink-0"
              options={[
                { key: 'desk', label: desk.length ? `Mesa · ${desk.length}` : 'Mesa', icon: <LayoutGrid /> },
                { key: 'worktrees', label: 'Worktrees', icon: <GitBranch /> },
              ]}
            />
          </header>

          {view === 'worktrees' ? (
            <div className={cn('mt-4 rounded-xl p-2', surface)}>
              <WorktreesView machine={machine} project={cwd} onLeave={() => {}} />
            </div>
          ) : (
            <>
              <div className="mt-4 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,20rem),1fr))]">
                <NewChat machine={machine} cwd={cwd} git={git.status} hero={!desk.length} working={working} shortcuts={shortcuts} onPin={pin} />
                {desk.map((id) =>
                  // Só com o hub à vista: escondido, cada miniatura seguiria recebendo a conversa ao vivo.
                  active ? (
                    <MiniChat key={id} id={id} machine={machine} onEdit={pin} className={cn(CELL, surface)} />
                  ) : (
                    <div key={id} className={cn('rounded-xl', CELL, surface)} />
                  ),
                )}
              </div>

              {closed.length > 0 && (
                <section className="mt-10 mb-6">
                  <div className="mb-2 flex items-baseline justify-between">
                    <h2 className="text-sm font-semibold">Fechadas · {closed.length}</h2>
                    {closed.length > TEAM && (
                      <button type="button" onClick={() => setEveryone(!everyone)} className="text-xs text-muted-foreground hover:text-foreground">
                        {everyone ? 'Mostrar menos' : `Ver todas (${closed.length})`}
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {(everyone ? closed : closed.slice(0, TEAM)).map((s) => (
                      <Member key={s.sessionId} s={s} />
                    ))}
                  </div>
                </section>
              )}

              <div className={cn('mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4', closed.length === 0 && 'mt-10')}>
                <GithubCards machine={machine} cwd={cwd} active={active} />
                <TodoCard machine={machine} cwd={cwd} />
                <WorkspaceCard machine={machine} cwd={cwd} />
              </div>

              <UsageCard activity={activity} outdated={outdated} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
