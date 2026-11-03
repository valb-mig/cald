import { Delete } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CaldMark } from '@/components/claudinho'
import { unlock, useLock } from '@/lib/lock'
import { cn } from '@/lib/utils'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'] as const

/**
 * A tela de bloqueio do PIN (ver lib/lock.ts), por cima de tudo: o teclado numérico no celular, as
 * teclas no PC. Confere sozinha ao completar os dígitos; errar balança as bolinhas, e errar demais
 * mostra quanto falta para tentar de novo.
 */
export function LockScreen() {
  const length = useLock((s) => s.length)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [shake, setShake] = useState(0)
  // Fim da espera depois de errar demais (ms), para a contagem.
  const [blockedUntil, setBlockedUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  // O foco vem para cá ao travar: no que estava focado por baixo (o terminal, que segura as teclas
  // para o shell), os dígitos do PIN não chegariam a esta tela.
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => dialog.current?.focus(), [])

  const blocked = blockedUntil > now
  useEffect(() => {
    if (!blocked) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [blocked])

  const press = (key: string) => {
    if (busy || blocked) return
    if (key === 'back') return setPin((p) => p.slice(0, -1))
    setMessage(null)
    const next = pin + key
    setPin(next)
    if (next.length === length) submit(next)
  }

  const submit = (value: string) => {
    setBusy(true)
    void unlock(value).then((result) => {
      setBusy(false)
      if (result.ok) return
      setPin('')
      setShake((n) => n + 1)
      if (result.error === 'blocked') {
        setNow(Date.now())
        setBlockedUntil(Date.now() + result.retryAfter * 1000)
        setMessage(null)
      } else if (result.error === 'wrong') {
        const left = result.attemptsLeft
        setMessage(left ? `PIN errado. ${left === 1 ? 'Mais 1 erro' : `Mais ${left} erros`} e você vai precisar esperar.` : 'PIN errado.')
      } else {
        setMessage('Sem resposta do PC. Confira a conexão e tente de novo.')
      }
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key)
      else if (e.key === 'Backspace') press('back')
      else return
      e.preventDefault()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  const wait = Math.ceil((blockedUntil - now) / 1000)
  return (
    <div
      ref={dialog}
      tabIndex={-1}
      role="dialog"
      aria-modal
      aria-label="Painel travado"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-8 bg-background px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] outline-none select-none"
    >
      <div className="flex flex-col items-center gap-3">
        <CaldMark className="size-10 text-foreground" />
        <p className="text-sm text-muted-foreground">Digite o PIN para abrir o painel</p>
      </div>

      <div key={shake} className={cn('flex gap-3', shake > 0 && 'lock-shake')} aria-live="polite" aria-label={`${pin.length} de ${length} dígitos`}>
        {Array.from({ length }, (_, i) => (
          <span
            key={i}
            className={cn('size-3 rounded-full border border-foreground/40 transition-colors', i < pin.length && 'border-foreground bg-foreground')}
          />
        ))}
      </div>

      <p className="h-4 text-center text-xs text-muted-foreground" role="status">
        {blocked ? `Muitas tentativas. Tente de novo em ${wait < 60 ? `${wait} s` : `${Math.ceil(wait / 60)} min`}.` : busy ? 'Conferindo…' : message}
      </p>

      <div className="grid grid-cols-3 gap-3">
        {KEYS.map((key, i) =>
          key === '' ? (
            <span key={i} />
          ) : (
            <button
              key={key}
              type="button"
              disabled={busy || blocked || (key === 'back' && !pin)}
              onClick={() => press(key)}
              aria-label={key === 'back' ? 'Apagar' : key}
              className="flex size-16 items-center justify-center rounded-full bg-foreground/[0.05] text-xl font-medium tabular-nums transition-colors hover:bg-foreground/10 active:bg-foreground/15 disabled:opacity-40 [&_svg]:size-5"
            >
              {key === 'back' ? <Delete /> : key}
            </button>
          ),
        )}
      </div>
    </div>
  )
}
