import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronsUpDown,
  CloudUpload,
  Ellipsis,
  FileText,
  GitBranch,
  GitPullRequestCreate,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { UndoBar } from '@/components/claude/bits'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from '@/lib/api'
import { reloadGit, usePressMenu, useWide } from '@/lib/hooks'
import { openViewer, useProjectPanel, type PanelProject } from '@/lib/project-panel'
import type { BranchChanges, GitBranches, GitStatus } from '@/lib/types'
import { cn } from '@/lib/utils'
import { openPanelTab } from '@/lib/workbench'
import { DumpDialog } from './dump-dialog'
import { useFileMenu, type FileMenuAt } from './file-menu'
import { ChangeChip } from './patch-list'
import { badge, BADGES, splitPath, type Badge } from './status'

/** O que a lista mostra: o que ainda não entrou em commit, ou tudo o que a branch mudou desde a principal. */
type Scope = 'head' | 'base'

const SCOPE_KEY = 'cr:git-scope'
const savedScope = (): Scope => {
  try {
    return localStorage.getItem(SCOPE_KEY) === 'base' ? 'base' : 'head'
  } catch {
    return 'head'
  }
}

type Row = { path: string; from?: string; badge: Badge; additions: number | null; deletions: number | null }

/** A branch a apagar: a daqui (`local`), com a do remoto, se houver, ou só a do remoto. */
type Doomed = { branch: string; local: boolean; remote: string | null; ahead: number | null }

/** Por quanto tempo o Desfazer de um descarte fica na lista (o servidor guarda como estava por uma hora). */
const UNDO_MS = 10_000

// O último "Desta branch" de cada projeto: voltar para a aba mostra a lista na hora, e ela se atualiza por trás.
const lastChanges = new Map<string, BranchChanges>()

/** O que a branch mudou desde a principal; relido a cada vez que o git do projeto muda (`status`). */
function useBranchChanges(project: PanelProject, active: boolean, status: GitStatus | null) {
  const key = `${project.machine}\n${project.cwd}`
  const [data, setData] = useState(() => lastChanges.get(key) ?? null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!active) return
    let alive = true
    api.gitChanges(project.machine, project.cwd).then(
      (d) => {
        lastChanges.set(key, d)
        if (alive) {
          setData(d)
          setError(null)
        }
      },
      (err) => alive && setError(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err)),
    )
    return () => {
      alive = false
    }
  }, [key, project.machine, project.cwd, active, status])
  return { data, error }
}

/**
 * Uma linha de arquivo: tocar mostra o diff; abrir o arquivo aparece ao passar o mouse (no toque, sempre).
 * Descartar (`onDiscard`, só no não commitado) também aparece ao passar o mouse; no toque, fica no menu do dedo segurado.
 */
function FileRow({
  row,
  project,
  scope,
  selected,
  onMenu,
  onDiscard,
}: {
  row: Row
  project: PanelProject
  scope: Scope
  selected: boolean
  onMenu: (at: FileMenuAt) => void
  onDiscard?: () => void
}) {
  const { name, dir } = splitPath(row.path)
  const deleted = row.badge.letter === 'D'
  const press = usePressMenu((x, y) => onMenu({ path: row.path, deleted, discard: onDiscard, x, y }))
  const view = { ...project, path: row.path, diff: scope }
  return (
    <div className={cn('group flex min-w-0 items-center hover:bg-muted', selected && 'bg-muted')}>
      <button
        type="button"
        onClick={() => openViewer(view)}
        onDoubleClick={() => openViewer(view, true)}
        // Segurar o dedo abre o menu do arquivo: sem selecionar o texto nem o menu de link do iPhone.
        className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-1 pl-3 text-left text-[13px] select-none [-webkit-touch-callout:none]"
        title={`${row.from ? `${row.from} → ` : ''}${row.path} · ${row.badge.label}`}
        {...press}
      >
        <ChangeChip badge={row.badge} />
        <span className={cn('min-w-0 truncate', deleted && 'line-through decoration-muted-foreground/60')}>{name}</span>
        <span className="min-w-0 shrink-[4] truncate text-[11px] text-muted-foreground">{dir}</span>
      </button>
      {!deleted && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
          onClick={() => openViewer({ ...project, path: row.path })}
          aria-label={`Abrir ${name}`}
          title="Abrir arquivo"
        >
          <FileText />
        </Button>
      )}
      {onDiscard && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-red-600 pointer-coarse:hidden dark:hover:text-red-400"
          onClick={onDiscard}
          aria-label={`Descartar as alterações de ${name}`}
          title="Descartar alterações"
        >
          <Undo2 />
        </Button>
      )}
      {row.additions || row.deletions ? (
        <span className="shrink-0 pr-3 pl-1 font-mono text-[10.5px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{row.additions ?? 0}</span>{' '}
          <span className="text-red-600 dark:text-red-400">−{row.deletions ?? 0}</span>
        </span>
      ) : (
        <span className="w-3 shrink-0" />
      )}
    </div>
  )
}

/**
 * Controle de código-fonte do jeito do seu fluxo, e não do VSCode: em cima, as alterações (o que não
 * entrou em commit, ou tudo o que a branch mudou desde a principal), com busca; embaixo, a branch, para
 * trocar ou criar outra, e o pull do origin. Commit, PR e merge ficam para o Claude, na conversa.
 */
export function SourceControlTab({ project, status, loading }: { project: PanelProject; status: GitStatus | null; loading: boolean }) {
  const [scope, setScopeState] = useState<Scope>(savedScope)
  const setScope = (next: Scope) => {
    try {
      localStorage.setItem(SCOPE_KEY, next)
    } catch {
      // localStorage indisponível (modo privado): vale só nesta tela.
    }
    setScopeState(next)
  }
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<'pull' | 'switch' | 'branch' | 'reload' | 'delete' | 'dump' | 'discard' | null>(null)
  // O dump esperando a confirmação (ver dump-dialog.tsx).
  const [dumping, setDumping] = useState(false)
  const [branches, setBranches] = useState<GitBranches | null>(null)
  const [branchesError, setBranchesError] = useState<string | null>(null)
  // O nome da branch nova em edição, no lugar da barra de baixo; `null` com ela fechada.
  const [newBranch, setNewBranch] = useState<string | null>(null)
  const [picker, setPicker] = useState(false)
  // A branch esperando a confirmação para apagar, e se vai junto a do remoto.
  const [doomed, setDoomed] = useState<Doomed | null>(null)
  const [alsoRemote, setAlsoRemote] = useState(false)
  // Os arquivos esperando a confirmação para descartar todos (ou todos os do filtro).
  const [discarding, setDiscarding] = useState<{ rows: Row[]; filtered: boolean } | null>(null)
  // O último descarte, com o Desfazer na própria lista: no celular a barra é uma folha, e um aviso ficaria fora dela, sem clique.
  const [undone, setUndone] = useState<{ id: string; text: string } | null>(null)
  useEffect(() => {
    if (!undone) return
    const timer = setTimeout(() => setUndone(null), UNDO_MS)
    return () => clearTimeout(timer)
  }, [undone])
  const branchChanges = useBranchChanges(project, scope === 'base', status)
  const viewing = useProjectPanel((s) => s.viewing)
  const menu = useFileMenu(project)
  // A aba de abrir PR é do PC: no celular, os PRs abrem no GitHub.
  const wide = useWide()

  const loadBranches = (fetch = false) =>
    api.gitBranches(project.machine, project.cwd, fetch).then(
      (b) => {
        setBranches(b)
        setBranchesError(null)
      },
      (err) => setBranchesError(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err)),
    )

  // Ao abrir a aba, consulta o origin por trás (no máximo a cada 10 min): o ↓ do pull e as branches de lá ficam em dia.
  useEffect(() => {
    void loadBranches(true).then(() => reloadGit(project.machine, project.cwd))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.machine, project.cwd])

  const rows = useMemo<Row[] | null>(() => {
    if (scope === 'head') {
      return (status?.files ?? []).map((f) => ({ path: f.path, from: f.from, badge: badge(f), additions: f.additions, deletions: f.deletions }))
    }
    return branchChanges.data?.files.map((f) => ({ ...f, badge: BADGES[f.letter] })) ?? null
  }, [scope, status, branchChanges.data])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? rows?.filter((r) => r.path.toLowerCase().includes(q)) : rows
  }, [rows, query])

  if (!status) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {loading ? <Loader2 className="size-5 animate-spin" /> : 'Este projeto não usa git.'}
      </div>
    )
  }

  const branch = status.branch ?? 'HEAD destacado'
  const base = branchChanges.data?.base ?? branches?.base ?? 'main'

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<unknown>) => {
    setBusy(kind)
    try {
      await action()
    } catch (err) {
      toast.error('O git não fez', { description: errorMessage(err) })
    } finally {
      await reloadGit(project.machine, project.cwd)
      setBusy(null)
    }
  }

  const switchTo = (name: string) =>
    run('switch', async () => {
      await api.gitSwitch(project.machine, project.cwd, name)
      toast.success(`Agora na branch ${name}`)
      void loadBranches()
    })

  const createBranch = () => {
    const name = newBranch?.trim()
    if (!name || busy) return
    void run('branch', async () => {
      await api.gitBranch(project.machine, project.cwd, name)
      setNewBranch(null)
      toast.success(`Agora na branch ${name}`, { description: status.files.length ? 'As alterações vieram junto.' : undefined })
      void loadBranches()
    })
  }

  // Onde fica o remoto, para os textos de apagar: quase sempre o GitHub.
  const host = status.remote && new URL(status.remote).hostname === 'github.com' ? 'GitHub' : 'origin'

  const askDelete = (d: Doomed) => {
    setPicker(false)
    // Já toda na principal (um PR que entrou), o comum é apagar lá também; com commits só dela, não.
    setAlsoRemote(d.ahead === 0)
    setDoomed(d)
  }

  const remove = (d: Doomed) => {
    const remote = d.local ? alsoRemote && d.remote !== null : true
    void run('delete', async () => {
      await api.gitDeleteBranch(project.machine, project.cwd, d.branch, d.local, remote)
      toast.success(d.local ? `Branch ${d.branch} apagada${remote ? ` aqui e no ${host}` : ''}` : `${d.branch} apagada no ${host}`)
      void loadBranches()
    })
  }

  const pull = () =>
    run('pull', async () => {
      const { commits } = await api.gitPull(project.machine, project.cwd)
      toast.success(commits ? `${commits} ${commits === 1 ? 'commit trazido' : 'commits trazidos'} do ${status.upstream}` : 'Já estava em dia com o origin')
    })

  /** O dump: tudo num commit só e direto para o origin (traz o que chegou antes, só avançando). */
  const runDump = (message: string) => {
    setDumping(false)
    void run('dump', async () => {
      const { sha } = await api.gitCommit(project.machine, project.cwd, message, true)
      await api.gitSync(project.machine, project.cwd)
      toast.success(`Dump ${sha} em ${status.upstream ?? `origin/${branch}`}`, { description: message.split('\n')[0] })
    })
  }

  /** Volta os arquivos ao último commit (os novos somem), com Desfazer logo em seguida. */
  const discard = (paths: string[]) => {
    setDiscarding(null)
    if (busy) return
    void run('discard', async () => {
      const { undo, files } = await api.gitDiscard(project.machine, project.cwd, paths)
      setUndone({ id: undo, text: paths.length === 1 ? `${splitPath(paths[0]!).name} descartado` : `${files} arquivos descartados` })
    })
  }

  const undoDiscard = (id: string) => {
    setUndone(null)
    void run('discard', () => api.gitUndoDiscard(project.machine, project.cwd, id))
  }

  // Com o filtro, "descartar todas" é só as que ele mostra.
  const filtered = Boolean(shown && rows && shown.length < rows.length)
  const selected = viewing?.machine === project.machine && viewing.cwd === project.cwd && viewing.diff === scope ? viewing.path : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 py-1 pr-1 pl-3">
        <span className="text-xs font-medium">Alterações</span>
        {rows && rows.length > 0 && <span className="min-w-5 rounded-full bg-muted px-1.5 text-center text-[11px] leading-5 tabular-nums">{rows.length}</span>}
        <span className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="xs" className="gap-1 text-muted-foreground" title="O que a lista mostra">
              {scope === 'head' ? 'Não commitado' : `vs ${base}`}
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuRadioGroup value={scope} onValueChange={(v) => setScope(v as Scope)}>
              <DropdownMenuRadioItem value="head" className="flex-col items-start gap-0">
                <span>Não commitado</span>
                <span className="text-xs text-muted-foreground">O que ainda não entrou em commit</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="base" className="flex-col items-start gap-0">
                <span>Desta branch</span>
                <span className="text-xs text-muted-foreground">Tudo desde {base}: commits e não commitado</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {scope === 'head' && shown && shown.length > 0 && (
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy !== null}
            onClick={() => setDiscarding({ rows: shown, filtered })}
            aria-label={filtered ? 'Descartar as filtradas' : 'Descartar todas'}
            title={filtered ? 'Descartar as alterações filtradas' : 'Descartar todas as alterações'}
          >
            {busy === 'discard' ? <Loader2 className="animate-spin" /> : <Undo2 />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={busy !== null}
          onClick={() => void run('reload', () => loadBranches())}
          aria-label="Atualizar"
          title="Atualizar"
        >
          <RefreshCw className={cn(busy === 'reload' && 'animate-spin')} />
        </Button>
      </div>

      {rows && rows.length > 0 && (
        <div className="shrink-0 px-3 pb-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              placeholder="Filtrar arquivos"
              aria-label="Filtrar arquivos"
              spellCheck={false}
              className="h-7 pl-7 text-xs md:text-xs"
            />
          </div>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {scope === 'base' && branchChanges.error ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">{branchChanges.error}</p>
          ) : !shown ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : rows?.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {scope === 'head' ? 'Nada alterado.' : branchChanges.data?.base ? `Nada fora da ${branchChanges.data.base}.` : 'Não achei a main (nem a master) para comparar.'}
            </p>
          ) : shown.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Nenhum arquivo com “{query.trim()}”.</p>
          ) : (
            shown.map((r) => (
              <FileRow
                key={r.path}
                row={r}
                project={project}
                scope={scope}
                selected={selected === r.path}
                onMenu={menu.show}
                onDiscard={scope === 'head' ? () => discard([r.path]) : undefined}
              />
            ))
          )}
          {menu.menu}
        </div>
        {undone && (
          <div className="absolute inset-x-2 bottom-2">
            <UndoBar text={undone.text} onUndo={() => undoDiscard(undone.id)} />
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {newBranch !== null ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault()
              createBranch()
            }}
          >
            <Input
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setNewBranch(null)}
              placeholder="nome-da-branch"
              aria-label="Nome da branch nova"
              autoFocus
              spellCheck={false}
              className="h-7 font-mono text-xs md:text-xs"
            />
            <Button type="submit" size="icon-sm" disabled={busy !== null || !newBranch.trim()} aria-label="Criar a branch" title="Criar e passar para ela, levando as alterações">
              {busy === 'branch' ? <Loader2 className="animate-spin" /> : <Check />}
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setNewBranch(null)} aria-label="Cancelar" title="Cancelar">
              <X />
            </Button>
          </form>
        ) : (
          <>
            <DropdownMenu
              open={picker}
              onOpenChange={(open) => {
                setPicker(open)
                if (open) void loadBranches()
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy === 'switch' || busy === 'delete'}
                  className="min-w-0 shrink justify-start gap-1.5 px-2 font-mono text-xs"
                  title={status.upstream ? `${branch} → ${status.upstream}` : branch}
                >
                  {busy === 'switch' || busy === 'delete' ? <Loader2 className="animate-spin" /> : <GitBranch />}
                  <span className="min-w-0 truncate">{branch}</span>
                  <ChevronsUpDown className="text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="max-h-[min(60vh,28rem)] w-72 overflow-y-auto">
                <DropdownMenuItem onSelect={() => setNewBranch('')}>
                  <Plus /> Nova branch…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <BranchList branches={branches} error={branchesError} onPick={(name) => void switchTo(name)} onDelete={askDelete} />
              </DropdownMenuContent>
            </DropdownMenu>
            {status.upstream && (status.ahead > 0 || status.behind > 0) && (
              <span
                className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums"
                title={`${status.behind} para trazer e ${status.ahead} para enviar (${status.upstream})`}
              >
                <ArrowDown className="size-3" />
                {status.behind}
                <ArrowUp className="size-3" />
                {status.ahead}
              </span>
            )}
            <span className="flex-1" />
            {/* O que se faz com a branch: abrir PR, pull e o dump, num menu só. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" disabled={busy !== null} aria-label="Mais ações da branch" title="Abrir PR, pull e dump">
                  {busy === 'pull' || busy === 'dump' ? <Loader2 className="animate-spin" /> : <Ellipsis />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" className="w-64">
                {wide && status.remote && new URL(status.remote).hostname === 'github.com' && (
                  <DropdownMenuItem onSelect={() => openPanelTab({ kind: 'pr-new', machine: project.machine, cwd: project.cwd })}>
                    <GitPullRequestCreate /> Abrir PR
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem disabled={!status.upstream} onSelect={() => void pull()}>
                  <ArrowDownToLine /> Pull
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {status.upstream ? (status.behind > 0 ? `${status.behind} para trazer` : '') : 'sem origin'}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem disabled={status.files.length === 0} onSelect={() => setDumping(true)}>
                  <CloudUpload /> Dump
                  <span className="ml-auto text-xs text-muted-foreground">
                    {status.files.length ? `${status.files.length} ${status.files.length === 1 ? 'arquivo' : 'arquivos'}` : 'nada alterado'}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      <DumpDialog
        open={dumping}
        onOpenChange={setDumping}
        machine={project.machine}
        cwd={project.cwd}
        files={status.files}
        branch={branch}
        target={status.upstream ?? `origin/${branch}`}
        onConfirm={runDump}
      />

      <AlertDialog open={discarding !== null} onOpenChange={(open) => !open && setDiscarding(null)}>
        {discarding && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{discarding.filtered ? `Descartar os ${discarding.rows.length} filtrados?` : 'Descartar todas as alterações?'}</AlertDialogTitle>
              <AlertDialogDescription>{discardNote(discarding.rows)}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => discard(discarding.rows.map((r) => r.path))}>
                Descartar
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>

      <AlertDialog open={doomed !== null} onOpenChange={(open) => !open && setDoomed(null)}>
        {doomed && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="break-words">
                {doomed.local ? `Apagar a branch ${doomed.branch}?` : `Apagar ${doomed.branch} no ${host}?`}
              </AlertDialogTitle>
              <AlertDialogDescription>{deleteNote(doomed, doomed.local && alsoRemote, base, host)}</AlertDialogDescription>
            </AlertDialogHeader>
            {doomed.local && doomed.remote && (
              <label className="flex items-center gap-2.5 text-sm">
                <Checkbox checked={alsoRemote} onCheckedChange={(v) => setAlsoRemote(v === true)} />
                <span className="min-w-0">
                  Apagar também no {host} <span className="font-mono text-xs break-all text-muted-foreground">{doomed.remote}</span>
                </span>
              </label>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => remove(doomed)}>
                Apagar
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  )
}

/** O que o descarte faz: quantos voltam ao último commit e quantos, nunca commitados, são apagados. */
function discardNote(rows: Row[]): string {
  const fresh = rows.filter((r) => r.badge.letter === 'U' || r.badge.letter === 'A').length
  const back = rows.length - fresh
  const parts = [
    back > 0 && `${back} ${back === 1 ? 'volta' : 'voltam'} ao último commit`,
    fresh > 0 && `${fresh} ${fresh === 1 ? 'novo é apagado' : 'novos são apagados'}`,
  ].filter(Boolean)
  return `${parts.join(' e ')}. Dá para desfazer logo depois.`
}

/** O que se perde ao apagar: os commits que só a branch tem, e se eles continuam no remoto. */
function deleteNote(d: Doomed, alsoRemote: boolean, base: string, host: string): string {
  if (!d.local) return `Ela só existe no ${host} (${d.remote}). Apagando lá, some de vez.`
  if (d.ahead === 0) return `Todos os commits dela já estão na ${base}: nada se perde.`
  const kept = d.remote && !alsoRemote ? ` Eles continuam no ${host}.` : ' Apagando, eles se perdem.'
  if (d.ahead === null) return `Não deu para saber se os commits dela já estão na ${base}.${kept}`
  return `${d.ahead} ${d.ahead === 1 ? 'commit dela não está' : 'commits dela não estão'} na ${base}.${kept}`
}

/** A lixeira de uma branch, dentro do item do dropdown: tocar nela não troca para a branch. */
function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  // O item do menu escolhe no clique e no soltar do ponteiro: nada disso pode chegar até ele.
  const stop = (e: React.SyntheticEvent) => {
    e.stopPropagation()
    e.preventDefault()
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={stop}
      onPointerUp={stop}
      onClick={(e) => {
        stop(e)
        onClick()
      }}
      className="-my-1 -mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 group-hover/branch:opacity-100 group-data-[highlighted]/branch:opacity-100 pointer-coarse:opacity-100 hover:bg-foreground/10 hover:text-red-600 dark:hover:text-red-400"
    >
      <Trash2 className="size-3.5" />
    </button>
  )
}

/** As branches do dropdown: as locais, com quantos commits cada uma tem fora da principal, e as que só estão no origin. */
function BranchList({
  branches,
  error,
  onPick,
  onDelete,
}: {
  branches: GitBranches | null
  error: string | null
  onPick: (name: string) => void
  onDelete: (d: Doomed) => void
}) {
  if (error && !branches) return <p className="px-2 py-1.5 text-xs text-muted-foreground">{error}</p>
  if (!branches) {
    return (
      <div className="flex justify-center py-3">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    )
  }
  // A principal não tem lixeira: apagá-la por um toque errado seria o pior engano daqui.
  const main = branches.base?.replace(/^[^/]+\//, '')
  return (
    <>
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Trocar de branch</DropdownMenuLabel>
      {branches.local.map((b) => (
        <DropdownMenuItem
          key={b.name}
          disabled={b.current || b.worktree !== null}
          onSelect={() => onPick(b.name)}
          title={b.worktree ? `Aberta em outro worktree (${b.worktree})` : undefined}
          className="group/branch gap-2 data-[disabled]:opacity-100"
        >
          <Check className={cn('shrink-0', !b.current && 'invisible')} />
          <span className={cn('min-w-0 flex-1 truncate font-mono text-xs', b.worktree && 'text-muted-foreground')}>{b.name}</span>
          {b.worktree && <span className="shrink-0 text-[11px] text-muted-foreground">worktree</span>}
          {b.ahead ? (
            <span
              className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground tabular-nums"
              title={`${b.ahead} ${b.ahead === 1 ? 'commit' : 'commits'} fora da ${branches.base}`}
            >
              <span className="size-1.5 rounded-full bg-sky-500" />
              {b.ahead}
            </span>
          ) : null}
          {!b.current && !b.worktree && b.name !== main && (
            <DeleteButton label={`Apagar a branch ${b.name}`} onClick={() => onDelete({ branch: b.name, local: true, remote: b.remote, ahead: b.ahead })} />
          )}
        </DropdownMenuItem>
      ))}
      {branches.remote.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Só no origin</DropdownMenuLabel>
          {branches.remote.map((r) => (
            <DropdownMenuItem key={r.name} onSelect={() => onPick(r.branch)} className="group/branch gap-2" title={`Cria a ${r.branch} local, seguindo a ${r.name}`}>
              <span className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{r.branch}</span>
              <DeleteButton label={`Apagar ${r.name}`} onClick={() => onDelete({ branch: r.branch, local: false, remote: r.name, ahead: null })} />
            </DropdownMenuItem>
          ))}
        </>
      )}
    </>
  )
}
