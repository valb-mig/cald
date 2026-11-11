import { createContext } from 'react'

/**
 * As opções de uma resposta do Claude (ver lib/options.ts). Respondida, `answer` é a sua mensagem
 * seguinte, e a opção escolhida nela fica acesa. Sem resposta ainda, `pick` escreve a opção na caixa
 * de mensagem e `picked` é a última que foi para lá. `null` fora do chat: as opções só se leem.
 */
export type OptionPick = { answer?: string; picked?: string; pick?: (text: string) => void }

export const OptionPick = createContext<OptionPick | null>(null)
