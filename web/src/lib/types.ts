// Espelho dos tipos do backend (server/src/events.ts e manager.ts).

export type SessionState = 'starting' | 'running' | 'waiting' | 'idle' | 'exited';
export type CatalogState = 'running' | 'waiting' | 'idle' | 'stopped';
export type PendingKind = 'approval' | 'question';
export type AgentTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';
export type AgentUsage = { tokens: number; toolUses: number; durationMs: number };
/** Tarefa em segundo plano viva (server/src/tasks.ts). `type`: local_bash (comando ou monitor), local_agent, local_workflow… */
export type BackgroundTask = {
  taskId: string;
  toolUseId?: string;
  type: string;
  description: string;
  subagentType?: string;
  startedAt: number;
};

export type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string; preview?: string }[];
};

export type PanelEvent =
  /** `images`: chaves das imagens no PC (GET /api/sessions/:id/images/:key); `clientId`: ID na fila do celular. */
  | { kind: 'user'; text: string; images?: string[]; clientId?: string }
  | { kind: 'notice'; text: string }
  /** `model` e `effort`: o modelo que escreveu a resposta e o esforço com que pensou, quando se sabe. */
  | { kind: 'assistant'; text: string; parentToolUseId?: string | null; model?: string; effort?: string }
  | { kind: 'thinking'; text: string; parentToolUseId?: string | null }
  | { kind: 'tool_use'; id: string; name: string; input: Record<string, unknown>; parentToolUseId?: string | null }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; text: string; images?: string[] }
  | { kind: 'settings'; model?: string; effort?: string | null; permissionMode?: string }
  /** Um /clear esvaziou a conversa: o que veio antes sai da tela, e ela segue do zero, com o mesmo claudinho. */
  | { kind: 'cleared' }
  | { kind: 'init'; model: string; permissionMode: string; cwd: string }
  | { kind: 'status'; status: string }
  | { kind: 'state'; state: SessionState; waitingFor?: string }
  | {
      kind: 'approval_request';
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      toolUseId?: string;
      title?: string;
      decisionReason?: string;
      blockedPath?: string;
      canAlwaysAllow: boolean;
    }
  | { kind: 'approval_resolved'; requestId: string; decision: 'allow' | 'deny' | 'cancelled' }
  | { kind: 'question_request'; requestId: string; questions: Question[] }
  | {
      kind: 'question_resolved';
      requestId: string;
      decision: 'answered' | 'declined' | 'cancelled';
      answers?: Record<string, string>;
    }
  /** Novidade de um subagente (só o que mudou), ligada à chamada da ferramenta Agent que o criou. */
  | {
      kind: 'agent';
      toolUseId: string;
      agentId?: string;
      status?: AgentTaskStatus;
      background?: boolean;
      activity?: string;
      summary?: string;
      usage?: AgentUsage;
      result?: string;
      error?: string;
    }
  /** Tarefas em segundo plano vivas, a lista inteira a cada mudança. */
  | { kind: 'tasks'; tasks: BackgroundTask[] }
  | { kind: 'result'; ok: boolean; subtype: string; durationMs: number; costUsd?: number; turns: number }
  | { kind: 'exit'; error?: string };

/** `uuid`: a entrada do log de onde o evento veio; é o ponto de corte de uma bifurcação. */
export type LoggedEvent = PanelEvent & { seq: number; ts: number; uuid?: string };

export type CatalogEntry = {
  sessionId: string;
  title: string;
  cwd?: string;
  gitBranch?: string;
  lastModified: number;
  owner: 'panel' | 'pc' | null;
  state: CatalogState;
  waitingFor?: string;
  pcKind?: 'interactive' | 'background';
  pending?: { requestId: string; kind: PendingKind }[];
  /** Subagentes trabalhando agora (só sessões do painel). */
  agents?: number;
  /** Outras tarefas em segundo plano (monitores, comandos): o turno acabou, mas o Claude vai voltar. */
  tasks?: { type: string; description: string }[];
  pinned?: boolean;
  /** De onde esta conversa bifurcou; marca a conversa na lista e põe a tarja no topo do chat. */
  forkedFrom?: { sessionId: string; title?: string };
  /** Máquina da conversa, posta pelo app ao juntar as de todas (ver machines.ts); `''` é a desta página. */
  machine?: string;
  /** O nome que você deu ao claudinho da conversa; sem ele, vale o sorteado (ver lib/claudinho.ts). */
  claudinhoName?: string;
  /** O id de onde vem o claudinho desta conversa, quando ela continua outra (um /clear). */
  look?: string;
};

export type RunOptions = {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk';
};

export type CommandInfo = { name: string; description: string; argumentHint: string; builtin: boolean }

export type AttachmentPayload = { name: string; mediaType: string; data: string; thumb?: string }

export type SystemSnapshot = {
  at: number
  cpu: { percent: number; cores: number; load: [number, number, number] }
  memory: { total: number; used: number; swapTotal: number; swapUsed: number }
  claude: { processes: number; rss: number }
  uptimeSec: number
}

export type UsageWindow = { utilization: number | null; resetsAt: string | null }

export type UsageSnapshot = {
  plan: {
    subscription: string | null
    available: boolean
    fiveHour: UsageWindow | null
    sevenDay: UsageWindow | null
    models: (UsageWindow & { name: string })[]
    extraUsage: { utilization: number | null } | null
  } | null
  planError?: string
  planAt?: number
}

export type SessionSettings = { model?: string; effort?: string | null; permissionMode?: string }

export type ContextUsage = {
  model: string
  totalTokens: number
  maxTokens: number
  autoCompactThreshold: number | null
  autoCompactEnabled: boolean
}

export type ModelOption = { value: string; resolvedModel?: string; displayName: string; efforts: string[] }

/** Tokens e custo de um modelo na conversa (ver server/src/session-cost.ts); `costUsd` null: sem preço na tabela. */
export type ModelSpend = {
  model: string
  requests: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  costUsd: number | null
}

/** Consumo da conversa inteira, subagentes incluídos, a preço de tabela da API. */
export type SessionCost = {
  costUsd: number
  subagentsUsd: number
  models: ModelSpend[]
  context: { model: string; tokens: number; window: number | null } | null
}

export type TreeEntry = { name: string; path: string; type: 'dir' | 'file'; size?: number; ignored?: boolean }

export type FileView =
  | { kind: 'text'; size: number; content: string; truncated: boolean }
  | { kind: 'image' | 'pdf' | 'binary' | 'large'; size: number }

/** Linhas a mais e a menos; `null` em arquivo binário. */
export type LineCount = { additions: number | null; deletions: number | null }

export type GitFile = {
  path: string
  from?: string
  index: string
  worktree: string
  untracked: boolean
  /** Staged e não staged somados. */
  additions: number | null
  deletions: number | null
  /** Cada lado separado; `null` se o lado não mudou. */
  staged: LineCount | null
  unstaged: LineCount | null
}

/** Um lado só do diff: o que está staged ou o que ainda não está. Sem lado, contra o último commit. */
export type DiffSide = 'staged' | 'unstaged'

/** Atualizar o PC pelo celular (ver server/src/updater.ts). */
export type UpdateStep = 'fetch' | 'switch' | 'merge' | 'install' | 'build' | 'restart'
export type UpdateStatus = {
  branch: string | null
  target: string
  head: { sha: string; subject: string }
  incoming: { sha: string; subject: string }[]
  behind: number
  ahead: number
  dirty: boolean
  busy: string[]
  canRestart: boolean
  job: { step: UpdateStep; startedAt: number; error?: string; log?: string; done?: boolean } | null
  fetchError?: string
}

export type GitStatus = {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFile[]
  /** Página do repositório no navegador (ex.: https://github.com/dono/repo). */
  remote: string | null
}

/** Resumo do git de um projeto, para a lista de projetos (ver server/src/git.ts). */
export type GitSummary = {
  branch: string | null
  upstream: string | null
  changed: number
  ahead: number
  behind: number
}


/** PRs e issues abertos do repositório do projeto no GitHub (ver server/src/github.ts). */
export type GithubLabel = { name: string; color: string }

export type GithubIssue = {
  number: number
  title: string
  url: string
  author: string | null
  updatedAt: string
  comments: number
  labels: GithubLabel[]
}

export type GithubPull = {
  number: number
  title: string
  url: string
  author: string | null
  updatedAt: string
  draft: boolean
  branch: string
  review: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  checks: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null
}

/** Quanto sobra da cota da API do GitHub da conta, lido junto com cada consulta. */
export type GithubQuota = { remaining: number; limit: number; resetAt: string }

export type GithubInfo =
  | {
      ok: true
      repo: string
      pulls: GithubPull[]
      pullCount: number
      issues: GithubIssue[]
      issueCount: number
      fetchedAt: number
      quota?: GithubQuota | null
    }
  | { ok: false; reason: 'no_remote' | 'not_github' | 'no_gh' | 'gh_auth' | 'error'; message?: string; fetchedAt: number }

/** Uma issue ou um PR inteiro, para a aba de análise (ver server/src/github.ts). */
export type GithubComment = { author: string | null; body: string; createdAt: string; url: string }

export type GithubReview = {
  author: string | null
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  body: string
  submittedAt: string | null
}

export type GithubCheck = { name: string; result: 'success' | 'failure' | 'pending' | 'neutral'; url: string | null }

export type GithubFile = { path: string; additions: number; deletions: number; change: string }

type GithubItemBase = {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  author: string | null
  /** Quem está logado no `gh` do PC abriu este: o GitHub não deixa aprovar o próprio PR. */
  mine: boolean
  assignees: string[]
  createdAt: string
  updatedAt: string
  body: string
  labels: GithubLabel[]
  comments: GithubComment[]
  commentCount: number
}

export type GithubIssueDetail = GithubItemBase & { kind: 'issue'; stateReason: string | null }

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export type GithubPullDetail = GithubItemBase & {
  kind: 'pr'
  draft: boolean
  base: string
  branch: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  review: GithubPull['review']
  additions: number
  deletions: number
  changedFiles: number
  commitCount: number
  checks: GithubCheck[]
  files: GithubFile[]
  reviews: GithubReview[]
  mergeState: string
  crossRepo: boolean
  mergeMethods: MergeMethod[]
  defaultMethod: MergeMethod
  deleteBranchOnMerge: boolean
}

/** `viewer`: o login do `gh` do PC; `repoLabels`: as etiquetas do repositório, para pôr e tirar. */
export type GithubItem =
  | {
      ok: true
      repo: string
      viewer: string
      repoLabels: GithubLabel[]
      item: GithubIssueDetail | GithubPullDetail
      fetchedAt: number
      quota?: GithubQuota | null
      /** Só no app: o servidor é de antes das ações (falta reiniciar), e elas ficam escondidas. */
      outdated?: boolean
    }
  | Extract<GithubInfo, { ok: false }>

/** Uma ação numa issue ou num PR, pelo `gh` do PC (ver server/src/github.ts). `review`, `merge` e `draft` são de PR. */
export type GithubAction =
  | { type: 'comment'; body: string }
  | { type: 'labels'; add: string[]; remove: string[] }
  | { type: 'state'; open: boolean; reason?: 'completed' | 'not planned' }
  | { type: 'assign'; me: boolean }
  | { type: 'review'; event: 'approve' | 'request-changes' | 'comment'; body?: string }
  | { type: 'merge'; method: MergeMethod; deleteBranch: boolean }
  | { type: 'draft'; draft: boolean }

/** Um item do TODO do projeto, a lista simples do próprio Claude Remote (ver server/src/todos.ts). */
export type Todo = { id: string; text: string; done: boolean; createdAt: number }

/** Quanto você já codou hoje pelo WakaTime (ver server/src/wakatime.ts). */
export type WakaToday = { seconds: number; text: string; goalHours: number }

/** O que este aparelho quer receber além de perguntas, aprovações e erros, que sempre avisam. */
export type PushPrefs = { done: boolean; pc: boolean }

/** Aviso que o PC manda ao service worker (server/src/push.ts). */
export type PushPayload = { title: string; body: string; tag: string; url: string; ts: number }

/** Uso de um dia, lido dos registros do PC (ver server/src/activity.ts). */
export type ActivityDay = { date: string; sessions: number; remote: number; prompts: number; costUsd: number; tokens: number }
export type ActivityProject = { cwd: string; sessions: number; prompts: number; costUsd: number; tokens: number }
export type Activity = {
  /** Só os dias com alguma atividade, do mais antigo ao mais novo. */
  days: ActivityDay[]
  /** Mensagens suas por dia da semana (0 = domingo) e hora, nos últimos 30 dias. */
  hours: number[][]
  /** Projetos dos últimos 30 dias, do que mais custou ao que menos. */
  projects: ActivityProject[]
}

/** Estação da salinha (ver server/src/office.ts). */
export type OfficeActivity = 'web' | 'files' | 'edit' | 'command' | 'plan' | 'think' | 'ask' | 'compact' | 'background' | 'idle'
export type OfficeWorker = { id: string; name: string; role: string; activity: OfficeActivity; detail?: string }
/** O que acabou de acontecer na conversa, para a salinha animar uma vez (ver server/src/office.ts). */
export type OfficeEventKind = 'edit' | 'error' | 'test-pass' | 'test-fail' | 'commit' | 'push' | 'skill'
export type OfficeEvent = { id: string; at: number; kind: OfficeEventKind; worker: string; detail?: string }
export type OfficeTodos = { done: number; total: number; current?: string }
/** Um setor: uma conversa aberta e quem trabalha nela. `machine` é posto pelo app. */
export type OfficeRoom = Pick<CatalogEntry, 'sessionId' | 'title' | 'cwd' | 'state' | 'waitingFor'> & {
  owner: 'panel' | 'pc'
  workers: OfficeWorker[]
  /** Ausentes em servidores antigos. */
  events?: OfficeEvent[]
  todos?: OfficeTodos
  model?: string
  machine?: string
}
