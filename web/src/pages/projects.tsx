import { FolderPlus, GitBranch, House, Loader2, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Link, useLocation } from 'wouter'
import { AddProjectDialog } from '@/components/add-project-dialog'
import { GitBadges } from '@/components/git-badges'
import { PageHeader } from '@/components/layout'
import { MachineFilter } from '@/components/machine-filter'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, errorMessage } from '@/lib/api'
import { projectName, relativeTime, shortPath } from '@/lib/format'
import { useWide } from '@/lib/hooks'
import { HOME, newChatUrl, useMachineFilter } from '@/lib/machines'
import { cn } from '@/lib/utils'
import { useStore } from '@/lib/store'
import type { GitSummary } from '@/lib/types'
import { openProjectHub } from '@/lib/workbench'

type Stats = { count: number; last: number }

const pending = (g: GitSummary | undefined) => Boolean(g && (g.changed > 0 || g.ahead > 0 || g.behind > 0))

const ROW = 'mx-2 flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-foreground/[0.04] active:bg-foreground/[0.07]'

/** No PC, a linha abre o hub do projeto, e o + começa uma conversa nele; no celular, a linha toda começa. */
function ProjectRow(props: { cwd: string; machine: string; stats?: Stats; git?: GitSummary }) {
  const wide = useWide()
  if (!wide) {
    return (
      <Link href={newChatUrl(props.cwd, props.machine)} className={ROW}>
        <ProjectInfo {...props} />
        <Plus className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    )
  }
  return (
    <div className="mx-2 flex items-center gap-1 rounded-xl pr-1.5 transition-colors hover:bg-foreground/[0.04]">
      <button
        type="button"
        onClick={() => openProjectHub(props.machine, props.cwd)}
        title="Abrir o hub do projeto"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-2.5 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ProjectInfo {...props} />
      </button>
      <Button variant="ghost" size="icon-sm" asChild>
        <Link href={newChatUrl(props.cwd, props.machine)} aria-label={`Nova conversa em ${projectName(props.cwd)}`} title="Nova conversa neste projeto">
          <Plus />
        </Link>
      </Button>
    </div>
  )
}

function ProjectInfo({ cwd, stats, git }: { cwd: string; stats?: Stats; git?: GitSummary }) {
  const changes = pending(git)
  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium">{projectName(cwd)}</span>
        {git && <GitBadges g={git} />}
      </div>
      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        {changes && git?.branch && (
          <>
            <GitBranch className="size-3 shrink-0" />
            <span className="max-w-[40%] shrink-0 truncate">{git.branch}</span>
            <span className="shrink-0">·</span>
          </>
        )}
        <span className="truncate">
          {stats ? `${stats.count} ${stats.count === 1 ? 'sessão' : 'sessões'} · ${relativeTime(stats.last)}` : shortPath(cwd)}
        </span>
      </div>
    </div>
  )
}

/** `sidebar`: na barra lateral do PC (ver App.tsx), escolhida pelo ícone de Projetos da alça. */
export function ProjectsPage({ sidebar = false }: { sidebar?: boolean } = {}) {
  const catalog = useStore((s) => s.catalog)
  // Com várias máquinas, os projetos são os da máquina do filtro do topo (sem "Todas").
  const machine = useMachineFilter() ?? HOME
  const [projects, setProjects] = useState<string[] | null>(null)
  const [git, setGit] = useState<Record<string, GitSummary>>({})
  const [checking, setChecking] = useState(false)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  // Muda quando um projeto entra ou sai da lista: o git é conferido de novo, com o projeto novo.
  const [version, setVersion] = useState(0)
  const [, navigate] = useLocation()

  useEffect(() => {
    setProjects(null)
    api.projects(machine).then(setProjects, (err) => toast.error(errorMessage(err)))
  }, [machine])

  const reload = () => {
    void api.projects(machine).then(setProjects, (err) => toast.error(errorMessage(err)))
    setVersion((v) => v + 1)
  }

  // Primeiro o git local, que é rápido; depois de novo, com o remoto consultado (git fetch).
  useEffect(() => {
    let alive = true
    setGit({})
    setChecking(true)
    api
      .projectsGit(machine)
      .then((g) => {
        if (alive) setGit(g)
        return api.projectsGit(machine, true)
      })
      .then((g) => alive && setGit(g))
      // Máquina com servidor antigo, sem a rota: a lista segue sem o git.
      .catch(() => {})
      .finally(() => alive && setChecking(false))
    return () => {
      alive = false
    }
  }, [machine, version])

  const stats = useMemo(() => {
    const map = new Map<string, Stats>()
    for (const c of catalog) {
      if (!c.cwd || (c.machine ?? HOME) !== machine) continue
      const s = map.get(c.cwd) ?? { count: 0, last: 0 }
      map.set(c.cwd, { count: s.count + 1, last: Math.max(s.last, c.lastModified) })
    }
    return map
  }, [catalog, machine])

  const { changed, rest } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (projects ?? [])
      .filter((p) => !q || p.toLowerCase().includes(q))
      .sort((a, b) => (stats.get(b)?.last ?? 0) - (stats.get(a)?.last ?? 0) || a.localeCompare(b))
    return { changed: list.filter((p) => pending(git[p])), rest: list.filter((p) => !pending(git[p])) }
  }, [projects, query, stats, git])

  return (
    <>
      <PageHeader
        title="Projetos"
        className={sidebar ? 'bg-sidebar/90' : undefined}
        action={
          <div className="flex items-center gap-1">
            {checking && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Conferindo o remoto
              </span>
            )}
            <Button variant="ghost" size="icon-sm" onClick={() => setAdding(true)} aria-label="Adicionar projeto" title="Adicionar projeto">
              <FolderPlus />
            </Button>
          </div>
        }
      />
      <AddProjectDialog
        machine={machine}
        open={adding}
        onOpenChange={setAdding}
        onChange={reload}
        onAdded={(path) =>
          toast.success(`${projectName(path)} está nos projetos`, {
            action: { label: 'Nova conversa', onClick: () => navigate(newChatUrl(path, machine)) },
          })
        }
      />
      <MachineFilter all={false} className="px-4 pb-3" />
      <div className="px-4 pb-3">
        <Input
          type="search"
          placeholder="Buscar projeto"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Como o da lista de sessões: um recorte sem contorno, no tom do destaque da barra lateral.
          className={cn(
            'h-9 rounded-xl border-transparent px-3',
            sidebar ? 'bg-sidebar-accent/70' : 'bg-foreground/[0.06] dark:bg-foreground/[0.06]',
          )}
        />
      </div>
      {projects === null ? (
        <div className="space-y-3 px-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <>
          {changed.length > 0 && (
            <section className="mb-4">
              <h2 className="px-5 pb-1.5 text-xs font-medium text-muted-foreground">Com mudanças</h2>
              <div className="space-y-0.5">
                {changed.map((p) => (
                  <ProjectRow key={p} cwd={p} machine={machine} stats={stats.get(p)} git={git[p]} />
                ))}
              </div>
            </section>
          )}
          <section className="pb-4">
            {changed.length > 0 && (
              <h2 className="px-5 pb-1.5 text-xs font-medium text-muted-foreground">Outros projetos</h2>
            )}
            <div className="space-y-0.5">
              {!query.trim() && (
                <Link href={newChatUrl(undefined, machine)} className={ROW}>
                  <House className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">Sem projeto</div>
                    <div className="text-xs text-muted-foreground">Abre na pasta pessoal (~)</div>
                  </div>
                  <Plus className="size-4 shrink-0 text-muted-foreground" />
                </Link>
              )}
              {rest.map((p) => (
                <ProjectRow key={p} cwd={p} machine={machine} stats={stats.get(p)} git={git[p]} />
              ))}
              {changed.length + rest.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">Nenhum projeto encontrado.</p>}
            </div>
          </section>
        </>
      )}
    </>
  )
}
