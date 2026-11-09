import { Brain, Footprints } from 'lucide-react'
import { createContext, Fragment, useContext, useEffect, useMemo, useState } from 'react'
import { useNow } from '@/components/agents/status'
import { imageUrl, thumbUrl } from '@/lib/api'
import { shortPath, took } from '@/lib/format'
import { useStore } from '@/lib/store'
import { tokenStyle, useTokens } from '@/lib/highlight'
import { cn } from '@/lib/utils'
import { ImageThumb } from '@/components/image-viewer'
import { collectEdits, filesOf } from './code-files'
import { CodeEmpty, CodeVision } from './code-vision'
import { ScreenBar } from './screen-bar'
import { ScreenCtx } from './screen-ctx'
import { StepsEmptyArt } from './empty-art'
import { FRESH_MS, reducedMotion } from './fresh'
import { useGallery } from './gallery'
import type { Item } from './items'
import { buildTrail, countTools, type Step, type ToolEntry } from './trail'

// O terminal do app no escuro (THEMES.dark em components/terminal.tsx), em cartões pretos nos dois temas. Copiado
// em vez de importado: aquele arquivo traz o xterm inteiro, que o chat não precisa.
const FG = '#e5e5e5'
const DIM = '#737373'
const RED = '#ff7b72'
const GREEN = '#3fb950'
const BLUE = '#58a6ff'
const PROMPT = '#d97757'

const str = (v: unknown) => (typeof v === 'string' ? v : '')

type Line = { text: string; color?: string }
type Shown = {
  /** Pasta onde roda, se o comando mudou de pasta. */
  cd?: string
  command: string
  /** Realce de shell no comando (só o Bash). */
  shell?: boolean
  output: Line[]
  /** Quantas linhas da saída aparecem antes do "+N linhas". */
  limit: number
}

const textLines = (text: string, color?: string): Line[] => (text ? text.replace(/\n$/, '').split('\n').map((l) => ({ text: l, color })) : [])
const diffLines = (old: string, next: string): Line[] => [...textLines(old, RED).map((l) => ({ ...l, text: `- ${l.text}` })), ...textLines(next, GREEN).map((l) => ({ ...l, text: `+ ${l.text}` }))]
const json = (input: Record<string, unknown>) => JSON.stringify(input).slice(0, 160)

/** A ferramenta como se fosse um comando de shell, e o que saiu dele. */
function shown(t: ToolEntry): Shown {
  const { name, input } = t.use
  const file = shortPath(str(input.file_path) || str(input.notebook_path))
  const out = t.result?.text ?? ''
  const result = textLines(out, t.result?.isError ? RED : undefined)
  switch (name) {
    case 'Bash': {
      const cmd = str(input.command)
      // "cd pasta && comando": a pasta vira o cwd do prompt, o resto é o comando.
      const m = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&]+)\s*(?:&&|;)\s*([\s\S]+)$/.exec(cmd)
      const dir = m?.[1]!.replace(/^["']|["']$/g, '')
      return { cd: dir, command: m ? m[2]! : cmd, shell: true, output: result, limit: 8 }
    }
    case 'Read': {
      const range = input.offset || input.limit ? `:${input.offset ?? 0}-${input.limit ?? ''}` : ''
      return { command: `read ${file}${range}`, output: result, limit: 0 }
    }
    case 'Edit':
      return { command: `edit ${file}`, output: t.result?.isError ? result : diffLines(str(input.old_string), str(input.new_string)), limit: 8 }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
      return { command: `edit ${file}`, output: t.result?.isError ? result : edits.flatMap((e) => diffLines(str(e.old_string), str(e.new_string))), limit: 8 }
    }
    case 'Write':
      return { command: `write ${file}`, output: t.result?.isError ? result : textLines(str(input.content), GREEN).map((l) => ({ ...l, text: `+ ${l.text}` })), limit: 0 }
    case 'Grep':
      return { command: `grep ${str(input.pattern)}${input.path || input.glob ? ` ${shortPath(str(input.path || input.glob))}` : ''}`, output: result, limit: 8 }
    case 'Glob':
      return { command: `glob ${str(input.pattern)}`, output: result, limit: 8 }
    case 'WebFetch':
      return { command: `fetch ${str(input.url)}`, output: result, limit: 8 }
    case 'WebSearch':
      return { command: `search ${str(input.query)}`, output: result, limit: 8 }
    case 'Agent':
    case 'Task':
      return { command: `agent ${str(input.subagent_type) || 'geral'} "${str(input.description)}"`, output: t.result?.isError ? result : [], limit: 8 }
    default:
      return { command: `${name.startsWith('mcp__') ? name.split('__').slice(1).join('·') : name} ${json(input)}`, output: result, limit: 8 }
  }
}

/** Quantas linhas do comando aparecem antes do "+N linhas": um script inteiro não toma o painel. */
const COMMAND_LIMIT = 4

function Command({ text, shell }: { text: string; shell?: boolean }) {
  const [open, setOpen] = useState(false)
  // Sempre no tema escuro: o fundo é preto, qualquer que seja o do app.
  const lines = useTokens(shell ? text : null, 'comando.sh', true)
  const plain = text.split('\n')
  const more = plain.length - COMMAND_LIMIT
  const cut = !open && more > 0
  return (
    <>
      {lines ? (
        (cut ? lines.slice(0, COMMAND_LIMIT) : lines).map((line, i) => (
          <Fragment key={i}>
            {i > 0 && '\n'}
            {line.map((tk, j) => (
              <span key={j} style={tokenStyle(tk)}>
                {tk.content}
              </span>
            ))}
          </Fragment>
        ))
      ) : (
        <span style={{ color: FG }}>{cut ? plain.slice(0, COMMAND_LIMIT).join('\n') : text}</span>
      )}
      {more > 0 && (
        <>
          {'\n'}
          <button type="button" onClick={() => setOpen((o) => !o)} className="hover:underline" style={{ color: DIM }}>
            {open ? '▴ recolher' : `… +${more} linhas`}
          </button>
        </>
      )}
    </>
  )
}

function Output({ lines, limit }: { lines: Line[]; limit: number }) {
  const [open, setOpen] = useState(false)
  if (lines.length === 0) return null
  const more = lines.length - limit
  const visible = open || more <= 0 ? lines : lines.slice(0, limit)
  return (
    <div className="mt-0.5">
      {visible.length > 0 && (
        <pre className={cn('font-[inherit] break-all whitespace-pre-wrap', open && 'max-h-96 overflow-auto')} style={{ color: '#c4c4c4' }}>
          {visible.map((l, i) => (
            <Fragment key={i}>
              {i > 0 && '\n'}
              <span style={l.color ? { color: l.color } : undefined}>{l.text}</span>
            </Fragment>
          ))}
        </pre>
      )}
      {more > 0 && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-left hover:underline" style={{ color: DIM }}>
          {open ? '▴ recolher' : limit === 0 ? `… ${more} linhas` : `… +${more} linhas`}
        </button>
      )}
    </div>
  )
}

/** Se a conversa está trabalhando agora: sem isso, ferramenta sem resposta foi interrompida. */
const Live = createContext(false)

/**
 * As ferramentas que este aparelho já mostrou, pelo id da chamada: cada uma é digitada uma vez só. Pelo
 * id, e não pela chave do item, porque a mesma chamada troca de chave quando sai do ao vivo para o
 * histórico relido, e seria digitada de novo.
 */
const seenTools = new Set<string>()

/** Se a ferramenta acabou de chegar (e ainda não foi mostrada): ela entra animada. Decide e já marca. */
function arrive(tool: ToolEntry): boolean {
  const id = tool.use.id
  if (seenTools.has(id)) return false
  seenTools.add(id)
  const from = tool.at ?? tool.started
  return Boolean(from) && Date.now() - from! < FRESH_MS && !reducedMotion()
}

/** Quanto levou ou, rodando, há quanto tempo roda: pela hora ao vivo ou, sem ela, pela do transcript. */
function useElapsed(tool: ToolEntry, running: boolean): string {
  const now = useNow(running)
  if (tool.result) return tool.started && tool.finished ? took(tool.finished - tool.started) : ''
  const from = tool.at ?? tool.started
  return running && from ? took(Math.max(0, now - from)) : ''
}

/**
 * Entra abrindo a altura e clareando, em vez de empurrar a lista de uma vez. Decide na montagem; depois
 * de aberto, sai o recorte (senão o contorno dos cartões ficaria cortado).
 */
function Appear({ on, children }: { on: boolean; children: React.ReactNode }) {
  const [phase, setPhase] = useState<'closed' | 'opening' | 'done'>(on ? 'closed' : 'done')
  useEffect(() => {
    if (phase !== 'closed') return
    const frame = requestAnimationFrame(() => setPhase('opening'))
    return () => cancelAnimationFrame(frame)
  }, [phase])
  return (
    <div
      className={cn(
        phase !== 'done' && 'grid transition-[grid-template-rows,opacity] duration-300 ease-out',
        phase === 'closed' ? 'grid-rows-[0fr] opacity-0' : phase === 'opening' && 'grid-rows-[1fr] opacity-100',
      )}
      onTransitionEnd={(e) => e.target === e.currentTarget && e.propertyName === 'grid-template-rows' && setPhase('done')}
    >
      <div className={cn(phase !== 'done' && 'min-h-0 overflow-hidden')}>{children}</div>
    </div>
  )
}

/**
 * O comando aparecendo aos poucos, em uma duração que não depende do tamanho (de 0,3 a 1,2 s): comando
 * longo escreve vários caracteres por quadro. `done` vira true ao terminar; sem `enabled`, já nasce pronto.
 */
function useTyping(text: string, enabled: boolean): { shown: string; done: boolean } {
  const [n, setN] = useState(enabled ? 0 : text.length)
  useEffect(() => {
    if (!enabled) return
    const total = Math.min(1200, Math.max(300, text.length * 25))
    const start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / total)
      setN(Math.ceil(text.length * p))
      if (p < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [enabled, text])
  const done = !enabled || n >= text.length
  return { shown: text.slice(0, n), done }
}

function ToolBlock({ sessionId, cwd, agent, tool, animate }: { sessionId: string; cwd: string; agent: string; tool: ToolEntry; animate: boolean }) {
  const s = shown(tool)
  const live = useContext(Live)
  const running = !tool.result && live
  const interrupted = !tool.result && !live
  const time = useElapsed(tool, running)
  const { claude } = useGallery()
  const visible = s.command.split('\n').slice(0, COMMAND_LIMIT).join('\n')
  const typing = useTyping(visible, animate)
  const failed = tool.result?.isError
  const where = s.cd ? shortPath(s.cd.startsWith('/') ? s.cd : `${cwd.replace(/\/$/, '')}/${s.cd}`) : shortPath(cwd)
  return (
    <div className="relative rounded-xl bg-black px-3 py-2 font-mono text-[11px] leading-relaxed shadow-sm ring-1 ring-white/10 dark:shadow-none" style={{ color: FG }}>
      {/* Esperando a resposta: o contorno respira devagar. */}
      {running && typing.done && <span className="pointer-events-none absolute inset-0 animate-pulse rounded-xl ring-1 ring-white/30" />}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 break-all whitespace-pre-wrap">
          {/* Sem a pasta da conversa (ainda não chegou), o prompt começa direto no agente. */}
          {where && (
            <>
              <span style={{ color: BLUE }}>{where}</span> <span style={{ color: DIM }}>&gt;</span>{' '}
            </>
          )}
          <span style={{ color: failed ? RED : PROMPT }}>{agent}</span>{' '}
          {typing.done ? (
            <Command text={s.command} shell={s.shell} />
          ) : (
            <>
              <span style={{ color: FG }}>{typing.shown}</span>
              <span style={{ color: FG }}>▊</span>
            </>
          )}
        </div>
        {time && (
          <span className="shrink-0 tabular-nums" style={{ color: DIM }}>
            {time}
          </span>
        )}
      </div>
      {typing.done && (
        <div className={cn(animate && 'animate-in fade-in')}>
          <Output lines={s.output} limit={s.limit} />
          {running && (
            <div className="animate-pulse" style={{ color: FG }}>
              ▊
            </div>
          )}
          {interrupted && <div style={{ color: DIM }}>interrompido</div>}
          {tool.result?.images && tool.result.images.length > 0 && (
            <div className="mt-1 flex gap-1.5 overflow-x-auto">
              {tool.result.images.map((key) => (
                <ImageThumb key={key} src={imageUrl(sessionId, key)} thumb={thumbUrl(sessionId, key)} gallery={claude} from="Claude" className="h-16 max-w-32" />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Why({ why }: { why: NonNullable<Step['why']> }) {
  const [open, setOpen] = useState(false)
  return (
    <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start gap-1.5 px-1 text-left text-xs text-muted-foreground hover:text-foreground">
      {why.kind === 'thinking' && <Brain className="mt-0.5 size-3 shrink-0" />}
      <span className={cn('min-w-0 flex-1 whitespace-pre-wrap', !open && 'line-clamp-2')}>{why.text}</span>
    </button>
  )
}

/** Um cartão e o que o subagente dele fez; decide uma vez, ao montar, se chegou agora. */
function ToolItem({ sessionId, cwd, agent, tool }: { sessionId: string; cwd: string; agent: string; tool: ToolEntry }) {
  const [animate] = useState(() => arrive(tool))
  return (
    <Appear on={animate}>
      <ToolBlock sessionId={sessionId} cwd={cwd} agent={agent} tool={tool} animate={animate} />
    </Appear>
  )
}

function StepView({ sessionId, cwd, agent, step }: { sessionId: string; cwd: string; agent: string; step: Step }) {
  // O porquê de um passo que acabou de começar entra junto com o primeiro cartão dele.
  const [fresh] = useState(() => {
    const first = step.tools[0]
    const from = first && (first.at ?? first.started)
    return Boolean(first && !seenTools.has(first.use.id) && from && Date.now() - from < FRESH_MS) && !reducedMotion()
  })
  return (
    <div className="space-y-1.5">
      {/* Do mais novo ao mais antigo, também dentro do passo; o porquê veio antes, então fica por último. */}
      {[...step.tools].reverse().map((t) => {
        const inner = step.nested?.[t.key]
        // Dentro do subagente, quem assina o prompt é ele.
        const sub = str(t.use.input.subagent_type) || str(t.use.input.description) || 'agente'
        return (
          <div key={t.key} className="space-y-1.5">
            <ToolItem sessionId={sessionId} cwd={cwd} agent={agent} tool={t} />
            {inner && (
              <div className="ml-2 space-y-3 border-l pl-2">
                {[...inner].reverse().map((st) => (
                  <StepView key={st.key} sessionId={sessionId} cwd={cwd} agent={sub} step={st} />
                ))}
              </div>
            )}
          </div>
        )
      })}
      {step.why && (
        <Appear on={fresh}>
          <Why why={step.why} />
        </Appear>
      )}
    </div>
  )
}

/** O que o Claude está escrevendo agora, o fim do texto, com o cursor: vira o porquê do próximo passo quando acaba. */
function Typing({ sessionId }: { sessionId: string }) {
  // Só o fim: assinar o texto inteiro redesenharia o painel a cada pedaço.
  const tail = useStore((s) => (s.streams[sessionId] ?? '').slice(-200))
  if (!tail.trim()) return null
  return (
    <p className="line-clamp-2 px-1 text-xs text-muted-foreground">
      {tail.trim()}
      <span className="animate-pulse">▊</span>
    </p>
  )
}

/** Cada tela do painel é uma janela como a da conversa: a folga entre elas mostra a margem escura da casca. */
/** A tela do código: os arquivos que o Claude edita (ver code-vision.tsx). */
export function CodeScreen({ sessionId, machine, items, cwd, live }: { sessionId: string; machine: string; items: Item[]; cwd: string; live: boolean }) {
  const files = useMemo(() => filesOf(collectEdits(items), live), [items, live])
  return files.length > 0 ? <CodeVision sessionId={sessionId} machine={machine} cwd={cwd} files={files} live={live} /> : <CodeEmpty />
}

/** O que o Claude executou, em cartões de terminal: do mais novo ao mais antigo (inclusive dentro de um passo, com o porquê por último). */
export function StepsScreen({ sessionId, items, cwd, agent, live }: { sessionId: string; items: Item[]; cwd: string; agent: string; live: boolean }) {
  const groups = useMemo(() => buildTrail(items), [items])
  const total = useMemo(() => countTools(groups), [groups])
  const streaming = useStore((s) => Boolean((s.streams[sessionId] ?? '').trim()))
  const ctx = useContext(ScreenCtx)
  return (
    <>
      <ScreenBar icon={<Footprints />} title="Passos">
        {total > 0 && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{total}</span>}
      </ScreenBar>
      {/* Recolhida, o corpo só se esconde: o que chega ao vivo continua montado. */}
      <div className={cn('flex min-h-0 flex-1 flex-col', ctx?.collapsed && 'hidden')}>
        {groups.length === 0 && !streaming ? (
          <StepsEmptyArt />
        ) : (
          <Live value={live}>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4">
              <Typing sessionId={sessionId} />
              {groups.map((g) => (
                <section key={g.key} className="space-y-2.5">
                  {g.prompt !== undefined && (
                    <div className="flex items-baseline gap-2 px-1 text-[11px] text-muted-foreground" title={g.prompt}>
                      <span className="shrink-0">Pedido {g.n}</span>
                      <span className="min-w-0 truncate opacity-70">{g.prompt}</span>
                    </div>
                  )}
                  {g.steps.map((st) => (
                    <StepView key={st.key} sessionId={sessionId} cwd={cwd} agent={agent} step={st} />
                  ))}
                </section>
              ))}
            </div>
          </Live>
        )}
      </div>
    </>
  )
}
