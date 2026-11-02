import {
  AtSign,
  Ban,
  Check,
  ChevronDown,
  ClipboardList,
  FilePen,
  Hand,
  Minimize2,
  Paperclip,
  Plus,
  ShieldCheck,
  ShieldOff,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Meter, severityOf } from '@/components/pc-status'
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
import { useMachine } from '@/lib/machines'
import type { ContextUsage, ModelOption, RunOptions, SessionSettings } from '@/lib/types'
import { cn } from '@/lib/utils'

// Botões da linha de baixo da caixa, como no VSCode: discretos, só ícone ou texto curto.
export const footerButton =
  'inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted disabled:pointer-events-none disabled:opacity-40'

/** Modos de permissão com os textos do VSCode; `short` é o rótulo do botão. */
export const MODES: Record<string, { label: string; short: string; description: string; icon: LucideIcon }> = {
  default: { label: 'Manual', short: 'Manual', description: 'Pede aprovação antes de cada edição.', icon: Hand },
  acceptEdits: {
    label: 'Editar automaticamente',
    short: 'Editar auto',
    description: 'Edita os arquivos sem pedir aprovação.',
    icon: FilePen,
  },
  plan: { label: 'Plano', short: 'Plano', description: 'Explora o código e apresenta um plano antes de editar.', icon: ClipboardList },
  auto: {
    label: 'Automático',
    short: 'Automático',
    description: 'Aprova o que passa na checagem de segurança e para no que for arriscado.',
    icon: ShieldCheck,
  },
  dontAsk: { label: 'Não perguntar', short: 'Não perguntar', description: 'Nega o que precisaria de aprovação.', icon: Ban },
  bypassPermissions: { label: 'Sem permissões', short: 'Sem permissões', description: 'Não pede aprovação para nada.', icon: ShieldOff },
}
const SELECTABLE_MODES = ['default', 'acceptEdits', 'plan', 'auto']

export const EFFORTS: Record<string, string> = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' }

/** Cor do botão de enviar e da borda em foco por modo, como no VSCode. */
/** Cor de cada modo no botão de enviar e na caixa com foco, que acende em volta na mesma cor. */
export const MODE_TONE: Record<string, { send: string; focus: string }> = {
  default: {
    send: 'bg-[#c6613f] text-[#faf9f5]',
    focus: 'focus-within:border-[#c6613f]/70 focus-within:shadow-[0_0_0_3px_rgb(198_97_63/0.12),0_12px_40px_-14px_rgb(198_97_63/0.5)]',
  },
  acceptEdits: {
    send: 'bg-foreground text-background',
    focus:
      'focus-within:border-foreground/50 focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--foreground)_8%,transparent),0_12px_40px_-16px_color-mix(in_oklab,var(--foreground)_35%,transparent)]',
  },
  plan: {
    send: 'bg-sky-600 text-white',
    focus: 'focus-within:border-sky-500/70 focus-within:shadow-[0_0_0_3px_rgb(14_165_233/0.12),0_12px_40px_-14px_rgb(14_165_233/0.5)]',
  },
  auto: {
    send: 'bg-red-600 text-white',
    focus: 'focus-within:border-red-500/70 focus-within:shadow-[0_0_0_3px_rgb(239_68_68/0.12),0_12px_40px_-14px_rgb(239_68_68/0.5)]',
  },
}

const tokens = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })

// ---- modelos ----

const modelsRequests = new Map<string, Promise<ModelOption[]>>()

/** Lista de modelos da máquina da conversa (uma consulta por máquina por carregamento do app). */
export function useModels(): ModelOption[] | null {
  const machine = useMachine()
  const [models, setModels] = useState<ModelOption[] | null>(null)
  useEffect(() => {
    let request = modelsRequests.get(machine)
    if (!request) modelsRequests.set(machine, (request = api.models(machine)))
    request.then(setModels, () => {
      modelsRequests.delete(machine)
      setModels([])
    })
  }, [machine])
  return models
}

/** "claude-opus-5-5[1m]" → "Opus 5.5 · 1M"; aliases ("opus") só ganham maiúscula. */
export function prettyModel(id?: string): string {
  if (!id) return 'Padrão'
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(id)
  if (!m) return id.charAt(0).toUpperCase() + id.slice(1)
  return `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' · 1M' : ''}`
}

export function findModel(models: ModelOption[] | null, current?: string): ModelOption | undefined {
  const base = current?.replace(/\[1m\]$/, '')
  return models?.find((m) => m.value === current || m.resolvedModel === current || m.resolvedModel === base)
}

const modelName = (m: ModelOption) => (m.value === 'default' ? 'Padrão' : m.displayName)

// ---- contexto ----

/** Quanto do contexto já foi usado até a compactação automática (é essa distância que importa). */
export function compactProgress(c: ContextUsage): number {
  const limit = c.autoCompactEnabled && c.autoCompactThreshold ? c.autoCompactThreshold : c.maxTokens
  return Math.min(100, (c.totalTokens / Math.max(1, limit)) * 100)
}

const RING_TONE = { normal: 'text-sky-500', warning: 'text-[#fab219]', critical: 'text-[#d03b3b]' }

function Ring({ percent }: { percent: number }) {
  const r = 7
  const length = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 20 20" className={cn('size-5 -rotate-90', RING_TONE[severityOf(percent)])} aria-hidden>
      <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth="2.5" />
      <circle
        cx="10"
        cy="10"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${(percent / 100) * length} ${length}`}
      />
    </svg>
  )
}

// ---- componentes ----

export function AddMenu({ onAttach, onMention }: { onAttach: () => void; onMention?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(footerButton, 'px-0')} aria-label="Adicionar">
          <Plus className="size-5" />
        </button>
      </DropdownMenuTrigger>
      {/* Sem devolver o foco ao botão: o campo de mensagem precisa ficar com ele. */}
      <DropdownMenuContent side="top" align="start" className="w-64" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuItem onSelect={onAttach}>
          <Paperclip />
          <div>
            <div>Enviar do celular</div>
            <div className="text-xs text-muted-foreground">Câmera, galeria ou arquivos</div>
          </div>
        </DropdownMenuItem>
        {onMention && (
          <DropdownMenuItem onSelect={() => setTimeout(onMention, 50)}>
            <AtSign />
            <div>
              <div>Adicionar contexto</div>
              <div className="text-xs text-muted-foreground">Arquivo ou pasta do projeto</div>
            </div>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ContextRing({ context, onCompact, disabled }: { context: ContextUsage; onCompact: () => void; disabled: boolean }) {
  const percent = compactProgress(context)
  const auto = context.autoCompactEnabled && context.autoCompactThreshold
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(footerButton, 'px-0')} aria-label={`${Math.round(percent)}% do contexto até compactar`}>
          <Ring percent={percent} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72" onCloseAutoFocus={(e) => e.preventDefault()}>
        <div className="p-2">
          <Meter
            label={auto ? 'Contexto até a compactação automática' : 'Contexto usado'}
            value={`${Math.round(percent)}%`}
            percent={percent}
            detail={
              auto
                ? `${tokens.format(context.totalTokens)} de ${tokens.format(context.autoCompactThreshold!)} tokens · faltam ${tokens.format(Math.max(0, context.autoCompactThreshold! - context.totalTokens))}`
                : `${tokens.format(context.totalTokens)} de ${tokens.format(context.maxTokens)} tokens`
            }
          />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={disabled} onSelect={onCompact}>
          <Minimize2 /> Compactar agora
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ModelPill({
  models,
  settings,
  onChange,
}: {
  models: ModelOption[] | null
  settings: SessionSettings
  onChange: (patch: RunOptions) => void
}) {
  const current = findModel(models, settings.model)
  const label = current ? modelName(current) : prettyModel(settings.model)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(footerButton, 'min-w-0 max-w-36')} disabled={!models?.length}>
          <span className="truncate text-foreground/80">{label}</span>
          {settings.effort && <span className="shrink-0">{EFFORTS[settings.effort] ?? settings.effort}</span>}
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="max-h-80 overflow-y-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel>Modelo</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current?.value ?? ''} onValueChange={(model) => onChange({ model })}>
          {models?.map((m) => (
            <DropdownMenuRadioItem key={m.value} value={m.value}>
              {modelName(m)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ModeMenu({
  settings,
  efforts,
  onChange,
}: {
  settings: SessionSettings
  efforts: string[]
  onChange: (patch: RunOptions) => void
}) {
  const mode = settings.permissionMode ?? 'default'
  const info = MODES[mode] ?? MODES.default!
  const Icon = info.icon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(footerButton, 'min-w-0 max-w-32')} title={info.description}>
          <Icon className="size-4 shrink-0" />
          <span className="truncate">{info.short}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-72" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel>Modos</DropdownMenuLabel>
        {SELECTABLE_MODES.map((key) => {
          const m = MODES[key]!
          const ItemIcon = m.icon
          return (
            <DropdownMenuItem key={key} className="items-start" onSelect={() => onChange({ permissionMode: key as RunOptions['permissionMode'] })}>
              <ItemIcon className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div>{m.label}</div>
                <div className="text-xs text-muted-foreground">{m.description}</div>
              </div>
              {key === mode && <Check className="mt-0.5" />}
            </DropdownMenuItem>
          )
        })}
        {efforts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Esforço</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={settings.effort ?? ''}
              onValueChange={(effort) => onChange({ effort: effort as RunOptions['effort'] })}
            >
              {efforts.map((e) => (
                <DropdownMenuRadioItem key={e} value={e}>
                  {EFFORTS[e] ?? e}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
