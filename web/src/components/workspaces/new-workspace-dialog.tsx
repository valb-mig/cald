import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { projectName } from '@/lib/format'
import type { Workspace } from '@/lib/types'
import { createProjectWorkspace, workspaceFailed } from '@/lib/workspaces'

/** Mais um workspace para o projeto, com o nome que você quiser (já vem o do projeto). */
export function NewWorkspaceDialog({
  machine,
  project,
  open,
  onOpenChange,
  onCreated,
}: {
  machine: string
  project: string
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated: (ws: Workspace) => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  // Ao abrir, o nome começa no do projeto.
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setName(projectName(project))
  }
  const create = async () => {
    setBusy(true)
    try {
      const ws = await createProjectWorkspace(machine, project, name.trim())
      onOpenChange(false)
      onCreated(ws)
    } catch (err) {
      workspaceFailed(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Novo workspace</DialogTitle>
          <DialogDescription>Contexto, regras, comandos e um time para as conversas de {projectName(project)}.</DialogDescription>
        </DialogHeader>
        <form
          id="new-workspace"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) void create()
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Ex.: Revisão, Estudos" autoFocus aria-label="Nome do workspace" />
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
