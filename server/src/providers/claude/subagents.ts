import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getSubagentMessages, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_HOME } from './env.ts';
import { HttpError } from '../../errors.ts';
import type { AgentStatus, AgentUsage, LoggedEvent, PanelEvent } from '../../events.ts';
import { fromSessionMessage } from './messages.ts';
import { imageStore } from '../../images.ts';

type TaskPatchStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused';

const PATCH_STATUS: Record<TaskPatchStatus, AgentStatus> = {
  pending: 'running',
  running: 'running',
  paused: 'running',
  completed: 'completed',
  failed: 'failed',
  killed: 'stopped',
};

const usageOf = (u?: { total_tokens: number; tool_uses: number; duration_ms: number }): AgentUsage | undefined =>
  u && { tokens: u.total_tokens, toolUses: u.tool_uses, durationMs: u.duration_ms };

/**
 * Subagentes de um processo do painel. O SDK fala deles por `task_id` (início, progresso,
 * mudanças, fim); aqui cada novidade vira um evento `agent` ligado à chamada da ferramenta Agent
 * que o criou, e é por esses eventos que o painel sabe quem ainda trabalha (ver panel-session.ts).
 * Tarefas que não são subagentes (comandos em segundo plano, monitores) ficam de fora.
 */
export class AgentTasks {
  /** task_id → chamada da ferramenta Agent, para cada subagente visto neste processo. */
  private readonly calls = new Map<string, string>();

  fromMessage(msg: SDKMessage): PanelEvent[] {
    if (msg.type !== 'system') return [];
    switch (msg.subtype) {
      case 'task_started': {
        if (!msg.tool_use_id || (msg.task_type !== 'local_agent' && !msg.subagent_type)) return [];
        this.calls.set(msg.task_id, msg.tool_use_id);
        return [{ kind: 'agent', toolUseId: msg.tool_use_id, agentId: msg.task_id, status: 'running', background: msg.is_backgrounded }];
      }
      case 'task_progress': {
        const toolUseId = this.calls.get(msg.task_id);
        if (!toolUseId) return [];
        return [{ kind: 'agent', toolUseId, activity: msg.description, summary: msg.summary, usage: usageOf(msg.usage) }];
      }
      case 'task_updated': {
        const toolUseId = this.calls.get(msg.task_id);
        if (!toolUseId) return [];
        const status = msg.patch.status && PATCH_STATUS[msg.patch.status];
        if (!status && msg.patch.is_backgrounded === undefined && !msg.patch.error) return [];
        return [{ kind: 'agent', toolUseId, status, background: msg.patch.is_backgrounded, error: msg.patch.error }];
      }
      case 'task_notification': {
        const toolUseId = this.calls.get(msg.task_id);
        if (!toolUseId) return [];
        // Num subagente, o resumo do fim é o relatório final dele.
        return [{ kind: 'agent', toolUseId, status: msg.status, result: msg.summary || undefined, usage: usageOf(msg.usage) }];
      }
      default:
        return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Transcript salvo de um subagente: ~/.claude/projects/<projeto>/<sessão>/subagents/agent-<id>.jsonl
// ---------------------------------------------------------------------------

// IDs viram nomes de pasta e arquivo: nada de `..` nem `/`.
const SAFE_ID = /^[\w-]{1,64}$/;

async function subagentsDir(sessionId: string): Promise<string | null> {
  const root = join(CLAUDE_HOME, 'projects');
  for (const project of await readdir(root).catch(() => [])) {
    const dir = join(root, project, sessionId, 'subagents');
    if (await stat(dir).then((s) => s.isDirectory(), () => false)) return dir;
  }
  return null;
}

/**
 * ID do subagente que uma chamada da ferramenta Agent criou, lido do `.meta.json` que o Claude
 * Code grava ao lado de cada transcript (arquivo interno; sem ele, o transcript fica inacessível).
 */
async function agentIdOf(sessionId: string, toolUseId: string): Promise<string | null> {
  const dir = await subagentsDir(sessionId);
  if (!dir) return null;
  for (const name of await readdir(dir).catch(() => [])) {
    const id = name.match(/^agent-(.+)\.meta\.json$/)?.[1];
    if (!id) continue;
    const meta = JSON.parse(await readFile(join(dir, name), 'utf8').catch(() => '{}')) as { toolUseId?: string };
    if (meta.toolUseId === toolUseId) return id;
  }
  return null;
}

/**
 * O que um subagente fez, do transcript salvo: serve para agentes do histórico e de sessões
 * abertas no PC, cujo andamento não passa pelo painel. `agentId`, se o celular já souber, poupa a busca.
 */
export async function agentTranscript(sessionId: string, toolUseId: string, agentId?: string): Promise<LoggedEvent[]> {
  if (!SAFE_ID.test(sessionId)) throw new HttpError(404, 'agent_not_found');
  const id = agentId && SAFE_ID.test(agentId) ? agentId : await agentIdOf(sessionId, toolUseId);
  if (!id) throw new HttpError(404, 'agent_not_found');
  const messages = await getSubagentMessages(sessionId, id);
  if (!messages.length) throw new HttpError(404, 'agent_not_found');
  // Tudo aqui é do próprio subagente: sem a ligação com a chamada que o criou, as falas dele são falas, não "subagente: …".
  const events = messages.flatMap((m) => fromSessionMessage({ ...m, parent_tool_use_id: null }, imageStore.sink(sessionId, m.uuid)));
  return events.map((e, i) => ({ ...e, seq: i + 1, ts: 0 }) as LoggedEvent);
}
