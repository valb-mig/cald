import { Bug, FlaskConical, MessageCircleQuestion, Sparkles, WandSparkles } from 'lucide-react'
import { toast } from 'sonner'
import { insertInChat } from './project-panel'

/**
 * Pedir ao Claude algo sobre um trecho do código: o editor do PC (botão direito e Ctrl+I) e a seleção
 * de linhas do diff e do arquivo só leitura. O pedido entra no campo da conversa do projeto, com a
 * menção às linhas, e não vai sozinho: dá para ajustar antes de mandar.
 */
export const ASKS = [
  { kind: 'explain', label: 'Explicar', icon: MessageCircleQuestion, prompt: 'Explica o que esse trecho faz.' },
  { kind: 'refactor', label: 'Refatorar', icon: WandSparkles, prompt: 'Refatora esse trecho para ficar mais claro, sem mudar o comportamento.' },
  { kind: 'test', label: 'Escrever testes', icon: FlaskConical, prompt: 'Escreve testes para esse trecho, no jeito de testar do projeto.' },
  { kind: 'bugs', label: 'Achar bugs', icon: Bug, prompt: 'Procura bugs nesse trecho e diz o que pode dar errado.' },
  // Só a menção: o pedido você escreve.
  { kind: 'other', label: 'Outra coisa…', icon: Sparkles, prompt: '' },
] as const

export type Ask = (typeof ASKS)[number]

/** Põe o pedido sobre as linhas `lines` de `path` no campo da conversa; avisa se ela não tem campo agora. */
export function askClaude(path: string, lines: [number, number], ask: Ask): boolean {
  const [from, to] = lines
  const ref = `@${path}#L${from}${to !== from ? `-${to}` : ''}`
  const ok = insertInChat(`${ref} ${ask.prompt}${ask.prompt ? ' ' : ''}`)
  if (!ok) toast('Esta conversa não tem onde escrever agora', { description: 'Aberta no PC: assuma a sessão para mencionar arquivos.' })
  return ok
}
