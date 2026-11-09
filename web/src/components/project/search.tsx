import { CaseSensitive, ChevronRight, Loader2, Regex, WholeWord, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { Button } from '@/components/ui/button'
import { api, errorMessage } from '@/lib/api'
import type { PanelProject } from '@/lib/project-panel'
import { openAt } from '@/lib/reveal'
import type { SearchMatch, SearchResult } from '@/lib/types'
import { cn } from '@/lib/utils'
import { FileIcon } from './file-icons'
import { splitPath } from './status'

/**
 * Buscar texto nos arquivos do projeto, como o "Buscar" do VSCode (Ctrl+Shift+F): o PC roda o ripgrep
 * na hora, sem índice (ver server/src/search.ts). Os achados vêm por arquivo; clicar num abre o
 * arquivo na linha, com o trecho selecionado (dois cliques deixam a aba fixa).
 */

type Query = { q: string; regex: boolean; caseSensitive: boolean; word: boolean }

/** O que foi buscado em cada projeto: trocar de aba ou de conversa e voltar mantém a busca. */
const useQueries = create<Record<string, Query>>(() => ({}))
const EMPTY: Query = { q: '', regex: false, caseSensitive: false, word: false }

/** Pede o foco no campo da busca (o Ctrl+Shift+F), com o texto a pôr nele, se houver. */
export const useSearchFocus = create<{ tick: number; text: string }>(() => ({ tick: 0, text: '' }))
export const focusSearch = (text = '') => useSearchFocus.setState((s) => ({ tick: s.tick + 1, text }))

/** Uma linha achada, com os trechos achados realçados. */
function MatchText({ match }: { match: SearchMatch }) {
  const parts: React.ReactNode[] = []
  let at = 0
  match.ranges.forEach(([a, b], i) => {
    if (a > at) parts.push(match.text.slice(at, a))
    parts.push(
      <mark key={i} className="rounded-[2px] bg-amber-400/35 text-inherit">
        {match.text.slice(a, b)}
      </mark>,
    )
    at = b
  })
  parts.push(match.text.slice(at))
  return <>{parts}</>
}

const Toggle = ({ on, onClick, label, children }: { on: boolean; onClick: () => void; label: string; children: React.ReactNode }) => (
  <Button
    variant={on ? 'secondary' : 'ghost'}
    size="icon-xs"
    onClick={onClick}
    aria-pressed={on}
    aria-label={label}
    title={label}
    className={cn(on && 'text-sky-600 ring-1 ring-sky-500/50 dark:text-sky-400')}
  >
    {children}
  </Button>
)

export function SearchTab({ project }: { project: PanelProject }) {
  const key = `${project.machine}\n${project.cwd}`
  const query = useQueries((s) => s[key] ?? EMPTY)
  const set = (patch: Partial<Query>) => useQueries.setState((s) => ({ [key]: { ...(s[key] ?? EMPTY), ...patch } }))
  const [result, setResult] = useState<SearchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const input = useRef<HTMLInputElement>(null)
  const focus = useSearchFocus((s) => s.tick)

  // Ctrl+Shift+F: o foco vem para cá, com o texto selecionado no código, se houver.
  useEffect(() => {
    const { text } = useSearchFocus.getState()
    if (text) {
      set({ q: text })
      useSearchFocus.setState({ text: '' })
    }
    input.current?.focus()
    input.current?.select()
    // `set` só escreve no store; o que importa é o pedido novo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  // Busca enquanto se digita, depois de uma pausa; a busca anterior, se ainda corre, é largada.
  useEffect(() => {
    const q = query.q
    if (q.trim().length < 2 && !(query.regex && q)) {
      setResult(null)
      setError(null)
      return
    }
    const abort = new AbortController()
    const timer = setTimeout(() => {
      setBusy(true)
      api.search(project.machine, project.cwd, q, query, abort.signal).then(
        (r) => {
          setResult(r)
          setError(null)
          setClosed(new Set())
          setBusy(false)
        },
        (err) => {
          if (abort.signal.aborted) return
          setError(errorMessage(err))
          setResult(null)
          setBusy(false)
        },
      )
    }, 300)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [project.machine, project.cwd, query])

  const toggle = (path: string) =>
    setClosed((c) => {
      const next = new Set(c)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 pb-2">
        <div className="flex items-center gap-0.5 rounded-md border bg-background pr-1 focus-within:ring-2 focus-within:ring-ring">
          <input
            ref={input}
            value={query.q}
            onChange={(e) => set({ q: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query.q) {
                e.stopPropagation()
                set({ q: '' })
              }
            }}
            placeholder="Buscar nos arquivos"
            aria-label="Buscar nos arquivos"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-8 min-w-0 flex-1 bg-transparent px-2 font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted-foreground"
          />
          {query.q && (
            <Button variant="ghost" size="icon-xs" onClick={() => set({ q: '' })} aria-label="Limpar a busca" title="Limpar">
              <X />
            </Button>
          )}
          <Toggle on={query.caseSensitive} onClick={() => set({ caseSensitive: !query.caseSensitive })} label="Diferenciar maiúsculas">
            <CaseSensitive />
          </Toggle>
          <Toggle on={query.word} onClick={() => set({ word: !query.word })} label="Palavra inteira">
            <WholeWord />
          </Toggle>
          <Toggle on={query.regex} onClick={() => set({ regex: !query.regex })} label="Expressão regular">
            <Regex />
          </Toggle>
        </div>
        <div className="flex min-h-5 items-center gap-1.5 px-1 pt-1.5 text-xs text-muted-foreground">
          {busy && <Loader2 className="size-3 animate-spin" />}
          {error ? (
            <span className="text-red-600 dark:text-red-400">{error}</span>
          ) : result ? (
            result.total === 0 ? (
              'Nada encontrado.'
            ) : (
              <span>
                {result.total} {result.total === 1 ? 'resultado' : 'resultados'} em {result.files.length} {result.files.length === 1 ? 'arquivo' : 'arquivos'}
                {result.truncated && ' (os primeiros; refine a busca)'}
              </span>
            )
          ) : (
            query.q.trim().length < 2 && 'Sem índice: o PC busca na hora, respeitando o .gitignore.'
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {result?.files.map(({ path, matches }) => {
          const { name, dir } = splitPath(path)
          const open = !closed.has(path)
          return (
            <div key={path}>
              <button
                type="button"
                onClick={() => toggle(path)}
                title={path}
                className="flex w-full min-w-0 items-center gap-1.5 py-1 pr-2 pl-1.5 text-left text-[13px] hover:bg-muted"
              >
                <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
                <FileIcon name={name} className="size-3.5 text-muted-foreground" />
                <span className="shrink-0">{name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{dir}</span>
                <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums">{matches.length}</span>
              </button>
              {open &&
                matches.map((m) => (
                  <button
                    key={m.line}
                    type="button"
                    onClick={() => openAt(project, path, { line: m.line, col: m.col, len: m.len })}
                    onDoubleClick={() => openAt(project, path, { line: m.line, col: m.col, len: m.len }, true)}
                    className="flex w-full min-w-0 items-baseline gap-2 py-0.5 pr-2 pl-9 text-left hover:bg-muted"
                  >
                    <span className="w-7 shrink-0 text-right font-mono text-[11px] text-muted-foreground/70 tabular-nums">{m.line}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs whitespace-pre">
                      <MatchText match={m} />
                    </span>
                  </button>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
