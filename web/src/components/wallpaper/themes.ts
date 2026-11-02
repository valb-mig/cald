import type { Theme } from './engine'
import { ondas } from './ondas'

/** Os temas na ordem em que aparecem nos ajustes. */
export const THEMES: Theme[] = [ondas]

export const themeOf = (id: string): Theme | undefined => THEMES.find((t) => t.id === id)
