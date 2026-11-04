import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  query,
  type CanUseTool,
  type EffortLevel,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type ModelInfo,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { AgentTasks } from './agents.ts';
import { imageStore } from './images.ts';
import { BackgroundTasks } from './tasks.ts';
import { AGENT_TOOLS, OfficeLog, workersFrom, type OfficeSnapshot, type OpenTool } from './office.ts';
import { UPLOADS_DIR, childEnv } from './config.ts';
import { probeSetup, type RawSetup } from './claude-config.ts';
import { readPlanUsage } from './claude-usage.ts';
import type { PlanUsage } from './system.ts';
import { HttpError } from './errors.ts';
import { agentsOf, teamPrompt, type TeamSnapshot } from './teams.ts';
import {
  fromSdkMessage,
  stampAssistant,
  parseQuestions,
  type LoggedEvent,
  type PanelEvent,
  type Question,
  type Sent,
  type SessionState,
} from './events.ts';

const MAX_EVENTS = 5_000;

export type ContentBlocks = Exclude<SDKUserMessage['message']['content'], string>;

/** Fila de prompts que mantém o processo headless vivo entre turnos. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(item: SDKUserMessage): void {
    if (this.closed) throw new HttpError(409, 'session_closed');
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

type PendingKind = 'approval' | 'question';

/** Algo que trava o turno até o usuário responder: aprovação de ferramenta ou pergunta do Claude. */
type Pending = {
  kind: PendingKind;
  input: Record<string, unknown>;
  /** Chamada que pede aprovação: na salinha, quem a fez vai até a porta. */
  toolUseId?: string;
  suggestions?: PermissionUpdate[];
  questions?: Question[];
  resolve: (result: PermissionResult) => void;
};

export type PanelSessionOptions = {
  cwd: string;
  /** Rótulo para o catálogo até a conversa ganhar título (rótulo do usuário ou início do prompt). */
  label?: string;
  resume?: string;
  fork?: boolean;
  /** Bifurcar aqui: retoma só até esta entrada do log e descarta o que vem depois. */
  resumeAt?: string;
  /**
   * Conversa de onde esta bifurcou. O CLI só grava o log da nova no primeiro turno, então até lá o
   * painel mostra o histórico da origem, cortado em `priorMessages` (ver `Manager.history`).
   */
  origin?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
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
};

/** O que vai no fim do prompt de sistema: o time, o workspace e o worktree da conversa. */
const append = (opts: PanelSessionOptions) =>
  [opts.team && teamPrompt(opts.team), opts.workspace?.prompt, opts.worktree?.prompt].filter(Boolean).join('\n\n');

/**
 * Sessão cujo único dono é o painel: um processo headless do Claude Code
 * dirigido pelo Agent SDK, com entrada em streaming e aprovações remotas.
 */
export class PanelSession extends EventEmitter {
  id: string;
  readonly cwd: string;
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
  settings: { model?: string; effort?: string | null; permissionMode?: string } = {};
  /** Subagentes deste processo; os de segundo plano seguem trabalhando com a sessão ociosa. */
  readonly agents = new AgentTasks();
  /** Tudo o que roda em segundo plano (monitores, comandos, subagentes): o Claude volta quando terminar. */
  readonly background = new BackgroundTasks();

  private seq = 0;
  private readonly log: LoggedEvent[] = [];
  private readonly input = new InputQueue();
  private readonly pending = new Map<string, Pending>();
  private readonly q: Query;
  private stderrTail = '';
  private commandsCache?: Promise<SlashCommand[]>;
  private modelsCache?: Promise<ModelInfo[]>;
  private exited: Promise<void>;
  /** Ferramentas em uso agora, por quem as chamou (a conversa ou um subagente), para a salinha. */
  private readonly openTools = new Map<string, OpenTool>();
  /** Nome e tipo de cada subagente, pela chamada da ferramenta Agent que o criou. */
  private readonly agentCalls = new Map<string, { name: string; type: string }>();
  /**
   * O modelo escolhido no painel, como ele veio da lista ("opus", "default"…). O init de cada
   * turno traz o id resolvido no lugar dele, e sem guardar a escolha "Opus 5.5" viraria "Padrão"
   * na barra: os dois apontam para o mesmo modelo, e o painel acha o padrão primeiro.
   */
  private chosenModel?: string;
  /** Última ferramenta de cada um, eventos recentes e tarefas, para a salinha. */
  private readonly officeLog = new OfficeLog();
  private compacting = false;
  /** O CLI manda `session_state_changed` (ver o `env` do `query`): é ele, e não o resultado, que diz quando parou. */
  private stateEvents = false;

  constructor(opts: PanelSessionOptions) {
    super();
    this.cwd = opts.cwd;
    this.priorMessages = opts.priorMessages ?? 0;
    this.origin = opts.origin;
    this.team = opts.team;
    this.resumeAt = opts.resumeAt;
    this.label = opts.label;
    // Sessão nova recebe um ID conhecido de antemão, e a bifurcação também: o SDK aceita escolher o
    // ID da conversa bifurcada junto com `forkSession`. Sem isso ele só chegaria no `init`, que em
    // modo headless só vem no primeiro turno — e até lá o painel não teria a quem amarrar o
    // rascunho, a origem, nem para onde navegar.
    const freshId = opts.resume && !opts.fork ? undefined : randomUUID();
    this.id = opts.fork ? freshId! : (opts.resume ?? freshId!);
    this.state = 'idle';

    this.q = query({
      prompt: this.input,
      options: {
        cwd: opts.cwd,
        resume: opts.resume,
        resumeSessionAt: opts.resumeAt,
        forkSession: opts.fork,
        sessionId: freshId,
        model: opts.model,
        effort: opts.effort,
        permissionMode: opts.permissionMode,
        title: opts.title,
        // Anexos do celular ficam fora do projeto; liberados para leitura sem pedir aprovação. Os outros
        // projetos e os arquivos do workspace também.
        additionalDirectories: [UPLOADS_DIR, ...(opts.workspace?.directories ?? [])],
        // O `settings.local.json` não é versionado e não existe no worktree: sem isto, o que você já liberou
        // no projeto voltaria a pedir aprovação.
        projectConfigRoot: opts.worktree?.configRoot,
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(append(opts) ? { append: append(opts) } : {}) },
        agents: opts.team ? agentsOf(opts.team) : undefined,
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        // O celular mostra o que cada subagente faz: falas e raciocínio também, não só as ferramentas,
        // e de tempos em tempos uma linha do Claude Code resumindo o andamento.
        forwardSubagentText: true,
        agentProgressSummaries: true,
        canUseTool: this.canUseTool,
        // Sem isto o SDK engole os `session_state_changed`, e um turno que o Claude começa sozinho
        // (tarefa em segundo plano terminou) não tira a sessão de "Concluída".
        env: { ...childEnv(), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
        stderr: (data) => {
          this.stderrTail = (this.stderrTail + data).slice(-4_000);
        },
      },
    });

    // Já nasce com o que foi pedido: a barra mostra modelo/esforço/modo antes do primeiro turno.
    if (opts.model || opts.effort || opts.permissionMode) {
      this.updateSettings({ model: opts.model, effort: opts.effort ?? null, permissionMode: opts.permissionMode });
    }
    this.chosenModel = opts.model;
    this.exited = this.pump();
  }

  // ---- API usada pelo manager ----

  /**
   * Envia um turno; `blocks` (imagens) vão antes do texto, `images` são as miniaturas para o chat.
   * `context` vai depois, num bloco à parte, para o Claude e não para a tela (o conteúdo dos TODOs).
   * `sent`: por onde e de que aparelho ela saiu. Devolve o UUID dela no transcript, que é dado aqui
   * (o Claude Code grava com o que recebe): é por ele que o cald acha depois de onde ela veio, e que
   * dá para bifurcar nela sem esperar o histórico ser relido.
   */
  send(text: string, extra: { blocks?: ContentBlocks; images?: string[]; clientId?: string; context?: string; sent?: Sent } = {}): string {
    if (this.state === 'exited') throw new HttpError(409, 'session_exited');
    const uuid = randomUUID();
    const after = extra.context ? [{ type: 'text' as const, text: extra.context }] : [];
    const content =
      extra.blocks?.length || after.length ? [...(extra.blocks ?? []), ...(text ? [{ type: 'text' as const, text }] : []), ...after] : text;
    // O `uuid` não está no tipo do SDK, mas o CLI o usa como ID da entrada no transcript.
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid } as SDKUserMessage);
    this.record({ kind: 'user', text, images: extra.images?.length ? extra.images : undefined, clientId: extra.clientId, sent: extra.sent }, uuid);
    if (this.pending.size === 0) this.setState('running');
    return uuid;
  }

  // ---- controles da sessão (modelo, esforço, modo) ----

  async setModel(model: string): Promise<void> {
    await this.q.setModel(model);
    this.chosenModel = model;
    this.updateSettings({ model });
  }

  /** Para que id um valor da lista aponta ("opus" → "claude-opus-5-5"); o próprio valor, se não souber. */
  private async resolvedModel(value: string): Promise<string> {
    const list = await this.models().catch(() => []);
    return list.find((m) => m.value === value)?.resolvedModel ?? value;
  }

  /** Ajustes que o init do turno traz, com o modelo escolhido aqui mantido (ver `chosenModel`). */
  private async settingsFromInit(model: string, effort: string | null, permissionMode: string): Promise<void> {
    const chosen = this.chosenModel;
    const keep = chosen !== undefined && (await this.resolvedModel(chosen)) === model;
    this.updateSettings({ model: keep ? chosen : model, effort, permissionMode });
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    await this.q.applyFlagSettings({ effortLevel: effort });
    this.updateSettings({ effort });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.q.setPermissionMode(mode);
    this.updateSettings({ permissionMode: mode });
  }

  /** Ocupação do contexto e o ponto em que a compactação automática começa. */
  async contextUsage() {
    const c = await this.q.getContextUsage({ detail: 'summary' });
    return {
      model: c.model,
      totalTokens: c.totalTokens,
      maxTokens: c.maxTokens,
      autoCompactThreshold: c.autoCompactThreshold ?? null,
      autoCompactEnabled: c.isAutoCompactEnabled,
    };
  }

  /** Modelos disponíveis, com os níveis de esforço de cada um (consulta o processo uma vez). */
  models(): Promise<ModelInfo[]> {
    this.modelsCache ??= this.q.supportedModels();
    return this.modelsCache;
  }

  /** Uso do plano consultado pelo próprio processo desta sessão (evita subir uma sonda). */
  planUsage(): Promise<PlanUsage> {
    return readPlanUsage(this.q);
  }

  /** Comandos e skills disponíveis nesta sessão (consulta o processo uma vez). */
  commands(): Promise<SlashCommand[]> {
    this.commandsCache ??= this.q.supportedCommands();
    return this.commandsCache;
  }

  /** Skills, agentes e servidores MCP desta sessão, sem subir uma sonda (ver claude-config.ts). */
  setup(): Promise<RawSetup> {
    return probeSetup(this.q);
  }

  /** Liga ou desliga um servidor MCP: vale já nesta sessão e fica gravado para a pasta. */
  async toggleMcp(name: string, enabled: boolean): Promise<void> {
    await this.q.toggleMcpServer(name, enabled);
    this.commandsCache = undefined;
  }

  answer(requestId: string, decision: { allow: boolean; message?: string; always?: boolean }): void {
    const pending = this.findPending(requestId, 'approval');
    this.pending.delete(requestId);
    pending.resolve(
      decision.allow
        ? {
            behavior: 'allow',
            updatedInput: pending.input,
            updatedPermissions: decision.always ? pending.suggestions : undefined,
          }
        : { behavior: 'deny', message: decision.message ?? 'Negado pelo usuário no painel.' },
    );
    this.record({ kind: 'approval_resolved', requestId, decision: decision.allow ? 'allow' : 'deny' });
    this.afterResolve();
  }

  /**
   * Responde uma pergunta do Claude. `answers` mapeia o texto de cada pergunta para a
   * opção escolhida (várias separadas por vírgula, ou texto livre para "Outro").
   */
  answerQuestion(requestId: string, reply: { answers?: Record<string, string>; decline?: boolean }): void {
    const pending = this.findPending(requestId, 'question');

    if (reply.decline) {
      this.pending.delete(requestId);
      pending.resolve({ behavior: 'deny', message: 'O usuário preferiu não responder a pergunta.' });
      this.record({ kind: 'question_resolved', requestId, decision: 'declined' });
      return this.afterResolve();
    }

    const answers = reply.answers ?? {};
    const expected = (pending.questions ?? []).map((q) => q.question);
    const missing = expected.filter((q) => !answers[q]?.trim());
    const unknown = Object.keys(answers).filter((q) => !expected.includes(q));
    if (missing.length || unknown.length) throw new HttpError(400, 'invalid_answers', { missing, unknown });

    this.pending.delete(requestId);
    pending.resolve({ behavior: 'allow', updatedInput: { ...pending.input, answers } });
    this.record({ kind: 'question_resolved', requestId, decision: 'answered', answers });
    this.afterResolve();
  }

  /** Turno acabou, mas algo ainda roda em segundo plano e vai trazer o Claude de volta. */
  get pendingWork(): boolean {
    return this.agents.active > 0 || this.background.list.length > 0;
  }

  /** Turno em andamento sem ferramenta aberta nem subagente trabalhando: o Claude está pensando (ou escrevendo). */
  get thinking(): boolean {
    return this.state === 'running' && !this.compacting && !this.inTool && this.agents.active === 0;
  }

  /** Alguma ferramenta da própria conversa (não de subagente) rodando agora. */
  private get inTool(): boolean {
    for (const t of this.openTools.values()) if (t.scope === null) return true;
    return false;
  }

  /** Para uma tarefa em segundo plano; o Claude recebe o aviso de que ela foi parada. */
  async stopTask(taskId: string): Promise<void> {
    if (!this.background.knows(taskId)) throw new HttpError(404, 'task_not_found');
    await this.q.stopTask(taskId);
  }

  /** Fim da saída de um comando ou monitor em segundo plano (até 8 KiB), sem gastar um turno. */
  async taskOutput(taskId: string): Promise<{ output: string; totalBytes: number }> {
    if (!this.background.knows(taskId)) throw new HttpError(404, 'task_not_found');
    // Método do SDK que ainda não está nos tipos publicados.
    const q = this.q as Query & { getTaskOutput?: (id: string) => Promise<{ output: string; total_bytes: number }> };
    if (typeof q.getTaskOutput !== 'function') throw new HttpError(501, 'task_output_unsupported');
    const r = await q.getTaskOutput(taskId);
    return { output: r.output, totalBytes: r.total_bytes };
  }

  async interrupt(): Promise<void> {
    if (this.state === 'exited') throw new HttpError(409, 'session_exited');
    await this.q.interrupt();
  }

  /** Devolve a sessão ao PC: encerra o processo headless, desde que esteja ocioso (sem subagentes trabalhando). */
  async release(): Promise<void> {
    if (this.state === 'running' || this.state === 'waiting' || this.agents.active) {
      throw new HttpError(409, 'session_busy', { state: this.state, agents: this.agents.active });
    }
    await this.shutdown();
  }

  /** Encerramento incondicional (ex.: desligamento do servidor). */
  async shutdown(): Promise<void> {
    for (const [requestId, pending] of this.pending) {
      pending.resolve({ behavior: 'deny', message: 'Sessão encerrada pelo painel.' });
      this.recordCancelled(requestId, pending.kind);
    }
    this.pending.clear();
    this.input.close();
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000));
    if ((await Promise.race([this.exited, timeout])) === 'timeout') {
      this.q.close();
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

  // ---- internos ----

  private canUseTool: CanUseTool = (toolName, input, opts) =>
    new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID().slice(0, 8);
      // Pergunta malformada cai no fluxo de aprovação comum, que ao menos mostra o input.
      const questions = toolName === 'AskUserQuestion' ? parseQuestions(input) : [];
      const kind: PendingKind = questions.length ? 'question' : 'approval';
      this.pending.set(requestId, { kind, input, suggestions: opts.suggestions, questions, resolve, toolUseId: opts.toolUseID });

      if (kind === 'question') {
        this.setState('waiting', 'input needed');
        this.record({ kind: 'question_request', requestId, questions });
      } else {
        this.setState('waiting', 'permission prompt');
        this.record({
          kind: 'approval_request',
          requestId,
          toolName,
          input,
          toolUseId: opts.toolUseID,
          title: opts.title,
          decisionReason: opts.decisionReason,
          blockedPath: opts.blockedPath,
          canAlwaysAllow: Boolean(opts.suggestions?.length),
        });
      }

      opts.signal.addEventListener(
        'abort',
        () => {
          if (!this.pending.delete(requestId)) return;
          resolve({ behavior: 'deny', message: 'Cancelado.' });
          this.recordCancelled(requestId, kind);
        },
        { once: true },
      );
    });

  private findPending(requestId: string, kind: PendingKind): Pending {
    const pending = this.pending.get(requestId);
    if (!pending) throw new HttpError(404, 'request_not_found');
    if (pending.kind !== kind) throw new HttpError(409, kind === 'approval' ? 'is_a_question' : 'is_an_approval');
    return pending;
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

  private async pump(): Promise<void> {
    let error: string | undefined;
    try {
      for await (const msg of this.q) this.handle(msg);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (this.stderrTail) error += `\n${this.stderrTail.trim()}`;
    }
    this.setState('exited');
    this.record({ kind: 'exit', error });
    this.emit('exit');
  }

  /** O id de antes do último que a sessão ganhou: o /clear pode avisar depois de o id novo já ter chegado. */
  private previousId: string | undefined;

  private rekeyTo(id: string): void {
    const from = this.id;
    this.previousId = from;
    this.id = id;
    this.emit('rekey', from, id);
  }

  private handle(msg: SDKMessage): void {
    // O /clear (e os outros jeitos de recomeçar a conversa): a tela esvazia, sem fechar a conversa, e ela
    // passa para o id novo. O manager faz o id novo herdar o claudinho e tira o antigo da lista.
    if (msg.type === 'conversation_reset') {
      const from = msg.new_conversation_id !== this.id ? this.id : this.previousId;
      this.record({ kind: 'cleared' });
      if (msg.new_conversation_id && msg.new_conversation_id !== this.id) this.rekeyTo(msg.new_conversation_id);
      if (from && from !== this.id) this.emit('cleared', from, this.id);
      return;
    }
    if (msg.type === 'system' && msg.subtype === 'init') {
      if (msg.session_id !== this.id) this.rekeyTo(msg.session_id);
      // O init nem sempre traz o esforço; sem ele, vale o último escolhido.
      void this.settingsFromInit(msg.model, msg.effort ?? this.settings.effort ?? null, msg.permissionMode);
    }
    // O modo muda sozinho, por exemplo ao aprovar a saída do modo de plano.
    if (msg.type === 'system' && msg.subtype === 'status' && msg.permissionMode) {
      this.updateSettings({ permissionMode: msg.permissionMode });
    }
    if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
      this.stateEvents = true;
      if (msg.state === 'running') this.setState('running');
      else if (msg.state === 'idle') this.setState('idle');
      else this.setState('waiting', this.waitingFor ?? 'input needed');
    }
    // Compactação: começa com o status "compacting" e acaba com a marca de fronteira (ou o fim do turno).
    if (msg.type === 'system' && msg.subtype === 'status') this.compacting = msg.status === 'compacting';
    if ((msg.type === 'system' && msg.subtype === 'compact_boundary') || msg.type === 'result') this.compacting = false;

    // Resultados de ferramentas podem trazer imagens (prints, arquivos lidos): vão para o cache.
    const sink = msg.type === 'user' ? imageStore.sink(this.id, (msg as { uuid?: string }).uuid ?? randomUUID()) : undefined;
    const { events, delta } = fromSdkMessage(msg, sink);
    // O esforço não vem na mensagem: é o ajuste da sessão agora. Subagente pensa com o dele, que não se sabe daqui.
    if (msg.type === 'assistant' && msg.parent_tool_use_id === null) stampAssistant(events, undefined, this.settings.effort);
    // O UUID vem junto para o que chega ao vivo também, senão só daria para bifurcar no histórico
    // já lido do arquivo — e não no turno que acabou de acontecer.
    const uuid = (msg as { uuid?: string }).uuid;
    const tooling = this.inTool;
    for (const ev of events) {
      this.track(ev);
      this.record(ev, uuid);
    }
    // Fim do turno: o que ficou sem resultado (turno interrompido) não está mais rodando.
    if (msg.type === 'result') for (const [id, t] of this.openTools) if (t.scope === null) this.openTools.delete(id);
    // O fim do turno não é o fim do trabalho: com mensagem na fila, o CLI emenda outro turno sem parar, e quem
    // diz que parou é o `session_state_changed` "idle". Só sem esses avisos o resultado faz as vezes dele.
    if (msg.type === 'result' && !this.stateEvents && this.pending.size === 0) this.setState('idle');
    if (delta) this.emit('delta', delta);

    const working = this.agents.active;
    for (const ev of this.agents.fromMessage(msg)) this.record(ev);
    const waiting = this.background.list;
    for (const ev of this.background.fromMessage(msg)) this.record(ev);
    // Subagente, tarefa em segundo plano ou ferramenta da conversa começou ou terminou: a lista de
    // sessões mostra (com ferramenta, o claudinho está executando; sem, pensando).
    if (this.agents.active !== working || this.background.list !== waiting || this.inTool !== tooling) this.emit('state');
  }

  /** Quem está no setor desta conversa na salinha, o que cada um faz e o que acabou de acontecer (ver office.ts). */
  office(): OfficeSnapshot {
    const agents = this.agents.runningCalls().map((id) => ({ id, ...(this.agentCalls.get(id) ?? { name: 'Subagente', type: 'subagente' }) }));
    const working = new Set(agents.map((a) => a.id));
    const now = Date.now();
    const workers = workersFrom({
      tools: [...this.openTools.values()].filter((t) => t.scope === null || working.has(t.scope)),
      agents,
      busy: this.state === 'running' || this.state === 'starting',
      waiting: this.state === 'waiting',
      waitingFor: this.waitingFor,
      asking: new Set([...this.pending.values()].flatMap((p) => (p.toolUseId ? [p.toolUseId] : []))),
      background: this.background.list.length > 0,
      compacting: this.compacting,
      recent: (scope) => this.officeLog.recent(scope, now),
    });
    return { workers, events: this.officeLog.recentEvents(now), todos: this.officeLog.todos, model: this.settings.model };
  }

  private track(ev: PanelEvent): void {
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

  private updateSettings(patch: PanelSession['settings']): void {
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

/**
 * Sobe um processo só para consultas de controle (lista de comandos, uso do plano):
 * não chama o modelo, não grava conversa e é encerrado em seguida.
 */
export async function withProbe<T>(cwd: string, fn: (q: Query) => Promise<T>): Promise<T> {
  const input = new InputQueue();
  const q = query({
    prompt: input,
    options: {
      cwd,
      env: childEnv(),
      persistSession: false,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    },
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, 'probe_timeout')), 20_000);
  });
  try {
    return await Promise.race([fn(q), timeout]);
  } finally {
    clearTimeout(timer);
    input.close();
    q.close();
  }
}

export const probeCommands = (cwd: string) => withProbe(cwd, (q) => q.supportedCommands());
