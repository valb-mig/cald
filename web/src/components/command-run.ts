import { createContext } from 'react'

/**
 * Rodar um comando do chat no terminal, na pasta da conversa (ver o bloco de comando e o comando inline
 * em markdown.tsx, e `runInFolder`). `enter: false` só cola; `newTab` abre outra aba. `null` fora do
 * chat e onde não há terminal (o celular): os comandos ficam só com o copiar.
 */
export type CommandRun = (command: string, opts: { enter: boolean; newTab?: boolean }) => void

export const CommandRun = createContext<CommandRun | null>(null)
