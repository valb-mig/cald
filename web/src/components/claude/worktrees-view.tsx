import { ArrowDownToLine, GitBranch, Loader2, MessageSquarePlus, RefreshCw, SquareTerminal, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { navigate } from 'wouter/use-browser-location'
import { Claudinho } from '@/components/claudinho'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { api, errorMessage } from '@/lib/api'
import { saveBottomPanel, useBottomPanel } from '@/lib/bottom-panel'
import { placeName, shortPath } from '@/lib/format'
import { useWide } from '@/lib/hooks'
import { newChatUrl } from '@/lib/machines'
import { useStore } from '@/lib/store'
import { newTerminal } from '@/lib/terminals'
import type { CatalogEntry, ListedWorktree } from '@/lib/types'
import { Tag } from './bits'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** O que se perde apagando: mudanças sem commit e commits que a base não tem (nem rebaseados). */
const atRisk = (w: ListedWorktree) => w.changed > 0 || w.unmerged > 0

/**
 * Os worktrees de todos os projetos da máquina, na seção Worktrees do painel Computador, agrupados por
 * repositório: os das conversas (do cald e do `claude --worktree`) e os criados à mão em qualquer
 * pasta. Cada um diz a branch, o que tem sem commit e o que a base ainda não tem, e quais conversas
 * estão nele. Dá para trazer o trabalho (o mesmo "Trazer" da faixa do worktree no chat), abrir uma
 * conversa nova ou um terminal nele e apagá-lo. `onLeave`: o painel fecha ao ir para outra tela.
 */
export function WorktreesView({ machine, onLeave }: { machine: string; onLeave: () => void }) {
  // `undefined`: carregando a primeira vez.
  const [groups, setGroups] = useState<{ root: string; worktrees: ListedWorktree[] }[]>()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const catalog = useStore((s) => s.catalog)

  const load = useCallback(() => {
    setLoading(true)
    api.worktrees(machine).then(
      (g) => {
        setGroups(g)
        setError(null)
        setLoading(false)
      },
      (err) => {
        setError(errorMessage(err))
        setLoading(false)
      },
    )
  }, [machine])
  useEffect(load, [load])

  if (groups === undefined) {
    return error ? <p className="px-1 py-2 text-sm text-red-600 dark:text-red-400">{error}</p> : <Loader2 className="mx-auto my-6 size-4 animate-spin text-muted-foreground" />
  }
  const inside = (w: ListedWorktree) => catalog.filter((c) => c.cwd && (c.cwd === w.path || c.cwd.startsWith(`${w.path}/`)))
  const total = groups.reduce((n, g) => n + g.worktrees.length, 0)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1">
          {total ? `${plural(total, 'worktree', 'worktrees')} em ${plural(groups.length, 'projeto', 'projetos')}` : 'Nenhum projeto tem worktree, só o checkout principal.'}
        </span>
        <Button variant="ghost" size="xs" onClick={load} disabled={loading}>
          <RefreshCw className={loading ? 'animate-spin' : undefined} /> Atualizar
        </Button>
      </div>
      {error && <p className="px-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {groups.map((g) => (
        <section key={g.root} className="space-y-0.5">
          <h3 className="flex min-w-0 items-baseline gap-1.5 px-1 pb-0.5 text-xs font-medium" title={g.root}>
            {placeName(g.root)}
            <span className="truncate font-normal text-muted-foreground">{shortPath(g.root)}</span>
          </h3>
          {g.worktrees.map((w) => (
            <WorktreeRow key={w.path} worktree={w} sessions={inside(w)} machine={machine} cwd={g.root} onChanged={load} onLeave={onLeave} />
          ))}
        </section>
      ))}
      {total > 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          Apagar tira a pasta e, quando tudo dela já está na base, a branch também. Com trabalho que não voltou, pede confirmação antes.
        </p>
      )}
    </div>
  )
}

function WorktreeRow({
  worktree: w,
  sessions,
  machine,
  cwd,
  onChanged,
  onLeave,
}: {
  worktree: ListedWorktree
  sessions: CatalogEntry[]
  machine: string
  /** O checkout principal do repositório (o projeto, para o servidor achar o worktree na lista dele). */
  cwd: string
  onChanged: () => void
  onLeave: () => void
}) {
  const wide = useWide()
  const [busy, setBusy] = useState<'merge' | 'remove' | null>(null)
  const [confirm, setConfirm] = useState(false)
  const base = w.base ?? 'a base'

  async function merge() {
    setBusy('merge')
    try {
      const { commits } = await api.mergeListedWorktree(machine, cwd, w.path)
      toast.success(`${plural(commits, 'commit trazido', 'commits trazidos')} para ${base}`)
    } catch (err) {
      toast.error(errorMessage(err), { duration: 10_000 })
    } finally {
      setBusy(null)
      onChanged()
    }
  }

  async function remove() {
    setBusy('remove')
    try {
      await api.removeListedWorktree(machine, cwd, w.path, atRisk(w))
      toast.success(`Worktree ${w.name} apagado`)
      onChanged()
    } catch (err) {
      toast.error(errorMessage(err), { duration: 10_000 })
    } finally {
      setBusy(null)
    }
  }

  function terminal() {
    onLeave()
    newTerminal({ machine, cwd: w.path })
    useBottomPanel.setState({ open: true, tab: 'terminal' })
    saveBottomPanel()
  }

  return (
    <div className="group rounded-xl px-2.5 py-2 transition-colors hover:bg-foreground/[0.04]">
      <div className="flex min-w-0 items-start gap-2">
        <GitBranch className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate font-mono text-[12.5px]" title={w.path}>
              {w.name}
            </span>
            {w.branch && w.branch !== w.name && <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{w.branch}</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {w.missing ? (
              <Tag tone="bad" title="A pasta foi apagada à mão: sobra só o registro no git">
                pasta apagada
              </Tag>
            ) : (
              <>
                {!w.branch && <Tag tone="warn">sem branch</Tag>}
                {w.changed > 0 && <Tag tone="warn">{plural(w.changed, 'arquivo sem commit', 'arquivos sem commit')}</Tag>}
                {w.unmerged > 0 && (
                  <Tag tone="warn" title={`Commits que ${base} ainda não tem`}>
                    {plural(w.unmerged, 'commit para trazer', 'commits para trazer')}
                  </Tag>
                )}
                {!atRisk(w) && w.branch && (
                  <Tag tone="ok" title={w.ahead > 0 ? 'Os commits dele já estão na base, com outro hash (rebaseados)' : undefined}>
                    tudo já em {base}
                  </Tag>
                )}
                {w.behind > 0 && <Tag>{plural(w.behind, 'commit atrás', 'commits atrás')}</Tag>}
              </>
            )}
            {!w.managed && (
              <Tag title={w.path}>{w.usable ? 'criado à mão' : `fora dos projetos · ${shortPath(w.path)}`}</Tag>
            )}
          </div>
          {sessions.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {sessions.map((s) => (
                <button
                  key={s.sessionId}
                  type="button"
                  onClick={() => {
                    onLeave()
                    navigate(`/s/${s.sessionId}`)
                  }}
                  title="Abrir a conversa"
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-foreground/[0.06] py-0.5 pr-2 pl-0.5 text-xs hover:bg-foreground/10"
                >
                  <Claudinho seed={s.sessionId} state={s.state} size={16} />
                  <span className="truncate">{s.title || 'Conversa'}</span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-0.5">
            {w.unmerged > 0 && (
              <Button variant="ghost" size="xs" onClick={() => void merge()} disabled={busy !== null || w.changed > 0} title={w.changed > 0 ? 'Faça o commit antes: o Trazer leva só commits' : `Merge em ${base}, no checkout principal`}>
                {busy === 'merge' ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />} Trazer
              </Button>
            )}
            {w.usable && (
              <Button variant="ghost" size="xs" onClick={() => {
                  onLeave()
                  navigate(newChatUrl(w.path, machine))
                }} title="Conversa nova dentro deste worktree">
                <MessageSquarePlus /> Conversa
              </Button>
            )}
            {w.usable && wide && (
              <Button variant="ghost" size="xs" onClick={terminal} title="Terminal na pasta deste worktree">
                <SquareTerminal /> Terminal
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => (w.missing || !atRisk(w) ? void remove() : setConfirm(true))}
              disabled={busy !== null}
              className="text-muted-foreground hover:text-destructive"
            >
              {busy === 'remove' ? <Loader2 className="animate-spin" /> : <Trash2 />} Apagar
            </Button>
          </div>
        </div>
      </div>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar o worktree {w.name} mesmo assim?</AlertDialogTitle>
            <AlertDialogDescription>
              {[
                `Ele tem trabalho que não voltou para ${base}: ${[w.unmerged > 0 && plural(w.unmerged, 'commit', 'commits'), w.changed > 0 && plural(w.changed, 'arquivo sem commit', 'arquivos sem commit')].filter(Boolean).join(' e ')}.`,
                w.unmerged > 0 && `A branch ${w.branch} fica com os commits, para trazer depois.`,
                w.changed > 0 && 'O que está sem commit se perde, sem volta.',
                sessions.length > 0 && 'As conversas do painel nele são fechadas e ficam na lista, só para leitura.',
              ]
                .filter(Boolean)
                .join(' ')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              Apagar mesmo assim
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
