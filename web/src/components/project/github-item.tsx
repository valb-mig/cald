import { Check, CircleDot, ExternalLink, GitPullRequest, GitPullRequestDraft, Loader2, MessageSquarePlus, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/format'
import { GITHUB_REASON, useGithubItem } from '@/lib/github'
import { insertInChat } from '@/lib/project-panel'
import type { GithubCheck, GithubComment, GithubIssueDetail, GithubLabel, GithubPullDetail, GithubReview } from '@/lib/types'
import { cn } from '@/lib/utils'

const when = (iso: string) => relativeTime(Date.parse(iso))

/** O estado na cor que o GitHub usa para ele: aberto verde, mesclado ou concluída roxo, fechado vermelho. */
function StatePill({ item }: { item: GithubIssueDetail | GithubPullDetail }) {
  const pr = item.kind === 'pr'
  const [text, tone] =
    pr && item.draft && item.state === 'OPEN'
      ? ['Rascunho', 'bg-muted text-muted-foreground']
      : item.state === 'OPEN'
        ? [pr ? 'Aberto' : 'Aberta', 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300']
        : item.state === 'MERGED'
          ? ['Mesclado', 'bg-violet-500/15 text-violet-700 dark:text-violet-300']
          : !pr && item.stateReason === 'COMPLETED'
            ? ['Concluída', 'bg-violet-500/15 text-violet-700 dark:text-violet-300']
            : !pr && item.stateReason === 'NOT_PLANNED'
              ? ['Fechada sem fazer', 'bg-muted text-muted-foreground']
              : [pr ? 'Fechado' : 'Fechada', 'bg-red-500/15 text-red-700 dark:text-red-300']
  const Icon = pr ? (item.draft ? GitPullRequestDraft : GitPullRequest) : CircleDot
  return (
    <span className={cn('flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tone)}>
      <Icon className="size-3.5" />
      {text}
    </span>
  )
}

function Labels({ labels }: { labels: GithubLabel[] }) {
  if (!labels.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {labels.map((l) => (
        // A cor da etiqueta é a do GitHub: é o jeito de reconhecer cada uma de relance.
        <span key={l.name} className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
          <span className="size-2 rounded-full" style={{ background: `#${l.color}` }} />
          {l.name}
        </span>
      ))}
    </div>
  )
}

/** Um texto de alguém (a descrição, um comentário, uma revisão): quem, quando e o markdown. */
function Post({ author, at, body, note, href }: { author: string | null; at: string | null; body: string; note?: React.ReactNode; href?: string }) {
  return (
    <article className="rounded-2xl border bg-card">
      <header className="flex min-w-0 items-center gap-1.5 border-b px-4 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{author ?? 'alguém'}</span>
        {note}
        {at && (
          <a href={href} target="_blank" rel="noreferrer" className={cn('ml-auto shrink-0', href && 'hover:text-foreground')}>
            {when(at)}
          </a>
        )}
      </header>
      <div className="px-4 py-3">
        {body.trim() ? <Markdown text={body} /> : <p className="text-sm text-muted-foreground italic">Sem texto.</p>}
      </div>
    </article>
  )
}

function Section({ title, action, children }: { title: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

const CHECK: Record<GithubCheck['result'], React.ReactNode> = {
  success: <Check className="size-3.5 text-emerald-500" aria-label="Passou" />,
  failure: <X className="size-3.5 text-red-500" aria-label="Falhou" />,
  pending: <span className="mx-[3px] size-2 rounded-full bg-amber-500" aria-label="Rodando" />,
  neutral: <span className="mx-[3px] size-2 rounded-full bg-muted-foreground/50" aria-label="Pulado" />,
}

const REVIEW: Record<GithubReview['state'], string> = {
  APPROVED: 'aprovou',
  CHANGES_REQUESTED: 'pediu mudanças',
  COMMENTED: 'comentou',
  DISMISSED: 'revisão descartada',
  PENDING: 'revisão pendente',
}

/** O que o PR precisa para entrar: revisão, conflito e checks, numa linha cada, só o que tem algo a dizer. */
function PullStatus({ pr }: { pr: GithubPullDetail }) {
  const failed = pr.checks.filter((c) => c.result === 'failure').length
  const running = pr.checks.filter((c) => c.result === 'pending').length
  const lines: [React.ReactNode, string][] = []
  if (pr.review === 'APPROVED') lines.push([CHECK.success, 'Aprovado na revisão'])
  if (pr.review === 'CHANGES_REQUESTED') lines.push([CHECK.failure, 'Mudanças pedidas na revisão'])
  if (pr.review === 'REVIEW_REQUIRED') lines.push([CHECK.pending, 'Esperando revisão'])
  if (pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING') lines.push([CHECK.failure, `Conflito com ${pr.base}`])
  if (pr.checks.length)
    lines.push(
      failed
        ? [CHECK.failure, `${failed} de ${pr.checks.length} checks falharam`]
        : running
          ? [CHECK.pending, `${running} de ${pr.checks.length} checks rodando`]
          : [CHECK.success, `${pr.checks.length} ${pr.checks.length === 1 ? 'check passou' : 'checks passaram'}`],
    )
  if (!lines.length) return null
  return (
    <ul className="mt-5 space-y-1.5 rounded-2xl border bg-card px-4 py-3 text-sm">
      {lines.map(([icon, text]) => (
        <li key={text} className="flex items-center gap-2">
          <span className="flex size-4 items-center justify-center">{icon}</span>
          {text}
        </li>
      ))}
    </ul>
  )
}

function PullDetails({ pr }: { pr: GithubPullDetail }) {
  const reviews = pr.reviews.filter((r) => r.body.trim() || r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
  return (
    <>
      {pr.checks.length > 0 && (
        <Section title="Checks">
          <ul className="space-y-0.5">
            {pr.checks.map((c, i) => (
              <li key={`${c.name}-${i}`}>
                <a
                  href={c.url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-foreground/[0.04]"
                >
                  <span className="flex size-4 items-center justify-center">{CHECK[c.result]}</span>
                  <span className="min-w-0 truncate">{c.name}</span>
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section
        title={`Arquivos alterados · ${pr.changedFiles}`}
        action={
          <a href={`${pr.url}/files`} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-foreground">
            Ver o diff no GitHub
          </a>
        }
      >
        <ul className="rounded-2xl border bg-card py-1.5">
          {pr.files.map((f) => (
            <li key={f.path} className="flex min-w-0 items-center gap-3 px-4 py-1 text-[13px]">
              <span className={cn('min-w-0 flex-1 truncate font-mono text-xs', f.change === 'DELETED' && 'line-through')} title={f.path}>
                {f.path}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">+{f.additions}</span>{' '}
                <span className="text-red-600 dark:text-red-400">−{f.deletions}</span>
              </span>
            </li>
          ))}
          {pr.changedFiles > pr.files.length && (
            <li className="px-4 py-1 text-xs text-muted-foreground">Mais {pr.changedFiles - pr.files.length} no GitHub</li>
          )}
        </ul>
      </Section>
      {reviews.length > 0 && (
        <Section title="Revisões">
          <div className="space-y-3">
            {reviews.map((r, i) => (
              <Post
                key={i}
                author={r.author}
                at={r.submittedAt}
                body={r.body}
                note={<span className={cn(r.state === 'APPROVED' && 'text-emerald-600 dark:text-emerald-400', r.state === 'CHANGES_REQUESTED' && 'text-red-600 dark:text-red-400')}>{REVIEW[r.state]}</span>}
              />
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

function Comments({ comments, total }: { comments: GithubComment[]; total: number }) {
  return (
    <Section title={`Comentários · ${total}`}>
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ninguém comentou ainda.</p>
      ) : (
        <div className="space-y-3">
          {total > comments.length && <p className="text-xs text-muted-foreground">Os {comments.length} mais recentes.</p>}
          {comments.map((c) => (
            <Post key={c.url} author={c.author} at={c.createdAt} body={c.body} href={c.url} />
          ))}
        </div>
      )}
    </Section>
  )
}

/**
 * Uma issue ou um PR aberto como aba, para analisar: título, estado, descrição, comentários e, no PR,
 * o que falta para entrar (revisão, conflito, checks), os checks, os arquivos e as revisões. "Mandar
 * para o chat" põe a referência no campo da conversa do projeto, para pedir ao Claude que olhe.
 */
export function GithubItemView({
  machine,
  cwd,
  kind,
  number,
  title,
  active,
}: {
  machine: string
  cwd: string
  kind: 'issue' | 'pr'
  number: number
  title?: string
  active: boolean
}) {
  const { item: result, loading, error, refresh } = useGithubItem(machine, cwd, kind, number, active)
  const item = result?.ok ? result.item : null
  const name = `${kind === 'pr' ? 'PR' : 'Issue'} #${number}`
  const send = () => {
    if (!item) return
    if (!insertInChat(`${name}: ${item.title} (${item.url}) `))
      toast('Nenhuma conversa deste projeto com onde escrever agora', { description: 'Abra uma conversa nele no painel e tente de novo.' })
  }

  return (
    <div className="absolute inset-0 overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-3xl px-6 pt-5 pb-16">
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {name}
            {result?.ok && ` · ${result.repo}`}
            {result && ` · ${relativeTime(result.fetchedAt)}`}
          </span>
          <Button variant="ghost" size="sm" onClick={send} disabled={!item}>
            <MessageSquarePlus /> Mandar para o chat
          </Button>
          {item && (
            <Button variant="ghost" size="icon-sm" asChild>
              <a href={item.url} target="_blank" rel="noreferrer" aria-label="Abrir no GitHub" title="Abrir no GitHub">
                <ExternalLink />
              </a>
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={refresh} disabled={loading} aria-label="Atualizar" title="Atualizar">
            <RefreshCw className={cn(loading && 'animate-spin')} />
          </Button>
        </div>

        {error || (result && !result.ok) ? (
          <div className="mt-16 text-center">
            <h1 className="text-lg font-semibold">{title ?? name}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{error ?? (result && !result.ok ? (result.message ?? GITHUB_REASON[result.reason]) : '')}</p>
          </div>
        ) : !item ? (
          <div className="mt-16 flex flex-col items-center gap-3 text-center">
            {title && <h1 className="text-lg font-semibold">{title}</h1>}
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <h1 className="mt-3 text-xl leading-snug font-semibold">{item.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
              <StatePill item={item} />
              <span>
                <span className="text-foreground">{item.author ?? 'alguém'}</span> abriu {when(item.createdAt)} · mexido {when(item.updatedAt)}
              </span>
            </div>
            {item.kind === 'pr' && (
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono">{item.branch}</span>→
                <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono">{item.base}</span>
                <span className="font-mono tabular-nums">
                  <span className="text-emerald-600 dark:text-emerald-400">+{item.additions}</span>{' '}
                  <span className="text-red-600 dark:text-red-400">−{item.deletions}</span>
                </span>
                <span>
                  {item.changedFiles} {item.changedFiles === 1 ? 'arquivo' : 'arquivos'} · {item.commitCount}{' '}
                  {item.commitCount === 1 ? 'commit' : 'commits'}
                </span>
              </div>
            )}
            {item.kind === 'issue' && item.assignees.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">Com {item.assignees.join(', ')}</p>
            )}
            <div className="mt-3">
              <Labels labels={item.labels} />
            </div>
            {item.kind === 'pr' && <PullStatus pr={item} />}
            <div className="mt-6">
              <Post author={item.author} at={item.createdAt} body={item.body} href={item.url} />
            </div>
            {item.kind === 'pr' && <PullDetails pr={item} />}
            <Comments comments={item.comments} total={item.commentCount} />
          </>
        )}
      </div>
    </div>
  )
}
