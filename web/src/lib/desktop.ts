import type { PushPrefs } from '@/lib/types'

/** Os avisos do app do PC: ligados ou não neste PC, e o que avisa além de perguntas, aprovações e erros. */
export type DesktopNotifications = PushPrefs & { enabled: boolean }

/**
 * O app do PC (ver desktop/): o Electron põe `window.editr` pelo preload (desktop/src/preload.ts).
 * Lá não há Web Push nem o ditado ao vivo do Chrome: os avisos são do sistema, mostrados pelo próprio
 * app, que guarda o que avisa, e o ditado vai para o Whisper do PC.
 */
type DesktopBridge = {
  notifications: {
    get: () => Promise<DesktopNotifications>
    set: (next: DesktopNotifications) => Promise<DesktopNotifications>
    test: () => Promise<void>
  }
  /** Clique num aviso do sistema: a tela da conversa dele. Devolve o que desliga. */
  onNavigate: (cb: (url: string) => void) => () => void
}

export const desktop = (window as { editr?: DesktopBridge }).editr
