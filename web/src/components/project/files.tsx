import { ChevronRight, ChevronsDownUp, FileSearch, Folder, FolderOpen, Loader2, RefreshCw } from 'lucide-react'
import { createElement, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api, errorMessage } from '@/lib/api'
import { usePressMenu } from '@/lib/hooks'
import { projectName } from '@/lib/format'
import { openViewer, useProjectPanel, type PanelProject } from '@/lib/project-panel'
import type { GitStatus, TreeEntry } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useFileMenu, type FileMenuAt } from './file-menu'
import { openQuickOpen } from './quick-open'
import { fileIcon, treeMarks, type Badge } from './status'

// Pastas abertas por projeto: trocar de aba, fechar e reabrir a barra mantém a árvore como estava.
const expanded = new Set<string>()
// Segurar o dedo abre o menu do arquivo: sem selecionar o texto nem o menu de link do iPhone.
const rowClass =
  'flex w-full min-w-0 items-center gap-1.5 py-1 pr-2 text-left text-[13px] select-none [-webkit-touch-callout:none] hover:bg-muted active:bg-muted'
const indent = (depth: number) => ({ paddingLeft: 8 + depth * 12 })

type TreeProps = {
  project: PanelProject
  /** Muda para reler as pastas abertas (o Claude terminou um turno, o botão de atualizar). */
  version: number
  marks: Map<string, Badge>
  /** O arquivo aberto agora por cima da conversa, para ficar marcado na árvore. */
  selected: string | null
  /** Botão direito ou dedo segurado num arquivo ou pasta: o menu dele (mencionar no chat...). */
  onMenu: (at: FileMenuAt) => void
}

function TreeLevel({ path, depth, ...props }: TreeProps & { path: string; depth: number }) {
  const { machine, cwd } = props.project
  const [entries, setEntries] = useState<TreeEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // Ao reler, o que já estava fica na tela até o novo chegar: nada de a árvore piscar a cada turno.
    api.tree(machine, cwd, path).then(
      (e) => {
        if (!alive) return
        setEntries(e)
        setError(null)
      },
      (err) => alive && setError(errorMessage(err)),
    )
    return () => {
      alive = false
    }
  }, [machine, cwd, path, props.version])

  if (error && !entries) return <p className="py-1 text-xs text-red-600 dark:text-red-400" style={indent(depth + 1)}>{error}</p>
  if (!entries) {
    return (
      <div className="py-1.5" style={indent(depth + 1)}>
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (entries.length === 0) return <p className="py-1 text-xs text-muted-foreground" style={indent(depth + 1)}>vazia</p>
  return entries.map((e) =>
    e.type === 'dir' ? <DirNode key={e.path} entry={e} depth={depth} {...props} /> : <FileNode key={e.path} entry={e} depth={depth} {...props} />,
  )
}

function FileNode({ entry, depth, ...props }: TreeProps & { entry: TreeEntry; depth: number }) {
  const { machine, cwd } = props.project
  const mark = props.marks.get(entry.path)
  const press = usePressMenu((x, y) => props.onMenu({ path: entry.path, x, y }))
  return (
    <button
      type="button"
      className={cn(rowClass, props.selected === entry.path && 'bg-muted')}
      style={indent(depth + 1)}
      onClick={() => openViewer({ machine, cwd, path: entry.path })}
      // Dois cliques: a aba fica (no PC; o clique abre como prévia).
      onDoubleClick={() => openViewer({ machine, cwd, path: entry.path }, true)}
      title={mark ? `${entry.path} · ${mark.label}` : entry.path}
      {...press}
    >
      {createElement(fileIcon(entry.name), { className: 'size-4 shrink-0 text-muted-foreground' })}
      <span className={cn('min-w-0 flex-1 truncate', entry.ignored && 'opacity-50', mark?.className)}>{entry.name}</span>
      {mark && <span className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-semibold', mark.className)}>{mark.letter}</span>}
    </button>
  )
}

function DirNode({ entry, depth, ...props }: TreeProps & { entry: TreeEntry; depth: number }) {
  const key = `${props.project.machine}\n${props.project.cwd}\n${entry.path}`
  const [open, setOpen] = useState(expanded.has(key))
  const toggle = () => {
    if (open) expanded.delete(key)
    else expanded.add(key)
    setOpen(!open)
  }
  const mark = props.marks.get(entry.path)
  const press = usePressMenu((x, y) => props.onMenu({ path: entry.path, dir: true, x, y }))
  const Icon = open ? FolderOpen : Folder
  return (
    <>
      <button type="button" className={rowClass} style={indent(depth)} onClick={toggle} aria-expanded={open} {...press}>
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className={cn('min-w-0 flex-1 truncate', entry.ignored && 'opacity-50', mark?.className)}>{entry.name}</span>
        {/* Pasta com alteração dentro: a cor da mais importante e um ponto, como no VSCode. */}
        {mark && <span className={cn('w-3 shrink-0 text-center text-[10px]', mark.className)}>●</span>}
      </button>
      {open && <TreeLevel path={entry.path} depth={depth + 1} {...props} />}
    </>
  )
}

/**
 * A árvore do projeto (só leitura), com as cores do git; tocar num arquivo abre por cima da conversa, e
 * o botão direito (no celular, o dedo segurado) abre o menu dele, com mencionar no chat.
 */
export function FilesTab({ project, status }: { project: PanelProject; status: GitStatus | null }) {
  const [version, setVersion] = useState(0)
  // Recolher tudo recomeça a árvore do zero, com as pastas fechadas.
  const [generation, setGeneration] = useState(0)
  const marks = useMemo(() => treeMarks(status?.files ?? []), [status])
  const { menu, show } = useFileMenu(project)
  const viewing = useProjectPanel((s) => s.viewing)
  const selected = viewing?.machine === project.machine && viewing.cwd === project.cwd && !viewing.diff ? viewing.path : null

  // Git relido (fim de turno, commit, stage): arquivos podem ter surgido ou sumido, então a árvore também.
  const [seen, setSeen] = useState(status)
  if (status !== seen) {
    setSeen(status)
    setVersion((v) => v + 1)
  }

  const collapseAll = () => {
    const prefix = `${project.machine}\n${project.cwd}\n`
    for (const key of [...expanded]) if (key.startsWith(prefix)) expanded.delete(key)
    setGeneration((g) => g + 1)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 py-1 pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-muted-foreground uppercase" title={project.cwd}>
          {projectName(project.cwd)}
        </span>
        <Button variant="ghost" size="icon-xs" onClick={openQuickOpen} aria-label="Abrir arquivo pelo nome" title="Abrir arquivo pelo nome · Ctrl+P">
          <FileSearch />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={() => setVersion((v) => v + 1)} aria-label="Atualizar" title="Atualizar">
          <RefreshCw />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={collapseAll} aria-label="Recolher pastas" title="Recolher pastas">
          <ChevronsDownUp />
        </Button>
      </div>
      <div key={generation} className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        <TreeLevel project={project} path="" depth={0} version={version} marks={marks} selected={selected} onMenu={show} />
      </div>
      {menu}
    </div>
  )
}
