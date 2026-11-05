import { ChevronDown, GitBranch, Maximize2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { Composer } from '@/components/chat/composer'
import { DeleteSessionDialog } from '@/components/delete-session-dialog'
import { useAutoScroll, useConversation } from '@/components/chat/feed'
import { MessageList } from '@/components/chat/message-list'
import { Claudinho } from '@/components/claudinho'
import { StateBadge } from '@/components/state-badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { claudinhoName } from '@/lib/claudinho'
import { enqueue } from '@/lib/outbox'
import { subscribe, unsubscribe } from '@/lib/store'
import type { RunOptions } from '@/lib/types'
import { cn } from '@/lib/utils'
import { openTab } from '@/lib/workbench'

/**
 * Uma conversa em miniatura, na mesa do projeto (ver hub.tsx): as mensagens ao vivo, as aprovações e
 * perguntas para responder ali mesmo e a caixa de mensagem. É a mesma conversa da aba, sem o resto da
 * tela (mapa, agentes, menu): o topo a abre como aba, onde está tudo. `onEdit`: escrever nela deixa a
 * mesa aberta, como na caixa da conversa nova.
 */
export function MiniChat({ id, machine, onEdit, className }: { id: string; machine: string; onEdit?: () => void; className?: string }) {
  const [, navigate] = useLocation()
  useEffect(() => {
    subscribe(id)
    return () => unsubscribe(id)
  }, [id])
  const { view, entry, cwd, panelOpen, owner, state, waitingFor, working, history, items, background, uses, queued } = useConversation(id, machine)
  const { scrollRef, contentRef, onScroll, atBottom, jumpToBottom } = useAutoScroll([items.length, queued.length, history.events === null])
  // Parada: modelo/esforço/modo escolhidos aqui valem quando ela for retomada, como na aba.
  const [pending, setPending] = useState<RunOptions>({})
  // Apagar a conversa pela lixeira do card (ver DeleteSessionDialog); o PC recusa a que está aberta nele.
  const [confirmDelete, setConfirmDelete] = useState(false)
  const name = claudinhoName(id, entry?.claudinhoName)
  // Turno encerrado com algo em segundo plano: ainda trabalha, como na lista de conversas.
  const inBackground = state === 'idle' && background.length > 0
  const shown = inBackground ? 'running' : state
  const live = shown === 'running' || shown === 'waiting'
  const branch = entry?.worktree ? (entry.worktree.branch ?? entry.worktree.name) : entry?.gitBranch

  const expand = () => {
    openTab({ kind: 'chat', id })
    navigate(`/s/${id}`)
  }

  return (
    <section className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl', className)}>
      {/* O realce do hover vale para a linha toda, lixeira inclusive, e não só para o botão de abrir. */}
      <div className="group/top flex min-h-11 shrink-0 items-center transition-colors hover:bg-foreground/[0.04]">
        <button
          type="button"
          onClick={expand}
          title="Abrir como aba"
          className="flex min-w-0 flex-1 items-center gap-2 self-stretch px-2.5 py-1.5 text-left"
        >
          <Claudinho seed={id} name={name} state={shown} size={28} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{entry?.title ?? 'Conversa'}</span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <span className="shrink-0 font-medium text-foreground/70">{name}</span>
              {branch && (
                <>
                  <GitBranch className="ml-1 size-3 shrink-0" />
                  <span className="truncate font-mono text-[11px]">{branch}</span>
                </>
              )}
            </span>
          </span>
          {live && <StateBadge state={shown} waitingFor={inBackground ? 'background' : waitingFor} className="h-4 shrink-0 px-1 text-[10px]" />}
          <Maximize2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/top:opacity-100" />
        </button>
        {/* Apagar a conversa: só no hover (ou no toque/foco), e no PC recusa a que está aberta nele. */}
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          disabled={owner === 'pc'}
          aria-label={owner === 'pc' ? 'Apagar a conversa (feche no PC antes)' : 'Apagar a conversa'}
          title={owner === 'pc' ? 'Apagar a conversa (feche no PC antes)' : 'Apagar a conversa'}
          className={cn(
            'mr-1 flex size-7 shrink-0 items-center justify-center opacity-0 transition focus-visible:opacity-100 group-hover/top:opacity-100 pointer-coarse:opacity-100',
            owner === 'pc' ? 'cursor-not-allowed text-muted-foreground/40' : 'text-muted-foreground hover:text-destructive',
          )}
        >
          <Trash2 className="size-4" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="absolute inset-0 overflow-y-auto">
          <div ref={contentRef}>
            {history.events === null && !history.error ? (
              <div className="space-y-3 p-3">
                <Skeleton className="ml-auto h-8 w-2/3" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : (
              <>
                {history.error && <p className="p-3 text-xs text-red-600 dark:text-red-400">{history.error}</p>}
                {items.length === 0 && queued.length === 0 && !working && !history.error && (
                  <p className="p-4 text-center text-xs text-muted-foreground">Nenhuma mensagem ainda.</p>
                )}
                <MessageList
                  items={items}
                  queued={queued}
                  sessionId={id}
                  actionable={panelOpen}
                  working={working}
                  background={background}
                  uses={uses}
                  cwd={cwd}
                />
              </>
            )}
          </div>
        </div>
        {!atBottom && (
          <Button
            variant="secondary"
            size="icon"
            onClick={jumpToBottom}
            aria-label="Ir para a última mensagem"
            className="absolute right-2 bottom-2 z-10 size-8 rounded-full border shadow-md"
          >
            <ChevronDown />
          </Button>
        )}
      </div>

      <div className="shrink-0">
        {owner === 'panel' ? (
          <Composer
            sessionId={id}
            cwd={cwd}
            working={working || state === 'waiting'}
            settings={Object.keys(view.settings).length ? view.settings : pending}
            context={null}
            onChangeSettings={async (patch) => {
              await api.settings(id, patch)
            }}
            onEdit={onEdit}
            onSend={(text, attachments) => {
              onEdit?.()
              return enqueue(id, text, attachments)
            }}
            onInterrupt={() => api.interrupt(id).then(() => undefined)}
          />
        ) : (
          <Composer
            sessionId={id}
            cwd={cwd}
            working={false}
            hint={owner === 'pc' ? (state === 'idle' ? 'Aberta no PC: enviar a continua aqui.' : 'Trabalhando no PC.') : 'Enviar retoma esta conversa.'}
            settings={pending}
            context={null}
            onChangeSettings={(patch) => setPending((p) => ({ ...p, ...patch }))}
            onEdit={onEdit}
            onSend={(text, attachments) => {
              onEdit?.()
              return enqueue(id, text, attachments, pending)
            }}
          />
        )}
      </div>

      <DeleteSessionDialog sessionId={id} title={entry?.title} open={confirmDelete} onOpenChange={setConfirmDelete} />
    </section>
  )
}
