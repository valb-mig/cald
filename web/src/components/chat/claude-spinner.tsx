import { useEffect, useState } from 'react'
import { useMediaQuery } from '@/lib/hooks'
import { cn } from '@/lib/utils'

/** Um traço do desenho: o caminho, apontando para cima, e quanto ele gira em volta do centro. */
type Part = { d: string; deg: number }

/**
 * Pétala que sai do centro e termina redonda, apontando para cima: fina na base, larga na ponta.
 * `len` é até onde ela chega, `w` a metade da largura da ponta.
 */
function ray(len: number, w: number): string {
  const tip = -len + w
  return `M0 0C${w * 0.5} -1 ${w} ${tip + w} ${w} ${tip}A${w} ${w} 0 0 0 ${-w} ${tip}C${-w} ${tip + w} ${-w * 0.5} -1 0 0Z`
}

/** `n` pétalas iguais em volta do centro. */
function rays(n: number, len: number, w: number): Part[] {
  const d = ray(len, w)
  return Array.from({ length: n }, (_, i) => ({ d, deg: (360 / n) * i }))
}

/** Estrela de `n` pontas, com raio `outer` nas pontas e `inner` entre elas. */
function star(n: number, outer: number, inner: number): Part[] {
  const pts = Array.from({ length: n * 2 }, (_, i) => {
    const r = i % 2 ? inner : outer
    const a = (Math.PI / n) * i - Math.PI / 2
    return `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`
  })
  return [{ d: `M${pts.join('L')}Z`, deg: 0 }]
}

/**
 * As formas do Claude Code, a estrelinha crescendo e voltando: · ✢ ✳ ✶ ✻ ✽ (o mesmo que o terminal e o
 * VSCode mostram enquanto ele trabalha). Desenhadas aqui em vez de usar os caracteres porque a fonte
 * do celular não tem todos, e o ✳ vira emoji no Android.
 */
const FRAMES: Part[][] = [
  [{ d: 'M-2.2 0a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0 -4.4 0Z', deg: 0 }],
  rays(4, 8, 2.4),
  rays(8, 10, 1.5),
  star(6, 10.5, 4.6),
  rays(6, 10.5, 2.2),
  rays(8, 11, 2.3),
]
/** Vai e volta, repetindo as pontas, como no terminal. */
const CYCLE = [...FRAMES.keys(), ...[...FRAMES.keys()].reverse()]
const STEP_MS = 120
/** Sem animação (preferência do sistema), fica parada no ✻. */
const STILL = 4

/** Indicador de "o Claude está trabalhando": a estrelinha laranja dele, mudando de forma. */
export function ClaudeSpinner({ className }: { className?: string }) {
  const still = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (still) return
    const t = setInterval(() => setStep((s) => (s + 1) % CYCLE.length), STEP_MS)
    return () => clearInterval(t)
  }, [still])

  return (
    <svg viewBox="-12 -12 24 24" className={cn('size-3.5 shrink-0 fill-current text-[#d77757]', className)} aria-hidden>
      {FRAMES[still ? STILL : CYCLE[step]!]!.map((p, i) => (
        <path key={i} d={p.d} transform={p.deg ? `rotate(${p.deg})` : undefined} />
      ))}
    </svg>
  )
}

/** A estrelinha do Claude parada, na cor do texto: a marca dele onde não há trabalho em andamento (ver a alça). */
export function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="-12 -12 24 24" className={cn('shrink-0 fill-current', className)} aria-hidden>
      {FRAMES[FRAMES.length - 1]!.map((p, i) => (
        <path key={i} d={p.d} transform={p.deg ? `rotate(${p.deg})` : undefined} />
      ))}
    </svg>
  )
}
