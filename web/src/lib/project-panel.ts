import { useEffect } from 'react'
import { create } from 'zustand'
import { insertInto } from './compose'
import { WIDE_QUERY } from './hooks'
import type { DiffSide } from './types'
import { openPanelTab, revealChat } from './workbench'

/**
 * A barra do projeto, à direita (como a barra lateral secundária do VSCode): os arquivos, a busca neles, o controle
 * de código-fonte, os PRs e issues do GitHub, o TODO e o que o Claude carrega (memória, skills e MCP)
 * no projeto da conversa em foco. No PC ela fica
 * ao lado das conversas quando cabe;
 * no celular, ou numa janela estreita demais, abre por cima, como folha.
 */
export type PanelTab = 'files' | 'search' | 'git' | 'pulls' | 'issues' | 'todo' | 'claude'
const TABS: PanelTab[] = ['files', 'search', 'git', 'pulls', 'issues', 'todo', 'claude']

/** O projeto que a barra mostra: o da conversa em foco (ou da nova conversa), posto por ela. */
export type PanelProject = { machine: string; cwd: string }

/** O projeto na barra e o campo de mensagem da conversa que o pôs, para onde vão as menções. */
export type ShownProject = PanelProject & { chat: string }

/** O que está aberto por cima da conversa: um arquivo do projeto ou, com `diff`, um lado do diff dele. */
export type Viewing = PanelProject & { path: string; diff?: DiffSide }

export const PANEL_WIDTH = 320
export const PANEL_MIN = 240
export const PANEL_MAX = 640
/** A alça da barra no PC, sempre à direita enquanto há projeto: a mesma largura da da esquerda. */
export const PANEL_RAIL = 64

type Saved = { open: boolean; tab: PanelTab; width: number }
type State = Saved & {
  /** Aberta como folha (celular, janela estreita): não fica salvo, para não abrir sozinha da próxima vez. */
  sheet: boolean
  /** Se a barra cabe ao lado das conversas agora; posto por ela mesma (ver ProjectBar). */
  docked: boolean
  project: ShownProject | null
  viewing: Viewing | null
}

const KEY = 'cr:project-panel'

function load(): Saved {
  const fallback: Saved = { open: false, tab: 'files', width: PANEL_WIDTH }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>
    return {
      open: raw.open === true,
      tab: raw.tab && TABS.includes(raw.tab) ? raw.tab : 'files',
      width: typeof raw.width === 'number' ? Math.min(PANEL_MAX, Math.max(PANEL_MIN, raw.width)) : fallback.width,
    }
  } catch {
    return fallback
  }
}

export const useProjectPanel = create<State>(() => ({ ...load(), sheet: false, docked: false, project: null, viewing: null }))

/** Grava aberta/fechada, a aba e a largura; a largura só no fim do arrasto, não a cada movimento. */
export function savePanel(): void {
  const { open, tab, width } = useProjectPanel.getState()
  try {
    localStorage.setItem(KEY, JSON.stringify({ open, tab, width }))
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}

/** Se a barra está à vista: ao lado das conversas ou como folha, conforme couber. */
export const isPanelShown = (s: State) => (s.docked ? s.open : s.sheet)

export function setPanelShown(shown: boolean): void {
  useProjectPanel.setState((s) => (s.docked ? { open: shown } : { sheet: shown }))
  savePanel()
}

export const togglePanel = () => setPanelShown(!isPanelShown(useProjectPanel.getState()))

export function setPanelTab(tab: PanelTab): void {
  useProjectPanel.setState({ tab })
  savePanel()
}

export const setPanelWidth = (width: number) => useProjectPanel.setState({ width })

/**
 * Abre um arquivo (ou um lado do diff dele). No PC vira aba, como no VSCode: de prévia, que o próximo
 * arquivo troca, ou fixa com `pin` (dois cliques). No celular, ocupa a tela toda por cima.
 */
export function openViewer(viewing: Viewing, pin = false): void {
  if (!matchMedia(WIDE_QUERY).matches) return useProjectPanel.setState({ viewing })
  openPanelTab({ kind: 'file', ...viewing }, { preview: !pin })
  // A folha (janela estreita) sai da frente da aba que acabou de abrir.
  useProjectPanel.setState({ sheet: false })
}
export const closeViewer = () => useProjectPanel.setState({ viewing: null })

/** Quem pôs o projeto que está na barra: só ele tira. */
let owner: object | null = null
/** A última conversa em foco de cada projeto: para onde vão as menções feitas com um arquivo em foco. */
const lastChat = new Map<string, string>()

/**
 * Põe o projeto na barra enquanto `active` (a conversa em foco, a nova conversa); `chat` é o id do
 * campo de mensagem dela. Ao sair de foco ou da tela ele sai, a não ser que outra conversa já tenha
 * posto o dela.
 */
export function useShowProject(machine: string, cwd: string | undefined, chat: string | null, active: boolean): void {
  useEffect(() => {
    if (!active || !cwd) return
    const me = {}
    owner = me
    // Aba de arquivo em foco (`chat` nulo): as menções vão para a última conversa em foco do projeto.
    const key = `${machine}\n${cwd}`
    if (chat) lastChat.set(key, chat)
    const target = chat ?? lastChat.get(key) ?? ''
    const current = useProjectPanel.getState().project
    // Mesmo projeto e mesma conversa: fica o que está, sem a barra recomeçar.
    if (current?.machine !== machine || current.cwd !== cwd || current.chat !== target) {
      useProjectPanel.setState({ project: { machine, cwd, chat: target } })
    }
    return () => {
      // Depois do efeito da conversa que ganhou o foco, que roda logo em seguida: ela já é a dona.
      queueMicrotask(() => {
        if (owner !== me) return
        owner = null
        useProjectPanel.setState({ project: null })
      })
    }
  }, [machine, cwd, chat, active])
}

/**
 * Menciona um arquivo, uma pasta (`dir`) ou um trecho (`lines`, primeira e última) na conversa da
 * barra: `@caminho`, `@pasta/` ou `@caminho#L10-20` entra onde estava o cursor do campo de mensagem,
 * que fica em foco. O trecho vai no formato que o próprio Claude Code entende (o mesmo da extensão do
 * VSCode). O arquivo aberto por cima sai, e a folha (celular) fecha, para o campo aparecer.
 */
export function mentionInChat(path: string, at: { dir?: boolean; lines?: [number, number] } = {}): boolean {
  const [from, to] = at.lines ?? []
  const ref = at.dir ? `${path}/` : from ? `${path}#L${from}${to && to !== from ? `-${to}` : ''}` : path
  return insertInChat(`@${ref} `)
}

/**
 * Escreve `text` no campo de mensagem da conversa do projeto da barra (a em foco, ou a última dele),
 * como as menções de arquivo; `false` se ela não tem campo agora (aberta no PC).
 */
export function insertInChat(text: string): boolean {
  const { project, docked } = useProjectPanel.getState()
  if (!project?.chat) return false
  // No PC, a conversa vem para a frente (a aba dela, no grupo dela) antes do texto entrar no campo.
  if (matchMedia(WIDE_QUERY).matches) revealChat(project.chat)
  if (!insertInto(project.chat, text)) return false
  closeViewer()
  if (!docked) useProjectPanel.setState({ sheet: false })
  return true
}
