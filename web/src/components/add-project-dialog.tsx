import { ArrowUp, ChevronRight, Folder, FolderGit2, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from '@/lib/api'
import { projectName, shortPath } from '@/lib/format'
import type { FolderListing } from '@/lib/types'
import { cn } from '@/lib/utils'

type Mode = 'new' | 'existing'

const failed = (err: unknown) => toast.error(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err))

/** Pasta nova na primeira raiz de projetos, com o repositório git já começado (se quiser). */
function NewFolder({ machine, root, onDone }: { machine: string; root?: string; onDone: (path: string) => void }) {
  const [name, setName] = useState('')
  const [git, setGit] = useState(true)
  const [busy, setBusy] = useState(false)
  const clean = name.trim()

  const create = async () => {
    if (!clean) return
    setBusy(true)
    try {
      onDone((await api.createProject(machine, clean, git)).path)
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <form
        id="new-project"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <div className="space-y-1.5">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="meu-projeto" maxLength={100} autoFocus aria-label="Nome da pasta" />
          <p className="truncate text-xs text-muted-foreground">{root ? `${shortPath(root)}/${clean || '…'}` : 'Na pasta de projetos do PC'}</p>
        </div>
        <Label className="flex items-center justify-between gap-3 text-sm font-normal">
          Começar um repositório git
          <Switch checked={git} onCheckedChange={setGit} />
        </Label>
      </form>
      <DialogFooter>
        <Button type="submit" form="new-project" disabled={busy || !clean}>
          {busy && <Loader2 className="animate-spin" />} Criar
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * Pasta que já existe em qualquer lugar do PC: navega pelas pastas (ou digita o caminho) e adiciona a
 * aberta. Embaixo, as que você já adicionou, para tirar da lista.
 */
function ExistingFolder({ machine, added, onDone, onRemoved }: { machine: string; added: string[]; onDone: (path: string) => void; onRemoved: () => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  const open = (path?: string) => {
    api.folders(machine, path).then((l) => {
      setListing(l)
      setTyped(shortPath(l.path))
    }, failed)
  }

  useEffect(() => {
    let alive = true
    api.folders(machine).then((l) => {
      if (!alive) return
      setListing(l)
      setTyped(shortPath(l.path))
    }, failed)
    return () => {
      alive = false
    }
  }, [machine])

  const add = async () => {
    if (!listing) return
    setBusy(true)
    try {
      onDone((await api.addProject(machine, listing.path)).path)
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (path: string) => {
    try {
      await api.removeProject(machine, path)
      onRemoved()
    } catch (err) {
      failed(err)
    }
  }

  return (
    <>
      <div className="min-w-0 space-y-2">
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (typed.trim()) open(typed)
          }}
        >
          <Button type="button" variant="ghost" size="icon-sm" disabled={!listing?.parent} onClick={() => listing?.parent && open(listing.parent)} aria-label="Pasta de cima" title="Pasta de cima">
            <ArrowUp />
          </Button>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} className="h-8 font-mono text-xs" aria-label="Caminho da pasta" spellCheck={false} autoCapitalize="off" />
        </form>
        <div className="h-[min(50dvh,20rem)] overflow-y-auto rounded-lg border">
          {!listing ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : listing.folders.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">Sem subpastas aqui.</p>
          ) : (
            listing.folders.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => open(f.path)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-foreground/[0.04] active:bg-foreground/[0.07]"
              >
                {f.git ? <FolderGit2 className="size-4 shrink-0 text-sky-500" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            ))
          )}
        </div>
      </div>
      {added.length > 0 && (
        <div className="min-w-0 space-y-1">
          <h3 className="text-xs font-medium text-muted-foreground">Adicionadas por você</h3>
          {added.map((p) => (
            <div key={p} className="flex min-w-0 items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate" title={p}>
                {projectName(p)} <span className="text-xs text-muted-foreground">{shortPath(p)}</span>
              </span>
              <Button variant="ghost" size="icon-xs" onClick={() => void remove(p)} aria-label={`Tirar ${projectName(p)} da lista`} title="Tirar da lista (a pasta fica no PC)">
                <X />
              </Button>
            </div>
          ))}
        </div>
      )}
      <DialogFooter>
        <Button disabled={busy || !listing} onClick={() => void add()} className="min-w-0">
          {busy && <Loader2 className="animate-spin" />}
          <span className="truncate">Adicionar {listing ? projectName(listing.path) : 'pasta'}</span>
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * Adicionar um projeto à lista: uma pasta nova (na pasta de projetos do PC) ou uma que já existe em
 * qualquer lugar dele. `onChange` avisa que a lista mudou; `onAdded`, qual pasta entrou.
 */
export function AddProjectDialog({
  machine,
  open,
  onOpenChange,
  onChange,
  onAdded,
}: {
  machine: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: () => void
  onAdded: (path: string) => void
}) {
  const [mode, setMode] = useState<Mode>('new')
  const [sources, setSources] = useState<{ roots: string[]; added: string[] }>()

  // Servidor antigo, sem a rota: segue sem o caminho da pasta nova e sem a lista das adicionadas.
  const loadSources = () => void api.projectSources(machine).then(setSources, () => {})
  useEffect(() => {
    if (open) void api.projectSources(machine).then(setSources, () => {})
  }, [open, machine])

  const done = (path: string) => {
    onChange()
    onAdded(path)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0">
        <DialogHeader>
          <DialogTitle>Adicionar projeto</DialogTitle>
          <DialogDescription>Crie uma pasta nova ou escolha uma que já existe no PC.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-foreground/[0.06] p-1" role="tablist">
          {(
            [
              ['new', 'Pasta nova'],
              ['existing', 'Pasta existente'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {open &&
          (mode === 'new' ? (
            <NewFolder machine={machine} root={sources?.roots[0]} onDone={done} />
          ) : (
            <ExistingFolder
              machine={machine}
              added={sources?.added ?? []}
              onDone={done}
              onRemoved={() => {
                loadSources()
                onChange()
              }}
            />
          ))}
      </DialogContent>
    </Dialog>
  )
}
