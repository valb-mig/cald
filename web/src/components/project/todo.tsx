import { Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import type { PanelProject } from '@/lib/project-panel'
import { newTodoId, saveTodos, useTodoError, useTodos } from '@/lib/todos'
import type { Todo } from '@/lib/types'
import { cn } from '@/lib/utils'

function TodoRow({ item, onToggle, onRemove }: { item: Todo; onToggle: () => void; onRemove: () => void }) {
  return (
    <div className="group flex min-w-0 items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors hover:bg-foreground/[0.04]">
      <Checkbox checked={item.done} onCheckedChange={onToggle} aria-label={item.done ? 'Marcar como não feito' : 'Marcar como feito'} className="mt-0.5" />
      <span
        className={cn(
          'min-w-0 flex-1 text-[13px] leading-snug break-words whitespace-pre-wrap',
          item.done && 'text-muted-foreground line-through decoration-muted-foreground/50',
        )}
      >
        {item.text}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onRemove}
        aria-label="Apagar"
        title="Apagar"
        className="-my-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <X />
      </Button>
    </div>
  )
}

/**
 * O TODO do projeto: uma lista simples do próprio Claude Remote, guardada no PC (ver lib/todos.ts).
 * Escrever e Enter adiciona no fim dos que faltam; os feitos descem e saem de uma vez pelo "Limpar".
 */
export function TodoTab({ project }: { project: PanelProject }) {
  const items = useTodos(project.machine, project.cwd)
  const error = useTodoError(project.machine, project.cwd)
  const [text, setText] = useState('')
  const save = (next: Todo[]) => saveTodos(project.machine, project.cwd, next)
  const pending = items?.filter((t) => !t.done) ?? []
  const done = items?.filter((t) => t.done) ?? []

  const add = () => {
    const value = text.trim()
    if (!value || !items) return
    save([...pending, { id: newTodoId(), text: value, done: false, createdAt: Date.now() }, ...done])
    setText('')
  }
  const toggle = (id: string) => items && save(items.map((t) => (t.id === id ? { ...t, done: !t.done } : t)))
  const remove = (id: string) => items && save(items.filter((t) => t.id !== id))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="shrink-0 px-2 pt-1 pb-2"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Adicionar e Enter"
          maxLength={1000}
          disabled={!items}
          aria-label="Novo item do TODO"
          className="h-9 rounded-xl border-transparent bg-background/70 px-3 dark:bg-background/50"
        />
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {error && !items ? (
          <p className="p-4 text-center text-sm text-muted-foreground">{error}</p>
        ) : !items ? (
          <div className="flex justify-center p-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">Nada por fazer neste projeto.</p>
        ) : (
          <>
            <div className="space-y-0.5">
              {pending.map((t) => (
                <TodoRow key={t.id} item={t} onToggle={() => toggle(t.id)} onRemove={() => remove(t.id)} />
              ))}
            </div>
            {done.length > 0 && (
              <>
                <div className="mt-3 flex items-center justify-between px-2.5 pb-1">
                  <span className="text-xs text-muted-foreground">Feitos · {done.length}</span>
                  <button type="button" onClick={() => save(pending)} className="text-xs text-muted-foreground hover:text-foreground">
                    Limpar
                  </button>
                </div>
                <div className="space-y-0.5">
                  {done.map((t) => (
                    <TodoRow key={t.id} item={t} onToggle={() => toggle(t.id)} onRemove={() => remove(t.id)} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
