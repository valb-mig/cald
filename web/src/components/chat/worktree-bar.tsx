import { ArrowDownToLine, GitBranch, Loader2, Trash2 } from 'lucide-react'
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
import { api, ApiError, errorMessage } from '@/lib/api'
import type { WorktreeStatus, WorktreeTag } from '@/lib/types'
import { cn } from '@/lib/utils'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * A faixa da conversa que roda num worktree (ver server/src/worktrees.ts): a branch dela, o que ela tem
 * que a de origem não tem, e as duas saídas. "Trazer" faz o merge na branch de origem, no checkout
 * principal, e o worktree segue para a conversa continuar; "Remover" apaga o worktree e a branch, e a
 * conversa fica só de leitura. `refresh` muda quando o git da conversa muda, e os números andam junto.
 */
export function WorktreeBar({ machine, cwd, tag, refresh }: { machine: string; cwd: string; tag: WorktreeTag; refresh: unknown }) {
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
  if (status === null) {
    return (
      <Strip>
        <GitBranch className="size-3.5 shrink-0" />
        <span className="truncate">Worktree {tag.name} removido: a conversa fica só para leitura.</span>
      </Strip>
    )
  }

  const base = status?.base ?? tag.base
  const lost = status ? status.ahead > 0 || status.changed > 0 : false
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
    <Strip>
      <GitBranch className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate" title={branch}>
        {/* No celular o cabeçalho já diz o worktree: a faixa estreita fica com os números. */}
        <span className="hidden font-medium text-foreground/80 wide:inline">{branch} · </span>
        {status && (
          <>
            {status.ahead > 0 ? `${plural(status.ahead, 'commit', 'commits')} para ${base}` : `em dia com ${base}`}
            {status.changed > 0 && <span className="text-amber-700 dark:text-amber-300"> · {plural(status.changed, 'arquivo', 'arquivos')} sem commit</span>}
            {status.behind > 0 && ` · ${base} andou ${status.behind}`}
            {status.current !== status.base && (
              <span className="text-amber-700 dark:text-amber-300"> · projeto em {status.current ?? 'HEAD solto'}</span>
            )}
          </>
        )}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          disabled={Boolean(blocked) || busy !== null}
          onClick={merge}
          title={blocked ?? `Merge de ${branch} em ${base}, no projeto`}
        >
          {busy === 'merge' ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowDownToLine className="size-3.5" />}
          Trazer
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          disabled={!status || busy !== null}
          onClick={() => setConfirm(true)}
          aria-label="Remover o worktree"
          title="Remover o worktree"
        >
          {busy === 'remove' ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        </Button>
      </span>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover o worktree {tag.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {lost && status
                ? `Ele tem ${[status.ahead && plural(status.ahead, 'commit que não voltou', 'commits que não voltaram') + ` para ${base}`, status.changed && plural(status.changed, 'arquivo sem commit', 'arquivos sem commit')].filter(Boolean).join(' e ')}. Removendo, isso se perde, sem volta.`
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
    </Strip>
  )
}

function Strip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mx-2 mb-1 flex min-h-8 items-center gap-1.5 rounded-lg border bg-muted/30 px-2.5 text-xs text-muted-foreground', className)}>
      {children}
    </div>
  )
}
