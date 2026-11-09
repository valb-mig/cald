import { CircleCheck, FilePenLine, Loader2, Pencil, Sparkles, Square, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api, errorMessage } from '@/lib/api'
import { actOnGithub } from '@/lib/github'
import type { AgentProviderInfo, GithubPatch, GithubPullDetail, GithubThread, GithubThreadComment, ModelOption, ReviewPartial, ReviewPlan, ReviewSide } from '@/lib/types'
import { cn } from '@/lib/utils'
import { DiffLines, PATCH_SCROLL, usePatchRows, type DiffRow } from './diff-lines'
import { ReviewDialog, useGithubAct } from './github-actions'
import { Avatar, when } from './github-item'
import { PatchFiles, usePatches, type PatchReview } from './patch-list'
import { AgentMenu } from './pull-composer'

/**
 * Revisar um PR a fundo, na aba Arquivos, como o "Files changed" do GitHub: tocar no número de uma linha
 * abre a caixa de comentar nela (com Shift, num trecho), e o comentário vai na hora ou entra na sua revisão
 * pendente, que sai depois inteira, com o veredito. As conversas de revisão aparecem embaixo das linhas
 * delas, com responder e resolver; as de código que mudou depois vão para o pé do arquivo. Cada arquivo se
 * marca como visto, e os vistos fecham.
 */

// ---- a revisão por um agente ----

/**
 * Uma revisão pedida a um agente, por PR, num store: trocar de aba (ou de PR) não perde o andamento. No fim,
 * os comentários dele vão de uma vez para a sua revisão pendente, nas linhas, e o resumo e o veredito
 * ficam aqui para preencher o "Enviar revisão". `posted`: quantos já estão na revisão pendente.
 */
type AgentRun = {
  status: 'running' | 'posting' | 'done' | 'error'
  agent: string
  partial: ReviewPartial | null
  plan: ReviewPlan | null
  posted: number
  error: string | null
  abort: AbortController | null
}

const useAgentRuns = create<Record<string, AgentRun>>(() => ({}))
const runKey = (machine: string, cwd: string, number: number) => `${machine}\n${cwd}\n${number}`

function patchRun(key: string, patch: Partial<AgentRun>) {
  useAgentRuns.setState((s) => (s[key] ? { [key]: { ...s[key], ...patch } } : {}))
}

function dropRun(key: string) {
  useAgentRuns.setState((s) => {
    const { [key]: _, ...rest } = s
    return rest
  }, true)
}

/** Põe os comentários do agente na sua revisão pendente (de novo, se da primeira vez o GitHub recusou). */
async function postRun(machine: string, cwd: string, number: number) {
  const key = runKey(machine, cwd, number)
  const plan = useAgentRuns.getState()[key]?.plan
  if (!plan?.comments.length) return patchRun(key, { status: 'done' })
  patchRun(key, { status: 'posting', error: null })
  try {
    await actOnGithub(machine, cwd, 'pr', number, { type: 'line-comments', comments: plan.comments })
    patchRun(key, { status: 'done', posted: plan.comments.length })
  } catch (err) {
    patchRun(key, { status: 'error', error: errorMessage(err) })
  }
}

async function startRun(machine: string, cwd: string, number: number, agent: AgentProviderInfo, model: ModelOption, effort: string | null) {
  const key = runKey(machine, cwd, number)
  useAgentRuns.getState()[key]?.abort?.abort()
  const abort = new AbortController()
  const name = `${agent.name}${model.value === 'default' ? '' : ` (${model.displayName})`}`
  useAgentRuns.setState({ [key]: { status: 'running', agent: name, partial: null, plan: null, posted: 0, error: null, abort } })
  try {
    const plan = await api.githubPlanReview(
      machine,
      cwd,
      number,
      { agent: agent.id, model: model.value === 'default' ? undefined : model.value, effort: effort ?? undefined },
      (partial) => patchRun(key, { partial }),
      abort.signal,
    )
    if (abort.signal.aborted) return
    patchRun(key, { plan, abort: null })
    await postRun(machine, cwd, number)
  } catch (err) {
    // Parou pelo botão: some sem aviso.
    if (abort.signal.aborted) return dropRun(key)
    patchRun(key, { status: 'error', error: errorMessage(err), abort: null })
  }
}

const VERDICT: Record<ReviewPlan['verdict'], { label: string; tone: string }> = {
  approve: { label: 'sugere aprovar', tone: 'text-emerald-700 dark:text-emerald-400' },
  comment: { label: 'sugere comentar', tone: 'text-muted-foreground' },
  'request-changes': { label: 'sugere pedir mudanças', tone: 'text-red-700 dark:text-red-400' },
}

/** O botão "Revisar com agente", com o mesmo seletor de agente, modelo e esforço do "Abrir PR". */
function AgentReviewButton({ machine, cwd, number }: { machine: string; cwd: string; number: number }) {
  const running = useAgentRuns((s) => {
    const status = s[runKey(machine, cwd, number)]?.status
    return status === 'running' || status === 'posting'
  })
  return (
    <AgentMenu
      machine={machine}
      disabled={running}
      onRun={(agent, model, effort) => void startRun(machine, cwd, number, agent, model, effort)}
      label="Revisar com agente"
      title="Um agente lê o diff e deixa os comentários nas linhas, na sua revisão pendente, no jeito das suas skills"
      heading="Revisar o PR com"
      verb="Revisar o PR com"
      storageKey="cr:review-agent"
      // Revisar pede mais que organizar: o Opus, com esforço médio, quando o agente tem.
      prefer={{ model: 'opus', effort: 'medium' }}
    />
  )
}

/** O andamento e o resultado da revisão do agente, no alto da aba Arquivos. */
function AgentReviewCard({ pr, machine, cwd }: { pr: GithubPullDetail; machine: string; cwd: string }) {
  const key = runKey(machine, cwd, pr.number)
  const run = useAgentRuns((s) => s[key])
  const [sending, setSending] = useState(false)
  if (!run) return null
  const working = run.status === 'running' || run.status === 'posting'
  const summary = run.plan?.summary ?? run.partial?.summary
  const verdict = run.plan && VERDICT[pr.mine ? 'comment' : run.plan.verdict]
  return (
    <div className="space-y-2.5 rounded-2xl bg-foreground/[0.04] px-4 py-3">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {working ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : <Sparkles className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate">
          {run.status === 'running'
            ? `${run.agent} está revisando…`
            : run.status === 'posting'
              ? `Pondo os comentários na sua revisão…`
              : `Revisão de ${run.agent}`}
          {verdict && <span className={cn('ml-1.5', verdict.tone)}>· {verdict.label}</span>}
          {run.status === 'running' && run.partial && run.partial.comments > 0 && (
            <span className="text-muted-foreground"> · {plural(run.partial.comments, 'comentário', 'comentários')} até agora</span>
          )}
        </span>
        {run.status === 'running' ? (
          <Button variant="ghost" size="sm" onClick={() => run.abort?.abort()}>
            <Square /> Parar
          </Button>
        ) : (
          !working && (
            <Button variant="ghost" size="sm" onClick={() => dropRun(key)}>
              Fechar
            </Button>
          )
        )}
      </div>
      {summary && (
        <div className="text-sm [&_.prose]:text-sm">
          <Markdown text={summary} />
        </div>
      )}
      {run.plan && !working && (
        <p className="text-xs text-muted-foreground">
          {run.posted > 0
            ? `${plural(run.posted, 'comentário foi', 'comentários foram')} para a sua revisão pendente, nas linhas: edite ou apague o que não quiser antes de enviar.`
            : run.plan.comments.length
              ? ''
              : 'Nenhum comentário nas linhas.'}
          {run.plan.dropped > 0 && ` ${plural(run.plan.dropped, 'comentário apontava', 'comentários apontavam')} para linhas fora do diff e ficou de fora.`}
        </p>
      )}
      {run.error && <p className="text-xs text-red-700 dark:text-red-400">{run.error}</p>}
      {run.plan && !working && (
        <div className="flex flex-wrap gap-1.5">
          {run.status === 'error' && run.plan.comments.length > 0 && run.posted === 0 && (
            <Button size="sm" variant="secondary" onClick={() => void postRun(machine, cwd, pr.number)}>
              Pôr os {plural(run.plan.comments.length, 'comentário', 'comentários')} na revisão
            </Button>
          )}
          {pr.state === 'OPEN' && (run.posted > 0 || run.plan.summary) && (
            <Button size="sm" onClick={() => setSending(true)}>
              Enviar revisão
            </Button>
          )}
        </div>
      )}
      {sending && run.plan && (
        <ReviewDialog key="agent" pr={pr} open={sending} onOpenChange={setSending} initial={{ event: run.plan.verdict, body: run.plan.summary }} />
      )}
    </div>
  )
}

/** Um pedido para levar a um arquivo (e a uma conversa dele), vindo da conversa da lateral. */
export type ReviewFocus = { path: string; thread?: string; at: number }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Onde a linha fica para o GitHub: a do arquivo novo (`RIGHT`) ou, numa linha que saiu, a do antigo. */
function anchorOf(r: DiffRow | undefined): { side: ReviewSide; line: number } | null {
  if (!r) return null
  if (r.kind === 'del') return { side: 'LEFT', line: r.old! }
  if (r.kind === 'add' || r.kind === 'ctx') return { side: 'RIGHT', line: r.new! }
  return null
}

/** A linha do diff de uma conversa; -1 se ela não está no trecho que o GitHub mandou. */
function rowOf(rows: DiffRow[], side: ReviewSide, line: number): number {
  return rows.findIndex((r) =>
    side === 'RIGHT' ? (r.kind === 'add' || r.kind === 'ctx') && r.new === line : (r.kind === 'del' || r.kind === 'ctx') && r.old === line,
  )
}

/** A aba Arquivos do PR, com a revisão. */
export function ReviewFiles({ pr, machine, cwd, focus }: { pr: GithubPullDetail; machine: string; cwd: string; focus: ReviewFocus | null }) {
  const { files, error } = usePatches(machine, cwd, { pr: pr.number })
  const { act } = useGithubAct()
  // O visto aparece na hora; se o GitHub recusar, volta.
  const [viewedNow, setViewedNow] = useState<Record<string, boolean>>({})
  const threads = useMemo(() => pr.threads ?? [], [pr.threads])
  const byFile = useMemo(() => {
    const out = new Map<string, GithubThread[]>()
    for (const t of threads) out.set(t.path, [...(out.get(t.path) ?? []), t])
    return out
  }, [threads])
  const viewedThere = useMemo(() => new Set(pr.files.filter((f) => f.viewed).map((f) => f.path)), [pr.files])
  const pending = Boolean(pr.pendingReview)

  // A conversa pedida, depois que o arquivo dela abre.
  useEffect(() => {
    if (!focus?.thread || !files) return
    const timer = setTimeout(() => document.querySelector(`[data-thread="${CSS.escape(focus.thread!)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300)
    return () => clearTimeout(timer)
  }, [focus?.at, focus?.thread, files])

  // Servidor de antes da revisão nas linhas (sem o id do PR): só os diffs.
  if (!pr.id) return <PatchFiles files={files} error={error} />

  const review: PatchReview = {
    viewed: (path) => viewedNow[path] ?? viewedThere.has(path),
    onViewed: (path, viewed) => {
      setViewedNow((v) => ({ ...v, [path]: viewed }))
      void act({ type: 'viewed', path, viewed }).then((ok) => {
        if (!ok)
          setViewedNow((v) => {
            const { [path]: _, ...rest } = v
            return rest
          })
      })
    },
    open: (path) => (byFile.get(path) ?? []).filter((t) => !t.resolved).length,
    diff: (file) => <ReviewDiff file={file} threads={byFile.get(file.path) ?? []} pending={pending} />,
  }
  // Conversas de arquivos que não estão na lista (o GitHub manda até 3.000 arquivos, e as conversas não têm limite de arquivo).
  const listed = new Set(files?.map((f) => f.path))
  const astray = files ? threads.filter((t) => !listed.has(t.path)) : []

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <AgentReviewButton machine={machine} cwd={cwd} number={pr.number} />
      </div>
      <AgentReviewCard pr={pr} machine={machine} cwd={cwd} />
      {pr.pendingReview && <PendingBar pr={pr} comments={pr.pendingReview.comments} />}
      <PatchFiles files={files} error={error} review={review} focus={focus} />
      {astray.length > 0 && (
        <div className="space-y-2">
          <p className="px-1 text-xs text-muted-foreground">Conversas em arquivos fora da lista</p>
          {astray.map((t) => (
            <ThreadCard key={t.id} thread={t} pending={pending} withHunk />
          ))}
        </div>
      )}
    </div>
  )
}

/** A sua revisão começada: quantos comentários pendentes, e enviar (com o veredito) ou descartar. */
function PendingBar({ pr, comments }: { pr: GithubPullDetail; comments: number }) {
  const { busy, act } = useGithubAct()
  const [sending, setSending] = useState(false)
  const [confirm, setConfirm] = useState(false)
  // O "descartar" pede um segundo toque, e esquece o primeiro depois de uns segundos.
  useEffect(() => {
    if (!confirm) return
    const timer = setTimeout(() => setConfirm(false), 4000)
    return () => clearTimeout(timer)
  }, [confirm])
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-foreground/[0.05] px-4 py-2.5">
      {/* Âmbar: espera você, como o resto do app. */}
      <span className="size-2 shrink-0 rounded-full bg-amber-500" />
      <p className="min-w-0 flex-1 text-sm">
        Revisão em andamento
        <span className="text-muted-foreground"> · {plural(comments, 'comentário pendente', 'comentários pendentes')}, que só você vê até enviar</span>
      </p>
      <div className="flex gap-1.5">
        <Button
          variant={confirm ? 'destructive' : 'ghost'}
          size="sm"
          disabled={busy !== null}
          onClick={() => {
            if (!confirm) return setConfirm(true)
            setConfirm(false)
            void act({ type: 'discard-review' }, 'Revisão descartada')
          }}
        >
          {busy === 'discard-review' && <Loader2 className="animate-spin" />}
          {confirm ? `Descartar ${plural(comments, 'comentário', 'comentários')}?` : 'Descartar'}
        </Button>
        <Button size="sm" onClick={() => setSending(true)}>
          Enviar revisão
        </Button>
      </div>
      {sending && <ReviewDialog key="review" pr={pr} open={sending} onOpenChange={setSending} />}
    </div>
  )
}

/** O diff de um arquivo com as conversas embaixo das linhas e a caixa de comentar. */
function ReviewDiff({ file, threads, pending }: { file: GithubPatch; threads: GithubThread[]; pending: boolean }) {
  if (!file.patch) {
    return (
      <>
        <p className="px-9 py-1 text-xs text-muted-foreground">Sem diff para mostrar aqui (binário ou grande demais). Veja no GitHub.</p>
        {threads.length > 0 && <LooseThreads threads={threads} pending={pending} />}
      </>
    )
  }
  return <PatchWithThreads patch={file.patch} path={file.path} threads={threads} pending={pending} />
}

function PatchWithThreads({ patch, path, threads, pending }: { patch: string; path: string; threads: GithubThread[]; pending: boolean }) {
  const { rows, oldTokens, newTokens } = usePatchRows(patch, path)
  // As linhas escolhidas para comentar, da primeira à última (índices em `rows`).
  const [pick, setPick] = useState<readonly [number, number] | null>(null)
  const { placed, loose } = useMemo(() => {
    const placed = new Map<number, GithubThread[]>()
    const loose: GithubThread[] = []
    for (const t of threads) {
      const at = t.line == null ? -1 : rowOf(rows, t.side, t.line)
      if (at < 0) loose.push(t)
      else placed.set(at, [...(placed.get(at) ?? []), t])
    }
    return { placed, loose }
  }, [rows, threads])

  const onPick = (row: number, extend: boolean) => {
    if (!anchorOf(rows[row])) return
    setPick((cur) => {
      if (extend && cur) {
        const start = Math.min(cur[0], row)
        const end = Math.max(cur[1], row)
        // Um comentário não atravessa de um trecho do diff para outro: aí recomeça na linha tocada.
        return rows.slice(start, end + 1).some((r) => r.kind === 'hunk') ? [row, row] : [start, end]
      }
      // Tocar de novo na mesma linha desiste.
      return cur && cur[0] === row && cur[1] === row ? null : [row, row]
    })
  }

  const below = (row: number) => {
    const here = placed.get(row)
    const composing = pick !== null && row === pick[1]
    if (!here && !composing) return null
    return (
      <div className="space-y-2 py-1">
        {here?.map((t) => <ThreadCard key={t.id} thread={t} pending={pending} />)}
        {composing && <LineComposer key={`${pick[0]}:${pick[1]}`} path={path} rows={rows} pick={pick} pending={pending} onClose={() => setPick(null)} />}
      </div>
    )
  }

  return (
    <>
      <div className={PATCH_SCROLL}>
        <DiffLines rows={rows} oldTokens={oldTokens} newTokens={newTokens} wrap={false} onPick={onPick} picked={pick} below={below} />
      </div>
      {loose.length > 0 && <LooseThreads threads={loose} pending={pending} />}
    </>
  )
}

/** As conversas que não apontam mais para o diff de agora (o código mudou depois), com o trecho de quando foram escritas. */
function LooseThreads({ threads, pending }: { threads: GithubThread[]; pending: boolean }) {
  return (
    <div className="space-y-2 px-2 pt-2">
      <p className="px-1 text-xs text-muted-foreground">{threads.length === 1 ? 'Uma conversa' : `${threads.length} conversas`} em código que mudou depois</p>
      {threads.map((t) => (
        <ThreadCard key={t.id} thread={t} pending={pending} withHunk />
      ))}
    </div>
  )
}

/**
 * A caixa de comentar nas linhas escolhidas. Sem revisão pendente, dá para comentar na hora ou começar
 * uma; com ela, o comentário entra nela (o GitHub não deixa as duas coisas ao mesmo tempo). "Sugerir
 * mudança" traz as linhas para um bloco `suggestion`, que quem abriu o PR aplica com um toque no GitHub.
 */
function LineComposer({ path, rows, pick, pending, onClose }: { path: string; rows: DiffRow[]; pick: readonly [number, number]; pending: boolean; onClose: () => void }) {
  const { busy, act } = useGithubAct()
  const [body, setBody] = useState('')
  const start = anchorOf(rows[pick[0]])!
  const end = anchorOf(rows[pick[1]])!
  const range = pick[0] !== pick[1]
  const chosen = rows.slice(pick[0], pick[1] + 1)
  // A sugestão troca as linhas do arquivo novo: só quando todas existem nele.
  const suggestible = chosen.every((r) => r.kind === 'add' || r.kind === 'ctx')
  const where = range ? `nas linhas ${start.line} a ${end.line}` : `na linha ${end.line}`

  const suggest = () => {
    const code = chosen.map((r) => (r.kind === 'add' || r.kind === 'ctx' ? r.text : '')).join('\n')
    setBody((b) => `${b}${b && !b.endsWith('\n') ? '\n' : ''}\`\`\`suggestion\n${code}\n\`\`\`\n`)
  }

  const send = async (now: boolean) => {
    if (!body.trim()) return
    const ok = await act(
      { type: 'line-comment', path, line: end.line, side: end.side, ...(range ? { startLine: start.line, startSide: start.side } : {}), body, now },
      now ? 'Comentário enviado' : pending ? 'Adicionado à revisão' : 'Revisão começada: o comentário fica pendente até você enviar',
    )
    if (ok) onClose()
  }

  return (
    <div className="max-w-3xl overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={`Comentar ${where}`}
        autoFocus
        aria-label={`Comentar ${where}`}
        className="min-h-20 rounded-none border-0 bg-transparent px-3.5 py-3 text-sm shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(false)
        }}
      />
      <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2">
        {suggestible && (
          <Button variant="ghost" size="sm" onClick={suggest} title="Propor o código novo: quem abriu o PR aplica com um toque no GitHub">
            <FilePenLine /> Sugerir mudança
          </Button>
        )}
        <span className="ml-auto max-sm:hidden text-[11px] text-muted-foreground">Ctrl+Enter: {pending ? 'adicionar' : 'começar revisão'}</span>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancelar
        </Button>
        {!pending && (
          <Button variant="secondary" size="sm" disabled={busy !== null || !body.trim()} onClick={() => void send(true)}>
            Comentar agora
          </Button>
        )}
        <Button size="sm" disabled={busy !== null || !body.trim()} onClick={() => void send(false)}>
          {busy && <Loader2 className="animate-spin" />}
          {pending ? 'Adicionar à revisão' : 'Começar revisão'}
        </Button>
      </div>
    </div>
  )
}

/** As últimas linhas do trecho do diff de quando a conversa foi escrita. */
function Hunk({ text }: { text: string }) {
  const lines = text.split('\n').filter((l) => !l.startsWith('@@')).slice(-5)
  return (
    <pre className="overflow-x-auto bg-foreground/[0.03] px-3.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
      {lines.map((l, i) => (
        <div key={i} className={cn(l.startsWith('+') && 'text-emerald-700 dark:text-emerald-400', l.startsWith('-') && 'text-red-700 dark:text-red-400')}>
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

/**
 * Uma conversa de revisão: os comentários, responder e resolver. A resolvida fica fechada numa linha, que
 * abre ao tocar. `withHunk`: fora do diff (código que mudou), com o trecho de quando foi escrita.
 */
function ThreadCard({ thread, pending, withHunk }: { thread: GithubThread; pending: boolean; withHunk?: boolean }) {
  const { busy, act } = useGithubAct()
  const [shown, setShown] = useState(!thread.resolved)
  const [reply, setReply] = useState<string | null>(null)
  const place = thread.line ?? thread.originalLine

  if (!shown) {
    return (
      <button
        type="button"
        data-thread={thread.id}
        onClick={() => setShown(true)}
        className="flex w-full max-w-3xl items-center gap-2 rounded-xl bg-foreground/[0.04] px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground"
      >
        <CircleCheck className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          Conversa resolvida{thread.resolvedBy && ` por ${thread.resolvedBy}`} · {plural(thread.comments.length, 'comentário', 'comentários')}
        </span>
        <span className="shrink-0">Mostrar</span>
      </button>
    )
  }

  const sendReply = async () => {
    if (!reply?.trim()) return
    if (await act({ type: 'reply', thread: thread.id, body: reply }, pending ? 'Resposta adicionada à revisão' : 'Resposta enviada')) setReply(null)
  }

  return (
    <div data-thread={thread.id} className="max-w-3xl overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      {withHunk && (
        <>
          <div className="truncate px-3.5 pt-2.5 pb-1.5 font-mono text-[11px] text-muted-foreground">
            {thread.path}
            {place != null && `:${place}`}
          </div>
          <Hunk text={thread.hunk} />
        </>
      )}
      {thread.outdated && !withHunk && <p className="px-3.5 pt-2.5 text-[11px] text-amber-700 dark:text-amber-400">Desatualizada: o código mudou depois desta conversa.</p>}
      <div className="space-y-1 pt-1">
        {thread.comments.map((c) => (
          <ThreadComment key={c.id} c={c} />
        ))}
      </div>
      <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-2.5">
        {reply === null ? (
          <>
            {thread.canReply && (
              <button
                type="button"
                onClick={() => setReply('')}
                className="h-8 min-w-0 flex-1 rounded-lg bg-foreground/[0.04] px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.07]"
              >
                Responder…
              </button>
            )}
            {thread.resolved ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => setShown(false)}>
                  Ocultar
                </Button>
                {thread.canUnresolve && (
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void act({ type: 'resolve', thread: thread.id, resolved: false }, 'Conversa reaberta')}>
                    {busy === 'resolve' && <Loader2 className="animate-spin" />}
                    Reabrir
                  </Button>
                )}
              </>
            ) : (
              thread.canResolve && (
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void act({ type: 'resolve', thread: thread.id, resolved: true }, 'Conversa resolvida')}>
                  {busy === 'resolve' ? <Loader2 className="animate-spin" /> : <CircleCheck />}
                  Resolver
                </Button>
              )
            )}
          </>
        ) : (
          <div className="w-full space-y-1.5">
            <Textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Responder"
              autoFocus
              className="min-h-16 text-sm md:text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setReply(null)
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void sendReply()
              }}
            />
            <div className="flex justify-end gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => setReply(null)}>
                Cancelar
              </Button>
              <Button size="sm" disabled={busy !== null || !reply.trim()} onClick={() => void sendReply()}>
                {busy === 'reply' && <Loader2 className="animate-spin" />}
                {pending ? 'Responder na revisão' : 'Responder'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Um comentário da conversa; o seu se edita e se apaga (apagar pede um segundo toque). */
function ThreadComment({ c }: { c: GithubThreadComment }) {
  const { busy, act } = useGithubAct()
  const [edit, setEdit] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    if (!confirm) return
    const timer = setTimeout(() => setConfirm(false), 4000)
    return () => clearTimeout(timer)
  }, [confirm])
  const save = async () => {
    if (!edit?.trim() || edit === c.body) return setEdit(null)
    if (await act({ type: 'edit-comment', comment: c.id, body: edit }, 'Comentário editado')) setEdit(null)
  }
  return (
    <div className="group px-3.5 py-2">
      <header className="mb-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Avatar login={c.author} src={c.avatar} className="size-5 text-[10px]" />
        <span className="truncate font-medium text-foreground">{c.author ?? 'alguém'}</span>
        {c.pending ? (
          <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">Pendente</span>
        ) : (
          <a href={c.url} target="_blank" rel="noreferrer" className="shrink-0 hover:underline">
            {when(c.createdAt)}
          </a>
        )}
        {(c.canEdit || c.canDelete) && edit === null && (
          <span className="ml-auto flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
            {c.canEdit && (
              <Button variant="ghost" size="icon-xs" aria-label="Editar" title="Editar" onClick={() => setEdit(c.body)}>
                <Pencil />
              </Button>
            )}
            {c.canDelete && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={confirm ? 'Apagar mesmo' : 'Apagar'}
                title={confirm ? 'Toque de novo para apagar' : 'Apagar'}
                disabled={busy !== null}
                className={cn(confirm && 'text-destructive')}
                onClick={() => {
                  if (!confirm) return setConfirm(true)
                  setConfirm(false)
                  void act({ type: 'delete-comment', comment: c.id }, 'Comentário apagado')
                }}
              >
                {busy === 'delete-comment' ? <Loader2 className="animate-spin" /> : <Trash2 />}
              </Button>
            )}
          </span>
        )}
      </header>
      {edit === null ? (
        <div className="text-sm [&_.prose]:text-sm">
          <Markdown text={c.body} />
        </div>
      ) : (
        <div className="space-y-1.5">
          <Textarea
            value={edit}
            onChange={(e) => setEdit(e.target.value)}
            autoFocus
            aria-label="Editar o comentário"
            className="min-h-16 text-sm md:text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEdit(null)
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save()
            }}
          />
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setEdit(null)}>
              Cancelar
            </Button>
            <Button size="sm" disabled={busy !== null || !edit.trim()} onClick={() => void save()}>
              {busy === 'edit-comment' && <Loader2 className="animate-spin" />}
              Salvar
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
