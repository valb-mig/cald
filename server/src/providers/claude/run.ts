import { randomUUID } from 'node:crypto';
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type EffortLevel,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type ModelInfo,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { UPLOADS_DIR } from '../../config.ts';
import type { McpServerSpec } from '../../editr-mcp.ts';
import { HttpError } from '../../errors.ts';
import { parseQuestions } from '../../events.ts';
import type { PlanUsage } from '../../system.ts';
import type { ContextUsage, ProviderRun, RunHost, RunOptions, UserTurn } from '../types.ts';
import { childEnv } from './env.ts';
import { fromSdkMessage, stampAssistant } from './messages.ts';
import { InputQueue } from './probe.ts';
import { probeSetup, type RawSetup } from './setup.ts';
import { AgentTasks } from './subagents.ts';
import { BackgroundTasks } from './tasks.ts';
import { agentsOf } from './team.ts';
import { readPlanUsage } from './usage.ts';

/** O MCP do edit.r como servidor do SDK, no mesmo processo. */
function sdkMcp(spec: McpServerSpec): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: spec.name,
    version: spec.version,
    instructions: spec.instructions,
    tools: spec.tools.map((t) => tool(t.name, t.description, t.shape, (args) => t.handler(args), { annotations: t.annotations })),
  });
}

/**
 * Uma conversa do painel no Claude Code: um processo headless dirigido pelo Agent SDK, com entrada em
 * streaming (a fila mantém o processo vivo entre turnos). Traduz o que o SDK fala para o painel
 * (ver providers/types.ts) e as aprovações do `canUseTool` em pedidos ao edit.r.
 */
export class ClaudeRun implements ProviderRun {
  readonly cwd: string;
  private readonly host: RunHost;
  private readonly input = new InputQueue();
  private readonly q: Query;
  private stderrTail = '';
  private commandsCache?: Promise<SlashCommand[]>;
  private modelsCache?: Promise<ModelInfo[]>;
  /** Subagentes deste processo (viram eventos `agent`). */
  private readonly agents = new AgentTasks();
  /** Tarefas em segundo plano deste processo (viram eventos `tasks`). */
  private readonly background = new BackgroundTasks();
  /**
   * O modelo escolhido no painel, como ele veio da lista ("opus", "default"…). O init de cada
   * turno traz o id resolvido no lugar dele, e sem guardar a escolha "Opus 5.5" viraria "Padrão"
   * na barra: os dois apontam para o mesmo modelo, e o painel acha o padrão primeiro.
   */
  private chosenModel?: string;
  /** O esforço vigente: o init nem sempre traz, e as respostas levam o da sessão. */
  private effort?: string | null;
  /** O CLI manda `session_state_changed` (ver o `env` do `query`): é ele, e não o resultado, que diz quando parou. */
  private stateEvents = false;

  constructor(opts: RunOptions, host: RunHost, onExit: () => void) {
    this.cwd = opts.cwd;
    this.host = host;
    this.chosenModel = opts.model;
    this.effort = opts.effort ?? null;
    const append = opts.instructions;
    const beforeWrite = opts.beforeWrite;

    this.q = query({
      prompt: this.input,
      options: {
        cwd: opts.cwd,
        resume: opts.resume,
        resumeSessionAt: opts.resumeAt,
        forkSession: opts.fork,
        sessionId: opts.sessionId,
        model: opts.model,
        effort: opts.effort as EffortLevel | undefined,
        permissionMode: opts.permissionMode as PermissionMode | undefined,
        title: opts.title,
        // Anexos do celular ficam fora do projeto; liberados para leitura sem pedir aprovação. Os outros
        // projetos e os arquivos do workspace também.
        additionalDirectories: [UPLOADS_DIR, ...opts.directories],
        // O `settings.local.json` não é versionado e não existe no worktree: sem isto, o que você já liberou
        // no projeto voltaria a pedir aprovação.
        projectConfigRoot: opts.configRoot,
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(append ? { append } : {}) },
        agents: opts.team ? agentsOf(opts.team) : undefined,
        // As habilidades do edit.r como plugin: o Claude as vê como skills (`/editr:nome`).
        plugins: opts.skills ? [{ type: 'local', path: opts.skills, skipMcpDiscovery: true }] : undefined,
        // O MCP do edit.r: o Claude cria TODOs, times, workspaces e habilidades; ler e criar passam sem aprovação.
        // A regra vai na camada de flags, e não em `allowedTools`: dá no mesmo, sem o SDK avisar a cada
        // abertura que o `canUseTool` não é chamado para elas.
        mcpServers: opts.mcp ? { [opts.mcp.name]: sdkMcp(opts.mcp) } : undefined,
        settings: opts.mcp
          ? { permissions: { allow: opts.mcp.tools.filter((t) => t.allowed).map((t) => `mcp__${opts.mcp!.name}__${t.name}`) } }
          : undefined,
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        // O celular mostra o que cada subagente faz: falas e raciocínio também, não só as ferramentas,
        // e de tempos em tempos uma linha do Claude Code resumindo o andamento.
        forwardSubagentText: true,
        agentProgressSummaries: true,
        canUseTool: this.canUseTool,
        // A pasta de memória do projeto é liberada para escrita sem passar pelo `canUseTool`: só um hook a vê.
        hooks: beforeWrite ? { PreToolUse: [{ matcher: 'Write|Edit', hooks: [this.writeHook(beforeWrite)] }] } : undefined,
        // Sem o EMIT o SDK engole os `session_state_changed`, e um turno que o Claude começa sozinho
        // (tarefa em segundo plano terminou) não tira a sessão de "Concluída".
        // O Claude Code deixa a ferramenta Artifact desligada quando sobe pelo SDK (`sdk_default_off`), e
        // o edit.r mostra os protótipos que ela publica: liga aqui, antes do ambiente, para que
        // `CLAUDE_CODE_ARTIFACT=0` no serviço ainda desligue. Conta, plano e `enableArtifact` seguem valendo.
        env: { CLAUDE_CODE_ARTIFACT: '1', ...childEnv(), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
        stderr: (data) => {
          this.stderrTail = (this.stderrTail + data).slice(-4_000);
        },
      },
    });
    void this.pump().finally(onExit);
  }

  // ---- o contrato (ver providers/types.ts) ----

  send(turn: UserTurn): void {
    const after = turn.context ? [{ type: 'text' as const, text: turn.context }] : [];
    const images = (turn.blocks ?? []).map((b) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: b.mediaType as 'image/png', data: b.data },
    }));
    const content = images.length || after.length ? [...images, ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []), ...after] : turn.text;
    // O `uuid` não está no tipo do SDK, mas o CLI o usa como ID da entrada no transcript.
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: turn.uuid } as SDKUserMessage);
  }

  async setModel(model: string): Promise<void> {
    await this.q.setModel(model);
    this.chosenModel = model;
  }

  async setEffort(effort: string): Promise<void> {
    await this.q.applyFlagSettings({ effortLevel: effort as EffortLevel });
    this.effort = effort;
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.q.setPermissionMode(mode as PermissionMode);
  }

  async interrupt(): Promise<void> {
    await this.q.interrupt();
  }

  async contextUsage(): Promise<ContextUsage> {
    const c = await this.q.getContextUsage({ detail: 'summary' });
    return {
      model: c.model,
      totalTokens: c.totalTokens,
      maxTokens: c.maxTokens,
      autoCompactThreshold: c.autoCompactThreshold ?? null,
      autoCompactEnabled: c.isAutoCompactEnabled,
    };
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

  /**
   * O plugin das habilidades foi refeito (uma ligada, desligada, criada ou editada): o processo relê
   * sem reiniciar, e a lista de comandos é pedida de novo.
   */
  async reloadSkills(): Promise<void> {
    this.commandsCache = undefined;
    await this.q.reloadPlugins();
  }

  end(): void {
    this.input.close();
  }

  kill(): void {
    this.q.close();
  }

  // ---- o que o ClaudeProvider pergunta a uma conversa aberta, em vez de subir uma sonda ----

  /** Modelos disponíveis, com os níveis de esforço de cada um (consulta o processo uma vez). */
  models(): Promise<ModelInfo[]> {
    this.modelsCache ??= this.q.supportedModels();
    return this.modelsCache;
  }

  /** Comandos e skills disponíveis nesta sessão (consulta o processo uma vez). */
  commands(): Promise<SlashCommand[]> {
    this.commandsCache ??= this.q.supportedCommands();
    return this.commandsCache;
  }

  /** Uso do plano consultado pelo próprio processo desta sessão. */
  planUsage(): Promise<PlanUsage> {
    return readPlanUsage(this.q);
  }

  /** Skills, agentes e servidores MCP desta sessão (ver setup.ts). */
  setup(): Promise<RawSetup> {
    return probeSetup(this.q);
  }

  /** Liga ou desliga um servidor MCP: vale já nesta sessão e fica gravado para a pasta. */
  async toggleMcp(name: string, enabled: boolean): Promise<void> {
    await this.q.toggleMcpServer(name, enabled);
    this.commandsCache = undefined;
  }

  // ---- internos ----

  private canUseTool: CanUseTool = async (toolName, input, opts) => {
    // Pergunta malformada cai no fluxo de aprovação comum, que ao menos mostra o input.
    const questions = toolName === 'AskUserQuestion' ? parseQuestions(input) : [];
    if (questions.length) {
      const reply = await this.host.ask({ questions, toolUseId: opts.toolUseID, signal: opts.signal });
      return reply.answered ? { behavior: 'allow', updatedInput: { ...input, answers: reply.answers } } : { behavior: 'deny', message: reply.message };
    }
    const decision = await this.host.approve({
      toolName,
      input,
      toolUseId: opts.toolUseID,
      title: opts.title,
      decisionReason: opts.decisionReason,
      blockedPath: opts.blockedPath,
      canAlwaysAllow: Boolean(opts.suggestions?.length),
      signal: opts.signal,
    });
    return decision.allow
      ? { behavior: 'allow', updatedInput: input, updatedPermissions: decision.always ? opts.suggestions : undefined }
      : { behavior: 'deny', message: decision.message };
  };

  /** O recado do edit.r nega a ferramenta sem travar a conversa: o Claude lê e segue. */
  private writeHook(check: NonNullable<RunOptions['beforeWrite']>): HookCallback {
    return async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      // Se a checagem falhou, a ferramenta passa como sempre passou.
      const reason = await check(input.tool_name, input.tool_input).catch(() => null);
      if (!reason) return {};
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    };
  }

  private async pump(): Promise<void> {
    let error: string | undefined;
    try {
      for await (const msg of this.q) this.handle(msg);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (this.stderrTail) error += `\n${this.stderrTail.trim()}`;
    }
    this.host.exit(error);
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
    this.host.settings({ model: keep ? chosen : model, effort, permissionMode });
  }

  private handle(msg: SDKMessage): void {
    const host = this.host;
    // O /clear (e os outros jeitos de recomeçar a conversa): a tela esvazia, sem fechar a conversa, e ela
    // passa para o id novo.
    if (msg.type === 'conversation_reset') return host.reset(msg.new_conversation_id ?? undefined);
    if (msg.type === 'system' && msg.subtype === 'init') {
      host.rekey(msg.session_id);
      // O init nem sempre traz o esforço; sem ele, vale o último escolhido.
      this.effort = msg.effort ?? this.effort ?? null;
      void this.settingsFromInit(msg.model, this.effort, msg.permissionMode);
    }
    // O modo muda sozinho, por exemplo ao aprovar a saída do modo de plano.
    if (msg.type === 'system' && msg.subtype === 'status' && msg.permissionMode) host.settings({ permissionMode: msg.permissionMode });
    if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
      this.stateEvents = true;
      host.state(msg.state === 'running' ? 'running' : msg.state === 'idle' ? 'idle' : 'waiting');
    }
    // Compactação: começa com o status "compacting" e acaba com a marca de fronteira (ou o fim do turno).
    if (msg.type === 'system' && msg.subtype === 'status') host.compacting(msg.status === 'compacting');
    if ((msg.type === 'system' && msg.subtype === 'compact_boundary') || msg.type === 'result') host.compacting(false);

    // O UUID vem junto para o que chega ao vivo também, senão só daria para bifurcar no histórico
    // já lido do arquivo — e não no turno que acabou de acontecer.
    const uuid = (msg as { uuid?: string }).uuid;
    // Resultados de ferramentas podem trazer imagens (prints, arquivos lidos): vão para o cache.
    const sink = msg.type === 'user' ? host.images(uuid ?? randomUUID()) : undefined;
    const { events, delta } = fromSdkMessage(msg, sink);
    // O esforço não vem na mensagem: é o ajuste da sessão agora. Subagente pensa com o dele, que não se sabe daqui.
    if (msg.type === 'assistant' && msg.parent_tool_use_id === null) stampAssistant(events, undefined, this.effort);
    if (events.length) host.events(events, uuid);
    // O fim do turno não é o fim do trabalho: com mensagem na fila, o CLI emenda outro turno sem parar, e quem
    // diz que parou é o `session_state_changed` "idle". Só sem esses avisos o resultado faz as vezes dele.
    if (msg.type === 'result') host.turnEnd(!this.stateEvents);
    if (delta) host.delta(delta);

    const tasks = [...this.agents.fromMessage(msg), ...this.background.fromMessage(msg)];
    if (tasks.length) host.events(tasks);
  }
}
