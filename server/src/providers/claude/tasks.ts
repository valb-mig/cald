import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BackgroundTask, PanelEvent } from '../../events.ts';

/**
 * Tarefas em segundo plano de um processo do painel: monitores, comandos com `run_in_background`,
 * subagentes, workflows. Com elas vivas, o turno acaba mas o Claude não terminou: ele volta sozinho
 * quando uma termina (ou, num monitor, a cada novidade). A lista vem do SDK inteira a cada mudança
 * (`background_tasks_changed`); as que não são atividade (`ambient`) ficam de fora.
 */
export class BackgroundTasks {
  /** Início e chamada de cada tarefa vista; o `task_started` pode chegar antes ou depois da lista. */
  private readonly seen = new Map<string, { toolUseId?: string; at: number }>();
  private live: BackgroundTask[] = [];

  get list(): BackgroundTask[] {
    return this.live;
  }

  /** Tarefa deste processo (as rotas de saída e de parar só aceitam essas). */
  knows(taskId: string): boolean {
    return this.seen.has(taskId);
  }

  fromMessage(msg: SDKMessage): PanelEvent[] {
    if (msg.type !== 'system') return [];
    if (msg.subtype === 'task_started') {
      const known = this.seen.get(msg.task_id);
      this.seen.set(msg.task_id, { toolUseId: msg.tool_use_id, at: known?.at ?? Date.now() });
      // Chegou depois da lista: completa a tarefa com a chamada que a criou.
      const listed = this.live.find((t) => t.taskId === msg.task_id);
      if (!listed || listed.toolUseId || !msg.tool_use_id) return [];
      return this.publish(this.live.map((t) => (t === listed ? { ...t, toolUseId: msg.tool_use_id } : t)));
    }
    if (msg.subtype !== 'background_tasks_changed') return [];
    const next = msg.tasks
      .filter((t) => !t.ambient)
      .map((t): BackgroundTask => {
        const known = this.seen.get(t.task_id) ?? { at: Date.now() };
        this.seen.set(t.task_id, known);
        return {
          taskId: t.task_id,
          toolUseId: known.toolUseId,
          type: t.task_type,
          description: t.description,
          subagentType: t.subagent_type,
          startedAt: known.at,
        };
      });
    if (JSON.stringify(next) === JSON.stringify(this.live)) return [];
    return this.publish(next);
  }

  private publish(tasks: BackgroundTask[]): PanelEvent[] {
    this.live = tasks;
    return [{ kind: 'tasks', tasks }];
  }
}
