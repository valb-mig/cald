import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import type { DiffSide, GitFile, GitStatus, WorktreeTag } from '@/lib/types'
import { parseDiff } from '@/components/project/diff-lines'
import type { GitChange } from './code-files'

/** De que lado o git compara: no worktree, a base dele (commits e não commitado); fora, só o não commitado. */
export type GitSide = { side: DiffSide; base?: string }

const letterOf = (f: GitFile): GitChange['letter'] => {
  if (f.untracked) return 'U'
  const codes = `${f.index}${f.worktree}`
  if (codes.includes('D')) return 'D'
  if (codes.includes('R')) return 'R'
  if (codes.includes('A')) return 'A'
  return 'M'
}

const fromStatus = (status: GitStatus | null): GitChange[] =>
  (status?.files ?? []).map((f) => ({ path: f.path, letter: letterOf(f), additions: f.additions ?? 0, deletions: f.deletions ?? 0 }))

/**
 * O que o git viu mudar, para a tela Código: no worktree, o que a branch mudou desde a base dele; fora dele
 * (checkout compartilhado), só o não commitado, porque os commits dali não são necessariamente da conversa.
 * Relê quando o git da conversa muda (`status`, que a conversa já recarrega a cada turno): sem sondagem própria.
 * Servidor sem a rota (ou sem a base), cai no não commitado.
 */
export function useGitChanges(machine: string, cwd: string, worktree: WorktreeTag | undefined, status: GitStatus | null): { changes: GitChange[]; side: GitSide } {
  const [branch, setBranch] = useState<{ key: string; files: GitChange[] } | null>(null)
  const inTree = Boolean(worktree) && Boolean(cwd)
  const key = `${machine}\n${cwd}\n${worktree?.base ?? ''}`
  useEffect(() => {
    if (!inTree) return
    let alive = true
    api.gitChanges(machine, cwd, worktree?.base).then(
      (d) => {
        if (alive && d.base) setBranch({ key, files: d.files.map((f) => ({ path: f.path, letter: f.letter, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })) })
      },
      () => {},
    )
    return () => {
      alive = false
    }
    // `status` só avisa que o git mudou.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, cwd, inTree, key, status])
  const loose = useMemo(() => fromStatus(status), [status])
  if (inTree && branch?.key === key) return { changes: branch.files, side: { side: 'base', base: worktree?.base } }
  return { changes: loose, side: { side: 'head' } }
}

/** O que o diff mudou: as linhas (de 0) acrescentadas e, por linha do arquivo novo, as que saíram logo antes dela. */
export type GitMarks = { added: Set<number>; removed: Map<number, string[]> }

/** As marcas do diff, lidas com o mesmo `parseDiff` dos outros diffs. */
export function marksFromDiff(diff: string): GitMarks {
  const added = new Set<number>()
  const removed = new Map<number, string[]>()
  let pending: string[] = []
  let at = 0
  const flush = () => {
    if (pending.length) removed.set(at, [...(removed.get(at) ?? []), ...pending])
    pending = []
  }
  for (const r of parseDiff(diff).rows) {
    if (r.kind === 'hunk') {
      flush()
      at = r.line - 1
    } else if (r.kind === 'del') pending.push(r.text)
    else if (r.kind === 'add') {
      flush()
      added.add(at++)
    } else if (r.kind === 'ctx') {
      flush()
      at++
    }
  }
  flush()
  return { added, removed }
}

/** As marcas de um arquivo só do git; relê quando `key` muda. Sem diff, vazio. */
export function useGitAdded(machine: string, cwd: string, path: string | null, gitSide: GitSide, key: string): GitMarks | null {
  const [state, setState] = useState<{ id: string; lines: GitMarks } | null>(null)
  const id = path ? `${path}\n${gitSide.side}\n${gitSide.base ?? ''}\n${key}` : ''
  useEffect(() => {
    if (!path) return
    let alive = true
    api.gitDiff(machine, cwd, path, gitSide.side, gitSide.base).then(
      (r) => alive && setState({ id, lines: marksFromDiff(r.diff) }),
      () => alive && setState({ id, lines: { added: new Set(), removed: new Map() } }),
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, cwd, path, gitSide.side, gitSide.base, id])
  return state?.id === id ? state.lines : null
}
