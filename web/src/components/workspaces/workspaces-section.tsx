import { Loader2, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useLocation } from 'wouter'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from '@/lib/api'
import { useWide } from '@/lib/hooks'
import { HOME } from '@/lib/machines'
import { useStore } from '@/lib/store'
import type { Workspace } from '@/lib/types'
import { openWorkspace } from '@/lib/workbench'
import { loadWorkspaces, putWorkspace, useWorkspaces, WORKSPACE_COLORS, workspaceColor } from '@/lib/workspaces'

const failed = (err: unknown) => toast.error(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err))

/** No PC, o workspace abre numa aba; no celular, na tela dele. */
function useOpenWorkspace(machine: string) {
  const wide = useWide()
  const [, navigate] = useLocation()
  return (id: string) => (wide ? openWorkspace(machine, id) : navigate(`/w/${id}${machine === HOME ? '' : `?maquina=${encodeURIComponent(machine)}`}`))
}

function NewWorkspaceDialog({ machine, open, onOpenChange, onCreated }: { machine: string; open: boolean; onOpenChange: (o: boolean) => void; onCreated: (ws: Workspace) => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const count = useWorkspaces((s) => s.byMachine[machine]?.length ?? 0)
  const create = async () => {
    setBusy(true)
    try {
      const ws = await api.saveWorkspace(machine, { name: name.trim(), color: count % WORKSPACE_COLORS.length, projects: [], instructions: '', rules: [], commands: [] })
      putWorkspace(machine, ws)
      setName('')
      onOpenChange(false)
      onCreated(ws)
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Novo workspace</DialogTitle>
          <DialogDescription>Junte projetos, contexto, regras, comandos e um time: toda conversa aberta nele já começa com isso.</DialogDescription>
        </DialogHeader>
        <form
          id="new-workspace"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) void create()
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Ex.: Cliente X, Blog, Estudos" autoFocus aria-label="Nome do workspace" />
        </form>
        <DialogFooter>
          <Button type="submit" form="new-workspace" disabled={busy || !name.trim()}>
            {busy && <Loader2 className="animate-spin" />} Criar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Os workspaces no alto de Projetos: um cartão por workspace, com a cor, os projetos e quantas conversas
 * ele tem, e o botão de criar um.
 */
export function WorkspacesSection({ machine }: { machine: string }) {
  const list = useWorkspaces((s) => s.byMachine[machine])
  const catalog = useStore((s) => s.catalog)
  const [creating, setCreating] = useState(false)
  const open = useOpenWorkspace(machine)
  useEffect(() => {
    // Servidor antigo, sem workspaces: a seção só oferece criar (e o PC avisa ao tentar).
    loadWorkspaces(machine).catch(() => {})
  }, [machine])
  const count = (id: string) => catalog.filter((c) => c.workspace?.id === id && (c.machine ?? HOME) === machine).length

  return (
    <section className="mb-4">
      <div className="flex items-center px-5 pb-1.5">
        <h2 className="flex-1 text-xs font-medium text-muted-foreground">Workspaces</h2>
        <Button variant="ghost" size="xs" onClick={() => setCreating(true)} className="-mr-2 text-muted-foreground">
          <Plus /> Novo
        </Button>
      </div>
      {list && list.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 px-4">
          {list.map((ws) => {
            const n = count(ws.id)
            return (
              <button
                key={ws.id}
                type="button"
                onClick={() => open(ws.id)}
                className="min-w-0 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.04] active:bg-foreground/[0.07]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: workspaceColor(ws.color) }} />
                  <span className="truncate text-sm font-medium">{ws.name}</span>
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {ws.projects.length} {ws.projects.length === 1 ? 'projeto' : 'projetos'} · {n} {n === 1 ? 'conversa' : 'conversas'}
                </div>
              </button>
            )
          })}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mx-4 block w-[calc(100%-2rem)] rounded-xl border border-dashed px-3 py-3 text-left text-xs text-muted-foreground hover:bg-foreground/[0.03]"
        >
          Crie um workspace para juntar projetos, contexto, regras e um time de agentes, como uma gem.
        </button>
      )}
      <NewWorkspaceDialog machine={machine} open={creating} onOpenChange={setCreating} onCreated={(ws) => open(ws.id)} />
    </section>
  )
}
