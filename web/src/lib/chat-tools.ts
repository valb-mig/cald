import { create } from 'zustand'
import type { ToolEntry } from '@/components/chat/turn'

/**
 * As ferramentas que o Claude usou em cada conversa aberta (comandos, edições, buscas), na ordem,
 * com o resultado. A conversa publica as dela (ver ChatPage), e o painel de comandos lê daqui: ver o
 * que rodou não faz buscar o histórico de novo.
 */
export const useChatTools = create<Record<string, ToolEntry[]>>(() => ({}))

export function publishTools(id: string, tools: ToolEntry[]): void {
  useChatTools.setState({ [id]: tools })
}

export function dropTools(id: string): void {
  useChatTools.setState((s) => {
    const { [id]: _gone, ...rest } = s
    return rest
  }, true)
}
