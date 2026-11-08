import { CircleCheck, CircleDot, CircleSlash, Ellipsis, GitMerge, GitPullRequestDraft, Loader2, Tag, TriangleAlert, UserMinus, UserPlus, XCircle } from 'lucide-react'
import { createContext, use, useState } from 'react'
import { toast } from 'sonner'
import { Segmented } from '@/components/settings-ui'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@/components/markdown'
import { errorMessage } from '@/lib/api'
import { actOnGithub } from '@/lib/github'
import type { GithubAction, GithubIssueDetail, GithubLabel, GithubPullDetail, GithubQuota, MergeMethod } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * O que dá para fazer numa issue ou num PR sem sair do painel: comentar, pôr e tirar etiquetas,
 * fechar e reabrir, se atribuir e, no PR, revisar, dar merge e trocar entre rascunho e pronto. Tudo pelo
 * `gh` do PC, com o login dele, e só no clique: nada aqui consulta o GitHub por conta própria, e a
 * resposta de cada ação já traz o item como ficou (ver server/src/github.ts).
 */

type Target = { machine: string; cwd: string; kind: 'issue' | 'pr'; number: number }

const TargetContext = createContext<Target | null>(null)
export const GithubTarget = TargetContext.Provider

/** Faz a ação, avisa o que aconteceu e diz qual está em andamento, para o botão dela girar. */
export function useGithubAct() {
  const target = use(TargetContext)!
  const [busy, setBusy] = useState<GithubAction['type'] | null>(null)
  const act = async (action: GithubAction, done?: string): Promise<boolean> => {
    setBusy(action.type)
    try {
      await actOnGithub(target.machine, target.cwd, target.kind, target.number, action)
      if (done) toast.success(done)
      return true
    } catch (err) {
      toast.error(errorMessage(err))
      return false
    } finally {
      setBusy(null)
    }
  }
  return { busy, act }
}

// ---- etiquetas ----

/**
 * Pôr e tirar etiquetas, com as do repositório. As marcadas e desmarcadas vão juntas num pedido só,
 * quando o menu fecha: ir e voltar numa etiqueta não gasta nada da cota.
 */
export function LabelsEditor({
  labels,
  repoLabels,
  trigger,
}: {
  labels: GithubLabel[]
  repoLabels: GithubLabel[]
  /** O que aparece no botão; sem isso, o ícone e "Etiquetas". */
  trigger?: React.ReactNode
}) {
  const { busy, act } = useGithubAct()
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const current = new Set(labels.map((l) => l.name))
  const shown = picked ?? current

  const close = () => {
    if (!picked) return
    const add = [...picked].filter((n) => !current.has(n))
    const remove = [...current].filter((n) => !picked.has(n))
    setPicked(null)
    if (add.length || remove.length) void act({ type: 'labels', add, remove })
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) setPicked(new Set(current))
        else close()
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy === 'labels'}
          aria-label="Editar as etiquetas"
          title="Editar as etiquetas"
          className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          {busy === 'labels' ? <Loader2 className="size-3 animate-spin" /> : (trigger ?? <Tag className="size-3" />)}
          {!trigger && (labels.length ? 'Etiquetas' : 'Pôr etiqueta')}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel>Etiquetas do repositório</DropdownMenuLabel>
        {repoLabels.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">O repositório não tem etiquetas.</p>}
        {repoLabels.map((l) => (
          <DropdownMenuCheckboxItem
            key={l.name}
            checked={shown.has(l.name)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) =>
              setPicked((p) => {
                const next = new Set(p ?? current)
                if (on) next.add(l.name)
                else next.delete(l.name)
                return next
              })
            }
          >
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: `#${l.color}` }} />
            <span className="truncate">{l.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---- menu do item ----

/** Fechar e reabrir, se atribuir e, no PR, rascunho e pronto: o que não precisa de mais nada que um clique. */
export function ItemMenu({ item, viewer }: { item: GithubIssueDetail | GithubPullDetail; viewer: string }) {
  const { busy, act } = useGithubAct()
  const open = item.state === 'OPEN'
  const pr = item.kind === 'pr'
  const assigned = item.assignees.includes(viewer)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Mais ações" title="Mais ações" disabled={busy !== null}>
          {busy ? <Loader2 className="animate-spin" /> : <Ellipsis />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {item.state !== 'MERGED' &&
          (open ? (
            pr ? (
              <DropdownMenuItem onSelect={() => void act({ type: 'state', open: false }, `PR #${item.number} fechado`)}>
                <XCircle /> Fechar o PR
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onSelect={() => void act({ type: 'state', open: false, reason: 'completed' }, `Issue #${item.number} concluída`)}>
                  <CircleCheck /> Fechar como concluída
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void act({ type: 'state', open: false, reason: 'not planned' }, `Issue #${item.number} fechada`)}>
                  <CircleSlash /> Fechar sem fazer
                </DropdownMenuItem>
              </>
            )
          ) : (
            <DropdownMenuItem onSelect={() => void act({ type: 'state', open: true }, `${pr ? 'PR' : 'Issue'} #${item.number} reaberto`)}>
              <CircleDot /> Reabrir
            </DropdownMenuItem>
          ))}
        {pr && open && (
          <DropdownMenuItem onSelect={() => void act({ type: 'draft', draft: !item.draft }, item.draft ? 'Pronto para revisão' : 'Voltou para rascunho')}>
            <GitPullRequestDraft /> {item.draft ? 'Marcar como pronto para revisão' : 'Voltar para rascunho'}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void act({ type: 'assign', me: !assigned }, assigned ? 'Tirado de você' : 'Atribuído a você')}>
          {assigned ? <UserMinus /> : <UserPlus />} {assigned ? 'Tirar de mim' : 'Atribuir a mim'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---- revisão e merge ----

const MERGE_LABEL: Record<MergeMethod, { label: string; hint: string; verb: string }> = {
  merge: { label: 'Merge', hint: 'Junta tudo com um commit de merge, guardando os commits do PR.', verb: 'Dar merge' },
  squash: { label: 'Squash', hint: 'Junta os commits do PR num commit só.', verb: 'Fazer squash' },
  rebase: { label: 'Rebase', hint: 'Reaplica os commits do PR em cima da base, sem commit de merge.', verb: 'Fazer rebase' },
}

/** O que segura o merge, dito pelo GitHub; o resto (`CLEAN`, `HAS_HOOKS`, `UNSTABLE`) deixa passar. */
export function mergeBlock(pr: GithubPullDetail): string | null {
  if (pr.state !== 'OPEN') return pr.state === 'MERGED' ? 'Já entrou.' : 'O PR está fechado.'
  if (pr.draft) return 'É rascunho: marque como pronto para revisão antes.'
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') return `Tem conflito com ${pr.base}: resolva antes.`
  return null
}

export function mergeWarning(pr: GithubPullDetail): string | null {
  if (pr.mergeState === 'BLOCKED') return 'O GitHub diz que falta algo que o repositório exige (revisão ou check). Pode recusar.'
  if (pr.mergeState === 'BEHIND') return `A branch está atrás de ${pr.base}, e o repositório pode exigir que ela esteja em dia.`
  if (pr.checks.some((c) => c.result === 'failure')) return 'Há checks falhando.'
  if (pr.checks.some((c) => c.result === 'pending')) return 'Há checks ainda rodando.'
  return null
}

/**
 * Revisar o PR, como o "Review changes" do GitHub: aprovar, comentar ou pedir mudanças, com um texto.
 * O próprio PR só aceita comentário: o GitHub não deixa aprovar nem pedir mudanças no que você abriu.
 */
function ReviewDialog({ pr, open, onOpenChange }: { pr: GithubPullDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { busy, act } = useGithubAct()
  const [event, setEvent] = useState<'approve' | 'comment' | 'request-changes'>(pr.mine ? 'comment' : 'approve')
  const [body, setBody] = useState('')
  const needsBody = event !== 'approve'
  const own = 'O GitHub não deixa fazer isso no PR que você abriu'
  const submit = async () => {
    const ok = await act(
      { type: 'review', event, body: body.trim() || undefined },
      event === 'approve' ? `PR #${pr.number} aprovado` : event === 'request-changes' ? 'Mudanças pedidas' : 'Revisão enviada',
    )
    if (ok) {
      setBody('')
      onOpenChange(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revisar o PR #{pr.number}</DialogTitle>
          <DialogDescription className="truncate">{pr.title}</DialogDescription>
        </DialogHeader>
        <Segmented
          value={event}
          onChange={setEvent}
          options={[
            { key: 'approve', label: 'Aprovar', disabled: pr.mine, title: pr.mine ? own : undefined },
            { key: 'comment', label: 'Comentar' },
            { key: 'request-changes', label: 'Pedir mudanças', disabled: pr.mine, title: pr.mine ? own : undefined },
          ]}
        />
        {pr.mine && <p className="-mt-2 text-xs text-muted-foreground">Este PR é seu: o GitHub só deixa comentar.</p>}
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={event === 'approve' ? 'Um comentário, se quiser' : event === 'request-changes' ? 'O que precisa mudar' : 'O comentário da revisão'}
          className="min-h-24"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (!needsBody || body.trim())) void submit()
          }}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={busy !== null || (needsBody && !body.trim())}>
            {busy && <Loader2 className="animate-spin" />}
            {event === 'approve' ? 'Aprovar' : event === 'request-changes' ? 'Pedir mudanças' : 'Comentar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Dar merge, com confirmação: mexe na base e não se desfaz daqui. Escolhe o jeito (só os que o
 * repositório aceita) e se apaga a branch no GitHub depois (a do PC fica como está).
 */
function MergeDialog({ pr, open, onOpenChange }: { pr: GithubPullDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { busy, act } = useGithubAct()
  const [method, setMethod] = useState<MergeMethod>(pr.defaultMethod)
  // Branch de PR que já entrou não serve para mais nada: apagar é o normal, e dá para restaurar no GitHub.
  const [deleteBranch, setDeleteBranch] = useState(!pr.crossRepo)
  const warning = mergeWarning(pr)
  const submit = async () => {
    const ok = await act({ type: 'merge', method, deleteBranch }, `PR #${pr.number} entrou em ${pr.base}`)
    if (ok) onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Dar merge no PR #{pr.number}?</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{pr.branch}</span> entra em <span className="font-mono">{pr.base}</span>, no GitHub.
          </DialogDescription>
        </DialogHeader>
        {pr.mergeMethods.length > 1 && (
          <Segmented value={method} onChange={setMethod} options={pr.mergeMethods.map((m) => ({ key: m, label: MERGE_LABEL[m].label }))} />
        )}
        <p className="-mt-2 text-xs text-muted-foreground">{MERGE_LABEL[method].hint}</p>
        <label className={cn('flex items-center gap-2 text-sm', pr.crossRepo && 'opacity-50')}>
          <Checkbox checked={deleteBranch} disabled={pr.crossRepo} onCheckedChange={(on) => setDeleteBranch(on === true)} />
          <span>
            Apagar a branch <span className="font-mono text-xs">{pr.branch}</span> no GitHub
            {pr.crossRepo && <span className="text-muted-foreground"> (é de um fork)</span>}
          </span>
        </label>
        {warning && (
          <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            {warning}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={busy !== null}>
            {busy ? <Loader2 className="animate-spin" /> : <GitMerge />}
            {MERGE_LABEL[method].verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Os botões do PR, no pé do quadro do que falta para ele entrar: revisar e dar merge. */
export function PullActions({ pr }: { pr: GithubPullDetail }) {
  const [review, setReview] = useState(false)
  const [merge, setMerge] = useState(false)
  if (pr.state !== 'OPEN') return null
  const block = mergeBlock(pr)
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setMerge(true)} disabled={block !== null} title={block ?? undefined}>
          <GitMerge /> Dar merge
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setReview(true)}>
          Revisar
        </Button>
      </div>
      {/* A chave recomeça o diálogo a cada vez, com o jeito e o texto do zero. */}
      {review && <ReviewDialog key="review" pr={pr} open={review} onOpenChange={setReview} />}
      {merge && <MergeDialog key="merge" pr={pr} open={merge} onOpenChange={setMerge} />}
    </>
  )
}

// ---- comentar ----

/**
 * Responder ali mesmo, no pé da conversa, como no GitHub: escrever ou ver como fica (o Markdown já
 * desenhado), com a sua foto ao lado. Ctrl+Enter envia.
 */
export function CommentBox({ kind, avatar }: { kind: 'issue' | 'pr'; avatar?: React.ReactNode }) {
  const { busy, act } = useGithubAct()
  const [body, setBody] = useState('')
  const [preview, setPreview] = useState(false)
  const submit = async () => {
    if (!body.trim()) return
    if (await act({ type: 'comment', body }, 'Comentário enviado')) {
      setBody('')
      setPreview(false)
    }
  }
  const tab = (on: boolean) =>
    cn('rounded-md px-2.5 py-1 text-xs transition-colors', on ? 'bg-background font-medium text-foreground shadow-xs dark:bg-sidebar-accent' : 'text-muted-foreground hover:text-foreground')
  return (
    // Sem `avatar` (na coluna estreita da direita), sem a coluna da foto.
    <div className={cn('grid gap-3', avatar !== undefined && 'grid-cols-[2rem_minmax(0,1fr)]')}>
      {avatar !== undefined && <div className="pt-0.5">{avatar}</div>}
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <div className="flex items-center gap-1 bg-foreground/[0.03] px-2 py-1.5">
          <button type="button" className={tab(!preview)} onClick={() => setPreview(false)}>
            Escrever
          </button>
          <button type="button" className={tab(preview)} onClick={() => setPreview(true)}>
            Ver como fica
          </button>
          <span className="ml-auto pr-1 text-[11px] text-muted-foreground">Markdown</span>
        </div>
        {preview ? (
          <div className="min-h-28 px-4 py-3">
            {body.trim() ? <Markdown text={body} /> : <p className="text-sm text-muted-foreground">Nada para ver ainda.</p>}
          </div>
        ) : (
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`Comentar ${kind === 'pr' ? 'no PR' : 'na issue'}`}
            className="min-h-28 rounded-none border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit()
            }}
          />
        )}
        <div className="flex items-center justify-end gap-2 px-2 pb-2">
          <span className="text-[11px] text-muted-foreground">Ctrl+Enter envia</span>
          <Button size="sm" onClick={() => void submit()} disabled={busy !== null || !body.trim()}>
            {busy && <Loader2 className="animate-spin" />}
            Comentar
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---- cota ----

const thousands = new Intl.NumberFormat('pt-BR')

/** Quanto sobra da cota do GitHub da conta, para ver de olho; fica âmbar quando passa de 80% usada. */
export function QuotaNote({ quota }: { quota: GithubQuota | null | undefined }) {
  if (!quota) return null
  const low = quota.remaining < quota.limit * 0.2
  const reset = new Date(quota.resetAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return (
    <span
      className={cn(low && 'text-amber-700 dark:text-amber-400')}
      title={`Cota da API do GitHub da sua conta: ${thousands.format(quota.remaining)} de ${thousands.format(quota.limit)} pontos nesta hora, renova às ${reset}. Ver um PR ou uma issue gasta 1.`}
    >
      {' '}
      · cota {thousands.format(quota.remaining)}/{thousands.format(quota.limit)}
    </span>
  )
}
