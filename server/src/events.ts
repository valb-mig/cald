import type { SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImageSink, StoredImage } from './images.ts';

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

/** Pergunta de múltipla escolha feita pelo Claude (ferramenta AskUserQuestion). */
export type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string; preview?: string }[];
};

/** Evento normalizado enviado ao celular; o mesmo formato serve para histórico e tempo real. */
export type PanelEvent =
  /**
   * `images`: chaves no cache de imagens (GET /api/sessions/:id/images/:key).
   * `clientId`: ID da mensagem na fila do celular, para ele saber que ela chegou.
   */
  | { kind: 'user'; text: string; images?: string[]; clientId?: string }
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
export type LoggedEvent = PanelEvent & { seq: number; ts: number; uuid?: string };

const MAX_TEXT = 8_000;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (+${text.length - MAX_TEXT} caracteres)` : text;
}

type Block = { type?: string; [key: string]: unknown };

function imageOf(b: Block): StoredImage | null {
  const src = b.source as { type?: string; media_type?: string; data?: string } | undefined;
  if (b.type !== 'image' || src?.type !== 'base64' || !src.data) return null;
  return { mediaType: String(src.media_type ?? 'image/png'), data: src.data };
}

/** Texto de um resultado de ferramenta; imagens (prints, arquivos lidos) vão para o cache. */
function toolResultParts(content: unknown, sink?: ImageSink): { text: string; images: string[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const texts: string[] = [];
  const images: string[] = [];
  for (const b of content as Block[]) {
    const image = imageOf(b);
    if (image) {
      if (sink) images.push(sink(image));
    } else {
      texts.push(b.type === 'text' ? String(b.text ?? '') : `[${b.type}]`);
    }
  }
  return { text: texts.join('\n'), images };
}

function tag(name: string, text: string): string | undefined {
  return text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
}

const AGENT_STATUS = new Set<string>(['completed', 'failed', 'stopped']);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
/** O aviso vem em XML: `&&` de um comando chega como `&amp;&amp;`. */
const unescapeXml = (text: string) => text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, name: string) => ENTITIES[name]!);

/**
 * Aviso de tarefa em segundo plano que terminou. Se a tarefa era um subagente, vem junto a
 * novidade dele, com o relatório final (no histórico salvo é o único lugar onde ele aparece).
 */
function taskNotification(text: string): PanelEvent[] {
  const summary = tag('summary', text);
  const notice: PanelEvent = { kind: 'notice', text: summary ? unescapeXml(summary) : 'Tarefa em segundo plano terminou' };
  const toolUseId = tag('tool-use-id', text);
  const status = tag('status', text) ?? '';
  if (!toolUseId || !AGENT_STATUS.has(status)) return [notice];
  const result = tag('result', text);
  return [
    notice,
    { kind: 'agent', toolUseId, agentId: tag('task-id', text), status: status as AgentStatus, result: result ? clip(unescapeXml(result)) : undefined },
  ];
}

/**
 * Textos "de usuário" que na verdade são injetados pelo Claude Code (avisos de tarefas,
 * saída de comandos locais, lembretes) viram `notice` ou somem; o resto é prompt real.
 */
function userTextEvents(raw: string): PanelEvent[] {
  // O conteúdo dos TODOs mencionados (ver todos.ts) foi para o Claude, não para a tela.
  const text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<claude-remote-todo[^>]*>[\s\S]*?<\/claude-remote-todo>/g, '')
    .trim();
  if (!text || text.startsWith('Caveat:')) return [];
  if (text.startsWith('<task-notification>')) return taskNotification(text);
  const command = tag('command-name', text);
  if (command) return [{ kind: 'user', text: [command, tag('command-args', text)].filter(Boolean).join(' ') }];
  if (text.startsWith('<bash-input>')) return [{ kind: 'user', text: `! ${tag('bash-input', text) ?? ''}` }];
  if (/^<(local-command|bash)-(stdout|stderr)>/.test(text)) {
    const out = tag('local-command-stdout', text) ?? tag('bash-stdout', text) ?? tag('local-command-stderr', text) ?? tag('bash-stderr', text);
    return out ? [{ kind: 'notice', text: clip(out) }] : [];
  }
  if (text.startsWith('[Request interrupted by user')) return [{ kind: 'notice', text: 'Interrompido pelo usuário' }];
  return [{ kind: 'user', text }];
}

/** Converte o conteúdo de uma mensagem da API (user/assistant) em eventos do painel. */
export function fromContent(
  role: 'user' | 'assistant',
  content: unknown,
  parentToolUseId: string | null = null,
  sink?: ImageSink,
): PanelEvent[] {
  if (typeof content === 'string') {
    if (role === 'user') return userTextEvents(content);
    return content.trim() ? [{ kind: 'assistant', text: content, parentToolUseId }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: PanelEvent[] = [];
  for (const b of content as Block[]) {
    switch (b.type) {
      case 'text': {
        const text = String(b.text ?? '');
        if (role === 'user') {
          out.push(...userTextEvents(text));
        } else if (text.trim()) {
          out.push({ kind: 'assistant', text, parentToolUseId });
        }
        break;
      }
      case 'thinking':
        if (String(b.thinking ?? '').trim()) out.push({ kind: 'thinking', text: clip(String(b.thinking)), parentToolUseId });
        break;
      case 'tool_use':
        out.push({ kind: 'tool_use', id: String(b.id), name: String(b.name), input: b.input, parentToolUseId });
        break;
      case 'tool_result': {
        const parts = toolResultParts(b.content, sink);
        out.push({
          kind: 'tool_result',
          toolUseId: String(b.tool_use_id),
          isError: Boolean(b.is_error),
          text: clip(parts.text),
          images: parts.images.length ? parts.images : undefined,
        });
        break;
      }
    }
  }

  // Imagens coladas ou anexadas pelo usuário: vão para o cache e o prompt leva as chaves.
  if (role === 'user' && sink) {
    const keys = (content as Block[]).flatMap((b) => {
      const image = imageOf(b);
      return image ? [sink(image)] : [];
    });
    if (keys.length) {
      const prompt = out.find((e): e is Extract<PanelEvent, { kind: 'user' }> => e.kind === 'user');
      if (prompt) prompt.images = keys;
      else out.unshift({ kind: 'user', text: '', images: keys });
    }
  }
  return out;
}

/** Extrai as perguntas do input da ferramenta AskUserQuestion; vazio se o formato não bater. */
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

/**
 * Marca nas respostas quem as escreveu. O modelo vem na própria mensagem da API; o esforço, de fora
 * (o transcript guarda ao lado da mensagem, e ao vivo vale o ajuste da sessão). Mensagens sintéticas
 * (erro da API, `<synthetic>`) não têm modelo de verdade e ficam sem.
 */
export function stampAssistant(events: PanelEvent[], model?: string, effort?: string | null): PanelEvent[] {
  const real = model && !model.startsWith('<') ? model : undefined;
  for (const e of events) {
    if (e.kind !== 'assistant') continue;
    if (real) e.model = real;
    if (effort) e.effort = effort;
  }
  return events;
}

/** Histórico salvo (getSessionMessages) → eventos. `effort`: o do transcript para esta mensagem. */
export function fromSessionMessage(m: SessionMessage, sink?: ImageSink, effort?: string): PanelEvent[] {
  if (m.type !== 'user' && m.type !== 'assistant') return [];
  const message = m.message as { content?: unknown; model?: string } | null;
  const events = fromContent(m.type, message?.content, m.parent_tool_use_id, sink);
  return m.type === 'assistant' ? stampAssistant(events, message?.model, effort) : events;
}

/** Mensagem do stream do SDK → eventos persistentes + texto parcial efêmero. */
export function fromSdkMessage(msg: SDKMessage, sink?: ImageSink): { events: PanelEvent[]; delta?: string } {
  switch (msg.type) {
    case 'assistant':
      return { events: stampAssistant(fromContent('assistant', msg.message.content, msg.parent_tool_use_id), msg.message.model) };
    case 'user':
      // Prompts do usuário já são registrados no envio; aqui só interessam resultados de ferramentas.
      return { events: fromContent('user', msg.message.content, null, sink).filter((e) => e.kind === 'tool_result') };
    case 'result':
      return {
        events: [
          {
            kind: 'result',
            ok: msg.subtype === 'success' && !msg.is_error,
            subtype: msg.subtype,
            durationMs: msg.duration_ms,
            costUsd: msg.total_cost_usd,
            turns: msg.num_turns,
          },
        ],
      };
    case 'stream_event': {
      const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } };
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && msg.parent_tool_use_id === null) {
        return { events: [], delta: ev.delta.text ?? '' };
      }
      return { events: [] };
    }
    case 'system':
      if (msg.subtype === 'init') {
        return { events: [{ kind: 'init', model: msg.model, permissionMode: msg.permissionMode, cwd: msg.cwd }] };
      }
      // 'requesting' sai a cada chamada à API; só compactação interessa ao celular.
      if (msg.subtype === 'status' && msg.status === 'compacting') return { events: [{ kind: 'status', status: msg.status }] };
      return { events: [] };
    default:
      return { events: [] };
  }
}
