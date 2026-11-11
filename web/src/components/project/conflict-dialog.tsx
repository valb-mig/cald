import { Check, CloudUpload, Loader2, Pencil, RotateCcw, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import type { ThemedToken } from 'shiki/core'
import { toast } from 'sonner'
import { FIELD, ISLAND, ISLAND_WIDE, NAV_ITEM, NavGroup, WINDOW, WindowHeader } from '@/components/island'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { api, errorMessage } from '@/lib/api'
import { askAgent } from '@/lib/ask-agent'
import { picked, resolved, segmentsOf, type Pick, type Segment } from '@/lib/conflict'
import { refreshGithubItem } from '@/lib/github'
import { useTokens } from '@/lib/highlight'
import { useMediaQuery } from '@/lib/hooks'
import type { ConflictFile, ConflictResolution, GithubPullDetail, PrConflicts, RunOptions } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Code as TokenLine } from './diff-lines'
import { AgentMenu } from './pull-composer'
import { splitPath } from './status'

type Props = { open: boolean; onOpenChange: (open: boolean) => void; machine: string; cwd: string; pr: GithubPullDetail }
type Conflict = Extract<Segment, { kind: 'conflict' }>

/**
 * Resolver o conflito de um PR com a base, na ilha do edit.r: à esquerda os arquivos em conflito, com o
 * que falta em cada um, o "Concluir e subir" e o "Pedir a um agente"; à direita, cada trecho em conflito
 * com a versão da branch e a da base, para usar uma, as duas ou escrever outra. Concluir faz o commit de
 * merge e sobe na branch do PR, sem mexer em pasta nenhuma do PC (ver server/src/conflicts.ts).
 */
export function ConflictDialog({ open, onOpenChange, ...rest }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className={cn(ISLAND, 'h-[min(44rem,calc(100dvh-2rem))] w-[min(72rem,calc(100vw-1.5rem))]')}>
        <DialogTitle className="sr-only">Resolver o conflito do PR #{rest.pr.number}</DialogTitle>
        <DialogDescription className="sr-only">
          Escolha o que fica em cada trecho em conflito entre {rest.pr.branch} e {rest.pr.base}.
        </DialogDescription>
        {open && <Body {...rest} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

/**
 * "Pedir a um agente": o mesmo menu do "Chamar agente" do PR (ver AgentMenu), com os agentes ligados na
 * máquina e, ao lado de cada um, o modelo e o esforço. Tocar num cria a conversa no projeto já pedindo
 * para trazer a base para a branch, resolver e subir, e vai para ela.
 */
function AskAgent({ machine, cwd, pr, onAsked }: { machine: string; cwd: string; pr: GithubPullDetail; onAsked: () => void }) {
  const prompt = `O PR #${pr.number} (${pr.title}) tem conflito com ${pr.base}. Traga a ${pr.base} para a branch ${pr.branch}, resolva os conflitos e suba a branch.`
  return (
    <AgentMenu
      machine={machine}
      disabled={false}
      anyAgent
      className="w-full"
      label="Pedir a um agente"
      title="Uma conversa nova em que o agente resolve o conflito e sobe a branch"
      heading="Resolver o conflito com"
      verb="Resolver o conflito com"
      storageKey="cr:conflict-agent"
      // Uma conversa de verdade, e não uma tarefa curta: de partida, o modelo e o esforço das suas configurações.
      prefer={{ model: 'default', effort: null }}
      onRun={(agent, model, effort) => {
        onAsked()
        void askAgent({ machine, cwd }, prompt, {
          provider: agent.id,
          model: model.value === 'default' ? undefined : model.value,
          effort: (effort ?? undefined) as RunOptions['effort'],
        })
      }}
    />
  )
}

function Body({ machine, cwd, pr, onClose }: Omit<Props, 'open' | 'onOpenChange'> & { onClose: () => void }) {
  const wide = useMediaQuery(ISLAND_WIDE)
  const [data, setData] = useState<PrConflicts | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // As escolhas: por trecho nos arquivos de texto, o lado inteiro nos outros.
  const [picks, setPicks] = useState<Record<string, (Pick | null)[]>>({})
  const [sides, setSides] = useState<Record<string, 'branch' | 'base'>>({})
  const [shownPath, setShownPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api.prConflicts(machine, cwd, pr.branch, pr.base).then(
      (c) => {
        if (!alive) return
        setData(c)
        // Sem conflito (resolvido por fora, ou o GitHub ainda não tinha visto): o PR na tela se atualiza.
        if (!c.files.length) refreshGithubItem(machine, cwd, 'pr', pr.number)
      },
      (err) => alive && setError(errorMessage(err)),
    )
    return () => {
      alive = false
    }
  }, [machine, cwd, pr.branch, pr.base, pr.number, attempt])

  const segments = useMemo(() => new Map((data?.files ?? []).flatMap((f) => (f.text === null ? [] : [[f.path, segmentsOf(f.text)] as const]))), [data])
  /** Quantas escolhas faltam no arquivo. */
  const left = (f: ConflictFile) => {
    const segs = segments.get(f.path)
    if (!segs) return sides[f.path] ? 0 : 1
    const count = segs.filter((s) => s.kind === 'conflict').length
    const made = (picks[f.path] ?? []).filter(Boolean).length
    return count - made
  }
  const files = data?.files ?? []
  const pending = files.reduce((n, f) => n + left(f), 0)
  const shown = shownPath ?? (wide ? (files[0]?.path ?? null) : null)
  const file = files.find((f) => f.path === shown)
  const next = files.find((f) => f.path !== shown && left(f) > 0)

  const finish = async () => {
    if (!data || pending) return
    const resolutions: ConflictResolution[] = files.map((f) => {
      const segs = segments.get(f.path)
      return segs ? { path: f.path, content: resolved(segs, picks[f.path] ?? [])! } : { path: f.path, side: sides[f.path]! }
    })
    setBusy(true)
    try {
      await api.resolvePrConflicts(machine, cwd, { branch: data.branch, base: data.base, head: data.head, baseSha: data.baseSha, files: resolutions })
      toast.success(`O merge de ${data.base} subiu na ${data.branch}`)
      refreshGithubItem(machine, cwd, 'pr', pr.number)
      // O GitHub leva uns segundos para conferir o conflito de novo: mais uma busca, depois.
      setTimeout(() => refreshGithubItem(machine, cwd, 'pr', pr.number), 6000)
      onClose()
    } catch (err) {
      toast.error(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <>
      {(wide || !file) && (
        <nav className="flex min-h-0 shrink-0 flex-col gap-1 p-3 sm:w-80">
          <div className="flex items-start gap-1 px-2 pt-1 pb-2">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-medium">Conflito com {pr.base}</h2>
              <p className="truncate font-mono text-xs text-muted-foreground" title={pr.branch}>
                {pr.branch}
              </p>
            </div>
            {!wide && (
              <DialogClose asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Fechar">
                  <X />
                </Button>
              </DialogClose>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {data ? (
              <NavGroup title={`${files.length} ${files.length === 1 ? 'arquivo' : 'arquivos'}`} empty="Nenhum conflito">
                {files.map((f) => {
                  const { name, dir } = splitPath(f.path)
                  const n = left(f)
                  return (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => setShownPath(f.path)}
                      aria-current={f.path === shown ? 'page' : undefined}
                      title={f.path}
                      className={cn(NAV_ITEM, 'h-auto py-1.5')}
                    >
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-[13px] text-foreground">{name}</span>
                        {dir && <span className="block truncate text-[11px]">{dir}</span>}
                      </span>
                      {n ? (
                        <span title={`${n} para escolher`} className="flex h-5 min-w-5 items-center justify-center rounded-md bg-foreground/[0.06] px-1 text-[11px] tabular-nums">
                          {n}
                        </span>
                      ) : (
                        <Check aria-label="Resolvido" className="text-emerald-600 dark:text-emerald-400" />
                      )}
                    </button>
                  )
                })}
              </NavGroup>
            ) : (
              !error && <Loader2 className="mx-auto my-8 size-5 animate-spin text-muted-foreground" />
            )}
          </div>
          <div className="space-y-2 px-1 pt-2">
            {data && files.length > 0 && (
              <>
                <p className="px-1 text-xs text-muted-foreground">
                  {pending ? `Falta escolher em ${pending} ${pending === 1 ? 'trecho' : 'trechos'}.` : `Um commit de merge na ${data.branch}, direto no GitHub.`}
                </p>
                <Button className="w-full" disabled={pending > 0 || busy} onClick={() => void finish()}>
                  {busy ? <Loader2 className="animate-spin" /> : <CloudUpload />} Concluir e subir
                </Button>
              </>
            )}
            <AskAgent machine={machine} cwd={cwd} pr={pr} onAsked={onClose} />
          </div>
        </nav>
      )}

      {(wide || file) && (
        <div className={WINDOW}>
          {error ? (
            <div className="m-auto max-w-sm space-y-3 px-6 text-center">
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setError(null)
                  setAttempt((a) => a + 1)
                }}
              >
                Tentar de novo
              </Button>
            </div>
          ) : !data ? (
            <p className="m-auto text-sm text-muted-foreground">Juntando {pr.base} na branch…</p>
          ) : !files.length ? (
            <p className="m-auto px-6 text-center text-sm text-muted-foreground">Não há mais conflito com {pr.base}: dá para dar merge.</p>
          ) : file ? (
            <>
              <WindowHeader title={splitPath(file.path).name} subtitle={splitPath(file.path).dir || 'raiz do projeto'} onBack={() => setShownPath(null)} />
              <div className="@container min-h-0 flex-1 space-y-2 overflow-y-auto px-6 pb-4 max-sm:px-3">
                {segments.has(file.path) ? (
                  <FileSegments
                    key={file.path}
                    path={file.path}
                    segments={segments.get(file.path)!}
                    picks={picks[file.path] ?? []}
                    onPick={(i, pick) =>
                      setPicks((all) => {
                        const list = [...(all[file.path] ?? [])]
                        list[i] = pick
                        return { ...all, [file.path]: list }
                      })
                    }
                    branch={pr.branch}
                    base={pr.base}
                  />
                ) : (
                  <WholeFile file={file} base={pr.base} side={sides[file.path]} onSide={(side) => setSides((all) => ({ ...all, [file.path]: side }))} />
                )}
                {next && left(file) === 0 && (
                  <div className="flex justify-end pt-2">
                    <Button size="sm" variant="secondary" onClick={() => setShownPath(next.path)}>
                      Próximo arquivo: {splitPath(next.path).name}
                    </Button>
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      )}
    </>
  )
}

/** As cores de sintaxe das linhas de um pedaço de código; sem elas (carregando, linguagem que o app não colore), o texto puro. */
type Colors = ThemedToken[][] | undefined

/**
 * Um trecho de código, com as cores de sintaxe e as linhas longas quebradas: lado a lado, rolar cada
 * versão escondia o fim delas. `faded`: o que é igual nos dois lados, mais apagado que os trechos.
 */
function Code({ text, colors, faded = false }: { text: string; colors?: Colors; faded?: boolean }) {
  const lines = text.replace(/\n$/, '').split('\n')
  return (
    <pre className={cn('px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]', faded && 'opacity-60')}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && '\n'}
          <TokenLine text={line} tokens={colors?.[i]} />
        </Fragment>
      ))}
    </pre>
  )
}

/** O que você escreveu num trecho, colorido à parte (não está em nenhuma das duas versões). */
function TypedCode({ text, path }: { text: string; path: string }) {
  return <Code text={text} colors={useTokens(text, path) ?? undefined} />
}

/** Quantas linhas o texto ocupa (o vazio, nenhuma). */
const lineCount = (text: string) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0)

/**
 * O arquivo de texto: as partes iguais, encurtadas em volta dos trechos, e cada trecho em conflito. As
 * cores vêm das duas versões inteiras do arquivo (a da branch e a da base), coloridas uma vez cada:
 * colorir trecho por trecho perderia o contexto (um trecho no meio de um comentário longo, por exemplo).
 */
function FileSegments({
  path,
  segments,
  picks,
  onPick,
  branch,
  base,
}: {
  path: string
  segments: Segment[]
  picks: (Pick | null)[]
  onPick: (i: number, pick: Pick | null) => void
  branch: string
  base: string
}) {
  // As duas versões e a linha em que cada pedaço começa em cada uma.
  const versions = useMemo(() => {
    const text = { branch: '', base: '' }
    const at = { branch: 0, base: 0 }
    const starts = segments.map((s) => {
      const start = { ...at }
      const sides = s.kind === 'same' ? { branch: s.text, base: s.text } : s
      for (const side of ['branch', 'base'] as const) {
        text[side] += sides[side]
        at[side] += lineCount(sides[side])
      }
      return start
    })
    return { ...text, starts }
  }, [segments])
  const branchColors = useTokens(versions.branch, path)
  const baseColors = useTokens(versions.base, path)
  const slice = (colors: ThemedToken[][] | null, from: number, text: string) => colors?.slice(from, from + lineCount(text))

  const total = segments.filter((s) => s.kind === 'conflict').length
  let n = 0
  return segments.map((s, i) => {
    const start = versions.starts[i]!
    if (s.kind === 'same')
      return <Same key={i} text={s.text} colors={slice(branchColors, start.branch, s.text)} first={i === 0} last={i === segments.length - 1} />
    const at = n++
    return (
      <Hunk
        key={i}
        n={at + 1}
        total={total}
        path={path}
        segment={s}
        colors={{ branch: slice(branchColors, start.branch, s.branch), base: slice(baseColors, start.base, s.base) }}
        pick={picks[at] ?? null}
        onPick={(p) => onPick(at, p)}
        branch={branch}
        base={base}
      />
    )
  })
}

const CONTEXT = 3

/** O que é igual nos dois lados: só as linhas em volta dos trechos, e o resto num "N linhas iguais". */
function Same({ text, colors, first, last }: { text: string; colors: Colors; first: boolean; last: boolean }) {
  const [open, setOpen] = useState(false)
  const lines = text.replace(/\n$/, '').split('\n')
  const head = first ? 0 : CONTEXT
  const tail = last ? 0 : CONTEXT
  if (open || lines.length <= head + tail + 2) return <Code text={text} colors={colors} faded />
  const fold = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="w-full rounded-md px-3 py-1 text-left text-[11px] text-muted-foreground/80 transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
    >
      ··· {lines.length - head - tail} linhas iguais
    </button>
  )
  return (
    <div>
      {head > 0 && <Code text={lines.slice(0, head).join('\n')} colors={colors?.slice(0, head)} faded />}
      {fold}
      {tail > 0 && <Code text={lines.slice(-tail).join('\n')} colors={colors?.slice(lines.length - tail)} faded />}
    </div>
  )
}

const PICK_LABEL = { branch: 'fica o da branch', base: 'fica o da base', both: 'ficam os dois' } as const

/** Um trecho em conflito: as duas versões para escolher; escolhido, o que fica, com o "Trocar". */
function Hunk({
  n,
  total,
  path,
  segment,
  colors,
  pick,
  onPick,
  branch,
  base,
}: {
  n: number
  total: number
  path: string
  segment: Conflict
  colors: { branch: Colors; base: Colors }
  pick: Pick | null
  onPick: (pick: Pick | null) => void
  branch: string
  base: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const title = `Trecho ${n} de ${total}`
  // O que fica, com as cores do lado de onde veio; "os dois" é a branch e, embaixo, a base.
  const result =
    pick === 'branch' ? (
      <Code text={segment.branch} colors={colors.branch} />
    ) : pick === 'base' ? (
      <Code text={segment.base} colors={colors.base} />
    ) : pick === 'both' ? (
      <Code text={picked(segment, 'both')} colors={colors.branch && colors.base && [...colors.branch, ...colors.base]} />
    ) : pick ? (
      <TypedCode text={picked(segment, pick)} path={path} />
    ) : null

  if (draft !== null)
    return (
      <section className="space-y-1 rounded-xl bg-foreground/[0.04] p-1">
        <h4 className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{title}: escrevendo o que fica</h4>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          spellCheck={false}
          aria-label="O que fica no trecho"
          rows={Math.min(18, draft.split('\n').length + 1)}
          className={cn(FIELD, 'resize-y bg-background font-mono text-xs leading-5 focus-visible:bg-background')}
        />
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            Cancelar
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onPick({ text: draft })
              setDraft(null)
            }}
          >
            Pronto
          </Button>
        </div>
      </section>
    )

  if (pick)
    return (
      <section className="rounded-xl bg-emerald-500/[0.07] p-1">
        <div className="flex items-center gap-1.5 py-0.5 pr-0.5 pl-2 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
          <Check className="size-3.5" />
          <span className="min-w-0 flex-1 truncate">
            {title}: {typeof pick === 'string' ? PICK_LABEL[pick] : 'fica o que você escreveu'}
          </span>
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setDraft(picked(segment, pick))}>
            <Pencil /> Editar
          </Button>
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => onPick(null)}>
            <RotateCcw /> Trocar
          </Button>
        </div>
        <div className="rounded-lg bg-background">{result}</div>
      </section>
    )

  return (
    <section className="rounded-xl bg-foreground/[0.04] p-1">
      <h4 className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{title}</h4>
      <div className="grid gap-1 @2xl:grid-cols-2">
        <Side label="Da branch" source={branch} text={segment.branch} colors={colors.branch} onUse={() => onPick('branch')} />
        <Side label="Da base" source={base} text={segment.base} colors={colors.base} onUse={() => onPick('base')} />
      </div>
      <div className="flex gap-1 pt-1">
        <Button size="sm" variant="ghost" onClick={() => onPick('both')} title="A versão da branch e, embaixo, a da base">
          Os dois
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDraft(picked(segment, 'both'))}>
          <Pencil /> Escrever
        </Button>
      </div>
    </section>
  )
}

/** Uma das versões do trecho, com o "Usar este". Vazia: daquele lado, o trecho foi apagado. */
function Side({ label, source, text, colors, onUse }: { label: string; source: string; text: string; colors: Colors; onUse: () => void }) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg bg-background">
      <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs" title={source}>
          <span className="font-medium">{label}</span> <span className="font-mono text-muted-foreground">{source}</span>
        </span>
        <Button size="sm" variant="secondary" onClick={onUse}>
          Usar este
        </Button>
      </div>
      {text ? <Code text={text} colors={colors} /> : <p className="px-3 pb-2 text-xs text-muted-foreground italic">Nada: deste lado, o trecho foi apagado.</p>}
    </div>
  )
}

/** O arquivo que não dá para juntar por trechos (binário, grande, apagado de um lado): fica um lado inteiro. */
function WholeFile({ file, base, side, onSide }: { file: ConflictFile; base: string; side?: 'branch' | 'base'; onSide: (side: 'branch' | 'base') => void }) {
  const why = !file.branch
    ? `Apagado na branch e mudado na ${base}.`
    : !file.base
      ? `Mudado na branch e apagado na ${base}.`
      : 'Não dá para juntar por trechos (binário ou grande demais): fica um dos lados inteiro.'
  const options = [
    { key: 'branch' as const, title: file.branch ? 'Manter o da branch' : 'Apagar, como na branch' },
    { key: 'base' as const, title: file.base ? `Manter o da ${base}` : `Apagar, como na ${base}` },
  ]
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{why}</p>
      <div role="radiogroup" aria-label="O que fica" className="space-y-0.5 rounded-xl bg-foreground/[0.04] p-1">
        {options.map((o) => {
          const on = side === o.key
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onSide(o.key)}
              className={cn('flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors hover:bg-foreground/[0.04]', on && 'bg-primary/[0.07] font-medium')}
            >
              <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', on ? 'border-primary bg-primary' : 'border-muted-foreground/40')}>
                {on && <span className="size-1.5 rounded-full bg-primary-foreground" />}
              </span>
              {o.title}
            </button>
          )
        })}
      </div>
    </div>
  )
}
