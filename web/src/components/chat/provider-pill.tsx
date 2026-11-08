import { ChevronDown } from 'lucide-react'
import { ProviderMark } from '@/components/provider-mark'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { AgentProviderInfo } from '@/lib/types'
import { cn } from '@/lib/utils'
import { footerButton } from './composer-controls'

/**
 * O agente da conversa nova, na barra da caixa de mensagem, antes do modelo: quem chama só mostra com
 * mais de um ligado na máquina, começando no padrão. Trocar muda os modelos, o esforço e os modos.
 */
export function ProviderPill({ providers, value, onChange }: { providers: AgentProviderInfo[]; value: string; onChange: (id: string) => void }) {
  const current = providers.find((p) => p.id === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(footerButton, 'min-w-0 max-w-36 shrink')} aria-label={`Agente: ${current?.name ?? value}`} title="Agente da conversa">
          <ProviderMark id={value} className="size-3.5" />
          {/* No celular a barra é estreita: a marca basta, e o nome fica no menu. */}
          <span className="truncate text-foreground/80 max-sm:hidden">{current?.name ?? value}</span>
          <ChevronDown className="size-3 shrink-0 max-sm:hidden" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel>Agente</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {providers.map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.id} className="gap-2">
              <ProviderMark id={p.id} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {p.default && <span className="text-xs text-muted-foreground">padrão</span>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
