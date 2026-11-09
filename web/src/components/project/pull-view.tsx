import { ChevronRight, ExternalLink, GitBranch, Loader2, MessageSquarePlus, Pencil, RefreshCw, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { relativeTime } from '@/lib/format'
import { GITHUB_REASON, useGithubItem } from '@/lib/github'
import { insertInChat } from '@/lib/project-panel'
import type { GithubCommit, GithubComment, GithubPullDetail, GithubReview, GithubThread } from '@/lib/types'
import { cn } from '@/lib/utils'
import { CommentBox, GithubTarget, ItemMenu, LabelsEditor, mergeBlock, mergeWarning, PullActions, QuotaNote, useGithubAct } from './github-actions'
import { Assignees, Avatar, BranchChip, CHECK, DiffBar, Labels, REVIEW, Reviewers, StatePill, when } from './github-item'
import { PatchFiles, usePatches } from './patch-list'
import { ReviewFiles, type ReviewFocus } from './pull-review'

/**
 * Um PR como aba, no desenho do edit.r: no topo, o título (que dá para editar), o estado, de que branch
 * para qual e o tamanho; abas de visão geral, commits e arquivos, com os diffs ali mesmo; e, à direita,
 * o que se acompanha (o estado do merge com os botões, os checks, quem fez e quem revisou, as etiquetas)
 * e a conversa, com a caixa de comentar no pé. Numa coluna estreita, o lado desce para baixo.
 */

type Tab = 'overview' | 'commits' | 'files'

/** Uma ilha da coluna da direita: o título pequeno e o conteúdo, sem caixa em volta. */
function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {action}
      </div>
      <div className="text-sm">{children}</div>
    </section>
  )
}

/** O título grande; o lápis o troca por um campo (Enter salva, Esc desiste). */
function Title({ pr }: { pr: GithubPullDetail }) {
  const { busy, act } = useGithubAct()
  const [draft, setDraft] = useState<string | null>(null)
  const save = async () => {
    const title = draft?.trim()
    if (!title || title === pr.title) return setDraft(null)
    if (await act({ type: 'edit', title }, 'Título trocado')) setDraft(null)
  }
  if (draft !== null) {
    return (
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setDraft(null)}
          autoFocus
          aria-label="Título do PR"
          className="h-11 text-xl font-semibold md:text-xl"
        />
        <Button type="submit" disabled={busy === 'edit'}>
          {busy === 'edit' && <Loader2 className="animate-spin" />}
          Salvar
        </Button>
        <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
          Cancelar
        </Button>
      </form>
    )
  }
  return (
    <h1 className="group mt-3 text-2xl leading-snug font-semibold">
      {pr.title} <span className="font-normal text-muted-foreground">#{pr.number}</span>
      <button
        type="button"
        onClick={() => setDraft(pr.title)}
        aria-label="Editar o título"
        title="Editar o título"
        className="ml-2 inline-flex size-7 translate-y-[-2px] items-center justify-center rounded-full align-middle text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-foreground/5 hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <Pencil className="size-3.5" />
      </button>
    </h1>
  )
}

/** Escrever o Markdown ou ver como fica, com o "Salvar" no pé. Usado na descrição do PR e na de um PR novo. */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  autoFocus,
  readOnly,
  footer,
}: {
  value: string
  onChange: (text: string) => void
  placeholder: string
  autoFocus?: boolean
  /** Um agente escrevendo nela: o texto aparece, mas não dá para mexer até ele terminar. */
  readOnly?: boolean
  footer?: React.ReactNode
}) {
  const [preview, setPreview] = useState(false)
  const pill = (on: boolean) =>
    cn('rounded-full px-3 py-1 text-xs transition-colors', on ? 'bg-background font-medium text-foreground shadow-xs dark:bg-foreground/10' : 'text-muted-foreground hover:text-foreground')
  return (
    <div className="overflow-hidden rounded-2xl bg-foreground/[0.03] ring-1 ring-foreground/[0.06] focus-within:ring-foreground/15">
      <div className="flex items-center gap-1 px-2 pt-2">
        <div className="flex rounded-full bg-foreground/[0.05] p-0.5">
          <button type="button" className={pill(!preview)} onClick={() => setPreview(false)}>
            Escrever
          </button>
          <button type="button" className={pill(preview)} onClick={() => setPreview(true)}>
            Ver como fica
          </button>
        </div>
        <span className="ml-auto pr-2 text-[11px] text-muted-foreground">Markdown</span>
      </div>
      {preview ? (
        <div className="min-h-64 px-5 py-4">{value.trim() ? <Markdown text={value} /> : <p className="text-sm text-muted-foreground">Nada para ver ainda.</p>}</div>
      ) : (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          readOnly={readOnly}
          className="min-h-64 resize-y rounded-none border-0 bg-transparent px-5 py-4 text-sm leading-relaxed shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
        />
      )}
      {footer && <div className="flex items-center justify-end gap-2 px-3 pb-3">{footer}</div>}
    </div>
  )
}

/** A descrição do PR, já desenhada; "Editar" abre o editor ali mesmo. */
function Description({ pr }: { pr: GithubPullDetail }) {
  const { busy, act } = useGithubAct()
  const [draft, setDraft] = useState<string | null>(null)
  const save = async () => {
    if (draft === null) return
    if (draft === pr.body || (await act({ type: 'edit', body: draft }, 'Descrição salva'))) setDraft(null)
  }
  if (draft !== null) {
    return (
      <MarkdownEditor
        value={draft}
        onChange={setDraft}
        placeholder="O que muda, por quê e como testar"
        autoFocus
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Cancelar
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={busy === 'edit'}>
              {busy === 'edit' && <Loader2 className="animate-spin" />}
              Salvar descrição
            </Button>
          </>
        }
      />
    )
  }
  return (
    <div className="group relative rounded-2xl bg-foreground/[0.03] px-5 py-4">
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setDraft(pr.body)}
        className="absolute top-2.5 right-2.5 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <Pencil /> Editar
      </Button>
      {pr.body.trim() ? <Markdown text={pr.body} /> : <p className="text-sm text-muted-foreground italic">Sem descrição. Toque em Editar para escrever uma.</p>}
    </div>
  )
}

/** Um commit que abre a lista dos arquivos dele, com os diffs (buscados só ao abrir). */
function CommitItem({ c, machine, cwd }: { c: GithubCommit; machine: string; cwd: string }) {
  const [open, setOpen] = useState(false)
  const { files, error } = usePatches(machine, cwd, open ? { sha: c.sha } : null)
  return (
    <li className={cn('rounded-xl', open && 'bg-foreground/[0.03]')}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-foreground/[0.05]"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Avatar login={c.author} src={c.avatar} className="size-5 text-[10px]" />
        <span className="min-w-0 flex-1 truncate text-sm">{c.headline}</span>
        <span className="shrink-0 text-xs text-muted-foreground max-sm:hidden">{when(c.date)}</span>
        <a
          href={c.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 rounded-md bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          title="Abrir o commit no GitHub"
        >
          {c.short}
        </a>
      </button>
      {open && (
        <div className="px-2 pb-2 pl-7">
          <PatchFiles files={files} error={error} />
        </div>
      )}
    </li>
  )
}

function Commits({ pr, machine, cwd }: { pr: GithubPullDetail; machine: string; cwd: string }) {
  const commits = pr.commits ?? []
  if (!commits.length) return <p className="text-sm text-muted-foreground">Nenhum commit.</p>
  return (
    <>
      <ul className="space-y-0.5">
        {commits.map((c) => (
          <CommitItem key={c.sha} c={c} machine={machine} cwd={cwd} />
        ))}
      </ul>
      {pr.commitCount > commits.length && (
        <p className="mt-3 text-xs text-muted-foreground">
          Os {commits.length} mais recentes de {pr.commitCount}.{' '}
          <a href={`${pr.url}/commits`} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
            Ver todos no GitHub
          </a>
        </p>
      )}
    </>
  )
}

/** O estado do PR numa frase, com a cor dele: pronto, com aviso, em conflito, rascunho, mesclado ou fechado. */
function MergeState({ pr }: { pr: GithubPullDetail }) {
  const block = mergeBlock(pr)
  const warning = block ? null : mergeWarning(pr)
  const [text, tone] =
    pr.state === 'MERGED'
      ? [`Entrou na ${pr.base}.`, 'bg-violet-500']
      : pr.state === 'CLOSED'
        ? ['Fechado sem entrar.', 'bg-red-500']
        : block
          ? [block, pr.draft ? 'bg-muted-foreground' : 'bg-red-500']
          : warning
            ? [warning, 'bg-amber-500']
            : ['Pronto para entrar.', 'bg-emerald-500']
  const review =
    pr.review === 'APPROVED'
      ? 'Aprovado.'
      : pr.review === 'CHANGES_REQUESTED'
        ? 'Pediram mudanças.'
        : pr.review === 'REVIEW_REQUIRED'
          ? 'Esperando revisão.'
          : null
  return (
    <div className="space-y-3 rounded-2xl bg-foreground/[0.03] p-4">
      <p className="flex items-start gap-2 text-sm">
        <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', tone)} />
        <span>
          {text}
          {review && pr.state === 'OPEN' && <span className="text-muted-foreground"> {review}</span>}
        </span>
      </p>
      <PullActions pr={pr} />
    </div>
  )
}

type Talk = { at: string; comment?: GithubComment; review?: GithubReview; thread?: GithubThread }

/**
 * Comentários, revisões com texto (ou que aprovaram e pediram mudanças) e as conversas no código, na
 * ordem em que vieram. A do código mostra onde está e o primeiro comentário; tocar leva até ela, na aba
 * Arquivos. As suas ainda pendentes ficam de fora: só existem na revisão que você não enviou.
 */
function Conversation({ pr, onOpenThread }: { pr: GithubPullDetail; onOpenThread: (thread: GithubThread) => void }) {
  const talks: Talk[] = [
    ...pr.comments.map((c) => ({ at: c.createdAt, comment: c })),
    ...pr.reviews
      .filter((r) => r.submittedAt && (r.body.trim() || r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED'))
      .map((r) => ({ at: r.submittedAt!, review: r })),
    ...(pr.threads ?? []).flatMap((t) => {
      const first = t.comments.find((c) => !c.pending)
      return first ? [{ at: first.createdAt, thread: t }] : []
    }),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return (
    <div className="space-y-3">
      {talks.length === 0 && <p className="text-xs text-muted-foreground">Ninguém comentou ainda.</p>}
      {pr.commentCount > pr.comments.length && (
        <a href={pr.url} target="_blank" rel="noreferrer" className="block text-xs text-muted-foreground underline hover:text-foreground">
          Mais {pr.commentCount - pr.comments.length} antes, no GitHub
        </a>
      )}
      {talks.map((t) => {
        if (t.thread) return <ThreadTalk key={t.thread.id} thread={t.thread} onOpen={() => onOpenThread(t.thread!)} />
        const author = t.comment?.author ?? t.review?.author ?? null
        const avatar = t.comment?.avatar ?? t.review?.avatar
        const body = t.comment?.body ?? t.review?.body ?? ''
        const tone =
          t.review?.state === 'APPROVED' ? 'text-emerald-600 dark:text-emerald-400' : t.review?.state === 'CHANGES_REQUESTED' ? 'text-red-600 dark:text-red-400' : ''
        return (
          <article key={`${t.at}-${author}`} className="rounded-2xl bg-foreground/[0.03] px-3.5 py-3">
            <header className="mb-1.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <Avatar login={author} src={avatar} className="size-5 text-[10px]" />
              <span className="truncate font-medium text-foreground">{author ?? 'alguém'}</span>
              {t.review && <span className={cn('shrink-0', tone)}>{REVIEW[t.review.state]}</span>}
              <span className="ml-auto shrink-0">{when(t.at)}</span>
            </header>
            {body.trim() && (
              <div className="text-sm [&_.prose]:text-sm">
                <Markdown text={body} />
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}

/** Uma conversa no código, na lateral: onde está, o primeiro comentário e quantas respostas. */
function ThreadTalk({ thread, onOpen }: { thread: GithubThread; onOpen: () => void }) {
  const shown = thread.comments.filter((c) => !c.pending)
  const first = shown[0]!
  const place = thread.line ?? thread.originalLine
  const replies = shown.length - 1
  return (
    <article className={cn('rounded-2xl bg-foreground/[0.03] px-3.5 py-3', thread.resolved && 'opacity-70')}>
      <header className="mb-1.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Avatar login={first.author} src={first.avatar} className="size-5 text-[10px]" />
        <span className="truncate font-medium text-foreground">{first.author ?? 'alguém'}</span>
        <span className="shrink-0">no código</span>
        <span className="ml-auto shrink-0">{when(first.createdAt)}</span>
      </header>
      <button
        type="button"
        onClick={onOpen}
        title="Ver no diff"
        className="mb-1.5 block max-w-full truncate rounded-md bg-foreground/[0.05] px-1.5 py-0.5 text-left font-mono text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.09] hover:text-foreground"
      >
        {thread.path}
        {place != null && `:${place}`}
      </button>
      <div className="line-clamp-6 text-sm [&_.prose]:text-sm">
        <Markdown text={first.body} />
      </div>
      {(replies > 0 || thread.resolved || thread.outdated) && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {[replies > 0 && `${replies} ${replies === 1 ? 'resposta' : 'respostas'}`, thread.resolved && 'resolvida', thread.outdated && 'desatualizada']
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </article>
  )
}

export function PullView({ machine, cwd, number, title, active }: { machine: string; cwd: string; number: number; title?: string; active: boolean }) {
  const { item: result, loading, error, refresh } = useGithubItem(machine, cwd, 'pr', number, active)
  const pr = result?.ok && result.item.kind === 'pr' ? result.item : null
  const [tab, setTab] = useState<Tab>('overview')
  // Uma conversa tocada na lateral: a aba Arquivos abre no arquivo dela e rola até ela.
  const [focus, setFocus] = useState<ReviewFocus | null>(null)
  const openThread = (thread: GithubThread) => {
    setTab('files')
    setFocus({ path: thread.path, thread: thread.id, at: Date.now() })
  }
  const viewer = result?.ok ? result.viewer : ''
  const send = () => {
    if (!pr) return
    if (!insertInChat(`PR #${number}: ${pr.title} (${pr.url}) `))
      toast('Nenhuma conversa deste projeto com onde escrever agora', { description: 'Abra uma conversa nele no painel e tente de novo.' })
  }
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Visão geral' },
    { id: 'commits', label: 'Commits', count: pr?.commitCount },
    { id: 'files', label: 'Arquivos', count: pr?.changedFiles },
  ]

  return (
    <GithubTarget value={{ machine, cwd, kind: 'pr', number }}>
      {/* Contêiner de altura: a coluna da direita se limita a ele (`cqh`) quando acompanha a rolagem. */}
      <div className="absolute inset-0 overflow-y-auto bg-background [container-type:size]">
        <div className="@container mx-auto w-full max-w-6xl px-6 pt-5 pb-16 max-sm:px-4">
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              PR #{number}
              {result?.ok && ` · ${result.repo}`}
              {result && ` · ${relativeTime(result.fetchedAt)}`}
              {result?.ok && <QuotaNote quota={result.quota} />}
            </span>
            <Button variant="ghost" size="sm" onClick={send} disabled={!pr}>
              <MessageSquarePlus /> <span className="max-sm:hidden">Mandar para o chat</span>
            </Button>
            {pr && (
              <Button variant="ghost" size="icon-sm" asChild>
                <a href={pr.url} target="_blank" rel="noreferrer" aria-label="Abrir no GitHub" title="Abrir no GitHub">
                  <ExternalLink />
                </a>
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" onClick={refresh} disabled={loading} aria-label="Atualizar" title="Atualizar">
              <RefreshCw className={cn(loading && 'animate-spin')} />
            </Button>
            {pr && <ItemMenu item={pr} viewer={viewer} />}
          </div>

          {error || (result && !result.ok) ? (
            <div className="mt-16 text-center">
              <h1 className="text-lg font-semibold">{title ?? `PR #${number}`}</h1>
              <p className="mt-2 text-sm text-muted-foreground">{error ?? (result && !result.ok ? (result.message ?? GITHUB_REASON[result.reason]) : '')}</p>
            </div>
          ) : !pr || !result?.ok ? (
            <div className="mt-16 flex flex-col items-center gap-3 text-center">
              {title && <h1 className="text-lg font-semibold">{title}</h1>}
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <Title pr={pr} />
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
                <StatePill item={pr} />
                <span className="flex items-center gap-1.5">
                  <Avatar login={pr.author} src={pr.authorAvatar} className="size-5 text-[10px]" />
                  <span className="font-medium text-foreground">{pr.author ?? 'alguém'}</span>
                  <span>abriu {when(pr.createdAt)}</span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <GitBranch className="size-3.5 shrink-0" />
                  <BranchChip name={pr.branch} copy />
                  <span aria-label="para">→</span>
                  <BranchChip name={pr.base} />
                </span>
                <span className="flex items-center gap-2 font-mono text-xs tabular-nums">
                  <span className="text-emerald-600 dark:text-emerald-400">+{pr.additions.toLocaleString('pt-BR')}</span>
                  <span className="text-red-600 dark:text-red-400">−{pr.deletions.toLocaleString('pt-BR')}</span>
                  <DiffBar additions={pr.additions} deletions={pr.deletions} />
                </span>
              </div>

              <div className="mt-5 inline-flex rounded-full bg-foreground/[0.05] p-0.5" role="tablist">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition-colors',
                      tab === t.id ? 'bg-background font-medium text-foreground shadow-xs dark:bg-foreground/10' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t.label}
                    {t.count !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{t.count}</span>}
                  </button>
                ))}
              </div>

              {/* Lado a lado: o conteúdo à esquerda e, à direita, o que se acompanha com a conversa embaixo,
                  numa coluna que acompanha a rolagem (com rolagem própria, se passar da altura da tela; a
                  altura desconta o `top-5` e o `pb-16` da página, para ela caber inteira no fim da rolagem).
                  Numa coluna só, a coluna some (`contents`) e a ordem vira: o estado e o que se acompanha
                  em cima, o conteúdo no meio e a conversa no fim. */}
              <div className="mt-5 grid gap-x-8 gap-y-8 @4xl:grid-cols-[minmax(0,1fr)_21rem]">
                <div className="contents @4xl:sticky @4xl:top-5 @4xl:col-start-2 @4xl:row-start-1 @4xl:-mx-1 @4xl:block @4xl:max-h-[calc(100cqh-5.25rem)] @4xl:px-1 @4xl:pb-1 @4xl:space-y-8 @4xl:self-start @4xl:overflow-y-auto">
                  <aside className="order-1 min-w-0 space-y-6">
                    <MergeState pr={pr} />
                    {pr.checks.length > 0 && (
                      <Section title="Checks">
                        <ul className="space-y-1">
                          {pr.checks.map((c) => (
                            <li key={c.name} className="flex min-w-0 items-center gap-2">
                              <span className="flex w-4 shrink-0 justify-center">{CHECK[c.result]}</span>
                              {c.url ? (
                                <a href={c.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:underline">
                                  {c.name}
                                </a>
                              ) : (
                                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </Section>
                    )}
                    <Section title="Revisões">
                      <Reviewers pr={pr} />
                    </Section>
                    <Section title="Responsáveis">
                      <Assignees item={pr} viewer={viewer} />
                    </Section>
                    <Section title="Etiquetas" action={<LabelsEditor labels={pr.labels} repoLabels={result.repoLabels} trigger={<Settings2 className="size-3.5" />} />}>
                      {pr.labels.length ? (
                        <div className="flex flex-wrap gap-1.5">
                          <Labels labels={pr.labels} />
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">Nenhuma.</p>
                      )}
                    </Section>
                  </aside>

                  <div className="order-3 min-w-0">
                    <Section title={`Conversa${pr.commentCount ? ` · ${pr.commentCount}` : ''}`}>
                      <Conversation pr={pr} onOpenThread={openThread} />
                      <div className="mt-3">
                        <CommentBox kind="pr" />
                      </div>
                    </Section>
                  </div>
                </div>

                <main className="order-2 min-w-0 @4xl:col-start-1 @4xl:row-start-1">
                  {tab === 'commits' ? (
                    <Commits pr={pr} machine={machine} cwd={cwd} />
                  ) : tab === 'files' ? (
                    <ReviewFiles pr={pr} machine={machine} cwd={cwd} focus={focus} />
                  ) : (
                    <Description pr={pr} />
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
