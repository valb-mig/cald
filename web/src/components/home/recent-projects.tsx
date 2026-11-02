import { FolderGit2, GitBranch, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { projectName, relativeTime } from '@/lib/format'
import { useHome } from '@/lib/hooks'
import { HOME, newChatUrl } from '@/lib/machines'
import { useStore } from '@/lib/store'
import type { Activity, CatalogEntry, GitStatus } from '@/lib/types'
import { HomeCard } from './card'
import { plural, usd } from './scale'

const LIMIT = 6

type Project = { cwd: string; machine: string; latest: CatalogEntry; conversations: number }

/** Branch e arquivos não commitados, lidos uma vez ao abrir a home. */
function useGit(projects: Project[]): Record<string, GitStatus | null> {
  const [status, setStatus] = useState<Record<string, GitStatus | null>>({})
  const keys = projects.map((p) => `${p.machine}|${p.cwd}`).join('\n')
  useEffect(() => {
    let alive = true
    for (const key of keys.split('\n').filter(Boolean)) {
      const [machine, cwd] = key.split('|')
      api.git(machine, cwd).then(
        (s) => alive && setStatus((m) => ({ ...m, [key]: s })),
        () => alive && setStatus((m) => ({ ...m, [key]: null })),
      )
    }
    return () => {
      alive = false
    }
  }, [keys])
  return status
}

/** Os projetos das conversas mais recentes: git, última conversa, quanto custaram e conversa nova. */
export function RecentProjects({ activity, className }: { activity: Activity | null; className?: string }) {
  const catalog = useStore((s) => s.catalog)
  const loaded = useStore((s) => s.catalogLoaded)
  const home = useHome(HOME)
  const projects = useMemo(() => {
    const byKey = new Map<string, Project>()
    for (const c of [...catalog].sort((a, b) => b.lastModified - a.lastModified)) {
      // A pasta pessoal é "sem projeto": não entra.
      if (!c.cwd || c.cwd === home) continue
      const machine = c.machine ?? HOME
      const key = `${machine}|${c.cwd}`
      const p = byKey.get(key)
      if (p) p.conversations++
      else byKey.set(key, { cwd: c.cwd, machine, latest: c, conversations: 1 })
    }
    return [...byKey.values()].slice(0, LIMIT)
  }, [catalog, home])
  const git = useGit(projects)
  const cost = useMemo(() => new Map((activity?.projects ?? []).map((p) => [p.cwd, p.costUsd])), [activity])

  return (
    <HomeCard
      className={className}
      title="Projetos recentes"
      description="Toque para voltar à última conversa; + começa uma nova no projeto."
      action={
        <Button variant="ghost" size="sm" asChild className="-mt-1 -mr-2 text-xs">
          <Link href="/projetos">Todos</Link>
        </Button>
      }
    >
      {!loaded ? (
        <Skeleton className="h-40 w-full" />
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum projeto ainda. Comece uma conversa numa pasta de projeto e ela aparece aqui.</p>
      ) : (
        <div className="-mx-2 divide-y">
          {projects.map((p) => {
            const key = `${p.machine}|${p.cwd}`
            const g = git[key]
            const spent = cost.get(p.cwd)
            return (
              <div key={key} className="flex items-center gap-1">
                <Link href={`/s/${p.latest.sessionId}`} className="flex min-w-0 flex-1 items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-muted/50">
                  <FolderGit2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2 text-sm">
                      <span className="truncate font-medium" title={p.cwd}>
                        {projectName(p.cwd)}
                      </span>
                      {g === undefined ? (
                        <Skeleton className="h-3 w-16" />
                      ) : (
                        g && (
                          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                            <GitBranch className="size-3 shrink-0" />
                            <span className="truncate">{g.branch ?? 'sem branch'}</span>
                            {g.files.length > 0 ? (
                              <span className="shrink-0 rounded bg-sky-500/15 px-1 text-[10px] font-medium text-sky-700 dark:text-sky-300">
                                {plural(g.files.length, 'alterado', 'alterados')}
                              </span>
                            ) : (
                              <span className="shrink-0">· limpo</span>
                            )}
                          </span>
                        )
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {p.latest.title} · {relativeTime(p.latest.lastModified)}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {plural(p.conversations, 'conversa', 'conversas')}
                      {spent ? ` · ${usd(spent)} em 30 dias` : ''}
                    </div>
                  </div>
                </Link>
                <Button variant="ghost" size="icon" asChild aria-label={`Nova conversa em ${projectName(p.cwd)}`} className="shrink-0">
                  <Link href={newChatUrl(p.cwd, p.machine)}>
                    <Plus />
                  </Link>
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </HomeCard>
  )
}
