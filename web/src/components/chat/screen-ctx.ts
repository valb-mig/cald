import { createContext } from 'react'
import { create } from 'zustand'
import type { Screen, Slot } from '@/lib/chat-view'

/**
 * O arrasto de uma tela do modo coding, feito com o ponteiro e não com o arrastar do navegador (que no
 * app do PC, no Wayland, não chega a soltar): a tela que vai, onde o ponteiro está e a tela embaixo dele.
 * Os três lugares viram alvo enquanto houver uma.
 */
export const useDraggingScreen = create<{ screen: Screen | null; over: Screen | null; x: number; y: number }>(() => ({
  screen: null,
  over: null,
  x: 0,
  y: 0,
}))

/** O que cada janela do modo coding sabe de si: de quem é, onde está e se está recolhida. */
export const ScreenCtx = createContext<{ screen: Screen; slot: Slot; collapsed: boolean; toggle: () => void } | null>(null)
