import { ChevronDown, Settings2, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { footerButton } from '@/components/chat/composer-controls'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import type { Team, TeamSnapshot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { TeamFaces } from './team-faces'
import { TeamsDialog } from './teams-dialog'

const NONE = '__sem-time__'

/**
 * O time de agentes na barra da caixa de mensagem: "Sem time", os times salvos e o atalho para montar
 * ou editar um. Na conversa nova, o escolhido vai no pedido que a cria; numa que já começou, `current`
 * é o time dela (a cópia de quando foi escolhido, que continua valendo mesmo se o time for apagado) e
 * trocar a retoma com o novo (ver `api.setTeam`). `onShow` abre a lista do time com o que cada um faz.
 */
export function TeamPill({
  machine,
  value,
  current,
  onChange,
  onShow,
  className,
}: {
  machine: string
  value?: string
  current?: TeamSnapshot
  onChange: (teamId: string | undefined) => void
  onShow?: () => void
  className?: string
}) {
  const [teams, setTeams] = useState<Team[]>([])
  const [managing, setManaging] = useState(false)
  useEffect(() => {
    // Servidor antigo, sem times: o botão só oferece montar um (e o PC avisa que precisa atualizar).
    api.teams(machine).then(setTeams, () => setTeams([]))
  }, [machine])
  const chosen = current ?? teams.find((t) => t.id === value)
  // Na conversa nova, o time escolhido foi apagado no diálogo: ela volta a não ter time.
  useEffect(() => {
    if (!current && value && teams.length && !teams.some((t) => t.id === value)) onChange(undefined)
  }, [current, value, teams, onChange])

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(footerButton, 'min-w-0 max-w-40', className)}
            aria-label={chosen ? `Time: ${chosen.name}` : 'Escolher um time de agentes'}
            title="Time de agentes"
          >
            {chosen ? <TeamFaces team={chosen} size={16} /> : <Users className="size-4 shrink-0" />}
            {/* No celular a barra é estreita: os claudinhos bastam, e o nome fica no menu. */}
            {chosen && <span className="truncate text-foreground/80 max-sm:hidden">{chosen.name}</span>}
            <ChevronDown className="size-3 shrink-0 max-sm:hidden" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-64" onCloseAutoFocus={(e) => e.preventDefault()}>
          {onShow && chosen && (
            <>
              <DropdownMenuItem onSelect={onShow}>
                <Users /> Ver o time
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuLabel>{current ? 'Trocar o time' : 'Time de agentes'}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={chosen?.id ?? NONE} onValueChange={(v) => onChange(v === NONE ? undefined : v)}>
            <DropdownMenuRadioItem value={NONE}>Sem time</DropdownMenuRadioItem>
            {teams.map((t) => (
              <DropdownMenuRadioItem key={t.id} value={t.id} className="gap-2">
                <TeamFaces team={t} size={16} />
                <span className="truncate">{t.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setManaging(true)}>
            <Settings2 /> {teams.length ? 'Gerenciar times…' : 'Montar um time…'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TeamsDialog machine={machine} open={managing} onOpenChange={setManaging} onChange={setTeams} onSaved={(t) => onChange(t.id)} />
    </>
  )
}
