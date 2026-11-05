import { ArrowDown, ArrowDownToLine, ArrowUp, Check, FilePen, GitBranch, GitBranchMinus, Loader2, Trash2, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, ApiError, errorMessage } from '@/lib/api'
import type { WorktreeStatus, WorktreeTag } from '@/lib/types'
import { cn } from '@/lib/utils'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * O botão da conversa que roda num worktree (ver server/src/worktrees.ts), no cabeçalho dela: o selo diz
 * quantos commits esperam o "Trazer"; o menu, a branch, o que ela tem que a de origem não tem, e as duas
 * saídas. "Trazer" faz o merge na branch de origem, no checkout principal, e o worktree segue para a
 * conversa continuar; "Remover" apaga o worktree (e a branch, se tudo dela já voltou), e a conversa fica só
 * de leitura. `refresh` muda quando o git da conversa muda, e os números andam junto (e ao abrir o menu).
 */
export function WorktreeMenu({ machine, cwd, tag, refresh }: { machine: string; cwd: string; tag: WorktreeTag; refresh: unknown }) {
  // `undefined`: ainda não veio; `null`: o worktree já foi removido.
  const [status, setStatus] = useState<WorktreeStatus | null>()
  const [busy, setBusy] = useState<'merge' | 'remove' | null>(null)
  const [confirm, setConfirm] = useState(false)

  const load = useCallback(
    () =>
      api.worktree(machine, cwd).then(setStatus, (err) => {
        if (err instanceof ApiError && err.code === 'worktree_removed') setStatus(null)
      }),
    [machine, cwd],
  )
  useEffect(() => {
    void load()
  }, [load, refresh])

  async function merge() {
    setBusy('merge')
    try {
      const { commits } = await api.mergeWorktree(machine, cwd)
      toast.success(`${plural(commits, 'commit trazido', 'commits trazidos')} para ${status?.base}`)
    } catch (err) {
      toast.error(errorMessage(err), { duration: 10_000 })
    } finally {
      setBusy(null)
      void load()
    }
  }

  async function remove(force: boolean) {
    setBusy('remove')
    try {
      await api.removeWorktree(machine, cwd, force)
      toast.success('Worktree removido', { description: 'A conversa continua na lista, só para leitura.' })
      setStatus(null)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const branch = status?.branch ?? tag.branch ?? tag.name
  const base = status?.base ?? tag.base
  // Commit rebaseado (que a base já tem com outro hash) não conta: nada dele se perde.
  const lost = status ? status.unmerged > 0 || status.changed > 0 : false
  // O "Trazer" só vai com commits a levar, nada sem commit e o projeto na branch de origem.
  const blocked = !status
    ? 'Carregando…'
    : status.changed
      ? 'Faça o commit antes: o "Trazer" leva só commits.'
      : !status.ahead
        ? `Nada para trazer: ${base} já tem tudo.`
        : status.current !== status.base
          ? `O projeto está em ${status.current ?? 'nenhuma branch'}: volte para ${base} para trazer.`
          : null

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && void load()}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn('relative', status === null && 'text-muted-foreground')}
            aria-label={
              status === null
                ? `Worktree ${tag.name} removido`
                : `Worktree ${branch}${status?.ahead ? `: ${plural(status.ahead, 'commit', 'commits')} para trazer` : ''}`
            }
            title={status === null ? 'Worktree removido' : 'Worktree'}
          >
            {busy ? <Loader2 className="animate-spin" /> : status === null ? <GitBranchMinus /> : <GitBranch />}
            {/* Os commits que esperam o "Trazer": verde quando já dá para trazer, cinza quando algo impede. */}
            {status && status.ahead > 0 && (
              <span
                className={cn(
                  'absolute top-0.5 right-0 min-w-4 rounded-full px-1 text-center text-[9px] leading-4 font-semibold',
                  blocked ? 'bg-muted-foreground text-background' : 'bg-emerald-600 text-white',
                )}
              >
                {status.ahead > 99 ? '99+' : status.ahead}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {status === null ? (
            <div className="space-y-0.5 px-2 py-1.5">
              <div className="truncate text-sm font-medium">Worktree removido</div>
              <div className="text-xs text-muted-foreground">A conversa fica só para leitura.</div>
            </div>
          ) : (
            <>
              <div className="space-y-1 px-2 py-1.5 text-xs text-muted-foreground">
                <div className="truncate text-sm font-medium text-foreground" title={branch}>
                  {branch}
                </div>
                {!status ? (
                  <div>Carregando…</div>
                ) : (
                  <>
                    <Fact icon={status.ahead ? ArrowUp : Check}>
                      {status.ahead ? `${plural(status.ahead, 'commit', 'commits')} para ${base}` : `Em dia com ${base}`}
                    </Fact>
                    {status.changed > 0 && (
                      <Fact icon={FilePen} className="text-amber-700 dark:text-amber-300">
                        {plural(status.changed, 'arquivo', 'arquivos')} sem commit
                      </Fact>
                    )}
                    {status.behind > 0 && <Fact icon={ArrowDown}>{`${base} andou ${status.behind}`}</Fact>}
                    {status.current !== status.base && (
                      <Fact icon={TriangleAlert} className="text-amber-700 dark:text-amber-300">
                        Projeto em {status.current ?? 'HEAD solto'}
                      </Fact>
                    )}
                  </>
                )}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={Boolean(blocked) || busy !== null} onSelect={() => void merge()}>
                <ArrowDownToLine /> Trazer para {base ?? 'a origem'}
              </DropdownMenuItem>
              {/* Com commits a levar, por que ainda não dá: o item desligado sozinho não diz. */}
              {status && status.ahead > 0 && blocked && <p className="px-2 pb-1.5 text-xs text-muted-foreground">{blocked}</p>}
              <DropdownMenuItem variant="destructive" disabled={!status || busy !== null} onSelect={() => setConfirm(true)}>
                <Trash2 /> Remover o worktree
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover o worktree {tag.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {lost && status
                ? `Ele tem ${[status.unmerged && plural(status.unmerged, 'commit que não voltou', 'commits que não voltaram') + ` para ${base}`, status.changed && plural(status.changed, 'arquivo sem commit', 'arquivos sem commit')].filter(Boolean).join(' e ')}. ${status.unmerged ? `A branch ${status.branch} fica com os commits, para trazer depois${status.changed ? ', e o que está sem commit se perde, sem volta.' : '.'}` : 'O que está sem commit se perde, sem volta.'}`
                : `Apaga a pasta do worktree${tag.branch ? ` e a branch ${tag.branch}` : ''}. Tudo já está em ${base}.`}{' '}
              A conversa é fechada e fica na lista, só para leitura.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant={lost ? 'destructive' : 'default'} onClick={() => remove(lost)}>
              {lost ? 'Remover e perder' : 'Remover'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** Um fato do worktree no topo do menu: o ícone e uma frase curta. */
function Fact({ icon: Icon, className, children }: { icon: LucideIcon; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{children}</span>
    </div>
  )
}
