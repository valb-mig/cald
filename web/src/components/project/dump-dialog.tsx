import { CloudUpload, Loader2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { FIELD, ISLAND, ISLAND_WIDE, NAV_ITEM, NavGroup, WINDOW, WindowHeader } from '@/components/island'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { api, errorMessage } from '@/lib/api'
import { useMediaQuery } from '@/lib/hooks'
import { useTokens } from '@/lib/highlight'
import type { GitFile } from '@/lib/types'
import { cn } from '@/lib/utils'
import { DiffLines, parseDiff } from './diff-lines'
import { ChangeChip } from './patch-list'
import { badge, splitPath } from './status'

/**
 * O dump, na ilha do edit.r: à esquerda, os arquivos que vão, a mensagem do commit (que chega sugerida no
 * jeito dos seus commits, para você validar) e o "Commit e push"; à direita, o diff do arquivo escolhido.
 * No celular, a lista e o diff se revezam.
 */
export function DumpDialog({
  open,
  onOpenChange,
  machine,
  cwd,
  files,
  branch,
  target,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  machine: string
  cwd: string
  files: GitFile[]
  branch: string
  /** Para onde vai: o upstream, ou o origin/<branch> que o push vai criar. */
  target: string
  onConfirm: (message: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className={cn(ISLAND, 'h-[min(44rem,calc(100dvh-2rem))] w-[min(68rem,calc(100vw-1.5rem))]')}>
        <DialogTitle className="sr-only">Dump na {branch}</DialogTitle>
        <DialogDescription className="sr-only">Um commit com todos os arquivos alterados, direto para o {target}.</DialogDescription>
        {open && <Body machine={machine} cwd={cwd} files={files} branch={branch} target={target} onConfirm={onConfirm} />}
      </DialogContent>
    </Dialog>
  )
}

function Body({ machine, cwd, files, branch, target, onConfirm }: Omit<React.ComponentProps<typeof DumpDialog>, 'open' | 'onOpenChange'>) {
  const wide = useMediaQuery(ISLAND_WIDE)
  // O arquivo à vista: no PC, o primeiro já vem aberto; no celular, a lista vem primeiro.
  const [picked, setPicked] = useState<string | null>(null)
  const shown = picked ?? (wide ? (files[0]?.path ?? null) : null)
  const file = files.find((f) => f.path === shown)
  const [message, setMessage] = useState('')
  const [suggesting, setSuggesting] = useState(true)

  // A mensagem sugerida, no jeito dos seus commits; o que você já escreveu enquanto ela vinha fica.
  useEffect(() => {
    let alive = true
    api.gitSuggest(machine, cwd, true).then(
      (s) => {
        if (!alive) return
        setMessage((m) => m || s.message)
        setSuggesting(false)
      },
      () => alive && setSuggesting(false),
    )
    return () => {
      alive = false
    }
  }, [machine, cwd])

  const confirm = () => {
    if (message.trim()) onConfirm(message.trim())
  }

  return (
    <>
      {(wide || !file) && (
        <nav className="flex min-h-0 shrink-0 flex-col gap-1 p-3 sm:w-80">
          <div className="flex items-start gap-1 px-2 pt-1 pb-2">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-medium">Dump na {branch}</h2>
              <p className="truncate text-xs text-muted-foreground">Um commit com tudo, direto para o {target}</p>
            </div>
            {!wide && (
              <DialogClose asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Fechar">
                  <X />
                </Button>
              </DialogClose>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <NavGroup title={`${files.length} ${files.length === 1 ? 'arquivo' : 'arquivos'}`} empty="Nada alterado">
              {files.map((f) => {
                const { name, dir } = splitPath(f.path)
                return (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => setPicked(f.path)}
                    aria-current={f.path === shown ? 'page' : undefined}
                    title={f.path}
                    className={cn(NAV_ITEM, 'h-auto py-1.5')}
                  >
                    <ChangeChip badge={badge(f)} />
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-[13px] text-foreground">{name}</span>
                      {dir && <span className="block truncate text-[11px]">{dir}</span>}
                    </span>
                    {f.additions || f.deletions ? (
                      <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
                        <span className="text-emerald-600 dark:text-emerald-400">+{f.additions ?? 0}</span>{' '}
                        <span className="text-red-600 dark:text-red-400">−{f.deletions ?? 0}</span>
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </NavGroup>
          </div>
          <div className="space-y-2 px-1 pt-2">
            <div className="relative">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    confirm()
                  }
                }}
                placeholder={suggesting ? 'Escrevendo a mensagem…' : 'Mensagem do commit'}
                aria-label="Mensagem do commit"
                rows={6}
                className={cn(FIELD, 'resize-none font-mono text-xs leading-relaxed')}
              />
              {suggesting && <Loader2 className="absolute top-2.5 right-2.5 size-3.5 animate-spin text-muted-foreground" />}
            </div>
            <Button className="w-full" disabled={!message.trim() || files.length === 0} onClick={confirm} title="Ctrl+Enter">
              <CloudUpload /> Commit e push
            </Button>
          </div>
        </nav>
      )}

      {(wide || file) && (
        <div className={WINDOW}>
          {file ? (
            <>
              <WindowHeader
                title={splitPath(file.path).name}
                subtitle={splitPath(file.path).dir || 'raiz do projeto'}
                onBack={() => setPicked(null)}
              />
              <FileDiff key={file.path} machine={machine} cwd={cwd} path={file.path} />
            </>
          ) : (
            <p className="m-auto text-sm text-muted-foreground">Nada alterado.</p>
          )}
        </div>
      )}
    </>
  )
}

/** O diff do arquivo contra o último commit, no desenho de diff-lines.tsx. */
function FileDiff({ machine, cwd, path }: { machine: string; cwd: string; path: string }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.gitDiff(machine, cwd, path, 'head').then(
      (r) => setDiff(r.diff),
      (err) => setError(errorMessage(err)),
    )
  }, [machine, cwd, path])
  const parsed = useMemo(() => (diff === null ? null : parseDiff(diff)), [diff])
  const oldTokens = useTokens(useMemo(() => parsed?.old.join('\n') ?? null, [parsed]), path)
  const newTokens = useTokens(useMemo(() => parsed?.new.join('\n') ?? null, [parsed]), path)
  return (
    <div className="min-h-0 flex-1 overflow-auto pb-3 [--code-font:12px]">
      {error ? (
        <p className="px-6 text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : !parsed ? (
        <Loader2 className="mx-auto my-8 size-5 animate-spin text-muted-foreground" />
      ) : parsed.rows.length === 0 ? (
        <p className="px-6 text-sm text-muted-foreground">Sem diferenças em texto (só permissões, ou arquivo binário).</p>
      ) : (
        <DiffLines rows={parsed.rows} oldTokens={oldTokens} newTokens={newTokens} wrap={false} />
      )}
    </div>
  )
}
