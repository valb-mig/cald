import { ArrowDown, ArrowDownUp, ArrowUp, Check, ChevronRight, CloudUpload, FileText, GitBranch, Loader2, Minus, Plus, RefreshCw } from 'lucide-react'
import { createElement, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api, errorMessage } from '@/lib/api'
import { reloadGit, usePressMenu } from '@/lib/hooks'
import { openViewer, useProjectPanel, type PanelProject } from '@/lib/project-panel'
import type { DiffSide, GitFile, GitStatus } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useFileMenu, type FileMenuAt } from './file-menu'
import { badge, fileIcon, isStaged, isUnstaged, splitPath } from './status'

// A mensagem em andamento de cada projeto: trocar de conversa ou de aba não a perde.
const drafts = new Map<string, string>()
// Seções recolhidas, como no VSCode.
const folded = new Set<DiffSide>()

/** Uma linha de arquivo: tocar mostra o diff do lado dela; as ações aparecem ao passar o mouse (no toque, sempre). */
function FileRow({
  file,
  side,
  project,
  selected,
  busy,
  onToggle,
  onMenu,
}: {
  file: GitFile
  side: DiffSide
  project: PanelProject
  selected: boolean
  busy: boolean
  onToggle: () => void
  onMenu: (at: FileMenuAt) => void
}) {
  const { name, dir } = splitPath(file.path)
  const b = badge(file, side)
  const lines = side === 'staged' ? file.staged : file.unstaged
  const deleted = b.letter === 'D'
  const press = usePressMenu((x, y) => onMenu({ path: file.path, deleted, x, y }))
  return (
    <div className={cn('group flex min-w-0 items-center hover:bg-muted', selected && 'bg-muted')}>
      <button
        type="button"
        onClick={() => openViewer({ ...project, path: file.path, diff: side })}
        onDoubleClick={() => openViewer({ ...project, path: file.path, diff: side }, true)}
        // Segurar o dedo abre o menu do arquivo: sem selecionar o texto nem o menu de link do iPhone.
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 pl-5 text-left text-[13px] select-none [-webkit-touch-callout:none]"
        title={`${file.path} · ${b.label}`}
        {...press}
      >
        {createElement(fileIcon(name), { className: 'size-4 shrink-0 text-muted-foreground' })}
        <span className={cn('shrink-0 truncate', deleted && 'line-through decoration-muted-foreground/60')}>{name}</span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{dir}</span>
      </button>
      <div className="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
        {!deleted && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => openViewer({ ...project, path: file.path })}
            aria-label={`Abrir ${name}`}
            title="Abrir arquivo"
          >
            <FileText />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          onClick={onToggle}
          aria-label={side === 'staged' ? `Tirar ${name} da preparação` : `Preparar ${name}`}
          title={side === 'staged' ? 'Tirar da preparação' : 'Preparar (stage)'}
        >
          {side === 'staged' ? <Minus /> : <Plus />}
        </Button>
      </div>
      {lines && (lines.additions || lines.deletions) ? (
        <span className="shrink-0 pr-1 font-mono text-[10.5px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{lines.additions ?? 0}</span>{' '}
          <span className="text-red-600 dark:text-red-400">−{lines.deletions ?? 0}</span>
        </span>
      ) : null}
      <span className={cn('w-5 shrink-0 pr-2 text-center font-mono text-[11px] font-semibold', b.className)}>{b.letter}</span>
    </div>
  )
}

function Section({
  side,
  files,
  project,
  busy,
  selected,
  onStage,
  onMenu,
}: {
  side: DiffSide
  files: GitFile[]
  project: PanelProject
  busy: boolean
  selected: string | null
  onStage: (paths: string[], stage: boolean) => void
  onMenu: (at: FileMenuAt) => void
}) {
  const [open, setOpen] = useState(!folded.has(side))
  const toggle = () => {
    if (open) folded.add(side)
    else folded.delete(side)
    setOpen(!open)
  }
  const staged = side === 'staged'
  return (
    <div>
      <div className="group flex items-center gap-1 pr-2 hover:bg-muted/60">
        <button type="button" onClick={toggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1 py-1 pl-1 text-left text-xs font-medium">
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className="truncate">{staged ? 'Alterações preparadas' : 'Alterações'}</span>
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
          onClick={() =>
            onStage(
              files.map((f) => f.path),
              !staged,
            )
          }
          aria-label={staged ? 'Tirar tudo da preparação' : 'Preparar tudo'}
          title={staged ? 'Tirar tudo da preparação' : 'Preparar tudo'}
        >
          {staged ? <Minus /> : <Plus />}
        </Button>
        <span className="min-w-5 rounded-full bg-muted px-1.5 text-center text-[11px] leading-5 tabular-nums">{files.length}</span>
      </div>
      {open &&
        files.map((f) => (
          <FileRow
            key={f.path}
            file={f}
            side={side}
            project={project}
            selected={selected === `${side}\n${f.path}`}
            busy={busy}
            onToggle={() => onStage([f.path], !staged)}
            onMenu={onMenu}
          />
        ))}
    </div>
  )
}

/**
 * Controle de código-fonte, como no VSCode: a branch e a sincronização com o remoto, a mensagem e o
 * commit, e as listas do que está preparado e do que não está. Descartar alterações fica de fora.
 */
export function SourceControlTab({ project, status, loading }: { project: PanelProject; status: GitStatus | null; loading: boolean }) {
  const key = `${project.machine}\n${project.cwd}`
  const [message, setMessageState] = useState(() => drafts.get(key) ?? '')
  const setMessage = (text: string) => {
    drafts.set(key, text)
    setMessageState(text)
  }
  const [busy, setBusy] = useState<'commit' | 'sync' | 'stage' | 'reload' | null>(null)
  const viewing = useProjectPanel((s) => s.viewing)
  const menu = useFileMenu(project)
  const selected =
    viewing?.machine === project.machine && viewing.cwd === project.cwd && viewing.diff ? `${viewing.diff}\n${viewing.path}` : null

  if (!status) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {loading ? <Loader2 className="size-5 animate-spin" /> : 'Este projeto não usa git.'}
      </div>
    )
  }

  const staged = status.files.filter(isStaged)
  const changes = status.files.filter(isUnstaged)
  const all = staged.length === 0
  const branch = status.branch ?? 'HEAD destacado'

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<unknown>, done?: string) => {
    setBusy(kind)
    try {
      await action()
      if (done) toast.success(done)
    } catch (err) {
      toast.error('O git não fez', { description: errorMessage(err) })
    } finally {
      await reloadGit(project.machine, project.cwd)
      setBusy(null)
    }
  }

  const stage = (paths: string[], add: boolean) =>
    run('stage', () => (add ? api.gitStage : api.gitUnstage)(project.machine, project.cwd, paths))

  const commit = () => {
    const text = message.trim()
    if (!text || busy || status.files.length === 0) return
    void run('commit', async () => {
      const { sha } = await api.gitCommit(project.machine, project.cwd, text, all)
      setMessage('')
      toast.success(`Commit ${sha} em ${branch}`, { description: text.split('\n')[0] })
    })
  }

  const sync = () =>
    run('sync', () => api.gitSync(project.machine, project.cwd), status.upstream ? 'Sincronizado com o remoto' : `Branch ${branch} publicada`)

  // Sem nada para o commit, o botão grande vira o de enviar o que falta (como o "Sync Changes" do VSCode).
  const syncFirst = status.files.length === 0 && status.branch && (!status.upstream || status.ahead > 0 || status.behind > 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 py-1 pr-1 pl-3">
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-xs" title={status.upstream ? `${branch} → ${status.upstream}` : branch}>
          {branch}
        </span>
        {status.upstream && (status.ahead > 0 || status.behind > 0) && (
          <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums">
            <ArrowDown className="size-3" />
            {status.behind}
            <ArrowUp className="size-3" />
            {status.ahead}
          </span>
        )}
        <span className="flex-1" />
        {status.branch && (
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy !== null}
            onClick={() => void sync()}
            aria-label={status.upstream ? 'Sincronizar com o remoto' : 'Publicar branch'}
            title={status.upstream ? `Sincronizar: trazer ${status.behind} e enviar ${status.ahead}` : 'Publicar branch no origin'}
          >
            {busy === 'sync' ? <Loader2 className="animate-spin" /> : status.upstream ? <ArrowDownUp /> : <CloudUpload />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={busy !== null}
          onClick={() => void run('reload', () => Promise.resolve())}
          aria-label="Atualizar"
          title="Atualizar"
        >
          <RefreshCw className={cn(busy === 'reload' && 'animate-spin')} />
        </Button>
      </div>

      <div className="shrink-0 space-y-2 px-3 pb-2">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              commit()
            }
          }}
          placeholder="Mensagem do commit (Ctrl+Enter)"
          aria-label="Mensagem do commit"
          rows={1}
          className="max-h-40 min-h-9 resize-none py-1.5 text-[13px] md:text-[13px]"
        />
        {syncFirst ? (
          <Button className="w-full" variant="secondary" disabled={busy !== null} onClick={() => void sync()}>
            {busy === 'sync' ? <Loader2 className="animate-spin" /> : status.upstream ? <ArrowDownUp /> : <CloudUpload />}
            {status.upstream ? `Sincronizar ${status.behind}↓ ${status.ahead}↑` : 'Publicar branch'}
          </Button>
        ) : (
          <Button
            className="w-full"
            disabled={busy !== null || !message.trim() || status.files.length === 0}
            onClick={commit}
            title={all ? 'Nada preparado: prepara todas as alterações e faz o commit' : undefined}
          >
            {busy === 'commit' ? <Loader2 className="animate-spin" /> : <Check />}
            {all && status.files.length > 0 ? `Commit de tudo (${status.files.length})` : 'Commit'}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        {status.files.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">Nada alterado.</p>}
        {staged.length > 0 && (
          <Section
            side="staged"
            files={staged}
            project={project}
            busy={busy !== null}
            selected={selected}
            onStage={(p, add) => void stage(p, add)}
            onMenu={menu.show}
          />
        )}
        {changes.length > 0 && (
          <Section
            side="unstaged"
            files={changes}
            project={project}
            busy={busy !== null}
            selected={selected}
            onStage={(p, add) => void stage(p, add)}
            onMenu={menu.show}
          />
        )}
        {menu.menu}
      </div>
    </div>
  )
}

