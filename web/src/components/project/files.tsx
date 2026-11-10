import { ChevronRight, ChevronsDownUp, FilePlus, FileSearch, FolderPlus, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { api, errorMessage } from '@/lib/api'
import { reloadGit, usePressMenu, useWide } from '@/lib/hooks'
import { projectName } from '@/lib/format'
import { closeViewer, openViewer, useProjectPanel, type PanelProject } from '@/lib/project-panel'
import type { EntryInfo, GitStatus, TreeEntry } from '@/lib/types'
import { fileNameOf, useUnsaved } from '@/lib/unsaved'
import { cn } from '@/lib/utils'
import { closeFileTabs, isUnder } from '@/lib/workbench'
import { useFileMenu, type FileMenuAt } from './file-menu'
import { openQuickOpen } from './quick-open'
import { FileIcon, FolderIcon } from './file-icons'
import { splitPath, treeMarks, type Badge } from './status'

// Pastas abertas por projeto: trocar de aba, fechar e reabrir a barra mantém a árvore como estava.
const expanded = new Set<string>()
// Segurar o dedo abre o menu do arquivo: sem selecionar o texto nem o menu de link do iPhone.
const rowClass =
  'flex w-full min-w-0 items-center gap-1.5 py-1 pr-2 text-left text-[13px] select-none [-webkit-touch-callout:none] hover:bg-muted active:bg-muted'
const indent = (depth: number) => ({ paddingLeft: 8 + depth * 12 })
// O Desfazer de apagar fica à vista por este tempo.
const UNDO_MS = 10_000

/**
 * O nome sendo escrito na árvore, como no VSCode: um arquivo ou pasta novo dentro de `parent` ('' é a
 * raiz). `id`: outro começado no mesmo lugar é outro campo, vazio.
 */
type Draft = { parent: string; type: 'dir' | 'file'; id: number }
let drafts = 0
/** O item escolhido (o clicado, o do botão direito): os botões de criar põem o novo nele, ou ao lado. */
type Picked = { path: string; dir: boolean }
/** O que espera a confirmação para ir para a lixeira, com as abas dele que têm alteração não salva. */
type Doomed = Picked & { info: EntryInfo | null; unsaved: string[] }

type TreeProps = {
  project: PanelProject
  /** Muda para reler as pastas abertas (o Claude terminou um turno, o botão de atualizar). */
  version: number
  marks: Map<string, Badge>
  /** O item marcado na árvore: o escolhido, ou o arquivo aberto agora por cima da conversa. */
  selected: string | null
  /** As pastas no caminho até este abrem (a do nome sendo escrito, o item que acabou de nascer). */
  reveal: string | null
  draft: Draft | null
  onDraftDone: (draft: Draft, created: string | null) => void
  onPick: (item: Picked) => void
  /** Delete no item com o foco do teclado. */
  onDelete: (item: Picked) => void
  /** Botão direito ou dedo segurado num arquivo ou pasta: o menu dele (mencionar no chat...). */
  onMenu: (at: FileMenuAt) => void
}

// O Delete (no Mac, Cmd+Backspace) apaga o item com o foco, como no VSCode.
const isDeleteKey = (e: React.KeyboardEvent) => e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)

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
  // O nome novo entra no topo da pasta, antes do que já tem nela.
  const draft = props.draft?.parent === path && (
    <DraftRow key={props.draft.id} project={props.project} draft={props.draft} depth={depth} taken={entries} onDone={props.onDraftDone} />
  )
  if (entries.length === 0) return draft || <p className="py-1 text-xs text-muted-foreground" style={indent(depth + 1)}>vazia</p>
  return (
    <>
      {draft}
      {entries.map((e) =>
        e.type === 'dir' ? <DirNode key={e.path} entry={e} depth={depth} {...props} /> : <FileNode key={e.path} entry={e} depth={depth} {...props} />,
      )}
    </>
  )
}

/** O item que acabou de nascer (ou de voltar da lixeira) aparece na lista, rolando até ele. */
function useRevealed(path: string, reveal: string | null) {
  const ref = useRef<HTMLButtonElement>(null)
  const revealed = reveal === path
  useEffect(() => {
    if (revealed) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [revealed])
  return ref
}

function FileNode({ entry, depth, ...props }: TreeProps & { entry: TreeEntry; depth: number }) {
  const { machine, cwd } = props.project
  const mark = props.marks.get(entry.path)
  const press = usePressMenu((x, y) => props.onMenu({ path: entry.path, x, y }))
  const ref = useRevealed(entry.path, props.reveal)
  return (
    <button
      ref={ref}
      type="button"
      className={cn(rowClass, props.selected === entry.path && 'bg-muted')}
      style={indent(depth + 1)}
      onClick={() => {
        props.onPick({ path: entry.path, dir: false })
        openViewer({ machine, cwd, path: entry.path })
      }}
      // Dois cliques: a aba fica (no PC; o clique abre como prévia).
      onDoubleClick={() => openViewer({ machine, cwd, path: entry.path }, true)}
      onKeyDown={(e) => {
        if (!isDeleteKey(e)) return
        e.preventDefault()
        props.onDelete({ path: entry.path, dir: false })
      }}
      title={mark ? `${entry.path} · ${mark.label}` : entry.path}
      {...press}
    >
      <FileIcon name={entry.name} className={cn('size-4 text-muted-foreground', entry.ignored && 'opacity-50')} />
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
  // No caminho do que precisa aparecer: abre, e fica aberta como se tivesse sido clicada (dá para fechar depois).
  const wanted = props.reveal !== null && props.reveal.startsWith(`${entry.path}/`)
  const [seenWanted, setSeenWanted] = useState(false)
  if (wanted !== seenWanted) {
    setSeenWanted(wanted)
    if (wanted && !open) {
      expanded.add(key)
      setOpen(true)
    }
  }
  const mark = props.marks.get(entry.path)
  const press = usePressMenu((x, y) => props.onMenu({ path: entry.path, dir: true, x, y }))
  const ref = useRevealed(entry.path, props.reveal)
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cn(rowClass, props.selected === entry.path && 'bg-muted')}
        style={indent(depth)}
        onClick={() => {
          props.onPick({ path: entry.path, dir: true })
          toggle()
        }}
        onKeyDown={(e) => {
          if (!isDeleteKey(e)) return
          e.preventDefault()
          props.onDelete({ path: entry.path, dir: true })
        }}
        aria-expanded={open}
        {...press}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <FolderIcon name={entry.name} open={open} className={cn('size-4 text-muted-foreground', entry.ignored && 'opacity-50')} />
        <span className={cn('min-w-0 flex-1 truncate', entry.ignored && 'opacity-50', mark?.className)}>{entry.name}</span>
        {/* Pasta com alteração dentro: a cor da mais importante e um ponto, como no VSCode. */}
        {mark && <span className={cn('w-3 shrink-0 text-center text-[10px]', mark.className)}>●</span>}
      </button>
      {open && <TreeLevel path={entry.path} depth={depth + 1} {...props} />}
    </>
  )
}

/**
 * O que impede o nome (já sem os espaços das pontas); `null` se serve. Com subpastas no nome (`a/b.ts`,
 * que cria a pasta `a`), daqui só se confere o primeiro pedaço, que é o desta pasta; o resto, o PC confere.
 */
function nameProblem(name: string, type: Draft['type'], taken: TreeEntry[]): string | null {
  const clean = type === 'dir' ? name.replace(/\/+$/, '') : name
  if (!clean) return 'Escreva um nome'
  if (clean.startsWith('/')) return 'Sem / no começo'
  const parts = clean.split('/')
  if (parts.at(-1) === '') return 'Falta o nome depois da /'
  if (parts.includes('')) return 'Falta um nome entre as barras'
  if (parts.some((p) => p === '.' || p === '..')) return '. e .. não servem de nome'
  if (parts.includes('.git')) return 'A .git é do git'
  const first = taken.find((e) => e.name === parts[0])
  if (first && parts.length === 1) return `Já existe ${first.type === 'dir' ? 'uma pasta' : 'um arquivo'} com esse nome`
  if (first?.type === 'file') return `${first.name} é um arquivo`
  return null
}

/** O campo do nome, no lugar onde o item vai aparecer: Enter cria, Esc desiste, sair do campo cria se o nome serve. */
function DraftRow({
  project,
  draft,
  depth,
  taken,
  onDone,
}: {
  project: PanelProject
  draft: Draft
  depth: number
  taken: TreeEntry[]
  onDone: (draft: Draft, created: string | null) => void
}) {
  const [name, setName] = useState('')
  // O que o PC recusou, ou o nome vazio no Enter; o resto aparece enquanto se escreve.
  const [error, setError] = useState<string | null>(null)
  const typed = name.trim()
  const problem = nameProblem(typed, draft.type, taken)
  const shown = error ?? (typed ? problem : null)
  // O Enter e a saída do campo podem chegar juntos: cria uma vez só, e termina uma vez só.
  const busy = useRef(false)
  const done = useRef(false)
  const finish = (created: string | null) => {
    if (done.current) return
    done.current = true
    onDone(draft, created)
  }

  const submit = async (leaving: boolean) => {
    if (busy.current || done.current) return
    if (problem) return leaving ? finish(null) : setError(problem)
    busy.current = true
    const rel = typed.replace(/\/+$/, '')
    try {
      const { path } = await api.createEntry(project.machine, project.cwd, draft.parent ? `${draft.parent}/${rel}` : rel, draft.type)
      finish(path)
    } catch (err) {
      busy.current = false
      // Fora do campo, o erro não teria onde ficar: vira aviso, e o campo sai.
      if (!leaving) return setError(errorMessage(err))
      toast.error(`Não deu para criar ${rel}`, { description: errorMessage(err) })
      finish(null)
    }
  }

  const leaf = typed.replace(/\/+$/, '').split('/').at(-1) ?? ''
  return (
    <div className="py-0.5 pr-2" style={indent(draft.type === 'dir' ? depth : depth + 1)}>
      <div className="flex min-w-0 items-center gap-1.5">
        {draft.type === 'dir' ? (
          <>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            <FolderIcon name={leaf} className="size-4 text-muted-foreground" />
          </>
        ) : (
          <FileIcon name={leaf} className="size-4 text-muted-foreground" />
        )}
        {/* 16 px no celular: menos que isso, o iPhone dá zoom ao focar. */}
        <input
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit(false)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              finish(null)
            }
          }}
          // Trocar de janela também tira o foco do campo, e aí ele fica como está.
          onBlur={() => document.hasFocus() && (typed ? void submit(true) : finish(null))}
          aria-label={draft.type === 'dir' ? 'Nome da pasta nova' : 'Nome do arquivo novo'}
          aria-invalid={shown ? true : undefined}
          placeholder={draft.type === 'dir' ? 'pasta' : 'arquivo'}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          enterKeyHint="done"
          className="h-6 min-w-0 flex-1 rounded-sm bg-background px-1 text-base ring-1 ring-ring outline-none placeholder:text-muted-foreground/60 aria-invalid:ring-red-500 wide:text-[13px]"
        />
      </div>
      {shown && <p className={cn('mt-0.5 text-xs text-red-600 dark:text-red-400', draft.type === 'dir' ? 'ml-10.5' : 'ml-5.5')}>{shown}</p>}
    </div>
  )
}

/** Quantos itens a pasta leva para a lixeira, em palavras. */
function itemsNote(info: EntryInfo | null): string {
  if (info?.items === undefined) return 'com tudo o que tem dentro'
  if (info.capped) return `com mais de ${info.items.toLocaleString('pt-BR')} itens dentro`
  if (info.items === 0) return 'vazia'
  return `com ${info.items.toLocaleString('pt-BR')} ${info.items === 1 ? 'item' : 'itens'} dentro`
}

/** As abas de arquivo do projeto com alteração não salva em `under` (o arquivo, ou o que está na pasta). */
function unsavedUnder(project: PanelProject, under: string): string[] {
  return Object.keys(useUnsaved.getState().dirty).filter((k) => {
    const [machine, cwd, path] = k.slice(2).split('\n')
    return k.startsWith('f:') && machine === project.machine && cwd === project.cwd && path !== undefined && isUnder(path, under)
  })
}

/**
 * A árvore do projeto, com as cores do git; tocar num arquivo abre por cima da conversa, e o botão
 * direito (no celular, o dedo segurado) abre o menu dele, com mencionar no chat, criar e apagar.
 * Apagar vai para a lixeira do edit.r, com Desfazer logo em seguida.
 */
export function FilesTab({ project, status }: { project: PanelProject; status: GitStatus | null }) {
  const { machine, cwd } = project
  const [version, setVersion] = useState(0)
  // Recolher tudo recomeça a árvore do zero, com as pastas fechadas.
  const [generation, setGeneration] = useState(0)
  const marks = useMemo(() => treeMarks(status?.files ?? []), [status])
  const wide = useWide()
  const viewing = useProjectPanel((s) => s.viewing)
  const viewed = viewing?.machine === machine && viewing.cwd === cwd && !viewing.diff ? viewing.path : null
  const [draft, setDraft] = useState<Draft | null>(null)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [reveal, setReveal] = useState<string | null>(null)
  const [doomed, setDoomed] = useState<Doomed | null>(null)
  // O último apagado, com o Desfazer na própria árvore: no celular a barra é uma folha, e um aviso ficaria fora dela, sem clique.
  const [undo, setUndo] = useState<{ id: string; text: string } | null>(null)
  useEffect(() => {
    if (!undo) return
    const timer = setTimeout(() => setUndo(null), UNDO_MS)
    return () => clearTimeout(timer)
  }, [undo])

  // Git relido (fim de turno, commit, stage): arquivos podem ter surgido ou sumido, então a árvore também.
  const [seen, setSeen] = useState(status)
  if (status !== seen) {
    setSeen(status)
    setVersion((v) => v + 1)
  }
  // Outro arquivo aberto (uma aba, o Ctrl+P): a marca vai para ele, como no VSCode.
  const [seenViewed, setSeenViewed] = useState(viewed)
  if (viewed !== seenViewed) {
    setSeenViewed(viewed)
    setPicked(null)
  }
  // Onde os botões de criar põem o novo: na pasta escolhida, ao lado do arquivo escolhido (ou do aberto), ou na raiz.
  const here = picked ? (picked.dir ? picked.path : splitPath(picked.path).dir) : viewed ? splitPath(viewed).dir : ''

  const refresh = () => {
    setVersion((v) => v + 1)
    void reloadGit(machine, cwd)
  }

  const pick = (item: Picked) => {
    setPicked(item)
    setReveal(null)
  }

  const startDraft = (parent: string, type: Draft['type']) => {
    setUndo(null)
    setDraft({ parent, type, id: ++drafts })
  }

  const drafted = (d: Draft, created: string | null) => {
    // Outro nome já começou (o clique no botão tirou o foco deste): aquele fica.
    setDraft((now) => (now === d ? null : now))
    if (!created) return
    setPicked({ path: created, dir: d.type === 'dir' })
    setReveal(created)
    refresh()
    // No PC, o arquivo novo abre no editor, numa aba que fica; no celular, só leitura, não há o que abrir.
    if (d.type === 'file' && wide) openViewer({ machine, cwd, path: created }, true)
  }

  const askDelete = (item: Picked) => {
    setDoomed({ ...item, info: null, unsaved: unsavedUnder(project, item.path) })
    if (!item.dir) return
    api.entryInfo(machine, cwd, item.path).then(
      (info) => setDoomed((d) => (d?.path === item.path ? { ...d, info } : d)),
      () => {},
    )
  }

  const remove = (d: Doomed) => {
    setDoomed(null)
    const name = splitPath(d.path).name
    api.trashEntry(machine, cwd, d.path).then(
      ({ id }) => {
        // As abas do que foi apagado fecham; a com alteração não salva fica, com o aviso de apagado do editor.
        const dirty = useUnsaved.getState().dirty
        closeFileTabs(machine, cwd, d.path, (key) => Boolean(dirty[key]))
        const v = useProjectPanel.getState().viewing
        if (v?.machine === machine && v.cwd === cwd && isUnder(v.path, d.path)) closeViewer()
        const prefix = `${machine}\n${cwd}\n`
        for (const key of [...expanded]) if (key.startsWith(prefix) && isUnder(key.slice(prefix.length), d.path)) expanded.delete(key)
        if (picked && isUnder(picked.path, d.path)) setPicked(null)
        setUndo({ id, text: `${name} foi para a lixeira` })
        refresh()
      },
      (err) => toast.error(`Não deu para apagar ${name}`, { description: errorMessage(err) }),
    )
  }

  const restore = (u: { id: string }) => {
    setUndo(null)
    api.restoreEntry(machine, cwd, u.id).then(
      ({ path }) => {
        setReveal(path)
        refresh()
      },
      (err) => toast.error('Não deu para desfazer', { description: errorMessage(err) }),
    )
  }

  const { menu, show } = useFileMenu(project, { create: startDraft, remove: askDelete })
  const onMenu = (at: FileMenuAt) => {
    pick({ path: at.path, dir: Boolean(at.dir) })
    show(at)
  }

  const collapseAll = () => {
    const prefix = `${machine}\n${cwd}\n`
    for (const key of [...expanded]) if (key.startsWith(prefix)) expanded.delete(key)
    setReveal(null)
    setDraft(null)
    setGeneration((g) => g + 1)
  }

  const action = useRef<HTMLButtonElement>(null)
  const doomedName = doomed && splitPath(doomed.path).name

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 py-1 pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-muted-foreground uppercase" title={project.cwd}>
          {projectName(project.cwd)}
        </span>
        <Button variant="ghost" size="icon-xs" onClick={() => startDraft(here, 'file')} aria-label="Novo arquivo" title="Novo arquivo">
          <FilePlus />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={() => startDraft(here, 'dir')} aria-label="Nova pasta" title="Nova pasta">
          <FolderPlus />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={openQuickOpen} aria-label="Abrir arquivo pelo nome" title="Abrir arquivo pelo nome · Ctrl+P">
          <FileSearch />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={refresh} aria-label="Atualizar" title="Atualizar">
          <RefreshCw />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={collapseAll} aria-label="Recolher pastas" title="Recolher pastas">
          <ChevronsDownUp />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          key={generation}
          className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]"
          // Clicar no vazio, abaixo dos itens, desmarca: o próximo novo vai para a raiz.
          onClick={(e) => e.target === e.currentTarget && pick({ path: '', dir: true })}
        >
          <TreeLevel
            project={project}
            path=""
            depth={0}
            version={version}
            marks={marks}
            selected={picked ? picked.path : viewed}
            reveal={draft ? `${draft.parent}/` : reveal}
            draft={draft}
            onDraftDone={drafted}
            onPick={pick}
            onDelete={askDelete}
            onMenu={onMenu}
          />
        </div>
        {undo && (
          <div className="absolute inset-x-2 bottom-2">
            <UndoBar text={undo.text} onUndo={() => restore(undo)} />
          </div>
        )}
      </div>
      {menu}

      <AlertDialog open={doomed !== null} onOpenChange={(open) => !open && setDoomed(null)}>
        {doomed && (
          // O foco já no Apagar: Delete e Enter, como no VSCode. Tem volta, pelo Desfazer.
          <AlertDialogContent
            size="sm"
            onOpenAutoFocus={(e) => {
              e.preventDefault()
              action.current?.focus()
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle className="break-words">{doomed.dir ? `Apagar a pasta ${doomedName}?` : `Apagar ${doomedName}?`}</AlertDialogTitle>
              <AlertDialogDescription>
                {doomed.dir ? `Vai para a lixeira do edit.r ${itemsNote(doomed.info)}.` : 'Vai para a lixeira do edit.r.'} Dá para desfazer.
                {doomed.unsaved.length > 0 && (
                  <span className="mt-1 block text-amber-700 dark:text-amber-400">
                    {doomed.unsaved.length === 1
                      ? `${fileNameOf(doomed.unsaved[0]!)} tem alteração não salva: a aba fica aberta com o texto.`
                      : `${doomed.unsaved.length} abas têm alteração não salva: ficam abertas com o texto.`}
                  </span>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction ref={action} variant="destructive" onClick={() => remove(doomed)}>
                Apagar
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  )
}
