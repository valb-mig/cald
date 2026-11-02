import { CircleDot, FolderGit2, GitBranch, GitPullRequest, ListTodo, Loader2, Server } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { Composer } from '@/components/chat/composer'
import { Claudinho } from '@/components/claudinho'
import { GitBadges } from '@/components/git-badges'
import { BAR, plural, usd } from '@/components/home/scale'
import { StateBadge } from '@/components/state-badge'
import { Checkbox } from '@/components/ui/checkbox'
import { dayKey, noon, useToday } from '@/lib/activity'
import { api, OUTDATED_SERVER } from '@/lib/api'
import { claudinhoName } from '@/lib/claudinho'
import { insertInto } from '@/lib/compose'
import { projectName, relativeTime, shortPath } from '@/lib/format'
import { GITHUB_REASON, useGithub } from '@/lib/github'
import { useGitStatus } from '@/lib/hooks'
import { HOME, noteSession, useMachines } from '@/lib/machines'
import { setPanelShown, setPanelTab } from '@/lib/project-panel'
import { useStore } from '@/lib/store'
import { saveTodos, useTodos } from '@/lib/todos'
import type { Activity, CatalogEntry, RunOptions } from '@/lib/types'
import { cn } from '@/lib/utils'
import { keyOf, openPanelTab, openTab, pinTab } from '@/lib/workbench'

const SPAN = 30
/** Quantos claudinhos a equipe mostra antes do "ver todos". */
const TEAM = 8

/** Trabalhando e esperando você primeiro; depois, do mais recente ao mais antigo. */
const liveFirst = (a: CatalogEntry, b: CatalogEntry) => {
  const rank = (c: CatalogEntry) => (c.state === 'waiting' ? 0 : c.state === 'running' ? 1 : 2)
  return rank(a) - rank(b) || b.lastModified - a.lastModified
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
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border bg-card p-4">
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
              <span className="line-clamp-2 min-w-0">{t.text}</span>
            </label>
          ))}
        </div>
      )}
    </Card>
  )
}

/** Mensagens suas por dia nos últimos 30 dias, com os totais do projeto. */
function UsageCard({ activity, outdated }: { activity: Activity | null; outdated: boolean }) {
  const today = useToday()
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
    <section className="rounded-2xl border bg-card p-4">
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

/** Um claudinho da equipe: tocar abre a conversa dele. */
function Member({ s }: { s: CatalogEntry }) {
  const name = claudinhoName(s.sessionId, s.claudinhoName)
  return (
    <Link href={`/s/${s.sessionId}`} className="flex min-w-0 items-center gap-2.5 rounded-xl border bg-card p-2.5 transition-colors hover:bg-foreground/[0.03]">
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
 * O hub do projeto, aberto como aba pelo nome dele (na lista de sessões ou na de projetos): a pergunta
 * do dia com a caixa de mensagem (que começa uma conversa nova nele), atalhos para continuar, pegar uma
 * issue ou um item do TODO, a equipe de claudinhos (as conversas dele), as pendências e o uso dos
 * últimos 30 dias. A barra da direita fica no projeto, com os arquivos e o git à mão.
 */
export function ProjectHub({ machine, cwd, active }: { machine: string; cwd: string; active: boolean }) {
  const name = projectName(cwd)
  const composerId = `new:${cwd}`
  const [, navigate] = useLocation()
  const [pending, setPending] = useState<RunOptions>({})
  const [everyone, setEveryone] = useState(false)
  const git = useGitStatus(machine, cwd, null)
  const machineLabel = useMachines((s) => (s.machines.length > 1 ? s.machines.find((m) => m.id === machine)?.name : undefined))
  const all = useStore((s) => s.catalog)
  const team = useMemo(() => all.filter((c) => (c.machine ?? HOME) === machine && c.cwd === cwd).sort(liveFirst), [all, machine, cwd])
  const recent = useMemo(() => [...team].sort((a, b) => b.lastModified - a.lastModified)[0], [team])
  const { info } = useGithub(machine, cwd, active)
  const todo = useTodos(machine, cwd)?.find((t) => !t.done)
  const { activity, outdated } = useProjectActivity(machine, cwd, active)

  // Atalhos: continuar a última conversa, ou começar uma nova já com a issue ou o item do TODO no texto.
  const shortcuts: { key: string; label: string; act: () => void }[] = []
  if (recent) shortcuts.push({ key: 'recent', label: `Continuar com ${claudinhoName(recent.sessionId, recent.claudinhoName)}: ${recent.title}`, act: () => navigate(`/s/${recent.sessionId}`) })
  if (info?.ok)
    for (const i of info.issues.slice(0, 2))
      shortcuts.push({ key: `i${i.number}`, label: `issue #${i.number}: ${i.title}`, act: () => insertInto(composerId, `issue #${i.number} `) })
  if (todo) shortcuts.push({ key: 'todo', label: `TODO: ${todo.text}`, act: () => insertInto(composerId, `${todo.text} `) })

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-6 pb-16">
        <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-5 text-xs text-muted-foreground">
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
        </header>

        {/* O herói: a cena animada atrás (quando há uma), com um véu na cor do fundo para o texto ler bem. */}
        <section className="relative mt-[10vh] mb-12">
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-24 -inset-y-20 bg-[radial-gradient(ellipse_at_center,var(--background)_35%,transparent_72%)]"
          />
          <h1 className="relative text-center text-3xl font-medium tracking-tight text-balance">O que vamos fazer no {name} hoje?</h1>
          <div className="relative mt-6">
            <Composer
              sessionId={composerId}
              cwd={cwd}
              branch={git.status?.branch}
              working={false}
              settings={pending}
              context={null}
              onChangeSettings={(patch) => setPending((p) => ({ ...p, ...patch }))}
              // Escrever aqui deixa o hub aberto, como editar no VSCode.
              onEdit={() => pinTab(keyOf({ kind: 'project', machine, cwd }))}
              onSend={async (text, attachments) => {
                const { sessionId } = await api.create(machine, { cwd, prompt: text, attachments, ...pending })
                noteSession(sessionId, machine)
                // A conversa nova nasce aba fixa (ver lib/workbench.ts), e a URL leva até ela.
                openTab({ kind: 'chat', id: sessionId })
                navigate(`/s/${sessionId}`)
              }}
            />
          </div>
          {shortcuts.length > 0 && (
            <div className="relative mt-1 flex flex-wrap justify-center gap-2 px-4">
              {shortcuts.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={s.act}
                  className="max-w-72 truncate rounded-full border bg-card/80 px-3 py-1 text-xs text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="mb-6">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">A equipe{team.length ? ` · ${team.length}` : ''}</h2>
            {team.length > TEAM && (
              <button type="button" onClick={() => setEveryone(!everyone)} className="text-xs text-muted-foreground hover:text-foreground">
                {everyone ? 'Mostrar menos' : `Ver todos (${team.length})`}
              </button>
            )}
          </div>
          {team.length === 0 ? (
            <p className={quiet}>Ninguém por aqui ainda: a primeira conversa começa na caixa acima.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {(everyone ? team : team.slice(0, TEAM)).map((s) => (
                <Member key={s.sessionId} s={s} />
              ))}
            </div>
          )}
        </section>

        <div className="mb-6 grid gap-3 md:grid-cols-3">
          <GithubCards machine={machine} cwd={cwd} active={active} />
          <TodoCard machine={machine} cwd={cwd} />
        </div>

        <UsageCard activity={activity} outdated={outdated} />
      </div>
    </div>
  )
}
