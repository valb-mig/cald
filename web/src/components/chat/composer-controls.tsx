import {
  Ban,
  Check,
  ChevronDown,
  ClipboardList,
  FilePen,
  Hand,
  Minimize2,
  Paperclip,
  Shield,
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
import { CLAUDE_MODES, currentMode } from '@/lib/providers'
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

/** Um modo que o app não conhece (de outro agente): o nome que o agente dá, sem descrição. */
const modeInfo = (key: string) => MODES[key] ?? { label: key, short: key, description: '', icon: Shield }

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

/**
 * Lista de modelos de um agente na máquina da conversa (uma consulta por agente e máquina por
 * carregamento do app). Sem `provider`, os do agente padrão da máquina.
 */
export function useModels(provider?: string): ModelOption[] | null {
  const machine = useMachine()
  const key = `${machine}\n${provider ?? ''}`
  const [models, setModels] = useState<{ key: string; list: ModelOption[] } | null>(null)
  useEffect(() => {
    let alive = true
    let request = modelsRequests.get(key)
    if (!request) modelsRequests.set(key, (request = api.models(machine, provider)))
    request.then(
      (list) => alive && setModels({ key, list }),
      () => {
        modelsRequests.delete(key)
        if (alive) setModels({ key, list: [] })
      },
    )
    return () => {
      alive = false
    }
  }, [key, machine, provider])
  // Trocou de agente: a lista do anterior não vale enquanto a nova não chega.
  return models?.key === key ? models.list : null
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

/**
 * Anexar: abre direto o seletor de arquivos do sistema (no celular, câmera, galeria ou arquivos). Um
 * arquivo ou pasta do projeto entra digitando "@" no texto.
 */
export function AttachButton({ onAttach }: { onAttach: () => void }) {
  return (
    <button type="button" className={cn(footerButton, 'px-0')} onClick={onAttach} aria-label="Anexar arquivos" title="Anexar arquivos">
      <Paperclip className="size-4" />
    </button>
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

/** `effort`: o agente tem níveis de esforço; sem eles, o seletor é só do modelo. */
export function ModelPill({
  models,
  settings,
  effort = true,
  onChange,
}: {
  models: ModelOption[] | null
  settings: SessionSettings
  effort?: boolean
  onChange: (patch: RunOptions) => void
}) {
  const current = findModel(models, settings.model)
  const label = current ? modelName(current) : prettyModel(settings.model)
  const efforts = effort ? (current?.efforts ?? []) : []
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(footerButton, 'min-w-0 max-w-36 shrink')} disabled={!models?.length}>
          <span className="truncate text-foreground/80">{label}</span>
          {effort && settings.effort && <span className="shrink-0">{EFFORTS[settings.effort] ?? settings.effort}</span>}
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      {/* O esforço fica no alto, fora da rolagem: a lista de modelos é que rola embaixo dele. */}
      <DropdownMenuContent side="top" align="start" className="w-72" onCloseAutoFocus={(e) => e.preventDefault()}>
        {efforts.length > 0 && (
          <>
            <EffortBar
              efforts={efforts}
              value={settings.effort}
              model={label}
              onChange={(effort) => onChange({ effort: effort as RunOptions['effort'] })}
            />
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Modelo</DropdownMenuLabel>
        <div className="max-h-64 overflow-y-auto">
          <DropdownMenuRadioGroup value={current?.value ?? ''} onValueChange={(model) => onChange({ model })}>
            {models?.map((m) => (
              <DropdownMenuRadioItem key={m.value} value={m.value}>
                {modelName(m)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** `modes`: os que o agente aceita, na ordem dele (ver lib/providers.ts); os conhecidos levam os textos do VSCode. */
export function ModeMenu({
  settings,
  modes = CLAUDE_MODES,
  onChange,
}: {
  settings: SessionSettings
  modes?: string[]
  onChange: (patch: RunOptions) => void
}) {
  const mode = currentMode(settings, modes)
  const info = modeInfo(mode)
  const Icon = info.icon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(footerButton, 'min-w-0 max-w-32 shrink')} title={info.description || info.label}>
          <Icon className="size-4 shrink-0" />
          <span className="truncate @max-[21rem]:hidden">{info.short}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-72" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel>Modos</DropdownMenuLabel>
        {modes.map((key) => {
          const m = modeInfo(key)
          const ItemIcon = m.icon
          return (
            <DropdownMenuItem key={key} className="items-start" onSelect={() => onChange({ permissionMode: key })}>
              <ItemIcon className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div>{m.label}</div>
                {m.description && <div className="text-xs text-muted-foreground">{m.description}</div>}
              </div>
              {key === mode && <Check className="mt-0.5" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Desliza com um leve passo além da parada e volta, como uma mola.
const SPRING = 'duration-300 ease-[cubic-bezier(0.34,1.4,0.64,1)] motion-reduce:transition-none'

/**
 * A cor de cada nível, do começo ao fim do degradê: esfria no baixo e esquenta até o roxo e o rosa no
 * máximo. É a única cor da barra, e diz o estado (quanto o Claude vai pensar), como no resto do app.
 */
const EFFORT_TONE: Record<string, [string, string]> = {
  low: ['#64748b', '#94a3b8'],
  medium: ['#0284c7', '#38bdf8'],
  high: ['#4f46e5', '#818cf8'],
  xhigh: ['#6d28d9', '#c084fc'],
  max: ['#a21caf', '#f472b6'],
}

/** Os brilhos dentro do preenchimento, espalhados sempre do mesmo jeito; mais esforço acende mais deles. */
const SPARKS = Array.from({ length: 20 }, (_, i) => ({
  x: (i * 37) % 100,
  y: 18 + ((i * 53) % 64),
  delay: -((i * 0.37) % 2),
  size: i % 3 === 0 ? 3 : 2,
}))

// O pino (24 px) anda dentro da faixa com 2 px de folga: o centro dele vai de 14 px até a largura menos 14 px.
const THUMB_INSET = 14
const stop = (i: number, last: number) => `calc(${THUMB_INSET}px + (100% - ${THUMB_INSET * 2}px) * ${i / Math.max(1, last)})`

/**
 * O esforço numa barra como a do ChatGPT, no alto do seletor de modelo: o nome do nível e o modelo em
 * cima, e uma faixa com uma parada por nível. O preenchimento é um degradê na cor do nível, com brilhos
 * correndo e um reflexo passando, mais rápidos quanto mais esforço; a cor muda deslizando. Clicar ou
 * arrastar escolhe, e o pino desliza até a parada; pelo teclado, as setas para os lados. O menu fica
 * aberto, para dar para ir e voltar.
 */
export function EffortBar({
  efforts,
  value,
  model,
  onChange,
}: {
  efforts: string[]
  value: string | null | undefined
  model: string
  onChange: (effort: string) => void
}) {
  // Enquanto arrasta, só a barra acompanha; o nível vai para a sessão ao soltar.
  const [drag, setDrag] = useState<number | null>(null)
  // O pedido vale na barra até a sessão responder com o ajuste novo, para o pino não voltar no meio.
  const [asked, setAsked] = useState<{ effort: string; over: string | null | undefined } | null>(null)
  const current = asked && asked.over === value ? asked.effort : value
  const index = drag ?? (current ? efforts.indexOf(current) : -1)
  const last = efforts.length - 1
  const level = index < 0 ? null : efforts[index]!
  const label = level ? (EFFORTS[level] ?? level) : 'Padrão'
  const [from, to] = (level && EFFORT_TONE[level]) || EFFORT_TONE.high!
  // De 0 (o mais baixo) a 1 (o mais alto): quantos brilhos e quão rápido eles correm.
  const heat = index < 0 ? 0 : index / Math.max(1, last)

  const pick = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const span = Math.max(1, r.width - THUMB_INSET * 2)
    return Math.round(Math.min(1, Math.max(0, (e.clientX - r.left - THUMB_INSET) / span)) * last)
  }
  const choose = (i: number) => {
    const effort = efforts[Math.min(last, Math.max(0, i))]!
    if (effort === current) return
    setAsked({ effort, over: value })
    onChange(effort)
  }

  return (
    <DropdownMenuItem
      aria-label={`Esforço: ${label}`}
      className="flex-col items-stretch gap-2.5 px-2 pt-2 pb-2.5 transition-[--fx-from,--fx-to] duration-500 focus:bg-transparent"
      style={{ '--fx-from': from, '--fx-to': to } as React.CSSProperties}
      onSelect={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        choose(index < 0 ? 0 : index + (e.key === 'ArrowRight' ? 1 : -1))
      }}
    >
      <div className="text-center leading-tight">
        {/* A chave refaz a entrada a cada nível, e o nome novo sobe no lugar do antigo. */}
        <div
          key={label}
          className={cn(
            'animate-in text-sm font-semibold duration-200 fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none',
            // Com `!`: o item do menu em foco pinta todos os filhos com a cor dele, e o nome perderia o tom do nível.
            level ? 'text-(--fx-from)! dark:text-(--fx-to)!' : 'text-muted-foreground!',
          )}
        >
          {label}
        </div>
        <div className="truncate text-xs text-muted-foreground!">{model}</div>
      </div>
      <div
        className="relative h-7 cursor-pointer touch-none rounded-full bg-foreground/[0.07]"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setDrag(pick(e))
        }}
        onPointerMove={(e) => drag !== null && setDrag(pick(e))}
        onPointerUp={() => {
          if (drag === null) return
          choose(drag)
          setDrag(null)
        }}
        onPointerCancel={() => setDrag(null)}
      >
        {/* As paradas, apagadas na faixa vazia; o preenchimento passa por cima delas. */}
        {efforts.map((e, i) => (
          <span key={e} className="absolute top-1/2 size-1 -translate-1/2 rounded-full bg-foreground/25" style={{ left: stop(i, last) }} />
        ))}
        <span
          className={cn(
            'absolute inset-y-0 left-0 overflow-hidden rounded-full bg-linear-to-r from-(--fx-from) to-(--fx-to) transition-[width,opacity]',
            SPRING,
            index < 0 && 'opacity-0',
          )}
          style={{ width: index < 0 ? 0 : `calc(${stop(index, last)} + ${THUMB_INSET}px)` }}
        >
          <span className="effort-shimmer absolute inset-0" style={{ animationDuration: `${3.2 - heat * 1.6}s` }} />
          {SPARKS.slice(0, 6 + Math.round(heat * 14)).map((p, i) => (
            <span
              key={i}
              className="effort-spark absolute rounded-full bg-white"
              style={{
                left: `${p.x}%`,
                top: `${p.y}%`,
                width: p.size,
                height: p.size,
                animationDelay: `${p.delay}s`,
                animationDuration: `${2.4 - heat * 1.1}s`,
              }}
            />
          ))}
        </span>
        <span
          className={cn(
            'absolute top-1/2 size-6 -translate-1/2 rounded-full bg-white shadow-[0_1px_6px_rgb(0_0_0/0.35)] ring-ring/50 transition-[left,scale,opacity]',
            'group-focus-visible/dropdown-menu-item:ring-[3px]',
            SPRING,
            drag !== null && 'scale-110',
            index < 0 && 'scale-50 opacity-0',
          )}
          style={{ left: stop(Math.max(0, index), last) }}
        />
      </div>
    </DropdownMenuItem>
  )
}
