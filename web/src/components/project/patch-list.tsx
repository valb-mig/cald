import { ChevronRight, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import type { GithubPatch } from '@/lib/types'
import { cn } from '@/lib/utils'
import { BADGES, splitPath, type Badge } from './status'

/**
 * Os arquivos de um PR ou de um commit com o diff de cada um, como o "Files changed" do GitHub, no
 * desenho do cald: uma linha por arquivo, com a letra da mudança, que abre o diff ali mesmo.
 */

// Um commit não muda: os diffs dele ficam aqui enquanto o app está aberto. Os do PR, o servidor guarda 2 min.
const cache = new Map<string, Promise<GithubPatch[]>>()

/** Os arquivos de `target` com os diffs; `null` não busca nada (a linha do commit ainda fechada). */
export function usePatches(machine: string, cwd: string, target: { pr: number } | { sha: string } | null) {
  const key = target && `${machine}\n${cwd}\n${'pr' in target ? `pr:${target.pr}` : target.sha}`
  const [state, setState] = useState<{ key: string; files: GithubPatch[] | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!key || !target) return
    let alive = true
    let request = cache.get(key)
    if (!request || 'pr' in target) {
      request = api.githubPatches(machine, cwd, target).then((r) => r.files)
      if ('sha' in target) cache.set(key, request)
      request.catch(() => cache.delete(key))
    }
    request.then(
      (files) => alive && setState({ key, files, error: null }),
      (err) => alive && setState({ key, files: null, error: errorMessage(err) }),
    )
    return () => {
      alive = false
    }
    // `target` muda de identidade a cada render; a chave diz o que ele é.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, machine, cwd])
  const current = state?.key === key ? state : null
  return { files: current?.files ?? null, error: current?.error ?? null }
}

const STATUS: Record<string, Badge> = {
  added: BADGES.A,
  removed: BADGES.D,
  modified: BADGES.M,
  changed: BADGES.M,
  renamed: BADGES.R,
  copied: BADGES.R,
}

// O fundo da letra, na cor dela, como na lista do controle de código-fonte.
export const CHIP: Record<string, string> = {
  U: 'bg-emerald-500/15',
  A: 'bg-emerald-500/15',
  M: 'bg-amber-500/15',
  D: 'bg-red-500/15',
  R: 'bg-sky-500/15',
  '!': 'bg-red-500/15',
}

/** A letra da mudança num quadradinho da cor dela. */
export function ChangeChip({ badge, className }: { badge: Badge; className?: string }) {
  return (
    <span
      title={badge.label}
      className={cn('flex size-[1.125rem] shrink-0 items-center justify-center rounded font-mono text-[11px] font-bold', badge.className, CHIP[badge.letter], className)}
    >
      {badge.letter}
    </span>
  )
}

type Line = { kind: 'hunk' | 'add' | 'del' | 'ctx'; text: string; old?: number; new?: number }

/** O trecho do diff que o GitHub manda (`@@ -a,b +c,d @@` e as linhas), com o número de cada lado. */
function parsePatch(patch: string): Line[] {
  const lines: Line[] = []
  let o = 0
  let n = 0
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw)
      o = Number(m?.[1] ?? 0)
      n = Number(m?.[2] ?? 0)
      lines.push({ kind: 'hunk', text: raw })
    } else if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw.slice(1), new: n++ })
    else if (raw.startsWith('-')) lines.push({ kind: 'del', text: raw.slice(1), old: o++ })
    else if (!raw.startsWith('\\')) lines.push({ kind: 'ctx', text: raw.slice(1), old: o++, new: n++ })
  }
  return lines
}

const ROW: Record<Line['kind'], string> = {
  hunk: 'bg-foreground/[0.04] text-muted-foreground',
  add: 'bg-emerald-500/10',
  del: 'bg-red-500/10',
  ctx: '',
}

/** Um diff, lado a lado em números e numa coluna só de código; linhas longas rolam de lado. */
export function PatchView({ patch }: { patch: string }) {
  const lines = useMemo(() => parsePatch(patch), [patch])
  return (
    <div className="overflow-x-auto font-mono text-[12px] leading-5">
      <div className="min-w-max">
        {lines.map((l, i) => (
          <div key={i} className={cn('flex', ROW[l.kind])}>
            <span className="w-11 shrink-0 pr-2 text-right text-muted-foreground/60 tabular-nums select-none">{l.old ?? ''}</span>
            <span className="w-11 shrink-0 pr-2 text-right text-muted-foreground/60 tabular-nums select-none">{l.new ?? ''}</span>
            <span
              className={cn(
                'w-4 shrink-0 text-center select-none',
                l.kind === 'add' ? 'text-emerald-600 dark:text-emerald-400' : l.kind === 'del' ? 'text-red-600 dark:text-red-400' : 'text-transparent',
              )}
            >
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
            </span>
            <span className="pr-4 whitespace-pre">{l.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Uma linha de arquivo que abre o diff dele embaixo. */
function PatchFile({ file, open, onToggle }: { file: GithubPatch; open: boolean; onToggle: () => void }) {
  const { name, dir } = splitPath(file.path)
  const badge = STATUS[file.status] ?? BADGES.M
  return (
    <div className={cn('overflow-hidden rounded-xl', open && 'bg-foreground/[0.03]')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[13px] hover:bg-foreground/[0.05]"
        title={file.previous ? `${file.previous} → ${file.path}` : file.path}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <ChangeChip badge={badge} />
        <span className="shrink-0 truncate">{name}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{dir}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{' '}
          <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
        </span>
      </button>
      {open && (
        <div className="pb-2">
          {file.patch ? (
            <PatchView patch={file.patch} />
          ) : (
            <p className="px-9 py-1 text-xs text-muted-foreground">Sem diff para mostrar aqui (binário ou grande demais). Veja no GitHub.</p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A lista de arquivos com os diffs. Com poucos arquivos, já vem aberta; com muitos, fechada, e o
 * "abrir todos" está à mão.
 */
export function PatchFiles({ files, error }: { files: GithubPatch[] | null; error: string | null }) {
  const [opened, setOpened] = useState<Set<string> | null>(null)
  if (error) return <p className="py-2 text-sm text-muted-foreground">{error}</p>
  if (!files) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (!files.length) return <p className="py-2 text-sm text-muted-foreground">Nenhum arquivo.</p>
  const open = opened ?? new Set(files.length <= 8 ? files.map((f) => f.path) : [])
  const all = open.size === files.length
  const toggle = (path: string) => {
    const next = new Set(open)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setOpened(next)
  }
  return (
    <div className="space-y-0.5">
      {files.length > 1 && (
        <div className="flex justify-end pb-1">
          <button
            type="button"
            onClick={() => setOpened(new Set(all ? [] : files.map((f) => f.path)))}
            className="rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            {all ? 'Fechar todos' : 'Abrir todos'}
          </button>
        </div>
      )}
      {files.map((f) => (
        <PatchFile key={f.path} file={f} open={open.has(f.path)} onToggle={() => toggle(f.path)} />
      ))}
    </div>
  )
}
