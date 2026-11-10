import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, LanguageDescription, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { lintKeymap } from '@codemirror/lint'
import { diff } from '@codemirror/merge'
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Text, Transaction } from '@codemirror/state'
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate,
} from '@codemirror/view'
import { AtSign, Box, Check, ClipboardPaste, Copy, Hash, RotateCcw, Scissors, SquareFunction, TriangleAlert, Type, X } from 'lucide-react'
import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { api, ApiError, errorMessage, fileSocketUrl } from '@/lib/api'
import { ASKS, askClaude, type Ask } from '@/lib/ask-claude'
import { useCodeFont } from '@/lib/code-font'
import { editorCommands, setEditorCursor } from '@/lib/editor-cursor'
import { useTokens } from '@/lib/highlight'
import { reloadGit, subscribeGit, useDarkMode } from '@/lib/hooks'
import { insertInChat, type Viewing } from '@/lib/project-panel'
import { doneReveal, revealKey, useReveal } from '@/lib/reveal'
import type { FileView } from '@/lib/types'
import { drafts, draftsLoaded, persistDraft, registerSaver, setDirty, useUnsaved } from '@/lib/unsaved'
import { cn } from '@/lib/utils'
import { keyOf, pinTab } from '@/lib/workbench'
import { ChangePeek, type Block } from './changes'
import {
  addDiskMarks,
  blockOf,
  changeGutter,
  clearDiskMark,
  completions,
  diskBlockOf,
  diskField,
  diskGutter,
  diskMarksOf,
  symbolsOf,
  type CodeSymbol,
  changesField,
  changeStats,
  detectIndent,
  editorTheme,
  flashField,
  flashLines,
  highlightStyle,
  hunkLine,
  minimapTokens,
  peekField,
  phrases,
  hunksOf,
  setBase,
  setHunks,
  setPeek,
  syntaxErrors,
} from './editor-setup'
import { lineSelection } from './editor-selection'
import { mention } from './file-menu'
import type { CodeMap } from './viewer'

/**
 * O editor de código do PC, no lugar do arquivo só leitura: o CodeMirror, com o cursor suave do VSCode,
 * desfazer, buscar e substituir, vários cursores (Ctrl+D, Alt+clique), dobrar, fechar parênteses e
 * Ctrl+/. Ctrl+S salva, conferindo antes se o arquivo mudou no disco desde que abriu.
 *
 * Acompanha o arquivo no disco (ver /ws/file no servidor): se o Claude gravar nele e não houver nada
 * por salvar aqui, o texto novo entra no lugar, com um lampejo nas linhas que mudaram e o cursor onde
 * estava; se houver, uma faixa pergunta o que fazer. As marcas na margem comparam o que está escrito
 * com o último commit enquanto se digita, e clicar numa abre a mudança ali mesmo, como no arquivo só
 * leitura. Os erros de sintaxe que o parser acha no trecho na tela vêm sublinhados, com o "Pedir ao Claude".
 *
 * Carregado só no PC, e só quando um arquivo abre (ver viewer.tsx). No celular o arquivo segue só leitura.
 */

export type EditorStatus = {
  saving: boolean
  /** O tamanho do arquivo depois da última gravação daqui; `null` antes dela. */
  size: number | null
  /** As linhas selecionadas (contando de 1); `null` sem seleção. */
  lines: [number, number] | null
  /** `current`: a última mudança acima do cursor (ou nele), contando de 0; -1 antes da primeira. */
  changes: { total: number; current: number; added: number; removed: number }
}

/** O que o cabeçalho do arquivo (ver viewer.tsx) pede ao editor. */
export type EditorHandle = {
  save: () => Promise<boolean>
  goChange: (dir: 1 | -1) => void
  /** Menciona no chat as linhas selecionadas (ou o arquivo, sem seleção). */
  mention: () => void
}

type Conflict = { content: string; hash: string } | 'gone'

/** O texto como o editor guarda: quebras de linha só com `\n` (a do arquivo volta ao salvar). */
const normalize = (text: string) => text.replace(/\r\n?/g, '\n')

function selectedLines(state: EditorState): [number, number] | null {
  const r = state.selection.main
  if (r.empty) return null
  const a = state.doc.lineAt(r.from).number
  let b = state.doc.lineAt(r.to).number
  // A seleção que termina no começo de uma linha não leva essa linha.
  if (b > a && state.doc.line(b).from === r.to) b--
  return [a, b]
}

const label = ([from, to]: [number, number]) => (from === to ? `linha ${from}` : `linhas ${from}–${to}`)

const NO_CHAT = { description: 'Aberta no PC: assuma a sessão para mencionar arquivos.' }

/** Um lugar novo para cada peek: o CodeMirror tira o elemento do anterior quando ele muda de linha. */
function peekHost(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'cm-peek'
  return el
}

export default function CodeEditor({
  viewing,
  file,
  wrap,
  minimap,
  handle,
  scrollRef,
  onStatus,
  onCode,
}: {
  viewing: Viewing
  /** Com `hash`: sem ele o arquivo não abre aqui (ver viewer.tsx). */
  file: Extract<FileView, { kind: 'text' }> & { hash: string }
  wrap: boolean
  /** O minimapa está à vista: só então vale montar o que ele desenha. */
  minimap: boolean
  handle: React.RefObject<EditorHandle | null>
  /** Onde o minimapa acompanha a rolagem (o rolador do próprio CodeMirror). */
  scrollRef: React.RefObject<HTMLElement | null>
  /** Estáveis, como um `setState`. */
  onStatus: (status: EditorStatus) => void
  onCode: (code: CodeMap | null) => void
}) {
  const { machine, cwd, path } = viewing
  const key = keyOf({ kind: 'file', machine, cwd, path })
  const name = path.slice(path.lastIndexOf('/') + 1)
  // Quebras de linha misturadas (CRLF e LF) ou CR sozinho: o editor guarda só `\n`, e salvar
  // reescreveria as linhas que você nem tocou. Abre só para leitura.
  const breaks = useMemo(() => {
    const crlf = file.content.split('\r\n').length - 1
    const lf = file.content.split('\n').length - 1 - crlf
    const cr = file.content.split('\r').length - 1 - crlf
    return { eol: crlf > 0 ? '\r\n' : '\n', mixed: cr > 0 || (crlf > 0 && lf > 0) }
  }, [file.content])
  const readOnly = file.truncated || breaks.mixed
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const dark = useDarkMode()
  const fontSize = useCodeFont((s) => s.size)

  // A versão do disco de onde o texto partiu (o hash que vai ao salvar) e o texto dela, para saber se há o que salvar.
  const base = useRef(file.hash)
  const saved = useRef<Text>(Text.empty)
  // A quebra de linha do arquivo, que volta ao salvar.
  const eol = useRef(breaks.eol)
  const saving = useRef<Promise<boolean> | null>(null)
  // Um aviso do disco que chegou no meio de uma gravação: conferido quando ela acaba.
  const missed = useRef<string | null | undefined>(undefined)
  const size = useRef<number | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  // A mudança aberta no peek, já no formato dele (ver changes.tsx).
  // A mudança aberta no peek: uma do git (contra o último commit) ou uma do disco (o que mudou por fora).
  const [peek, setPeekOpen] = useState<{ source: 'git' | 'disk'; index: number; total: number; host: HTMLElement; block: Block; pos: number; above: boolean } | null>(
    null,
  )
  // O menu do botão direito; com `ask` (o Ctrl+I), só os pedidos ao Claude, no lugar do cursor.
  const [menu, setMenu] = useState<{ x: number; y: number; lines: [number, number] | null; selection: boolean; ask?: boolean } | null>(null)
  const [symbols, setSymbols] = useState<CodeSymbol[] | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const conf = useMemo(() => ({ theme: new Compartment(), language: new Compartment(), wrap: new Compartment() }), [])

  const isDirty = () => Boolean(useUnsaved.getState().dirty[key])

  // ---- o que o cabeçalho e o minimapa leem ----

  const lastStatus = useRef('')
  const emitStatus = () => {
    const view = viewRef.current
    if (!view) return
    const { state } = view
    const { hunks } = state.field(changesField)
    const line = state.doc.lineAt(state.selection.main.head).number
    const { added, removed } = changeStats(state)
    const status: EditorStatus = {
      saving: saving.current !== null,
      size: size.current,
      lines: selectedLines(state),
      changes: {
        total: hunks.length,
        current: hunks.findLastIndex((h) => hunkLine(h, state.doc) <= line),
        added,
        removed,
      },
    }
    const text = JSON.stringify(status)
    if (text === lastStatus.current) return
    lastStatus.current = text
    onStatus(status)
  }

  // A linha e a coluna para a barra de status (ver lib/editor-cursor.ts).
  const language = useMemo(() => LanguageDescription.matchFilename(languages, name)?.name ?? null, [name])
  const emitCursor = (state: EditorState) => {
    const head = state.selection.main.head
    const line = state.doc.lineAt(head)
    const unit = state.facet(indentUnit)
    setEditorCursor(key, {
      line: line.number,
      col: head - line.from + 1,
      selected: state.selection.ranges.reduce((n, r) => n + r.to - r.from, 0),
      indent: unit === '\t' ? `Tabs: ${state.tabSize}` : `Espaços: ${unit.length}`,
      eol: eol.current === '\r\n' ? 'CRLF' : 'LF',
      language,
    })
  }

  const mapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scheduleMap = () => {
    if (!minimapOn.current) return
    clearTimeout(mapTimer.current)
    mapTimer.current = setTimeout(() => {
      const view = viewRef.current
      if (!view) return
      const { added, removed, marks } = changeStats(view.state)
      // Num arquivo enorme o mapa fica só com os traços cinza: colorir tudo a cada pausa pesaria.
      const tokens = view.state.doc.lines > 20_000 ? null : minimapTokens(view.state, darkRef.current)
      onCode({ lines: view.state.doc.toString().split('\n'), tokens, marks, changes: [], added, removed })
    }, 250)
  }
  const minimapOn = useRef(minimap)
  const darkRef = useRef(dark)

  // ---- salvar e o disco ----

  /** Grava; `false` se não deu (o arquivo mudou no disco, sumiu, ou a rede caiu), já com o aviso. */
  const save = (): Promise<boolean> => {
    const view = viewRef.current
    if (!view || readOnly) return Promise.resolve(false)
    if (saving.current) return saving.current
    if (!isDirty()) return Promise.resolve(true)
    const doc = view.state.doc
    const run = (async () => {
      let changed: string | null = null
      try {
        const r = await api.saveFile(machine, cwd, path, doc.sliceString(0, doc.length, eol.current), base.current)
        base.current = r.hash
        size.current = r.size
        saved.current = doc
        // O que foi escrito enquanto salvava continua por salvar.
        setDirty(key, !view.state.doc.eq(doc))
        void reloadGit(machine, cwd)
        return true
      } catch (err) {
        if (err instanceof ApiError && err.code === 'file_changed') changed = String(err.details.hash ?? '')
        else toast.error('Não deu para salvar', { description: errorMessage(err) })
        return false
      } finally {
        saving.current = null
        emitStatus()
        // Mudou no disco (a gravação foi recusada, ou alguém gravou logo depois): `onDisk` confere e, se preciso, pergunta.
        const late = missed.current
        missed.current = undefined
        if (changed !== null) void onDisk(changed)
        else if (late !== undefined) void onDisk(late)
      }
    })()
    saving.current = run
    emitStatus()
    return run
  }

  /** Troca o texto pelo do disco, mexendo só no que mudou: o cursor e a rolagem ficam onde estavam. */
  const applyDisk = (content: string, hash: string) => {
    const view = viewRef.current
    if (!view) return
    const old = view.state.doc.toString()
    const changes = diff(old, content)
    // O texto novo vira o "salvo" antes de entrar, para a troca não contar como alteração sua.
    const next = Text.of(content.split('\n'))
    const marks = diskMarksOf(view.state.doc, next)
    saved.current = next
    base.current = hash
    view.dispatch({
      changes: changes.map((c) => ({ from: c.fromA, to: c.toA, insert: content.slice(c.fromB, c.toB) })),
      // E fica marcado na margem, em laranja, até você ver (ver `diskGutter`).
      effects: addDiskMarks.of(marks),
      // Fora do desfazer: o Ctrl+Z não pode trazer de volta, sem aviso, o texto que o Claude trocou.
      annotations: [Transaction.userEvent.of('input.disk'), Transaction.addToHistory.of(false)],
    })
    setDirty(key, false)
    setConflict(null)
    flashLines(
      view,
      changes.map((c) => ({ from: c.fromB, to: c.toB })),
    )
  }

  /** O disco avisou um hash novo (ou `null`: o arquivo sumiu). */
  const onDisk = async (hash: string | null) => {
    if (hash === null) return setConflict('gone')
    if (hash === base.current) return setConflict((c) => (c === 'gone' ? null : c))
    // A própria gravação ainda em curso: quem salva confere no fim.
    if (saving.current) return void (missed.current = hash)
    const v = await api.file(machine, cwd, path).catch(() => null)
    const view = viewRef.current
    // Virou outra coisa (binário, fora do UTF-8, grande demais): fica o que está aqui, sem trocar.
    if (!view || v?.kind !== 'text' || !v.hash) return
    const disk = normalize(v.content)
    if (disk === view.state.doc.toString()) {
      base.current = v.hash
      saved.current = view.state.doc
      setDirty(key, false)
      setConflict(null)
    } else if (!isDirty()) applyDisk(disk, v.hash)
    else setConflict({ content: disk, hash: v.hash })
  }

  // ---- mandar para o chat ----

  /** O Claude lê o arquivo do disco, não o editor: antes de mandar linhas, grava o que mudou. */
  const ensureSaved = async () => {
    if (!isDirty()) return true
    const ok = await save()
    if (ok) toast('Salvo, para o Claude ler o mesmo que está aqui')
    return ok
  }

  const mentionLines = async (lines: [number, number] | null) => {
    if (await ensureSaved()) mention(path, lines ? { lines } : undefined)
  }

  const ask = async (line: number, message: string) => {
    if (!(await ensureSaved())) return
    if (!insertInChat(`@${path}#L${line} tem um erro de sintaxe: “${message}” Pode corrigir? `)) toast('Esta conversa não tem onde escrever agora', NO_CHAT)
  }

  // ---- mudanças desde o commit ----

  /** As mudanças com o texto de agora: a comparação refaz só depois de uma pausa na digitação. */
  const freshHunks = (view: EditorView) => {
    const { base } = view.state.field(changesField)
    if (base) view.dispatch({ effects: setHunks.of(hunksOf(base, view.state.doc) ?? []) })
    return view.state.field(changesField).hunks
  }

  const revealHunk = (k: number, select: boolean) => {
    const view = viewRef.current
    const h = view?.state.field(changesField).hunks[k]
    if (!view || !h) return
    const { doc } = view.state
    const from = doc.line(hunkLine(h, doc)).from
    // A um terço do alto, como no arquivo só leitura, para sobrar um pouco do que vem antes.
    view.dispatch({
      selection: select ? { anchor: from } : undefined,
      effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: view.scrollDOM.clientHeight / 3 }),
    })
    flashLines(view, [{ from, to: doc.line(Math.max(hunkLine(h, doc), h.toB - 1)).to }])
  }

  const goChange = (dir: 1 | -1) => {
    const view = viewRef.current
    if (!view) return
    const hunks = freshHunks(view)
    if (hunks.length === 0) return
    const line = view.state.doc.lineAt(view.state.selection.main.head).number
    const starts = hunks.map((h) => hunkLine(h, view.state.doc))
    let k = dir > 0 ? starts.findIndex((n) => n > line) : starts.findLastIndex((n) => n < line)
    if (k < 0) k = dir > 0 ? 0 : hunks.length - 1
    revealHunk(k, true)
    view.focus()
  }

  /** O peek da mudança `k`, como está agora; `null` se ela não existe mais. */
  const peekOf = (k: number) => {
    const view = viewRef.current
    if (!view) return null
    const hunks = freshHunks(view)
    const { base } = view.state.field(changesField)
    const hunk = hunks[k]
    if (!hunk || !base) return null
    const { doc } = view.state
    // Debaixo da última linha da mudança; numa que só tirou linhas, logo acima da que ficou.
    const above = hunk.toB === hunk.fromB && hunk.fromB <= doc.lines
    const line = doc.line(above ? hunk.fromB : Math.min(Math.max(hunk.fromB, hunk.toB - 1), doc.lines))
    return { source: 'git' as const, index: k, total: hunks.length, host: peekHost(), block: blockOf(hunk, base, doc), pos: above ? line.from : line.to, above }
  }

  /** O peek da marca `k` do que mudou no disco. */
  const diskPeekOf = (k: number) => {
    const view = viewRef.current
    const marks = view?.state.field(diskField)
    const mark = marks?.[k]
    if (!view || !mark) return null
    const { doc } = view.state
    const above = mark.from === mark.to && mark.from < doc.length
    const pos = above ? doc.lineAt(mark.from).from : doc.lineAt(mark.to).to
    return { source: 'disk' as const, index: k, total: marks.length, host: peekHost(), block: diskBlockOf(mark, doc), pos, above }
  }

  /** Marca vista: some da margem, e o peek vai para a seguinte (ou fecha, se era a última). */
  const seen = (k: number) => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: clearDiskMark.of(k) })
    const left = view.state.field(diskField).length
    setPeekOpen(left ? diskPeekOf(Math.min(k, left - 1)) : null)
  }

  const revealDisk = (k: number) => {
    const view = viewRef.current
    const m = view?.state.field(diskField)[k]
    if (!view || !m) return
    view.dispatch({ effects: EditorView.scrollIntoView(m.from, { y: 'start', yMargin: view.scrollDOM.clientHeight / 3 }) })
  }

  // ---- pedir ao Claude sobre o trecho ----

  const askAbout = async (lines: [number, number], what: Ask) => {
    if (await ensureSaved()) askClaude(path, lines, what)
  }

  /** O Ctrl+I: os pedidos ao Claude num menu no lugar do cursor, sobre a seleção (ou a linha dele). */
  const openAsk = () => {
    const view = viewRef.current
    if (!view) return
    const { head } = view.state.selection.main
    const at = view.coordsAtPos(head)
    const line = view.state.doc.lineAt(head).number
    setMenu({ x: at?.left ?? 0, y: at?.bottom ?? 0, lines: selectedLines(view.state) ?? [line, line], selection: !view.state.selection.main.empty, ask: true })
    setMenuOpen(true)
  }

  /** O Ctrl+Shift+O: os símbolos do arquivo, com o texto de agora. */
  const openSymbols = () => {
    const view = viewRef.current
    if (view) setSymbols(symbolsOf(view.state))
  }

  const goSymbol = (sym: CodeSymbol) => {
    setSymbols(null)
    const view = viewRef.current
    if (!view) return
    const line = view.state.doc.lineAt(Math.min(sym.from, view.state.doc.length))
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: view.scrollDOM.clientHeight / 3 }) })
    flashLines(view, [{ from: line.from, to: line.to }])
    view.focus()
  }

  // As funções acima leem o estado da vez; o CodeMirror, montado uma vez só, chama sempre a última.
  const actions = useRef({
    save,
    onDisk,
    ask,
    goChange,
    mentionLines,
    emitStatus,
    scheduleMap,
    openAsk,
    openSymbols,
    togglePeek: (_source: 'git' | 'disk', _k: number) => {},
    onUpdate: (_u: ViewUpdate) => {},
  })
  useLayoutEffect(() => {
    actions.current = {
      save,
      onDisk,
      ask,
      goChange,
      mentionLines,
      emitStatus,
      scheduleMap,
      openAsk,
      openSymbols,
      togglePeek: (source, k) => setPeekOpen((p) => (p?.source === source && p.index === k ? null : source === 'git' ? peekOf(k) : diskPeekOf(k))),
      onUpdate: (u) => {
        if (u.docChanged && u.transactions.some((tr) => !tr.isUserEvent('input.disk'))) {
          const now = !u.state.doc.eq(saved.current)
          setDirty(key, now)
          // Escrever numa prévia a fixa, como no VSCode: o próximo arquivo aberto não toma o lugar dela.
          if (now) pinTab(key)
          // E o texto vai para o aparelho, para sobreviver a recarregar a página.
          if (now) persistDraft(key, () => u.state.doc.sliceString(0, u.state.doc.length, eol.current), base.current)
          setPeekOpen(null)
        }
        const treeChanged = syntaxTree(u.state) !== syntaxTree(u.startState)
        const changesChanged = u.state.field(changesField) !== u.startState.field(changesField)
        if (u.docChanged || treeChanged || changesChanged) scheduleMap()
        if (u.docChanged || u.selectionSet || changesChanged) emitStatus()
        if (u.docChanged || u.selectionSet) emitCursor(u.state)
      },
    }
  })

  // ---- montar ----

  useEffect(() => {
    const draft = drafts.get(key)
    drafts.delete(key)
    const disk = normalize(file.content)
    const text = draft ? normalize(draft.text) : disk
    if (draft) base.current = draft.base
    const indent = detectIndent(text)
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          diskGutter((k) => actions.current.togglePeek('disk', k)),
          changeGutter((k) => actions.current.togglePeek('git', k)),
          foldGutter({ openText: '⌄', closedText: '›' }),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection({ cursorBlinkRate: 1200 }),
          lineSelection,
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          // Como no VSCode: Alt+clique põe outro cursor, e Shift+Alt+arrastar seleciona em coluna.
          EditorView.clickAddsSelectionRange.of((e) => e.altKey),
          rectangularSelection({ eventFilter: (e) => e.altKey && e.shiftKey }),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          // Sem LSP: as palavras do próprio arquivo, mais o que a linguagem já sabe (nomes locais, palavras-chave).
          autocompletion({ activateOnTyping: true, icons: false, override: [completions] }),
          syntaxErrors((line, message) => void actions.current.ask(line, message)),
          keymap.of([
            { key: 'Mod-h', run: openSearchPanel, preventDefault: true },
            { key: 'Mod-g', run: gotoLine, preventDefault: true },
            { key: 'Mod-i', run: () => (actions.current.openAsk(), true), preventDefault: true },
            { key: 'Mod-Shift-o', run: () => (actions.current.openSymbols(), true), preventDefault: true },
            { key: 'Tab', run: acceptCompletion },
            ...completionKeymap,
            { key: 'Mod-Alt-k', run: () => (void actions.current.mentionLines(selectedLines(view.state)), true) },
            { key: 'F7', run: () => (actions.current.goChange(1), true) },
            { key: 'Shift-F7', run: () => (actions.current.goChange(-1), true) },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...lintKeymap,
            indentWithTab,
          ]),
          indentUnit.of(indent),
          EditorState.tabSize.of(indent === '\t' ? 4 : indent.length),
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
          peekField,
          flashField,
          editorTheme,
          phrases,
          conf.theme.of(syntaxHighlighting(highlightStyle(dark))),
          conf.language.of([]),
          conf.wrap.of(wrap ? EditorView.lineWrapping : []),
          EditorView.updateListener.of((u) => actions.current.onUpdate(u)),
          EditorView.domEventHandlers({
            contextmenu: (e, v) => {
              e.preventDefault()
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
              const sel = v.state.selection.main
              // Fora da seleção, o clique leva o cursor para lá, como num editor.
              if (pos !== null && (pos < sel.from || pos > sel.to)) v.dispatch({ selection: { anchor: pos } })
              const at = v.state.doc.lineAt(pos ?? sel.head).number
              setMenu({ x: e.clientX, y: e.clientY, lines: selectedLines(v.state) ?? [at, at], selection: !v.state.selection.main.empty })
              setMenuOpen(true)
              return true
            },
          }),
        ],
      }),
    })
    viewRef.current = view
    scrollRef.current = view.scrollDOM
    saved.current = Text.of(disk.split('\n'))
    if (draft) setDirty(key, !view.state.doc.eq(saved.current))
    handle.current = {
      save: () => actions.current.save(),
      goChange: (dir) => actions.current.goChange(dir),
      mention: () => void actions.current.mentionLines(selectedLines(view.state)),
    }
    const unregister = registerSaver(key, () => actions.current.save())
    editorCommands.set(key, { gotoLine: () => (gotoLine(view), view.focus()) })
    emitStatus()
    emitCursor(view.state)

    // O rascunho guardado no aparelho chegou depois de o editor montar (logo ao abrir o app): entra se
    // você ainda não escreveu nada aqui.
    void draftsLoaded.then(() => {
      const late = drafts.get(key)
      if (!late || viewRef.current !== view || !view.state.doc.eq(saved.current)) return
      drafts.delete(key)
      base.current = late.base
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: normalize(late.text) }, annotations: Transaction.addToHistory.of(false) })
    })

    // A cor de cada linguagem baixa à parte, só a do arquivo aberto.
    void LanguageDescription.matchFilename(languages, name)
      ?.load()
      .then((support) => view.dom.isConnected && view.dispatch({ effects: conf.language.reconfigure(support) }))

    return () => {
      // Saiu da tela sem salvar (a aba foi para outro grupo): o texto espera o editor voltar.
      if (useUnsaved.getState().dirty[key]) drafts.set(key, { text: view.state.doc.sliceString(0, view.state.doc.length, eol.current), base: base.current })
      unregister()
      editorCommands.delete(key)
      setEditorCursor(key, null)
      clearTimeout(mapTimer.current)
      handle.current = null
      scrollRef.current = null
      viewRef.current = null
      view.destroy()
      onCode(null)
    }
    // Montado uma vez por arquivo (a aba é dele); o que muda depois entra pelos efeitos abaixo.
  }, [])

  // Aberto já numa linha (a busca nos arquivos, o `arquivo:12` do Ctrl+P): vai até ela e seleciona o achado.
  const rkey = revealKey(machine, cwd, path)
  const reveal = useReveal((s) => s[rkey])
  useEffect(() => {
    const view = viewRef.current
    if (!reveal || !view) return
    const { doc } = view.state
    const line = doc.line(Math.min(Math.max(1, reveal.line), doc.lines))
    const from = Math.min(line.from + (reveal.col ?? 0), line.to)
    const to = Math.min(from + (reveal.len ?? 0), line.to)
    view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) })
    flashLines(view, [{ from: line.from, to: line.to }])
    view.focus()
    doneReveal(rkey)
  }, [reveal, rkey])

  // O último commit, para as marcas: ao abrir, ao voltar para a janela e quando o git do projeto é relido (um commit).
  useEffect(() => {
    let alive = true
    const load = () =>
      api.gitBase(machine, cwd, path).then(
        (r) => {
          const view = viewRef.current
          if (alive && view) view.dispatch({ effects: setBase.of(r.content === null ? null : Text.of(normalize(r.content).split('\n'))) })
        },
        () => {},
      )
    void load()
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    const unsubscribe = subscribeGit(machine, cwd, onFocus)
    return () => {
      alive = false
      window.removeEventListener('focus', onFocus)
      unsubscribe()
    }
  }, [machine, cwd, path])

  // O arquivo no disco: o PC avisa a cada gravação (do Claude, de outro editor, de um `git checkout`).
  useEffect(() => {
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let wait = 1_000
    let alive = true
    const connect = () => {
      socket = new WebSocket(fileSocketUrl(machine, cwd, path))
      socket.onopen = () => (wait = 1_000)
      socket.onmessage = (e) => {
        const { hash } = JSON.parse(String(e.data)) as { hash: string | null }
        void actions.current.onDisk(hash)
      }
      // Caiu (rede, PC reiniciando): tenta de novo, cada vez esperando mais, até meio minuto.
      // O PC fecha com 1008 quando o arquivo ou o projeto não existe mais: não adianta insistir.
      socket.onclose = (e) => {
        if (!alive || e.code === 1008) return
        retry = setTimeout(connect, wait)
        wait = Math.min(wait * 2, 30_000)
      }
    }
    connect()
    return () => {
      alive = false
      clearTimeout(retry)
      socket?.close()
    }
  }, [machine, cwd, path])

  useEffect(() => {
    darkRef.current = dark
    viewRef.current?.dispatch({ effects: conf.theme.reconfigure(syntaxHighlighting(highlightStyle(dark))) })
    actions.current.scheduleMap()
  }, [dark, conf])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: conf.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }, [wrap, conf])

  useEffect(() => {
    minimapOn.current = minimap
    actions.current.scheduleMap()
  }, [minimap])

  // A fonte mudou (Ctrl+roda, Ctrl+=): a linha que estava no topo continua no topo.
  const topLine = useRef<number | null>(null)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const onScroll = () => (topLine.current = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from)
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
    return () => view.scrollDOM.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.requestMeasure()
    if (topLine.current !== null) view.dispatch({ effects: EditorView.scrollIntoView(topLine.current, { y: 'start' }) })
  }, [fontSize])

  // O peek aberto: debaixo da última linha da mudança; numa que só tirou linhas, logo acima da que ficou.
  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    if (!peek) return void v.dispatch({ effects: setPeek.of(null) })
    v.dispatch({ effects: setPeek.of({ pos: Math.min(peek.pos, v.state.doc.length), above: peek.above, host: peek.host }) })
  }, [peek])

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      // Ctrl+S de qualquer canto do editor (o texto, a busca, o peek), no lugar do "salvar página" do navegador.
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
          e.preventDefault()
          void save()
        } else if (e.key === 'Escape' && peek) setPeekOpen(null)
      }}
    >
      {readOnly && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          {breaks.mixed ? 'Quebras de linha misturadas (CRLF e LF): só para leitura, para salvar não reescrever o arquivo todo.' : 'Arquivo grande: mostrando só o primeiro 1 MB, sem editar.'}
        </div>
      )}
      {conflict && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs">
          <TriangleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          {conflict === 'gone' ? (
            <span className="min-w-0 flex-1">O arquivo foi apagado no disco. O texto continua aqui até a aba fechar.</span>
          ) : (
            <>
              <span className="min-w-0 flex-1">O arquivo mudou no disco (o Claude, ou outro editor) e você tem alterações não salvas.</span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  applyDisk(conflict.content, conflict.hash)
                  viewRef.current?.focus()
                }}
                title="Fica o que está no disco; o que você escreveu se perde"
              >
                <RotateCcw /> Recarregar
              </Button>
              <Button
                size="xs"
                onClick={() => {
                  // Salvar agora grava por cima do que está no disco.
                  base.current = conflict.hash
                  setConflict(null)
                  viewRef.current?.focus()
                }}
                title="Fica o seu texto; salvar grava por cima do que está no disco"
              >
                Manter o meu
              </Button>
            </>
          )}
          {conflict === 'gone' && (
            <Button size="icon-xs" variant="ghost" onClick={() => setConflict(null)} aria-label="Fechar o aviso">
              <X />
            </Button>
          )}
        </div>
      )}
      <div ref={host} className="min-h-0 flex-1" />
      {peek &&
        createPortal(
          <EditorPeek
            block={peek.block}
            index={peek.index}
            total={peek.total}
            path={path}
            disk={peek.source === 'disk' ? () => seen(peek.index) : undefined}
            onGo={(k) => {
              if (peek.source === 'git') {
                setPeekOpen(peekOf(k))
                revealHunk(k, false)
              } else {
                setPeekOpen(diskPeekOf(k))
                revealDisk(k)
              }
            }}
            onClose={() => setPeekOpen(null)}
            onShown={() => viewRef.current?.requestMeasure()}
          />,
          peek.host,
        )}
      <DropdownMenu open={menuOpen && Boolean(menu)} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="w-auto min-w-52"
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            viewRef.current?.focus()
          }}
        >
          {menu && (
            <>
              {menu.lines && (
                <>
                  <DropdownMenuLabel className="font-normal text-muted-foreground first-letter:uppercase">
                    {menu.ask ? `Pedir ao Claude · ${label(menu.lines)}` : label(menu.lines)}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {!menu.ask && (
                    <>
                      <DropdownMenuItem onSelect={() => void mentionLines(menu.lines)}>
                        <AtSign /> Mencionar no chat
                        <span className="ml-auto pl-4 text-xs text-muted-foreground">Ctrl+Alt+K</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="py-1 text-xs font-normal text-muted-foreground">
                        Pedir ao Claude <span className="float-right pl-4">Ctrl+I</span>
                      </DropdownMenuLabel>
                    </>
                  )}
                  {ASKS.map((a) => (
                    <DropdownMenuItem key={a.kind} onSelect={() => void askAbout(menu.lines!, a)}>
                      <a.icon /> {a.label}
                    </DropdownMenuItem>
                  ))}
                  {!menu.ask && <DropdownMenuSeparator />}
                </>
              )}
              {!menu.ask && (
                <>
                  <DropdownMenuItem disabled={!menu.selection || readOnly} onSelect={() => clipboard('cut')}>
                    <Scissors /> Recortar
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!menu.selection} onSelect={() => clipboard('copy')}>
                    <Copy /> Copiar
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={readOnly} onSelect={() => clipboard('paste')}>
                    <ClipboardPaste /> Colar
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={symbols !== null} onOpenChange={(o) => !o && setSymbols(null)}>
        <DialogContent
          showCloseButton={false}
          className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            viewRef.current?.focus()
          }}
        >
          <DialogTitle className="sr-only">Ir para um símbolo</DialogTitle>
          <DialogDescription className="sr-only">As funções, classes e títulos deste arquivo</DialogDescription>
          {symbols && <SymbolList symbols={symbols} onPick={goSymbol} />}
        </DialogContent>
      </Dialog>
    </div>
  )

  /** Recortar, copiar e colar pelo menu (pelo teclado, quem faz é o navegador). */
  function clipboard(action: 'cut' | 'copy' | 'paste') {
    const v = viewRef.current
    if (!v) return
    const { from, to } = v.state.selection.main
    if (action === 'paste') {
      navigator.clipboard.readText().then(
        (text) => v.dispatch(v.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true }),
        () => toast('O navegador não deixou colar por aqui', { description: 'Use Ctrl+V.' }),
      )
      return
    }
    const text = v.state.sliceDoc(from, to)
    navigator.clipboard.writeText(text).then(
      // Recorta só se o trecho ainda é o mesmo: o texto pode ter mudado enquanto o navegador copiava.
      () => action === 'cut' && v.state.sliceDoc(from, to) === text && v.dispatch({ changes: { from, to }, userEvent: 'delete.cut' }),
      () => toast.error('Não deu para copiar'),
    )
  }
}

/** O peek de uma mudança no editor, com as cores do Shiki nas linhas que entraram (ver changes.tsx). */
function EditorPeek({
  block,
  index,
  total,
  path,
  disk,
  onGo,
  onClose,
  onShown,
}: {
  block: Block
  index: number
  total: number
  path: string
  /** Uma mudança do disco (e não do git): o título é outro, e o "Visto" a tira da margem. */
  disk?: () => void
  onGo: (k: number) => void
  onClose: () => void
  onShown: () => void
}) {
  const tokens = useTokens(block.added.length ? block.added.join('\n') : null, path)
  // A altura do peek muda a das linhas abaixo: o editor mede de novo.
  useLayoutEffect(onShown, [onShown, block, tokens])
  return (
    <ChangePeek
      block={block}
      index={index}
      total={total}
      addedTokens={tokens ?? undefined}
      onGo={onGo}
      onClose={onClose}
      className="ml-1"
      title={disk ? 'Mudou no disco (o Claude ou outro programa)' : undefined}
      dot={disk ? 'bg-[#d97757]' : undefined}
      actions={
        disk && (
          <Button variant="ghost" size="xs" onClick={disk} title="Tirar a marca da margem">
            <Check /> Visto
          </Button>
        )
      }
    />
  )
}

const SYMBOL_ICON = { function: SquareFunction, method: SquareFunction, class: Box, type: Type, heading: Hash }

/** O Ctrl+Shift+O: os símbolos do arquivo, filtrados pelo que se digita (as letras na ordem, como no VSCode). */
function SymbolList({ symbols, onPick }: { symbols: CodeSymbol[]; onPick: (s: CodeSymbol) => void }) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const needle = q.trim().toLowerCase()
  const shown = needle
    ? symbols.filter((s) => {
        const name = s.name.toLowerCase()
        let i = 0
        for (const ch of name) if (ch === needle[i]) i++
        return i === needle.length
      })
    : symbols
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <>
      <input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const n = shown.length
            if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
          } else if (e.key === 'Enter' && shown[active]) {
            e.preventDefault()
            onPick(shown[active]!)
          }
        }}
        placeholder="Função, classe ou título deste arquivo"
        aria-label="Buscar símbolo"
        spellCheck={false}
        className="h-11 w-full border-b bg-transparent px-4 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
      />
      <div ref={list} role="listbox" className="max-h-[min(60vh,420px)] overflow-y-auto py-1">
        {shown.map((s, i) => (
          <button
            key={`${s.from}-${s.name}`}
            type="button"
            role="option"
            data-index={i}
            aria-selected={i === active}
            onMouseMove={() => setActive(i)}
            onClick={() => onPick(s)}
            style={{ paddingLeft: `${1 + Math.min(s.depth, 4) * 0.9}rem` }}
            className={cn('flex w-full min-w-0 items-center gap-2 py-1 pr-4 text-left text-[13px]', i === active && 'bg-muted')}
          >
            {createElement(SYMBOL_ICON[s.kind], { className: 'size-3.5 shrink-0 text-muted-foreground' })}
            <span className="truncate font-mono">{s.name}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{s.line}</span>
          </button>
        ))}
        {shown.length === 0 && (
          <p className="px-4 py-2 text-xs text-muted-foreground">{symbols.length ? 'Nenhum símbolo com esse nome.' : 'Este arquivo não tem funções, classes nem títulos que o editor reconheça.'}</p>
        )}
      </div>
    </>
  )
}
