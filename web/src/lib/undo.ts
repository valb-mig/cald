import { useEffect, useState } from 'react'

/**
 * O Desfazer do que acabou de ir para uma lixeira, na própria lista e não num aviso: o painel
 * Computador e a folha da barra no celular são modais, e um aviso fica fora deles, sem receber clique.
 * Guarda os ids na lixeira por `ms` e depois esquece.
 */
export function useUndo(ms = 10_000) {
  const [ids, setIds] = useState<string[] | null>(null)
  useEffect(() => {
    if (!ids) return
    const timer = setTimeout(() => setIds(null), ms)
    return () => clearTimeout(timer)
  }, [ids, ms])
  return [ids, setIds] as const
}
