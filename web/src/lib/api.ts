import { pinRejected } from './lock'
import { HOME, baseOf, machineOf } from './machines'
import { authHeader, withToken } from './pin-tokens'
import type {
  Activity,
  AttachmentPayload,
  CommandInfo,
  Habilidade,
  HabilidadeList,
  ClaudeSetup,
  ContextUsage,
  DiffSide,
  FileView,
  FolderListing,
  GithubInfo,
  GithubAction,
  InboxAction,
  InboxItemState,
  InboxPayload,
  GithubItem,
  GitStatus,
  GitSummary,
  LoggedEvent,
  McpScope,
  MemoryList,
  MemoryRef,
  ModelOption,
  OfficeRoom,
  PushPrefs,
  RunOptions,
  SessionCost,
  Team,
  TeamInput,
  Todo,
  TodoFile,
  TreeEntry,
  UpdateStatus,
  WakaToday,
  Workspace,
  WorkspaceFile,
  WorkspaceInput,
  WorktreeStatus,
  SearchResult,
} from './types'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error ?? `HTTP ${status}`))
    this.status = status
    this.code = String(body.error ?? 'http_error')
    this.details = body
  }
}

/** `fetch` com o token do PIN da máquina; recusado, destrava ela de novo (ver lock.ts) e tenta mais uma vez. */
async function send(url: string, init: RequestInit, retry = true): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...init.headers, ...authHeader(url) } })
  if (res.status !== 401 || !retry) return res
  const body = (await res.clone().json().catch(() => ({}))) as { error?: string }
  if (body.error === 'pin_required' && (await pinRejected(url))) return send(url, init, false)
  return res
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await send(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new ApiError(res.status, data)
  return data as T
}

const post = <T = { ok: true }>(path: string, body: unknown = {}, signal?: AbortSignal) => request<T>('POST', path, body, signal)
// Cada conversa vai para a máquina dela; o resto, para a máquina pedida (ver machines.ts).
const sid = (id: string) => `${baseOf(machineOf(id))}/api/sessions/${encodeURIComponent(id)}`
const at = (machine: string) => `${baseOf(machine)}/api`
const project = (cwd: string, path?: string) =>
  `cwd=${encodeURIComponent(cwd)}${path !== undefined ? `&path=${encodeURIComponent(path)}` : ''}`

// Os endereços abaixo vão em `<img>` e links, que não mandam cabeçalho: o token do PIN segue na URL.
/** Os avisos de que o arquivo aberto no editor mudou no disco (ver /ws/file no servidor). */
export function fileSocketUrl(m: string, cwd: string, path: string): string {
  const base = baseOf(m)
  const origin = base ? base.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
  return withToken(`${origin}/ws/file?${project(cwd, path)}`)
}
/** Arquivo do projeto como está (imagens, PDF), para abrir no navegador. */
export const fileRawUrl = (m: string, cwd: string, path: string) => withToken(`${at(m)}/file/raw?${project(cwd, path)}`)
/**
 * A marca do projeto (a escolhida no app ou a do repositório, em 128 px); 404 sem uma (ver ProjectMark).
 * `version` muda quando ela é trocada neste aparelho, para a imagem nova entrar na hora.
 */
export const projectIconUrl = (m: string, cwd: string, version = 0) =>
  withToken(`${at(m)}/project-icon?${project(cwd)}${version ? `&v=${version}` : ''}`)
/** Um anexo de um item do TODO, para ver (imagem) ou baixar. */
export const workspaceFileUrl = (m: string, id: string, file: WorkspaceFile) =>
  withToken(`${at(m)}/workspaces/${encodeURIComponent(id)}/files/${encodeURIComponent(file.id)}?type=${encodeURIComponent(file.mediaType)}`)
export const todoFileUrl = (m: string, file: { id: string; mediaType: string }) =>
  withToken(`${at(m)}/todos/files/${encodeURIComponent(file.id)}?type=${encodeURIComponent(file.mediaType)}`)

export const api = {
  health: (m: string) =>
    request<{ ok: boolean; name?: string; tailnetHost: string | null; startedAt: number; home: string }>('GET', `${at(m)}/health`),
  projects: (m: string) => request<string[]>('GET', `${at(m)}/projects`),
  /** Git de cada projeto; `fetch` consulta antes o remoto (mais lento). */
  projectsGit: (m: string, fetch = false) =>
    request<Record<string, GitSummary>>('GET', `${at(m)}/projects/git${fetch ? '?fetch=1' : ''}`),
  /** As raízes de projetos (pasta nova vai na primeira) e as pastas adicionadas à mão. */
  projectSources: (m: string) => request<{ roots: string[]; added: string[] }>('GET', `${at(m)}/projects/sources`),
  createProject: (m: string, name: string, git: boolean) => post<{ path: string }>(`${at(m)}/projects`, { name, git }),
  addProject: (m: string, path: string) => post<{ path: string }>(`${at(m)}/projects/add`, { path }),
  /** De onde vem a marca do projeto (escolhida no app ou do repositório) e se o repositório tem uma. */
  projectIconInfo: (m: string, cwd: string) =>
    request<{ source: 'custom' | 'repo' | null; repo: boolean }>('GET', `${at(m)}/project-icon/info?${project(cwd)}`),
  setProjectIcon: (m: string, cwd: string, data: string) => post(`${at(m)}/project-icon`, { cwd, data }),
  removeProjectIcon: (m: string, cwd: string) => post(`${at(m)}/project-icon/remove`, { cwd }),
  removeProject: (m: string, path: string) => post(`${at(m)}/projects/remove`, { path }),
  /** As subpastas de uma pasta do PC (sem `path`, a pasta pessoal). */
  folders: (m: string, path?: string) =>
    request<FolderListing>('GET', `${at(m)}/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  /** A salinha: o que cada claudinho de cada conversa aberta faz agora. */
  office: (m: string) => request<OfficeRoom[]>('GET', `${at(m)}/office`),
  /** Uso por dia para a home (grid do ano, gráficos, projetos). */
  /** Com `cwd`, só o uso daquele projeto (o hub do projeto). */
  activity: (m: string, cwd?: string) => request<Activity>('GET', `${at(m)}/activity${cwd ? `?${project(cwd)}` : ''}`),
  /** Com `session`, as habilidades do cald desligadas nela ficam de fora. */
  commands: (m: string, cwd: string, session?: string) =>
    request<CommandInfo[]>('GET', `${at(m)}/commands?cwd=${encodeURIComponent(cwd)}${session ? `&session=${encodeURIComponent(session)}` : ''}`),
  habilidades: (m: string, cwd?: string) => request<HabilidadeList>('GET', `${at(m)}/habilidades${cwd ? `?${project(cwd)}` : ''}`),
  saveHabilidade: (m: string, h: { id?: string; name: string; description: string; body: string; project: string | null }) => post<Habilidade>(`${at(m)}/habilidades`, h),
  trashHabilidade: (m: string, id: string) => post(`${at(m)}/habilidades/trash`, { id }),
  restoreHabilidade: (m: string, id: string) => post<Habilidade>(`${at(m)}/habilidades/restore`, { id }),
  purgeHabilidade: (m: string, id: string) => post(`${at(m)}/habilidades/purge`, { id }),
  /** As habilidades desligadas numa conversa; o resto vale nela. */
  sessionHabilidades: (id: string) => request<{ off: string[] }>('GET', `${sid(id)}/habilidades`),
  setSessionHabilidade: (id: string, habilidade: string, on: boolean) => post<{ off: string[] }>(`${sid(id)}/habilidades`, { id: habilidade, on }),
  files: (m: string, cwd: string, q: string) =>
    request<string[]>('GET', `${at(m)}/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`),
  history: (id: string, limit = 300) => request<LoggedEvent[]>('GET', `${sid(id)}/history?limit=${limit}`),
  /** Ditado pelo Whisper na máquina desta página (navegadores sem reconhecimento de voz). `audio`: WAV em base64. */
  transcribeStatus: () => request<{ available: boolean }>('GET', `${at(HOME)}/transcribe`),
  transcribe: (audio: string) => post<{ text: string }>(`${at(HOME)}/transcribe`, { audio }),
  /** Leitura em voz alta pelo Piper na máquina desta página (no PC, onde a voz do navegador é robótica). */
  speakStatus: () => request<{ available: boolean }>('GET', `${at(HOME)}/speak`),
  /** Uma frase falada pelo Piper, em WAV. */
  speak: async (text: string): Promise<Blob> => {
    const res = await send(`${at(HOME)}/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))) as Record<string, unknown>)
    return res.blob()
  },
  /** O que um subagente fez, do transcript salvo no PC; `agentId`, se já se sabe, poupa a busca. */
  agent: (id: string, toolUseId: string, agentId?: string) =>
    request<LoggedEvent[]>('GET', `${sid(id)}/agents/${encodeURIComponent(toolUseId)}${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`),

  /** `worktree`: a conversa abre num worktree novo do projeto, separada das outras dele. */
  create: (
    m: string,
    body: RunOptions & {
      cwd?: string
      prompt: string
      title?: string
      attachments?: AttachmentPayload[]
      teamId?: string
      workspaceId?: string
      worktree?: boolean
    },
  ) =>
    post<{ sessionId: string }>(`${at(m)}/sessions`, body),
  /** O worktree de uma conversa (ver server/src/worktrees.ts): branch, origem e o que falta trazer. */
  worktree: (m: string, cwd: string) => request<WorktreeStatus>('GET', `${at(m)}/worktree?${project(cwd)}`),
  /** "Trazer": merge da branch do worktree na de origem, no checkout principal. */
  mergeWorktree: (m: string, cwd: string) => post<{ commits: number }>(`${at(m)}/worktree/merge`, { cwd }),
  /** `force`: remove mesmo com commits que não voltaram ou mudanças sem commit. */
  removeWorktree: (m: string, cwd: string, force = false) => post(`${at(m)}/worktree/remove`, { cwd, force }),
  /** A memória do Claude Code (ver server/src/memory.ts): de todos os projetos ou, com `cwd`, de um. */
  memory: (m: string, cwd?: string) => request<MemoryList>('GET', `${at(m)}/memory${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  saveMemory: (m: string, ref: MemoryRef & { description: string; body: string; mtime: number }) => request<{ mtime: number }>('PUT', `${at(m)}/memory`, ref),
  trashMemories: (m: string, items: MemoryRef[]) => post<{ ids: string[] }>(`${at(m)}/memory/trash`, { items }),
  restoreMemories: (m: string, ids: string[]) => post(`${at(m)}/memory/restore`, { ids }),
  /** Sem `ids`, a lixeira inteira. */
  emptyMemoryTrash: (m: string, ids?: string[]) => post(`${at(m)}/memory/trash/empty`, ids ? { ids } : {}),
  /** Skills, agentes e servidores MCP de uma pasta (ver server/src/claude-config.ts); sem `cwd`, os que valem em todas. */
  claudeSetup: (m: string, cwd?: string, refresh = false) => {
    const params = new URLSearchParams()
    if (cwd) params.set('cwd', cwd)
    if (refresh) params.set('refresh', '1')
    const query = params.toString()
    return request<ClaudeSetup>('GET', `${at(m)}/claude/setup${query ? `?${query}` : ''}`)
  },
  claudeText: (m: string, path: string, cwd?: string) =>
    request<{ text: string }>('GET', `${at(m)}/claude/text?${new URLSearchParams({ path, ...(cwd ? { cwd } : {}) })}`),
  /** Sem `cwd`: na pasta pessoal (o servidor MCP) ou em todo projeto (a skill). */
  toggleMcp: (m: string, cwd: string | undefined, name: string, enabled: boolean) => post(`${at(m)}/claude/mcp`, { ...(cwd ? { cwd } : {}), name, enabled }),
  toggleSkill: (m: string, cwd: string | undefined, name: string, enabled: boolean) => post(`${at(m)}/claude/skill`, { ...(cwd ? { cwd } : {}), name, enabled }),
  togglePlugin: (m: string, key: string, enabled: boolean) => post(`${at(m)}/claude/plugin`, { key, enabled }),
  trashClaudeItem: (m: string, cwd: string | undefined, path: string) => post<{ id: string }>(`${at(m)}/claude/trash`, { ...(cwd ? { cwd } : {}), path }),
  trashMcp: (m: string, mcp: { name: string; scope: McpScope; project?: string }) => post<{ id: string }>(`${at(m)}/claude/trash`, { mcp }),
  restoreClaude: (m: string, ids: string[]) => post(`${at(m)}/claude/restore`, { ids }),
  emptyClaudeTrash: (m: string, ids?: string[]) => post(`${at(m)}/claude/trash/empty`, ids ? { ids } : {}),
  /** Times de agentes (ver server/src/teams.ts). */
  teams: (m: string) => request<Team[]>('GET', `${at(m)}/teams`),
  saveTeam: (m: string, team: TeamInput) => post<Team>(`${at(m)}/teams`, team),
  deleteTeam: (m: string, id: string) => post(`${at(m)}/teams/${encodeURIComponent(id)}/delete`),
  /** A inbox da máquina (ver server/src/inbox.ts); `refresh` busca de novo no GitHub e no remoto. */
  inbox: (m: string, refresh = false) => request<InboxPayload>('GET', `${at(m)}/inbox${refresh ? '?refresh=1' : ''}`),
  inboxState: (m: string) => request<Record<string, InboxItemState>>('GET', `${at(m)}/inbox/state`),
  setInboxState: (m: string, actions: InboxAction[]) => post<Record<string, InboxItemState>>(`${at(m)}/inbox/state`, { actions }),
  /** Workspaces (ver server/src/workspaces.ts). */
  workspaces: (m: string) => request<Workspace[]>('GET', `${at(m)}/workspaces`),
  saveWorkspace: (m: string, ws: WorkspaceInput) => post<Workspace>(`${at(m)}/workspaces`, ws),
  deleteWorkspace: (m: string, id: string) => post(`${at(m)}/workspaces/${encodeURIComponent(id)}/delete`),
  addWorkspaceFile: (m: string, id: string, file: { name: string; mediaType: string; data: string }) =>
    post<Workspace>(`${at(m)}/workspaces/${encodeURIComponent(id)}/files`, file),
  removeWorkspaceFile: (m: string, id: string, fileId: string) =>
    post<Workspace>(`${at(m)}/workspaces/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}/delete`),
  /** Troca o time de uma conversa que já começou (`null` tira); aberta no painel, ela é retomada com ele. */
  setTeam: (id: string, teamId: string | null) => post(`${sid(id)}/team`, { teamId }),
  /** `at`: entrada do log onde cortar, para bifurcar no meio da conversa em vez de no fim. */
  open: (id: string, body: RunOptions & { fork?: boolean; at?: string } = {}) => post<{ sessionId: string }>(`${sid(id)}/open`, body),
  /** Retoma aqui para mandar uma mensagem; aberta e ociosa no terminal do PC, ela é encerrada lá antes. */
  takeover: (id: string, body: RunOptions = {}) => post<{ sessionId: string }>(`${sid(id)}/takeover`, body),
  release: (id: string) => post<{ resumeCommand: string }>(`${sid(id)}/release`),

  /** `clientId` identifica a mensagem da fila: reenviar a mesma não repete o turno. */
  send: (id: string, body: { text: string; attachments?: AttachmentPayload[]; clientId?: string }, signal?: AbortSignal) =>
    post(`${sid(id)}/messages`, body, signal),
  interrupt: (id: string) => post(`${sid(id)}/interrupt`),
  pin: (id: string, pinned: boolean) => post(`${sid(id)}/pin`, { pinned }),
  /** O nome do claudinho da conversa; `null` volta ao sorteado. */
  claudinhoName: (id: string, name: string | null) => post(`${sid(id)}/claudinho`, { name }),
  remove: (id: string) => post(`${sid(id)}/delete`),
  tree: (m: string, cwd: string, path: string) => request<TreeEntry[]>('GET', `${at(m)}/tree?${project(cwd, path)}`),
  file: (m: string, cwd: string, path: string) => request<FileView>('GET', `${at(m)}/file?${project(cwd, path)}`),
  /** Grava o texto do editor; recusa com `file_changed` se o arquivo não é mais o de `base`, a não ser com `force`. */
  saveFile: (m: string, cwd: string, path: string, content: string, base: string, force = false) =>
    post<{ hash: string; size: number }>(`${at(m)}/file/save`, { cwd, path, content, base, force }),
  /** Busca texto nos arquivos do projeto (o ripgrep, no PC). */
  search: (m: string, cwd: string, q: string, o: { regex: boolean; caseSensitive: boolean; word: boolean }, signal?: AbortSignal) =>
    request<SearchResult>(
      'GET',
      `${at(m)}/search?${project(cwd)}&q=${encodeURIComponent(q)}${o.regex ? '&regex=1' : ''}${o.caseSensitive ? '&case=1' : ''}${o.word ? '&word=1' : ''}`,
      undefined,
      signal,
    ),
  /** O arquivo no último commit; `''` se é novo, `null` fora do git (ou ignorado por ele). */
  gitBase: (m: string, cwd: string, path: string) => request<{ content: string | null }>('GET', `${at(m)}/git/base?${project(cwd, path)}`),
  git: (m: string, cwd: string) => request<GitStatus | null>('GET', `${at(m)}/git?${project(cwd)}`),
  /** Quanto você já codou hoje; `null` quando a máquina não tem o wakatime-cli. */
  wakatimeToday: (m: string) => request<{ today: WakaToday | null }>('GET', `${at(m)}/wakatime`),
  /** Avisa que você está mexendo no painel, para o tempo contar no WakaTime (ver lib/wakatime.ts). */
  wakatime: (m: string, body: { cwd: string; path?: string; category?: 'code reviewing' | 'planning' }) => post(`${at(m)}/wakatime`, body),
  gitDiff: (m: string, cwd: string, path: string, side?: DiffSide) =>
    request<{ diff: string }>('GET', `${at(m)}/git/diff?${project(cwd, path)}${side ? `&side=${side}` : ''}`),
  gitStage: (m: string, cwd: string, paths: string[]) => post(`${at(m)}/git/stage`, { cwd, paths }),
  gitUnstage: (m: string, cwd: string, paths: string[]) => post(`${at(m)}/git/unstage`, { cwd, paths }),
  /** Commit do que está staged; `all` prepara tudo antes. */
  gitCommit: (m: string, cwd: string, message: string, all: boolean) => post<{ sha: string }>(`${at(m)}/git/commit`, { cwd, message, all }),
  /** Traz o que chegou do remoto (só avançando) e envia o que falta; sem upstream, publica a branch. */
  gitSync: (m: string, cwd: string) => post(`${at(m)}/git/sync`, { cwd }),
  /** A mensagem do próximo commit (o staged, ou tudo com `all`) e um nome de branch, pelo Claude. */
  gitSuggest: (m: string, cwd: string, all: boolean) => post<{ message: string; branch: string }>(`${at(m)}/git/suggest`, { cwd, all }),
  /** Cria a branch e passa para ela, levando as alterações. */
  gitBranch: (m: string, cwd: string, name: string) => post(`${at(m)}/git/branch`, { cwd, name }),
  /** PRs e issues abertos no GitHub; o servidor guarda por 2 min, e `refresh` pede de novo (ver server/src/github.ts). */
  github: (m: string, cwd: string, refresh = false) =>
    request<GithubInfo>('GET', `${at(m)}/github?${project(cwd)}${refresh ? '&refresh=1' : ''}`),
  /** Uma issue ou um PR inteiro, com o mesmo cache das listas. */
  githubItem: (m: string, cwd: string, kind: 'issue' | 'pr', number: number, refresh = false) =>
    request<GithubItem>('GET', `${at(m)}/github/item?${project(cwd)}&kind=${kind}&number=${number}${refresh ? '&refresh=1' : ''}`),
  /** Faz a ação e devolve o item como ficou (ver server/src/github.ts). */
  githubAct: (m: string, cwd: string, kind: 'issue' | 'pr', number: number, action: GithubAction) =>
    request<GithubItem>('POST', `${at(m)}/github/action`, { cwd, kind, number, action }),
  todos: (m: string, cwd: string) => request<{ items: Todo[] }>('GET', `${at(m)}/todos?${project(cwd)}`),
  /** A lista inteira, como ficou depois da mudança. */
  saveTodos: (m: string, cwd: string, items: Todo[]) => post<{ items: Todo[] }>(`${at(m)}/todos`, { cwd, items }),
  /** Um anexo de um item do TODO; o item leva o que volta. */
  uploadTodoFile: (m: string, cwd: string, file: { name: string; mediaType: string; data: string }) =>
    post<TodoFile>(`${at(m)}/todos/files`, { cwd, ...file }),
  update: (m: string) => request<UpdateStatus>('GET', `${at(m)}/update`),
  startUpdate: (m: string) => post<UpdateStatus>(`${at(m)}/update`),
  restartNow: (m: string) => post(`${at(m)}/update/restart`),
  rename: (id: string, title: string) => post(`${sid(id)}/rename`, { title }),
  settings: (id: string, body: RunOptions) => post(`${sid(id)}/settings`, body),
  context: (id: string) => request<ContextUsage>('GET', `${sid(id)}/context`),
  /** Tokens e custo estimado da conversa inteira, lidos do transcript salvo no PC. */
  cost: (id: string) => request<SessionCost>('GET', `${sid(id)}/cost`),
  models: (m: string) => request<ModelOption[]>('GET', `${at(m)}/models`),
  /** Tarefa em segundo plano (monitor, comando): o fim da saída e parar. */
  taskOutput: (id: string, taskId: string) =>
    request<{ output: string; totalBytes: number }>('GET', `${sid(id)}/tasks/${encodeURIComponent(taskId)}/output`),
  stopTask: (id: string, taskId: string) => post(`${sid(id)}/tasks/${encodeURIComponent(taskId)}/stop`),
  approve: (id: string, requestId: string, body: { allow: boolean; always?: boolean; message?: string }) =>
    post(`${sid(id)}/approvals/${requestId}`, body),
  answer: (id: string, requestId: string, body: { answers?: Record<string, string>; decline?: boolean }) =>
    post(`${sid(id)}/questions/${requestId}`, body),

  pushKey: () => request<{ publicKey: string }>('GET', '/api/push/key'),
  pushSubscribe: (subscription: PushSubscriptionJSON, prefs: PushPrefs) => post('/api/push/subscribe', { subscription, prefs }),
  pushUnsubscribe: (endpoint: string) => post('/api/push/unsubscribe', { endpoint }),
  pushTest: (endpoint: string) => post('/api/push/test', { endpoint }),
}

/** Mensagens legíveis para os códigos de erro do backend. */
/**
 * Rota que o servidor do PC não tem: ele ainda roda uma versão anterior à do app (o código novo só
 * vale depois de reiniciar). Só para rotas novas: em outras, o mesmo 404 quer dizer outra coisa.
 */
export const isOutdatedServer = (err: unknown) => err instanceof ApiError && err.status === 404 && err.code === 'not_found'
export const OUTDATED_SERVER = 'O servidor do PC ainda roda a versão anterior. Reinicie o cald no PC para usar isto.'

export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : String(err)
  const status = String(err.details.status ?? '')
  switch (err.code) {
    case 'pin_required':
      return 'Essa máquina pede PIN. Destrave o app para continuar.'
    case 'busy_on_pc':
      return status === 'waiting'
        ? 'A sessão está esperando uma resposta no PC. Responda lá ou aguarde.'
        : 'A sessão está trabalhando no PC. Mande de novo quando ela parar.'
    case 'live_on_pc':
      return 'Esta sessão está aberta no PC. Feche-a lá primeiro.'
    case 'unsupported_entrypoint':
      return 'Esta sessão está aberta no VSCode. Feche-a lá para continuar daqui.'
    case 'session_busy':
      return err.details.agents
        ? 'Ainda há subagentes trabalhando. Aguarde terminarem para liberar.'
        : 'A sessão ainda está trabalhando. Interrompa ou aguarde para liberar.'
    case 'task_not_found':
      return 'Essa tarefa não está mais rodando.'
    case 'task_output_unsupported':
      return 'Esta versão do Claude Code não mostra a saída da tarefa.'
    case 'file_changed':
      return 'O arquivo mudou no disco desde que foi aberto.'
    case 'rg_unavailable':
      return 'A busca usa o ripgrep: instale o `rg` no PC (pacote ripgrep).'
    case 'invalid_search':
      return `A expressão não vale: ${String(err.details.message ?? '')}`
    case 'habilidade_exists':
      return `Já existe uma habilidade chamada ${String(err.details.name ?? '')} aí. Escolha outro nome.`
    case 'invalid_habilidade_name':
      return 'O nome vai no /cald:nome: só letras minúsculas, números e hífen, começando por letra ou número.'
    case 'invalid_habilidade_description':
      return 'Escreva a descrição: é por ela que o Claude decide quando usar a habilidade.'
    case 'habilidade_too_long':
      return 'As instruções passaram de 50 mil caracteres.'
    case 'habilidade_not_found':
      return 'Essa habilidade não existe mais.'
    case 'not_utf8':
      return 'O arquivo não está em UTF-8: salvar pelo painel trocaria os acentos.'
    case 'file_too_large':
      return 'Arquivo grande demais para editar pelo painel.'
    case 'whisper_unavailable':
      return 'O Whisper não está instalado no PC.'
    case 'invalid_image':
      return 'Essa imagem não deu para ler. Tente um PNG, JPG, WebP ou SVG.'
    case 'sharp_unavailable':
      return 'O PC não tem o sharp para converter a imagem.'
    case 'transcribe_failed':
    case 'invalid_audio':
      return 'O Whisper não conseguiu transcrever o áudio.'
    case 'transcribe_timeout':
      return 'A transcrição demorou demais. Tente um trecho mais curto.'
    case 'audio_too_long':
      return 'Gravação longa demais: até 10 minutos.'
    case 'piper_unavailable':
      return 'O Piper não está instalado no PC.'
    case 'speak_failed':
    case 'speak_timeout':
      return 'O Piper não conseguiu falar.'
    case 'github_action_failed':
      return String(err.details.message ?? 'O GitHub recusou.')
    case 'agent_not_found':
      return 'O registro deste subagente não está no PC.'
    case 'workspace_not_found':
      return 'Esse workspace não existe mais.'
    case 'workspace_name_required':
      return 'Dê um nome ao workspace.'
    case 'workspace_too_many_files':
      return `Um workspace vai até ${String(err.details.max ?? 30)} arquivos.`
    case 'unknown_project':
      return 'Essa pasta não é um projeto conhecido do PC.'
    case 'team_not_found':
      return 'Esse time não existe mais. Escolha outro.'
    case 'team_name_required':
      return 'Dê um nome ao time.'
    case 'member_name_required':
      return 'Todo membro do time precisa de um nome.'
    case 'team_too_big':
      return `Um time vai até ${String(err.details.max ?? 8)} membros.`
    case 'cwd_outside_roots':
      return 'Esse diretório está fora das pastas de projetos permitidas.'
    case 'invalid_project_name':
      return 'Use letras, números, espaço, ponto, hífen ou sublinhado, sem começar por ponto.'
    case 'project_exists':
      return 'Já existe uma pasta com esse nome.'
    case 'folder_not_found':
      return 'Essa pasta não existe no PC.'
    case 'folder_not_readable':
      return 'Sem permissão para abrir essa pasta.'
    case 'folder_not_project':
      return 'A pasta pessoal e as de cima dela não podem ser projeto. Use "Sem projeto" para a pasta pessoal.'
    case 'no_project_root':
      return 'O PC não tem uma pasta de projetos configurada (PROJECT_ROOTS).'
    case 'attachment_too_large':
      return `O anexo ${String(err.details.name ?? '')} passa de 25 MB.`
    case 'empty_message':
      return 'Escreva algo ou anexe um arquivo.'
    case 'session_exited':
    case 'not_open_in_panel':
      return 'A sessão não está mais aberta no painel.'
    case 'session_not_found':
      return 'A conversa não existe mais.'
    case 'subscription_not_found':
      return 'O PC não conhece este aparelho. Desative e ative as notificações de novo.'
    case 'update_running':
      return 'Uma atualização já está em andamento.'
    case 'update_dirty':
      return 'O repositório no PC tem mudanças não commitadas. Resolva pelo terminal.'
    case 'update_diverged':
      return 'A main do PC tem commits que não estão no GitHub. Resolva pelo terminal.'
    case 'update_busy':
      return `Espere terminar: ${((err.details.sessions as string[] | undefined) ?? []).join(', ')}.`
    case 'update_up_to_date':
      return 'O PC já está na versão mais nova.'
    case 'update_fetch_failed':
      return 'Não deu para falar com o GitHub.'
    case 'update_no_service':
      return 'O servidor não roda como serviço. Reinicie pelo terminal.'
    case 'git_failed':
      return String(err.details.message || 'O git recusou.')
    case 'worktree_dirty':
      return `O worktree tem ${String(err.details.changed)} ${err.details.changed === 1 ? 'arquivo' : 'arquivos'} sem commit. O "Trazer" leva só commits: faça o commit antes.`
    case 'nothing_to_merge':
      return 'Nada para trazer: a branch de origem já tem todos os commits do worktree.'
    case 'base_not_checked_out':
      return `O projeto está em ${String(err.details.current ?? 'nenhuma branch')}, não em ${String(err.details.base)}. Volte para ${String(err.details.base)} para trazer.`
    case 'merge_conflict':
      return `Conflito com ${String(err.details.base)} em ${((err.details.files as string[] | undefined) ?? []).join(', ') || 'alguns arquivos'}. Nada mudou no projeto: peça ao Claude para trazer ${String(err.details.base)} para o worktree e resolver.`
    case 'worktree_removed':
      return 'O worktree desta conversa foi removido. O histórico continua aqui, só para leitura.'
    case 'cwd_gone':
      return 'A pasta desta conversa não existe mais no PC.'
    case 'already_in_worktree':
      return 'Esta conversa já está num worktree.'
    case 'no_commits':
      return 'O projeto ainda não tem commits: não há de onde criar o worktree.'
    case 'worktree_needs_project':
      return 'Escolha um projeto para rodar num worktree.'
    case 'nothing_to_commit':
      return 'Nada para o commit.'
    case 'suggest_failed':
      return 'O Claude não respondeu com uma mensagem.'
    case 'suggest_timeout':
      return 'O Claude demorou demais para responder.'
    case 'invalid_branch':
      return 'Esse nome não serve para branch.'
    case 'detached_head':
      return 'Sem branch (HEAD destacado): não há para onde sincronizar.'
    case 'not_a_repository':
      return 'Esse projeto não usa git.'
    case 'memory_changed':
      return 'O Claude mudou esta memória enquanto você editava. Abra de novo para ver como ficou.'
    case 'memory_not_found':
      return 'Essa memória não existe mais.'
    case 'memory_exists':
      return `Já existe outra memória com o nome ${String(err.details.file ?? '')} nesse projeto.`
    case 'invalid_memory':
      return 'Memória inválida.'
    case 'settings_invalid':
      return `As configurações do Claude Code não abrem (${String(err.details.file ?? '')}); nada foi mudado.`
    case 'claude_cli_failed':
      return `O Claude Code recusou: ${String(err.details.message ?? '')}`
    case 'claude_exists':
      return `Já existe outro ${String(err.details.name ?? '')} no lugar: tire-o antes de restaurar.`
    case 'plugin_not_found':
      return 'Esse plugin não está instalado.'
    case 'mcp_not_found':
      return 'A configuração desse servidor não foi achada.'
    case 'probe_timeout':
      return 'O Claude Code demorou demais para responder.'
    case 'push_failed':
      return `O serviço de push recusou o aviso${err.details.status ? ` (HTTP ${String(err.details.status)})` : ''}.`
    default:
      return err.code
  }
}

/** URL de uma imagem do chat: chave no cache do PC ou data URL já pronta. */
export function imageUrl(sessionId: string, key: string): string {
  return key.startsWith('data:') ? key : withToken(`${sid(sessionId)}/images/${encodeURIComponent(key)}`)
}

/** Versão reduzida para miniaturas (o PC gera, até 512 px); a ampliada usa `imageUrl`. */
export function thumbUrl(sessionId: string, key: string): string {
  return key.startsWith('data:') ? key : withToken(`${sid(sessionId)}/images/${encodeURIComponent(key)}?thumb=1`)
}
