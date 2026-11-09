import { Check, ChevronRight, Loader2, MessageSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import type { GithubPatch } from '@/lib/types'
import { cn } from '@/lib/utils'
import { PatchDiff } from './diff-lines'
import { BADGES, splitPath, type Badge } from './status'

/**
 * Os arquivos de um PR ou de um commit com o diff de cada um, como o "Files changed" do GitHub, no
 * desenho do cald: uma linha por arquivo, com a letra da mudança, que abre o diff ali mesmo.
 */

// Um commit não muda: os diffs dele ficam aqui enquanto o app está aberto. Os do PR, o servidor guarda 2 min.
const cache = new Map<string, Promise<GithubPatch[]>>()

/** Os arquivos de `target` com os diffs; `null` não busca nada (a linha do commit ainda fechada). */
export function usePatches(machine: string, cwd: string, target: { pr: number } | { sha: string } | null) {
  const key = target && `${machine}\n${cwd}\n${'pr' in target ? `pr:${target.pr}` : target.sha}`
  const [state, setState] = useState<{ key: string; files: GithubPatch[] | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!key || !target) return
    let alive = true
    let request = cache.get(key)
    if (!request || 'pr' in target) {
      request = api.githubPatches(machine, cwd, target).then((r) => r.files)
      if ('sha' in target) cache.set(key, request)
      request.catch(() => cache.delete(key))
    }
    request.then(
      (files) => alive && setState({ key, files, error: null }),
      (err) => alive && setState({ key, files: null, error: errorMessage(err) }),
    )
    return () => {
      alive = false
    }
    // `target` muda de identidade a cada render; a chave diz o que ele é.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, machine, cwd])
  const current = state?.key === key ? state : null
  return { files: current?.files ?? null, error: current?.error ?? null }
}

/** Os que começam abertos: todos, com poucos arquivos, menos os já vistos. */
function initialOpen(files: GithubPatch[], review?: PatchReview): Set<string> {
  return new Set(files.length <= 8 ? files.filter((f) => !review?.viewed(f.path)).map((f) => f.path) : [])
}

const STATUS: Record<string, Badge> = {
  added: BADGES.A,
  removed: BADGES.D,
  modified: BADGES.M,
  changed: BADGES.M,
  renamed: BADGES.R,
  copied: BADGES.R,
}

// O fundo da letra, na cor dela, como na lista do controle de código-fonte.
export const CHIP: Record<string, string> = {
  U: 'bg-emerald-500/15',
  A: 'bg-emerald-500/15',
  M: 'bg-amber-500/15',
  D: 'bg-red-500/15',
  R: 'bg-sky-500/15',
  '!': 'bg-red-500/15',
}

/** A letra da mudança num quadradinho da cor dela. */
export function ChangeChip({ badge, className }: { badge: Badge; className?: string }) {
  return (
    <span
      title={badge.label}
      className={cn('flex size-[1.125rem] shrink-0 items-center justify-center rounded font-mono text-[11px] font-bold', badge.className, CHIP[badge.letter], className)}
    >
      {badge.letter}
    </span>
  )
}

/**
 * Para revisar um PR (ver pull-review.tsx): marcar arquivos como vistos, quantas conversas cada um tem e
 * o diff com elas e com o comentar nas linhas. Sem isto (os diffs de um commit), é só a lista.
 */
export type PatchReview = {
  viewed: (path: string) => boolean
  onViewed: (path: string, viewed: boolean) => void
  /** As conversas do arquivo ainda abertas (não resolvidas). */
  open: (path: string) => number
  diff: (file: GithubPatch) => React.ReactNode
}

/** Uma linha de arquivo que abre o diff dele embaixo. */
function PatchFile({ file, open, onToggle, review }: { file: GithubPatch; open: boolean; onToggle: () => void; review?: PatchReview }) {
  const { name, dir } = splitPath(file.path)
  const badge = STATUS[file.status] ?? BADGES.M
  const viewed = review?.viewed(file.path) ?? false
  const talks = review?.open(file.path) ?? 0
  return (
    <div data-file={file.path} className={cn('overflow-hidden rounded-xl', open && 'bg-foreground/[0.03]')}>
      <div className="flex min-w-0 items-center rounded-xl hover:bg-foreground/[0.05]">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[13px]"
          title={file.previous ? `${file.previous} → ${file.path}` : file.path}
        >
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <ChangeChip badge={badge} />
          <span className={cn('shrink-0 truncate', viewed && 'text-muted-foreground')}>{name}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{dir}</span>
          {talks > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums" title={`${talks} ${talks === 1 ? 'conversa aberta' : 'conversas abertas'}`}>
              <MessageSquare className="size-3" />
              {talks}
            </span>
          )}
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{' '}
            <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
          </span>
        </button>
        {review && (
          // Como o "Viewed" do GitHub: marcado, o arquivo fecha e sai do caminho.
          <button
            type="button"
            onClick={() => review.onViewed(file.path, !viewed)}
            aria-pressed={viewed}
            title={viewed ? 'Desmarcar: ainda não vi' : 'Marcar como visto'}
            className="mr-1 flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground aria-pressed:bg-foreground/[0.08] aria-pressed:text-foreground"
          >
            <span className={cn('flex size-3.5 items-center justify-center rounded-[4px] ring-1 ring-foreground/25', viewed && 'bg-foreground text-background ring-0')}>
              {viewed && <Check className="size-2.5" strokeWidth={3} />}
            </span>
            <span className="max-sm:hidden">Visto</span>
          </button>
        )}
      </div>
      {open && (
        <div className="pb-2">
          {review ? (
            review.diff(file)
          ) : file.patch ? (
            <PatchDiff patch={file.patch} path={file.path} />
          ) : (
            <p className="px-9 py-1 text-xs text-muted-foreground">Sem diff para mostrar aqui (binário ou grande demais). Veja no GitHub.</p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A lista de arquivos com os diffs. Com poucos arquivos, já vem aberta (menos os vistos); com muitos,
 * fechada, e o "abrir todos" está à mão. `focus`: um arquivo para abrir e trazer à vista (a conversa que
 * se tocou na lateral); `at` muda a cada pedido, para o mesmo arquivo poder ser pedido de novo.
 */
export function PatchFiles({
  files,
  error,
  review,
  focus,
}: {
  files: GithubPatch[] | null
  error: string | null
  review?: PatchReview
  focus?: { path: string; at: number } | null
}) {
  const [opened, setOpened] = useState<Set<string> | null>(null)
  // O arquivo pedido abre (o resto fica como estava) e vem para a vista; quem pediu rola até a conversa.
  useEffect(() => {
    if (!focus || !files?.some((f) => f.path === focus.path)) return
    setOpened((prev) => new Set([...(prev ?? initialOpen(files, review)), focus.path]))
    requestAnimationFrame(() => document.querySelector(`[data-file="${CSS.escape(focus.path)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
    // Só quando chega um pedido novo (ou os arquivos, se o pedido veio antes deles).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.at, files])
  if (error) return <p className="py-2 text-sm text-muted-foreground">{error}</p>
  if (!files) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (!files.length) return <p className="py-2 text-sm text-muted-foreground">Nenhum arquivo.</p>
  const open = opened ?? initialOpen(files, review)
  const all = open.size === files.length
  const toggle = (path: string) => {
    const next = new Set(open)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setOpened(next)
  }
  const seen = review ? files.filter((f) => review.viewed(f.path)).length : 0
  const reviewed = review && {
    ...review,
    // Marcar como visto fecha o arquivo; desmarcar deixa como está.
    onViewed: (path: string, viewed: boolean) => {
      review.onViewed(path, viewed)
      if (viewed && open.has(path)) toggle(path)
    },
  }
  return (
    <div className="space-y-0.5">
      {(files.length > 1 || review) && (
        <div className="flex items-center justify-end gap-3 pb-1">
          {review && (
            <span className="mr-auto flex items-center gap-2 px-2 text-xs text-muted-foreground tabular-nums">
              <span className="h-1 w-16 overflow-hidden rounded-full bg-foreground/10">
                <span className="block h-full rounded-full bg-foreground/50 transition-[width]" style={{ width: `${(seen / files.length) * 100}%` }} />
              </span>
              {seen} de {files.length} {files.length === 1 ? 'visto' : 'vistos'}
            </span>
          )}
          {files.length > 1 && (
            <button
              type="button"
              onClick={() => setOpened(new Set(all ? [] : files.map((f) => f.path)))}
              className="rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            >
              {all ? 'Fechar todos' : 'Abrir todos'}
            </button>
          )}
        </div>
      )}
      {files.map((f) => (
        <PatchFile key={f.path} file={f} open={open.has(f.path)} onToggle={() => toggle(f.path)} review={reviewed || undefined} />
      ))}
    </div>
  )
}
