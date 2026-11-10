import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { api, errorMessage } from '@/lib/api'
import { WIDE_QUERY } from '@/lib/hooks'
import { openViewer, setPanelShown, setPanelTab, useProjectPanel, useShownProject, type PanelProject } from '@/lib/project-panel'
import { openAt } from '@/lib/reveal'
import { cn } from '@/lib/utils'
import { useWorkbench } from '@/lib/workbench'
import { focusSearch } from './search'
import { fileIcon, splitPath } from './status'

/**
 * Abrir um arquivo do projeto pelo nome, como o Ctrl+P do VSCode: a mesma busca da menção `@` (o
 * `git ls-files` do PC, sem índice), só com arquivos. `caminho:12` abre já na linha 12. Sem nada
 * digitado, mostra os arquivos do projeto abertos em abas. Abre pelo Ctrl+P (no PC) ou pelo botão da
 * aba Arquivos; Ctrl+Shift+F leva à aba Buscar da barra do projeto.
 */

export const useQuickOpen = create<{ open: boolean }>(() => ({ open: false }))
export const openQuickOpen = () => useQuickOpen.setState({ open: true })

function Palette({ project, onClose }: { project: PanelProject; onClose: () => void }) {
  const [text, setText] = useState('')
  const [found, setFound] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  // `arquivo:12`: a linha vai junto.
  const m = /^(.*?):(\d+)$/.exec(text.trim())
  const q = m ? m[1]! : text.trim()
  const line = m ? Number(m[2]) : undefined
  // Sem termo: os arquivos deste projeto abertos em abas, os usados por último primeiro.
  const groups = useWorkbench((s) => s.groups)
  const opened = useMemo(
    () =>
      [...new Set(groups.flatMap((g) => (g.recent ?? []).concat(g.tabs.map((t) => t.key))))]
        .map((k) => k.split('\n'))
        .filter(([kind, cwd, , diff]) => kind === `f:${project.machine}` && cwd === project.cwd && !diff)
        .map(([, , path]) => path!),
    [groups, project.machine, project.cwd],
  )

  useEffect(() => {
    if (!q) return
    let alive = true
    const timer = setTimeout(() => {
      api.files(project.machine, project.cwd, q).then(
        (paths) => {
          if (!alive) return
          setFound(paths.filter((p) => !p.endsWith('/')))
          setError(null)
          setActive(0)
        },
        (err) => alive && setError(errorMessage(err)),
      )
    }, 100)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [project.machine, project.cwd, q])

  const items = q ? found : opened
  const pick = (path: string | undefined, pin = false) => {
    if (!path) return
    onClose()
    if (line) openAt(project, path, { line }, pin)
    else openViewer({ ...project, path }, pin)
  }

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <>
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const n = items.length
            if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            pick(items[active], e.ctrlKey || e.metaKey)
          }
        }}
        placeholder="Nome do arquivo (arquivo:12 abre na linha)"
        aria-label="Buscar arquivo pelo nome"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="h-11 w-full border-b bg-transparent px-4 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
      />
      <div ref={list} role="listbox" className="max-h-[min(60vh,420px)] overflow-y-auto py-1">
        {!q && items.length > 0 && <div className="px-4 pt-1 pb-1.5 text-xs text-muted-foreground">Abertos</div>}
        {items.map((path, i) => {
          const { name, dir } = splitPath(path)
          return (
            <button
              key={path}
              type="button"
              role="option"
              data-index={i}
              aria-selected={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(path)}
              className={cn('flex w-full min-w-0 items-center gap-2 px-4 py-1.5 text-left text-[13px]', i === active && 'bg-muted')}
            >
              {createElement(fileIcon(name), { className: 'size-4 shrink-0 text-muted-foreground' })}
              <span className="shrink-0">{name}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{dir}</span>
            </button>
          )
        })}
        {error && <p className="px-4 py-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
        {q && !error && items.length === 0 && <p className="px-4 py-2 text-xs text-muted-foreground">Nenhum arquivo com esse nome.</p>}
        {!q && items.length === 0 && <p className="px-4 py-2 text-xs text-muted-foreground">Digite parte do nome ou do caminho.</p>}
      </div>
    </>
  )
}

/** A paleta do projeto na barra, e os atalhos dela (Ctrl+P e Ctrl+Shift+F), valendo no app todo. */
export function QuickOpen() {
  const project = useShownProject()
  const open = useQuickOpen((s) => s.open)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || !useProjectPanel.getState().project) return
      const key = e.key.toLowerCase()
      if (key === 'p' && !e.shiftKey) {
        // No lugar do "imprimir" do navegador.
        e.preventDefault()
        openQuickOpen()
      } else if (key === 'f' && e.shiftKey) {
        e.preventDefault()
        // O que está selecionado (no código, no chat) já vem no campo, se for uma linha só.
        const selected = getSelection()?.toString() ?? ''
        setPanelTab('search')
        setPanelShown(true)
        focusSearch(selected.includes('\n') || selected.length > 200 ? '' : selected)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  const close = () => useQuickOpen.setState({ open: false })
  return (
    <Dialog open={open && Boolean(project)} onOpenChange={(o) => !o && close()}>
      <DialogContent
        showCloseButton={false}
        // Perto do topo, como no VSCode, e não no meio da tela.
        className={cn('top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl', !matchMedia(WIDE_QUERY).matches && 'top-4')}
      >
        <DialogTitle className="sr-only">Abrir arquivo</DialogTitle>
        <DialogDescription className="sr-only">Busque um arquivo do projeto pelo nome</DialogDescription>
        {project && <Palette key={`${project.machine}\n${project.cwd}`} project={project} onClose={close} />}
      </DialogContent>
    </Dialog>
  )
}
