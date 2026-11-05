import { ArrowLeft, ArrowUp, Check, Ellipsis, FileText, FolderGit2, Layers, Loader2, MessageSquarePlus, Paperclip, Pin, PinOff, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Link, useLocation } from 'wouter'
import { Claudinho } from '@/components/claudinho'
import { ProjectMark } from '@/components/project-mark'
import { ProjectPicker } from '@/components/project-picker'
import { Group, SettingRow } from '@/components/settings-ui'
import { TeamPill } from '@/components/teams/team-pill'
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Veil } from '@/components/wallpaper/veil'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER, workspaceFileUrl } from '@/lib/api'
import { blobToBase64 } from '@/lib/attachments'
import { claudinhoName } from '@/lib/claudinho'
import { projectName, relativeTime, shortPath, shortTime } from '@/lib/format'
import { useWide } from '@/lib/hooks'
import { HOME, newChatUrl } from '@/lib/machines'
import { useStore } from '@/lib/store'
import { backHref } from '@/lib/tabs'
import type { Workspace, WorkspaceInput } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useScrim, useSurface } from '@/lib/wallpaper'
import { openProjectHub } from '@/lib/workbench'
import { loadWorkspaces, putWorkspace, setProjectWorkspace, useWorkspaces, WORKSPACE_COLORS, workspaceColor } from '@/lib/workspaces'

const failed = (err: unknown) => toast.error(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err))

const draftOf = (ws: Workspace): WorkspaceInput => ({
  id: ws.id,
  name: ws.name,
  color: ws.color,
  projects: ws.projects,
  instructions: ws.instructions,
  rules: ws.rules,
  commands: ws.commands,
  teamId: ws.teamId,
})

const sizeOf = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** Quantas conversas aparecem antes do "ver todas". */
const FEW = 5

/** Uma linha de bloco; o que se edita nela ganha o fundo ao focar. */
const ROW = 'group flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg px-3 py-1.5'
/** O campo sem borda dentro da linha. */
const FIELD = 'min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60'
/** O "tirar" da linha: aparece com o mouse em cima ou o foco nela; no toque, sempre. */
const TOOL = 'shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100'

/** A última linha de um bloco: acrescentar mais um. Num bloco vazio, é ela que diz o que cabe ali. */
function AddRow({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0"
    >
      {icon}
      {label}
    </button>
  )
}

/**
 * A página de um workspace (no PC, numa aba; no celular, uma tela), aberta pelo cartão no hub do projeto
 * e pelo menu de workspace da conversa. No alto, o nome, a cor e a conversa nova; embaixo, o que toda
 * conversa dele recebe (o contexto, as regras, os comandos e os arquivos) e, ao lado (no celular, antes),
 * onde e com quem: os projetos, o time padrão e as conversas dele. Na aba do PC, fica sobre a cena do
 * fundo como o hub, com o escurecido e os blocos de vidro. O que se edita vale a partir da próxima vez
 * que cada conversa for aberta (ver server/src/workspaces.ts).
 */
export function WorkspacePage({ machine, id }: { machine: string; id: string }) {
  const wide = useWide()
  const [, navigate] = useLocation()
  const list = useWorkspaces((s) => s.byMachine[machine])
  const ws = list?.find((w) => w.id === id)
  const [draft, setDraft] = useState<WorkspaceInput | null>(null)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [everyone, setEveryone] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const catalog = useStore((s) => s.catalog)
  const scrim = useScrim()
  const surface = useSurface()

  useEffect(() => {
    if (!list) loadWorkspaces(machine).catch(failed)
  }, [list, machine])
  // O rascunho nasce do que está salvo; depois de salvar, volta a ser igual a ele.
  const saved = useMemo(() => (ws ? draftOf(ws) : null), [ws])
  const form = draft ?? saved
  const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved))
  const patch = (p: Partial<WorkspaceInput>) => setDraft((d) => ({ ...(d ?? saved!), ...p }))

  const sessions = useMemo(
    () => catalog.filter((c) => c.workspace?.id === id && (c.machine ?? HOME) === machine).sort((a, b) => b.lastModified - a.lastModified),
    [catalog, id, machine],
  )

  if (!list) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-3 px-6 pt-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }
  if (!ws || !form) {
    return <p className="p-6 text-center text-sm text-muted-foreground">Este workspace não existe mais.</p>
  }

  const save = async () => {
    if (!draft || !dirty || !form.name.trim()) return
    setSaving(true)
    try {
      putWorkspace(machine, await api.saveWorkspace(machine, draft))
      setDraft(null)
    } catch (err) {
      failed(err)
    } finally {
      setSaving(false)
    }
  }

  const upload = async (files: FileList) => {
    setUploading(true)
    try {
      for (const f of Array.from(files)) {
        const next = await api.addWorkspaceFile(machine, ws.id, { name: f.name, mediaType: f.type || 'application/octet-stream', data: await blobToBase64(f) })
        putWorkspace(machine, next)
      }
    } catch (err) {
      failed(err)
    } finally {
      setUploading(false)
    }
  }

  const remove = async () => {
    try {
      await api.deleteWorkspace(machine, ws.id)
      putWorkspace(machine, null, ws.id)
      if (!wide) navigate(backHref())
    } catch (err) {
      failed(err)
    }
  }

  const start = () => {
    if (dirty) toast.message('Salve as mudanças para a conversa nova já vir com elas.')
    navigate(newChatUrl(form.projects[0], machine, ws.id))
  }

  const rules = form.rules
  const setRule = (i: number, text: string) => patch({ rules: rules.map((x, j) => (j === i ? text : x)) })
  const shownSessions = everyone ? sessions : sessions.slice(0, FEW)

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onKeyDown={(e) => {
        // Ctrl+S (⌘S no Mac) salva, como no editor de arquivos.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          void save()
        }
      }}
    >
      {/* O escurecido da cena atrás, como no hub e no chat; fora da rolagem, para não rolar junto. */}
      {scrim !== null && <Veil dim={scrim} />}

      <header className="relative shrink-0 px-4 pt-[max(0.75rem,var(--safe-top))] wide:px-6">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-1">
          {!wide && (
            <Button variant="ghost" size="icon" asChild aria-label="Voltar" className="-ml-2">
              <Link href={backHref()}>
                <ArrowLeft />
              </Link>
            </Button>
          )}
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
            <Layers className="size-3.5 shrink-0" />
            <span className="truncate">
              Workspace<span className="max-sm:hidden"> · editado {relativeTime(ws.updatedAt)}</span>
            </span>
          </span>
          <Button size="sm" onClick={start} disabled={!form.projects.length} title={form.projects.length ? undefined : 'Adicione um projeto primeiro'}>
            <MessageSquarePlus /> Nova conversa
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Mais ações" title="Mais ações">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto">
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                <Trash2 /> Apagar workspace
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto w-full max-w-5xl px-4 pt-3 pb-28 wide:px-6">
          <div className="flex min-w-0 items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="-ml-1.5 flex size-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-foreground/[0.06]"
                  aria-label="Cor do workspace"
                  title="Cor"
                >
                  <span className="size-4 rounded-full" style={{ background: workspaceColor(form.color) }} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="grid w-auto grid-cols-5 gap-1 p-1.5">
                {WORKSPACE_COLORS.map((c, i) => (
                  <DropdownMenuItem key={c} onSelect={() => patch({ color: i })} aria-label={`Cor ${i + 1}`} className="size-9 justify-center rounded-full p-0">
                    <span className="flex size-6 items-center justify-center rounded-full text-white" style={{ background: c }}>
                      {form.color === i && <Check className="size-3.5" strokeWidth={3} />}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <input
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              maxLength={60}
              placeholder="Nome do workspace"
              aria-label="Nome do workspace"
              spellCheck={false}
              className="min-w-0 flex-1 truncate rounded-lg bg-transparent px-1.5 py-0.5 text-2xl font-semibold outline-none placeholder:text-muted-foreground/50 hover:bg-foreground/[0.04] focus:bg-foreground/[0.05]"
            />
          </div>

          <div className="mt-6 grid gap-x-8 gap-y-6 @3xl:grid-cols-[minmax(0,1fr)_19rem]">
            {/* Onde e com quem: ao lado no PC; no celular, antes do resto. */}
            <aside className="min-w-0 space-y-6 @3xl:order-last">
              <Group title="Projetos" className={surface} note={form.projects.length > 1 ? 'A conversa nova abre no principal; os outros entram como pastas extras.' : undefined}>
                {form.projects.map((p, i) => {
                  const isDefault = ws.defaultFor?.includes(p) ?? false
                  const hint = [i === 0 && 'Principal', isDefault && 'Padrão do projeto'].filter(Boolean).join(' · ')
                  return (
                    <div key={p} className={ROW}>
                      <ProjectMark machine={machine} cwd={p} name={projectName(p)} className="size-5 text-[11px]" />
                      <div className="min-w-0 flex-1" title={shortPath(p)}>
                        <div className="truncate text-sm">{projectName(p)}</div>
                        {hint && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" className={cn(TOOL, 'text-muted-foreground')} aria-label={`Ações de ${projectName(p)}`} title="Mais ações">
                            <Ellipsis />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-auto">
                          {i > 0 && (
                            <DropdownMenuItem onSelect={() => patch({ projects: [p, ...form.projects.filter((x) => x !== p)] })}>
                              <ArrowUp /> Fazer principal
                            </DropdownMenuItem>
                          )}
                          {/* Só com o projeto já salvo no workspace: o PC recusa o padrão de um que ele ainda não tem. */}
                          {ws.projects.includes(p) && (
                            <DropdownMenuItem onSelect={() => void setProjectWorkspace(machine, p, isDefault ? null : ws.id).catch(failed)}>
                              {isDefault ? <PinOff /> : <Pin />} {isDefault ? 'Deixar de ser o padrão' : `Padrão de ${projectName(p)}`}
                            </DropdownMenuItem>
                          )}
                          {wide && (
                            <DropdownMenuItem onSelect={() => openProjectHub(machine, p)}>
                              <FolderGit2 /> Abrir o projeto
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => patch({ projects: form.projects.filter((x) => x !== p) })}>
                            <X /> Tirar do workspace
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )
                })}
                <AddRow icon={<Plus />} label="Adicionar projeto" onClick={() => setPicking(true)} />
              </Group>

              <Group className={surface}>
                <SettingRow label="Time padrão" hint="Vem na conversa nova">
                  <TeamPill machine={machine} value={form.teamId} onChange={(teamId) => patch({ teamId })} />
                </SettingRow>
              </Group>

              <Group title={sessions.length ? `Conversas · ${sessions.length}` : 'Conversas'} className={surface}>
                {shownSessions.map((c) => (
                  <Link key={c.sessionId} href={`/s/${c.sessionId}`} className={cn(ROW, 'transition-colors hover:bg-foreground/[0.04]')}>
                    <Claudinho seed={c.sessionId} name={claudinhoName(c.sessionId, c.claudinhoName)} size={22} state={c.state} thinking={c.thinking} status />
                    <span className="min-w-0 flex-1 truncate text-sm">{c.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{shortTime(c.lastModified)}</span>
                  </Link>
                ))}
                {sessions.length > FEW && <AddRow icon={null} label={everyone ? 'Mostrar menos' : `Ver todas (${sessions.length})`} onClick={() => setEveryone(!everyone)} />}
                {sessions.length === 0 && <AddRow icon={<MessageSquarePlus />} label="Começar a primeira" onClick={start} disabled={!form.projects.length} />}
              </Group>
            </aside>

            {/* O que toda conversa do workspace recebe. */}
            <main className="min-w-0 space-y-6">
              <Group title="Contexto" className={surface} note="Toda conversa do workspace recebe este texto.">
                <textarea
                  value={form.instructions}
                  onChange={(e) => patch({ instructions: e.target.value })}
                  maxLength={20000}
                  placeholder="Ex.: É o app do cliente X, em Laravel e Vue. Escreva em português, sem travessão."
                  aria-label="Contexto"
                  className="block min-h-32 w-full resize-none rounded-lg bg-transparent px-3 py-2.5 text-sm leading-relaxed outline-none [field-sizing:content] placeholder:text-muted-foreground/60 focus:bg-foreground/[0.03]"
                />
              </Group>

              <Group title="Regras" className={surface}>
                <div data-rules>
                  {rules.map((r, i) => (
                    <div key={i} className={cn(ROW, 'items-start focus-within:bg-foreground/[0.03]')}>
                      <span className="mt-[0.4rem] size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                      <textarea
                        value={r}
                        rows={1}
                        onChange={(e) => setRule(i, e.target.value.replace(/\n/g, ' '))}
                        onKeyDown={(e) => {
                          // Enter abre a próxima regra (ou vai para ela); a regra é uma linha só.
                          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                          e.preventDefault()
                          const next = e.currentTarget.closest('[data-rules]')?.querySelectorAll('textarea')[i + 1]
                          if (next) next.focus()
                          else if (r.trim()) patch({ rules: [...rules, ''] })
                        }}
                        maxLength={1000}
                        placeholder="Ex.: Commits em Conventional Commits, em português"
                        aria-label={`Regra ${i + 1}`}
                        autoFocus={!r}
                        className={cn(FIELD, 'resize-none py-0.5 leading-snug [field-sizing:content]')}
                      />
                      <Button variant="ghost" size="icon-xs" className={cn(TOOL, 'text-muted-foreground')} onClick={() => patch({ rules: rules.filter((_, j) => j !== i) })} aria-label={`Tirar a regra ${i + 1}`} title="Tirar">
                        <X />
                      </Button>
                    </div>
                  ))}
                </div>
                <AddRow icon={<Plus />} label="Adicionar regra" onClick={() => patch({ rules: [...rules, ''] })} />
              </Group>

              <Group title="Comandos" className={surface} note="O Claude roda antes de dar algo por pronto.">
                {form.commands.map((c, i) => {
                  const set = (p: Partial<typeof c>) => patch({ commands: form.commands.map((x, j) => (j === i ? { ...x, ...p } : x)) })
                  return (
                    <div key={i} className={cn(ROW, 'focus-within:bg-foreground/[0.03]')}>
                      <input value={c.label} onChange={(e) => set({ label: e.target.value })} maxLength={60} placeholder="Testes" aria-label="Rótulo" className={cn(FIELD, 'w-20 flex-none font-medium @md:w-28')} />
                      <input
                        value={c.command}
                        onChange={(e) => set({ command: e.target.value })}
                        maxLength={1000}
                        placeholder="pnpm test"
                        aria-label="Comando"
                        spellCheck={false}
                        autoFocus={!c.command && !c.label}
                        className={cn(FIELD, 'font-mono text-[12.5px]')}
                      />
                      {form.projects.length > 1 && (
                        <select
                          value={c.cwd ?? ''}
                          onChange={(e) => set({ cwd: e.target.value || undefined })}
                          aria-label="Projeto"
                          title="Onde roda"
                          className="max-w-28 shrink-0 truncate bg-transparent text-xs text-muted-foreground outline-none hover:text-foreground"
                        >
                          {form.projects.map((p) => (
                            <option key={p} value={p}>
                              {projectName(p)}
                            </option>
                          ))}
                        </select>
                      )}
                      <Button variant="ghost" size="icon-xs" className={cn(TOOL, 'text-muted-foreground')} onClick={() => patch({ commands: form.commands.filter((_, j) => j !== i) })} aria-label="Tirar o comando" title="Tirar">
                        <X />
                      </Button>
                    </div>
                  )
                })}
                <AddRow icon={<Plus />} label="Adicionar comando" onClick={() => patch({ commands: [...form.commands, { label: '', command: '', cwd: form.projects[0] }] })} />
              </Group>

              {/* Soltar arquivos no bloco também anexa. */}
              <div
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes('Files')) return
                  e.preventDefault()
                  setDropping(true)
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
                }}
                onDrop={(e) => {
                  if (!e.dataTransfer.files.length) return
                  e.preventDefault()
                  setDropping(false)
                  void upload(e.dataTransfer.files)
                }}
              >
                <Group
                  title="Arquivos"
                  className={cn(surface, dropping && 'ring-2 ring-foreground/20')}
                  note="Texto pequeno vai inteiro; o resto o Claude abre quando precisar."
                >
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => {
                      if (e.target.files?.length) void upload(e.target.files)
                      e.target.value = ''
                    }}
                  />
                  {ws.files.map((f) => (
                    <div key={f.id} className={ROW}>
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <a href={workspaceFileUrl(machine, ws.id, f)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm hover:underline">
                        {f.name}
                      </a>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{sizeOf(f.size)}</span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className={cn(TOOL, 'text-muted-foreground')}
                        onClick={() => api.removeWorkspaceFile(machine, ws.id, f.id).then((next) => putWorkspace(machine, next), failed)}
                        aria-label={`Tirar ${f.name}`}
                        title="Tirar"
                      >
                        <X />
                      </Button>
                    </div>
                  ))}
                  <AddRow
                    icon={uploading ? <Loader2 className="animate-spin" /> : <Paperclip />}
                    label={uploading ? 'Anexando…' : 'Anexar arquivo'}
                    onClick={() => fileInput.current?.click()}
                    disabled={uploading}
                  />
                </Group>
              </div>
            </main>
          </div>
        </div>
      </div>

      {dirty && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-4 pb-[max(1rem,var(--safe-bottom))]">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-popover p-1.5 pl-4 text-sm shadow-lg">
            Mudanças não salvas
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Descartar
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={saving || !form.name.trim()}>
              {saving && <Loader2 className="animate-spin" />} Salvar
            </Button>
          </div>
        </div>
      )}

      <ProjectPicker
        open={picking}
        onOpenChange={setPicking}
        machine={machine}
        exclude={form.projects}
        title="Adicionar projeto"
        description={`Ao workspace ${ws.name}`}
        onPick={(cwd) => cwd && patch({ projects: [...form.projects, cwd] })}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="line-clamp-3 break-words">Apagar “{ws.name}”?</AlertDialogTitle>
            <AlertDialogDescription>As conversas continuam, só sem o contexto dele daqui em diante. Os arquivos anexados somem junto. Não dá para desfazer.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              Apagar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
