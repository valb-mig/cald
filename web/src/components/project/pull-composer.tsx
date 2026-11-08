import { GitBranch, GitPullRequestCreate, Loader2, RefreshCw, Sparkles, Square, Tag, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { EffortBar, EFFORTS } from '@/components/chat/composer-controls'
import { ProviderMark } from '@/components/provider-mark'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from '@/lib/api'
import { GITHUB_REASON, loadGithub } from '@/lib/github'
import { reloadGit } from '@/lib/hooks'
import type { AgentProviderInfo, GitFile, ModelOption, PlannedCommit, PullDraftInfo } from '@/lib/types'
import { cn } from '@/lib/utils'
import { openTab } from '@/lib/workbench'
import { BranchChip, Labels } from './github-item'
import { ChangeChip } from './patch-list'
import { MarkdownEditor } from './pull-view'
import { badge, splitPath } from './status'

/**
 * Abrir um PR sem sair do cald, no mesmo desenho da tela de PR: o título no topo, a descrição no meio,
 * os arquivos que vão (o não commitado, escolhido um a um) e os commits que a branch já tem; à
 * direita, de onde para onde, as etiquetas e o "Abrir PR", que diz antes o que vai fazer. Na
 * principal, o PR sai de uma branch nova, com o nome tirado do título.
 *
 * "Chamar agente" faz o que você pediria numa conversa ("abrir PR"): o agente lê as mudanças e, com as
 * suas skills de commit e PR, escreve o título, a descrição e a branch, escolhe as etiquetas e divide o
 * não commitado em commits. Ele só preenche: tudo fica editável, e quem abre é o botão.
 */

/** Um nome de branch a partir do título: "feat(web): Algo novo" vira "feat-algo-novo". */
function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48)
    .replace(/-+$/, '')
}

/** A branch sugerida, no jeito das suas: `<login>/<tipo>-<assunto>`, com o tipo do título (feat, fix…), se ele tiver. */
function suggestBranch(viewer: string, title: string): string {
  const m = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(title.trim())
  const name = m ? `${m[1]!.toLowerCase()}-${slug(m[2]!)}` : slug(title)
  return name ? `${viewer}/${name}` : ''
}

/** Um agente que organiza PRs, com os modelos atuais dele. */
type Organizer = { agent: AgentProviderInfo; models: ModelOption[] }

/** O modelo e o esforço escolhidos para um agente; `default` e `null` são os das suas configurações. */
type Pick = { model: string; effort: string | null }

// O modelo e o esforço de cada agente, lembrados neste aparelho para a próxima vez.
const PICKS_KEY = 'cr:pr-agent'
const savedPicks = (): Record<string, Pick> => {
  try {
    const raw = JSON.parse(localStorage.getItem(PICKS_KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, Pick>) : {}
  } catch {
    return {}
  }
}

/**
 * Os modelos atuais do agente: os que ele oferece por apelido (sonnet, opus…), sem as versões antigas,
 * e o "padrão" (o das suas configurações) no fim. Sem apelidos, os quatro primeiros.
 */
const current = (models: ModelOption[]) => {
  const named = models.filter((m) => m.value !== 'default')
  const aliases = named.filter((m) => !/\d/.test(m.value))
  const fallback = models.find((m) => m.value === 'default')
  return [...(aliases.length ? aliases : named.slice(0, 4)), ...(fallback ? [fallback] : [])]
}

/** Sem escolha ainda: o Sonnet com esforço baixo, que fica em uns 20 s e segue bem as convenções. */
const firstPick = (models: ModelOption[]): Pick => {
  const model = models.find((m) => m.value === 'sonnet') ?? models[0]
  return { model: model?.value ?? 'default', effort: model?.efforts.includes('low') ? 'low' : null }
}

const modelName = (m: ModelOption) => (m.value === 'default' ? 'Padrão' : m.displayName)

/**
 * O "Chamar agente": cada agente com a marca dele, que já organiza ao tocar; passar o mouse abre ao lado o
 * mesmo seletor da barra do chat (o esforço em cima, os modelos embaixo). O que você escolhe fica para a próxima.
 */
function AgentMenu({ machine, disabled, onRun }: { machine: string; disabled: boolean; onRun: (agent: AgentProviderInfo, model: ModelOption, effort: string | null) => void }) {
  const [organizers, setOrganizers] = useState<Organizer[] | null>(null)
  const [picks, setPicks] = useState(savedPicks)
  const [open, setOpen] = useState(false)
  const load = () =>
    api
      .agents(machine)
      .then((list) =>
        Promise.all(
          list
            .filter((a) => a.enabled && a.available && a.features.assist)
            .map(async (agent) => ({ agent, models: current(await api.models(machine, agent.id).catch(() => [])) })),
        ),
      )
      .then(setOrganizers, () => setOrganizers([]))
  const choose = (agent: string, pick: Pick) => {
    const next = { ...picks, [agent]: pick }
    setPicks(next)
    try {
      localStorage.setItem(PICKS_KEY, JSON.stringify(next))
    } catch {
      // localStorage indisponível: a escolha vale só até fechar a aba.
    }
  }
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next && organizers === null) void load()
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled} title="Um agente organiza o título, a descrição, as etiquetas e os commits no jeito das suas skills">
          <Sparkles /> Chamar agente
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Organizar o PR com</DropdownMenuLabel>
        {organizers === null ? (
          <div className="flex justify-center py-2">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : organizers.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Nenhum agente ligado organiza PRs (ou o servidor do PC é da versão anterior).</p>
        ) : (
          organizers.map(({ agent, models }) => {
            const pick = picks[agent.id] ?? firstPick(models)
            const model = models.find((m) => m.value === pick.model) ?? models[0]
            if (!model) return null
            const efforts = agent.features.effort ? model.efforts : []
            const effort = pick.effort && efforts.includes(pick.effort) ? pick.effort : null
            return (
              <DropdownMenuSub key={agent.id}>
                {/* Passar o mouse abre o modelo e o esforço ao lado; tocar no agente já organiza, com o que está escolhido. */}
                <DropdownMenuSubTrigger
                  className="gap-2"
                  title={`Organizar o PR com ${agent.name}`}
                  onClick={(e) => {
                    e.preventDefault()
                    setOpen(false)
                    onRun(agent, model, effort)
                  }}
                >
                  <ProviderMark id={agent.id} className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {modelName(model)}
                    {effort && ` · ${EFFORTS[effort] ?? effort}`}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-72">
                  {efforts.length > 0 && (
                    <>
                      <EffortBar efforts={efforts} value={effort} model={modelName(model)} onChange={(e) => choose(agent.id, { model: model.value, effort: e })} />
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuLabel>Modelo</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={model.value} onValueChange={(v) => choose(agent.id, { model: v, effort })}>
                    {models.map((m) => (
                      <DropdownMenuRadioItem key={m.value} value={m.value} onSelect={(e) => e.preventDefault()}>
                        {modelName(m)}
                        {m.value === 'default' && <span className="ml-auto text-xs text-muted-foreground">suas configurações</span>}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Os caminhos que vão no commit: numa renomeação, o antigo também, senão o commit leva só o novo. */
const pathsOf = (files: GitFile[]) => files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path]))

/** Um arquivo do não commitado: marcar leva ou tira do PR; o nome abre o diff ao lado. */
function FileRow({ file, checked, onToggle, machine, cwd }: { file: GitFile; checked: boolean; onToggle: () => void; machine: string; cwd: string }) {
  const { name, dir } = splitPath(file.path)
  return (
    <li className="flex min-w-0 items-center gap-2.5 rounded-xl px-2 py-1 hover:bg-foreground/[0.04]">
      <Checkbox checked={checked} onCheckedChange={onToggle} aria-label={`Levar ${file.path}`} />
      <ChangeChip badge={badge(file)} />
      <button
        type="button"
        // Ao lado, para ler o diff sem perder o que está escrevendo.
        onClick={() => openTab({ kind: 'file', machine, cwd, path: file.path, diff: 'head' }, { preview: true, beside: true })}
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px]"
        title={`Ver o diff de ${file.path}`}
      >
        <span className="shrink-0 truncate">{name}</span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{dir}</span>
      </button>
      {file.additions || file.deletions ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{file.additions ?? 0}</span>{' '}
          <span className="text-red-600 dark:text-red-400">−{file.deletions ?? 0}</span>
        </span>
      ) : null}
    </li>
  )
}

function Section({ title, action, children }: { title: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {action}
      </div>
      <div className="text-sm">{children}</div>
    </section>
  )
}

export function PullComposer({
  machine,
  cwd,
  onCreated,
}: {
  machine: string
  cwd: string
  /** O PR aberto (ou o que já existia para a branch): a aba vira a dele. */
  onCreated: (pr: { number: number; title: string }) => void
}) {
  const [info, setInfo] = useState<PullDraftInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState<string | null>(null)
  // `null`: o nome segue o título; escrito à mão, fica o que você escreveu.
  const [branch, setBranch] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [message, setMessage] = useState('')
  const [labels, setLabels] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  // A divisão em commits que um agente sugeriu; `null`: um commit só, com os arquivos marcados.
  const [commits, setCommits] = useState<PlannedCommit[] | null>(null)
  const [planning, setPlanning] = useState<{ name: string; abort: AbortController } | null>(null)
  // Os arquivos já vistos: ao reler, só os que apareceram agora entram marcados.
  const seen = useRef(new Set<string>())

  const load = () => {
    setLoading(true)
    api.githubDraft(machine, cwd).then(
      (next) => {
        setInfo(next)
        setError(null)
        // Arquivos novos entram marcados; os que você desmarcou continuam de fora.
        if (next.ok) {
          const fresh = new Set(next.files.filter((f) => !seen.current.has(f.path)).map((f) => f.path))
          for (const f of next.files) seen.current.add(f.path)
          setPicked((p) => new Set(next.files.map((f) => f.path).filter((path) => fresh.has(path) || p?.has(path))))
        }
        setLoading(false)
      },
      (err) => {
        setError(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err))
        setLoading(false)
      },
    )
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [machine, cwd])

  if (error || (info && !info.ok)) {
    return (
      <Shell repo={null} loading={loading} onReload={load}>
        <p className="mt-16 text-center text-sm text-muted-foreground">{error ?? (info && !info.ok ? (info.message ?? GITHUB_REASON[info.reason]) : '')}</p>
      </Shell>
    )
  }
  if (!info?.ok) {
    return (
      <Shell repo={null} loading onReload={load}>
        <div className="mt-16 flex justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </Shell>
    )
  }

  const into = base ?? info.base
  const head = info.onBase ? (branch ?? suggestBranch(info.viewer, title)) : info.branch
  const byPath = new Map(info.files.map((f) => [f.path, f]))
  // Os commits do agente, só com o que ainda está sem commit (relido depois de um erro, parte já pode ter ido).
  const planned = commits?.map((c) => ({ ...c, files: c.files.filter((p) => byPath.has(p)) })).filter((c) => c.files.length) ?? null
  const chosen = planned ? planned.flatMap((c) => c.files.map((p) => byPath.get(p)!)) : info.files.filter((f) => picked?.has(f.path))
  const loose = planned ? info.files.filter((f) => !chosen.includes(f)) : []
  const all = chosen.length === info.files.length
  const nothing = chosen.length === 0 && info.commits.length === 0
  const blocked = !title.trim()
    ? 'Escreva o título.'
    : nothing
      ? 'Nada para o PR: escolha arquivos ou faça commits na branch.'
      : info.onBase && !head
        ? 'Dê um nome à branch nova.'
        : head === into
          ? `O PR precisa sair de outra branch, não da ${into}.`
          : null

  // O que o "Abrir PR" vai fazer, na ordem: dito antes, para não ter surpresa.
  const steps = [
    info.onBase && `cria a branch ${head}`,
    planned && planned.length > 1
      ? `faz ${planned.length} commits com ${chosen.length} arquivos`
      : chosen.length && `faz um commit com ${chosen.length} ${chosen.length === 1 ? 'arquivo' : 'arquivos'}`,
    'publica no origin',
    `abre o PR na ${into}`,
  ].filter(Boolean) as string[]
  const plan = steps.join(', ').replace(/^./, (c) => c.toUpperCase()) + '.'

  const toggle = (path: string) => {
    const next = new Set(picked)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setPicked(next)
  }

  /** Tira um arquivo do commit dele (o commit que fica sem nenhum some) ou, solto, põe no último. */
  const moveFile = (path: string) => {
    if (!planned) return
    const from = planned.findIndex((c) => c.files.includes(path))
    if (from >= 0) setCommits(planned.map((c, i) => (i === from ? { ...c, files: c.files.filter((p) => p !== path) } : c)).filter((c) => c.files.length))
    else if (planned.length) setCommits(planned.map((c, i) => (i === planned.length - 1 ? { ...c, files: [...c.files, path] } : c)))
    else setCommits([{ message: title.trim(), files: [path] }])
  }

  /**
   * O agente organiza o PR no jeito das suas skills; o que ele devolve preenche a tela, para você revisar.
   * O modelo "padrão" e o esforço vazio são os das suas configurações.
   */
  const organize = async (agent: AgentProviderInfo, model: ModelOption, effort: string | null) => {
    const abort = new AbortController()
    const name = `${agent.name} (${modelName(model)})`
    setPlanning({ name, abort })
    try {
      const plan = await api.githubPlanPull(
        machine,
        cwd,
        {
          agent: agent.id,
          model: model.value === 'default' ? undefined : model.value,
          effort: effort ?? undefined,
          base: into,
          title,
          body,
          labels: info.labels.map((l) => l.name),
        },
        // Os textos aparecem enquanto ele escreve, como a resposta no chat.
        (partial) => {
          if (typeof partial.title === 'string') setTitle(partial.title)
          if (typeof partial.body === 'string') setBody(partial.body)
          if (info.onBase && typeof partial.branch === 'string' && partial.branch) setBranch(partial.branch)
        },
        abort.signal,
      )
      // Com cuidado: uma resposta fora do formato (servidor de outra versão) não pode derrubar a tela.
      if (typeof plan.title === 'string') setTitle(plan.title)
      if (typeof plan.body === 'string') setBody(plan.body)
      if (info.onBase && typeof plan.branch === 'string' && plan.branch) setBranch(plan.branch)
      if (Array.isArray(plan.commits)) setCommits(plan.commits)
      // As que você já tinha marcado ficam; as do agente entram junto.
      if (plan.labels?.length) setLabels((prev) => new Set([...prev, ...plan.labels!]))
      toast.success(`${name} organizou o PR`, { description: 'Revise o que ele escreveu e abra quando estiver bom.' })
    } catch (err) {
      if (!abort.signal.aborted) toast.error(`${name} não organizou o PR`, { description: errorMessage(err) })
    } finally {
      setPlanning(null)
    }
  }

  const submit = async () => {
    if (blocked || busy) return
    setBusy(true)
    try {
      const pr = await api.githubCreatePull(machine, cwd, {
        title: title.trim(),
        body,
        base: into,
        branch: info.onBase ? head! : undefined,
        commits: planned
          ? planned.map((c) => ({ message: c.message.trim() || title.trim(), files: pathsOf(c.files.map((p) => byPath.get(p)!)) }))
          : chosen.length
            ? [{ message: message.trim() || title.trim(), files: pathsOf(chosen) }]
            : [],
        labels: [...labels],
        draft,
      })
      toast.success(`PR #${pr.number} aberto`, { description: title.trim() })
      void reloadGit(machine, cwd)
      void loadGithub(machine, cwd, true)
      onCreated({ number: pr.number, title: title.trim() })
    } catch (err) {
      toast.error('O PR não abriu', { description: errorMessage(err) })
      // A branch ou o commit podem ter saído antes do erro: a tela mostra o estado de agora.
      load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell
      repo={info.repo}
      loading={loading}
      onReload={load}
      actions={
        planning ? (
          <>
            <span className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> {planning.name} está organizando o PR…
            </span>
            <Button variant="ghost" size="sm" onClick={() => planning.abort.abort()} title="Parar o agente">
              <Square /> Parar
            </Button>
          </>
        ) : (
          <AgentMenu machine={machine} disabled={busy} onRun={(agent, model, effort) => void organize(agent, model, effort)} />
        )
      }
    >
      {info.existing && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-foreground/[0.04] px-4 py-3 text-sm">
          <span className="min-w-0 flex-1">
            A branch {info.branch} já tem um PR aberto: <span className="font-medium">#{info.existing.number}</span> {info.existing.title}
          </span>
          <Button size="sm" variant="secondary" onClick={() => onCreated({ number: info.existing!.number, title: info.existing!.title })}>
            Ver o PR
          </Button>
        </div>
      )}

      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        readOnly={planning !== null}
        placeholder="Título do PR"
        aria-label="Título do PR"
        autoFocus
        className="mt-4 h-auto border-0 bg-transparent px-0 py-1 text-2xl font-semibold shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-0 md:text-2xl dark:bg-transparent"
      />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <GitBranch className="size-3.5 shrink-0" />
          {head ? <BranchChip name={head} /> : <span className="italic">branch nova</span>}
          <span aria-label="para">→</span>
          <BranchChip name={into} />
        </span>
        <span>
          {chosen.length} de {info.files.length} {info.files.length === 1 ? 'arquivo' : 'arquivos'} · {info.commits.length}{' '}
          {info.commits.length === 1 ? 'commit' : 'commits'} na branch
        </span>
      </div>

      {/* Numa coluna só, o "Abrir PR" e de onde para onde vêm primeiro; lado a lado, ficam à direita. */}
      <div className="mt-6 grid gap-x-8 gap-y-8 @4xl:grid-cols-[minmax(0,1fr)_21rem]">
        <aside className="min-w-0 space-y-6 @4xl:col-start-2 @4xl:row-start-1">
          <div className="space-y-3 rounded-2xl bg-foreground/[0.03] p-4">
            <p className="text-sm text-muted-foreground">{blocked ?? plan}</p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={draft} onCheckedChange={(v) => setDraft(v === true)} />
              Abrir como rascunho
            </label>
            <Button className="w-full" disabled={blocked !== null || busy || info.existing !== null} onClick={() => void submit()}>
              {busy ? <Loader2 className="animate-spin" /> : <GitPullRequestCreate />}
              {draft ? 'Abrir rascunho' : 'Abrir PR'}
            </Button>
          </div>

          {info.onBase && (
            <Section title="Branch nova">
              <Input
                value={head ?? ''}
                onChange={(e) => setBranch(e.target.value)}
                placeholder={`${info.viewer}/feat-algo`}
                aria-label="Nome da branch nova"
                spellCheck={false}
                className="h-8 font-mono text-xs md:text-xs"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Sai da {info.branch}, levando os arquivos marcados. {branch === null ? 'O nome segue o título.' : ''}
              </p>
            </Section>
          )}

          <Section title="Entra em">
            <Select value={into} onValueChange={setBase}>
              <SelectTrigger size="sm" className="w-full font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {info.bases.map((b) => (
                  <SelectItem key={b} value={b} className="font-mono text-xs">
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Section>

          {!planned && chosen.length > 0 && (
            <Section title="Mensagem do commit">
              <Input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={title.trim() || 'A mesma do título'}
                aria-label="Mensagem do commit"
                className="h-8 text-xs md:text-xs"
              />
            </Section>
          )}

          <Section
            title="Etiquetas"
            action={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Escolher as etiquetas"
                    title="Escolher as etiquetas"
                    className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  >
                    <Tag className="size-3" /> Escolher
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
                  <DropdownMenuLabel>Etiquetas do repositório</DropdownMenuLabel>
                  {info.labels.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">O repositório não tem etiquetas.</p>}
                  {info.labels.map((l) => (
                    <DropdownMenuCheckboxItem
                      key={l.name}
                      checked={labels.has(l.name)}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(on) =>
                        setLabels((prev) => {
                          const next = new Set(prev)
                          if (on) next.add(l.name)
                          else next.delete(l.name)
                          return next
                        })
                      }
                    >
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: `#${l.color}` }} />
                      <span className="truncate">{l.name}</span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            }
          >
            {labels.size ? (
              <div className="flex flex-wrap gap-1.5">
                <Labels labels={info.labels.filter((l) => labels.has(l.name))} />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Nenhuma.</p>
            )}
          </Section>
        </aside>
        <main className="min-w-0 space-y-8 @4xl:col-start-1 @4xl:row-start-1">
          <MarkdownEditor value={body} onChange={setBody} placeholder="O que muda, por quê e como testar" readOnly={planning !== null} />

          {planned ? (
            <Section
              title={`Commits que vão · ${planned.length}`}
              action={
                <button
                  type="button"
                  onClick={() => {
                    setPicked(new Set(chosen.map((f) => f.path)))
                    setCommits(null)
                  }}
                  className="rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                >
                  Juntar num commit só
                </button>
              }
            >
              <div className="space-y-3">
                {planned.map((c, i) => (
                  <div key={i} className="rounded-2xl bg-foreground/[0.03] p-2">
                    <Textarea
                      value={c.message}
                      onChange={(e) => setCommits(planned.map((x, k) => (k === i ? { ...x, message: e.target.value } : x)))}
                      rows={Math.min(6, c.message.split('\n').length)}
                      aria-label={`Mensagem do commit ${i + 1}`}
                      className="max-h-40 min-h-0 resize-y overflow-y-auto rounded-xl border-0 bg-transparent px-2 py-1 font-mono text-xs shadow-none focus-visible:ring-0 md:text-xs dark:bg-transparent"
                    />
                    <ul className="mt-1 space-y-0.5">
                      {c.files.map((p) => (
                        <FileRow key={p} file={byPath.get(p)!} checked onToggle={() => moveFile(p)} machine={machine} cwd={cwd} />
                      ))}
                    </ul>
                  </div>
                ))}
                {loose.length > 0 && (
                  <div className="px-2">
                    <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <X className="size-3" /> Fora do PR · {loose.length} (marcar põe no último commit)
                    </p>
                    <ul className="-mx-2 space-y-0.5">
                      {loose.map((f) => (
                        <FileRow key={f.path} file={f} checked={false} onToggle={() => moveFile(f.path)} machine={machine} cwd={cwd} />
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </Section>
          ) : (
            <Section
              title={`Arquivos que vão · ${chosen.length} de ${info.files.length}`}
              action={
                info.files.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setPicked(new Set(all ? [] : info.files.map((f) => f.path)))}
                    className="rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  >
                    {all ? 'Desmarcar todos' : 'Marcar todos'}
                  </button>
                )
              }
            >
              {info.files.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nada sem commit: o PR leva só os commits da branch.</p>
              ) : (
                <ul className="space-y-0.5">
                  {info.files.map((f) => (
                    <FileRow key={f.path} file={f} checked={picked?.has(f.path) ?? false} onToggle={() => toggle(f.path)} machine={machine} cwd={cwd} />
                  ))}
                </ul>
              )}
            </Section>
          )}

          {info.commits.length > 0 && (
            <Section title={`Já na branch · ${info.commits.length} ${info.commits.length === 1 ? 'commit' : 'commits'}`}>
              <ul className="space-y-0.5">
                {info.commits.map((c) => (
                  <li key={c.sha} className="flex min-w-0 items-center gap-2.5 px-2 py-1">
                    <span className="shrink-0 rounded-md bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{c.short}</span>
                    <span className="min-w-0 truncate text-[13px]">{c.headline}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </main>
      </div>
    </Shell>
  )
}

/** A moldura da aba: o topo com o repositório, o agente e o reler, e a coluna centrada. */
function Shell({
  repo,
  loading,
  onReload,
  actions,
  children,
}: {
  repo: string | null
  loading: boolean
  onReload: () => void
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="absolute inset-0 overflow-y-auto bg-background">
      <div className="@container mx-auto w-full max-w-6xl px-6 pt-5 pb-16 max-sm:px-4">
        <div className="flex items-center gap-1">
          <span className={cn('min-w-0 flex-1 truncate text-xs text-muted-foreground')}>Novo PR{repo && ` · ${repo}`}</span>
          {actions}
          <Button variant="ghost" size="icon-sm" onClick={onReload} disabled={loading} aria-label="Reler" title="Reler o que mudou no projeto">
            <RefreshCw className={cn(loading && 'animate-spin')} />
          </Button>
        </div>
        {children}
      </div>
    </div>
  )
}
