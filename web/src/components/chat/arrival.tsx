import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Diz o que chegou depois que a lista já estava na tela: o que já existia quando ela abriu (ou quando
 * `scope`, a conversa, mudou) aparece parado, e só o que chega depois anima a entrada (ver `.chat-enter`).
 */
export function useArrivals(scope: string, keys: string[]): (key: string) => boolean {
  const seen = useRef(new Set<string>())
  const opened = useRef(new Set<string>())
  useEffect(() => {
    if (!keys.length) return
    opened.current.add(scope)
    for (const k of keys) seen.current.add(`${scope}\n${k}`)
  })
  return (key) => opened.current.has(scope) && !seen.current.has(`${scope}\n${key}`)
}

/** Sobe de leve e aparece ao montar, se `fresh`; a decisão vale a vida toda, para não repetir a cada render. */
export function Arrival({
  fresh,
  delay,
  className,
  children,
}: {
  fresh: boolean
  /** Atraso em ms, para entrar depois do que vem antes dele. */
  delay?: number
  className?: string
  children: React.ReactNode
}) {
  const [animate] = useState(fresh)
  return (
    <div className={cn(animate && 'chat-enter', className)} style={animate && delay ? { animationDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  )
}
