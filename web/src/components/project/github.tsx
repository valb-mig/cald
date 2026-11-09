import { Check, CircleDot, ExternalLink, GitPullRequest, GitPullRequestDraft, Loader2, MessageSquare, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/format'
import { GITHUB_REASON, useGithub } from '@/lib/github'
import { WIDE_QUERY } from '@/lib/hooks'
import type { PanelProject } from '@/lib/project-panel'
import type { GithubInfo, GithubIssue, GithubPull } from '@/lib/types'
import { cn } from '@/lib/utils'
import { keyOf, openPanelTab, pinTab } from '@/lib/workbench'
import { IssuesEmptyArt, PullsEmptyArt } from './empty-art'

const ROW = 'flex min-w-0 items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors hover:bg-foreground/[0.04]'

/**
 * No PC, tocar abre a issue ou o PR numa aba de prévia no meio da tela (dois cliques a fixam), como os
 * arquivos; no celular, e com Ctrl ou ⌘ no PC, segue o link para o GitHub.
 */
function openProps(project: PanelProject, item: 'issue' | 'pr', number: number, title: string) {
  const ref = { kind: 'github', machine: project.machine, cwd: project.cwd, item, number, title } as const
  return {
    onClick: (e: React.MouseEvent) => {
      if (!matchMedia(WIDE_QUERY).matches || e.metaKey || e.ctrlKey || e.shiftKey) return
      e.preventDefault()
      openPanelTab(ref, { preview: true })
    },
    onDoubleClick: () => matchMedia(WIDE_QUERY).matches && pinTab(keyOf(ref)),
  }
}
const META = 'mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground'

/** Os checks do último commit do PR: só o resultado, em ícone com a cor dele. */
function Checks({ state }: { state: GithubPull['checks'] }) {
  if (!state) return null
  if (state === 'SUCCESS') return <Check className="size-3.5 text-emerald-500" aria-label="Checks passaram" />
  if (state === 'FAILURE' || state === 'ERROR') return <X className="size-3.5 text-red-500" aria-label="Checks falharam" />
  return <span className="size-2 rounded-full bg-amber-500" aria-label="Checks rodando" title="Checks rodando" />
}

const REVIEW: Record<NonNullable<GithubPull['review']>, { text: string; tone: string }> = {
  APPROVED: { text: 'aprovado', tone: 'text-emerald-600 dark:text-emerald-400' },
  CHANGES_REQUESTED: { text: 'mudanças pedidas', tone: 'text-red-600 dark:text-red-400' },
  REVIEW_REQUIRED: { text: 'esperando revisão', tone: '' },
}

function PullRow({ pr, project }: { pr: GithubPull; project: PanelProject }) {
  const review = pr.review && REVIEW[pr.review]
  return (
    <a href={pr.url} target="_blank" rel="noreferrer" className={ROW} {...openProps(project, 'pr', pr.number, pr.title)}>
      {pr.draft ? (
        <GitPullRequestDraft className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Rascunho" />
      ) : (
        <GitPullRequest className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-label="Aberto" />
      )}
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[13px] leading-snug">{pr.title}</div>
        <div className={META}>
          <span>#{pr.number}</span>
          {pr.author && <span>{pr.author}</span>}
          <span className="max-w-full truncate font-mono">{pr.branch}</span>
          <span>{relativeTime(Date.parse(pr.updatedAt))}</span>
          {review && <span className={review.tone}>{review.text}</span>}
        </div>
      </div>
      <span className="mt-1 flex shrink-0 items-center">
        <Checks state={pr.checks} />
      </span>
    </a>
  )
}

function IssueRow({ issue, project }: { issue: GithubIssue; project: PanelProject }) {
  return (
    <a href={issue.url} target="_blank" rel="noreferrer" className={ROW} {...openProps(project, 'issue', issue.number, issue.title)}>
      <CircleDot className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-label="Aberta" />
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[13px] leading-snug">{issue.title}</div>
        <div className={META}>
          <span>#{issue.number}</span>
          {issue.author && <span>{issue.author}</span>}
          <span>{relativeTime(Date.parse(issue.updatedAt))}</span>
          {issue.labels.map((l) => (
            // A cor da etiqueta é a do GitHub: é o jeito de reconhecer cada uma de relance.
            <span key={l.name} className="flex items-center gap-1">
              <span className="size-2 rounded-full" style={{ background: `#${l.color}` }} />
              {l.name}
            </span>
          ))}
        </div>
      </div>
      {issue.comments > 0 && (
        <span className="mt-0.5 flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums">
          <MessageSquare className="size-3" />
          {issue.comments}
        </span>
      )}
    </a>
  )
}

/**
 * O esqueleto das duas abas: a barrinha com o repositório, quando foi buscado e o atualizar; embaixo,
 * a lista, ou o motivo de não ter lista.
 */
function GithubTab<T>({
  project,
  pick,
  empty,
  path,
  render,
}: {
  project: PanelProject
  pick: (info: Extract<GithubInfo, { ok: true }>) => { items: T[]; total: number }
  /** O desenho do vazio, com a frase dele (ver empty-art.tsx). */
  empty: React.ReactNode
  /** A página da lista completa no GitHub, depois do repositório. */
  path: string
  render: (item: T) => React.ReactNode
}) {
  // Só monta com a aba à vista (ver PanelBody): é aí que busca.
  const { info, loading, error, refresh } = useGithub(project.machine, project.cwd, true)
  const list = info?.ok ? pick(info) : null
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 py-1 pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {info?.ok ? info.repo : 'GitHub'}
          {info && ` · ${relativeTime(info.fetchedAt)}`}
        </span>
        {info?.ok && (
          <Button variant="ghost" size="icon-xs" asChild>
            <a href={`https://github.com/${info.repo}/${path}`} target="_blank" rel="noreferrer" aria-label="Abrir no GitHub" title="Abrir no GitHub">
              <ExternalLink />
            </a>
          </Button>
        )}
        <Button variant="ghost" size="icon-xs" onClick={refresh} disabled={loading} aria-label="Atualizar" title="Atualizar">
          <RefreshCw className={cn(loading && 'animate-spin')} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {error ? (
          <p className="p-4 text-center text-sm text-muted-foreground">{error}</p>
        ) : !info ? (
          <div className="flex justify-center p-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !info.ok ? (
          <p className="p-4 text-center text-sm text-muted-foreground">{info.message ?? GITHUB_REASON[info.reason]}</p>
        ) : list && list.items.length === 0 ? (
          empty
        ) : (
          <div className="space-y-0.5">
            {list?.items.map(render)}
            {list && list.total > list.items.length && (
              <a
                href={`https://github.com/${info.repo}/${path}`}
                target="_blank"
                rel="noreferrer"
                className="block px-2.5 py-2 text-xs text-muted-foreground hover:text-foreground"
              >
                Mais {list.total - list.items.length} no GitHub
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** PRs abertos do repositório, dos mais mexidos aos menos; tocar abre o PR (ver `openProps`). */
export function PullsTab({ project }: { project: PanelProject }) {
  return (
    <GithubTab
      project={project}
      pick={(info) => ({ items: info.pulls, total: info.pullCount })}
      empty={<PullsEmptyArt />}
      path="pulls"
      render={(pr: GithubPull) => <PullRow key={pr.number} pr={pr} project={project} />}
    />
  )
}

/** Issues abertas do repositório, das mais mexidas às menos; tocar abre a issue (ver `openProps`). */
export function IssuesTab({ project }: { project: PanelProject }) {
  return (
    <GithubTab
      project={project}
      pick={(info) => ({ items: info.issues, total: info.issueCount })}
      empty={<IssuesEmptyArt />}
      path="issues"
      render={(issue: GithubIssue) => <IssueRow key={issue.number} issue={issue} project={project} />}
    />
  )
}
