
export type SessionState = 'starting' | 'running' | 'waiting' | 'idle' | 'exited';

export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped';
/** Tarefa em segundo plano viva (ver tasks.ts). `type`: local_bash (comando ou monitor), local_agent, local_workflow… */
export type BackgroundTask = {
  taskId: string;
  /** Chamada que a criou (Bash, Monitor, Agent): o celular tira dela o comando e o tipo. */
  toolUseId?: string;
  type: string;
  description: string;
  subagentType?: string;
  startedAt: number;
};
export type AgentUsage = { tokens: number; toolUses: number; durationMs: number };

/** Pergunta de múltipla escolha feita pelo agente (ferramenta AskUserQuestion). */
export type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string; preview?: string }[];
};

/**
 * Por onde, de que máquina e quando uma mensagem sua saiu. `via`: o app (`editr`), o terminal, o VSCode
 * ou o app de desktop do Claude; `mobile`: o aparelho é um celular ou tablet. Cada campo falta quando
 * não se sabe (mensagens do app de antes de o edit.r guardar o aparelho, por exemplo).
 */
export type Sent = { via?: 'editr' | 'terminal' | 'vscode' | 'desktop'; device?: string; mobile?: boolean; at?: number };

/** Evento normalizado enviado ao celular; o mesmo formato serve para histórico e tempo real. */
export type PanelEvent =
  /**
   * `images`: chaves no cache de imagens (GET /api/sessions/:id/images/:key).
   * `clientId`: ID da mensagem na fila do celular, para ele saber que ela chegou.
   */
  | { kind: 'user'; text: string; images?: string[]; clientId?: string; sent?: Sent }
  | { kind: 'notice'; text: string }
  /** `model` e `effort`: o modelo que escreveu a resposta e o esforço com que pensou, quando se sabe. */
  | { kind: 'assistant'; text: string; parentToolUseId?: string | null; model?: string; effort?: string }
  | { kind: 'thinking'; text: string; parentToolUseId?: string | null }
  | { kind: 'tool_use'; id: string; name: string; input: unknown; parentToolUseId?: string | null }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; text: string; images?: string[] }
  /** Modelo, esforço e modo de permissão vigentes (no início de cada turno e a cada mudança). */
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
      input: unknown;
      /** Chamada que pede aprovação: o `parentToolUseId` dela diz se veio de um subagente. */
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
  /**
   * Novidade de um subagente, ligada à chamada da ferramenta Agent que o criou. Traz só o que
   * mudou; o celular junta tudo num nó do grafo de agentes.
   */
  | {
      kind: 'agent';
      toolUseId: string;
      agentId?: string;
      status?: AgentStatus;
      background?: boolean;
      /** O que ele está fazendo agora, em uma linha (ex.: "Reading src/app.ts"). */
      activity?: string;
      /** Resumo periódico feito pelo Claude Code do que ele vem fazendo. */
      summary?: string;
      usage?: AgentUsage;
      /** Relatório final, quando termina. */
      result?: string;
      error?: string;
    }
  /** Tarefas em segundo plano vivas, a lista inteira a cada mudança (vazia quando a última termina). */
  | { kind: 'tasks'; tasks: BackgroundTask[] }
  | { kind: 'result'; ok: boolean; subtype: string; durationMs: number; costUsd?: number; turns: number }
  | { kind: 'exit'; error?: string };

/**
 * `uuid`: a entrada do log de onde o evento veio. É por ele que uma bifurcação sabe onde cortar a
 * conversa (ver `Manager.open`); só vem no histórico lido do arquivo, que é de onde se bifurca.
 */
/**
 * `ts`: quando chegou ao vivo (0 no histórico salvo). `time`: quando o Claude Code gravou a mensagem,
 * do transcript; só no histórico, para o app mostrar quanto cada ferramenta levou.
 */
export type LoggedEvent = PanelEvent & { seq: number; ts: number; uuid?: string; time?: number };

/**
 * Extrai as perguntas do input da ferramenta AskUserQuestion; vazio se o formato não bater. É o
 * formato do Claude Code, que serve de vocabulário do painel (ver providers/types.ts).
 */
export function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
  return raw.flatMap((q) => {
    if (typeof q?.question !== 'string' || !Array.isArray(q.options)) return [];
    const options = (q.options as Record<string, unknown>[]).map((o) => ({
      label: String(o.label ?? ''),
      description: String(o.description ?? ''),
      preview: typeof o.preview === 'string' ? o.preview : undefined,
    }));
    return [{ question: q.question, header: String(q.header ?? ''), multiSelect: Boolean(q.multiSelect), options }];
  });
}
