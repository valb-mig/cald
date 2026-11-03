import { ChevronRight, Plus, Server } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Link, useLocation } from 'wouter'
import { ClaudinhoNameDialog } from '@/components/claudinho-name'
import { DeleteSessionDialog } from '@/components/delete-session-dialog'
import { GitBadges } from '@/components/git-badges'
import { PageHeader } from '@/components/layout'
import { MachineFilter } from '@/components/machine-filter'
import { ProjectPicker } from '@/components/project-picker'
import { SessionInfo } from '@/components/session-info'
import { SessionMenu, type MenuAt } from '@/components/session-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { projectName } from '@/lib/format'
import { usePressMenu, useWide } from '@/lib/hooks'
import { HOME, newChatUrl, useMachineFilter, useMachines } from '@/lib/machines'
import {
  ALL_TAB,
  bySession,
  groupByProject,
  setProjectTab,
  shownSessions,
  toggleProject,
  useClosedProjects,
  useProjectTab,
  useProjectsGit,
  type ProjectGroup,
} from '@/lib/project-groups'
import { focusChat, openBeside, useSplit } from '@/lib/split'
import { keyOf, openProjectHub, pinTab, revealChat } from '@/lib/workbench'
import { useStore } from '@/lib/store'
import type { CatalogEntry, GitSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

type OnMenu = (s: CatalogEntry, x: number, y: number) => void

/**
 * `grouped`: dentro de um projeto, que já diz qual é (na aba de todas, cada uma diz o seu). `roomy`: na
 * lista do celular, a linha maior e sem o recuo do grupo (ver ProjectTabs).
 */
function SessionRow({ s, onMenu, grouped = true, roomy = false }: { s: CatalogEntry; onMenu: OnMenu; grouped?: boolean; roomy?: boolean }) {
  // No PC a lista fica ao lado do chat: as conversas na tela ficam marcadas, a em foco mais forte.
  const split = useSplit()
  const wide = useWide()
  // Botão direito ou dedo segurado: o menu da conversa (apagar).
  const press = usePressMenu((x, y) => onMenu(s, x, y))
  const shown = split.ids.includes(s.sessionId)
  const focused = split.focused === s.sessionId
  return (
    <div
      className="relative"
      // Ctrl/⌘ + clique, como no explorador do VSCode: abre ao lado, num grupo novo. Na captura, antes do
      // link: com a tecla, o Link do wouter deixa o navegador abrir outra aba e nem chama o onClick.
      onClickCapture={(e) => {
        if (!wide || !(e.ctrlKey || e.metaKey)) return
        e.preventDefault()
        e.stopPropagation()
        if (shown) revealChat(s.sessionId)
        else if (split.canAdd) openBeside(s.sessionId)
        else toast(`Cabem ${split.max} conversas lado a lado nesta tela. Feche uma para abrir outra.`)
      }}
    >
      <Link
        href={split.hrefFor(s.sessionId)}
        onClick={(e) => {
          focusChat(s.sessionId)
          if (!shown) return
          e.preventDefault()
          // No PC, já à vista noutro grupo: o grupo dela ganha o foco.
          if (wide) revealChat(s.sessionId)
        }}
        // No PC o clique abre numa aba de prévia; dois cliques a deixam aberta; Ctrl/⌘ abre ao lado.
        onDoubleClick={() => wide && pinTab(keyOf({ kind: 'chat', id: s.sessionId }))}
        aria-current={focused ? 'page' : undefined}
        {...press}
        className={cn(
          // Segurar o dedo não seleciona o texto nem abre o menu de link do iPhone.
          // O claudinho fica embaixo da setinha do grupo, e o título, recuado sob o nome do projeto.
          'mx-2 flex items-start gap-3 rounded-xl transition-colors select-none [-webkit-touch-callout:none] hover:bg-foreground/[0.04] active:bg-foreground/[0.07]',
          roomy ? 'px-2 py-3' : 'py-2.5 pr-3 pl-1.5',
          shown && 'bg-foreground/[0.04]',
          // A em foco ganha o destaque da barra lateral (no claro, a cor da janela, como a aba aberta dela).
          focused && 'bg-sidebar-accent shadow-xs hover:bg-sidebar-accent',
        )}
      >
        <SessionInfo s={s} grouped={grouped} roomy={roomy} />
      </Link>
    </div>
  )
}

/**
 * Um projeto na lista: o cabeçalho (a setinha recolhe e abre o grupo; no PC, o nome abre o hub do
 * projeto; o git dele; o + começa uma conversa nele) e as conversas embaixo. `searching`: com busca,
 * aparece tudo o que achou, recolhido ou não.
 */
function ProjectSection({ group, git, searching, onMenu }: { group: ProjectGroup; git?: GitSummary; searching: boolean; onMenu: OnMenu }) {
  const closed = useClosedProjects((s) => s.keys.includes(group.key)) && !searching
  const [all, setAll] = useState(false)
  // Com várias máquinas, o projeto diz de qual é.
  const machine = useMachines((m) => (m.machines.length > 1 ? m.machines.find((x) => x.id === group.machine)?.name : undefined))
  const wide = useWide()
  const shown = searching ? group.sessions : shownSessions(group, closed, all)
  const hidden = group.sessions.length - shownSessions(group, false, false).length
  return (
    <section className="mb-1.5">
      <div className="group/project mx-2 flex items-center gap-1 rounded-xl pr-1.5 transition-colors hover:bg-foreground/[0.04]">
        <button
          type="button"
          onClick={() => toggleProject(group.key)}
          aria-expanded={!closed}
          aria-label={closed ? `Mostrar as conversas de ${group.name}` : `Recolher ${group.name}`}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight className={cn('size-3.5 transition-transform duration-150', !closed && 'rotate-90')} />
        </button>
        <button
          type="button"
          // No PC, o nome abre o hub do projeto; no celular (sem abas), recolhe e abre, como a setinha.
          onClick={() => (wide && group.cwd ? openProjectHub(group.machine, group.cwd) : toggleProject(group.key))}
          title={wide && group.cwd ? `Abrir o hub de ${group.name}` : group.cwd}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xl py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate text-[13px] font-medium">{group.name}</span>
          {machine && (
            <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
              <Server className="size-3" />
              {machine}
            </span>
          )}
          {git && <GitBadges g={git} />}
        </button>
        {group.waiting > 0 && (
          <span
            className="min-w-4 shrink-0 rounded-full bg-amber-500 px-1 text-center text-[10px] leading-4 font-semibold text-white shadow-[0_0_10px_-1px_rgb(245_158_11/0.8)]"
            title={`${group.waiting} ${group.waiting === 1 ? 'conversa espera' : 'conversas esperam'} você`}
          >
            {group.waiting}
          </span>
        )}
        {/* O total some ao passar o mouse, e o + entra no lugar. */}
        <span className="shrink-0 px-1 text-xs text-muted-foreground tabular-nums group-hover/project:hidden pointer-coarse:hidden">
          {group.sessions.length}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          asChild
          className="hidden group-hover/project:inline-flex focus-visible:inline-flex pointer-coarse:inline-flex"
        >
          <Link href={newChatUrl(group.cwd, group.machine)} aria-label={`Nova conversa em ${group.name}`} title="Nova conversa neste projeto">
            <Plus />
          </Link>
        </Button>
      </div>
      {shown.length > 0 && (
        <div className="mt-0.5 space-y-0.5">
          {shown.map((s) => (
            <SessionRow key={s.sessionId} s={s} onMenu={onMenu} />
          ))}
        </div>
      )}
      {!closed && !searching && hidden > 0 && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="mx-2 mt-0.5 rounded-lg py-1 pr-3 pl-7 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {all ? 'Mostrar menos' : `Mostrar mais ${hidden}`}
        </button>
      )}
    </section>
  )
}

type Tab = { key: string; name: string; waiting: number; group?: ProjectGroup }

/**
 * A ordem das abas, da primeira vez que a lista abriu: os projetos vêm do mais recente, mas não trocam
 * de lugar enquanto ela está na tela (uma conversa trabalhando empurraria o projeto dela para a frente,
 * e a aba fugiria do dedo). Projeto novo entra na frente.
 */
function useStableOrder(keys: string[]): string[] {
  const [order, setOrder] = useState(keys)
  const fresh = keys.filter((k) => !order.includes(k))
  if (!fresh.length) return order
  const next = [...fresh, ...order]
  setOrder(next)
  return next
}

const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * No celular, os projetos em abas, como as pastas de um app de mensagens: a primeira com todas as
 * conversas e uma para cada projeto. Troca tocando na aba ou deslizando a lista para o lado, e o
 * destaque da aba acompanha o dedo. Cada aba rola por conta própria. `order`: os projetos sem a busca,
 * para a ordem não mudar ao buscar.
 */
function ProjectTabs({
  groups,
  order,
  git,
  query,
  onMenu,
}: {
  groups: ProjectGroup[]
  order: string[]
  git: Record<string, GitSummary>
  query: string
  onMenu: OnMenu
}) {
  const machines = useMachines((m) => m.machines)
  const keys = useStableOrder(order)
  const tabs = useMemo(() => {
    const byKey = new Map(groups.map((g) => [g.key, g]))
    // Dois projetos com o mesmo nome (a mesma pasta em outra máquina): a aba diz de qual máquina é.
    const twice = new Set(groups.filter((g, i) => groups.findIndex((o) => o.name === g.name) !== i).map((g) => g.name))
    const label = (g: ProjectGroup) => (twice.has(g.name) ? `${g.name} · ${machines.find((m) => m.id === g.machine)?.name ?? g.machine}` : g.name)
    const projects = keys.flatMap((k): Tab[] => {
      const g = byKey.get(k)
      return g ? [{ key: k, name: label(g), waiting: g.waiting, group: g }] : []
    })
    return [{ key: ALL_TAB, name: 'Todas', waiting: 0 }, ...projects]
  }, [groups, keys, machines])
  const everything = useMemo(() => groups.flatMap((g) => g.sessions).sort(bySession), [groups])

  const active = useProjectTab((s) => s.key)
  // Projeto que sumiu (ou que a busca escondeu): fica na de todas.
  const index = Math.max(0, tabs.findIndex((t) => t.key === active))
  const id = useId()
  const pager = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLSpanElement>(null)
  const tabEls = useRef<(HTMLButtonElement | null)[]>([])
  // O que os observadores de tamanho leem sem refazer a inscrição a cada render.
  const live = useRef({ index, count: tabs.length })
  useLayoutEffect(() => {
    live.current = { index, count: tabs.length }
  })

  /** Põe o destaque na posição `p` do deslize: 1.5 é metade do caminho entre a segunda e a terceira aba. */
  const place = (p: number) => {
    const i = Math.max(0, Math.min(Math.floor(p), live.current.count - 1))
    const a = tabEls.current[i]
    const b = tabEls.current[i + 1] ?? a
    if (!a || !b || !pill.current) return
    const f = p - i
    pill.current.style.width = `${a.offsetWidth + (b.offsetWidth - a.offsetWidth) * f}px`
    pill.current.style.transform = `translateX(${a.offsetLeft + (b.offsetLeft - a.offsetLeft) * f}px)`
  }
  const progress = () => {
    const el = pager.current
    return el?.clientWidth ? Math.max(0, Math.min(el.scrollLeft / el.clientWidth, live.current.count - 1)) : 0
  }

  // Ao abrir e quando as abas mudam (busca, projeto novo): a lista volta para a aba aberta, sem animar.
  const tabKeys = tabs.map((t) => t.key).join('\n')
  useLayoutEffect(() => {
    const el = pager.current
    if (!el) return
    el.scrollLeft = live.current.index * el.clientWidth
    place(live.current.index)
  }, [tabKeys])

  // Girar o celular muda a largura das páginas; uma aba que ganha o número de espera muda o destaque.
  useEffect(() => {
    const el = pager.current
    const tabRow = row.current
    if (!el || !tabRow) return
    const page = new ResizeObserver(() => {
      el.scrollLeft = live.current.index * el.clientWidth
      place(live.current.index)
    })
    const label = new ResizeObserver(() => place(progress()))
    page.observe(el)
    label.observe(tabRow)
    return () => {
      page.disconnect()
      label.disconnect()
    }
  }, [])

  // A aba aberta fica à vista na faixa, no meio quando dá.
  useEffect(() => {
    const el = strip.current
    const tab = tabEls.current[index]
    if (!el || !tab) return
    el.scrollTo({ left: tab.offsetLeft - (el.clientWidth - tab.offsetWidth) / 2, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [index])

  const onScroll = () => {
    const p = progress()
    place(p)
    // A aba muda na metade do caminho, como o destaque.
    const tab = tabs[Math.round(p)]
    if (tab && tab.key !== useProjectTab.getState().key) setProjectTab(tab.key)
  }
  const go = (i: number) => {
    const el = pager.current
    el?.scrollTo({ left: i * el.clientWidth, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }

  return (
    <>
      <div ref={strip} className="shrink-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={row} role="tablist" aria-label="Projetos" className="relative flex w-max min-w-full gap-1 px-3 pb-2">
          <span aria-hidden ref={pill} className="absolute top-0 left-0 h-9 rounded-full bg-foreground/[0.08]" />
          {tabs.map((t, i) => (
            <button
              key={t.key}
              ref={(el) => {
                tabEls.current[i] = el
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${i}`}
              aria-selected={i === index}
              aria-controls={`${id}-page-${i}`}
              onClick={() => go(i)}
              // O peso da letra é o mesmo em todas: trocar o peso mudaria a largura da aba e o destaque sairia dela.
              className={cn(
                'relative flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                i === index ? 'text-foreground' : 'text-muted-foreground active:text-foreground',
              )}
            >
              <span className="max-w-48 truncate">{t.name}</span>
              {t.waiting > 0 && (
                <span
                  className="min-w-4 shrink-0 rounded-full bg-amber-500 px-1 text-center text-[10px] leading-4 font-semibold text-white"
                  aria-label={`${t.waiting} ${t.waiting === 1 ? 'espera' : 'esperam'} você`}
                >
                  {t.waiting}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      {/* O topo esmaece: a lista some aos poucos embaixo das abas, em vez de cortada seco. */}
      <div
        ref={pager}
        onScroll={onScroll}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain [mask-image:linear-gradient(to_bottom,transparent,#000_1rem)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((t, i) => (
          <div
            key={t.key}
            role="tabpanel"
            id={`${id}-page-${i}`}
            aria-labelledby={`${id}-tab-${i}`}
            // Embaixo, espaço para o botão de nova conversa, que flutua por cima da lista.
            className="w-full shrink-0 snap-start snap-always overflow-y-auto pt-3 pb-24"
          >
            {t.group ? <ProjectPage group={t.group} git={git[t.key]} onMenu={onMenu} /> : <AllPage sessions={everything} query={query} onMenu={onMenu} />}
          </div>
        ))}
      </div>
    </>
  )
}

/** A aba de todas as conversas: da mais recente para a mais antiga, cada uma com o seu projeto. */
function AllPage({ sessions, query, onMenu }: { sessions: CatalogEntry[]; query: string; onMenu: OnMenu }) {
  if (!sessions.length) {
    return <p className="px-4 pt-2 text-sm text-muted-foreground">{query.trim() ? `Nada encontrado para “${query}”.` : 'Nenhuma conversa ainda.'}</p>
  }
  return (
    <div className="space-y-0.5">
      {sessions.map((s) => (
        <SessionRow key={s.sessionId} s={s} onMenu={onMenu} grouped={false} roomy />
      ))}
    </div>
  )
}

/** A aba de um projeto: o git e a máquina dele, quando há o que dizer, e todas as conversas dele. */
function ProjectPage({ group, git, onMenu }: { group: ProjectGroup; git?: GitSummary; onMenu: OnMenu }) {
  const machine = useMachines((m) => (m.machines.length > 1 ? m.machines.find((x) => x.id === group.machine)?.name : undefined))
  const badges = git && (git.changed > 0 || git.ahead > 0 || git.behind > 0)
  return (
    <>
      {(machine || badges) && (
        <div className="flex items-center gap-1.5 px-4 pb-2">
          {machine && (
            <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
              <Server className="size-3" />
              {machine}
            </span>
          )}
          {git && <GitBadges g={git} />}
        </div>
      )}
      <div className="space-y-0.5">
        {group.sessions.map((s) => (
          <SessionRow key={s.sessionId} s={s} onMenu={onMenu} roomy />
        ))}
      </div>
    </>
  )
}

/**
 * `sidebar`: na barra lateral do PC, só a lista, com os projetos em grupos que recolhem; as abas ficam
 * na alça e as métricas no pé da barra (ver sidebar-rail.tsx). Fora dela (no celular), os projetos
 * viram abas (ver ProjectTabs).
 */
export function SessionsPage({ sidebar = false }: { sidebar?: boolean } = {}) {
  const all = useStore((s) => s.catalog)
  const loaded = useStore((s) => s.catalogLoaded)
  const filter = useMachineFilter()
  const catalog = useMemo(() => (filter === null ? all : all.filter((c) => (c.machine ?? HOME) === filter)), [all, filter])
  const [query, setQuery] = useState('')
  const [picker, setPicker] = useState(false)
  const [, navigate] = useLocation()
  // Menu e confirmação ficam com a última conversa enquanto fecham, para não esvaziar na animação.
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleting, setDeleting] = useState<CatalogEntry | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [naming, setNaming] = useState<CatalogEntry | null>(null)
  const [namingOpen, setNamingOpen] = useState(false)
  const onMenu: OnMenu = (session, x, y) => {
    setMenu({ session, x, y })
    setMenuOpen(true)
  }

  const searching = query.trim() !== ''
  const projects = useMemo(() => groupByProject(catalog), [catalog])
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? groupByProject(catalog.filter((c) => `${c.title} ${projectName(c.cwd)}`.toLowerCase().includes(q))) : projects
  }, [catalog, projects, query])
  const git = useProjectsGit(groups.map((g) => g.machine))
  // No celular, com a aba de um projeto aberta, o botão de nova conversa já começa nele (dá para trocar na tela dela).
  const tab = useProjectTab((s) => s.key)
  const here = sidebar ? undefined : groups.find((g) => g.key === tab)

  const list = !loaded ? (
    <div className="space-y-3 px-4">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  ) : sidebar ? (
    <>
      <div className="pb-6">
        {groups.map((g) => (
          <ProjectSection key={g.key} group={g} git={git[g.key]} searching={searching} onMenu={onMenu} />
        ))}
      </div>
      {catalog.length > 0 && groups.length === 0 && <p className="px-4 text-sm text-muted-foreground">Nada encontrado para “{query}”.</p>}
    </>
  ) : (
    <ProjectTabs groups={groups} order={projects.map((g) => g.key)} git={git} query={query} onMenu={onMenu} />
  )

  const startNew = () => (here ? navigate(newChatUrl(here.cwd, here.machine)) : setPicker(true))

  return (
    // No celular, a página ocupa a janela e só as abas rolam (ver TabPages, em App.tsx).
    <div className={cn(!sidebar && 'relative flex min-h-0 flex-1 flex-col')}>
      <PageHeader
        title="Sessões"
        // No celular, o cabeçalho não rola (só as abas): sem fundo próprio, a casca por trás.
        className={sidebar ? 'bg-sidebar/90' : 'bg-transparent backdrop-blur-none'}
        action={
          sidebar && (
            <Button size="sm" onClick={() => setPicker(true)}>
              <Plus /> Nova
            </Button>
          )
        }
      />
      <MachineFilter className="px-4 pb-3" />
      <div className={cn('px-4', sidebar ? 'pb-3' : 'pb-2.5')}>
        <Input
          type="search"
          placeholder="Buscar por título ou projeto"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Um recorte sem contorno: na barra lateral, no tom do destaque dela; no celular, um pouco mais claro que a casca.
          className={cn(
            'h-9 rounded-xl border-transparent px-3',
            sidebar ? 'bg-sidebar-accent/70' : 'bg-foreground/[0.06] dark:bg-foreground/[0.06]',
          )}
        />
      </div>
      {list}
      {/* No celular, a conversa nova num botão redondo no canto de baixo, perto do dedo, logo acima das abas. */}
      {!sidebar && (
        <button
          type="button"
          onClick={startNew}
          aria-label={here ? `Nova conversa em ${here.name}` : 'Nova conversa'}
          title={here ? `Nova conversa em ${here.name}` : 'Nova conversa'}
          className="absolute right-4 bottom-4 z-10 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-black/25 transition-transform outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-95"
        >
          <Plus className="size-6" />
        </button>
      )}
      <SessionMenu
        at={menu}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onDelete={(session) => {
          setDeleting(session)
          setConfirmOpen(true)
        }}
        onRename={(session) => {
          setNaming(session)
          setNamingOpen(true)
        }}
      />
      <ClaudinhoNameDialog session={naming} open={namingOpen} onOpenChange={setNamingOpen} />
      {deleting && (
        <DeleteSessionDialog sessionId={deleting.sessionId} title={deleting.title} open={confirmOpen} onOpenChange={setConfirmOpen} />
      )}
      <ProjectPicker
        open={picker}
        onOpenChange={setPicker}
        onPick={(cwd, machine) => navigate(newChatUrl(cwd, machine))}
      />
    </div>
  )
}
