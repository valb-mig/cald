import { CircleDot, FileText, Folder, GitPullRequest, GitPullRequestDraft, ListTodo, Slash } from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState, type ComponentProps, type Ref } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { getGithub } from '@/lib/github'
import { useMachine } from '@/lib/machines'
import { pastedFiles } from '@/lib/compose'
import { getTodos } from '@/lib/todos'
import type { CommandInfo } from '@/lib/types'
import { cn } from '@/lib/utils'

type Token = { kind: '/' | '@' | '#' | 'todo'; query: string; start: number; end: number }
type GithubRef = { number: number; title: string; draft: boolean; updatedAt: string }
type GithubSuggestion = ({ kind: 'issue' } & GithubRef) | ({ kind: 'pr' } & GithubRef)
type TodoSuggestion = { kind: 'todo'; n: number; title: string; done: boolean }
type Suggestion = ({ kind: 'command' } & CommandInfo) | { kind: 'file'; path: string } | GithubSuggestion | TodoSuggestion

const suggestionKey = (s: Suggestion) =>
  s.kind === 'command' ? s.name : s.kind === 'file' ? s.path : s.kind === 'todo' ? `todo${s.n}` : `${s.kind}${s.number}`

/**
 * Palavra sob o cursor que dispara sugestões: "/comando" no início da mensagem, "@caminho" e "#issue"
 * ou "#PR" (pelo número ou pelo título) em qualquer lugar.
 */
function activeToken(text: string, caret: number): Token | null {
  // "TODO:3": um item do TODO do projeto, que vai inteiro para o Claude (ver server/src/todos.ts).
  const todo = /(^|\s)TODO:(\d*)$/i.exec(text.slice(0, caret))
  if (todo) {
    const rest = /^\d*/.exec(text.slice(caret))![0]
    return { kind: 'todo', query: todo[2]!, start: caret - 5 - todo[2]!.length, end: caret + rest.length }
  }
  const m = /(^|\s)([@/#])([^\s]*)$/.exec(text.slice(0, caret))
  if (!m) return null
  const kind = m[2] as Token['kind']
  const start = caret - 1 - m[3].length
  if (kind === '/' && (start !== 0 || m[3].includes('/'))) return null
  const rest = /^[^\s]*/.exec(text.slice(caret))![0]
  return { kind, query: m[3], start, end: caret + rest.length }
}

const commandCache = new Map<string, Promise<CommandInfo[]>>()

/**
 * Carrega (uma vez por projeto em cada máquina, e por conversa) a lista de comandos e skills, com as
 * habilidades do cald ligadas nela.
 */
export function loadCommands(machine: string, cwd: string, session?: string): Promise<CommandInfo[]> {
  const key = `${machine}\n${cwd}\n${session ?? ''}`
  let list = commandCache.get(key)
  if (!list) {
    list = api.commands(machine, cwd, session)
    commandCache.set(key, list)
    list.catch(() => commandCache.delete(key))
  }
  return list
}

/** Uma habilidade do cald mudou (criada, editada, ligada ou desligada): o "/" pede a lista de novo. */
export const forgetCommands = () => commandCache.clear()

/**
 * As sugestões da palavra sob o cursor e `ready`: a busca dela já respondeu. Sem nada achado, a lista
 * diz isso em vez de não abrir (ver `EMPTY`): digitar e nada acontecer deixa a dúvida se o atalho existe.
 */
function useSuggestions(cwd: string | undefined, session: string | undefined, token: Token | null): { items: Suggestion[]; ready: boolean } {
  const machine = useMachine()
  const [found, setFound] = useState<{ for: string; items: Suggestion[] }>({ for: '', items: [] })
  const kind = token?.kind
  const query = token?.query ?? ''
  const current = `${kind ?? ''}\n${query}`

  useEffect(() => {
    if (!cwd || !kind) {
      setFound({ for: '', items: [] })
      return
    }
    let alive = true
    // A resposta vale para a palavra que a pediu: uma busca antiga que chega depois não engana.
    const setItems = (items: Suggestion[]) => setFound({ for: `${kind}\n${query}`, items })
    const q = query.toLowerCase()
    if (kind === '/') {
      loadCommands(machine, cwd, session).then(
        (list) => {
          if (!alive) return
          const matches = list.filter((c) => c.name.toLowerCase().includes(q))
          matches.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
          setItems(matches.slice(0, 50).map((c) => ({ kind: 'command', ...c })))
        },
        () => alive && setItems([]),
      )
      return () => {
        alive = false
      }
    }
    if (kind === 'todo') {
      // Os do projeto, do mesmo cache da barra do projeto: os que faltam primeiro, pelo número ou pelo título.
      getTodos(machine, cwd).then(
        (list) => {
          if (!alive) return
          const byNumber = /^\d+$/.test(q)
          setItems(
            list
              .filter((t) => t.n !== undefined && (!q || (byNumber ? String(t.n).startsWith(q) : t.title.toLowerCase().includes(q))))
              .sort((a, b) => Number(a.done) - Number(b.done) || a.n! - b.n!)
              .slice(0, 20)
              .map((t) => ({ kind: 'todo', n: t.n!, title: t.title, done: t.done })),
          )
        },
        () => alive && setItems([]),
      )
      return () => {
        alive = false
      }
    }
    if (kind === '#') {
      // As abertas do projeto, do mesmo cache da barra do projeto: digitar "#" não gasta cota à toa.
      getGithub(machine, cwd).then(
        (info) => {
          if (!alive) return
          if (!info?.ok) return setItems([])
          const all: GithubSuggestion[] = [
            ...info.pulls.map((p) => ({ kind: 'pr' as const, number: p.number, title: p.title, draft: p.draft, updatedAt: p.updatedAt })),
            ...info.issues.map((i) => ({ kind: 'issue' as const, number: i.number, title: i.title, draft: false, updatedAt: i.updatedAt })),
          ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          // Número: pelo começo dele ("#3" acha 31 e 30); texto: pelo título.
          const byNumber = /^\d+$/.test(q)
          setItems(all.filter((g) => (byNumber ? String(g.number).startsWith(q) : g.title.toLowerCase().includes(q))).slice(0, 20))
        },
        () => alive && setItems([]),
      )
      return () => {
        alive = false
      }
    }
    const timer = setTimeout(() => {
      api.files(machine, cwd, query).then(
        (paths) => alive && setItems(paths.map((path) => ({ kind: 'file', path }))),
        () => alive && setItems([]),
      )
    }, 120)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [machine, cwd, session, kind, query])

  return { items: found.for === current ? found.items : [], ready: found.for === current }
}

/** O que a lista diz quando a busca não acha nada. */
function emptyText(token: Token): string {
  const q = token.query
  if (token.kind === '@') return q ? `Nenhum arquivo com "${q}" no projeto.` : 'Nenhum arquivo no projeto.'
  if (token.kind === '#') return q ? `Nenhuma issue ou PR aberto com "${q}".` : 'Nenhuma issue ou PR aberto neste projeto.'
  if (token.kind === 'todo') return q ? `Nenhum item do TODO com "${q}".` : 'O TODO deste projeto está vazio.'
  return q ? `Nenhum comando com "${q}".` : 'Nenhum comando.'
}

function SuggestionRow({ s }: { s: Suggestion }) {
  if (s.kind === 'command') {
    return (
      <>
        <Slash className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-mono text-sm">
            {s.name}
            {s.argumentHint && <span className="ml-1.5 text-muted-foreground">{s.argumentHint}</span>}
          </div>
          {s.description && <div className="line-clamp-2 text-xs text-muted-foreground">{s.description}</div>}
        </div>
      </>
    )
  }
  if (s.kind === 'todo') {
    return (
      <>
        <ListTodo className={cn('mt-0.5 size-4 shrink-0', s.done ? 'text-muted-foreground' : 'text-foreground')} />
        <div className="min-w-0">
          <div className={cn('truncate text-sm', s.done && 'text-muted-foreground line-through')}>
            <span className="font-mono text-muted-foreground">TODO:{s.n}</span> {s.title}
          </div>
          <div className="text-xs text-muted-foreground">{s.done ? 'Feito' : 'A fazer'} · o Claude recebe a descrição e os anexos</div>
        </div>
      </>
    )
  }
  if (s.kind === 'issue' || s.kind === 'pr') {
    const Icon = s.kind === 'issue' ? CircleDot : s.draft ? GitPullRequestDraft : GitPullRequest
    return (
      <>
        <Icon className={cn('mt-0.5 size-4 shrink-0', s.draft ? 'text-muted-foreground' : 'text-emerald-500')} />
        <div className="min-w-0">
          <div className="truncate text-sm">
            <span className="font-mono text-muted-foreground">#{s.number}</span> {s.title}
          </div>
          <div className="text-xs text-muted-foreground">{s.kind === 'pr' ? (s.draft ? 'PR em rascunho' : 'PR aberto') : 'Issue aberta'}</div>
        </div>
      </>
    )
  }
  const dir = s.path.endsWith('/')
  const Icon = dir ? Folder : FileText
  const name = s.path.replace(/\/$/, '').split('/').pop()
  const parent = s.path.replace(/\/$/, '').split('/').slice(0, -1).join('/')
  return (
    <>
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="truncate font-mono text-sm">
          {name}
          {dir && '/'}
        </div>
        {parent && <div className="truncate font-mono text-xs text-muted-foreground">{parent}</div>}
      </div>
    </>
  )
}

/** Ações dos botões da barra: inserir "@" ou "/" e abrir as sugestões. */
export type PromptInputHandle = {
  /** Insere no cursor (com espaço antes, se colado a uma palavra) ou no início da mensagem. */
  insert: (text: string, opts?: { atStart?: boolean }) => void
  focus: () => void
  /** Início e fim da seleção (ou a posição do cursor), mesmo com o campo sem foco. */
  selection: () => [number, number]
}

type Props = Omit<ComponentProps<typeof Textarea>, 'value' | 'onChange'> & {
  handleRef?: Ref<PromptInputHandle>
  /** Projeto da sessão: de onde vêm os comandos, os arquivos, as issues e os PRs sugeridos. */
  cwd?: string
  /** A conversa do campo: o "/" mostra só as habilidades do cald ligadas nela. */
  session?: string
  value: string
  onChange: (value: string) => void
  /** Arquivos colados (ex.: print no PC). */
  onPasteFiles?: (files: File[]) => void
  /** Ctrl/Cmd+Enter. */
  onSubmitShortcut?: () => void
  placement?: 'top' | 'bottom'
  /** false: a lista se posiciona pelo contêiner do chamador (ex.: largura toda da barra de envio). */
  anchored?: boolean
}

/** Campo de mensagem com sugestões de "/comando", "@arquivo", "#issue" ou "#PR" e "TODO:" (itens do TODO). */
export function PromptInput({
  cwd,
  session,
  value,
  onChange,
  onPasteFiles,
  onSubmitShortcut,
  placement = 'top',
  anchored = true,
  handleRef,
  className,
  ...rest
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [token, setToken] = useState<Token | null>(null)
  const [highlight, setHighlight] = useState(0)
  const { items: suggestions, ready } = useSuggestions(cwd, session, token)
  const empty = token !== null && ready && suggestions.length === 0
  const open = token !== null && (suggestions.length > 0 || empty)
  const machine = useMachine()

  useEffect(() => {
    if (cwd) void loadCommands(machine, cwd, session).catch(() => {})
  }, [machine, cwd, session])

  useEffect(() => setHighlight(0), [token?.kind, token?.query])

  const syncToken = (el: HTMLTextAreaElement) => setToken(activeToken(el.value, el.selectionStart))

  useImperativeHandle(
    handleRef,
    () => ({
      focus: () => ref.current?.focus(),
      selection: () => [ref.current?.selectionStart ?? value.length, ref.current?.selectionEnd ?? value.length],
      insert: (text, { atStart = false } = {}) => {
        const el = ref.current
        if (!el) return
        const start = atStart ? 0 : el.selectionStart
        const end = atStart ? 0 : el.selectionEnd
        const before = value.slice(0, start)
        const insert = (!atStart && before && !/\s$/.test(before) ? ' ' : '') + text
        const next = before + insert + value.slice(end)
        const caret = start + insert.length
        onChange(next)
        requestAnimationFrame(() => {
          el.focus()
          el.setSelectionRange(caret, caret)
          setToken(activeToken(next, caret))
        })
      },
    }),
    [value, onChange],
  )

  function pick(s: Suggestion) {
    const el = ref.current
    if (!el || !token) return
    // Diretório: mantém a sugestão aberta para descer na árvore. Issue e PR entram com o tipo na frente,
    // para o Claude saber o que buscar no GitHub do projeto (pelo `gh`).
    const insert =
      s.kind === 'command'
        ? `/${s.name} `
        : s.kind === 'file'
          ? s.path.endsWith('/')
            ? `@${s.path}`
            : `@${s.path} `
          : s.kind === 'todo'
            ? `TODO:${s.n} `
            : `${s.kind === 'pr' ? 'PR' : 'issue'} #${s.number} `
    const next = value.slice(0, token.start) + insert + value.slice(token.end)
    const caret = token.start + insert.length
    onChange(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(caret, caret)
      setToken(activeToken(next, caret))
    })
  }

  return (
    <div className={cn('min-w-0 flex-1', anchored && 'relative')}>
      {open && (
        <div
          className={cn(
            'absolute right-0 left-0 z-30 max-h-64 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg',
            placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
        >
          {empty && <p className="px-2 py-2 text-sm text-muted-foreground">{emptyText(token)}</p>}
          {suggestions.map((s, i) => (
            <button
              key={suggestionKey(s)}
              type="button"
              // Não tirar o foco do campo (o teclado do celular fecharia).
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
              className={cn('flex w-full items-start gap-2 rounded-md px-2 py-2 text-left', i === highlight && 'bg-muted')}
            >
              <SuggestionRow s={s} />
            </button>
          ))}
        </div>
      )}
      <Textarea
        {...rest}
        ref={ref}
        value={value}
        className={className}
        onChange={(e) => {
          onChange(e.target.value)
          syncToken(e.target)
        }}
        onSelect={(e) => syncToken(e.currentTarget)}
        onBlur={() => setTimeout(() => setToken(null), 150)}
        onPaste={(e) => {
          const files = pastedFiles(e.clipboardData)
          if (files.length && onPasteFiles) {
            e.preventDefault()
            onPasteFiles(files)
          }
        }}
        onKeyDown={(e) => {
          if (open) {
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestions.length) {
              e.preventDefault()
              const step = e.key === 'ArrowDown' ? 1 : -1
              setHighlight((h) => (h + step + suggestions.length) % suggestions.length)
              return
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && suggestions.length) {
              e.preventDefault()
              pick(suggestions[highlight]!)
              return
            }
            if (e.key === 'Escape') {
              setToken(null)
              return
            }
          }
          // Enter quebra linha (ditado/Gboard); Ctrl/Cmd+Enter envia no PC.
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSubmitShortcut) {
            e.preventDefault()
            onSubmitShortcut()
          }
        }}
      />
    </div>
  )
}
