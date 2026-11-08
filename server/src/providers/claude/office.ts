import { open, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EVENTS_MS, OfficeLog, todosOf, workersFrom, type OfficeAgent, type OfficeSnapshot, type OfficeTodos, type OpenTool } from '../../office.ts';
import type { LiveSession } from './live.ts';
import { transcriptPath } from './transcript.ts';

// ---------------------------------------------------------------------------
// Conversas abertas no PC: o que fazem sai do fim do transcript, que o Claude Code grava ao vivo.
// ---------------------------------------------------------------------------

const str = (v: unknown) => (typeof v === 'string' ? v : '');

const TAIL_BYTES = 256 * 1024;
// Subagente cujo transcript não muda há mais que isso terminou (ou está parado esperando).
const AGENT_FRESH_MS = 45_000;

type Block = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown };
type Line = { type?: string; isSidechain?: boolean; timestamp?: string; message?: { content?: unknown; model?: string } };

async function tail(path: string): Promise<string[]> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await file.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    // A primeira linha do pedaço pode ter vindo cortada.
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await file.close();
  }
}

const resultText = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => str((c as { text?: unknown }).text)).join('\n') : '';

/** Ferramentas ainda sem resultado (na ordem), as que terminaram, a última lista de tarefas e o modelo. */
type Scan = {
  open: OpenTool[];
  done: { tool: OpenTool; isError: boolean; text: string; at: number }[];
  todos?: OfficeTodos;
  model?: string;
};

// O transcript só cresce: com o mesmo tamanho e a mesma data, a leitura anterior ainda vale.
const scans = new Map<string, { size: number; mtimeMs: number; scan: Scan }>();

async function scanTranscript(path: string, scope: string | null, sidechain: boolean): Promise<Scan> {
  const info = await stat(path).catch(() => null);
  const hit = scans.get(path);
  if (info && hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.scan;

  const open = new Map<string, OpenTool>();
  const scan: Scan = { open: [], done: [] };
  for (const raw of await tail(path).catch(() => [])) {
    const hasTool = raw.includes('"tool_use"') || raw.includes('"tool_result"');
    if (!hasTool && !raw.includes('"model"')) continue;
    let e: Line;
    try {
      e = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    // Transcripts antigos guardavam os subagentes no arquivo da conversa, marcados como `isSidechain`.
    if (!sidechain && e.isSidechain) continue;
    if (e.type === 'assistant' && e.message?.model && !e.message.model.startsWith('<')) scan.model = e.message.model;
    const blocks = Array.isArray(e.message?.content) ? (e.message.content as Block[]) : [];
    const at = e.timestamp ? Date.parse(e.timestamp) : 0;
    for (const b of blocks) {
      if (e.type === 'assistant' && b.type === 'tool_use' && b.id && b.name) {
        const tool = { id: b.id, name: b.name, input: b.input, scope };
        open.set(b.id, tool);
        if (b.name === 'TodoWrite' && scope === null) scan.todos = todosOf(b.input) ?? scan.todos;
      }
      if (e.type === 'user' && b.type === 'tool_result' && b.tool_use_id) {
        const tool = open.get(b.tool_use_id);
        open.delete(b.tool_use_id);
        if (tool) scan.done.push({ tool, isError: Boolean(b.is_error), text: resultText(b.content), at });
      }
    }
  }
  scan.open = [...open.values()];
  // Só o fim interessa: o que acabou faz mais tempo que os eventos duram não volta à tela.
  scan.done = scan.done.slice(-40);
  if (info) {
    scans.delete(path);
    scans.set(path, { size: info.size, mtimeMs: info.mtimeMs, scan });
    // Conversas e subagentes de horas atrás saem do cache (o Map guarda a ordem de inserção).
    if (scans.size > 200) scans.delete(scans.keys().next().value!);
  }
  return scan;
}

type AgentFile = OfficeAgent & { path: string };

/** Subagentes com transcript mexido há pouco, com nome e tipo do `.meta.json` ao lado. */
async function freshAgents(sessionPath: string, sessionId: string): Promise<AgentFile[]> {
  const dir = join(dirname(sessionPath), sessionId, 'subagents');
  const out: AgentFile[] = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const id = name.match(/^agent-(.+)\.jsonl$/)?.[1];
    if (!id) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info || Date.now() - info.mtimeMs > AGENT_FRESH_MS) continue;
    const meta = JSON.parse(await readFile(join(dir, `agent-${id}.meta.json`), 'utf8').catch(() => '{}')) as {
      agentType?: string;
      description?: string;
    };
    out.push({ id, path, name: meta.description || meta.agentType || 'Subagente', type: meta.agentType || 'subagente' });
  }
  return out;
}

export async function pcOffice(sessionId: string, live: LiveSession): Promise<OfficeSnapshot> {
  const base = { asking: new Set<string>(), background: false, waitingFor: live.waitingFor };
  const path = await transcriptPath(sessionId);
  if (!path) {
    return { workers: workersFrom({ ...base, tools: [], agents: [], busy: live.status === 'busy', waiting: live.status === 'waiting' }), events: [] };
  }
  const idle = live.status === 'idle';
  const agents = idle ? [] : await freshAgents(path, sessionId);
  const [main, ...subs] = await Promise.all([
    scanTranscript(path, null, false),
    ...agents.map((a) => scanTranscript(a.path, a.id, true)),
  ]);
  const log = new OfficeLog();
  log.todos = main.todos;
  const now = Date.now();
  for (const s of [main, ...subs]) for (const d of s.done) if (now - d.at < EVENTS_MS) log.result(d.tool, d.isError, d.text, d.at);
  const workers = workersFrom({
    ...base,
    tools: idle ? [] : [...main.open, ...subs.flatMap((s) => s.open)],
    agents,
    busy: live.status === 'busy',
    waiting: live.status === 'waiting',
    recent: (scope) => log.recent(scope, now),
  });
  return { workers, events: log.recentEvents(now), todos: main.todos, model: main.model };
}
