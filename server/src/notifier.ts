import { homedir } from 'node:os';
import { basename } from 'node:path';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { fromSessionMessage, parseQuestions, type LoggedEvent, type Question } from './events.ts';
import type { LiveRegistry, LiveSession } from './live.ts';
import type { Manager } from './manager.ts';
import type { PushService, SendOptions } from './push.ts';

const HOUR = 3_600;
const DAY = 24 * HOUR;
const TITLE_MAX = 80;
const BODY_MAX = 240;

// Perguntas e aprovações travam o turno: entrega imediata, mesmo com o celular economizando bateria.
const ATTENTION: SendOptions = { needs: [], urgency: 'high', ttl: DAY };
const FAILED: SendOptions = { needs: [], urgency: 'normal', ttl: DAY };
const DONE: SendOptions = { needs: ['done'], urgency: 'normal', ttl: HOUR };
const PC_WAITING: SendOptions = { needs: ['pc'], urgency: 'high', ttl: HOUR };
const PC_DONE: SendOptions = { needs: ['pc', 'done'], urgency: 'normal', ttl: HOUR };

/**
 * Turnos curtos no terminal quase sempre têm alguém olhando a tela do PC. Para as sessões
 * do painel não há limite: o celular já esconde o aviso da conversa que está aberta.
 */
const PC_DONE_MIN_MS = 60_000;

/**
 * Decide o que vira notificação no celular: perguntas, aprovações, fim de turno e erros das
 * sessões do painel, e as sessões abertas no PC que passam a esperar alguém ou terminam.
 */
export class Notifier {
  private readonly manager: Manager;
  private readonly live: LiveRegistry;
  private readonly push: PushService;
  /** Última fala do Claude no turno em andamento, para o aviso de "terminou". */
  private readonly lastReply = new Map<string, string>();
  /** Último resultado de turno, até a sessão parar: com mensagem na fila, o CLI emenda outro turno. */
  private readonly lastResult = new Map<string, Extract<LoggedEvent, { kind: 'result' }>>();
  /** Estado anterior das sessões vivas no PC; `undefined` até a primeira leitura. */
  private pc?: Map<string, { status: LiveSession['status']; since: number }>;

  constructor(manager: Manager, live: LiveRegistry, push: PushService) {
    this.manager = manager;
    this.live = live;
    this.push = push;
    manager.on('event', (sessionId: string, ev: LoggedEvent) => void this.onPanelEvent(sessionId, ev).catch(this.fail));
    live.on('change', () => void this.onLiveChange().catch(this.fail));
  }

  // Mesmo destino das falhas de envio: o log do serviço.
  private fail = (err: unknown) => this.push.emit('error', err);

  private async onPanelEvent(sessionId: string, ev: LoggedEvent): Promise<void> {
    switch (ev.kind) {
      case 'user':
        this.lastReply.delete(sessionId);
        return;
      case 'assistant':
        if (!ev.parentToolUseId) this.lastReply.set(sessionId, ev.text);
        return;
      case 'question_request':
        return this.send(sessionId, 'Pergunta', questionText(ev.questions), ATTENTION);
      case 'approval_request':
        return this.send(sessionId, 'Aprovação', toolText(ev.toolName, ev.input), ATTENTION);
      case 'result':
        // O fim do turno não é o fim do trabalho: o aviso espera a sessão parar.
        this.lastResult.set(sessionId, ev);
        return;
      case 'state': {
        const result = this.lastResult.get(sessionId);
        if (ev.state !== 'idle' || !result) return;
        this.lastResult.delete(sessionId);
        // Algo ainda roda em segundo plano (monitor, comando, subagente): o Claude vai voltar, não terminou.
        if (this.manager.find(sessionId)?.pendingWork) return;
        const reply = this.lastReply.get(sessionId);
        this.lastReply.delete(sessionId);
        return this.send(sessionId, resultLabel(result), reply ? plain(reply) : `Turno de ${duration(result.durationMs)}`, DONE);
      }
      case 'exit':
        this.lastReply.delete(sessionId);
        this.lastResult.delete(sessionId);
        if (ev.error) return this.send(sessionId, 'Sessão caiu', ev.error.split('\n')[0] ?? ev.error, FAILED);
        return;
    }
  }

  private async onLiveChange(): Promise<void> {
    const before = this.pc;
    const now = Date.now();
    // O processo headless do painel também aparece em `claude agents`; esse já avisa pelos eventos.
    const rows = this.live.all().filter((l) => !this.manager.find(l.sessionId));
    this.pc = new Map(
      rows.map((l) => {
        const prev = before?.get(l.sessionId);
        return [l.sessionId, { status: l.status, since: prev?.status === l.status ? prev.since : now }];
      }),
    );
    // Primeira leitura (servidor subindo): só registra, sem avisar do que já estava assim.
    if (!before || !this.push.hasSubscribers) return;

    for (const l of rows) {
      const prev = before.get(l.sessionId);
      if (l.status === 'waiting' && prev?.status !== 'waiting') {
        const { tool } = await savedTurn(l.sessionId);
        await this.send(l.sessionId, 'Aguardando no PC', pcWaitingText(l.waitingFor, tool), PC_WAITING);
      } else if (l.status === 'idle' && prev?.status === 'busy' && now - prev.since >= PC_DONE_MIN_MS) {
        const { reply } = await savedTurn(l.sessionId);
        await this.send(l.sessionId, 'Terminou no PC', reply ? plain(reply) : `Turno de ${duration(now - prev.since)}`, PC_DONE);
      }
    }
  }

  private async send(sessionId: string, label: string, body: string, opts: SendOptions): Promise<void> {
    if (!this.push.hasSubscribers) return;
    const title = clip(`${label} · ${await this.titleOf(sessionId)}`, TITLE_MAX);
    await this.push.notify(
      { title, body: clip(body.trim(), BODY_MAX), tag: sessionId, url: `/s/${sessionId}`, ts: Date.now() },
      { ...opts, topic: sessionId.replaceAll('-', '').slice(0, 32) },
    );
  }

  /** O mesmo título da lista de sessões; sem título ainda, o nome do projeto. */
  private async titleOf(sessionId: string): Promise<string> {
    const entry = (await this.manager.catalog().catch(() => [])).find((e) => e.sessionId === sessionId);
    if (entry && !entry.title.startsWith('(')) return entry.title;
    return entry?.cwd ? basename(entry.cwd) : 'Claude';
  }
}

type ToolCall = { name: string; input: unknown };

/** Última fala do Claude e última ferramenta chamada no turno atual, lidas da conversa salva. */
async function savedTurn(sessionId: string): Promise<{ reply?: string; tool?: ToolCall }> {
  const messages = await getSessionMessages(sessionId).catch(() => []);
  let reply: string | undefined;
  let tool: ToolCall | undefined;
  for (let i = messages.length - 1; i >= 0 && !(reply && tool); i--) {
    const events = fromSessionMessage(messages[i]!);
    // Prompt do usuário: começo do turno, o que vem antes é de outro.
    if (events.some((e) => e.kind === 'user')) break;
    for (const e of events.reverse()) {
      if (e.kind === 'assistant' && !e.parentToolUseId) reply ??= e.text;
      if (e.kind === 'tool_use' && !e.parentToolUseId) tool ??= { name: e.name, input: e.input };
    }
  }
  return { reply, tool };
}

function pcWaitingText(waitingFor: string | undefined, tool: ToolCall | undefined): string {
  if (tool?.name === 'AskUserQuestion') {
    const questions = parseQuestions((tool.input ?? {}) as Record<string, unknown>);
    if (questions.length) return questionText(questions);
  }
  if (waitingFor === 'permission prompt') return tool ? `Pede aprovação: ${toolText(tool.name, tool.input)}` : 'Pede aprovação';
  if (waitingFor === 'input needed') return 'Esperando sua resposta';
  return 'Esperando você';
}

function questionText(questions: Question[]): string {
  const [first, ...rest] = questions;
  if (!first) return 'O Claude tem uma pergunta';
  const options = first.options.map((o) => o.label).filter(Boolean).join(' · ');
  const more = rest.length ? `\n+${rest.length} ${rest.length > 1 ? 'perguntas' : 'pergunta'}` : '';
  return `${first.question}${options ? `\n${options}` : ''}${more}`;
}

/** O que a ferramenta vai fazer, em uma ou duas linhas (como o resumo do chat). */
function toolText(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Bash':
      return [str(i.description), `$ ${str(i.command)}`].filter(Boolean).join('\n');
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editar ${shortPath(str(i.file_path) || str(i.notebook_path))}`;
    case 'Write':
      return `Gravar ${shortPath(str(i.file_path))}`;
    case 'WebFetch':
      return `Abrir ${str(i.url)}`;
    case 'WebSearch':
      return `Pesquisar "${str(i.query)}"`;
    case 'ExitPlanMode':
      return 'Plano pronto para revisão';
    default:
      return `Usar ${name}`;
  }
}

function shortPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** Mesmos rótulos do fim de turno no chat. */
function resultLabel(ev: Extract<LoggedEvent, { kind: 'result' }>): string {
  if (ev.ok) return 'Terminou';
  if (ev.subtype === 'error_during_execution') return 'Interrompido';
  if (ev.subtype === 'error_max_turns') return 'Parou no limite de turnos';
  return 'Terminou com erro';
}

/** Resposta em Markdown vira texto corrido: a notificação não formata. */
function plain(text: string): string {
  return text
    .replace(/^```.*$/gm, '')
    .replace(/^ {0,3}(#{1,6}|>) ?/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
