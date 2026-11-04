import { useState } from 'react'
import { projectIconUrl } from '@/lib/api'
import { projectKey } from '@/lib/project-groups'
import { useIconVersions } from '@/lib/project-icons'
import { cn } from '@/lib/utils'
import { workspaceColor } from '@/lib/workspaces'

/** A mesma cor para o mesmo nome, em qualquer aparelho e máquina. */
function colorOf(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) | 0
  return workspaceColor(Math.abs(hash))
}

/** A primeira letra ou número do nome: ".claude" vira "C", "ts.my-film-list", "T". */
const initialOf = (name: string) => (/[\p{L}\p{N}]/u.exec(name)?.[0] ?? '?').toUpperCase()

/**
 * A marca de um projeto, antes do nome dele: a logo escolhida no app (ver ProjectMenu) ou a que o
 * repositório já tem (o servidor procura, ver server/src/project-icon.ts) ou, sem nenhuma, a inicial
 * num quadradinho com a cor do projeto. A inicial fica até a logo chegar, então nada pisca vazio.
 */
export function ProjectMark({ machine, cwd, name, className }: { machine: string; cwd?: string; name: string; className?: string }) {
  const version = useIconVersions((s) => (cwd ? (s[projectKey(machine, cwd)] ?? 0) : 0))
  const src = cwd ? projectIconUrl(machine, cwd, version) : null
  // Pelo endereço: trocar de projeto, de token ou de logo volta a tentar.
  const [loaded, setLoaded] = useState<string | null>(null)
  const [broken, setBroken] = useState<string | null>(null)
  const logo = Boolean(src) && loaded === src
  return (
    <span
      aria-hidden
      className={cn(
        'relative flex size-[18px] shrink-0 items-center justify-center overflow-hidden rounded-[5px] text-[10px] leading-none font-semibold text-white',
        className,
      )}
      style={logo ? undefined : { background: colorOf(name) }}
    >
      {!logo && initialOf(name)}
      {src && broken !== src && (
        <img
          src={src}
          alt=""
          // Na tela de Projetos a lista é longa: só pede a logo de quem aparece.
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(src)}
          onError={() => setBroken(src)}
          className={cn('absolute inset-0 size-full object-contain', !logo && 'opacity-0')}
        />
      )}
    </span>
  )
}
