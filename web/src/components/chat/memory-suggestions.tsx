import { Check, Lightbulb, MessageSquareQuote, Pencil, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FIELD } from '@/components/island'
import { Tag, UndoBar } from '@/components/claude/bits'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { ApiError, errorMessage } from '@/lib/api'
import { useBackToClose } from '@/lib/back-close'
import { insertInto } from '@/lib/compose'
import { relativeTime } from '@/lib/format'
import { useWide } from '@/lib/hooks'
import { MEMORY_TYPES } from '@/lib/memory'
import {
  closeMemorySuggestions,
  dismissMemorySuggestion,
  openMemorySuggestions,
  restoreMemorySuggestion,
  saveMemorySuggestion,
  useMemorySuggestions,
  useSessionMemorySuggestions,
} from '@/lib/memory-suggestions'
import type { MemorySuggestion } from '@/lib/types'
import { useUndo } from '@/lib/undo'
import { cn } from '@/lib/utils'

/**
 * As memórias que o Claude quis guardar nesta conversa (ver server/src/memory-suggestions.ts): em vez
 * de gravar, ele segue trabalhando, e a sugestão espera aqui. O botão no topo do chat só aparece com
 * alguma esperando, com quantas são.
 */
export function MemorySuggestionsButton({ sessionId }: { sessionId: string }) {
  const list = useSessionMemorySuggestions(sessionId)
  const open = useMemorySuggestions((s) => s.open === sessionId)
  if (!list.length && !open) return null
  return (
    <Button
      variant={open ? 'secondary' : 'ghost'}
      size="icon"
      className="relative"
      onClick={() => openMemorySuggestions(sessionId)}
      aria-label={`Sugestões de memória: ${list.length}`}
      title="Sugestões de memória"
    >
      <Lightbulb />
      {list.length > 0 && (
        <span className="absolute top-0.5 right-0 min-w-4 rounded-full bg-amber-500 px-1 text-center text-[9px] leading-4 font-semibold text-white">
          {list.length > 99 ? '99+' : list.length}
        </span>
      )}
    </Button>
  )
}

// Celular primeiro: o alvo do dedo tem 44 px; no PC, o tamanho de sempre.
const ACTION = 'h-11 px-4 wide:h-8 wide:px-3.5'
const ICON_ACTION = 'size-11 wide:size-8'

/**
 * A lista das sugestões: salvar, editar antes de salvar, mencionar no chat ou recusar (com Desfazer).
 * No celular, uma folha de baixo; no PC, a ilha da direita, do lado do botão que a abriu.
 */
export function MemorySuggestionsSheet({ sessionId }: { sessionId: string }) {
  const list = useSessionMemorySuggestions(sessionId)
  const open = useMemorySuggestions((s) => s.open === sessionId)
  const wide = useWide()
  const [undo, setUndo] = useUndo()
  useBackToClose(open, closeMemorySuggestions)
  // Mencionou: o foco fica na caixa de mensagem, e não volta para o botão do topo ao fechar.
  const mentioned = useRef(false)

  const dismiss = async (s: MemorySuggestion) => {
    try {
      await dismissMemorySuggestion(sessionId, s.id)
      setUndo([s.id])
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const mention = (s: MemorySuggestion) => {
    if (!insertInto(sessionId, `Sobre a memória que você sugeriu, “${s.name}”: `)) {
      toast('A caixa de mensagem desta conversa não está na tela.')
      return
    }
    mentioned.current = true
    closeMemorySuggestions()
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && closeMemorySuggestions()}>
      <SheetContent
        side={wide ? 'right' : 'bottom'}
        showCloseButton={false}
        className={cn('gap-0', wide ? 'data-[side=right]:w-[28rem] data-[side=right]:sm:max-w-[28rem]' : 'max-h-[85dvh]')}
        onCloseAutoFocus={(e) => {
          if (mentioned.current) e.preventDefault()
          mentioned.current = false
        }}
      >
        <header className="flex shrink-0 items-start gap-2 px-4 pt-3 pb-2 wide:px-5 wide:pt-5 wide:pb-3">
          <div className="min-w-0 flex-1 pt-2 wide:pt-0">
            <SheetTitle className="flex items-baseline gap-1.5">
              Sugestões de memória
              {list.length > 0 && <span className="text-sm font-normal text-muted-foreground tabular-nums">{list.length}</span>}
            </SheetTitle>
            <SheetDescription className="text-xs">O que o Claude quis guardar nesta conversa.</SheetDescription>
          </div>
          <SheetClose asChild>
            <Button variant="ghost" size="icon" className={cn(ICON_ACTION, '-mr-2 wide:-mt-1')} aria-label="Fechar">
              <X />
            </Button>
          </SheetClose>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-[max(0.75rem,var(--safe-bottom))] *:shrink-0 wide:px-4 wide:pb-4">
          {list.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
              <Lightbulb className="size-8 opacity-40" />
              Nenhuma sugestão esperando.
            </div>
          ) : (
            list.map((s) => (
              // A chave muda quando o Claude troca a sugestão: o que estava sendo editado era da de antes.
              <SuggestionRow key={`${s.id}:${s.createdAt}`} sessionId={sessionId} suggestion={s} onDismiss={() => void dismiss(s)} onMention={() => mention(s)} />
            ))
          )}
          {/* No pé: na ilha alta do PC, embaixo, e não colado na última sugestão. */}
          {undo && (
            <div className="sticky bottom-0 z-10 mt-auto">
              <UndoBar
                text="Sugestão recusada"
                onUndo={() => {
                  setUndo(null)
                  restoreMemorySuggestion(sessionId, undo[0]!).catch((err: unknown) => toast.error(errorMessage(err)))
                }}
              />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * Uma sugestão, no tom do bloco: o nome, a descrição e os selos, o começo do texto e as ações numa
 * fileira só. À esquerda, o que guarda (Salvar, Editar); à direita, só ícone, o que não guarda agora
 * (Mencionar, Recusar).
 */
function SuggestionRow({
  sessionId,
  suggestion: s,
  onDismiss,
  onMention,
}: {
  sessionId: string
  suggestion: MemorySuggestion
  onDismiss: () => void
  onMention: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [description, setDescription] = useState(s.description)
  const [body, setBody] = useState(s.body)
  const [saving, setSaving] = useState(false)

  const save = async (edit?: { description: string; body: string }) => {
    if (saving) return
    setSaving(true)
    try {
      await saveMemorySuggestion(sessionId, s.id, edit)
      toast.success('Memória salva')
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.code === 'memory_changed' ? 'A memória mudou desde a sugestão. Peça ao Claude para sugerir de novo.' : errorMessage(err),
      )
      setSaving(false)
    }
  }
  const cancel = () => {
    setEditing(false)
    setDescription(s.description)
    setBody(s.body)
  }

  return (
    <div className="rounded-xl bg-foreground/[0.04] p-1">
      <div className="px-2.5 pt-2">
        <div className="text-sm leading-snug font-medium break-words">{s.name}</div>
        {!editing && s.description && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{s.description}</div>}
        {/* Nova é o comum: o selo só aparece quando ela muda uma memória que já existe. */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {s.type && <Tag>{MEMORY_TYPES[s.type] ?? s.type}</Tag>}
          {s.update && <Tag title="Muda uma memória que já existe">atualiza</Tag>}
          <span className="text-[11px] text-muted-foreground" title={new Date(s.createdAt).toLocaleString('pt-BR')}>
            {relativeTime(s.createdAt)}
          </span>
        </div>
      </div>

      {editing ? (
        <div
          className="space-y-2 px-1.5 pt-2.5"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && body.trim()) {
              e.preventDefault()
              void save({ description, body })
            }
          }}
        >
          {/* A descrição é uma linha do índice: o Enter não quebra, e o campo cresce com o texto. */}
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.replace(/\n/g, ' '))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) e.preventDefault()
            }}
            maxLength={1000}
            rows={1}
            placeholder="Descrição"
            aria-label="Descrição"
            className={cn(FIELD, 'block resize-none text-[13px] [field-sizing:content]')}
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label="Texto da memória"
            autoFocus
            spellCheck={false}
            className={cn(FIELD, 'block max-h-[50dvh] min-h-40 resize-none font-mono text-[12.5px] leading-relaxed [field-sizing:content]')}
          />
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" className={ACTION} onClick={cancel}>
              Cancelar
            </Button>
            <Button className={ACTION} disabled={saving || !body.trim()} onClick={() => void save({ description, body })} title="Ctrl+Enter">
              <Check /> Salvar
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Preview text={s.body} />
          <div className="mt-1 flex items-center gap-1">
            <Button className={ACTION} disabled={saving} onClick={() => void save()}>
              <Check /> Salvar
            </Button>
            <Button variant="ghost" className={ACTION} onClick={() => setEditing(true)}>
              <Pencil /> Editar
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn(ICON_ACTION, 'ml-auto text-muted-foreground')}
              onClick={onMention}
              aria-label="Mencionar no chat"
              title="Mencionar no chat"
            >
              <MessageSquareQuote />
            </Button>
            <Button variant="ghost" size="icon" className={cn(ICON_ACTION, 'text-muted-foreground hover:text-destructive')} onClick={onDismiss} aria-label="Recusar" title="Recusar">
              <X />
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * O começo do texto, esfumaçado no pé; tocar abre inteiro, e de novo recolhe. Curto, ele cabe e fica
 * como está, sem esfumaçar. Arrastar para selecionar um trecho não conta como toque.
 */
function Preview({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [clamped, setClamped] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Passou da altura? Muda com a largura da folha.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [open, text])

  const toggle = () => {
    if (clamped && window.getSelection()?.isCollapsed !== false) setOpen(!open)
  }
  // Recolhido, ele é o botão que abre; aberto, volta a ser texto (com os links e o copiar dos blocos).
  const opener = clamped && !open
  return (
    <div
      ref={ref}
      role={opener ? 'button' : undefined}
      tabIndex={opener ? 0 : undefined}
      aria-expanded={opener ? false : undefined}
      onClick={toggle}
      onKeyDown={(e) => {
        if (opener && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          setOpen(true)
        }
      }}
      className={cn(
        'mx-1.5 mt-2 rounded-lg px-1 text-foreground/85 outline-none focus-visible:ring-1 focus-visible:ring-foreground/15',
        clamped && 'cursor-pointer',
        !open && 'max-h-[4.75rem] overflow-hidden',
        !open && clamped && '[mask-image:linear-gradient(to_bottom,#000_40%,transparent)]',
      )}
    >
      <Markdown text={text} className="text-[13px]" />
    </div>
  )
}
