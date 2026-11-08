import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { HttpError } from '../../errors.ts';
import { childEnv } from './env.ts';

/** Fila de prompts que mantém o processo headless vivo entre turnos. */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
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
