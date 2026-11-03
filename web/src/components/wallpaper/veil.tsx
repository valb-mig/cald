import { cn } from '@/lib/utils'

/**
 * O véu atrás de uma coluna de texto (a conversa, a inbox), na cor do fundo e com um leve desfoque:
 * puxa a cena de volta para o fundo do app, para o texto ficar legível. Mais largo que a coluna (48rem)
 * para o esfumaçado das laterais cair fora dela, e não atrás das letras. Quem usa passa o `useScrim()`.
 */
export function Veil({ scrim }: { scrim: string }) {
  return (
    <div
      aria-hidden
      // A máscara esfumaça as laterais: sem ela o véu vira um retângulo com borda dura no meio da cena.
      className={cn(
        'pointer-events-none absolute inset-y-0 left-1/2 w-full max-w-[56rem] -translate-x-1/2 backdrop-blur-[1.5px]',
        '[mask-image:linear-gradient(90deg,transparent,#000_7%,#000_93%,transparent)]',
        scrim,
      )}
    />
  )
}
