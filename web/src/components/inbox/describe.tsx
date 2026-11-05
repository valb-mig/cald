import { CircleDot, FileDiff, GitPullRequest, ListTodo } from 'lucide-react'
import { Claudinho } from '@/components/claudinho'
import { projectName } from '@/lib/format'
import type { InboxEntry } from '@/lib/inbox'
import type { InboxReason } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Como cada item da inbox aparece numa linha: a da inbox e a da paleta de comandos (ver command-palette.tsx). */

const REASON: Record<InboxReason, { label: string; tone: string }> = {
  review: { label: 'Pedem sua revisão', tone: 'text-sky-600 dark:text-sky-400' },
  checks: { label: 'Check falhando', tone: 'text-red-600 dark:text-red-400' },
  changes: { label: 'Mudanças pedidas', tone: 'text-amber-600 dark:text-amber-400' },
  conflict: { label: 'Conflito com a base', tone: 'text-amber-600 dark:text-amber-400' },
  ready: { label: 'Aprovado, pronto para o merge', tone: 'text-emerald-600 dark:text-emerald-400' },
  assigned: { label: 'Atribuída a você', tone: 'text-violet-600 dark:text-violet-400' },
  mentioned: { label: 'Mencionaram você', tone: 'text-violet-600 dark:text-violet-400' },
}

/** O que a linha mostra: ícone, título, o porquê (colorido) e de onde vem. */
export function describe(e: InboxEntry): { icon: React.ReactNode; title: string; why: string; tone: string; where: string } {
  const it = e.item
  if (it.type === 'waiting') {
    const asking = it.session.pending?.some((p) => p.kind === 'approval')
    return {
      icon: <Claudinho seed={it.session.sessionId} size={22} state="waiting" />,
      title: it.session.title,
      why: asking ? 'Pede aprovação' : 'Pergunta para você',
      tone: 'text-amber-600 dark:text-amber-400',
      where: it.session.cwd ? projectName(it.session.cwd) : '~',
    }
  }
  if (it.type === 'github') {
    const r = REASON[it.reason]
    return {
      icon: it.kind === 'pr' ? <GitPullRequest className={cn('size-4', r.tone)} /> : <CircleDot className={cn('size-4', r.tone)} />,
      title: `${it.title}`,
      why: r.label,
      tone: r.tone,
      where: `${it.repo} #${it.number}`,
    }
  }
  if (it.type === 'git') {
    const parts = [it.changed && `${it.changed} ${it.changed === 1 ? 'alterado' : 'alterados'}`, it.ahead && `↑ ${it.ahead} para enviar`, it.behind && `↓ ${it.behind} para receber`]
    return {
      icon: <FileDiff className="size-4 text-sky-600 dark:text-sky-400" />,
      title: projectName(it.cwd),
      why: parts.filter(Boolean).join(' · '),
      tone: 'text-sky-600 dark:text-sky-400',
      where: it.branch ?? '',
    }
  }
  return {
    icon: <ListTodo className="size-4 text-muted-foreground" />,
    title: it.title,
    why: `TODO:${it.n}`,
    tone: 'text-muted-foreground',
    where: projectName(it.cwd),
  }
}
