import type { ConfigSyncKind, ConfigSyncSkip } from './types'

/**
 * O repositório de configuração (ver server/src/config-sync.ts): o que vai para ele, por categoria, e a
 * aparência deste aparelho, que mora no localStorage e por isso sai e entra pelo app, não pelo servidor.
 */

export type SyncKindInfo = { key: ConfigSyncKind; label: string; hint: string }

/** As categorias na ordem da tela, em grupos. */
export const SYNC_GROUPS: { title: string; kinds: SyncKindInfo[] }[] = [
  {
    title: 'Do edit.r',
    kinds: [
      { key: 'teams', label: 'Times', hint: 'Os subagentes de cada time.' },
      { key: 'workspaces', label: 'Workspaces', hint: 'Com os arquivos de contexto.' },
      { key: 'habilidades', label: 'Habilidades', hint: 'As globais e as de cada projeto.' },
      { key: 'commands', label: 'Comandos salvos', hint: 'Os da barra do terminal.' },
      { key: 'agents', label: 'Agentes ligados', hint: 'Quais conduzem as conversas, e o padrão.' },
    ],
  },
  {
    title: 'Dos projetos',
    kinds: [
      { key: 'todos', label: 'TODOs', hint: 'Sem os anexos, que ficam no PC.' },
      { key: 'detalhes', label: 'Detalhes', hint: 'Como cada parte do projeto funciona.' },
      { key: 'memory', label: 'Memória do Claude', hint: 'O que ele guardou sobre cada projeto.' },
    ],
  },
  {
    title: 'Do Claude Code',
    kinds: [
      { key: 'claude-config', label: 'Configuração', hint: 'settings.json (sem as variáveis secretas), CLAUDE.md e scripts.' },
      { key: 'claude-agents', label: 'Agentes', hint: 'Os seus, de ~/.claude/agents.' },
      { key: 'claude-skills', label: 'Skills pessoais', hint: 'As de ~/.claude/skills e os comandos.' },
    ],
  },
  {
    title: 'Deste aparelho',
    kinds: [{ key: 'appearance', label: 'Aparência', hint: 'Tema, fundo, sons, fonte do código e outras preferências do app.' }],
  },
]

export const SYNC_KINDS: SyncKindInfo[] = SYNC_GROUPS.flatMap((g) => g.kinds)

export const SKIP_LABEL: Record<ConfigSyncSkip, string> = {
  'newer-there': 'o do repositório é mais novo',
  'newer-here': 'o daqui é mais novo',
  'deleted-here': 'você apagou aqui',
  'no-project': 'o projeto não existe aqui',
  rejected: 'não deu para aplicar',
}

const KINDS_KEY = 'cr:config-sync-kinds'

/** As categorias escolhidas neste aparelho; todas, na primeira vez. */
export function loadKinds(): Set<ConfigSyncKind> {
  try {
    const saved = JSON.parse(localStorage.getItem(KINDS_KEY) ?? 'null') as ConfigSyncKind[] | null
    if (Array.isArray(saved)) return new Set(saved.filter((k) => SYNC_KINDS.some((i) => i.key === k)))
  } catch {
    // localStorage indisponível (modo privado): valem todas.
  }
  return new Set(SYNC_KINDS.map((k) => k.key))
}

export function saveKinds(kinds: Set<ConfigSyncKind>): void {
  try {
    localStorage.setItem(KINDS_KEY, JSON.stringify([...kinds]))
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}

// As preferências que viajam: o que é gosto, não o que é layout ou estado deste aparelho (abas, larguras, rascunhos).
const APPEARANCE_KEYS = [
  'theme',
  'cr:wallpaper',
  'cr:sounds',
  'cr:code-font',
  'cr:minimap',
  'cr:chat-display',
  'cr:chat-follow',
  'cr:speech-rate',
  'cald:autolock',
  'cr:pr-agent',
]
const WALLPAPER = 'cr:wallpaper'

/** A aparência deste aparelho, como está no localStorage (só as chaves que você já mexeu). */
export function readAppearance(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of APPEARANCE_KEYS) {
    try {
      const value = localStorage.getItem(key)
      if (value !== null) out[key] = value
    } catch {
      // localStorage indisponível: vai o que deu para ler.
    }
  }
  // A imagem de fundo fica no IndexedDB deste aparelho: vai a força e o escurecido, sem a escolha da imagem.
  const wallpaper = out[WALLPAPER]
  if (wallpaper) {
    try {
      const prefs = JSON.parse(wallpaper) as { theme?: string }
      if (prefs.theme?.startsWith('img:')) {
        delete prefs.theme
        out[WALLPAPER] = JSON.stringify(prefs)
      }
    } catch {
      delete out[WALLPAPER]
    }
  }
  return out
}

/** Grava a aparência que veio e recarrega o app, que lê as preferências ao abrir. */
export function applyAppearance(values: Record<string, string>): void {
  for (const key of APPEARANCE_KEYS) {
    let value = values[key]
    if (value === undefined) continue
    try {
      // Sem tema no fundo que veio (era uma imagem de lá), fica o daqui.
      if (key === WALLPAPER) value = JSON.stringify({ ...(JSON.parse(localStorage.getItem(key) ?? '{}') as object), ...(JSON.parse(value) as object) })
      localStorage.setItem(key, value)
    } catch {
      // Valor ilegível ou localStorage indisponível: essa preferência fica como está.
    }
  }
  location.reload()
}
