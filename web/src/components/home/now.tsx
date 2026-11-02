import { ChevronRight, Monitor } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { Link } from 'wouter'
import { ApprovalCard } from '@/components/chat/approval-card'
import { buildItems, type Item } from '@/components/chat/items'
import { QuestionCard } from '@/components/chat/question-card'
import { SessionInfo } from '@/components/session-info'
import { Skeleton } from '@/components/ui/skeleton'
import { projectName } from '@/lib/format'
import { selectView, subscribe, unsubscribe, useStore } from '@/lib/store'
import type { CatalogEntry } from '@/lib/types'
import { HomeCard } from './card'

type Request = Extract<Item, { type: 'approval' | 'question' }>

/** Os pedidos abertos de uma conversa do painel, com os mesmos cartões do chat para responder aqui. */
export function Pending({ s }: { s: CatalogEntry }) {
  // A home não fica ao mesmo tempo que o chat da conversa: pode acompanhar os eventos dela.
  useEffect(() => {
    subscribe(s.sessionId)
    return () => unsubscribe(s.sessionId)
  }, [s.sessionId])
  const view = useStore(selectView(s.sessionId))
  const requests = useMemo(
    () =>
      buildItems(view.events.map((e) => ({ ...e, key: `${view.runId}-${e.seq}` }))).filter(
        (i): i is Request => (i.type === 'approval' || i.type === 'question') && !i.resolution,
      ),
    [view.events, view.runId],
  )
  return (
    <div className="space-y-2">
      <Link href={`/s/${s.sessionId}`} className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <span className="truncate font-medium text-foreground">{s.title}</span>
        <span className="shrink-0">· {projectName(s.cwd)}</span>
        <ChevronRight className="size-3.5 shrink-0" />
      </Link>
      {requests.length === 0 ? (
        <Skeleton className="h-28 w-full" />
      ) : (
        requests.map((r) =>
          r.type === 'approval' ? (
            <ApprovalCard key={r.key} type={r.type} req={r.req} agent={r.agent} sessionId={s.sessionId} actionable={view.open !== false} />
          ) : (
            <QuestionCard key={r.key} type={r.type} req={r.req} sessionId={s.sessionId} actionable={view.open !== false} />
          ),
        )
      )}
    </div>
  )
}

function Row({ s, note }: { s: CatalogEntry; note?: string }) {
  return (
    <Link href={`/s/${s.sessionId}`} className="-mx-2 flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted/50 active:bg-muted">
      <SessionInfo s={s} />
      {note && (
        <span className="flex shrink-0 items-center gap-1 self-center text-[11px] text-muted-foreground">
          <Monitor className="size-3" />
          {note}
        </span>
      )}
    </Link>
  )
}

/** O que precisa de você agora (para responder aqui mesmo) e o que está trabalhando. */
export function Now({ className }: { className?: string }) {
  const catalog = useStore((s) => s.catalog)
  const loaded = useStore((s) => s.catalogLoaded)
  const { asking, onPc, working } = useMemo(() => {
    const asking = catalog.filter((c) => c.owner === 'panel' && c.pending?.length)
    return {
      asking,
      // Aberta no terminal ou no VSCode: a resposta é lá.
      onPc: catalog.filter((c) => c.owner === 'pc' && c.state === 'waiting'),
      working: catalog.filter(
        (c) => !asking.includes(c) && (c.state === 'running' || (c.state === 'idle' && Boolean(c.agents || c.tasks?.length))),
      ),
    }
  }, [catalog])

  return (
    <HomeCard
      className={className}
      title={asking.length + onPc.length ? 'Pedindo você' : 'Agora'}
      description={
        asking.length + onPc.length
          ? 'Responda aqui mesmo ou toque no título para abrir a conversa.'
          : 'Conversas trabalhando e tarefas em segundo plano.'
      }
    >
      {!loaded ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <div className="space-y-4">
          {asking.map((s) => (
            <Pending key={s.sessionId} s={s} />
          ))}
          {onPc.map((s) => (
            <Row key={s.sessionId} s={s} note="responder no PC" />
          ))}
          {working.length > 0 && (
            <div>
              {asking.length + onPc.length > 0 && <h3 className="mb-1 text-xs font-medium text-muted-foreground">Trabalhando</h3>}
              {working.map((s) => (
                <Row key={s.sessionId} s={s} />
              ))}
            </div>
          )}
          {asking.length + onPc.length + working.length === 0 && (
            <p className="text-sm text-muted-foreground">Nada rodando. Quando uma conversa trabalhar ou pedir algo, ela aparece aqui.</p>
          )}
        </div>
      )}
    </HomeCard>
  )
}
