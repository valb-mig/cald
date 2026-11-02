import {
  Check,
  CircleCheck,
  CircleDot,
  CircleX,
  Copy,
  ExternalLink,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  RefreshCw,
  Settings2,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/format'
import { GITHUB_REASON, useGithubItem } from '@/lib/github'
import { insertInChat } from '@/lib/project-panel'
import type { GithubCheck, GithubCommit, GithubComment, GithubIssueDetail, GithubLabel, GithubPullDetail, GithubReview } from '@/lib/types'
import { cn } from '@/lib/utils'
import { CommentBox, GithubTarget, ItemMenu, LabelsEditor, mergeBlock, mergeWarning, PullActions, QuotaNote, useGithubAct } from './github-actions'

const when = (iso: string) => relativeTime(Date.parse(iso))

type Item = GithubIssueDetail | GithubPullDetail

// ---- peças ----

/** A foto de quem é, do GitHub; sem ela (servidor antigo, conta apagada), a inicial. */
function Avatar({ login, src, className }: { login: string | null; src?: string | null; className?: string }) {
  const [broken, setBroken] = useState(false)
  const size = cn('size-8 shrink-0 rounded-full', className)
  if (!src || broken)
    return (
      <span aria-hidden className={cn(size, 'flex items-center justify-center bg-foreground/10 text-xs font-medium text-muted-foreground uppercase')}>
        {login?.[0] ?? '?'}
      </span>
    )
  return <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className={cn(size, 'bg-foreground/10')} />
}

/** A relação de quem escreveu com o repositório, como o selo do GitHub ("Owner", "Member"…). */
const ROLE: Record<string, string> = {
  OWNER: 'Dono',
  MEMBER: 'Membro',
  COLLABORATOR: 'Colaborador',
  CONTRIBUTOR: 'Já contribuiu',
  FIRST_TIME_CONTRIBUTOR: 'Primeira contribuição',
  FIRST_TIMER: 'Primeira vez no GitHub',
}

function Role({ role, author }: { role?: string; author?: boolean }) {
  const label = role ? ROLE[role] : undefined
  if (!label && !author) return null
  return (
    <>
      {author && <span className="rounded-full px-1.5 py-px text-[10px] font-medium text-muted-foreground ring-1 ring-foreground/15">Autor</span>}
      {label && <span className="rounded-full px-1.5 py-px text-[10px] font-medium text-muted-foreground ring-1 ring-foreground/15">{label}</span>}
    </>
  )
}

/** O estado na cor que o GitHub usa para ele: aberto verde, mesclado ou concluída roxo, fechado vermelho. */
function StatePill({ item }: { item: Item }) {
  const pr = item.kind === 'pr'
  const [text, tone, Icon] =
    pr && item.draft && item.state === 'OPEN'
      ? ['Rascunho', 'bg-foreground/10 text-muted-foreground', GitPullRequestDraft]
      : item.state === 'OPEN'
        ? [pr ? 'Aberto' : 'Aberta', 'bg-emerald-600 text-white', pr ? GitPullRequest : CircleDot]
        : item.state === 'MERGED'
          ? ['Mesclado', 'bg-violet-600 text-white', GitMerge]
          : !pr && item.stateReason === 'COMPLETED'
            ? ['Concluída', 'bg-violet-600 text-white', CircleCheck]
            : !pr && item.stateReason === 'NOT_PLANNED'
              ? ['Fechada sem fazer', 'bg-foreground/10 text-muted-foreground', CircleX]
              : [pr ? 'Fechado' : 'Fechada', 'bg-red-600 text-white', pr ? GitPullRequestClosed : CircleX]
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium', tone)}>
      <Icon className="size-4" />
      {text}
    </span>
  )
}

/** Um nome de branch numa pílula, com o copiar ao lado (o da branch do PR). */
function BranchChip({ name, copy }: { name: string; copy?: boolean }) {
  return (
    <span className="inline-flex max-w-full items-center gap-0.5 rounded-md bg-sky-500/10 font-mono text-xs text-sky-700 dark:text-sky-300">
      <span className="truncate px-1.5 py-0.5">{name}</span>
      {copy && (
        <button
          type="button"
          aria-label="Copiar o nome da branch"
          title="Copiar"
          onClick={() => void navigator.clipboard.writeText(name).then(() => toast.success('Branch copiada'))}
          className="mr-0.5 rounded p-0.5 opacity-70 hover:bg-sky-500/15 hover:opacity-100"
        >
          <Copy className="size-3" />
        </button>
      )}
    </span>
  )
}

/** Os cinco quadradinhos do GitHub: a proporção do que entrou (verde) e do que saiu (vermelho). */
function DiffBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions
  const green = total ? Math.round((additions / total) * 5) : 0
  const red = total ? Math.min(5 - green, Math.max(deletions ? 1 : 0, Math.round((deletions / total) * 5))) : 0
  return (
    <span className="flex gap-0.5" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={cn('size-2 rounded-[2px]', i < green ? 'bg-emerald-500' : i < green + red ? 'bg-red-500' : 'bg-foreground/15')}
        />
      ))}
    </span>
  )
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex items-center gap-2 font-mono text-xs tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{additions.toLocaleString('pt-BR')}</span>
      <span className="text-red-600 dark:text-red-400">−{deletions.toLocaleString('pt-BR')}</span>
      <DiffBar additions={additions} deletions={deletions} />
    </span>
  )
}

function Labels({ labels }: { labels: GithubLabel[] }) {
  return (
    <>
      {labels.map((l) => (
        // A cor da etiqueta é a do GitHub: é o jeito de reconhecer cada uma de relance.
        <span key={l.name} className="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ring-1 ring-foreground/15">
          <span className="size-2 rounded-full" style={{ background: `#${l.color}` }} />
          {l.name}
        </span>
      ))}
    </>
  )
}

// ---- linha do tempo ----

/** Um texto de alguém (a descrição, um comentário, uma revisão), como o do GitHub: a foto ao lado e o cartão. */
function Post({
  author,
  avatar,
  role,
  isAuthor,
  verb = 'comentou',
  at,
  body,
  href,
  tone,
}: {
  author: string | null
  avatar?: string | null
  role?: string
  isAuthor?: boolean
  verb?: React.ReactNode
  at: string | null
  body: string
  href?: string
  tone?: 'approved' | 'changes'
}) {
  return (
    <div className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
      <Avatar login={author} src={avatar} className="relative z-10 ring-4 ring-background" />
      <article
        className={cn(
          'overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10',
          tone === 'approved' && 'ring-emerald-500/40',
          tone === 'changes' && 'ring-red-500/40',
        )}
      >
        <header className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 bg-foreground/[0.03] px-4 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{author ?? 'alguém'}</span>
          <span>{verb}</span>
          {at && (
            <a href={href} target="_blank" rel="noreferrer" className={cn(href && 'hover:text-foreground hover:underline')}>
              {when(at)}
            </a>
          )}
          <span className="ml-auto flex items-center gap-1">
            <Role role={role} author={isAuthor} />
          </span>
        </header>
        <div className="px-4 py-3">
          {body.trim() ? <Markdown text={body} /> : <p className="text-sm text-muted-foreground italic">Sem descrição.</p>}
        </div>
      </article>
    </div>
  )
}

/** Um acontecimento pequeno na linha do tempo (commits que entraram, uma revisão sem texto): o ícone no fio. */
function Event({ icon, tone, children }: { icon: React.ReactNode; tone?: string; children: React.ReactNode }) {
  return (
    <div className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
      <span className="relative z-10 flex justify-center pt-0.5">
        <span className={cn('flex size-7 items-center justify-center rounded-full bg-background ring-1 ring-foreground/10 [&_svg]:size-3.5', tone ?? 'text-muted-foreground')}>
          {icon}
        </span>
      </span>
      <div className="min-w-0 py-1 text-sm text-muted-foreground">{children}</div>
    </div>
  )
}

const REVIEW: Record<GithubReview['state'], string> = {
  APPROVED: 'aprovou estas mudanças',
  CHANGES_REQUESTED: 'pediu mudanças',
  COMMENTED: 'revisou',
  DISMISSED: 'teve a revisão descartada',
  PENDING: 'está revisando',
}

type Moment =
  | { kind: 'comment'; at: string; comment: GithubComment }
  | { kind: 'review'; at: string; review: GithubReview }
  | { kind: 'commits'; at: string; commits: GithubCommit[] }

/** Comentários, revisões e commits na ordem em que aconteceram; commits seguidos viram um bloco só. */
function momentsOf(item: Item): Moment[] {
  const all: Moment[] = [
    ...item.comments.map((c): Moment => ({ kind: 'comment', at: c.createdAt, comment: c })),
    ...(item.kind === 'pr'
      ? [
          ...item.reviews
            .filter((r) => r.submittedAt && (r.body.trim() || r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED'))
            .map((r): Moment => ({ kind: 'review', at: r.submittedAt!, review: r })),
          ...(item.commits ?? []).map((c): Moment => ({ kind: 'commits', at: c.date, commits: [c] })),
        ]
      : []),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const out: Moment[] = []
  for (const m of all) {
    const last = out[out.length - 1]
    if (m.kind === 'commits' && last?.kind === 'commits') last.commits.push(...m.commits)
    else out.push(m.kind === 'commits' ? { ...m, commits: [...m.commits] } : m)
  }
  return out
}

function CommitRow({ c }: { c: GithubCommit }) {
  return (
    <li className="flex min-w-0 items-center gap-2 py-0.5">
      <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground/60" />
      <Avatar login={c.author} src={c.avatar} className="size-4" />
      <a href={c.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-foreground hover:underline" title={c.headline}>
        {c.headline}
      </a>
      <a href={c.url} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-xs text-muted-foreground hover:text-foreground">
        {c.short}
      </a>
    </li>
  )
}

function Timeline({ item }: { item: Item }) {
  const moments = momentsOf(item)
  const hidden = item.commentCount - item.comments.length
  return (
    <>
      {hidden > 0 && (
        <Event icon={<MessageSquare />}>
          {hidden} {hidden === 1 ? 'comentário mais antigo fica' : 'comentários mais antigos ficam'} no{' '}
          <a href={item.url} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
            GitHub
          </a>
          .
        </Event>
      )}
      {moments.map((m, i) =>
        m.kind === 'comment' ? (
          <Post
            key={m.comment.url}
            author={m.comment.author}
            avatar={m.comment.avatar}
            role={m.comment.role}
            isAuthor={m.comment.author === item.author}
            at={m.comment.createdAt}
            body={m.comment.body}
            href={m.comment.url}
          />
        ) : m.kind === 'review' ? (
          m.review.body.trim() ? (
            <Post
              key={`r${i}`}
              author={m.review.author}
              avatar={m.review.avatar}
              verb={REVIEW[m.review.state]}
              at={m.review.submittedAt}
              body={m.review.body}
              tone={m.review.state === 'APPROVED' ? 'approved' : m.review.state === 'CHANGES_REQUESTED' ? 'changes' : undefined}
            />
          ) : (
            <Event
              key={`r${i}`}
              icon={m.review.state === 'APPROVED' ? <Check /> : m.review.state === 'CHANGES_REQUESTED' ? <X /> : <MessageSquare />}
              tone={m.review.state === 'APPROVED' ? 'text-emerald-500' : m.review.state === 'CHANGES_REQUESTED' ? 'text-red-500' : undefined}
            >
              <span className="font-medium text-foreground">{m.review.author ?? 'alguém'}</span> {REVIEW[m.review.state]} {when(m.at)}
            </Event>
          )
        ) : (
          <Event key={`c${i}`} icon={<GitCommitHorizontal />}>
            <p>
              <span className="font-medium text-foreground">{m.commits[0]!.author ?? 'alguém'}</span> adicionou{' '}
              {m.commits.length === 1 ? 'um commit' : `${m.commits.length} commits`} {when(m.commits[m.commits.length - 1]!.date)}
            </p>
            <ul className="mt-1.5">
              {m.commits.map((c) => (
                <CommitRow key={c.sha} c={c} />
              ))}
            </ul>
          </Event>
        ),
      )}
    </>
  )
}

// ---- caixa de merge ----

const CHECK: Record<GithubCheck['result'], React.ReactNode> = {
  success: <Check className="size-3.5 text-emerald-500" aria-label="Passou" />,
  failure: <X className="size-3.5 text-red-500" aria-label="Falhou" />,
  pending: <span className="mx-[3px] size-2 rounded-full bg-amber-500" aria-label="Rodando" />,
  neutral: <span className="mx-[3px] size-2 rounded-full bg-muted-foreground/50" aria-label="Pulado" />,
}

/**
 * O pé da conversa do PR, como a caixa de merge do GitHub: a revisão, os checks e o conflito, uma linha
 * cada, e embaixo os botões. A cor diz o estado: verde pronto para entrar, vermelho com conflito ou
 * fechado, roxo já mesclado, neutro esperando algo.
 */
function MergeBox({ pr }: { pr: GithubPullDetail }) {
  const block = mergeBlock(pr)
  const warning = mergeWarning(pr)
  const failed = pr.checks.filter((c) => c.result === 'failure').length
  const running = pr.checks.filter((c) => c.result === 'pending').length
  const conflict = pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY'
  const tone =
    pr.state === 'MERGED' ? 'violet' : pr.state === 'CLOSED' || conflict ? 'red' : block || warning ? 'neutral' : ('green' as const)
  const lines: [React.ReactNode, string, string?][] = []
  if (pr.state === 'OPEN') {
    if (pr.review === 'APPROVED') lines.push([CHECK.success, 'Aprovado na revisão'])
    else if (pr.review === 'CHANGES_REQUESTED') lines.push([CHECK.failure, 'Mudanças pedidas na revisão'])
    else if (pr.review === 'REVIEW_REQUIRED') lines.push([CHECK.pending, 'Esperando revisão', 'O repositório pede ao menos uma aprovação.'])
    if (pr.checks.length)
      lines.push(
        failed
          ? [CHECK.failure, `${failed} de ${pr.checks.length} checks falharam`]
          : running
            ? [CHECK.pending, `${running} de ${pr.checks.length} checks rodando`]
            : [CHECK.success, `${pr.checks.length} ${pr.checks.length === 1 ? 'check passou' : 'checks passaram'}`],
      )
    lines.push(
      conflict
        ? [CHECK.failure, `Tem conflito com ${pr.base}`, 'Resolva no PC (ou peça ao Claude) e suba a branch de novo.']
        : pr.mergeable === 'UNKNOWN'
          ? [CHECK.pending, 'O GitHub ainda está conferindo se há conflito']
          : [CHECK.success, `Sem conflito com ${pr.base}`, 'Dá para juntar automaticamente.'],
    )
  }
  const title =
    pr.state === 'MERGED'
      ? `Mesclado em ${pr.base}`
      : pr.state === 'CLOSED'
        ? 'Fechado sem juntar'
        : pr.draft
          ? 'Ainda é rascunho'
          : conflict
            ? 'Tem conflito para resolver'
            : warning
              ? 'Falta algo para entrar'
              : 'Pronto para entrar'
  const ring = { green: 'ring-emerald-500/40', red: 'ring-red-500/40', violet: 'ring-violet-500/40', neutral: 'ring-foreground/10' }[tone]
  const badge = { green: 'bg-emerald-600 text-white', red: 'bg-red-600 text-white', violet: 'bg-violet-600 text-white', neutral: 'bg-foreground/10 text-muted-foreground' }[
    tone
  ]
  return (
    <div className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
      <span className={cn('relative z-10 flex size-8 items-center justify-center rounded-full ring-4 ring-background', badge)}>
        {pr.state === 'CLOSED' ? <GitPullRequestClosed className="size-4" /> : <GitMerge className="size-4" />}
      </span>
      <div className={cn('overflow-hidden rounded-xl bg-card ring-1', ring)}>
        <div className="px-4 pt-3 pb-1 text-sm font-semibold">{title}</div>
        {lines.length > 0 && (
          <ul className="divide-y divide-foreground/[0.06] px-4">
            {lines.map(([icon, text, hint]) => (
              <li key={text} className="flex items-start gap-2.5 py-2 text-sm">
                <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">{icon}</span>
                <span className="min-w-0">
                  {text}
                  {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {pr.state === 'OPEN' && (
          <div className="flex flex-wrap items-center gap-2 bg-foreground/[0.03] px-4 py-3">
            <PullActions pr={pr} />
            {(block ?? warning) && <span className="text-xs text-muted-foreground">{block ?? warning}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

// ---- abas do PR ----

type Tab = 'conversation' | 'commits' | 'checks' | 'files'

function Tabs({ pr, tab, onChange }: { pr: GithubPullDetail; tab: Tab; onChange: (t: Tab) => void }) {
  const items: { key: Tab; label: string; count?: number }[] = [
    { key: 'conversation', label: 'Conversa', count: pr.commentCount },
    { key: 'commits', label: 'Commits', count: pr.commitCount },
    { key: 'checks', label: 'Checks', count: pr.checks.length },
    { key: 'files', label: 'Arquivos', count: pr.changedFiles },
  ]
  return (
    <div role="tablist" className="flex flex-wrap items-center gap-1">
      {items.map((i) => (
        <button
          key={i.key}
          type="button"
          role="tab"
          aria-selected={tab === i.key}
          onClick={() => onChange(i.key)}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors',
            tab === i.key ? 'bg-foreground/[0.07] font-medium text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
          )}
        >
          {i.label}
          {i.count !== undefined && <span className="rounded-full bg-foreground/[0.08] px-1.5 text-xs tabular-nums">{i.count}</span>}
        </button>
      ))}
      <span className="ml-auto max-sm:hidden">
        <Counts additions={pr.additions} deletions={pr.deletions} />
      </span>
    </div>
  )
}

const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })

function CommitsTab({ pr }: { pr: GithubPullDetail }) {
  const commits = [...(pr.commits ?? [])].reverse()
  if (!commits.length) return <p className="text-sm text-muted-foreground">Reinicie o serviço claude-remote no PC para ver os commits aqui.</p>
  const days = commits.reduce<[string, GithubCommit[]][]>((acc, c) => {
    const d = day(c.date)
    const last = acc[acc.length - 1]
    if (last?.[0] === d) last[1].push(c)
    else acc.push([d, [c]])
    return acc
  }, [])
  return (
    <div className="space-y-5">
      {days.map(([d, list]) => (
        <section key={d}>
          <h3 className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <GitCommitHorizontal className="size-3.5" /> Commits de {d}
          </h3>
          <ul className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
            {list.map((c) => (
              <li key={c.sha} className="flex min-w-0 items-center gap-3 border-b border-foreground/[0.06] px-4 py-2.5 last:border-0">
                <div className="min-w-0 flex-1">
                  <a href={c.url} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium hover:underline" title={c.headline}>
                    {c.headline}
                  </a>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Avatar login={c.author} src={c.avatar} className="size-4" />
                    {c.author ?? 'alguém'} · {when(c.date)}
                  </span>
                </div>
                <a href={c.url} target="_blank" rel="noreferrer" className="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-xs text-muted-foreground ring-1 ring-foreground/10 hover:text-foreground">
                  {c.short}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {pr.commitCount > commits.length && (
        <p className="text-xs text-muted-foreground">
          Os {commits.length} mais recentes de {pr.commitCount};{' '}
          <a href={`${pr.url}/commits`} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
            o resto no GitHub
          </a>
          .
        </p>
      )}
    </div>
  )
}

function ChecksTab({ pr }: { pr: GithubPullDetail }) {
  if (!pr.checks.length) return <p className="text-sm text-muted-foreground">Nenhum check roda neste PR.</p>
  return (
    <ul className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      {pr.checks.map((c, i) => (
        <li key={`${c.name}-${i}`} className="border-b border-foreground/[0.06] last:border-0">
          <a href={c.url ?? undefined} target="_blank" rel="noreferrer" className="flex items-center gap-2.5 px-4 py-2.5 text-sm hover:bg-foreground/[0.03]">
            <span className="flex size-4 items-center justify-center">{CHECK[c.result]}</span>
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            {c.url && <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />}
          </a>
        </li>
      ))}
    </ul>
  )
}

const CHANGE: Record<string, [string, string]> = {
  ADDED: ['A', 'text-emerald-600 dark:text-emerald-400'],
  DELETED: ['D', 'text-red-600 dark:text-red-400'],
  RENAMED: ['R', 'text-sky-600 dark:text-sky-400'],
  COPIED: ['C', 'text-sky-600 dark:text-sky-400'],
}

function FilesTab({ pr }: { pr: GithubPullDetail }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          {pr.changedFiles} {pr.changedFiles === 1 ? 'arquivo alterado' : 'arquivos alterados'}
        </span>
        <Counts additions={pr.additions} deletions={pr.deletions} />
        <a href={`${pr.url}/files`} target="_blank" rel="noreferrer" className="ml-auto hover:text-foreground">
          Ver o diff no GitHub
        </a>
      </div>
      <ul className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {pr.files.map((f) => {
          const [letter, tone] = CHANGE[f.change] ?? ['M', 'text-amber-600 dark:text-amber-400']
          const slash = f.path.lastIndexOf('/')
          return (
            <li key={f.path} className="flex min-w-0 items-center gap-3 border-b border-foreground/[0.06] px-4 py-2 last:border-0">
              <span className={cn('w-3 shrink-0 text-center font-mono text-xs font-semibold', tone)}>{letter}</span>
              <span className={cn('min-w-0 flex-1 truncate font-mono text-xs', f.change === 'DELETED' && 'line-through')} title={f.path}>
                <span className="text-muted-foreground">{f.path.slice(0, slash + 1)}</span>
                {f.path.slice(slash + 1)}
              </span>
              <Counts additions={f.additions} deletions={f.deletions} />
            </li>
          )
        })}
        {pr.changedFiles > pr.files.length && (
          <li className="px-4 py-2 text-xs text-muted-foreground">Mais {pr.changedFiles - pr.files.length} no GitHub</li>
        )}
      </ul>
    </div>
  )
}

// ---- coluna da direita ----

function Side({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    // Ao lado da conversa, uma embaixo da outra com uma linha entre elas; em cima dela (coluna estreita), lado a lado, sem linha.
    <section className="border-b border-foreground/[0.06] pb-3 last:border-0 @max-4xl:border-0 @max-4xl:pb-0">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
        {action}
      </div>
      <div className="text-sm">{children}</div>
    </section>
  )
}

/** Quem revisou e como ficou a última revisão de cada um. */
function Reviewers({ pr }: { pr: GithubPullDetail }) {
  const last = new Map<string, GithubReview>()
  for (const r of pr.reviews) if (r.author && r.state !== 'PENDING') last.set(r.author, r)
  if (!last.size) return <p className="text-xs text-muted-foreground">Ninguém revisou ainda.</p>
  return (
    <ul className="space-y-1.5">
      {[...last.values()].map((r) => (
        <li key={r.author} className="flex items-center gap-2">
          <Avatar login={r.author} src={r.avatar} className="size-5" />
          <span className="min-w-0 flex-1 truncate">{r.author}</span>
          {r.state === 'APPROVED' ? (
            <Check className="size-4 text-emerald-500" aria-label="aprovou" />
          ) : r.state === 'CHANGES_REQUESTED' ? (
            <X className="size-4 text-red-500" aria-label="pediu mudanças" />
          ) : (
            <MessageSquare className="size-3.5 text-muted-foreground" aria-label="comentou" />
          )}
        </li>
      ))}
    </ul>
  )
}

function Assignees({ item, viewer }: { item: Item; viewer: string }) {
  const { busy, act } = useGithubAct()
  // O servidor de antes de reiniciar não manda os atribuídos do PR.
  const assignees = item.assignees ?? []
  const mine = assignees.includes(viewer)
  return assignees.length ? (
    <ul className="space-y-1.5">
      {assignees.map((a) => (
        <li key={a} className="flex items-center gap-2">
          <Avatar login={a} className="size-5 text-[10px]" />
          <span className="min-w-0 flex-1 truncate">{a}</span>
          {a === viewer && (
            <button type="button" disabled={busy !== null} onClick={() => void act({ type: 'assign', me: false })} className="text-xs text-muted-foreground hover:text-foreground">
              sair
            </button>
          )}
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-xs text-muted-foreground">
      Ninguém ainda.{' '}
      {viewer && !mine && (
        <button type="button" disabled={busy !== null} onClick={() => void act({ type: 'assign', me: true }, 'Atribuído a você')} className="underline hover:text-foreground">
          Atribuir a mim
        </button>
      )}
    </p>
  )
}

// ---- a tela ----

/**
 * Uma issue ou um PR aberto como aba, no desenho do GitHub: o título grande com o estado e, no PR, o que
 * entra onde; abas de conversa, commits, checks e arquivos; a conversa como linha do tempo (a
 * descrição, os commits, as revisões e os comentários, com a foto de cada um), fechando com a caixa de
 * merge e a de comentar; e, ao lado, revisões, responsáveis e etiquetas. Numa coluna estreita, o que
 * fica ao lado desce para cima da conversa. "Mandar para o chat" põe a referência no campo da conversa
 * do projeto, para pedir ao Claude que olhe.
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
  const [tab, setTab] = useState<Tab>('conversation')
  const name = `${kind === 'pr' ? 'PR' : 'Issue'} #${number}`
  const send = () => {
    if (!item) return
    if (!insertInChat(`${name}: ${item.title} (${item.url}) `))
      toast('Nenhuma conversa deste projeto com onde escrever agora', { description: 'Abra uma conversa nele no painel e tente de novo.' })
  }
  const viewer = result?.ok ? result.viewer : ''
  const me = result?.ok ? <Avatar login={viewer || null} src={result.viewerAvatar} /> : null

  return (
    <GithubTarget value={{ machine, cwd, kind, number }}>
      <div className="absolute inset-0 overflow-y-auto bg-background">
        <div className="@container mx-auto w-full max-w-6xl px-6 pt-5 pb-16 max-sm:px-4">
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {name}
              {result?.ok && ` · ${result.repo}`}
              {result && ` · ${relativeTime(result.fetchedAt)}`}
              {result?.ok && <QuotaNote quota={result.quota} />}
            </span>
            <Button variant="ghost" size="sm" onClick={send} disabled={!item}>
              <MessageSquarePlus /> <span className="max-sm:hidden">Mandar para o chat</span>
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
            {item && result?.ok && <ItemMenu item={item} viewer={viewer} />}
          </div>

          {error || (result && !result.ok) ? (
            <div className="mt-16 text-center">
              <h1 className="text-lg font-semibold">{title ?? name}</h1>
              <p className="mt-2 text-sm text-muted-foreground">{error ?? (result && !result.ok ? (result.message ?? GITHUB_REASON[result.reason]) : '')}</p>
            </div>
          ) : !item || !result?.ok ? (
            <div className="mt-16 flex flex-col items-center gap-3 text-center">
              {title && <h1 className="text-lg font-semibold">{title}</h1>}
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <h1 className="mt-4 text-2xl leading-snug font-semibold">
                {item.title} <span className="font-normal text-muted-foreground">#{item.number}</span>
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-muted-foreground">
                <StatePill item={item} />
                {item.kind === 'pr' ? (
                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                    <span className="font-medium text-foreground">{item.author ?? 'alguém'}</span>
                    {item.state === 'MERGED' ? 'juntou' : 'quer juntar'} {item.commitCount} {item.commitCount === 1 ? 'commit' : 'commits'} em
                    <BranchChip name={item.base} /> vindos de <BranchChip name={item.branch} copy />
                  </span>
                ) : (
                  <span>
                    <span className="font-medium text-foreground">{item.author ?? 'alguém'}</span> abriu {when(item.createdAt)} · {item.commentCount}{' '}
                    {item.commentCount === 1 ? 'comentário' : 'comentários'}
                  </span>
                )}
              </div>

              {item.kind === 'pr' && (
                <div className="mt-5 border-b border-foreground/[0.06] pb-2">
                  <Tabs pr={item} tab={tab} onChange={setTab} />
                </div>
              )}

              <div className={cn('mt-5 grid gap-x-8 gap-y-5 @4xl:grid-cols-[minmax(0,1fr)_15rem]')}>
                <aside className="space-y-3 @4xl:order-last @max-4xl:grid @max-4xl:grid-cols-3 @max-4xl:gap-4 @max-4xl:space-y-0 @max-md:grid-cols-1">
                  {item.kind === 'pr' && (
                    <Side title="Revisões">
                      <Reviewers pr={item} />
                    </Side>
                  )}
                  <Side title="Responsáveis">
                    <Assignees item={item} viewer={viewer} />
                  </Side>
                  <Side
                    title="Etiquetas"
                    action={<LabelsEditor labels={item.labels} repoLabels={result.repoLabels} trigger={<Settings2 className="size-3.5" />} />}
                  >
                    {item.labels.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        <Labels labels={item.labels} />
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Nenhuma.</p>
                    )}
                  </Side>
                </aside>

                <main className="min-w-0">
                  {item.kind === 'pr' && tab === 'commits' ? (
                    <CommitsTab pr={item} />
                  ) : item.kind === 'pr' && tab === 'checks' ? (
                    <ChecksTab pr={item} />
                  ) : item.kind === 'pr' && tab === 'files' ? (
                    <FilesTab pr={item} />
                  ) : (
                    // A linha do tempo: um fio atrás das fotos e dos ícones, do primeiro ao último.
                    <div className="relative space-y-4 before:absolute before:top-8 before:bottom-8 before:left-4 before:w-px before:bg-foreground/10">
                      <Post
                        author={item.author}
                        avatar={item.authorAvatar}
                        role={item.authorRole}
                        isAuthor
                        verb="abriu"
                        at={item.createdAt}
                        body={item.body}
                        href={item.url}
                      />
                      <Timeline item={item} />
                      {item.kind === 'pr' && <MergeBox pr={item} />}
                      <CommentBox kind={item.kind} avatar={me} />
                    </div>
                  )}
                </main>
              </div>
            </>
          )}
        </div>
      </div>
    </GithubTarget>
  )
}
