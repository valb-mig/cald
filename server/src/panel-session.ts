import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { McpServerSpec } from './cald-mcp.ts';
import { HttpError } from './errors.ts';
import { imageStore } from './images.ts';
import { AGENT_TOOLS, OfficeLog, workersFrom, type OfficeSnapshot, type OpenTool } from './office.ts';
import { teamPrompt, type TeamSnapshot } from './teams.ts';
import type { BackgroundTask, LoggedEvent, PanelEvent, Question, Sent, SessionState } from './events.ts';
import type {
  AgentProvider,
  ApprovalDecision,
  ApprovalRequest,
  ContextUsage,
  ProviderRun,
  QuestionReply,
  QuestionRequest,
  RunHost,
  RunSettings,
  TurnBlock,
} from './providers/types.ts';

const MAX_EVENTS = 5_000;

type PendingKind = 'approval' | 'question';

/**
 * Algo que trava o turno até o usuário responder: aprovação de ferramenta ou pergunta do agente.
 * `toolUseId`: a chamada que pede; na salinha, quem a fez vai até a porta.
 */
type Pending =
  | { kind: 'approval'; toolUseId?: string; resolve: (decision: ApprovalDecision) => void }
  | { kind: 'question'; toolUseId?: string; questions: Question[]; resolve: (reply: QuestionReply) => void };

export type PanelSessionOptions = {
  /** O agente que conduz a conversa (ver providers/types.ts). */
  provider: AgentProvider;
  cwd: string;
  /** Rótulo para o catálogo até a conversa ganhar título (rótulo do usuário ou início do prompt). */
  label?: string;
  resume?: string;
  fork?: boolean;
  /** Bifurcar aqui: retoma só até esta entrada do log e descarta o que vem depois. */
  resumeAt?: string;
  /**
   * Conversa de onde esta bifurcou. O agente pode só gravar o log da nova no primeiro turno, então até
   * lá o painel mostra o histórico da origem, cortado em `priorMessages` (ver `Manager.history`).
   */
  origin?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  title?: string;
  /** Mensagens que a conversa já tinha antes deste processo (o resto chega pelo log de eventos). */
  priorMessages?: number;
  /** Time de agentes da conversa (ver teams.ts): vira os subagentes dela e um trecho do prompt de sistema. */
  team?: TeamSnapshot;
  /** Contexto do workspace da conversa, montado agora (ver workspaces.ts): mais prompt de sistema e pastas extras. */
  workspace?: { prompt: string; directories: string[] };
  /**
   * A conversa roda num worktree (ver worktrees.ts): um trecho do prompt de sistema e o checkout de que
   * ele é cópia, de onde vêm as configurações do projeto (permissões locais, skills, hooks).
   */
  worktree?: { prompt: string; configRoot: string };
  /** A pasta com as habilidades do cald que valem nesta conversa (ver habilidades.ts). */
  habilidades?: string;
  /** O MCP do cald (ver cald-mcp.ts), montado para esta conversa: recebe ela, para saber a quem pôr o time. */
  mcp?: (session: PanelSession) => McpServerSpec;
  /**
   * Antes de cada Write ou Edit: se ele grava uma memória, vira sugestão para você decidir no painel
   * (ver memory-suggestions.ts), e a ferramenta é negada com o recado que volta, sem travar a conversa.
   */
  memory?: (sessionId: string, tool: string, input: unknown) => Promise<string | null>;
};

/** O que vai no fim do prompt de sistema: o time, o workspace e o worktree da conversa. */
const append = (opts: PanelSessionOptions) =>
  [opts.team && teamPrompt(opts.team), opts.workspace?.prompt, opts.worktree?.prompt].filter(Boolean).join('\n\n');

/**
 * Sessão cujo único dono é o painel. O agente (ver providers/) conduz o processo; aqui fica o que é do
 * cald: o log de eventos com `seq`, o estado, as aprovações e perguntas esperando você, os subagentes e
 * tarefas em segundo plano, e o que a salinha mostra.
 */
export class PanelSession extends EventEmitter {
  id: string;
  readonly provider: AgentProvider;
  readonly cwd: string;
  /** A pasta das habilidades desta conversa (ver habilidades.ts), para o Manager refazer. */
  readonly habilidades?: string;
  readonly startedAt = Date.now();
  /** Identifica este processo: o `seq` recomeça a cada abertura da mesma conversa. */
  readonly runId = randomUUID().slice(0, 8);
  readonly priorMessages: number;
  /** Conversa de onde esta bifurcou, enquanto a nova ainda não tem log próprio. */
  readonly origin?: string;
  /** O time de agentes desta conversa, para passar adiante quando ela ganha id novo. */
  readonly team?: TeamSnapshot;
  /** Ponto do log da origem onde esta bifurcação cortou. */
  readonly resumeAt?: string;
  readonly label?: string;
  state: SessionState;
  waitingFor?: string;
  /** Modelo, esforço e modo vigentes; cada mudança vira um evento `settings`. */
  settings: RunSettings = {};
  /** Tudo o que roda em segundo plano (monitores, comandos, subagentes): o agente volta quando terminar. */
  tasks: BackgroundTask[] = [];

  private seq = 0;
  private readonly log: LoggedEvent[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly run: ProviderRun;
  private readonly exited: Promise<void>;
  /** Subagentes trabalhando agora, pela chamada da ferramenta Agent que criou cada um. */
  private readonly working = new Set<string>();
  /** Ferramentas em uso agora, por quem as chamou (a conversa ou um subagente), para a salinha. */
  private readonly openTools = new Map<string, OpenTool>();
  /** Nome e tipo de cada subagente, pela chamada da ferramenta Agent que o criou. */
  private readonly agentCalls = new Map<string, { name: string; type: string }>();
  /** Última ferramenta de cada um, eventos recentes e tarefas, para a salinha. */
  private readonly officeLog = new OfficeLog();
  private compacting = false;
  /** O id de antes do último que a sessão ganhou: o /clear pode avisar depois de o id novo já ter chegado. */
  private previousId: string | undefined;

  constructor(opts: PanelSessionOptions) {
    super();
    this.provider = opts.provider;
    this.cwd = opts.cwd;
    this.habilidades = opts.habilidades;
    this.priorMessages = opts.priorMessages ?? 0;
    this.origin = opts.origin;
    this.team = opts.team;
    this.resumeAt = opts.resumeAt;
    this.label = opts.label;
    // Sessão nova recebe um ID conhecido de antemão, e a bifurcação também. Sem isso ele só chegaria
    // quando o agente avisasse (no Claude Code, no `init`, que em modo headless só vem no primeiro
    // turno) — e até lá o painel não teria a quem amarrar o rascunho, a origem, nem para onde navegar.
    const freshId = opts.resume && !opts.fork ? undefined : randomUUID();
    this.id = opts.fork ? freshId! : (opts.resume ?? freshId!);
    this.state = 'idle';

    let exited!: () => void;
    this.exited = new Promise((resolve) => (exited = resolve));
    const memory = opts.memory;
    this.run = opts.provider.start(
      {
        cwd: opts.cwd,
        resume: opts.resume,
        fork: opts.fork,
        resumeAt: opts.resumeAt,
        sessionId: freshId,
        model: opts.model,
        effort: opts.effort,
        permissionMode: opts.permissionMode,
        title: opts.title,
        instructions: append(opts) || undefined,
        directories: opts.workspace?.directories ?? [],
        configRoot: opts.worktree?.configRoot,
        team: opts.team,
        skills: opts.habilidades,
        mcp: opts.mcp?.(this),
        beforeWrite: memory && ((tool, input) => memory(this.id, tool, input)),
      },
      this.host(exited),
    );

    // Já nasce com o que foi pedido: a barra mostra modelo/esforço/modo antes do primeiro turno.
    if (opts.model || opts.effort || opts.permissionMode) {
      this.updateSettings({ model: opts.model, effort: opts.effort ?? null, permissionMode: opts.permissionMode });
    }
  }

  // ---- API usada pelo manager ----

  /**
   * Envia um turno; `blocks` (imagens) vão antes do texto, `images` são as miniaturas para o chat.
   * `context` vai depois, num bloco à parte, para o agente e não para a tela (o conteúdo dos TODOs).
   * `sent`: por onde e de que aparelho ela saiu. Devolve o UUID dela no histórico, que é dado aqui
   * (o agente grava com o que recebe): é por ele que o cald acha depois de onde ela veio, e que
   * dá para bifurcar nela sem esperar o histórico ser relido.
   */
  send(text: string, extra: { blocks?: TurnBlock[]; images?: string[]; clientId?: string; context?: string; sent?: Sent } = {}): string {
    if (this.state === 'exited') throw new HttpError(409, 'session_exited');
    const uuid = randomUUID();
    this.run.send({ uuid, text, blocks: extra.blocks, context: extra.context });
    this.record({ kind: 'user', text, images: extra.images?.length ? extra.images : undefined, clientId: extra.clientId, sent: extra.sent }, uuid);
    if (this.pending.size === 0) this.setState('running');
    return uuid;
  }

  // ---- controles da sessão (modelo, esforço, modo) ----

  async setModel(model: string): Promise<void> {
    await this.run.setModel(model);
    this.updateSettings({ model });
  }

  async setEffort(effort: string): Promise<void> {
    await this.run.setEffort(effort);
    this.updateSettings({ effort });
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.run.setPermissionMode(mode);
    this.updateSettings({ permissionMode: mode });
  }

  /** Ocupação do contexto e o ponto em que a compactação automática começa. */
  contextUsage(): Promise<ContextUsage> {
    return this.run.contextUsage();
  }

  /** A pasta das habilidades foi refeita (uma ligada, desligada, criada ou editada): o agente relê sem reiniciar. */
  reloadHabilidades(): Promise<void> {
    return this.run.reloadSkills();
  }

  answer(requestId: string, decision: { allow: boolean; message?: string; always?: boolean }): void {
    const pending = this.findPending(requestId, 'approval');
    this.pending.delete(requestId);
    pending.resolve(decision.allow ? { allow: true, always: decision.always } : { allow: false, message: decision.message ?? 'Negado pelo usuário no painel.' });
    this.record({ kind: 'approval_resolved', requestId, decision: decision.allow ? 'allow' : 'deny' });
    this.afterResolve();
  }

  /**
   * Responde uma pergunta do agente. `answers` mapeia o texto de cada pergunta para a
   * opção escolhida (várias separadas por vírgula, ou texto livre para "Outro").
   */
  answerQuestion(requestId: string, reply: { answers?: Record<string, string>; decline?: boolean }): void {
    const pending = this.findPending(requestId, 'question');

    if (reply.decline) {
      this.pending.delete(requestId);
      pending.resolve({ answered: false, message: 'O usuário preferiu não responder a pergunta.' });
      this.record({ kind: 'question_resolved', requestId, decision: 'declined' });
      return this.afterResolve();
    }

    const answers = reply.answers ?? {};
    const expected = pending.questions.map((q) => q.question);
    const missing = expected.filter((q) => !answers[q]?.trim());
    const unknown = Object.keys(answers).filter((q) => !expected.includes(q));
    if (missing.length || unknown.length) throw new HttpError(400, 'invalid_answers', { missing, unknown });

    this.pending.delete(requestId);
    pending.resolve({ answered: true, answers });
    this.record({ kind: 'question_resolved', requestId, decision: 'answered', answers });
    this.afterResolve();
  }

  /** Subagentes trabalhando agora; os de segundo plano seguem depois do fim do turno. */
  get activeAgents(): number {
    return this.working.size;
  }

  /** Turno acabou, mas algo ainda roda em segundo plano e vai trazer o agente de volta. */
  get pendingWork(): boolean {
    return this.working.size > 0 || this.tasks.length > 0;
  }

  /** Turno em andamento sem ferramenta aberta nem subagente trabalhando: o agente está pensando (ou escrevendo). */
  get thinking(): boolean {
    return this.state === 'running' && !this.compacting && !this.inTool && this.working.size === 0;
  }

  /** Alguma ferramenta da própria conversa (não de subagente) rodando agora. */
  private get inTool(): boolean {
    for (const t of this.openTools.values()) if (t.scope === null) return true;
    return false;
  }

  /** Para uma tarefa em segundo plano; o agente recebe o aviso de que ela foi parada. */
  stopTask(taskId: string): Promise<void> {
    return this.run.stopTask(taskId);
  }

  /** Fim da saída de um comando ou monitor em segundo plano, sem gastar um turno. */
  taskOutput(taskId: string): Promise<{ output: string; totalBytes: number }> {
    return this.run.taskOutput(taskId);
  }

  async interrupt(): Promise<void> {
    if (this.state === 'exited') throw new HttpError(409, 'session_exited');
    await this.run.interrupt();
  }

  /** Devolve a sessão ao PC: encerra o processo do agente, desde que esteja ocioso (sem subagentes trabalhando). */
  async release(): Promise<void> {
    if (this.state === 'running' || this.state === 'waiting' || this.working.size) {
      throw new HttpError(409, 'session_busy', { state: this.state, agents: this.working.size });
    }
    await this.shutdown();
  }

  /** Encerramento incondicional (ex.: desligamento do servidor). */
  async shutdown(): Promise<void> {
    for (const [requestId, pending] of this.pending) {
      cancel(pending, 'Sessão encerrada pelo painel.');
      this.recordCancelled(requestId, pending.kind);
    }
    this.pending.clear();
    this.run.end();
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000));
    if ((await Promise.race([this.exited, timeout])) === 'timeout') {
      this.run.kill();
      await this.exited;
    }
  }

  /** Eventos após `sinceSeq`; `reset` indica que o cliente perdeu eventos já descartados. */
  eventsSince(sinceSeq: number): { reset: boolean; events: LoggedEvent[] } {
    const first = this.log[0]?.seq ?? this.seq + 1;
    if (sinceSeq < first - 1) return { reset: true, events: [...this.log] };
    return { reset: false, events: this.log.filter((e) => e.seq > sinceSeq) };
  }

  pendingRequests(): { requestId: string; kind: PendingKind }[] {
    return [...this.pending].map(([requestId, p]) => ({ requestId, kind: p.kind }));
  }

  /** Quem está no setor desta conversa na salinha, o que cada um faz e o que acabou de acontecer (ver office.ts). */
  office(): OfficeSnapshot {
    const agents = [...this.working].map((id) => ({ id, ...(this.agentCalls.get(id) ?? { name: 'Subagente', type: 'subagente' }) }));
    const now = Date.now();
    const workers = workersFrom({
      tools: [...this.openTools.values()].filter((t) => t.scope === null || this.working.has(t.scope)),
      agents,
      busy: this.state === 'running' || this.state === 'starting',
      waiting: this.state === 'waiting',
      waitingFor: this.waitingFor,
      asking: new Set([...this.pending.values()].flatMap((p) => (p.toolUseId ? [p.toolUseId] : []))),
      background: this.tasks.length > 0,
      compacting: this.compacting,
      recent: (scope) => this.officeLog.recent(scope, now),
    });
    return { workers, events: this.officeLog.recentEvents(now), todos: this.officeLog.todos, model: this.settings.model };
  }

  // ---- o que o agente avisa (ver RunHost em providers/types.ts) ----

  private host(exited: () => void): RunHost {
    const session = this;
    return {
      get sessionId() {
        return session.id;
      },
      events: (events, uuid) => this.onEvents(events, uuid),
      delta: (text) => this.emit('delta', text),
      images: (uuid) => imageStore.sink(this.id, uuid ?? randomUUID()),
      state: (state) => {
        if (state === 'waiting') this.setState('waiting', this.waitingFor ?? 'input needed');
        else this.setState(state);
      },
      turnEnd: (idle) => {
        // O que ficou sem resultado (turno interrompido) não está mais rodando.
        const tooling = this.inTool;
        for (const [id, t] of this.openTools) if (t.scope === null) this.openTools.delete(id);
        if (idle && this.pending.size === 0) this.setState('idle');
        else if (this.inTool !== tooling) this.emit('state');
      },
      compacting: (on) => {
        this.compacting = on;
      },
      settings: (patch) => this.updateSettings(patch),
      rekey: (id) => {
        if (id !== this.id) this.rekeyTo(id);
      },
      // O /clear: a tela esvazia, sem fechar a conversa, e ela passa para o id novo. O manager faz o id
      // novo herdar o claudinho e tira o antigo da lista.
      reset: (newId) => {
        const from = newId !== this.id ? this.id : this.previousId;
        this.record({ kind: 'cleared' });
        if (newId && newId !== this.id) this.rekeyTo(newId);
        if (from && from !== this.id) this.emit('cleared', from, this.id);
      },
      approve: (request) => this.approve(request),
      ask: (request) => this.ask(request),
      exit: (error) => {
        this.setState('exited');
        this.record({ kind: 'exit', error });
        this.emit('exit');
        exited();
      },
    };
  }

  private onEvents(events: PanelEvent[], uuid?: string): void {
    const working = this.working.size;
    const tasks = this.tasks;
    const tooling = this.inTool;
    for (const ev of events) {
      this.track(ev);
      this.record(ev, uuid);
    }
    // Subagente, tarefa em segundo plano ou ferramenta da conversa começou ou terminou: a lista de
    // sessões mostra (com ferramenta, o claudinho está executando; sem, pensando).
    if (this.working.size !== working || this.tasks !== tasks || this.inTool !== tooling) this.emit('state');
  }

  private approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const requestId = randomUUID().slice(0, 8);
      this.pending.set(requestId, { kind: 'approval', toolUseId: request.toolUseId, resolve });
      this.setState('waiting', 'permission prompt');
      this.record({
        kind: 'approval_request',
        requestId,
        toolName: request.toolName,
        input: request.input,
        toolUseId: request.toolUseId,
        title: request.title,
        decisionReason: request.decisionReason,
        blockedPath: request.blockedPath,
        canAlwaysAllow: request.canAlwaysAllow,
      });
      this.cancelOnAbort(request.signal, requestId);
    });
  }

  private ask(request: QuestionRequest): Promise<QuestionReply> {
    return new Promise((resolve) => {
      const requestId = randomUUID().slice(0, 8);
      this.pending.set(requestId, { kind: 'question', toolUseId: request.toolUseId, questions: request.questions, resolve });
      this.setState('waiting', 'input needed');
      this.record({ kind: 'question_request', requestId, questions: request.questions });
      this.cancelOnAbort(request.signal, requestId);
    });
  }

  /** O agente desistiu do pedido (turno interrompido): o cartão sai como cancelado. */
  private cancelOnAbort(signal: AbortSignal, requestId: string): void {
    signal.addEventListener(
      'abort',
      () => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        cancel(pending, 'Cancelado.');
        this.recordCancelled(requestId, pending.kind);
      },
      { once: true },
    );
  }

  private findPending<K extends PendingKind>(requestId: string, kind: K): Extract<Pending, { kind: K }> {
    const pending = this.pending.get(requestId);
    if (!pending) throw new HttpError(404, 'request_not_found');
    if (pending.kind !== kind) throw new HttpError(409, kind === 'approval' ? 'is_a_question' : 'is_an_approval');
    return pending as Extract<Pending, { kind: K }>;
  }

  /** Volta a `running` quando nada mais trava o turno; senão reflete o que ainda falta. */
  private afterResolve(): void {
    const next = this.pending.values().next().value;
    if (!next) this.setState('running');
    else this.setState('waiting', next.kind === 'question' ? 'input needed' : 'permission prompt');
  }

  private recordCancelled(requestId: string, kind: PendingKind): void {
    this.record(
      kind === 'question'
        ? { kind: 'question_resolved', requestId, decision: 'cancelled' }
        : { kind: 'approval_resolved', requestId, decision: 'cancelled' },
    );
  }

  private rekeyTo(id: string): void {
    const from = this.id;
    this.previousId = from;
    this.id = id;
    this.emit('rekey', from, id);
  }

  private track(ev: PanelEvent): void {
    if (ev.kind === 'agent') {
      if (ev.status === 'running') this.working.add(ev.toolUseId);
      else if (ev.status) this.working.delete(ev.toolUseId);
      return;
    }
    if (ev.kind === 'tasks') {
      this.tasks = ev.tasks;
      return;
    }
    if (ev.kind === 'tool_result') {
      const tool = this.openTools.get(ev.toolUseId);
      if (tool) this.officeLog.result(tool, ev.isError, ev.text);
      this.openTools.delete(ev.toolUseId);
      return;
    }
    if (ev.kind !== 'tool_use') return;
    const tool: OpenTool = { id: ev.id, name: ev.name, input: ev.input, scope: ev.parentToolUseId ?? null };
    this.openTools.set(ev.id, tool);
    this.officeLog.use(tool);
    if (AGENT_TOOLS.has(ev.name)) {
      const input = (ev.input ?? {}) as Record<string, unknown>;
      const type = typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : 'general-purpose';
      this.agentCalls.set(ev.id, { name: typeof input.description === 'string' && input.description ? input.description : type, type });
    }
  }

  private updateSettings(patch: RunSettings): void {
    const next = { ...this.settings, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return;
    this.settings = next;
    this.record({ kind: 'settings', ...next });
  }

  private setState(state: SessionState, waitingFor?: string): void {
    if (this.state === 'exited') return;
    if (state === this.state && waitingFor === this.waitingFor) return;
    this.state = state;
    this.waitingFor = state === 'waiting' ? waitingFor : undefined;
    this.record({ kind: 'state', state, waitingFor: this.waitingFor });
    this.emit('state');
  }

  /** `uuid`: a entrada do log de onde o evento veio, quando se sabe; é o ponto de corte de uma bifurcação. */
  private record(ev: PanelEvent, uuid?: string): void {
    const logged = { ...ev, seq: ++this.seq, ts: Date.now(), ...(uuid ? { uuid } : {}) } as LoggedEvent;
    this.log.push(logged);
    if (this.log.length > MAX_EVENTS) this.log.shift();
    this.emit('event', logged);
  }
}

/** Responde que não a um pedido pendurado (sessão encerrada, turno interrompido). */
function cancel(pending: Pending, message: string): void {
  if (pending.kind === 'approval') pending.resolve({ allow: false, message });
  else pending.resolve({ answered: false, message });
}
