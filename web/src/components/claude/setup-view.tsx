import { Bot, KeyRound, Loader2, Plug, RefreshCw, RotateCcw, Slash, Sparkles, Trash2, TriangleAlert, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Markdown } from '@/components/markdown'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { api, errorMessage } from '@/lib/api'
import { emptyClaudeTrash, loadSetup, restoreClaude, toggleMcp, togglePlugin, toggleSkill, trashClaude, useClaudeSetup } from '@/lib/claude-setup'
import { placeName, relativeTime } from '@/lib/format'
import type { ClaudeItem, ClaudeItemSource, ClaudeSetup, ClaudeTrashed, McpScope, McpServer, McpStatus, PluginInfo } from '@/lib/types'
import { useUndo } from '@/lib/undo'
import { cn } from '@/lib/utils'
import { Chip, Chips, Fold, SearchField, Tag, UndoBar } from './bits'

/**
 * O que o Claude Code carrega numa pasta (ver lib/claude-setup.ts): sem `cwd`, o que vale em todo
 * projeto (o painel Computador); com, o de um projeto. Dá para ligar e
 * desligar e mandar para a lixeira do edit.r o que é seu ou do projeto.
 */
type Props = { machine: string; cwd?: string }

const SOURCES: { key: ClaudeItemSource; label: string; open: boolean }[] = [
  { key: 'project', label: 'Deste projeto', open: true },
  { key: 'user', label: 'Suas', open: true },
  { key: 'claude.ai', label: 'Da sua conta no claude.ai', open: false },
  { key: 'plugin', label: 'De plugins', open: false },
  { key: 'builtin', label: 'Do próprio Claude Code', open: false },
]

/** O texto de uma skill ou agente sem o cabeçalho: o nome e a descrição já aparecem em volta. */
const withoutFrontmatter = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n+/, '')

const KIND: Record<ClaudeTrashed['kind'], { label: string; icon: typeof Bot }> = {
  skill: { label: 'Skill', icon: Sparkles },
  command: { label: 'Comando', icon: Slash },
  agent: { label: 'Agente', icon: Bot },
  mcp: { label: 'Servidor MCP', icon: Plug },
}

/** O topo das duas telas: quando o Claude Code foi consultado e o botão de consultar de novo. */
function Freshness({ machine, cwd, setup, loading }: Props & { setup?: ClaudeSetup; loading?: boolean }) {
  return (
    <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">
        {loading ? 'Perguntando ao Claude Code…' : setup ? `Lido do Claude Code ${relativeTime(setup.at)}` : ''}
      </span>
      <Button variant="ghost" size="xs" disabled={loading} onClick={() => void loadSetup(machine, cwd, true)} title="Consultar o Claude Code de novo">
        <RefreshCw className={cn(loading && 'animate-spin')} /> Atualizar
      </Button>
    </div>
  )
}

function Waiting({ error }: { error?: string }) {
  return error ? (
    <p className="p-4 text-center text-sm text-muted-foreground">{error}</p>
  ) : (
    <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
      Subindo um Claude Code para ver o que ele carrega. Leva alguns segundos.
    </div>
  )
}

/** O botão da lixeira de uma linha: discreto, aparece por inteiro ao passar o mouse (no toque, sempre). */
function TrashButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="text-muted-foreground opacity-60 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100 pointer-coarse:opacity-100"
    >
      <Trash2 />
    </Button>
  )
}

/** O que acabou de ir para a lixeira: o Desfazer no pé da lista. */
function useTrash(machine: string, cwd?: string) {
  const [undo, setUndo] = useUndo()
  const send = async (what: Parameters<typeof trashClaude>[2]) => {
    const id = await trashClaude(machine, cwd, what)
    if (id) setUndo([id])
  }
  const bar = undo && (
    <UndoBar
      text="Na lixeira do edit.r"
      onUndo={() => {
        void restoreClaude(machine, cwd, undo)
        setUndo(null)
      }}
    />
  )
  return { send, bar }
}

export function SkillsView({ machine, cwd }: Props) {
  const { setup, error, loading } = useClaudeSetup(machine, cwd)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<ClaudeItem['kind'] | null>(null)
  const [mentions, setMentions] = useState(false)
  const [off, setOff] = useState(false)
  const trash = useTrash(machine, cwd)

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (setup?.items ?? []).filter(
      (i) =>
        (!kind || i.kind === kind) &&
        (!mentions || i.mentions.length > 0) &&
        (!off || !i.enabled) &&
        (!q || [i.name, i.description, i.plugin ?? ''].some((t) => t.toLowerCase().includes(q))),
    )
  }, [setup, query, kind, mentions, off])

  if (!setup) return <Waiting error={error} />

  // Skills ligadas que falam de um servidor que não está ligado aqui: por isso o Claude cita coisas que ele não tem.
  const missing = setup.items.filter((i) => i.enabled && i.mentions.some((m) => !m.here))
  const kinds = (['skill', 'command', 'agent'] as const).filter((k) => setup.items.some((i) => i.kind === k))
  const disabled = setup.items.filter((i) => !i.enabled).length
  const filtering = Boolean(query.trim() || kind || mentions || off)
  const itemTrash = setup.trash.filter((t) => t.kind !== 'mcp')

  return (
    <div className="space-y-3">
      <Freshness machine={machine} cwd={cwd} setup={setup} loading={loading} />
      {missing.length > 0 && (
        <div className="flex gap-2.5 rounded-xl bg-amber-500/10 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <p>
            {missing.length === 1 ? 'Uma skill cita' : `${missing.length} skills citam`} um servidor MCP que{' '}
            {cwd ? 'não está ligado neste projeto' : 'não vale em todo projeto'} ({[...new Set(missing.flatMap((i) => i.mentions.filter((m) => !m.here).map((m) => m.name)))].join(', ')}):{' '}
            {missing.map((i) => i.name).join(', ')}. É daí que o Claude fala de coisas que ele não tem {cwd ? 'aqui' : 'na maioria das pastas'}.
          </p>
        </div>
      )}
      <div className="space-y-2">
        <SearchField value={query} onChange={setQuery} placeholder="Buscar skill, comando ou agente" />
        <Chips>
          {kinds.map((k) => (
            <Chip key={k} on={kind === k} onClick={() => setKind(kind === k ? null : k)} label={`${KIND[k].label}s`} count={setup.items.filter((i) => i.kind === k).length} />
          ))}
          {setup.items.some((i) => i.mentions.length) && (
            <Chip on={mentions} onClick={() => setMentions(!mentions)} label="Citam MCP" count={setup.items.filter((i) => i.mentions.length).length} />
          )}
          {disabled > 0 && <Chip on={off} onClick={() => setOff(!off)} label="Desligadas" count={disabled} />}
        </Chips>
      </div>
      <p className="px-1 text-xs text-muted-foreground">
        {cwd
          ? 'Desligar aqui vale só neste projeto (no .claude/settings.local.json dele).'
          : 'Desligar aqui vale em todo projeto (nas suas configurações do Claude Code).'}
      </p>
      <div className="space-y-2">
        {SOURCES.map((s) => {
          if (s.key === 'plugin') return <PluginGroups key="plugin" items={items.filter((i) => i.source === 'plugin')} plugins={setup.plugins} filtering={filtering} machine={machine} cwd={cwd} onTrash={trash.send} />
          const list = items.filter((i) => i.source === s.key)
          return list.length ? (
            <SourceGroup key={s.key} label={s.label} items={list} defaultOpen={s.open} forceOpen={filtering} machine={machine} cwd={cwd} onTrash={trash.send} />
          ) : null
        })}
        {items.length === 0 && <p className="px-1 py-4 text-sm text-muted-foreground">Nada com esse filtro.</p>}
      </div>
      {itemTrash.length > 0 && <ClaudeTrash machine={machine} cwd={cwd} items={itemTrash} />}
      {trash.bar}
    </div>
  )
}

type TrashFn = (what: Parameters<typeof trashClaude>[2]) => Promise<void>

/** `forceOpen`: com filtro, o grupo abre, porque é o que foi achado. */
function SourceGroup({
  label,
  items,
  defaultOpen,
  forceOpen,
  aside,
  machine,
  cwd,
  onTrash,
}: Props & { label: React.ReactNode; items: ClaudeItem[]; defaultOpen: boolean; forceOpen: boolean; aside?: React.ReactNode; onTrash: TrashFn }) {
  const [open, setOpen] = useState(defaultOpen)
  const sorted = [...items].sort((a, b) => Number(a.kind === 'agent') - Number(b.kind === 'agent') || a.name.localeCompare(b.name))
  return (
    <Fold open={open || forceOpen} onOpenChange={setOpen} title={label} count={items.length} aside={aside}>
      {sorted.map((i) => (
        <ItemRow key={`${i.kind}:${i.name}`} item={i} machine={machine} cwd={cwd} onTrash={onTrash} />
      ))}
    </Fold>
  )
}

/**
 * Os de plugin, um grupo por plugin: skill de plugin não desliga sozinha no Claude Code, então o
 * botão é o do plugin inteiro (com os agentes e os servidores MCP dele), e vale em todo projeto.
 */
function PluginGroups({ items, plugins, filtering, machine, cwd, onTrash }: Props & { items: ClaudeItem[]; plugins: PluginInfo[]; filtering: boolean; onTrash: TrashFn }) {
  const shown = plugins.filter((p) => items.some((i) => i.plugin === p.name) || (!filtering && !p.enabled))
  const loose = items.filter((i) => !plugins.some((p) => p.name === i.plugin))
  if (!shown.length && !loose.length) return null
  return (
    <>
      {shown.map((p) => (
        <SourceGroup
          key={p.key}
          label={
            <span className="flex items-center gap-1.5">
              Plugin {p.name}
              {!p.enabled && <Tag>desligado</Tag>}
            </span>
          }
          items={items.filter((i) => i.plugin === p.name)}
          defaultOpen={false}
          forceOpen={filtering}
          aside={
            <Switch
              checked={p.enabled}
              onCheckedChange={(on) => void togglePlugin(machine, cwd, p.key, on)}
              aria-label={p.enabled ? `Desligar o plugin ${p.name}` : `Ligar o plugin ${p.name}`}
              title={`${p.enabled ? 'Desligar' : 'Ligar'} o plugin inteiro, em todo projeto`}
              className="mr-1"
            />
          }
          machine={machine}
          cwd={cwd}
          onTrash={onTrash}
        />
      ))}
      {loose.length > 0 && <SourceGroup label="De plugins" items={loose} defaultOpen={false} forceOpen={filtering} machine={machine} cwd={cwd} onTrash={onTrash} />}
    </>
  )
}

function ItemRow({ item: i, machine, cwd, onTrash }: Props & { item: ClaudeItem; onTrash: TrashFn }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const Icon = KIND[i.kind].icon
  useEffect(() => {
    if (!open || !i.path || text !== null) return
    api.claudeText(machine, i.path, cwd).then(
      (r) => setText(withoutFrontmatter(r.text)),
      (err) => setError(errorMessage(err)),
    )
  }, [open, i.path, text, machine, cwd])
  const where = cwd ? 'neste projeto' : 'em todo projeto'
  return (
    <div className={cn('group rounded-xl px-2.5 py-2 transition-colors hover:bg-foreground/[0.04]', open && 'bg-foreground/[0.04]')}>
      <div className="flex min-w-0 items-start gap-2">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
          <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label={KIND[i.kind].label} />
          <span className={cn('min-w-0 flex-1', !i.enabled && 'opacity-55')}>
            <span className="block font-mono text-[12.5px] leading-snug break-all">{i.name}</span>
            {i.description && <span className={cn('mt-0.5 block text-xs text-muted-foreground', !open && 'line-clamp-2')}>{i.description}</span>}
            {(i.mentions.length > 0 || i.model || !i.enabled) && (
              <span className="mt-1 flex flex-wrap gap-1">
                {!i.enabled && <Tag>desligada</Tag>}
                {i.mentions.map((m) => (
                  <Tag
                    key={m.name}
                    tone={m.here || !i.enabled ? 'muted' : 'warn'}
                    title={m.here ? 'Esse servidor está ligado aqui.' : 'Esse servidor não está ligado aqui: a skill fala dele, mas o Claude não tem como usá-lo.'}
                  >
                    cita MCP {m.name}
                    {!m.here && ' · desligado aqui'}
                  </Tag>
                ))}
                {i.model && <Tag>modelo {i.model}</Tag>}
              </span>
            )}
          </span>
        </button>
        {i.canTrash && i.path && <TrashButton label={`Mandar ${i.name} para a lixeira`} onClick={() => void onTrash({ path: i.path! })} />}
        {i.canToggle && (
          <Switch
            checked={i.enabled}
            onCheckedChange={(on) => void toggleSkill(machine, cwd, i.name, on)}
            aria-label={`${i.enabled ? 'Desligar' : 'Ligar'} ${i.name} ${where}`}
            title={`${i.enabled ? 'Desligar' : 'Ligar'} ${where}`}
          />
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-2 pl-6">
          {i.path ? (
            <>
              <p className="font-mono text-[11px] break-all text-muted-foreground">{i.path}</p>
              {error ? (
                <p className="text-xs text-muted-foreground">{error}</p>
              ) : text === null ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <div className="max-h-96 overflow-y-auto rounded-lg bg-background/60 px-3 py-2">
                  <Markdown text={text} className="text-[13px]" />
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {i.source === 'builtin' ? 'Vem com o Claude Code; não tem arquivo seu.' : 'O arquivo não foi achado no disco.'}
            </p>
          )}
          {i.source === 'claude.ai' && <p className="text-xs text-muted-foreground">Vem sincronizada da sua conta: para tirar de vez, apague no claude.ai.</p>}
          {i.kind === 'agent' && !i.canTrash && i.source !== 'builtin' && <p className="text-xs text-muted-foreground">Agentes não têm como desligar no Claude Code.</p>}
        </div>
      )}
    </div>
  )
}

/** A lixeira do edit.r para skills e servidores: o que saiu daqui volta igual; some sozinho depois de 30 dias. */
function ClaudeTrash({ machine, cwd, items }: Props & { items: ClaudeTrashed[] }) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  return (
    <>
      <Fold
        open={open}
        onOpenChange={setOpen}
        title="Lixeira"
        count={items.length}
        aside={
          <Button variant="ghost" size="xs" onClick={() => setConfirm(true)} className="text-muted-foreground hover:text-destructive">
            Esvaziar
          </Button>
        }
      >
        {items.map((t) => {
          const Icon = KIND[t.kind].icon
          return (
            <div key={t.id} className="flex min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-2 hover:bg-foreground/[0.04]">
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12.5px] text-muted-foreground line-through decoration-muted-foreground/40">{t.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {KIND[t.kind].label} · {t.project ? placeName(t.project) : 'seu'} · {relativeTime(t.deletedAt)}
                </div>
              </div>
              <Button variant="ghost" size="xs" onClick={() => void restoreClaude(machine, cwd, [t.id])}>
                <RotateCcw /> Restaurar
              </Button>
            </div>
          )
        })}
      </Fold>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Esvaziar a lixeira?</AlertDialogTitle>
            <AlertDialogDescription>
              {items.length === 1 ? 'O item na lixeira é apagado' : `Os ${items.length} itens na lixeira são apagados`} de vez. Não dá para desfazer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                void emptyClaudeTrash(
                  machine,
                  cwd,
                  items.map((t) => t.id),
                )
              }
            >
              Esvaziar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

const STATUS: Record<McpStatus, { label: string; dot: string }> = {
  connected: { label: 'Conectado', dot: 'bg-emerald-500' },
  failed: { label: 'Falhou', dot: 'bg-red-500' },
  'needs-auth': { label: 'Precisa autorizar', dot: 'bg-amber-500' },
  pending: { label: 'Conectando…', dot: 'bg-amber-500 animate-pulse' },
  disabled: { label: 'Desligado', dot: 'bg-zinc-400' },
}

const SCOPES: Record<string, string> = {
  user: 'Seu, em todo projeto',
  project: 'Do projeto (.mcp.json)',
  local: 'Só nesta pasta',
  claudeai: 'Da sua conta no claude.ai',
  dynamic: 'De um plugin',
  plugin: 'De um plugin',
  managed: 'Da organização',
  enterprise: 'Da organização',
}

export function McpView({ machine, cwd }: Props) {
  const { setup, error, loading } = useClaudeSetup(machine, cwd)
  const trash = useTrash(machine, cwd)
  if (!setup) return <Waiting error={error} />
  const serverTrash = setup.trash.filter((t) => t.kind === 'mcp')
  return (
    <div className="space-y-3">
      <Freshness machine={machine} cwd={cwd} setup={setup} loading={loading} />
      {setup.mcp.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted-foreground">Nenhum servidor MCP {cwd ? 'neste projeto' : 'que valha em todo projeto'}.</p>
      ) : (
        <div className="space-y-0.5">
          {setup.mcp.map((s) => (
            <ServerRow key={s.name} server={s} setup={setup} machine={machine} cwd={cwd} onTrash={trash.send} />
          ))}
        </div>
      )}
      <p className="px-1 text-xs text-muted-foreground">
        {cwd
          ? 'O botão liga e desliga só neste projeto. A lixeira tira a configuração do servidor (a deste projeto), e ela volta igual pela lixeira.'
          : 'O Claude Code só desliga servidor por pasta: aqui, o botão vale para os de plugin (o plugin inteiro) e para os da pasta pessoal. Os outros, desligue numa conversa do projeto (/mcp) ou mande para a lixeira.'}
      </p>
      {setup.elsewhere.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="px-1 text-xs font-medium text-muted-foreground">Ligados só em outras pastas</h3>
          <div className="space-y-0.5">
            {setup.elsewhere.map((e) => (
              <div key={`${e.scope}:${e.name}`} className="flex min-w-0 items-start gap-2.5 rounded-xl px-2.5 py-2">
                <Plug className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[12.5px]">{e.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    {e.scope === 'local' ? 'Só em' : 'No .mcp.json de'}
                    {e.projects.map((p) => (
                      <span key={p} title={p} className="group inline-flex items-center gap-0.5 rounded bg-foreground/[0.06] py-0.5 pr-0.5 pl-1.5">
                        {placeName(p)}
                        <button
                          type="button"
                          onClick={() => void trash.send({ mcp: { name: e.name, scope: e.scope, project: p } })}
                          aria-label={`Tirar ${e.name} de ${placeName(p)} (vai para a lixeira)`}
                          title="Tirar daqui (vai para a lixeira)"
                          className="rounded p-0.5 opacity-60 hover:bg-foreground/10 hover:text-destructive hover:opacity-100"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {serverTrash.length > 0 && <ClaudeTrash machine={machine} cwd={cwd} items={serverTrash} />}
      {trash.bar}
    </div>
  )
}

/**
 * O que o botão e a lixeira fazem depende de onde o servidor vem e de onde a lista está:
 * - na barra do projeto, o botão é o do Claude Code, por pasta; com o plugin desligado, é o do plugin;
 * - no Computador, só os de plugin (o plugin inteiro) e os da pasta pessoal têm botão;
 * - a lixeira tira a configuração: a sua (Computador), a da pasta pessoal, a deste projeto.
 */
function ServerRow({ server: s, setup, machine, cwd, onTrash }: Props & { server: McpServer; setup: ClaudeSetup; onTrash: TrashFn }) {
  const [open, setOpen] = useState(false)
  const status = STATUS[s.status]
  const plugin = s.plugin ? setup.plugins.find((p) => p.key === s.plugin) : undefined
  const byPlugin = Boolean(plugin && (!cwd || !plugin.enabled))
  const canToggle = byPlugin || Boolean(cwd) || s.scope === 'local'
  const trashScope: McpScope | null =
    s.scope === 'local' ? 'local' : s.scope === 'project' && cwd ? 'project' : s.scope === 'user' && !cwd ? 'user' : null
  const authHint = s.scope === 'claudeai' ? 'Autorize nos conectores do claude.ai.' : 'Autorize num terminal: /mcp numa conversa do Claude Code.'
  const toggle = (on: boolean) => (byPlugin && plugin ? togglePlugin(machine, cwd, plugin.key, on) : toggleMcp(machine, cwd, s.name, on))
  const what = byPlugin ? `o plugin ${plugin?.name} inteiro, em todo projeto` : cwd ? 'neste projeto' : 'na pasta pessoal'
  return (
    <div className={cn('group rounded-xl px-2.5 py-2 transition-colors hover:bg-foreground/[0.04]', open && 'bg-foreground/[0.04]')}>
      <div className="flex min-w-0 items-start gap-2">
        <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', status.dot)} title={status.label} />
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="min-w-0 flex-1 text-left">
          <span className="block font-mono text-[12.5px] leading-snug break-all">{s.name}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1">
            <Tag tone={s.status === 'connected' ? 'ok' : s.status === 'failed' ? 'bad' : s.status === 'needs-auth' ? 'warn' : 'muted'}>{status.label}</Tag>
            {s.scope && <Tag>{s.scope === 'local' && !cwd ? 'Só na pasta pessoal' : (SCOPES[s.scope] ?? s.scope)}</Tag>}
            {s.tools.length > 0 && <span className="text-[11px] text-muted-foreground">{s.tools.length} ferramentas</span>}
          </span>
          {s.status === 'failed' && s.error && (
            <span className={cn('mt-1 block text-xs break-all text-red-700 dark:text-red-400', !open && 'line-clamp-2')}>{s.error}</span>
          )}
          {s.status === 'needs-auth' && <span className="mt-1 block text-xs text-muted-foreground">{authHint}</span>}
          {!canToggle && s.scope === 'claudeai' && <span className="mt-1 block text-xs text-muted-foreground">Em todo projeto, ligue e desligue nos conectores do claude.ai.</span>}
        </button>
        {trashScope && (
          <TrashButton
            label={`Tirar a configuração de ${s.name} (vai para a lixeira)`}
            onClick={() => void onTrash({ mcp: { name: s.name, scope: trashScope, ...(trashScope === 'user' ? {} : { project: cwd ?? setup.cwd }) } })}
          />
        )}
        {canToggle && (
          <Switch
            checked={byPlugin ? Boolean(plugin?.enabled) : s.status !== 'disabled'}
            disabled={s.status === 'pending'}
            onCheckedChange={(on) => void toggle(on)}
            aria-label={`${s.status === 'disabled' ? 'Ligar' : 'Desligar'} ${s.name}: ${what}`}
            title={`${s.status === 'disabled' ? 'Ligar' : 'Desligar'} ${what}`}
          />
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-2 pl-4.5">
          {s.target && (
            <p className="font-mono text-[11px] break-all text-muted-foreground">
              {s.transport && <span className="mr-1.5 uppercase">{s.transport}</span>}
              {s.target}
            </p>
          )}
          {s.secrets.length > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Os valores ficam no PC">
              <KeyRound className="size-3.5" /> Usa {s.secrets.join(', ')}
            </p>
          )}
          {s.tools.length > 0 && (
            <ul className="space-y-1">
              {s.tools.map((t) => (
                <li key={t.name} className="text-xs">
                  <span className="font-mono">{t.name}</span>
                  {t.description && <span className="line-clamp-2 text-muted-foreground">{t.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
