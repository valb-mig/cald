import { CheckCircle2, XCircle } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { ImageThumb } from '@/components/image-viewer'
import { Meter } from '@/components/pc-status'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError, api, imageUrl, thumbUrl } from '@/lib/api'
import { FILE_TOOLS, TEST_COMMAND, shortPath } from '@/lib/format'
import { useMachine } from '@/lib/machines'
import { useStore } from '@/lib/store'
import type { ContextUsage, SessionCost } from '@/lib/types'
import { cn } from '@/lib/utils'
import { compactProgress } from './composer-controls'
import type { Keyed } from './items'

type Summary = {
  files: { path: string; edits: number }[]
  commands: { command: string; failed: boolean }[]
  errors: { tool: string; text: string }[]
  tests: { command: string; failed: boolean }[]
  /** Chaves das imagens, na ordem do chat: anexadas pela pessoa e devolvidas por ferramentas (prints, imagens lidas). */
  media: { mine: string[]; claude: string[] }
}

function summarize(events: Keyed[]): Summary {
  const failed = new Map<string, string | null>()
  const media: Summary['media'] = { mine: [], claude: [] }
  for (const e of events) {
    if (e.kind === 'user' && e.images) media.mine.push(...e.images)
    if (e.kind !== 'tool_result') continue
    failed.set(e.toolUseId, e.isError ? e.text : null)
    if (e.images) media.claude.push(...e.images)
  }

  const files = new Map<string, number>()
  const commands: Summary['commands'] = []
  const errors: Summary['errors'] = []
  for (const e of events) {
    if (e.kind !== 'tool_use') continue
    const error = failed.get(e.id)
    if (error) errors.push({ tool: e.name, text: error.split('\n')[0] ?? '' })
    const path = e.input.file_path ?? e.input.notebook_path
    if (FILE_TOOLS.has(e.name) && typeof path === 'string' && !error) files.set(path, (files.get(path) ?? 0) + 1)
    if (e.name === 'Bash' && typeof e.input.command === 'string') {
      commands.push({ command: e.input.command, failed: Boolean(error) })
    }
  }
  return {
    files: [...files].map(([path, edits]) => ({ path, edits })),
    commands,
    errors,
    tests: commands.filter((c) => TEST_COMMAND.test(c.command)),
    media,
  }
}

function Section({ title, count, className, children }: { title: string; count: number; className?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">
        {title} <span className="text-muted-foreground">({count})</span>
      </h3>
      {count === 0 ? <p className="text-xs text-muted-foreground">Nada por aqui.</p> : <ul className={cn('space-y-1', className)}>{children}</ul>}
    </section>
  )
}

/** Grade de miniaturas; tocar abre a imagem em tela cheia, passando de lado pelas outras do grupo. */
function MediaGroup({ sessionId, title, from, keys }: { sessionId: string; title: string; from: string; keys: string[] }) {
  if (keys.length === 0) return null
  const gallery = keys.map((key) => imageUrl(sessionId, key))
  const thumbs = keys.map((key) => thumbUrl(sessionId, key))
  return (
    <li className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        {title} ({keys.length})
      </p>
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
        {gallery.map((src, i) => (
          <ImageThumb key={src} src={src} thumb={thumbs[i]} gallery={gallery} from={from} className="aspect-square w-full" />
        ))}
      </div>
    </li>
  )
}

const tokens = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })
const usd = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' })
const money = (n: number) => (n > 0 && n < 0.01 ? `< ${usd.format(0.01)}` : usd.format(n))

/** `claude-opus-5-5` → "Opus 5.5"; o que fugir do padrão fica como veio. */
function modelLabel(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d)(?!\d))?/)
  if (!m) return id
  const family = m[1]!
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

/** Consumo lido do transcript no PC; relido ao abrir e a cada turno concluído com a folha aberta. */
function useSessionCost(sessionId: string, open: boolean, turns: number) {
  const [data, setData] = useState<{ id: string; cost?: SessionCost; error?: string } | null>(null)
  useEffect(() => {
    if (!open) return
    let alive = true
    api.cost(sessionId).then(
      (cost) => {
        if (alive) setData({ id: sessionId, cost })
      },
      (err: unknown) => {
        if (!alive) return
        const missing = err instanceof ApiError && err.status === 404
        setData({ id: sessionId, error: missing ? 'Ainda não há respostas salvas.' : 'Não deu para ler o consumo.' })
      },
    )
    return () => {
      alive = false
    }
  }, [sessionId, open, turns])
  return data?.id === sessionId ? data : null
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

/** Peso do contexto, tokens e custo em dólar da conversa inteira. `live`: contexto da sessão aberta no painel. */
function Usage({ sessionId, open, turns, live }: { sessionId: string; open: boolean; turns: number; live?: ContextUsage | null }) {
  const data = useSessionCost(sessionId, open, turns)
  const machine = useMachine()
  const subscription = useStore((s) => s.usages[machine]?.plan?.subscription)
  const cost = data?.cost

  // A sessão aberta no painel sabe onde fica a compactação automática; as outras, só o tamanho da janela.
  const context = live
    ? {
        label: live.autoCompactEnabled && live.autoCompactThreshold ? 'Contexto até a compactação automática' : 'Contexto usado',
        tokens: live.totalTokens,
        limit: live.autoCompactEnabled && live.autoCompactThreshold ? live.autoCompactThreshold : live.maxTokens,
        percent: compactProgress(live),
      }
    : cost?.context?.window
      ? {
          label: 'Contexto na última resposta',
          tokens: cost.context.tokens,
          limit: cost.context.window,
          percent: Math.min(100, (cost.context.tokens / cost.context.window) * 100),
        }
      : null

  const total = cost?.models.reduce(
    (t, m) => ({ input: t.input + m.input, output: t.output + m.output, cacheWrite: t.cacheWrite + m.cacheWrite, cacheRead: t.cacheRead + m.cacheRead }),
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  )
  const unpriced = cost?.models.filter((m) => m.costUsd === null) ?? []

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Consumo</h3>
      {!data ? (
        <Skeleton className="h-28 w-full" />
      ) : data.error ? (
        <p className="text-xs text-muted-foreground">{data.error}</p>
      ) : (
        cost &&
        total && (
          <>
            {context && (
              <Meter
                label={context.label}
                value={`${Math.round(context.percent)}%`}
                percent={context.percent}
                detail={`${tokens.format(context.tokens)} de ${tokens.format(context.limit)} tokens`}
              />
            )}
            <div className="grid grid-cols-2 gap-2">
              <Tile label="Custo estimado" value={money(cost.costUsd)} />
              <Tile label="Tokens processados" value={tokens.format(total.input + total.output + total.cacheWrite + total.cacheRead)} />
            </div>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">
              {(
                [
                  ['Entrada', total.input],
                  ['Saída', total.output],
                  ['Gravação no cache', total.cacheWrite],
                  ['Leitura do cache', total.cacheRead],
                ] as const
              ).map(([label, n]) => (
                <Fragment key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-right tabular-nums">{tokens.format(n)}</dd>
                </Fragment>
              ))}
            </dl>
            <ul className="space-y-1 border-t pt-3">
              {cost.models.map((m) => (
                <li key={m.model} className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{modelLabel(m.model)}</span>
                    <span className="text-muted-foreground">
                      {' '}
                      · {m.requests} {m.requests === 1 ? 'resposta' : 'respostas'}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">{m.costUsd === null ? 'sem preço' : money(m.costUsd)}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Preço de tabela da API, da conversa inteira
              {cost.subagentsUsd > 0 ? `, com ${money(cost.subagentsUsd)} de subagentes` : ''}.
              {unpriced.length > 0 && ` Sem preço conhecido: ${unpriced.map((m) => modelLabel(m.model)).join(', ')}.`}
              {subscription &&
                ` No plano ${subscription.charAt(0).toUpperCase()}${subscription.slice(1)}, o uso conta nos limites do plano e não é cobrado à parte.`}
            </p>
          </>
        )
      )}
    </section>
  )
}

const Status = ({ failed }: { failed: boolean }) =>
  failed ? (
    <XCircle className="mt-0.5 size-3.5 shrink-0 text-red-600 dark:text-red-400" />
  ) : (
    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
  )

export function SummarySheet({
  sessionId,
  events,
  cwd,
  context,
  open,
  onOpenChange,
}: {
  sessionId: string
  events: Keyed[]
  cwd?: string
  /** Contexto da sessão aberta no painel, o mesmo do anel ao lado da caixa de mensagem. */
  context?: ContextUsage | null
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto lg:mx-auto lg:max-w-2xl lg:rounded-t-xl lg:border-x">
        <SheetHeader>
          <SheetTitle>Resumo da sessão</SheetTitle>
          <SheetDescription>Com base nas mensagens carregadas.</SheetDescription>
        </SheetHeader>
        <SummaryBody sessionId={sessionId} events={events} cwd={cwd} context={context} open={open} />
      </SheetContent>
    </Sheet>
  )
}

/** O resumo em si: montado só com a folha aberta, para não refazer as contas a cada evento da conversa. */
function SummaryBody({
  sessionId,
  events,
  cwd,
  context,
  open,
}: {
  sessionId: string
  events: Keyed[]
  cwd?: string
  context?: ContextUsage | null
  open: boolean
}) {
  const s = useMemo(() => summarize(events), [events])
  const turns = useMemo(() => events.filter((e) => e.kind === 'result').length, [events])
  return (
    <div className="space-y-6 px-4 pb-6">
      <Usage sessionId={sessionId} open={open} turns={turns} live={context} />
      <Section title="Mídia" count={s.media.mine.length + s.media.claude.length} className="space-y-3">
        <MediaGroup sessionId={sessionId} title="Enviadas por você" from="Você" keys={s.media.mine} />
        <MediaGroup sessionId={sessionId} title="Do Claude" from="Claude" keys={s.media.claude} />
      </Section>
      <Section title="Arquivos alterados" count={s.files.length}>
        {s.files.map((f) => {
          const rel = cwd && f.path.startsWith(`${cwd}/`) ? f.path.slice(cwd.length + 1) : shortPath(f.path)
          const slash = rel.lastIndexOf('/')
          return (
            <li key={f.path} className="flex items-start justify-between gap-2 text-xs">
              <div className="min-w-0">
                <div className="truncate font-mono font-medium">{rel.slice(slash + 1)}</div>
                {slash > 0 && <div className="truncate font-mono text-muted-foreground">{rel.slice(0, slash)}</div>}
              </div>
              <span className="shrink-0 text-muted-foreground">{f.edits}×</span>
            </li>
          )
        })}
      </Section>
      <Section title="Testes" count={s.tests.length}>
        {s.tests.map((t, i) => (
          <li key={i} className="flex items-start gap-2 font-mono text-xs">
            <Status failed={t.failed} />
            <span className="line-clamp-3 break-all">{t.command}</span>
          </li>
        ))}
      </Section>
      <Section title="Erros" count={s.errors.length}>
        {s.errors.map((e, i) => (
          <li key={i} className="text-xs">
            <span className="font-medium">{e.tool}: </span>
            <span className="text-red-700 dark:text-red-300">{e.text}</span>
          </li>
        ))}
      </Section>
      <Section title="Comandos" count={s.commands.length}>
        {s.commands.map((c, i) => (
          <li key={i} className="flex items-start gap-2 font-mono text-xs">
            <Status failed={c.failed} />
            <span className="line-clamp-3 break-all">{c.command}</span>
          </li>
        ))}
      </Section>
    </div>
  )
}
