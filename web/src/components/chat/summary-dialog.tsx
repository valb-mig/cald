import { CircleAlert, FilePen, FlaskConical, Gauge, Images, Link2, SquareTerminal, X, type LucideIcon } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { ImageThumb } from '@/components/image-viewer'
import { ISLAND, NAV_ITEM, WINDOW } from '@/components/island'
import { Meter } from '@/components/pc-status'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError, api, imageUrl, thumbUrl } from '@/lib/api'
import { TEST_COMMAND } from '@/lib/format'
import { useMachine } from '@/lib/machines'
import { useStore } from '@/lib/store'
import type { ContextUsage, SessionCost } from '@/lib/types'
import { cn } from '@/lib/utils'
import { LineCounts } from './activity'
import { compactProgress } from './composer-controls'
import type { Item } from './items'
import { failedTools, linksOf, sessionOf, toolsOf } from './turn'
import { CommandsView, ErrorsView, FilesView, LinksView, type CommandFilter } from './turn-views'

type Section = 'overview' | 'files' | 'commands' | 'errors' | 'links' | 'media'

const SECTIONS: { key: Section; label: string; description: string; icon: LucideIcon }[] = [
  { key: 'overview', label: 'Geral', description: 'O consumo e o que a conversa fez.', icon: Gauge },
  { key: 'files', label: 'Arquivos', description: 'O que o Claude mudou.', icon: FilePen },
  { key: 'commands', label: 'Comandos', description: 'O que rodou no terminal.', icon: SquareTerminal },
  { key: 'errors', label: 'Erros', description: 'As ferramentas que falharam.', icon: CircleAlert },
  { key: 'links', label: 'Links', description: 'Páginas abertas, pesquisas e citações.', icon: Link2 },
  { key: 'media', label: 'Mídia', description: 'As imagens da conversa.', icon: Images },
]

/** As contas do resumo, das mensagens carregadas. */
function summaryOf(items: Item[]) {
  const tools = toolsOf(items)
  const session = sessionOf(items)
  const tests = session.commands.filter((c) => typeof c.use.input.command === 'string' && TEST_COMMAND.test(c.use.input.command))
  return {
    session,
    links: linksOf(session),
    errors: failedTools(tools),
    tests: { total: tests.length, ok: tests.filter((t) => t.result && !t.result.isError).length, failed: tests.filter((t) => t.result?.isError).length },
    // Chaves das imagens, na ordem do chat: anexadas por você e devolvidas por ferramentas (prints, imagens lidas).
    media: {
      mine: items.flatMap((i) => (i.type === 'user' ? (i.images ?? []) : [])),
      claude: tools.flatMap((t) => t.result?.images ?? []),
    },
    turns: items.filter((i) => i.type === 'result').length,
  }
}

type SummaryData = ReturnType<typeof summaryOf>
/** Para onde ir: a seção e, nos comandos, um filtro já ligado (os testes, vindo da Geral). */
type Place = { section: Section; filter?: CommandFilter }

/**
 * O resumo da sessão, do ⋯ da conversa. Desenhado como o painel Computador: uma ilha na cor da casca,
 * com as seções à esquerda (com a contagem de cada uma) e a escolhida numa janela à direita; no
 * celular, as seções viram pílulas em cima da janela. As listas são as mesmas dos modais de cada
 * resposta (ver turn-views.tsx), só que da conversa inteira.
 */
export function SummaryDialog({
  sessionId,
  items,
  cwd,
  context,
  open,
  onOpenChange,
}: {
  sessionId: string
  items: Item[]
  cwd?: string
  /** Contexto da sessão aberta no painel, o mesmo do anel ao lado da caixa de mensagem. */
  context?: ContextUsage | null
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className={ISLAND}>
        {/* O conteúdo só existe com o modal aberto: fechado, as contas não são refeitas a cada evento. */}
        <Summary sessionId={sessionId} items={items} cwd={cwd} context={context} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function Summary({ sessionId, items, cwd, context, onClose }: { sessionId: string; items: Item[]; cwd?: string; context?: ContextUsage | null; onClose: () => void }) {
  const machine = useMachine()
  const [place, setPlace] = useState<Place>({ section: 'overview' })
  const s = useMemo(() => summaryOf(items), [items])
  const counts: Record<Section, number> = {
    overview: 0,
    files: s.session.files.length,
    commands: s.session.commands.length,
    errors: s.errors.length,
    links: s.links.length,
    media: s.media.mine.length + s.media.claude.length,
  }
  // Seção sem nada some da navegação; a Geral fica sempre.
  const sections = SECTIONS.filter((x) => x.key === 'overview' || counts[x.key] > 0)
  // A escolhida pode esvaziar com o modal aberto (um /clear): volta para a Geral.
  const current = sections.find((x) => x.key === place.section) ?? sections[0]!
  const scroll = 'min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6 max-sm:px-4 max-sm:pt-4'

  return (
    <>
      <nav className="flex shrink-0 flex-col gap-1 p-3 max-sm:pb-2 sm:w-52">
        <div className="flex items-center justify-between px-2 pt-1 pb-2 sm:pb-3">
          <DialogTitle className="text-sm">Resumo da sessão</DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="sm:hidden" aria-label="Fechar">
              <X />
            </Button>
          </DialogClose>
        </div>
        <DialogDescription className="sr-only">O consumo da conversa e o que o Claude fez nela: arquivos, comandos, erros, links e imagens.</DialogDescription>
        <div className="flex gap-1 max-sm:overflow-x-auto max-sm:[scrollbar-width:none] sm:flex-col">
          {sections.map((x) => (
            <button
              key={x.key}
              type="button"
              aria-current={current.key === x.key ? 'page' : undefined}
              onClick={() => setPlace({ section: x.key })}
              className={cn(NAV_ITEM, 'whitespace-nowrap max-sm:w-auto')}
            >
              <x.icon />
              <span className="flex-1 text-left">{x.label}</span>
              {x.key !== 'overview' && <span className="text-xs text-muted-foreground tabular-nums">{counts[x.key]}</span>}
            </button>
          ))}
        </div>
      </nav>

      <div className={WINDOW}>
        {/* No celular, a pílula escolhida já diz a seção: o cabeçalho sai para sobrar espaço. */}
        <header className="flex items-start gap-3 px-6 pt-5 pb-4 max-sm:hidden">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-medium">{current.label}</h2>
            <p className="text-xs text-muted-foreground">{current.description}</p>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-2" aria-label="Fechar">
              <X />
            </Button>
          </DialogClose>
        </header>
        <div key={`${current.key}:${place.filter ?? ''}`} className="tab-panel-in flex min-h-0 flex-1 flex-col">
          {current.key === 'overview' ? (
            <div className={scroll}>
              <Usage sessionId={sessionId} turns={s.turns} live={context} />
              <Did s={s} go={setPlace} />
            </div>
          ) : current.key === 'files' ? (
            <FilesView files={s.session.files} cwd={cwd} machine={machine} onDone={onClose} inset="window" />
          ) : current.key === 'commands' ? (
            <CommandsView commands={s.session.commands} filter={place.filter} inset="window" />
          ) : current.key === 'errors' ? (
            <ErrorsView tools={s.errors} inset="window" />
          ) : current.key === 'links' ? (
            <LinksView visited={s.session.visited} cited={s.session.cited} inset="window" />
          ) : (
            <div className={scroll}>
              <MediaGroup sessionId={sessionId} title="Enviadas por você" from="Você" keys={s.media.mine} />
              <MediaGroup sessionId={sessionId} title="Do Claude" from="Claude" keys={s.media.claude} />
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="px-1 text-xs font-medium text-muted-foreground">{children}</h3>
}

/** "Nesta conversa": um bloco por assunto com o número; tocar leva à seção dele. */
function Did({ s, go }: { s: SummaryData; go: (place: Place) => void }) {
  const { session, tests, errors, links, media } = s
  const images = media.mine.length + media.claude.length
  const tiles: { key: string; icon: LucideIcon; label: string; value: number; aside?: React.ReactNode; to: Place }[] = []
  if (session.files.length)
    tiles.push({
      key: 'files',
      icon: FilePen,
      label: 'Arquivos',
      value: session.files.length,
      aside: <LineCounts added={session.files.reduce((n, f) => n + f.added, 0)} removed={session.files.reduce((n, f) => n + f.removed, 0)} />,
      to: { section: 'files' },
    })
  if (session.commands.length) tiles.push({ key: 'commands', icon: SquareTerminal, label: 'Comandos', value: session.commands.length, to: { section: 'commands' } })
  if (tests.total)
    tiles.push({
      key: 'tests',
      icon: FlaskConical,
      label: 'Testes',
      value: tests.total,
      // Só a falha ganha cor: é o que pede atenção.
      aside: (tests.ok > 0 || tests.failed > 0) && (
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {tests.ok > 0 && `${tests.ok} ok`}
          {tests.ok > 0 && tests.failed > 0 && ' · '}
          {tests.failed > 0 && <span className="text-red-600 dark:text-red-400">{`${tests.failed} ${tests.failed === 1 ? 'falhou' : 'falharam'}`}</span>}
        </span>
      ),
      to: { section: 'commands', filter: 'tests' },
    })
  if (errors.length) tiles.push({ key: 'errors', icon: CircleAlert, label: 'Erros', value: errors.length, to: { section: 'errors' } })
  if (links.length) tiles.push({ key: 'links', icon: Link2, label: 'Links', value: links.length, to: { section: 'links' } })
  if (images) tiles.push({ key: 'media', icon: Images, label: 'Mídia', value: images, to: { section: 'media' } })
  if (!tiles.length) return null
  return (
    <section className="space-y-2">
      <Heading>Nesta conversa</Heading>
      <div className="grid grid-cols-3 gap-2 max-sm:grid-cols-2">
        {tiles.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => go(t.to)}
            className="min-w-0 rounded-xl bg-foreground/[0.04] px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.07]"
          >
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <t.icon className="size-3.5 shrink-0" />
              {t.label}
            </div>
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="text-lg font-semibold tabular-nums">{t.value}</span>
              {t.aside}
            </div>
          </button>
        ))}
      </div>
      <p className="px-1 text-xs text-muted-foreground">Das mensagens carregadas.</p>
    </section>
  )
}

/** Grade de miniaturas; tocar abre a imagem em tela cheia, passando de lado pelas outras do grupo. */
function MediaGroup({ sessionId, title, from, keys }: { sessionId: string; title: string; from: string; keys: string[] }) {
  if (keys.length === 0) return null
  const gallery = keys.map((key) => imageUrl(sessionId, key))
  const thumbs = keys.map((key) => thumbUrl(sessionId, key))
  return (
    <section className="space-y-2">
      <Heading>
        {title} <span className="font-normal tabular-nums opacity-70">{keys.length}</span>
      </Heading>
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
        {gallery.map((src, i) => (
          <ImageThumb key={src} src={src} thumb={thumbs[i]} gallery={gallery} from={from} className="aspect-square w-full" />
        ))}
      </div>
    </section>
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

/** Consumo lido do transcript no PC; relido ao abrir e a cada turno concluído com o resumo aberto. */
function useSessionCost(sessionId: string, turns: number) {
  const [data, setData] = useState<{ id: string; cost?: SessionCost; error?: string } | null>(null)
  useEffect(() => {
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
  }, [sessionId, turns])
  return data?.id === sessionId ? data : null
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-foreground/[0.04] px-3 py-2.5">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

/** Peso do contexto, tokens e custo em dólar da conversa inteira. `live`: contexto da sessão aberta no painel. */
function Usage({ sessionId, turns, live }: { sessionId: string; turns: number; live?: ContextUsage | null }) {
  const data = useSessionCost(sessionId, turns)
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
      <Heading>Consumo</Heading>
      {!data ? (
        <Skeleton className="h-28 w-full rounded-xl" />
      ) : data.error ? (
        <p className="px-1 text-xs text-muted-foreground">{data.error}</p>
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
                className="px-1"
              />
            )}
            <div className="grid grid-cols-2 gap-2">
              <Tile label="Custo estimado" value={money(cost.costUsd)} />
              <Tile label="Tokens processados" value={tokens.format(total.input + total.output + total.cacheWrite + total.cacheRead)} />
            </div>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-1 text-xs">
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
            <ul className="space-y-1 px-1 pt-1">
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
            <p className="px-1 text-xs text-muted-foreground">
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
