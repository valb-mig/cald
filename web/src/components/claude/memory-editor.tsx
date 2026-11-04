import { useState } from 'react'
import { toast } from 'sonner'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage } from '@/lib/api'
import { saveMemory } from '@/lib/memory'
import type { Memory } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Edita a descrição e o texto de uma memória; o resto do cabeçalho (nome, tipo, a conversa de origem)
 * fica como o Claude gravou. Se o Claude mexer nela enquanto isto está aberto, o servidor recusa, e
 * nada do que ele escreveu se perde.
 */
export function MemoryEditor({ machine, folder, memory, onClose }: { machine: string; folder: string; memory: Memory; onClose: () => void }) {
  const [description, setDescription] = useState(memory.description)
  const [body, setBody] = useState(memory.body)
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (saving || !body.trim()) return
    setSaving(true)
    try {
      await saveMemory(machine, { folder, file: memory.file, description, body, mtime: memory.mtime })
      toast.success('Memória salva')
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const tab = (on: boolean) =>
    cn('rounded-md px-2.5 py-1 text-xs transition-colors', on ? 'bg-background font-medium text-foreground shadow-xs dark:bg-sidebar-accent' : 'text-muted-foreground hover:text-foreground')

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="gap-4 sm:max-w-2xl"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void save()
          }
        }}
      >
        <div className="min-w-0 pr-8">
          <DialogTitle className="truncate text-base">{memory.name}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{memory.file}</DialogDescription>
        </div>

        <label className="space-y-1.5">
          <span className="text-xs text-muted-foreground">Descrição (o que o Claude lê para decidir se a memória importa)</span>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} aria-label="Descrição" />
        </label>

        <div className="rounded-xl ring-1 ring-foreground/10">
          <div className="flex items-center gap-1 rounded-t-xl bg-foreground/[0.03] px-2 py-1.5">
            <button type="button" className={tab(!preview)} onClick={() => setPreview(false)}>
              Escrever
            </button>
            <button type="button" className={tab(preview)} onClick={() => setPreview(true)}>
              Ver como fica
            </button>
          </div>
          {preview ? (
            <div className="max-h-[50dvh] min-h-48 overflow-y-auto px-3 py-2">
              <Markdown text={body} className="text-sm" />
            </div>
          ) : (
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              aria-label="Texto da memória"
              className="max-h-[50dvh] min-h-48 resize-none rounded-t-none border-0 bg-transparent font-mono text-[13px] shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving || !body.trim()}>
            Salvar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
