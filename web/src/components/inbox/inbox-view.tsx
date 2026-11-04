import {
  Check,
  ChevronRight,
  CircleDot,
  Clock,
  ExternalLink,
  FileDiff,
  GitPullRequest,
  ListFilter,
  ListTodo,
  Loader2,
  MessageCircleQuestion,
  MoreHorizontal,
  RotateCw,
  Search,
  Sparkles,
  Undo2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'wouter'
import { Claudinho } from '@/components/claudinho'
import { PageHeader } from '@/components/layout'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Veil } from '@/components/wallpaper/veil'
import { insertInto } from '@/lib/compose'
import { putDraft } from '@/lib/drafts'
import { projectName, relativeTime } from '@/lib/format'
import { useWide } from '@/lib/hooks'
import { actOnInbox, GROUPS, refreshInbox, statusOf, tomorrowMorning, useInbox, useInboxEntries, type InboxEntry, type InboxGroup } from '@/lib/inbox'
import { newChatUrl } from '@/lib/machines'
import type { InboxReason } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useGlass, useScrim } from '@/lib/wallpaper'
import { openPanelTab, openProjectHub } from '@/lib/workbench'

const REASON: Record<InboxReason, { label: string; tone: string }> = {
  review: { label: 'Pedem sua revisão', tone: 'text-sky-600 dark:text-sky-400' },
  checks: { label: 'Check falhando', tone: 'text-red-600 dark:text-red-400' },
  changes: { label: 'Mudanças pedidas', tone: 'text-amber-600 dark:text-amber-400' },
  conflict: { label: 'Conflito com a base', tone: 'text-amber-600 dark:text-amber-400' },
  ready: { label: 'Aprovado, pronto para o merge', tone: 'text-emerald-600 dark:text-emerald-400' },
  assigned: { label: 'Atribuída a você', tone: 'text-violet-600 dark:text-violet-400' },
  mentioned: { label: 'Mencionaram você', tone: 'text-violet-600 dark:text-violet-400' },
}

/** O que a linha mostra: ícone, título, o porquê (colorido) e de onde vem. */
function describe(e: InboxEntry): { icon: React.ReactNode; title: string; why: string; tone: string; where: string } {
  const it = e.item
  if (it.type === 'waiting') {
    const asking = it.session.pending?.some((p) => p.kind === 'approval')
    return {
      icon: <Claudinho seed={it.session.sessionId} size={22} state="waiting" />,
      title: it.session.title,
      why: asking ? 'Pede aprovação' : 'Pergunta para você',
      tone: 'text-amber-600 dark:text-amber-400',
      where: it.session.cwd ? projectName(it.session.cwd) : '~',
    }
  }
  if (it.type === 'github') {
    const r = REASON[it.reason]
    return {
      icon: it.kind === 'pr' ? <GitPullRequest className={cn('size-4', r.tone)} /> : <CircleDot className={cn('size-4', r.tone)} />,
      title: `${it.title}`,
      why: r.label,
      tone: r.tone,
      where: `${it.repo} #${it.number}`,
    }
  }
  if (it.type === 'git') {
    const parts = [it.changed && `${it.changed} ${it.changed === 1 ? 'alterado' : 'alterados'}`, it.ahead && `↑ ${it.ahead} para enviar`, it.behind && `↓ ${it.behind} para receber`]
    return {
      icon: <FileDiff className="size-4 text-sky-600 dark:text-sky-400" />,
      title: projectName(it.cwd),
      why: parts.filter(Boolean).join(' · '),
      tone: 'text-sky-600 dark:text-sky-400',
      where: it.branch ?? '',
    }
  }
  return {
    icon: <ListTodo className="size-4 text-muted-foreground" />,
    title: it.title,
    why: `TODO:${it.n}`,
    tone: 'text-muted-foreground',
    where: projectName(it.cwd),
  }
}

/** O projeto (ou o repositório, sem clone aqui) do item: o filtro por projeto. */
function projectOf(e: InboxEntry): string {
  const it = e.item
  if (it.type === 'waiting') return it.session.cwd ? projectName(it.session.cwd) : '~'
  if (it.type === 'github') return it.cwd ? projectName(it.cwd) : it.repo
  return projectName(it.cwd)
}

const labelsOf = (e: InboxEntry) => (e.item.type === 'github' ? e.item.labels : [])

const DAY = 86_400_000

/**
 * O filtro por data, sobre a data do item: a última atividade do PR ou da issue, a criação do TODO, a
 * última mensagem da conversa. As mudanças nos projetos não têm data e só aparecem em "Qualquer data".
 */
const PERIODS: { key: string; label: string; has: (at: number, now: number) => boolean }[] = [
  { key: 'today', label: 'Hoje', has: (at, now) => at >= new Date(now).setHours(0, 0, 0, 0) },
  { key: 'week', label: 'Últimos 7 dias', has: (at, now) => at >= now - 7 * DAY },
  { key: 'month', label: 'Últimos 30 dias', has: (at, now) => at >= now - 30 * DAY },
  // O que ficou esquecido: nada de novo há mais de um mês.
  { key: 'stale', label: 'Parados há mais de 30 dias', has: (at, now) => at < now - 30 * DAY },
]
type Period = (typeof PERIODS)[number]

const inPeriod = (e: InboxEntry, period: Period, now: number) => e.at > 0 && period.has(e.at, now)

/** Onde a busca procura: título, o porquê, o projeto, o repositório e as labels. */
function searchText(e: InboxEntry): string {
  const d = describe(e)
  return [d.title, d.why, d.where, projectOf(e), ...labelsOf(e).map((l) => l.name)].join(' ').toLowerCase()
}

/** Uma label do GitHub com a cor dela: o fundo claro da cor e o texto na cor, no claro e no escuro. */
function Label({ name, color }: { name: string; color: string }) {
  return (
    <span
      className="max-w-28 shrink-0 truncate rounded-full border px-1.5 text-[10px] leading-4"
      style={{ borderColor: `#${color}66`, background: `#${color}22`, color: `color-mix(in oklab, #${color} 70%, var(--foreground))` }}
    >
      {name}
    </span>
  )
}

/** O pedido pronto para o Claude, e em que projeto: só quando o item tem um projeto neste PC. */
function askOf(e: InboxEntry): { cwd: string; text: string } | null {
  const it = e.item
  if (it.type === 'waiting') return null
  if (it.type === 'git') {
    const what = [
      it.changed && 'revise as mudanças que ainda não foram commitadas e me ajude a commitar em partes',
      it.ahead && 'envie os commits que faltam (push)',
      it.behind && 'traga os commits novos do remoto (pull) sem perder nada daqui',
    ].filter(Boolean)
    return { cwd: it.cwd, text: `Neste projeto, ${what.join('; ')}.` }
  }
  if (it.type === 'todo') return { cwd: it.cwd, text: `Vamos trabalhar no TODO:${it.n}.` }
  if (!it.cwd) return null
  const ref = `${it.kind === 'pr' ? 'o PR' : 'a issue'} #${it.number} (${it.title}): ${it.url}`
  const text: Record<InboxReason, string> = {
    review: `Revise ${ref}. Aponte o que precisa mudar por arquivo e linha.`,
    checks: `Os checks de ${ref} estão falhando. Veja o que quebrou e corrija.`,
    changes: `Pediram mudanças em ${ref}. Leia a revisão e faça o que foi pedido.`,
    conflict: `${ref.charAt(0).toUpperCase()}${ref.slice(1)} tem conflito com a base. Resolva o conflito.`,
    ready: `${ref.charAt(0).toUpperCase()}${ref.slice(1)} foi aprovado. Confira os checks e faça o merge.`,
    assigned: `Trabalhe n${it.kind === 'pr' ? 'o' : 'a'} ${it.kind === 'pr' ? 'PR' : 'issue'} #${it.number} (${it.title}): ${it.url}.`,
    mentioned: `Leia ${ref} e me diga o que pedem de mim.`,
  }
  return { cwd: it.cwd, text: text[it.reason] }
}

function useActions() {
  const wide = useWide()
  const [, navigate] = useLocation()
  const open = (e: InboxEntry) => {
    const it = e.item
    if (it.type === 'waiting') return navigate(`/s/${it.session.sessionId}`)
    if (it.type === 'github') {
      // No PC, com o projeto clonado aqui, o PR ou a issue abre numa aba; senão, no GitHub.
      if (wide && it.cwd) return openPanelTab({ kind: 'github', machine: e.machine, cwd: it.cwd, item: it.kind, number: it.number, title: it.title }, { preview: true })
      return void window.open(it.url, '_blank', 'noreferrer')
    }
    if (wide) return openProjectHub(e.machine, it.cwd)
    navigate(newChatUrl(it.cwd, e.machine))
  }
  const ask = async (e: InboxEntry) => {
    const a = askOf(e)
    if (!a) return
    const draft = `new:${a.cwd}`
    // A conversa nova do projeto já aberta recebe o texto na caixa; senão, ele fica no rascunho dela.
    if (!insertInto(draft, a.text)) await putDraft(draft, { text: a.text, attachments: [] })
    navigate(newChatUrl(a.cwd, e.machine))
  }
  return { open, ask }
}

function Row({ e, status, onOpen, onAsk }: { e: InboxEntry; status: 'new' | 'seen' | 'snoozed'; onOpen: () => void; onAsk: () => void }) {
  const d = describe(e)
  const it = e.item
  const canAsk = Boolean(askOf(e))
  const url = it.type === 'github' ? it.url : undefined
  const time = e.at ? relativeTime(e.at) : ''
  return (
    <li className={cn('group mx-2 flex items-center gap-1 rounded-xl pr-1 transition-colors hover:bg-foreground/[0.04]', status !== 'new' && 'opacity-60')}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-2.5 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex size-6 shrink-0 items-center justify-center">{d.icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            {status === 'new' && <span className="size-1.5 shrink-0 rounded-full bg-sky-500" aria-label="Novo" />}
            <span className="truncate text-sm font-medium">{d.title}</span>
            {time && <span className="ml-auto shrink-0 pl-1 text-[11px] text-muted-foreground">{time}</span>}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn('shrink-0 font-medium', d.tone)}>{d.why}</span>
            {d.where && (
              <>
                <span>·</span>
                <span className="truncate">{d.where}</span>
              </>
            )}
          </span>
          {labelsOf(e).length > 0 && (
            <span className="mt-1 flex min-w-0 gap-1 overflow-hidden">
              {labelsOf(e)
                .slice(0, 4)
                .map((l) => (
                  <Label key={l.name} {...l} />
                ))}
            </span>
          )}
        </span>
      </button>
      {status === 'new' ? (
        <Button variant="ghost" size="icon-sm" onClick={() => actOnInbox([{ key: e.key, action: 'seen', mark: e.mark }])} aria-label="Marcar como visto" title="Visto">
          <Check />
        </Button>
      ) : (
        <Button variant="ghost" size="icon-sm" onClick={() => actOnInbox([{ key: e.key, action: 'clear' }])} aria-label="Voltar para a inbox" title="Voltar para a inbox">
          <Undo2 />
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Mais ações">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canAsk && (
            <DropdownMenuItem onSelect={onAsk}>
              <Sparkles /> Pedir ao Claude
            </DropdownMenuItem>
          )}
          {url && (
            <DropdownMenuItem onSelect={() => window.open(url, '_blank', 'noreferrer')}>
              <ExternalLink /> Abrir no GitHub
            </DropdownMenuItem>
          )}
          {(canAsk || url) && <DropdownMenuSeparator />}
          {status !== 'snoozed' && (
            <DropdownMenuItem onSelect={() => actOnInbox([{ key: e.key, action: 'snooze', until: tomorrowMorning() }])}>
              <Clock /> Adiar até amanhã
            </DropdownMenuItem>
          )}
          {status === 'new' ? (
            <DropdownMenuItem onSelect={() => actOnInbox([{ key: e.key, action: 'seen', mark: e.mark }])}>
              <Check /> Marcar como visto
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => actOnInbox([{ key: e.key, action: 'clear' }])}>
              <Undo2 /> Voltar para a inbox
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

/** Os vistos e os adiados, recolhidos embaixo, para desfazer. */
function Folded({ label, entries, status, actions }: { label: string; entries: InboxEntry[]; status: 'seen' | 'snoozed'; actions: ReturnType<typeof useActions> }) {
  const [open, setOpen] = useState(false)
  if (!entries.length) return null
  return (
    <section className="pb-2">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-1 px-4 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        {label} <span className="tabular-nums">{entries.length}</span>
      </button>
      {open && (
        <ul className="space-y-0.5">
          {entries.map((e) => (
            <Row key={e.key} e={e} status={status} onOpen={() => actions.open(e)} onAsk={() => void actions.ask(e)} />
          ))}
        </ul>
      )}
    </section>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors',
        active ? 'border-foreground/20 bg-foreground/[0.08] font-medium text-foreground' : 'border-transparent bg-foreground/[0.04] text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/**
 * A inbox: tudo o que pede você, de todos os projetos e do GitHub da conta, por urgência. Tocar abre
 * (a conversa, o PR ou a issue, o projeto); ✓ marca como visto (e o item volta se mudar); no ⋯, pedir ao
 * Claude (uma conversa nova no projeto, com o pedido já escrito) e adiar até amanhã. Numa aba do PC
 * (`panel`), ela rola por dentro e fica sobre a cena do fundo, como a conversa.
 */
export function InboxView({ panel = false }: { panel?: boolean }) {
  const all = useInboxEntries()
  const glass = useGlass()
  const scrim = useScrim()
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<InboxGroup | null>(null)
  const [project, setProject] = useState<string | null>(null)
  const [label, setLabel] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period | null>(null)
  const state = useInbox((s) => s.state)
  const loading = useInbox((s) => s.loading)
  const at = useInbox((s) => s.at)
  // "Agora", para o período: a última atualização, como no adiado (ver abaixo); antes da primeira, a
  // hora em que a inbox abriu.
  const [opened] = useState(Date.now)
  const now = Math.max(at, opened)
  const github = useInbox((s) => Object.values(s.byMachine).find((p) => p && !p.github.ok)?.github)
  const actions = useActions()
  useEffect(() => {
    // Abrir a inbox já confere o que mudou (sem gastar o GitHub: o cache dele vale 2 min).
    void refreshInbox()
  }, [])

  // Os períodos, os projetos e as labels que aparecem, para os menus de filtro.
  const options = useMemo(() => {
    const projects = new Map<string, number>()
    const labels = new Map<string, { color: string; n: number }>()
    for (const e of all) {
      const p = projectOf(e)
      projects.set(p, (projects.get(p) ?? 0) + 1)
      for (const l of labelsOf(e)) labels.set(l.name, { color: l.color, n: (labels.get(l.name)?.n ?? 0) + 1 })
    }
    return {
      periods: PERIODS.map((p) => [p, all.filter((e) => inPeriod(e, p, now)).length] as const),
      projects: [...projects].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      labels: [...labels].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])),
    }
  }, [all, now])

  // Busca, período, projeto e label valem para tudo; o tipo (os chips) só escolhe qual grupo aparece.
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter(
      (e) =>
        (!period || inPeriod(e, period, now)) &&
        (!project || projectOf(e) === project) &&
        (!label || labelsOf(e).some((l) => l.name === label)) &&
        (!q || searchText(e).includes(q)),
    )
  }, [all, now, query, period, project, label])

  const { byGroup, seen, snoozed, fresh, counts } = useMemo(() => {
    // "Agora" é a última atualização (a cada 2 min): o adiado volta sozinho quando passa a hora.
    const now = at
    const byGroup = new Map<string, InboxEntry[]>()
    const counts = new Map<InboxGroup, number>()
    const seen: InboxEntry[] = []
    const snoozed: InboxEntry[] = []
    for (const e of entries) {
      const st = statusOf(e, state, now)
      if (st === 'new') counts.set(e.group, (counts.get(e.group) ?? 0) + 1)
      if (group && e.group !== group) continue
      if (st === 'seen') seen.push(e)
      else if (st === 'snoozed') snoozed.push(e)
      else byGroup.set(e.group, [...(byGroup.get(e.group) ?? []), e])
    }
    const fresh = [...byGroup.values()].reduce((n, l) => n + l.length, 0)
    return { byGroup, seen, snoozed, fresh, counts }
  }, [entries, state, at, group])
  const total = [...counts.values()].reduce((n, c) => n + c, 0)
  const filtered = Boolean(query.trim() || period || project || label || group)

  const header = (
    <PageHeader
      title="Inbox"
      // Na aba, o vidro (ou o fundo) fica na faixa toda em volta (ver abaixo); o título segue a coluna.
      className={panel ? 'static mx-auto w-full max-w-3xl bg-transparent backdrop-blur-none' : undefined}
      action={
        <Button variant="ghost" size="icon-sm" onClick={() => void refreshInbox(true)} disabled={loading} aria-label="Atualizar" title={at ? `Atualizada ${relativeTime(at)}` : 'Atualizar'}>
          {loading ? <Loader2 className="animate-spin" /> : <RotateCw />}
        </Button>
      }
    />
  )

  const body = (
    <>
      <div className={cn('space-y-2 px-4 pb-3', panel && 'pt-3')}>
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Buscar por título, projeto, repositório ou label"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 rounded-xl border-transparent bg-foreground/[0.06] pl-9 dark:bg-foreground/[0.06]"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant={period || project || label ? 'secondary' : 'ghost'} size="icon" aria-label="Filtrar por período, projeto ou label" title="Filtrar">
                <ListFilter />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[70dvh] w-64 overflow-y-auto">
              <DropdownMenuLabel>Período</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={period?.key ?? ''} onValueChange={(v) => setPeriod(PERIODS.find((p) => p.key === v) ?? null)}>
                <DropdownMenuRadioItem value="">Qualquer data</DropdownMenuRadioItem>
                {options.periods.map(([p, n]) => (
                  <DropdownMenuRadioItem key={p.key} value={p.key}>
                    <span className="min-w-0 flex-1 truncate">{p.label}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{n}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Projeto</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={project ?? ''} onValueChange={(v) => setProject(v || null)}>
                <DropdownMenuRadioItem value="">Todos</DropdownMenuRadioItem>
                {options.projects.map(([p, n]) => (
                  <DropdownMenuRadioItem key={p} value={p}>
                    <span className="min-w-0 flex-1 truncate">{p}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{n}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {options.labels.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Label</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={label ?? ''} onValueChange={(v) => setLabel(v || null)}>
                    <DropdownMenuRadioItem value="">Todas</DropdownMenuRadioItem>
                    {options.labels.map(([name, l]) => (
                      <DropdownMenuRadioItem key={name} value={name} className="gap-2">
                        <span className="size-2.5 shrink-0 rounded-full" style={{ background: `#${l.color}` }} />
                        <span className="min-w-0 flex-1 truncate">{name}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{l.n}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* Os tipos, com quantos novos cada um tem; tocar no escolhido volta a mostrar tudo. */}
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]">
          <Chip active={!group} onClick={() => setGroup(null)}>
            Tudo <span className="tabular-nums opacity-70">{total}</span>
          </Chip>
          {GROUPS.filter(({ id }) => counts.get(id)).map(({ id, label: name }) => (
            <Chip key={id} active={group === id} onClick={() => setGroup(group === id ? null : id)}>
              {name} <span className="tabular-nums opacity-70">{counts.get(id)}</span>
            </Chip>
          ))}
        </div>
        {(period || project || label) && (
          <div className="flex flex-wrap gap-1.5">
            {period && (
              <Chip active onClick={() => setPeriod(null)}>
                {period.label} <X className="size-3" />
              </Chip>
            )}
            {project && (
              <Chip active onClick={() => setProject(null)}>
                {project} <X className="size-3" />
              </Chip>
            )}
            {label && (
              <Chip active onClick={() => setLabel(null)}>
                {label} <X className="size-3" />
              </Chip>
            )}
          </div>
        )}
      </div>
      {github && !github.ok && (
        <p className="mx-4 mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {github.reason === 'no_gh'
            ? 'Sem o gh (GitHub CLI) no PC: a inbox mostra só os projetos e os TODOs.'
            : github.reason === 'gh_auth'
              ? 'O gh do PC não está logado (gh auth login): a inbox mostra só os projetos e os TODOs.'
              : (github.message ?? 'Não deu para buscar no GitHub agora.')}
        </p>
      )}
      {fresh === 0 && !loading && (
        <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <MessageCircleQuestion className="size-7 text-muted-foreground" />
          <p className="text-sm font-medium">{filtered ? 'Nada com esse filtro' : 'Nada pedindo você'}</p>
          <p className="text-xs text-muted-foreground">
            {filtered ? 'Tire um filtro ou mude a busca.' : 'PRs, issues, mudanças nos projetos, TODOs e conversas esperando você aparecem aqui.'}
          </p>
        </div>
      )}
      {GROUPS.map(({ id, label }) => {
        const list = byGroup.get(id)
        if (!list?.length) return null
        return (
          <section key={id} className="mb-3">
            <div className="flex items-center px-5 pb-1">
              <h2 className="flex-1 text-xs font-medium text-muted-foreground">
                {label} <span className="tabular-nums">{list.length}</span>
              </h2>
              {list.length > 1 && (
                <Button variant="ghost" size="xs" className="-mr-2 text-muted-foreground" onClick={() => actOnInbox(list.map((e) => ({ key: e.key, action: 'seen' as const, mark: e.mark })))}>
                  <Check /> Todos vistos
                </Button>
              )}
            </div>
            <ul className="space-y-0.5">
              {list.map((e) => (
                <Row key={e.key} e={e} status="new" onOpen={() => actions.open(e)} onAsk={() => void actions.ask(e)} />
              ))}
            </ul>
          </section>
        )
      })}
      <div className="pb-4">
        <Folded label="Adiados" entries={snoozed} status="snoozed" actions={actions} />
        <Folded label="Vistos" entries={seen} status="seen" actions={actions} />
      </div>
    </>
  )

  if (!panel)
    return (
      <>
        {header}
        {body}
      </>
    )
  return (
    <div className="flex h-full flex-col">
      {/* O topo fica fora da rolagem: atualizar está sempre à mão, e o vidro (como a aba aberta, ver
          .tab-glass em index.css) não é recalculado a cada quadro de rolagem. */}
      <div className={cn('shrink-0', glass ? 'relative z-10 bg-background/70 backdrop-blur-md' : 'bg-background')}>{header}</div>
      <div className="relative min-h-0 flex-1">
        {/* Com a cena atrás, o escurecido sob a lista devolve contraste ao texto, como na conversa. Fica
            fora do scroller para não rolar junto com a lista. */}
        {scrim !== null && <Veil dim={scrim} />}
        <div className="absolute inset-0 overflow-y-auto [scrollbar-width:thin]">
          <div className="mx-auto w-full max-w-3xl">{body}</div>
        </div>
      </div>
    </div>
  )
}
