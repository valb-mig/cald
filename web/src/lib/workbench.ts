import { navigate } from 'wouter/use-browser-location'
import { create } from 'zustand'
import type { DiffSide } from './types'
import { closeGuarded } from './unsaved'

/**
 * Abas no PC, como os grupos de editores do VSCode: cada lado da tela (um grupo) tem a sua barra de
 * abas, e cada aba é uma conversa, um arquivo (ou o diff de um lado dele), uma issue ou PR do GitHub
 * (abertos pela barra do projeto), o hub de um projeto, uma página do Claude ou um artefato. As regras são as do VSCode:
 * - clicar abre numa aba de prévia (título em itálico); só há uma por grupo, e a próxima toma o lugar dela;
 * - a prévia vira fixa com dois cliques (na lista ou na aba), ao escrever ou mandar mensagem nela (como
 *   editar um arquivo), ao ser arrastada para outro grupo, e a conversa nova já nasce fixa;
 * - a aba nova entra logo à direita da ativa;
 * - fechar a ativa volta para a usada por último no grupo, não para a vizinha.
 * Diferente do VSCode, uma aba aberta não se repete em outro grupo: abrir de novo leva até ela.
 * No celular nada disso existe: lá a tela segue a URL, como antes (ver lib/split.ts).
 *
 * Fica salvo neste aparelho: recarregar, ir à home e voltar mantém as abas como estavam.
 */

export type TabRef =
  | { kind: 'chat'; id: string }
  | { kind: 'file'; machine: string; cwd: string; path: string; diff?: DiffSide }
  /** `title`: o da lista, para a aba ter nome antes de o detalhe chegar; não faz parte da chave. */
  | { kind: 'github'; machine: string; cwd: string; item: 'issue' | 'pr'; number: number; title?: string }
  /** Abrir um PR do projeto (ver project/pull-composer.tsx): ao abrir, a aba vira a do PR. Uma por projeto. */
  | { kind: 'pr-new'; machine: string; cwd: string }
  /** O hub do projeto: a conversa nova, a equipe de claudinhos, as pendências e o uso (ver project/hub.tsx). */
  | { kind: 'project'; machine: string; cwd: string }
  /**
   * Uma conversa nova, ainda sem sessão (sem `cwd`, na pasta pessoal): a primeira mensagem cria a sessão,
   * e a aba vira a dela, no mesmo lugar (ver `replaceTab`). Uma por projeto: abrir de novo volta para ela.
   */
  | { kind: 'new'; machine: string; cwd?: string; workspace?: string }
  /** A página de um workspace: projetos, contexto, regras, comandos, time e as conversas dele. */
  | { kind: 'workspace'; machine: string; id: string }
  /** A inbox: tudo o que pede você, de todas as máquinas (uma aba só). */
  | { kind: 'inbox' }
  /**
   * Uma página do Claude (o HTML que a ferramenta Artifact publica, ou um .html do projeto), num
   * mini-navegador (ver lib/prototype.ts). `path` sempre absoluto; `cwd` (o projeto, para a barra dele),
   * `url` (o artifact no claude.ai) e `title` (a descrição) não fazem parte da chave.
   */
  | { kind: 'prototype'; machine: string; path: string; cwd?: string; url?: string; title?: string }
  /**
   * Um artefato publicado pelo Claude (ver lib/artefatos.ts), no mesmo mini-navegador. Uma aba por
   * artefato: `n` (a versão à vista; sem ela, a atual) e `title` (o nome antes de a lista chegar) não
   * fazem parte da chave, e abrir de novo com outra versão troca a da aba.
   */
  | { kind: 'artefato'; machine: string; id: string; n?: number; title?: string }

export type Tab = TabRef & { key: string; preview?: boolean }

/** `recent`: as abas da mais usada por último para a menos, para fechar a ativa voltar para a anterior. */
export type Group = { id: string; tabs: Tab[]; active: string | null; recent?: string[] }

type State = {
  groups: Group[]
  focused: string | null
  /** A última URL que a área de trabalho viu ou escreveu, para não reabrir o que já está aberto. */
  url: string | null
}

/**
 * A área das abas sem uma conversa em foco: com um arquivo, uma issue ou um PR na frente, a URL é esta,
 * e não `/s/…`, que abriria a conversa por cima da aba. Com uma conversa em foco, a URL volta a ser a dela.
 */
export const WORKBENCH_PATH = '/abas'

/** Se a tela é a das abas (no PC): a de uma conversa ou a das abas sem conversa em foco. */
export const onWorkbench = (pathname: string) => pathname.startsWith('/s/') || pathname === WORKBENCH_PATH

export const keyOf = (ref: TabRef) =>
  ref.kind === 'chat'
    ? `c:${ref.id}`
    : ref.kind === 'file'
      ? `f:${ref.machine}\n${ref.cwd}\n${ref.path}\n${ref.diff ?? ''}`
      : ref.kind === 'github'
        ? `g:${ref.machine}\n${ref.cwd}\n${ref.item}\n${ref.number}`
        : ref.kind === 'pr-new'
          ? `pr:${ref.machine}\n${ref.cwd}`
          : ref.kind === 'new'
            ? `n:${ref.machine}\n${ref.cwd ?? ''}${ref.workspace ? `\n${ref.workspace}` : ''}`
            : ref.kind === 'workspace'
              ? `w:${ref.machine}\n${ref.id}`
              : ref.kind === 'inbox'
                ? 'i:'
                : ref.kind === 'prototype'
                  ? `pt:${ref.machine}\n${ref.path}`
                  : ref.kind === 'artefato'
                    ? `ar:${ref.machine}\n${ref.id}`
                    : `p:${ref.machine}\n${ref.cwd}`

const KEY = 'cr:workbench'
let counter = 0
const newGroupId = () => `g${Date.now().toString(36)}${(counter++).toString(36)}`

function load(): State {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as State | null
    if (raw && Array.isArray(raw.groups)) {
      const groups = raw.groups.filter((g) => g.tabs?.length)
      const focused = groups.some((g) => g.id === raw.focused) ? raw.focused : (groups[0]?.id ?? null)
      return { groups, focused, url: raw.url ?? null }
    }
  } catch {
    // salvo estragado: começa do zero
  }
  return { groups: [], focused: null, url: null }
}

export const useWorkbench = create<State>(load)

let saving: ReturnType<typeof setTimeout> | undefined
function save(): void {
  saving = undefined
  try {
    localStorage.setItem(KEY, JSON.stringify(useWorkbench.getState()))
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}
useWorkbench.subscribe(() => {
  clearTimeout(saving)
  saving = setTimeout(save, 200)
})
// Recarregar logo depois de abrir uma aba (o app que recarrega na versão nova ao abrir um arquivo,
// ver reloadIfStale em lib/update.ts): grava já, senão a aba some na volta.
window.addEventListener('pagehide', () => {
  if (saving === undefined) return
  clearTimeout(saving)
  save()
})

// ---- leitura ----

export const activeTab = (g: Group | undefined) => g?.tabs.find((t) => t.key === g.active)
export const focusedGroup = (s: State) => s.groups.find((g) => g.id === s.focused) ?? s.groups[0]

/** As conversas à vista, uma por grupo (a aba ativa de cada um, quando é conversa), na ordem da tela. */
export function visibleChats(s: State): string[] {
  return s.groups.flatMap((g) => {
    const t = activeTab(g)
    return t?.kind === 'chat' ? [t.id] : []
  })
}

/** A conversa em foco: a aba ativa do grupo em foco, se for uma conversa. */
export function focusedChat(s: State): string | null {
  const t = activeTab(focusedGroup(s))
  return t?.kind === 'chat' ? t.id : null
}

// ---- ações ----

type Groups = Group[]

/** Grava os grupos; a aba que virou ativa em cada um vai para o começo do histórico de uso dele. */
function set(groups: Groups, focused: string | null): void {
  const before = useWorkbench.getState().groups
  const next = groups.map((g) => {
    const old = before.find((b) => b.id === g.id)
    const recent = (g.recent ?? old?.recent ?? []).filter((k) => k !== g.active && g.tabs.some((t) => t.key === k))
    return { ...g, recent: g.active ? [g.active, ...recent] : recent }
  })
  useWorkbench.setState({ groups: next, focused: next.some((g) => g.id === focused) ? focused : (next[0]?.id ?? null) })
}

/** Tira a aba do grupo; se era a ativa, volta a usada por último antes dela (ou a vizinha). Grupo vazio sai. */
function without(groups: Groups, groupId: string, key: string): Groups {
  return groups.flatMap((g) => {
    if (g.id !== groupId) return [g]
    const i = g.tabs.findIndex((t) => t.key === key)
    if (i < 0) return [g]
    const tabs = g.tabs.filter((t) => t.key !== key)
    if (!tabs.length) return []
    const previous = g.recent?.find((k) => k !== key && tabs.some((t) => t.key === k))
    const active = g.active === key ? (previous ?? (tabs[i] ?? tabs[i - 1])!.key) : g.active
    return [{ ...g, tabs, active, recent: g.recent?.filter((k) => k !== key) }]
  })
}

function find(groups: Groups, key: string): Group | undefined {
  return groups.find((g) => g.tabs.some((t) => t.key === key))
}

/**
 * Abre pela barra do projeto uma aba que não é conversa (arquivo, issue, PR). Fora da tela das abas
 * (home, nova conversa), vai para ela, senão a aba abriria sem aparecer.
 */
export function openPanelTab(ref: Exclude<TabRef, { kind: 'chat' }>, opts: { preview?: boolean } = {}): void {
  openTab(ref, opts)
  if (!onWorkbench(location.pathname)) navigate(WORKBENCH_PATH)
}

/** O que o hub de um projeto mostra embaixo do cabeçalho: a mesa, os worktrees ou os detalhes. */
export type HubView = 'desk' | 'worktrees' | 'detalhes'
/** A vista de cada hub, por projeto: quem abre o hub de fora (o menu do projeto) pode abrir já numa delas. */
export const useHubViews = create<Record<string, HubView>>(() => ({}))
export const hubViewKey = (machine: string, cwd: string) => `${machine}\n${cwd}`

/** Abre o hub do projeto numa aba de prévia (pelo nome dele na lista de sessões ou na de projetos); com `view`, já nela. */
export function openProjectHub(machine: string, cwd: string, view?: HubView): void {
  if (view) useHubViews.setState({ [hubViewKey(machine, cwd)]: view })
  openPanelTab({ kind: 'project', machine, cwd }, { preview: true })
}
export const openWorkspace = (machine: string, id: string) => openPanelTab({ kind: 'workspace', machine, id }, { preview: true })
export const openInbox = () => openPanelTab({ kind: 'inbox' })

/**
 * A aba já aberta, aberta de novo: com o que `ref` sabe e fica de fora da chave (o título de uma issue, o
 * link de uma página) e, com `pin`, fixa. Sem nada novo, a mesma aba, para quem a acompanha não redesenhar.
 */
function reopened(tab: Tab, ref: TabRef, pin: boolean): Tab {
  const next: Record<string, unknown> = { ...tab, ...(pin && { preview: false }) }
  for (const [k, v] of Object.entries(ref)) if (v !== undefined) next[k] = v
  const old = tab as Record<string, unknown>
  return Object.keys(next).every((k) => next[k] === old[k]) ? tab : (next as Tab)
}

/**
 * Abre `ref`. Já aberta em algum grupo: só vai para ela (e, sem `preview`, ela vira fixa), com o que
 * `ref` traz de novo (a página que ganhou o link do claude.ai depois de aberta pela árvore). Senão,
 * entra no grupo em foco (ou num grupo novo ao lado, com `beside`), logo depois da ativa; como
 * prévia, toma o lugar da prévia que houver no grupo.
 */
export function openTab(ref: TabRef, opts: { preview?: boolean; beside?: boolean; after?: string } = {}): void {
  const { groups, focused } = useWorkbench.getState()
  const key = keyOf(ref)
  const open = find(groups, key)
  if (open && !opts.beside) {
    set(
      groups.map((g) =>
        g.id === open.id
          ? { ...g, active: key, tabs: g.tabs.map((t) => (t.key === key ? reopened(t, ref, !opts.preview) : t)) }
          : g,
      ),
      open.id,
    )
    return
  }
  const tab: Tab = { ...ref, key, preview: opts.preview ?? false }
  // Ao lado: um grupo novo logo depois do grupo de `after` (ou do em foco). A aba sai de onde estava.
  if (opts.beside || !groups.length) {
    const rest = open ? without(groups, open.id, key) : groups
    const anchor = (opts.after && find(rest, opts.after)?.id) ?? focused
    const at = rest.findIndex((g) => g.id === anchor) + 1 || rest.length
    const group: Group = { id: newGroupId(), tabs: [tab], active: key }
    set([...rest.slice(0, at), group, ...rest.slice(at)], group.id)
    return
  }
  const target = groups.find((g) => g.id === focused) ?? groups[0]!
  set(
    groups.map((g) => {
      if (g.id !== target.id) return g
      const preview = opts.preview ? g.tabs.findIndex((t) => t.preview) : -1
      const tabs =
        preview >= 0
          ? g.tabs.map((t, i) => (i === preview ? tab : t))
          : (() => {
              const at = g.tabs.findIndex((t) => t.key === g.active) + 1 || g.tabs.length
              return [...g.tabs.slice(0, at), tab, ...g.tabs.slice(at)]
            })()
      return { ...g, tabs, active: key }
    }),
    target.id,
  )
}

export function activateTab(groupId: string, key: string): void {
  const { groups } = useWorkbench.getState()
  set(
    groups.map((g) => (g.id === groupId ? { ...g, active: key } : g)),
    groupId,
  )
}

export function focusGroup(groupId: string): void {
  if (useWorkbench.getState().focused !== groupId) useWorkbench.setState({ focused: groupId })
}

/** A prévia vira aba fixa (dois cliques, ou uma mensagem mandada nela). */
export function pinTab(key: string): void {
  const { groups, focused } = useWorkbench.getState()
  if (!groups.some((g) => g.tabs.some((t) => t.key === key && t.preview))) return
  set(
    groups.map((g) => ({ ...g, tabs: g.tabs.map((t) => (t.key === key ? { ...t, preview: false } : t)) })),
    focused,
  )
}

/** Fecha a aba; um arquivo com alteração não salva pergunta antes (ver lib/unsaved.ts). */
export function closeTab(groupId: string, key: string): void {
  closeGuarded([key], () => {
    const { groups, focused } = useWorkbench.getState()
    set(without(groups, groupId, key), focused)
  })
}

/** Fecha as outras abas do grupo (`which: 'others'`) ou as que estão à direita dela (`'right'`). */
export function closeTabs(groupId: string, key: string, which: 'others' | 'right'): void {
  const keep = (g: Group) => {
    const i = g.tabs.findIndex((t) => t.key === key)
    return which === 'others' ? g.tabs.filter((t) => t.key === key) : g.tabs.slice(0, i + 1)
  }
  const group = useWorkbench.getState().groups.find((g) => g.id === groupId)
  const closing = group ? group.tabs.filter((t) => !keep(group).includes(t)).map((t) => t.key) : []
  closeGuarded(closing, () => {
    const { groups, focused } = useWorkbench.getState()
    set(
      groups.map((g) => {
        if (g.id !== groupId) return g
        const tabs = keep(g)
        return { ...g, tabs, active: tabs.some((t) => t.key === g.active) ? g.active : key }
      }),
      focused,
    )
  })
}

/** Leva a aba para o grupo `to`, na posição `index` (ou no fim). */
export function moveTab(from: string, key: string, to: string, index?: number): void {
  const { groups } = useWorkbench.getState()
  const tab = groups.find((g) => g.id === from)?.tabs.find((t) => t.key === key)
  if (!tab) return
  if (from === to) {
    set(
      groups.map((g) => {
        if (g.id !== to) return g
        const rest = g.tabs.filter((t) => t.key !== key)
        const old = g.tabs.findIndex((t) => t.key === key)
        // A posição foi medida com a aba ainda no lugar: depois dela, tudo anda uma casa.
        const at = Math.min(index === undefined ? rest.length : index > old ? index - 1 : index, rest.length)
        return { ...g, tabs: [...rest.slice(0, at), tab, ...rest.slice(at)], active: key }
      }),
      to,
    )
    return
  }
  // Levada para outro grupo, a prévia vira fixa, como no VSCode: foi escolhida para ficar ali.
  const moved = { ...tab, preview: false }
  const rest = without(groups, from, key)
  set(
    rest.map((g) => {
      if (g.id !== to) return g
      const at = Math.min(index ?? g.tabs.length, g.tabs.length)
      return { ...g, tabs: [...g.tabs.slice(0, at), moved, ...g.tabs.slice(at)], active: key }
    }),
    to,
  )
}

/** Tira a aba do grupo e abre um grupo novo com ela, à esquerda ou à direita do grupo `of`. */
export function splitTab(from: string, key: string, of: string, side: 'left' | 'right'): void {
  const { groups } = useWorkbench.getState()
  const tab = groups.find((g) => g.id === from)?.tabs.find((t) => t.key === key)
  if (!tab) return
  const rest = without(groups, from, key)
  const anchor = rest.findIndex((g) => g.id === of)
  const at = anchor < 0 ? rest.length : side === 'left' ? anchor : anchor + 1
  const group: Group = { id: newGroupId(), tabs: [{ ...tab, preview: false }], active: key }
  set([...rest.slice(0, at), group, ...rest.slice(at)], group.id)
}

/** Fecha a conversa onde estiver aberta (apagada, por exemplo). */
export function closeChatTabs(id: string): void {
  const key = keyOf({ kind: 'chat', id })
  let { groups } = useWorkbench.getState()
  for (let g = find(groups, key); g; g = find(groups, key)) groups = without(groups, g.id, key)
  set(groups, useWorkbench.getState().focused)
}

/** A conversa `old` ganhou outro id (cópia, sessão retomada): a aba dela passa a ser a nova, já fixa. */
export function swapChatTab(old: string, id: string): void {
  const from = keyOf({ kind: 'chat', id: old })
  const to = keyOf({ kind: 'chat', id })
  const { groups, focused } = useWorkbench.getState()
  if (find(groups, to)) return closeChatTabs(old)
  set(
    groups.map((g) => ({
      ...g,
      active: g.active === from ? to : g.active,
      tabs: g.tabs.map((t) => (t.key === from ? { ...t, kind: 'chat', id, key: to, preview: false } : t)),
    })),
    focused,
  )
}

/**
 * A aba `from` vira `ref` no mesmo lugar, já fixa: a conversa nova que acabou de ganhar sessão, ou a
 * conversa nova que trocou de projeto. Com `ref` já aberta em outro lugar, `from` fecha e vai para ela.
 */
export function replaceTab(from: string, ref: TabRef): void {
  const to = keyOf(ref)
  if (from === to) return
  const { groups, focused } = useWorkbench.getState()
  if (find(groups, to)) {
    const g = find(groups, from)
    const rest = g ? without(groups, g.id, from) : groups
    const target = find(rest, to)!
    set(
      rest.map((x) => (x.id === target.id ? { ...x, active: to } : x)),
      target.id,
    )
    return
  }
  set(
    groups.map((g) => ({
      ...g,
      active: g.active === from ? to : g.active,
      recent: g.recent?.map((k) => (k === from ? to : k)),
      tabs: g.tabs.map((t) => (t.key === from ? { ...ref, key: to, preview: false } : t)),
    })),
    focused,
  )
}

/** Mostra a conversa: ativa a aba dela e põe o grupo em foco. `false` se ela não está aberta. */
export function revealChat(id: string): boolean {
  const key = keyOf({ kind: 'chat', id })
  const g = find(useWorkbench.getState().groups, key)
  if (g) activateTab(g.id, key)
  return Boolean(g)
}
