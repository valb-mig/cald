import { AtSign, Eye, FileText, Hash, Loader2, MessageSquarePlus, Paperclip, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { footerButton } from '@/components/chat/composer-controls'
import { DropOverlay, useFileDrop } from '@/components/chat/file-drop'
import { PromptInput, type PromptInputHandle } from '@/components/chat/prompt-input'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api, errorMessage, todoFileUrl } from '@/lib/api'
import { formatSize, toAttachment } from '@/lib/attachments'
import { pastedFiles } from '@/lib/compose'
import { MachineContext } from '@/lib/machines'
import { insertInChat, openViewer, type PanelProject } from '@/lib/project-panel'
import { mentionsOf, newTodoId, saveTodos, useTodoError, useTodos } from '@/lib/todos'
import type { Todo, TodoFile } from '@/lib/types'
import { cn } from '@/lib/utils'
import { TodoEmptyArt } from './empty-art'

// A descrição numa linha só, para a lista: sem a marcação do Markdown nem o caminho inteiro das menções.
const preview = (body: string) =>
  body
    .replace(/(^|\s)@([^\s]+)/g, (_, space: string, path: string) => `${space}@${path.replace(/\/$/, '').split('/').pop()}`)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(^|\s)(#{1,6}|[-*+]|>|\d+\.)\s/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const isImage = (type: string) => type.startsWith('image/')

function TodoRow({ item, onToggle, onOpen, onRemove }: { item: Todo; onToggle: () => void; onOpen: () => void; onRemove: () => void }) {
  const mentions = mentionsOf(item.body).length
  const text = preview(item.body)
  return (
    <div className="group flex min-w-0 items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors hover:bg-foreground/[0.04]">
      <Checkbox checked={item.done} onCheckedChange={onToggle} aria-label={item.done ? 'Marcar como não feito' : 'Marcar como feito'} className="mt-0.5" />
      {/* O item inteiro abre o editor; o número é o que o chat menciona (TODO:3). */}
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className={cn('block text-[13px] leading-snug break-words', item.done && 'text-muted-foreground line-through decoration-muted-foreground/50')}>
          {item.n !== undefined && <span className="mr-1.5 font-mono text-[11px] text-muted-foreground/70">{item.n}</span>}
          {item.title}
        </span>
        {(text || item.files.length > 0 || mentions > 0) && (
          <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {text && <span className="min-w-0 truncate">{text}</span>}
            {item.files.length > 0 && (
              <span className="flex shrink-0 items-center gap-0.5" title={`${item.files.length} anexo(s)`}>
                <Paperclip className="size-3" />
                {item.files.length}
              </span>
            )}
            {mentions > 0 && (
              <span className="flex shrink-0 items-center gap-0.5" title={`${mentions} arquivo(s) mencionado(s)`}>
                <AtSign className="size-3" />
                {mentions}
              </span>
            )}
          </span>
        )}
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onRemove}
        aria-label="Apagar"
        title="Apagar"
        className="-my-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <X />
      </Button>
    </div>
  )
}

/** Um anexo ainda não guardado (escolhido agora) ou já no PC. */
type Draft = { key: string; saved?: TodoFile; file?: File; url?: string }

function AttachmentTile({ draft, machine, onRemove }: { draft: Draft; machine: string; onRemove: () => void }) {
  const name = draft.saved?.name ?? draft.file?.name ?? 'arquivo'
  const type = draft.saved?.mediaType ?? draft.file?.type ?? ''
  const size = draft.saved?.size ?? draft.file?.size ?? 0
  const href = draft.saved ? todoFileUrl(machine, draft.saved) : draft.url
  // Sem borda, como a bandeja da caixa do chat: a miniatura num tom acima do bloco, e o "tirar" no canto.
  return (
    <div className="group relative shrink-0">
      {isImage(type) && href ? (
        <a href={href} target="_blank" rel="noreferrer" title={name} className="block size-16 overflow-hidden rounded-lg bg-foreground/[0.05]">
          <img src={href} alt={name} className="size-full object-cover" />
        </a>
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          download={draft.saved ? name : undefined}
          title={name}
          className="flex h-16 w-36 flex-col justify-between rounded-lg bg-foreground/[0.05] p-2 transition-colors hover:bg-foreground/[0.08]"
        >
          <FileText className="size-4 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block truncate text-xs">{name}</span>
            <span className="text-[11px] text-muted-foreground">{formatSize(size)}</span>
          </span>
        </a>
      )}
      {!draft.saved && <span className="absolute right-1 bottom-1 rounded bg-background/85 px-1 text-[10px] text-muted-foreground">novo</span>}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Tirar ${name}`}
        title="Tirar"
        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background opacity-0 shadow transition-opacity group-hover:opacity-100 after:absolute after:-inset-2 focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

/**
 * O editor de um item, numa ilha como a das habilidades: na casca, o número e as ações (mandar para o
 * chat, apagar, salvar, fechar); na janela, o feito e o título grande, e um bloco com a descrição
 * (Markdown, com `@` para arquivos e `#` para issues e PRs, como no chat, e o olho para ver como fica),
 * os anexos (imagens e documentos: pelo clipe, colando ou arrastando) e, embaixo, os arquivos
 * mencionados (clicar abre). Os anexos novos sobem só ao salvar. "Mandar para o chat" põe o `TODO:n`
 * na conversa do projeto: o Claude recebe o item inteiro.
 */
function TodoEditor({
  project,
  item,
  initialTitle,
  initialFiles,
  onClose,
  onSave,
  onRemove,
}: {
  project: PanelProject
  /** `null`: um item novo. */
  item: Todo | null
  initialTitle?: string
  /** Colados ou soltos na lista antes de abrir: o item novo já nasce com eles. */
  initialFiles?: File[]
  onClose: () => void
  onSave: (item: Todo) => void
  onRemove?: () => void
}) {
  const [title, setTitle] = useState(item?.title ?? initialTitle ?? '')
  const [body, setBody] = useState(item?.body ?? '')
  const [done, setDone] = useState(item?.done ?? false)
  const [files, setFiles] = useState<Draft[]>(() => [
    ...(item?.files ?? []).map((f) => ({ key: f.id, saved: f })),
    ...(initialFiles ?? []).map((file) => ({ key: `${file.name}-${file.size}-${Math.random()}`, file, url: URL.createObjectURL(file) })),
  ])
  const [showPreview, setShowPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const field = useRef<PromptInputHandle>(null)
  const mentions = mentionsOf(body)
  const numbered = item?.n !== undefined

  // As prévias locais dos anexos novos saem da memória quando o editor fecha.
  useEffect(() => () => files.forEach((d) => d.url && URL.revokeObjectURL(d.url)), [files])

  const add = (list: File[]) =>
    setFiles((current) => [
      ...current,
      ...list.map((file) => ({ key: `${file.name}-${file.size}-${Math.random()}`, file, url: URL.createObjectURL(file) })),
    ])
  const drop = useFileDrop(add)
  // O diálogo fica dentro da lista na árvore do React (o portal só muda o DOM), e a lista também recebe
  // arquivos soltos: sem parar aqui, soltar no editor de um item abria por trás um item novo no lugar dele.
  const contain = (handler: (e: React.DragEvent) => void) => (e: React.DragEvent) => {
    e.stopPropagation()
    handler(e)
  }

  const save = async () => {
    if (!title.trim() || saving) return
    setSaving(true)
    try {
      // Os novos sobem um por vez (cada um pode ter vários MB); as imagens vão reduzidas, como no chat.
      const saved: TodoFile[] = []
      for (const d of files) {
        if (d.saved) saved.push(d.saved)
        else if (d.file) {
          const a = await toAttachment(d.file)
          saved.push(await api.uploadTodoFile(project.machine, project.cwd, { name: a.name, mediaType: a.mediaType, data: a.data }))
        }
      }
      onSave({
        id: item?.id ?? newTodoId(),
        n: item?.n,
        title: title.trim(),
        body,
        done,
        createdAt: item?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        files: saved,
      })
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  // Os botões da linha de baixo do bloco, como os da caixa do chat; o realce sobe a partir do bloco.
  const tool = cn(footerButton, 'px-0 hover:bg-foreground/[0.07] active:bg-foreground/[0.07] aria-pressed:bg-foreground/[0.08] aria-pressed:text-foreground')

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        // Uma ilha, como as do Computador e das habilidades: o cabeçalho na casca e o item numa janela. Sem
        // cortar o que passa da borda: a lista de sugestões do `@` e do `#` abre por cima dela, como um menu.
        // A ilha não cresce além da tela porque a descrição, os anexos e os mencionados rolam por dentro.
        className="flex max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100vw-1.5rem))] max-w-none flex-col gap-0 rounded-island bg-shell p-0 shadow-island ring-0 sm:max-w-none"
        onDragEnter={contain(drop.bind.onDragEnter)}
        onDragOver={contain(drop.bind.onDragOver)}
        onDragLeave={contain(drop.bind.onDragLeave)}
        onDrop={contain(drop.bind.onDrop)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void save()
          }
        }}
      >
        <DropOverlay show={drop.over} />
        <header className="flex shrink-0 items-center gap-1 py-1.5 pr-1.5 pl-[calc(var(--gap)+1.25rem)] max-sm:pl-[calc(var(--gap)+1rem)]">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm">{numbered ? <span className="font-mono text-[13px]">TODO:{item.n}</span> : 'Novo item'}</DialogTitle>
          <DialogDescription className="sr-only">Título, descrição, arquivos e anexos do item do TODO.</DialogDescription>
          {numbered && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Mandar para o chat"
              title="Mandar para o chat"
              onClick={() => {
                if (insertInChat(`TODO:${item.n} `)) onClose()
                else toast('Nenhuma conversa deste projeto com onde escrever agora', { description: 'Abra uma conversa nele e tente de novo.' })
              }}
            >
              <MessageSquarePlus />
            </Button>
          )}
          {onRemove && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Apagar"
              title="Apagar"
              className="hover:text-destructive"
              onClick={() => {
                onRemove()
                onClose()
              }}
            >
              <Trash2 />
            </Button>
          )}
          <Button size="sm" onClick={() => void save()} disabled={!title.trim() || saving} title="Ctrl+Enter" className="mx-1">
            {saving && <Loader2 className="animate-spin" />}
            Salvar
          </Button>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Fechar" title="Fechar">
              <X />
            </Button>
          </DialogClose>
        </header>

        <div className="mx-gap mb-gap flex min-h-0 flex-col gap-3 rounded-pane bg-background p-5 max-sm:p-4">
          {/* O feito e o título, como a linha da lista, só que grandes: é o que se lê primeiro. */}
          <div className="flex items-start gap-3">
            <Checkbox checked={done} onCheckedChange={(on) => setDone(on === true)} aria-label="Feito" title="Feito" className="mt-0.5 size-5 wide:mt-1" />
            <textarea
              value={title}
              // Uma linha só, que quebra na tela: colar um texto com quebras junta tudo.
              onChange={(e) => setTitle(e.target.value.replace(/\s*\n\s*/g, ' '))}
              onKeyDown={(e) => {
                // Enter passa para a descrição; Ctrl+Enter sobe para a ilha e salva.
                if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  field.current?.focus()
                }
              }}
              onPaste={(e) => {
                const list = pastedFiles(e.clipboardData)
                if (!list.length) return
                e.preventDefault()
                add(list)
              }}
              placeholder="Título"
              maxLength={300}
              rows={1}
              autoFocus={!item}
              aria-label="Título"
              className="min-w-0 flex-1 resize-none bg-transparent text-lg leading-snug font-semibold outline-none [field-sizing:content] placeholder:text-muted-foreground/60 wide:text-xl"
            />
          </div>

          <MachineContext value={project.machine}>
            <div className="rounded-xl bg-foreground/[0.04] transition-colors focus-within:bg-foreground/[0.06]">
              {showPreview ? (
                <div className="max-h-[40dvh] min-h-32 overflow-y-auto px-3.5 py-3">
                  {body.trim() ? <Markdown text={body} /> : <p className="text-sm text-muted-foreground">Nada para ver ainda.</p>}
                </div>
              ) : (
                <PromptInput
                  handleRef={field}
                  cwd={project.cwd}
                  value={body}
                  onChange={setBody}
                  onPasteFiles={add}
                  placement="bottom"
                  placeholder="Descrição"
                  aria-label="Descrição"
                  className="max-h-[40dvh] min-h-32 resize-none overflow-y-auto rounded-none border-0 bg-transparent px-3.5 py-3 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
                />
              )}
              {files.length > 0 && (
                <div className="flex gap-2 overflow-x-auto px-2.5 pt-2.5 pb-1">
                  {files.map((d) => (
                    <AttachmentTile key={d.key} draft={d} machine={project.machine} onRemove={() => setFiles((list) => list.filter((x) => x.key !== d.key))} />
                  ))}
                </div>
              )}
              {/* Os gatilhos à vista: tocar insere e já abre as sugestões, para quem não sabe que dá para digitar. */}
              <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
                {(
                  [
                    ['@', AtSign, 'Mencionar um arquivo'],
                    ['#', Hash, 'Mencionar uma issue ou um PR'],
                  ] as const
                ).map(([trigger, Icon, label]) => (
                  <button
                    key={trigger}
                    type="button"
                    aria-label={label}
                    title={label}
                    disabled={showPreview}
                    // Sem tirar o foco da descrição: perder o foco fecha as sugestões logo depois de abrir.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => field.current?.insert(trigger)}
                    className={tool}
                  >
                    <Icon className="size-4" />
                  </button>
                ))}
                <button type="button" aria-label="Anexar" title="Anexar imagem ou documento (ou cole e arraste)" onClick={() => picker.current?.click()} className={tool}>
                  <Paperclip className="size-4" />
                </button>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    add([...(e.target.files ?? [])])
                    e.target.value = ''
                  }}
                />
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
            <div className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
              {mentions.map((path) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => openViewer({ machine: project.machine, cwd: project.cwd, path: path.replace(/\/$/, '') })}
                  title={`Abrir ${path}`}
                  className="flex h-7 max-w-full items-center gap-1 rounded-md bg-foreground/[0.04] px-2 font-mono text-xs transition-colors hover:bg-foreground/[0.08] pointer-coarse:h-9"
                >
                  <AtSign className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{path}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * O TODO do projeto, a lista do próprio edit.r, guardada no PC (ver lib/todos.ts). "Novo" abre o
 * modal do item completo; escrever no campo e Enter anota rápido, só com o título. Clicar num item abre o editor dele
 * (descrição, arquivos e anexos). Os feitos descem e saem de uma vez pelo "Limpar". No chat, `TODO:3`
 * manda o item 3 inteiro para o Claude.
 */
export function TodoTab({ project }: { project: PanelProject }) {
  const items = useTodos(project.machine, project.cwd)
  const error = useTodoError(project.machine, project.cwd)
  const [text, setText] = useState('')
  // O que o editor mostra: um item (`id`), um novo (`new`) ou nada.
  const [editing, setEditing] = useState<string | null>(null)
  // Imagens coladas no campo rápido ou soltas na lista: o item novo abre já com elas.
  const [incoming, setIncoming] = useState<File[]>([])
  const startWith = (list: File[]) => {
    if (!items || !list.length) return
    setIncoming(list)
    setEditing('new')
  }
  const drop = useFileDrop(startWith)
  const save = (next: Todo[]) => saveTodos(project.machine, project.cwd, next)
  const pending = items?.filter((t) => !t.done) ?? []
  const done = items?.filter((t) => t.done) ?? []

  const add = () => {
    const value = text.trim()
    if (!value || !items) return
    save([...pending, { id: newTodoId(), title: value, body: '', done: false, createdAt: Date.now(), files: [] }, ...done])
    setText('')
  }
  const toggle = (id: string) => items && save(items.map((t) => (t.id === id ? { ...t, done: !t.done, updatedAt: Date.now() } : t)))
  const remove = (id: string) => items && save(items.filter((t) => t.id !== id))
  const upsert = (item: Todo) => {
    if (!items) return
    if (items.some((t) => t.id === item.id)) save(items.map((t) => (t.id === item.id ? item : t)))
    else save([...pending, item, ...done])
  }
  const current = editing && editing !== 'new' ? items?.find((t) => t.id === editing) : undefined

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...drop.bind}>
      <DropOverlay show={drop.over} label="Solte para um item novo com estes anexos" />
      <form
        className="flex shrink-0 items-center gap-1 px-2 pt-1 pb-2"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Anotar rápido e Enter"
          maxLength={300}
          disabled={!items}
          aria-label="Anotar um item rápido, só com o título"
          className="h-9 min-w-0 rounded-xl border-transparent bg-background/70 px-3 dark:bg-background/50"
          onPaste={(e) => {
            // Colar imagem (ou documento) aqui abre o item completo, com o que foi digitado de título.
            const list = pastedFiles(e.clipboardData)
            if (!list.length) return
            e.preventDefault()
            startWith(list)
          }}
        />
        {/* O item completo, no modal: título, descrição, arquivos e anexos. O que já foi digitado vira o título. */}
        <Button
          type="button"
          size="sm"
          disabled={!items}
          onClick={() => setEditing('new')}
          title="Novo item com descrição, arquivos e anexos"
          className="h-9 shrink-0 rounded-xl"
        >
          <Plus /> Novo
        </Button>
      </form>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {error && !items ? (
          <p className="p-4 text-center text-sm text-muted-foreground">{error}</p>
        ) : !items ? (
          <div className="flex justify-center p-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <TodoEmptyArt />
        ) : (
          <>
            <div className="space-y-0.5">
              {pending.map((t) => (
                <TodoRow key={t.id} item={t} onToggle={() => toggle(t.id)} onOpen={() => setEditing(t.id)} onRemove={() => remove(t.id)} />
              ))}
            </div>
            {done.length > 0 && (
              <>
                <div className="mt-3 flex items-center justify-between px-2.5 pb-1">
                  <span className="text-xs text-muted-foreground">Feitos · {done.length}</span>
                  <button type="button" onClick={() => save(pending)} className="text-xs text-muted-foreground hover:text-foreground">
                    Limpar
                  </button>
                </div>
                <div className="space-y-0.5">
                  {done.map((t) => (
                    <TodoRow key={t.id} item={t} onToggle={() => toggle(t.id)} onOpen={() => setEditing(t.id)} onRemove={() => remove(t.id)} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
      {editing && (editing === 'new' || current) && (
        <TodoEditor
          key={editing}
          project={project}
          item={current ?? null}
          initialTitle={editing === 'new' ? text : undefined}
          initialFiles={editing === 'new' ? incoming : undefined}
          onClose={() => {
            if (editing === 'new') setText('')
            setIncoming([])
            setEditing(null)
          }}
          onSave={upsert}
          onRemove={current ? () => remove(current.id) : undefined}
        />
      )}
    </div>
  )
}
