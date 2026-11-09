import { createContext } from 'react'
import { create } from 'zustand'
import type { Screen, Slot } from '@/lib/chat-view'

/** O tipo do arrasto de uma tela do modo coding: próprio, para não se misturar com o das abas e o do cabeçalho do chat. */
export const SCREEN_DRAG = 'application/x-editr-screen'

/** A tela que está sendo arrastada agora: os três lugares viram alvo enquanto houver uma. */
export const useDraggingScreen = create<{ screen: Screen | null }>(() => ({ screen: null }))

/** O que cada janela do modo coding sabe de si: de quem é, onde está e se está recolhida. */
export const ScreenCtx = createContext<{ screen: Screen; slot: Slot; collapsed: boolean; toggle: () => void } | null>(null)
