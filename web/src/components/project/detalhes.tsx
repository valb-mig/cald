import { ArrowLeft, AtSign, BookText, Eye, Loader2, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { UndoBar } from '@/components/claude/bits'
import { footerButton } from '@/components/chat/composer-controls'
import { PromptInput, type PromptInputHandle } from '@/components/chat/prompt-input'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { saveDetalhes, useDetalhes, useDetalhesError } from '@/lib/detalhes'
import { relativeTime } from '@/lib/format'
import { useWide } from '@/lib/hooks'
import { MachineContext } from '@/lib/machines'
import { openViewer } from '@/lib/project-panel'
import { mentionsOf, newTodoId } from '@/lib/todos'
import type { Detalhe } from '@/lib/types'
import { cn } from '@/lib/utils'

/** O que está no editor: o detalhe como você está escrevendo, salvo sozinho logo depois de parar. */
type Draft = { id: string; title: string; body: string; createdAt: number }

const toDraft = (d: Detalhe): Draft => ({ id: d.id, title: d.title, body: d.body, createdAt: d.createdAt })
const dirtyOf = (draft: Draft, saved: Detalhe | undefined) => (saved ? draft.title.trim() !== saved.title || draft.body !== saved.body : !!draft.title.trim())

/** Quanto esperar depois da última tecla para salvar. */
const SAVE_DELAY = 800
/** Quanto tempo o Desfazer de um detalhe apagado fica na tela. */
const UNDO_MS = 10_000

/**
 * Os detalhes do projeto, no hub (Mesa · Worktrees · Detalhes): como cada parte dele funciona, escrito
 * por você em Markdown, com `@` para arquivos. A conversa do projeto abre sabendo só as chaves e os
 * títulos (ver server/src/editr-mcp.ts) e lê o conteúdo do que precisar, em vez de varrer o código. No
 * PC, a lista e o editor lado a lado; no celular, a lista, e o detalhe abre no lugar dela. Salva sozinho.
 */
export function DetalhesView({ machine, cwd, className }: { machine: string; cwd: string; className?: string }) {
  const items = useDetalhes(machine, cwd)
  const error = useDetalhesError(machine, cwd)
  const wide = useWide()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [undo, setUndo] = useState<{ item: Detalhe; index: number } | null>(null)
  // No PC o editor nunca fica vazio enquanto há detalhe: sem um escolhido, mostra o primeiro.
  const current = draft ?? (wide && items?.[0] ? toDraft(items[0]) : null)
  const saved = current ? items?.find((d) => d.id === current.id) : undefined
  const dirty = current ? dirtyOf(current, saved) : false

  // O commit da saída (trocar de detalhe, sair da aba) lê a lista e o rascunho de agora, não os do render.
  const latest = useRef({ items, current })
  latest.current = { items, current }

  /** Grava o rascunho, se mudou e tem título, e devolve a lista como ficou (para quem grava em seguida). */
  const commit = (d: Draft): Detalhe[] | null => {
    const list = latest.current.items
    if (!list || !d.title.trim()) return list
    const old = list.find((x) => x.id === d.id)
    if (!dirtyOf(d, old)) return list
    const item: Detalhe = { ...old, id: d.id, title: d.title.trim(), body: d.body, createdAt: d.createdAt, updatedAt: Date.now() }
    const next = old ? list.map((x) => (x.id === d.id ? item : x)) : [...list, item]
    saveDetalhes(machine, cwd, next)
    return next
  }

  // Salva sozinho logo depois de parar de digitar.
  useEffect(() => {
    if (!current || !dirty) return
    const timer = setTimeout(() => commit(current), SAVE_DELAY)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, dirty])

  // Saindo da aba (Mesa, Worktrees) com algo ainda por salvar: salva antes.
  useEffect(
    () => () => {
      const d = latest.current.current
      if (d) commit(d)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useEffect(() => {
    if (!undo) return
    const timer = setTimeout(() => setUndo(null), UNDO_MS)
    return () => clearTimeout(timer)
  }, [undo])

  const open = (next: Draft | null) => {
    if (current) commit(current)
    setDraft(next)
  }
  const remove = (d: Draft) => {
    const index = items?.findIndex((x) => x.id === d.id) ?? -1
    setDraft(null)
    // Um detalhe novo que nunca salvou só some; um salvo vai embora com Desfazer.
    if (!items || index < 0) return
    setUndo({ item: items[index]!, index })
    saveDetalhes(
      machine,
      cwd,
      items.filter((x) => x.id !== d.id),
    )
  }
  const restore = () => {
    // O que está no editor salva antes, e o apagado volta por cima dessa lista: senão um gravaria por cima do outro.
    const base = current ? commit(current) : items
    if (!undo || !base) return
    const next = [...base]
    next.splice(Math.min(undo.index, next.length), 0, undo.item)
    saveDetalhes(machine, cwd, next)
    setDraft(toDraft(undo.item))
    setUndo(null)
  }

  if (error && !items) return <p className="p-6 text-center text-sm text-muted-foreground">{error}</p>
  if (!items)
    return (
      <div className="flex justify-center p-10">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )

  const fresh = () => open({ id: newTodoId(), title: '', body: '', createdAt: Date.now() })
  const showList = wide || !current
  const showEditor = !!current

  return (
    <div className={cn('relative flex min-h-[28rem] gap-2', wide && 'h-[min(44rem,calc(100dvh-10rem))]', className)}>
      {!items.length && !current ? (
        <Empty onNew={fresh} />
      ) : (
        <>
          {showList && (
            <nav className={cn('flex min-h-0 flex-col', wide ? 'w-72 shrink-0' : 'flex-1')}>
              <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-2">
                <span className="text-xs text-muted-foreground">{items.length === 1 ? '1 detalhe' : `${items.length} detalhes`}</span>
                <Button size="sm" variant="ghost" onClick={fresh} className="pointer-coarse:min-h-11">
                  <Plus /> Novo
                </Button>
              </div>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
                {items.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    aria-current={current?.id === d.id}
                    onClick={() => current?.id !== d.id && open(toDraft(d))}
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-foreground/[0.04] aria-current:bg-foreground/[0.06] pointer-coarse:min-h-11"
                  >
                    <span className={cn('min-w-0 flex-1 truncate', !d.body.trim() && 'text-muted-foreground')}>{d.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(d.updatedAt ?? d.createdAt)}</span>
                  </button>
                ))}
                {/* O novo, enquanto não tem título salvo, também aparece na lista. */}
                {current && !saved && (
                  <div aria-current className="flex min-w-0 items-center rounded-lg bg-foreground/[0.06] px-2.5 py-2 text-[13px] text-muted-foreground pointer-coarse:min-h-11">
                    <span className="truncate">{current.title.trim() || 'Novo detalhe'}</span>
                  </div>
                )}
              </div>
            </nav>
          )}
          {showEditor && (
            <Editor
              key={current.id}
              machine={machine}
              cwd={cwd}
              draft={current}
              saved={saved}
              dirty={dirty}
              onChange={(patch) => setDraft({ ...current, ...patch })}
              onBack={wide ? undefined : () => open(null)}
              onRemove={() => remove(current)}
            />
          )}
        </>
      )}
      {undo && (
        <div className="absolute inset-x-2 bottom-2">
          <UndoBar text={`${undo.item.title} foi apagado`} onUndo={restore} />
        </div>
      )}
    </div>
  )
}

/**
 * Os detalhes no celular, onde não há hub: uma folha de baixo, aberta pelo menu do projeto (dedo
 * segurado nele em Projetos, nas Conversas ou na barra do projeto). No PC o menu abre o hub nos detalhes.
 */
export function DetalhesSheet({ project, onClose }: { project: { machine: string; cwd: string; name: string } | null; onClose: () => void }) {
  return (
    <Sheet open={!!project} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" showCloseButton={false} className="gap-0 p-0 data-[side=bottom]:h-[92dvh]">
        {project && (
          <>
            <header className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
              <BookText className="size-4 shrink-0 text-muted-foreground" />
              <SheetTitle className="min-w-0 flex-1 truncate text-sm">Detalhes · {project.name}</SheetTitle>
              <SheetDescription className="sr-only">Como cada parte do projeto funciona, para o Claude ler só o que precisa.</SheetDescription>
              <SheetClose asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Fechar" title="Fechar" className="-mr-1 pointer-coarse:size-11">
                  <X />
                </Button>
              </SheetClose>
            </header>
            <DetalhesView machine={project.machine} cwd={project.cwd} className="min-h-0 flex-1 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]" />
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Empty({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <BookText className="size-10 text-muted-foreground/40" strokeWidth={1.5} />
      <div className="space-y-1">
        <p className="text-sm font-medium">Como o projeto funciona</p>
        <p className="max-w-sm text-xs text-muted-foreground">O Claude abre a conversa sabendo os títulos e lê só o que precisar, sem varrer o código.</p>
      </div>
      <Button size="sm" onClick={onNew} className="pointer-coarse:min-h-11">
        <Plus /> Novo detalhe
      </Button>
    </div>
  )
}

/**
 * Um detalhe: o título grande e o conteúdo num bloco, como a descrição do TODO (Markdown, `@` para
 * arquivos, o olho para ver como fica). Na casca, a chave que o Claude usa para pedir e se já salvou.
 */
function Editor({
  machine,
  cwd,
  draft,
  saved,
  dirty,
  onChange,
  onBack,
  onRemove,
}: {
  machine: string
  cwd: string
  draft: Draft
  saved: Detalhe | undefined
  dirty: boolean
  onChange: (patch: Partial<Draft>) => void
  /** Só no celular: volta para a lista. */
  onBack?: () => void
  onRemove: () => void
}) {
  const [showPreview, setShowPreview] = useState(false)
  const field = useRef<PromptInputHandle>(null)
  const mentions = mentionsOf(draft.body)
  const status = !draft.title.trim() ? (saved ? 'Sem título, não salva' : null) : dirty ? 'Salvando…' : 'Salvo'
  const tool = cn(footerButton, 'px-0 hover:bg-foreground/[0.07] active:bg-foreground/[0.07] aria-pressed:bg-foreground/[0.08] aria-pressed:text-foreground')

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 rounded-lg bg-background p-5 max-sm:p-4">
      <header className="-mt-1 flex min-h-8 items-center gap-1">
        {onBack && (
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Voltar" title="Voltar" className="-ml-2 pointer-coarse:size-11">
            <ArrowLeft />
          </Button>
        )}
        {saved?.chave && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title="A chave que o Claude usa para ler este detalhe">
            {saved.chave}
          </span>
        )}
        <span className="flex-1" />
        {status && <span className="shrink-0 text-xs text-muted-foreground">{status}</span>}
        <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Apagar" title="Apagar" className="hover:text-destructive pointer-coarse:size-11">
          <Trash2 />
        </Button>
      </header>

      <textarea
        value={draft.title}
        // Uma linha só, que quebra na tela: é o que o Claude lê no índice.
        onChange={(e) => onChange({ title: e.target.value.replace(/\s*\n\s*/g, ' ') })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            field.current?.focus()
          }
        }}
        placeholder="Título, ex.: Avatares"
        maxLength={120}
        rows={1}
        autoFocus={!saved}
        aria-label="Título"
        className="w-full shrink-0 resize-none bg-transparent text-lg leading-snug font-semibold outline-none [field-sizing:content] placeholder:text-muted-foreground/60 wide:text-xl"
      />

      <MachineContext value={machine}>
        <div className="flex min-h-0 flex-1 flex-col rounded-xl bg-foreground/[0.04] transition-colors focus-within:bg-foreground/[0.06]">
          {showPreview ? (
            <div className="min-h-48 flex-1 overflow-y-auto px-3.5 py-3">
              {draft.body.trim() ? <Markdown text={draft.body} /> : <p className="text-sm text-muted-foreground">Nada para ver ainda.</p>}
            </div>
          ) : (
            <PromptInput
              handleRef={field}
              cwd={cwd}
              value={draft.body}
              onChange={(body) => onChange({ body })}
              placement="bottom"
              placeholder="Como funciona: onde fica no código, o fluxo, o que não é óbvio…"
              aria-label="Conteúdo"
              className="min-h-48 flex-1 resize-none overflow-y-auto rounded-none border-0 bg-transparent px-3.5 py-3 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
            />
          )}
          <div className="flex shrink-0 items-center gap-0.5 px-1.5 pb-1.5">
            <button
              type="button"
              aria-label="Mencionar um arquivo"
              title="Mencionar um arquivo"
              disabled={showPreview}
              // Sem tirar o foco do conteúdo: perder o foco fecha as sugestões logo depois de abrir.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => field.current?.insert('@')}
              className={tool}
            >
              <AtSign className="size-4" />
            </button>
            <span className="flex-1" />
            <button
              type="button"
              aria-label="Ver como fica"
              aria-pressed={showPreview}
              title={showPreview ? 'Voltar a escrever' : 'Ver como fica (Markdown)'}
              onClick={() => setShowPreview((on) => !on)}
              className={tool}
            >
              <Eye className="size-4" />
            </button>
          </div>
        </div>
      </MachineContext>

      {mentions.length > 0 && (
        <div className="flex max-h-20 shrink-0 flex-wrap gap-1.5 overflow-y-auto">
          {mentions.map((path) => (
            <button
              key={path}
              type="button"
              onClick={() => openViewer({ machine, cwd, path: path.replace(/\/$/, '') })}
              title={`Abrir ${path}`}
              className="flex h-7 max-w-full items-center gap-1 rounded-md bg-foreground/[0.04] px-2 font-mono text-xs transition-colors hover:bg-foreground/[0.08] pointer-coarse:h-9"
            >
              <AtSign className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{path}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
