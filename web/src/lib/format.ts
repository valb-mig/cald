import type { CatalogState, SessionState } from './types'

/** Nome curto do projeto; worktrees aparecem como "projeto · worktree". */
export function projectName(cwd?: string): string {
  if (!cwd) return '—'
  const worktree = cwd.match(/\/([^/]+)\/\.claude\/worktrees\/([^/]+)\/?$/)
  if (worktree) return `${worktree[1]} · ${worktree[2]}`
  return cwd.replace(/\/+$/, '').split('/').pop() || cwd
}

export function shortPath(path: string): string {
  return path.replace(/^\/home\/[^/]+/, '~')
}

/** Nome curto de uma pasta qualquer: a pessoal vira `~`, o resto como `projectName`. */
export const placeName = (path: string) => (shortPath(path.replace(/\/+$/, '')) === '~' ? '~' : projectName(path))

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })

export function relativeTime(ms: number): string {
  const diff = (ms - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return 'agora'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 7 * 86_400) return rtf.format(Math.round(diff / 86_400), 'day')
  return new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

/** Quando, curto, para o canto de uma linha de lista: "agora", "5 min", "2 h", "3 d" ou a data. */
export function shortTime(ms: number): string {
  const abs = Math.abs(Date.now() - ms) / 1000
  if (abs < 45) return 'agora'
  if (abs < 3600) return `${Math.max(1, Math.floor(abs / 60))} min`
  if (abs < 86_400) return `${Math.floor(abs / 3600)} h`
  if (abs < 7 * 86_400) return `${Math.floor(abs / 86_400)} d`
  return new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}min ${s % 60}s`
}

export type Tone = 'running' | 'attention' | 'done' | 'muted'

/** Rótulo e tom de um estado (do catálogo ou do processo do painel). */
export function stateInfo(state: CatalogState | SessionState | undefined, waitingFor?: string): { label: string; tone: Tone } {
  switch (state) {
    case 'running':
    case 'starting':
      // Turno acabou, mas algo roda em segundo plano (monitor, comando) e vai trazer o Claude de volta.
      if (waitingFor === 'background') return { label: 'Em segundo plano', tone: 'running' }
      return { label: 'Executando', tone: 'running' }
    case 'waiting':
      if (waitingFor === 'permission prompt') return { label: 'Aguardando aprovação', tone: 'attention' }
      if (waitingFor === 'input needed') return { label: 'Aguardando resposta', tone: 'attention' }
      return { label: 'Aguardando você', tone: 'attention' }
    case 'idle':
      return { label: 'Concluída', tone: 'done' }
    default:
      return { label: 'Parada', tone: 'muted' }
  }
}

type Input = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Linha de resumo de uma chamada de ferramenta. */
export function toolSummary(name: string, input: Input): string {
  switch (name) {
    case 'Bash':
      return str(input.description) || str(input.command).split('\n')[0]
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return shortPath(str(input.file_path) || str(input.notebook_path))
    case 'Grep':
      return `${str(input.pattern)}${input.path ? ` em ${shortPath(str(input.path))}` : ''}`
    case 'Glob':
      return str(input.pattern)
    case 'WebFetch':
      return str(input.url)
    case 'WebSearch':
      return str(input.query)
    case 'Agent':
    case 'Task':
      return str(input.description) || str(input.subagent_type)
    case 'TodoWrite':
      return `${Array.isArray(input.todos) ? input.todos.length : 0} tarefas`
    case 'Skill':
      return str(input.skill)
    case 'Monitor':
      return str(input.description) || str(input.command).split('\n')[0]
    case 'ToolSearch':
      return str(input.query).replace(/^select:/, '')
    case 'ExitPlanMode':
      return 'plano pronto para revisão'
    case 'AskUserQuestion':
      return Array.isArray(input.questions)
        ? (input.questions as Input[]).map((q) => str(q.question)).join(' · ')
        : 'pergunta'
    default:
      return JSON.stringify(input).slice(0, 120)
  }
}

export const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
// Só executores de teste; a palavra "test" sozinha aparece demais (grep -v test, *.test.ts…).
export const TEST_COMMAND =
  /\b(vitest|jest|pytest|phpunit|mocha|rspec|cargo (nextest|test)|go test|dotnet test|playwright test|artisan test|(npm|pnpm|yarn|bun)( run)? test)\b/

export function bytes(n: number): string {
  const gb = n / 1024 ** 3
  if (gb >= 1) return `${gb.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`
  return `${Math.round(n / 1024 ** 2)} MB`
}

export function uptime(sec: number): string {
  const d = Math.floor(sec / 86_400)
  const h = Math.floor((sec % 86_400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d} d ${h} h`
  return h > 0 ? `${h} h ${m} min` : `${m} min`
}

/** "às 17:30" se for hoje; "ter., 04:00" em outro dia. */
export function resetTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === new Date().toDateString()) return `às ${time}`
  return `${date.toLocaleDateString('pt-BR', { weekday: 'short' })} ${time}`
}

/** Duração curta o bastante para caber dentro de um anel: "47min", "3h21", "12h". */
export function shortDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m}min`
  if (h >= 10) return `${h}h`
  return `${h}h${String(m).padStart(2, '0')}`
}
