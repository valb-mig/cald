import type { PanelEvent, Question } from '@/lib/types'

/*
 * A AskUserQuestion vista de fora do pedido ao vivo: as perguntas vêm do input da ferramenta e as
 * respostas, do texto do resultado. Serve ao chat (a linha da ferramenta) e ao mapa mental.
 */

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** "Opção (Recomendado)": o Claude marca a sugestão dele no próprio rótulo; aqui ela vira um selo. */
export const RECOMMENDED = /\s*\((recomendad[oa]|recommended)\)\s*$/i

/** As perguntas do input da AskUserQuestion, no formato do pedido ao vivo; vazio se não bater. */
export function questionsOf(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : []
  return raw.flatMap((q) =>
    typeof q?.question === 'string' && Array.isArray(q.options)
      ? [
          {
            question: q.question,
            header: str(q.header),
            multiSelect: Boolean(q.multiSelect),
            options: (q.options as Record<string, unknown>[]).map((o) => ({ label: str(o.label), description: str(o.description) })),
          },
        ]
      : [],
  )
}

/**
 * As respostas, recortadas do texto que o Claude Code grava no resultado da AskUserQuestion. O
 * histórico só guarda esse texto (o SDK descarta a versão estruturada), mas o miolo é estável —
 * `"pergunta"="resposta"`, uma atrás da outra —, e como as perguntas vêm exatas do input, cada
 * resposta vai do fim da sua pergunta até o começo da próxima.
 */
export function parseAnswers(text: string, questions: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  questions.forEach((q, i) => {
    const open = `"${q}"="`
    const at = text.indexOf(open)
    if (at < 0) return
    const start = at + open.length
    const nexts = questions
      .slice(i + 1)
      .map((n) => text.indexOf(`", "${n}"="`, start))
      .filter((p) => p >= 0)
    const tail = text.indexOf('". ', start)
    const end = nexts.length ? Math.min(...nexts) : tail >= 0 ? tail : text.lastIndexOf('"')
    if (end > start) out[q] = text.slice(start, end)
  })
  return out
}

/**
 * Se a opção está entre as escolhidas: a resposta inteira, ou um dos itens de uma múltipla escolha,
 * que chega com os rótulos unidos por vírgula. Compara o rótulo inteiro com fronteira dos dois
 * lados, porque os próprios rótulos podem ter vírgula dentro.
 */
export function picked(answer: string, label: string): boolean {
  if (!label) return false
  for (let at = answer.indexOf(label); at >= 0; at = answer.indexOf(label, at + 1)) {
    const before = at === 0 || answer.slice(at - 2, at) === ', '
    const end = at + label.length
    const after = end === answer.length || answer.slice(end, end + 2) === ', '
    if (before && after) return true
  }
  return false
}

/** A AskUserQuestion como dá para mostrar: as perguntas, as respostas e, sem elas, o que houve. */
export type Ask = { questions: Question[]; answers?: Record<string, string>; note?: string }

/**
 * Da chamada da ferramenta: a resposta do pedido do painel, quando há, ou a recortada do resultado
 * (conversas do PC e histórico). Sem nada recortado, `answers` fica vazio e quem mostra cai no texto.
 */
export function askOf(
  input: Record<string, unknown>,
  result?: { isError: boolean; text: string },
  answer?: Extract<PanelEvent, { kind: 'question_resolved' }>,
): Ask {
  const questions = questionsOf(input)
  if (answer) {
    if (answer.decision === 'answered' && answer.answers) return { questions, answers: answer.answers }
    return { questions, note: answer.decision === 'declined' ? 'Você preferiu não responder.' : 'Pergunta cancelada.' }
  }
  if (!result || result.isError) return { questions }
  const answers = parseAnswers(result.text, questions.map((q) => q.question))
  return { questions, answers: Object.keys(answers).length ? answers : undefined }
}
