import { ChevronRight, Columns2, Plus, Server } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Link, useLocation } from 'wouter'
import { ClaudinhoNameDialog } from '@/components/claudinho-name'
import { DeleteSessionDialog } from '@/components/delete-session-dialog'
import { GitBadges } from '@/components/git-badges'
import { PageHeader } from '@/components/layout'
import { SidebarMeters } from '@/components/sidebar-rail'
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
import { groupByProject, shownSessions, toggleProject, useClosedProjects, useProjectsGit, type ProjectGroup } from '@/lib/project-groups'
import { focusChat, openBeside, useSplit } from '@/lib/split'
import { keyOf, openProjectHub, pinTab, revealChat } from '@/lib/workbench'
import { useStore } from '@/lib/store'
import type { CatalogEntry, GitSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

type OnMenu = (s: CatalogEntry, x: number, y: number) => void

function SessionRow({ s, onMenu }: { s: CatalogEntry; onMenu: OnMenu }) {
  // No PC a lista fica ao lado do chat: as conversas na tela ficam marcadas, a em foco mais forte.
  const split = useSplit()
  const wide = useWide()
  // Botão direito ou dedo segurado: o menu da conversa (apagar).
  const press = usePressMenu((x, y) => onMenu(s, x, y))
  const shown = split.ids.includes(s.sessionId)
  const focused = split.focused === s.sessionId
  return (
    <div
      className="group relative"
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
          'mx-2 flex items-start gap-3 rounded-xl py-2.5 pr-3 pl-1.5 transition-colors select-none [-webkit-touch-callout:none] hover:bg-foreground/[0.04] active:bg-foreground/[0.07]',
          shown && 'bg-foreground/[0.04]',
          // A em foco ganha o destaque da barra lateral (no claro, a cor da janela, como a aba aberta dela).
          focused && 'bg-sidebar-accent shadow-xs hover:bg-sidebar-accent',
        )}
      >
        <SessionInfo s={s} grouped />
      </Link>
      {wide && split.ids.length > 0 && !shown && (
        <Button
          variant="secondary"
          size="icon-sm"
          onClick={() =>
            split.canAdd ? openBeside(s.sessionId) : toast(`Cabem ${split.max} conversas lado a lado nesta tela. Feche uma para abrir outra.`)
          }
          aria-label="Abrir ao lado"
          title="Abrir ao lado"
          className="absolute top-1/2 right-4 -translate-y-1/2 border opacity-0 shadow-sm group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <Columns2 />
        </Button>
      )}
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

/** `sidebar`: na barra lateral do PC, só a lista; as abas ficam na alça e as métricas no pé da barra (ver sidebar-rail.tsx). */
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
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return groupByProject(q ? catalog.filter((c) => `${c.title} ${projectName(c.cwd)}`.toLowerCase().includes(q)) : catalog)
  }, [catalog, query])
  const git = useProjectsGit(groups.map((g) => g.machine))

  return (
    <>
      <PageHeader
        title="Sessões"
        className={sidebar ? 'bg-sidebar/90' : undefined}
        action={
          <Button size="sm" onClick={() => setPicker(true)}>
            <Plus /> Nova
          </Button>
        }
      />
      <MachineFilter className="px-4 pb-3" />
      {/* No celular, as medidas do PC e do Claude no mesmo traço fino da barra lateral, sem cartão. */}
      {!sidebar && <SidebarMeters className="grid grid-cols-2 gap-x-3 px-2 pt-0" />}
      <div className="px-4 pb-3">
        <Input
          type="search"
          placeholder="Buscar por título ou projeto"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Um recorte sem contorno: na barra lateral, no tom do destaque dela; no celular, um pouco mais claro que a janela.
          className={cn(
            'h-9 rounded-xl border-transparent px-3',
            sidebar ? 'bg-sidebar-accent/70' : 'bg-foreground/[0.06] dark:bg-foreground/[0.06]',
          )}
        />
      </div>
      {!loaded ? (
        <div className="space-y-3 px-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <>
          <div className="pb-6">
            {groups.map((g) => (
              <ProjectSection key={g.key} group={g} git={git[g.key]} searching={searching} onMenu={onMenu} />
            ))}
          </div>
          {catalog.length > 0 && groups.length === 0 && <p className="px-4 text-sm text-muted-foreground">Nada encontrado para “{query}”.</p>}
        </>
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
    </>
  )
}
