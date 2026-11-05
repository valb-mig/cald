import { ArrowLeft, ArrowUp, FileText, FolderGit2, Loader2, MessageSquarePlus, Paperclip, Plus, Star, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Link, useLocation } from 'wouter'
import { Claudinho } from '@/components/claudinho'
import { ProjectPicker } from '@/components/project-picker'
import { TeamPill } from '@/components/teams/team-pill'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER, workspaceFileUrl } from '@/lib/api'
import { blobToBase64 } from '@/lib/attachments'
import { claudinhoName } from '@/lib/claudinho'
import { projectName, relativeTime, shortPath } from '@/lib/format'
import { useWide } from '@/lib/hooks'
import { HOME, newChatUrl } from '@/lib/machines'
import { useStore } from '@/lib/store'
import { backHref } from '@/lib/tabs'
import type { Workspace, WorkspaceInput } from '@/lib/types'
import { cn } from '@/lib/utils'
import { loadWorkspaces, putWorkspace, useWorkspaces, WORKSPACE_COLORS, workspaceColor } from '@/lib/workspaces'

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

function Section({ title, hint, children, action }: { title: string; hint?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">{title}</h2>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

const sizeOf = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/**
 * A página de um workspace (no PC, numa aba; no celular, uma tela), aberta pelo cartão no hub do projeto
 * e pelo menu de workspace da conversa: os projetos que podem usá-lo (e de quais ele é o padrão), o
 * contexto, os arquivos, as regras e os comandos que toda conversa dele recebe, o time padrão e as
 * conversas dele. O que se edita vale a partir da próxima vez que cada conversa for aberta (ver
 * server/src/workspaces.ts).
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
  const fileInput = useRef<HTMLInputElement>(null)
  const catalog = useStore((s) => s.catalog)

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
      <div className="mx-auto w-full max-w-2xl space-y-3 p-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }
  if (!ws || !form) {
    return <p className="p-6 text-center text-sm text-muted-foreground">Este workspace não existe mais.</p>
  }

  const save = async () => {
    if (!draft) return
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

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-2 pt-[max(0.5rem,var(--safe-top))] pb-2">
        {!wide && (
          <Button variant="ghost" size="icon" asChild aria-label="Voltar">
            <Link href={backHref()}>
              <ArrowLeft />
            </Link>
          </Button>
        )}
        <span className="ml-2 size-3 shrink-0 rounded-full" style={{ background: workspaceColor(form.color) }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{ws.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            Workspace · {form.projects.length} {form.projects.length === 1 ? 'projeto' : 'projetos'} · {sessions.length}{' '}
            {sessions.length === 1 ? 'conversa' : 'conversas'}
          </div>
        </div>
        <Button size="sm" onClick={start} disabled={!form.projects.length} title={form.projects.length ? undefined : 'Adicione um projeto primeiro'}>
          <MessageSquarePlus /> Nova conversa
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-7 px-4 pt-2 pb-28">
          <Section title="Nome e cor">
            <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} maxLength={60} aria-label="Nome do workspace" />
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Cor">
              {WORKSPACE_COLORS.map((c, i) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={form.color === i}
                  aria-label={`Cor ${i + 1}`}
                  onClick={() => patch({ color: i })}
                  className={cn('size-6 rounded-full ring-offset-2 ring-offset-background transition', form.color === i && 'ring-2 ring-foreground')}
                  style={{ background: c }}
                />
              ))}
            </div>
          </Section>

          <Section
            title="Projetos"
            hint="A conversa de qualquer um deles pode usar este workspace; os outros entram como pastas que o Claude também lê e edita."
            action={
              <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
                <Plus /> Projeto
              </Button>
            }
          >
            {form.projects.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">Nenhum projeto ainda.</p>
            ) : (
              <ul className="divide-y overflow-hidden rounded-xl border">
                {form.projects.map((p, i) => (
                  <li key={p} className="flex min-w-0 items-center gap-2.5 px-3 py-2">
                    <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{projectName(p)}</span>
                        {i === 0 && (
                          <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-amber-600 dark:text-amber-400" title="A Nova conversa desta página abre nele">
                            <Star className="size-3 fill-current" /> principal
                          </span>
                        )}
                        {/* A conversa nova deste projeto já vem com este workspace. */}
                        {ws.defaultFor?.includes(p) && (
                          <span className="shrink-0 text-[11px] text-muted-foreground" title={`A conversa nova de ${projectName(p)} já vem com este workspace`}>
                            padrão
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{shortPath(p)}</div>
                    </div>
                    {i > 0 && (
                      <Button variant="ghost" size="icon-sm" onClick={() => patch({ projects: [p, ...form.projects.filter((x) => x !== p)] })} aria-label={`Fazer de ${projectName(p)} o principal`} title="Fazer principal">
                        <ArrowUp />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon-sm" onClick={() => patch({ projects: form.projects.filter((x) => x !== p) })} aria-label={`Tirar ${projectName(p)}`} title="Tirar do workspace">
                      <X />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Contexto" hint="Instruções que toda conversa do workspace recebe: o que é o trabalho, como você gosta que seja feito, o que evitar.">
            <Textarea
              value={form.instructions}
              onChange={(e) => patch({ instructions: e.target.value })}
              rows={6}
              maxLength={20000}
              placeholder="Ex.: É o app do cliente X, em Laravel e Vue. Escreva em português, sem travessão."
              aria-label="Contexto"
            />
          </Section>

          <Section
            title="Arquivos"
            hint="Textos pequenos vão inteiros para o Claude; o resto (PDFs, imagens, textos grandes) ele lê quando precisar."
            action={
              <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
                {uploading ? <Loader2 className="animate-spin" /> : <Paperclip />} Anexar
              </Button>
            }
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
            {ws.files.length > 0 && (
              <ul className="divide-y overflow-hidden rounded-xl border">
                {ws.files.map((f) => (
                  <li key={f.id} className="flex min-w-0 items-center gap-2.5 px-3 py-2">
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <a href={workspaceFileUrl(machine, ws.id, f)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm hover:underline">
                      {f.name}
                    </a>
                    <span className="shrink-0 text-xs text-muted-foreground">{sizeOf(f.size)}</span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => api.removeWorkspaceFile(machine, ws.id, f.id).then((next) => putWorkspace(machine, next), failed)}
                      aria-label={`Tirar ${f.name}`}
                    >
                      <X />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Regras"
            hint="Padrões que valem em toda conversa: convenções de código, de commit, o que nunca fazer."
            action={
              <Button variant="outline" size="sm" onClick={() => patch({ rules: [...form.rules, ''] })}>
                <Plus /> Regra
              </Button>
            }
          >
            {form.rules.map((r, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  value={r}
                  onChange={(e) => patch({ rules: form.rules.map((x, j) => (j === i ? e.target.value : x)) })}
                  maxLength={1000}
                  placeholder="Ex.: Commits em Conventional Commits, em português"
                  aria-label={`Regra ${i + 1}`}
                  autoFocus={!r}
                />
                <Button variant="ghost" size="icon-sm" onClick={() => patch({ rules: form.rules.filter((_, j) => j !== i) })} aria-label={`Tirar a regra ${i + 1}`}>
                  <X />
                </Button>
              </div>
            ))}
          </Section>

          <Section
            title="Comandos"
            hint="Build, testes, lint… O Claude roda antes de dar algo por pronto, e passa a quem do time for testar."
            action={
              <Button variant="outline" size="sm" onClick={() => patch({ commands: [...form.commands, { label: '', command: '', cwd: form.projects[0] }] })}>
                <Plus /> Comando
              </Button>
            }
          >
            {form.commands.map((c, i) => {
              const set = (p: Partial<typeof c>) => patch({ commands: form.commands.map((x, j) => (j === i ? { ...x, ...p } : x)) })
              return (
                <div key={i} className="flex flex-wrap items-center gap-1.5 rounded-xl border p-2 sm:flex-nowrap">
                  <Input value={c.label} onChange={(e) => set({ label: e.target.value })} maxLength={60} placeholder="Testes" aria-label="Rótulo" className="h-8 w-24 shrink-0" />
                  <Input
                    value={c.command}
                    onChange={(e) => set({ command: e.target.value })}
                    maxLength={1000}
                    placeholder="pnpm test"
                    aria-label="Comando"
                    className="h-8 min-w-40 flex-1 font-mono text-xs"
                    spellCheck={false}
                  />
                  {form.projects.length > 1 && (
                    <select
                      value={c.cwd ?? ''}
                      onChange={(e) => set({ cwd: e.target.value || undefined })}
                      aria-label="Projeto"
                      className="h-8 max-w-36 rounded-md border bg-transparent px-2 text-xs"
                    >
                      {form.projects.map((p) => (
                        <option key={p} value={p}>
                          {projectName(p)}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button variant="ghost" size="icon-sm" onClick={() => patch({ commands: form.commands.filter((_, j) => j !== i) })} aria-label="Tirar o comando">
                    <X />
                  </Button>
                </div>
              )
            })}
          </Section>

          <Section title="Time padrão" hint="A conversa nova do workspace já vem com ele (dá para trocar na hora).">
            <div className="flex">
              <TeamPill machine={machine} value={form.teamId} onChange={(teamId) => patch({ teamId })} className="border" />
            </div>
          </Section>

          <Section title="Conversas">
            {sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">As conversas abertas por aqui aparecem nesta lista.</p>
            ) : (
              <ul className="divide-y overflow-hidden rounded-xl border">
                {sessions.map((c) => (
                  <li key={c.sessionId}>
                    <Link href={`/s/${c.sessionId}`} className="flex min-w-0 items-center gap-2.5 px-3 py-2 hover:bg-muted/50">
                      <Claudinho seed={c.sessionId} size={26} state={c.state} thinking={c.thinking} status />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{c.title}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {claudinhoName(c.sessionId, c.claudinhoName)} · {c.cwd ? projectName(c.cwd) : '~'} · {relativeTime(c.lastModified)}
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Apagar o workspace" hint="As conversas continuam, só sem o contexto dele daqui em diante.">
            <div>
              {confirmDelete ? (
                <div className="flex gap-2">
                  <Button variant="destructive" size="sm" onClick={() => void remove()}>
                    <Trash2 /> Apagar {ws.name}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                    Cancelar
                  </Button>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setConfirmDelete(true)}>
                  <Trash2 /> Apagar
                </Button>
              )}
            </div>
          </Section>
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
    </div>
  )
}
