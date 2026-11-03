import { Check, MessageCircleQuestion, PenLine } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { api, errorMessage } from '@/lib/api'
import type { Question } from '@/lib/types'
import { cn } from '@/lib/utils'
import type { Item } from './items'
import { picked as isPicked, RECOMMENDED } from './questions'

type Props = Extract<Item, { type: 'question' }> & { sessionId: string; actionable: boolean }
type Option = Question['options'][number]

/** A marca de escolha: círculo na escolha única, quadrado na múltipla. */
function Mark({ multi, checked }: { multi: boolean; checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors',
        multi ? 'rounded-[5px]' : 'rounded-full',
        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40 bg-background',
      )}
    >
      {checked && (multi ? <Check className="size-3" strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-primary-foreground" />)}
    </span>
  )
}

/** O miolo de uma opção: a marca, o rótulo (com o selo de recomendada) e a descrição. */
function OptionBody({ option, multi, checked }: { option: Option; multi: boolean; checked: boolean }) {
  const recommended = RECOMMENDED.test(option.label)
  const label = option.label.replace(RECOMMENDED, '')
  return (
    <>
      <Mark multi={multi} checked={checked} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={cn('text-sm', checked ? 'font-semibold' : 'font-medium')}>{label}</span>
          {recommended && (
            <span className="rounded-full bg-emerald-500/15 px-1.5 py-px text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
              Recomendado
            </span>
          )}
        </span>
        {option.description && option.description !== option.label && (
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{option.description}</span>
        )}
      </span>
    </>
  )
}

function OptionRow({
  option,
  multi,
  checked,
  disabled,
  onClick,
}: {
  option: Option
  multi: boolean
  checked: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-60',
        checked && 'bg-primary/[0.07] hover:bg-primary/10',
      )}
    >
      <OptionBody option={option} multi={multi} checked={checked} />
    </button>
  )
}

/**
 * A pergunta já feita, só para ler (a linha da AskUserQuestion no chat), com a mesma cara do cartão:
 * cada pergunta com as opções, a escolhida acesa e as outras apagadas, e a resposta escrita à mão
 * como a última linha. Sem `answers` (pendente, recusada), as opções ficam neutras e `note` diz o que houve.
 */
export function QuestionAnswers({ questions, answers, note }: { questions: Question[]; answers?: Record<string, string>; note?: string }) {
  return (
    <div className="space-y-2.5">
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {questions.map((q) => {
        const answer = answers?.[q.question]
        const chosen = new Set(answer ? q.options.filter((o) => isPicked(answer, o.label)).map((o) => o.label) : [])
        const typed = answer && !chosen.size ? answer : undefined
        return (
          <div key={q.question} className="space-y-1.5">
            <div className="space-y-0.5">
              {q.header && <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{q.header}</div>}
              <p className="text-sm font-medium">{q.question}</p>
            </div>
            <div
              role="list"
              aria-label={q.question}
              className="divide-y overflow-hidden rounded-lg border bg-background/40"
            >
              {q.options.map((o) => {
                const on = chosen.has(o.label)
                return (
                  <div
                    key={o.label}
                    role="listitem"
                    aria-current={on || undefined}
                    className={cn('flex items-start gap-3 px-3 py-2', on ? 'bg-primary/[0.07]' : answer && 'opacity-55')}
                  >
                    <OptionBody option={o} multi={q.multiSelect} checked={on} />
                  </div>
                )
              })}
              {typed && (
                <div role="listitem" aria-current className="flex items-start gap-3 bg-primary/[0.07] px-3 py-2">
                  <PenLine className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="text-muted-foreground">Outra resposta: </span>
                    <span className="font-semibold whitespace-pre-wrap">{typed}</span>
                  </span>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Pergunta do Claude com opções. Com várias, cada uma ganha uma aba (o rótulo curto dela, com ✓ quando
 * respondida), como no terminal: uma por vez na tela, e escolher numa de escolha única já leva à
 * próxima que falta. As opções são uma lista só, e "Outra resposta" é a última linha dela — escrever
 * ali desmarca as opções, e marcar uma opção apaga o texto, para nunca ir uma resposta ambígua.
 */
export function QuestionCard({ sessionId, req, resolution, actionable }: Props) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)

  if (resolution) {
    return (
      <div className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {resolution.decision === 'answered' && resolution.answers ? (
          Object.entries(resolution.answers).map(([q, a]) => (
            <div key={q}>
              {q} <span className="font-medium text-foreground">→ {a}</span>
            </div>
          ))
        ) : (
          <div>{resolution.decision === 'declined' ? 'Você preferiu não responder.' : 'Pergunta cancelada.'}</div>
        )}
      </div>
    )
  }

  const questions = req.questions
  const many = questions.length > 1
  const answerFor = (q: Question) => other[q.question]?.trim() || (picked[q.question] ?? []).join(', ')
  const missing = questions.filter((q) => !answerFor(q))
  const complete = missing.length === 0
  const at = Math.min(step, questions.length - 1)
  const q = questions[at]!
  const last = at === questions.length - 1
  const locked = !actionable || busy
  const tabName = (x: Question, i: number) => x.header || `Pergunta ${i + 1}`

  async function submit(decline: boolean) {
    setBusy(true)
    try {
      const answers = Object.fromEntries(questions.map((x) => [x.question, answerFor(x)]))
      await api.answer(sessionId, req.requestId, decline ? { decline: true } : { answers })
    } catch (err) {
      toast.error(errorMessage(err))
      setBusy(false)
    }
  }

  /** A próxima pergunta sem resposta depois desta (ou antes, dando a volta); nenhuma, fica onde está. */
  const nextOpen = () => {
    const order = [...questions.keys()].filter((i) => i !== at)
    const after = order.filter((i) => i > at && !answerFor(questions[i]!))
    const before = order.filter((i) => i < at && !answerFor(questions[i]!))
    return after[0] ?? before[0] ?? at
  }

  const choose = (option: Option) => {
    if (q.multiSelect) {
      setPicked((p) => {
        const current = p[q.question] ?? []
        const next = current.includes(option.label) ? current.filter((l) => l !== option.label) : [...current, option.label]
        return { ...p, [q.question]: next }
      })
    } else {
      setPicked((p) => ({ ...p, [q.question]: [option.label] }))
      // Escolha única: segue para a próxima que falta, menos quando a opção tem prévia, que é para olhar.
      if (many && !option.preview) {
        const to = nextOpen()
        if (to !== at) setTimeout(() => setStep(to), 220)
      }
    }
    setOther((o) => ({ ...o, [q.question]: '' }))
  }

  const chosen = picked[q.question] ?? []
  const previews = q.options.filter((o) => o.preview && chosen.includes(o.label))

  return (
    <Card size="sm" className="border-amber-500/50 ring-amber-500/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageCircleQuestion className="size-4 text-amber-600 dark:text-amber-400" />
          {many ? `O Claude tem ${questions.length} perguntas` : 'O Claude tem uma pergunta'}
        </CardTitle>
      </CardHeader>

      {many && (
        <div role="tablist" aria-label="Perguntas" className="flex gap-1 overflow-x-auto border-y px-(--card-spacing) [scrollbar-width:none]">
          {questions.map((x, i) => {
            const done = Boolean(answerFor(x))
            const active = i === at
            return (
              <button
                key={x.question}
                type="button"
                role="tab"
                aria-selected={active}
                title={x.question}
                onClick={() => setStep(i)}
                className={cn(
                  'relative flex shrink-0 items-center gap-1.5 px-2 py-2 text-xs font-medium transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                  // A aba aberta ganha um traço embaixo, sobre a borda da faixa.
                  active && 'after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary',
                )}
              >
                <span
                  className={cn(
                    'flex size-4 items-center justify-center rounded-full border text-[10px] tabular-nums transition-colors',
                    done ? 'border-emerald-500 bg-emerald-500 text-white' : active ? 'border-foreground/60' : 'border-muted-foreground/40',
                  )}
                >
                  {done ? <Check className="size-2.5" strokeWidth={3.5} /> : i + 1}
                </span>
                {tabName(x, i)}
              </button>
            )
          })}
        </div>
      )}

      <CardContent className="space-y-2.5" role={many ? 'tabpanel' : undefined}>
        <div className="space-y-0.5">
          {!many && q.header && <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{q.header}</div>}
          <p className="text-sm font-medium">{q.question}</p>
          {q.multiSelect && <p className="text-xs text-muted-foreground">Pode escolher mais de uma.</p>}
        </div>

        <div role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question} className="divide-y overflow-hidden rounded-lg border bg-background/40">
          {q.options.map((o) => (
            <OptionRow
              key={o.label}
              option={o}
              multi={q.multiSelect}
              checked={chosen.includes(o.label)}
              disabled={locked}
              onClick={() => choose(o)}
            />
          ))}
          <label className={cn('flex items-center gap-3 px-3 py-2', other[q.question]?.trim() && 'bg-primary/[0.07]', locked && 'opacity-60')}>
            <PenLine className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              value={other[q.question] ?? ''}
              disabled={locked}
              placeholder="Outra resposta…"
              onChange={(e) => {
                const text = e.target.value
                setOther((o) => ({ ...o, [q.question]: text }))
                if (text.trim()) setPicked((p) => ({ ...p, [q.question]: [] }))
              }}
              // 16 px no celular: abaixo disso o Safari dá zoom na página ao focar.
              className="min-w-0 flex-1 bg-transparent py-0.5 text-base outline-none placeholder:text-muted-foreground md:text-sm"
            />
          </label>
        </div>

        {previews.map((o) => (
          <pre key={o.label} className="overflow-x-auto rounded-lg border bg-muted/40 p-2 font-mono text-[11px]">
            {o.preview}
          </pre>
        ))}

        {many && last && !complete && (
          <p className="text-xs text-muted-foreground">
            Falta responder: {missing.map((x) => tabName(x, questions.indexOf(x))).join(', ')}.
          </p>
        )}
      </CardContent>

      <CardFooter className="flex flex-wrap gap-2">
        {actionable ? (
          <>
            {many && !complete && !last ? (
              <Button size="lg" className="flex-1" onClick={() => setStep(at + 1)}>
                Próxima
              </Button>
            ) : (
              <Button size="lg" className="flex-1" disabled={!complete || busy} onClick={() => submit(false)}>
                Responder
              </Button>
            )}
            {many && at > 0 && (
              <Button size="lg" variant="outline" onClick={() => setStep(at - 1)}>
                Voltar
              </Button>
            )}
            <Button size="lg" variant="ghost" disabled={busy} onClick={() => submit(true)}>
              Não responder
            </Button>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Sem resposta: a sessão não está mais aberta no painel.</p>
        )}
      </CardFooter>
    </Card>
  )
}
