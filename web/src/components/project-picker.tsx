import { FolderGit2, House } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { MachineChips } from '@/components/machine-filter'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { api, errorMessage } from '@/lib/api'
import { projectName, relativeTime, shortPath } from '@/lib/format'
import { HOME, useMachineFilter } from '@/lib/machines'
import { useStore } from '@/lib/store'

/**
 * Escolha de onde a conversa nova roda: sem projeto (pasta pessoal) ou um projeto, por uso recente.
 * Com várias máquinas, primeiro a máquina (começa na do filtro do topo ou na `machine` pedida).
 */
export function ProjectPicker({
  open,
  onOpenChange,
  onPick,
  machine: initial,
  only,
  exclude,
  title = 'Nova conversa',
  description = 'Onde o Claude vai trabalhar?',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** `undefined` = sem projeto. */
  onPick: (cwd: string | undefined, machine: string) => void
  machine?: string
  /** Só estes projetos (os de um workspace), sem "Sem projeto" nem a troca de máquina. */
  only?: string[]
  /** Estes ficam de fora, e também "Sem projeto" (ao escolher um projeto para o workspace). */
  exclude?: string[]
  title?: string
  description?: string
}) {
  const catalog = useStore((s) => s.catalog)
  const filter = useMachineFilter()
  const [machine, setMachine] = useState(initial ?? filter ?? HOME)
  // Projetos de cada máquina, buscados quando ela é escolhida.
  const [byMachine, setByMachine] = useState<Record<string, string[]>>({})
  const projects = only ?? byMachine[machine] ?? null
  const homeless = Boolean(only || exclude)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open || projects || only) return
    api.projects(machine).then(
      (list) => setByMachine((all) => ({ ...all, [machine]: list })),
      (err) => toast.error(errorMessage(err)),
    )
  }, [open, projects, machine, only])

  const list = useMemo(() => {
    const last = new Map<string, number>()
    for (const c of catalog) {
      if (c.cwd && (c.machine ?? HOME) === machine) last.set(c.cwd, Math.max(last.get(c.cwd) ?? 0, c.lastModified))
    }
    const q = query.trim().toLowerCase()
    return (projects ?? [])
      .filter((p) => (!q || p.toLowerCase().includes(q)) && !exclude?.includes(p))
      .map((p) => ({ path: p, last: last.get(p) }))
      .sort((a, b) => (b.last ?? 0) - (a.last ?? 0) || a.path.localeCompare(b.path))
  }, [projects, query, catalog, machine, exclude])

  const pick = (cwd: string | undefined) => {
    onOpenChange(false)
    onPick(cwd, machine)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="gap-0 p-0 data-[side=bottom]:h-[85dvh] lg:mx-auto lg:max-w-2xl lg:rounded-t-xl lg:border-x">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {!homeless && <MachineChips value={machine} onChange={(m) => m !== null && setMachine(m)} className="px-4 pb-2" />}
        <div className="px-4 pb-2">
          <Input type="search" placeholder="Buscar projeto" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="min-h-0 flex-1 divide-y overflow-y-auto pb-[env(safe-area-inset-bottom)]">
          {!query.trim() && !homeless && (
            <button type="button" onClick={() => pick(undefined)} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-muted">
              <House className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-sm font-medium">Sem projeto</div>
                <div className="text-xs text-muted-foreground">Pasta pessoal (~)</div>
              </div>
            </button>
          )}
          {projects === null
            ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="mx-4 my-3 h-9" />)
            : list.map(({ path, last }) => (
                <button key={path} type="button" onClick={() => pick(path)} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-muted">
                  <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{projectName(path)}</div>
                    <div className="truncate text-xs text-muted-foreground">{last ? `última conversa ${relativeTime(last)}` : shortPath(path)}</div>
                  </div>
                </button>
              ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
