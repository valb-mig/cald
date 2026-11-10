import { Check, GitBranch, Loader2, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from '@/lib/api'
import { reloadGit } from '@/lib/hooks'
import type { GitBranches } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * O chip da branch na casca da caixa, que abre a lista para trocar (ou criar uma) sem sair da conversa.
 * Os mesmos endpoints do controle de versão (ver project/source-control.tsx); o que não está commitado vai
 * junto, e o git recusa sozinho se conflitar (a mensagem dele sai no aviso). Com a conversa trabalhando, fica
 * travado: trocar a branch debaixo do agente bagunça o que ele está fazendo.
 */
export function BranchMenu({ machine, cwd, branch, working }: { machine: string; cwd?: string; branch: string; working: boolean }) {
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<GitBranches | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)

  const chip = (
    <>
      {busy ? <Loader2 className="size-3 shrink-0 animate-spin" /> : <GitBranch className="size-3 shrink-0" />}
      <span className="truncate">{branch}</span>
    </>
  )
  if (!cwd) return <span className="flex min-w-0 items-center gap-1 font-mono">{chip}</span>

  const load = () =>
    api.gitBranches(machine, cwd).then(
      (b) => {
        setBranches(b)
        setError(null)
      },
      (err) => setError(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err)),
    )

  const go = async (name: string, create: boolean) => {
    setOpen(false)
    setBusy(true)
    try {
      await (create ? api.gitBranch(machine, cwd, name) : api.gitSwitch(machine, cwd, name))
      toast.success(`Agora na branch ${name}`)
    } catch (err) {
      toast.error('O git não trocou', { description: errorMessage(err) })
    } finally {
      await reloadGit(machine, cwd)
      setBusy(false)
    }
  }

  const q = query.trim().toLowerCase()
  const local = branches?.local.filter((b) => b.name.toLowerCase().includes(q)) ?? []
  const remote = branches?.remote.filter((r) => r.branch.toLowerCase().includes(q)) ?? []
  const exists = !!branches && (branches.local.some((b) => b.name === query.trim()) || branches.remote.some((r) => r.branch === query.trim()))

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setQuery('')
          void load()
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={working || busy}
          title={working ? 'Espere o Claude terminar para trocar de branch' : 'Trocar de branch'}
          aria-label={`Branch ${branch}: trocar`}
          className="-my-1.5 flex min-w-0 items-center gap-1 py-1.5 font-mono transition-colors hover:text-foreground disabled:pointer-events-none"
        >
          {chip}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="flex max-h-[min(60vh,28rem)] w-72 flex-col p-0">
        <div className="border-b p-1.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // O menu leva as teclas para a busca por letra: aqui elas são do campo.
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && query.trim() && !exists) void go(query.trim(), true)
            }}
            placeholder="Buscar ou criar…"
            aria-label="Buscar ou criar branch"
            className="h-8 w-full rounded-md bg-foreground/[0.04] px-2 text-base outline-none placeholder:text-muted-foreground md:text-xs"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {query.trim() && !exists && (
            <DropdownMenuItem onSelect={() => void go(query.trim(), true)} className="min-h-11 gap-2 md:min-h-0">
              <Plus />
              <span className="min-w-0 truncate">
                Nova <span className="font-mono text-xs">{query.trim()}</span>
              </span>
            </DropdownMenuItem>
          )}
          {error && !branches ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{error}</p>
          ) : !branches ? (
            <div className="flex justify-center py-3">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {local.map((b) => (
                <DropdownMenuItem
                  key={b.name}
                  disabled={b.current || !!b.worktree}
                  onSelect={() => void go(b.name, false)}
                  title={b.worktree ? 'Aberta em outro worktree: o git não deixa usar a mesma branch em dois' : undefined}
                  className="min-h-11 gap-2 data-[disabled]:opacity-100 md:min-h-0"
                >
                  <Check className={cn('shrink-0', !b.current && 'invisible')} />
                  <span className={cn('min-w-0 flex-1 truncate font-mono text-xs', b.worktree && 'text-muted-foreground')}>{b.name}</span>
                  {b.worktree && <span className="shrink-0 text-[11px] text-muted-foreground">em uso</span>}
                </DropdownMenuItem>
              ))}
              {remote.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Só no origin</DropdownMenuLabel>
                  {remote.map((r) => (
                    <DropdownMenuItem key={r.name} onSelect={() => void go(r.branch, false)} className="min-h-11 gap-2 md:min-h-0" title={`Cria a ${r.branch} local, seguindo a ${r.name}`}>
                      <span className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{r.branch}</span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {!local.length && !remote.length && !query.trim() && <p className="px-2 py-1.5 text-xs text-muted-foreground">Nenhuma branch.</p>}
            </>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
