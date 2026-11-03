import { useEffect, useState } from 'react'
import type { OfficeActivity, OfficeEvent, OfficeEventKind, OfficeRoom, OfficeWorker, TeamMember } from '@/lib/types'

/**
 * Escritório de mentira para ver a salinha cheia (`/salinha?demo`): salas fictícias cujos
 * claudinhos trocam de atividade a cada poucos segundos, com subagentes chegando e indo embora,
 * folhas na pilha, testes, commits e pushes, e as tarefas da refatoração andando no quadro.
 */
const WORK: OfficeActivity[] = ['web', 'files', 'edit', 'command', 'plan', 'think']
const DETAIL: Record<OfficeActivity, string[]> = {
  web: ['WebSearch · claude code subagents', 'WebFetch · docs.anthropic.com'],
  files: ['Read · manager.ts', 'Grep · useSession', 'Glob · src/**/*.tsx'],
  edit: ['Edit · README.md', 'Write · office.ts', 'Edit · auth.ts'],
  command: ['Bash · pnpm test', 'Bash · git commit', 'Bash · git push', 'Bash · docker compose up'],
  plan: ['TodoWrite · 5 tarefas', 'Skill · frontend-design', 'Coordenando os subagentes'],
  think: ['Pensando'],
  ask: ['Pede aprovação: Bash · git push'],
  compact: ['Compactando a conversa'],
  background: ['Algo rodando em segundo plano'],
  idle: ['Descansando'],
}
const AGENTS = [
  ['Mapear rotas de auth', 'Explore'],
  ['Ler a doc do NextAuth', 'general-purpose'],
  ['Procurar testes antigos', 'Explore'],
  ['Comparar bibliotecas', 'general-purpose'],
] as const

// O time da sala do README: quem não foi chamado descansa na área, e cada chamada leva o membro à estação.
const TEAM: TeamMember[] = [
  { id: 'demo-thor', key: 'thor', name: 'Thor', role: 'Frontend', model: 'claude-sonnet-5-5', effort: 'medium', instructions: '' },
  { id: 'demo-atena', key: 'atena', name: 'Atena', role: 'Backend', model: 'claude-opus-5-5', effort: 'high', instructions: '' },
  { id: 'demo-hermes', key: 'hermes', name: 'Hermes', role: 'Testes', model: 'claude-haiku-5-5', instructions: '' },
]
const TEAM_TASKS = ['Ajustar o layout do README', 'Rever a rota de exemplos', 'Rodar os testes da doc']

// O que cada estação costuma render: folha na pilha, teste, commit, push, erro, skill.
const EVENTS: Partial<Record<OfficeActivity, OfficeEventKind[]>> = {
  edit: ['edit', 'edit', 'error'],
  command: ['test-pass', 'test-fail', 'commit', 'push', 'error'],
  plan: ['skill'],
}

const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]
const worker = (id: string, name: string, role: string, activity: OfficeActivity): OfficeWorker => ({ id, name, role, activity, detail: pick(DETAIL[activity]) })
let seq = 0

function initial(): OfficeRoom[] {
  const room = (id: string, title: string, cwd: string, state: OfficeRoom['state'], model: string, workers: OfficeWorker[]): OfficeRoom => ({
    sessionId: `demo-${id}`,
    title,
    cwd: `/home/dev/${cwd}`,
    state,
    owner: 'panel',
    workers,
    events: [],
    model,
  })
  return [
    {
      ...room('a', 'Refatorar o login', 'app', 'running', 'claude-opus-5-5', [
        worker('lead', 'Gestor', 'gestor', 'plan'),
        worker('a1', AGENTS[0][0], AGENTS[0][1], 'files'),
        worker('a2', AGENTS[1][0], AGENTS[1][1], 'web'),
      ]),
      todos: { done: 1, total: 5, current: 'Mapeando as rotas' },
    },
    room('b', 'Deploy da landing', 'site', 'waiting', 'claude-sonnet-5-5', [worker('lead', 'Gestor', 'gestor', 'ask')]),
    room('c', 'Monitorar o build', 'api', 'idle', 'claude-haiku-5-5', [worker('lead', 'Gestor', 'gestor', 'background')]),
    {
      ...room('d', 'Escrever o README', 'lib', 'running', 'claude-fable-5-1', [worker('lead', 'Gestor', 'gestor', 'plan'), worker('d-call-0', TEAM_TASKS[0]!, 'thor', 'edit')]),
      team: { id: 'demo-time', name: 'Squad', members: TEAM },
    },
    room('e', 'Pesquisa de mercado', 'notas', 'idle', 'claude-opus-5-5', [worker('lead', 'Gestor', 'gestor', 'idle')]),
  ]
}

function evolve(rooms: OfficeRoom[], tick: number): OfficeRoom[] {
  const next = rooms.map((r) => ({ ...r, workers: [...r.workers], events: [...(r.events ?? [])] }))
  // Uma conversa nova abre depois de um tempo: o escritório ganha uma sala.
  if (tick === 6) {
    next.push({ sessionId: 'demo-f', title: 'Nova conversa', cwd: '/home/dev/app', state: 'running', owner: 'panel', model: 'claude-sonnet-5-5', events: [], workers: [worker('lead', 'Gestor', 'gestor', 'think')] })
  }
  for (const r of next) {
    if (r.state === 'running') {
      // Cada um que trabalha tem uma chance de ir para outra estação.
      r.workers = r.workers.map((w) => (Math.random() < 0.3 ? worker(w.id, w.name, w.role, pick(WORK)) : w))
      // E uma de contar o que acabou de fazer.
      for (const w of r.workers) {
        const kinds = EVENTS[w.activity]
        if (!kinds || Math.random() > 0.45) continue
        const e: OfficeEvent = { id: `demo-${++seq}`, at: Date.now(), kind: pick(kinds), worker: w.id, detail: w.detail }
        r.events = [...r.events, e].slice(-12)
      }
    }
    if (r.sessionId === 'demo-b' && tick % 4 === 0) {
      const asking = r.state === 'waiting'
      r.state = asking ? 'running' : 'waiting'
      r.workers = [worker('lead', 'Gestor', 'gestor', asking ? pick(WORK) : 'ask')]
    }
    if (r.sessionId === 'demo-e' && tick % 7 === 3) {
      const resting = r.state === 'idle'
      r.state = resting ? 'running' : 'idle'
      r.workers = [worker('lead', 'Gestor', 'gestor', resting ? 'think' : 'idle')]
    }
  }
  // O time do README: de tempos em tempos alguém é chamado, e quem terminou volta a descansar.
  const d = next.find((r) => r.sessionId === 'demo-d')
  if (d && tick % 3 === 1) {
    const calls = d.workers.filter((w) => w.role !== 'gestor')
    if (calls.length < 2 && Math.random() < 0.7) {
      const i = Math.floor(Math.random() * TEAM.length)
      d.workers.push(worker(`d-call-${tick}`, TEAM_TASKS[i]!, TEAM[i]!.key, pick(WORK)))
    } else if (calls.length) d.workers.splice(d.workers.indexOf(pick(calls)), 1)
  }
  const a = next[0]
  if (a.todos && tick % 2 === 0) a.todos = { ...a.todos, done: (a.todos.done + 1) % (a.todos.total + 1) }
  // Subagentes chegando e indo embora na sala da refatoração.
  if (tick % 3 === 2) {
    const missing = AGENTS.filter((_, i) => !a.workers.some((w) => w.id === `a${i + 1}`))
    if (missing.length && Math.random() < 0.6) {
      const i = AGENTS.indexOf(pick(missing))
      a.workers.push(worker(`a${i + 1}`, AGENTS[i][0], AGENTS[i][1], pick(WORK)))
    } else if (a.workers.length > 2) a.workers.splice(1 + Math.floor(Math.random() * (a.workers.length - 1)), 1)
  }
  return next
}

/** As salas de mentira, mudando a cada 4 s (dá tempo de chegar e trabalhar um pouco). */
export function useDemoOffice(enabled: boolean): OfficeRoom[] {
  const [rooms, setRooms] = useState(initial)
  useEffect(() => {
    if (!enabled) return
    let tick = 0
    const timer = setInterval(() => setRooms((r) => evolve(r, ++tick)), 4_000)
    return () => clearInterval(timer)
  }, [enabled])
  return rooms
}
