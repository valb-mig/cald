import { basename } from 'node:path';

/**
 * A salinha: cada conversa aberta é um setor e cada claudinho (a conversa e os subagentes dela)
 * vai até a estação do que está fazendo agora. Aqui sai o que cada um faz; o desenho é do celular.
 */

/** Estação da salinha: mesa com PC (web), gaveteiro (arquivos), bancada (edição), terminal, quadro, café, porta, sofá. */
export type OfficeActivity = 'web' | 'files' | 'edit' | 'command' | 'plan' | 'think' | 'ask' | 'compact' | 'background' | 'idle';

export type OfficeWorker = {
  id: string;
  name: string;
  /** "gestor" para a conversa; o tipo do subagente para os outros. */
  role: string;
  activity: OfficeActivity;
  /** "Read · manager.ts", "Pensando"… */
  detail?: string;
};

/** O que acabou de acontecer, para a salinha animar uma vez: folha na pilha, fumaça, caixa no elevador… */
export type OfficeEventKind = 'edit' | 'error' | 'test-pass' | 'test-fail' | 'commit' | 'push' | 'skill';
/** `worker`: "lead" (a conversa) ou o id do subagente, como em `OfficeWorker.id`. */
export type OfficeEvent = { id: string; at: number; kind: OfficeEventKind; worker: string; detail?: string };

/** A lista de tarefas da conversa (TodoWrite), para o quadro. */
export type OfficeTodos = { done: number; total: number; current?: string };

export type OfficeSnapshot = { workers: OfficeWorker[]; events: OfficeEvent[]; todos?: OfficeTodos; model?: string };

/** Ferramenta em uso: `scope` é a chamada do subagente que a usa (`null`: a própria conversa). */
export type OpenTool = { id: string; name: string; input: unknown; scope: string | null };

export const AGENT_TOOLS = new Set(['Agent', 'Task']);
const WEB = /^(WebFetch|WebSearch)$|^mcp__.*(browser|playwright|chrome|puppeteer|fetch|search)/i;
const FILES = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const EDIT = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const PLAN = new Set(['TodoWrite', 'ExitPlanMode', 'EnterPlanMode', 'Skill', 'Agent', 'Task']);

// Comandos do terminal que só leem (vão ao gaveteiro) ou buscam na rede (vão ao PC).
const BASH_READ = /^(cat|less|head|tail|sed|awk|grep|rg|ag|ls|tree|find|fd|wc|file|stat|du|jq|bat|diff)\b/;
const BASH_WEB = /^(curl|wget|http|xh)\b|^gh (api|search)\b/;
const TESTS = /\b(test|tests|vitest|jest|pytest|phpunit|pest|mocha|rspec)\b/;
const COMMIT = /\bgit\b[^|;&]*\bcommit\b/;
const PUSH = /\bgit\b[^|;&]*\bpush\b|\bgh pr (create|merge)\b/;
// Recusa sua não é erro do Claude: não solta fumaça.
const DENIED = /doesn't want to proceed|was rejected|denied/i;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const inputOf = (input: unknown) => (input ?? {}) as Record<string, unknown>;

/** O comando sem os `cd pasta &&` do começo. */
const bashCommand = (input: unknown) => str(inputOf(input).command).trim().replace(/^(cd\s+[^;&|]+(&&|;)\s*)+/, '');

export function activityOf(tool: string, input?: unknown): OfficeActivity {
  if (tool === 'Bash') {
    const cmd = bashCommand(input);
    if (BASH_READ.test(cmd)) return 'files';
    if (BASH_WEB.test(cmd)) return 'web';
    return 'command';
  }
  if (WEB.test(tool)) return 'web';
  if (FILES.has(tool)) return 'files';
  if (EDIT.has(tool)) return 'edit';
  if (PLAN.has(tool)) return 'plan';
  if (tool === 'AskUserQuestion') return 'ask';
  return 'command';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "Read · manager.ts", "Bash · Roda os testes", "WebSearch · claude code salinha". */
export function toolLine(name: string, input: unknown): string {
  const i = inputOf(input);
  const label = name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : name;
  let detail = '';
  if (name === 'Bash') detail = str(i.description) || str(i.command).split('\n')[0];
  else if (FILES.has(name) || EDIT.has(name)) detail = basename(str(i.file_path) || str(i.notebook_path) || str(i.path)) || str(i.pattern);
  else if (name === 'Grep' || name === 'Glob') detail = str(i.pattern);
  else if (name === 'WebFetch') detail = hostOf(str(i.url));
  else if (name === 'WebSearch') detail = str(i.query);
  else if (name === 'Skill') detail = str(i.skill);
  else if (AGENT_TOOLS.has(name)) detail = str(i.description);
  if (FILES.has(name) && !detail) detail = str(i.pattern);
  const line = detail ? `${label} · ${detail}` : label;
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** O que o resultado de uma ferramenta tem de animável. */
function eventKinds(tool: OpenTool, isError: boolean, text: string): OfficeEventKind[] {
  if (isError && DENIED.test(text)) return [];
  if (tool.name === 'Bash') {
    const cmd = bashCommand(tool.input);
    if (TESTS.test(cmd)) return [isError ? 'test-fail' : 'test-pass'];
    if (isError) return ['error'];
    return [...(COMMIT.test(cmd) ? (['commit'] as const) : []), ...(PUSH.test(cmd) ? (['push'] as const) : [])];
  }
  if (isError) return ['error'];
  if (EDIT.has(tool.name)) return ['edit'];
  if (tool.name === 'Skill') return ['skill'];
  return [];
}

export function todosOf(input: unknown): OfficeTodos | undefined {
  const list = inputOf(input).todos;
  if (!Array.isArray(list)) return undefined;
  const todos = list as { content?: unknown; activeForm?: unknown; status?: unknown }[];
  const active = todos.find((t) => t.status === 'in_progress');
  return {
    done: todos.filter((t) => t.status === 'completed').length,
    total: todos.length,
    current: active ? str(active.activeForm) || str(active.content) : undefined,
  };
}

// A última ferramenta fica na tela mais um pouco: Read e Edit acabam em milissegundos, antes da salinha perguntar.
const STICKY_MS = 6_000;
// Eventos ficam disponíveis por um tempo; o celular anima cada um uma vez só (pelo id).
export const EVENTS_MS = 30_000;

/** O que a salinha lembra de uma conversa: a última ferramenta de cada um, o que acabou de acontecer e as tarefas. */
export class OfficeLog {
  private readonly last = new Map<string | null, { tool: OpenTool; at: number }>();
  private events: OfficeEvent[] = [];
  todos?: OfficeTodos;

  use(tool: OpenTool): void {
    if (tool.name === 'TodoWrite' && tool.scope === null) this.todos = todosOf(tool.input) ?? this.todos;
  }

  result(tool: OpenTool, isError: boolean, text: string, at = Date.now()): void {
    if (!AGENT_TOOLS.has(tool.name)) this.last.set(tool.scope, { tool, at });
    const detail = toolLine(tool.name, tool.input);
    for (const kind of eventKinds(tool, isError, text)) {
      this.events.push({ id: `${tool.id}:${kind}`, at, kind, worker: tool.scope ?? 'lead', detail });
    }
    const now = Date.now();
    this.events = this.events.filter((e) => now - e.at < EVENTS_MS);
  }

  /** Ferramenta que acabou há pouco: o claudinho fica mais um pouco na estação dela. */
  recent(scope: string | null, now = Date.now()): OpenTool | undefined {
    const l = this.last.get(scope);
    return l && now - l.at < STICKY_MS ? l.tool : undefined;
  }

  recentEvents(now = Date.now()): OfficeEvent[] {
    return this.events.filter((e) => now - e.at < EVENTS_MS);
  }
}

export type OfficeAgent = { id: string; name: string; type: string };

/**
 * Quem está na sala e o que faz, a partir das ferramentas em uso. Sem ferramenta rodando no
 * meio do turno, o claudinho está pensando (café); com subagentes trabalhando, coordena (quadro).
 */
export function workersFrom(o: {
  tools: OpenTool[];
  agents: OfficeAgent[];
  /** Turno em andamento. */
  busy: boolean;
  /** Esperando você (aprovação ou pergunta). */
  waiting: boolean;
  waitingFor?: string;
  /** Chamadas esperando aprovação: quem as fez vai até a porta. */
  asking: Set<string>;
  /** Algo em segundo plano vai trazer o Claude de volta. */
  background: boolean;
  /** Compactando a conversa: o gestor vai ao arquivo. */
  compacting?: boolean;
  /** Ferramenta que acabou há pouco, de cada um (ver OfficeLog). */
  recent?: (scope: string | null) => OpenTool | undefined;
}): OfficeWorker[] {
  const of = (scope: string | null) => o.tools.filter((t) => t.scope === scope);
  const doing = (scope: string | null): Pick<OfficeWorker, 'activity' | 'detail'> | null => {
    const tools = of(scope);
    const asked = tools.find((t) => o.asking.has(t.id));
    if (asked) return { activity: 'ask', detail: `Pede aprovação: ${toolLine(asked.name, asked.input)}` };
    const own = tools.filter((t) => !AGENT_TOOLS.has(t.name)).at(-1);
    if (own) return { activity: activityOf(own.name, own.input), detail: toolLine(own.name, own.input) };
    if (tools.length) return { activity: 'plan', detail: 'Coordenando os subagentes' };
    // Com a conversa parada, a última ferramenta não segura o gestor na estação; pergunta respondida
    // também não (senão ele ficaria no corredor pedindo você).
    const done = scope === null && !o.busy ? undefined : o.recent?.(scope);
    if (done && activityOf(done.name, done.input) !== 'ask') return { activity: activityOf(done.name, done.input), detail: toolLine(done.name, done.input) };
    return null;
  };

  let lead = o.compacting ? { activity: 'compact' as const, detail: 'Compactando a conversa' } : doing(null);
  if (!lead && o.waiting) lead = { activity: 'ask', detail: o.waitingFor === 'input needed' ? 'Pergunta para você' : 'Pede você' };
  if (!lead && o.busy) lead = { activity: 'think', detail: 'Pensando' };
  if (!lead && o.agents.length) lead = { activity: 'plan', detail: 'Esperando os subagentes' };
  if (!lead) lead = o.background ? { activity: 'background', detail: 'Algo rodando em segundo plano' } : { activity: 'idle', detail: 'Descansando' };

  return [
    { id: 'lead', name: 'Gestor', role: 'gestor', ...lead },
    ...o.agents.map((a) => ({ id: a.id, name: a.name, role: a.type, ...(doing(a.id) ?? { activity: 'think' as const, detail: 'Pensando' }) })),
  ];
}
