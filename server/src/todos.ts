import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Um item do TODO de um projeto: uma lista simples do próprio Claude Remote, sem nada do GitHub. */
export type Todo = { id: string; text: string; done: boolean; createdAt: number };

export const MAX_TODOS = 500;
export const MAX_TODO_TEXT = 1000;

// Dado seu, como o histórico de uso: fica com os dados do app, não no cache.
const FILE = process.env.TODOS_FILE ?? join(homedir(), '.local', 'share', 'claude-remote', 'todos.json');

/** O TODO de cada projeto, pela pasta. A lista vai inteira a cada mudança: é pequena e só sua. */
export class TodoStore {
  private todos: Record<string, Todo[]> = {};
  private writing = Promise.resolve();

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(FILE, 'utf8')) as unknown;
      if (data && typeof data === 'object') this.todos = data as Record<string, Todo[]>;
    } catch {
      // Primeiro uso ou arquivo ilegível: começa vazio.
    }
  }

  list(cwd: string): Todo[] {
    return this.todos[cwd] ?? [];
  }

  async replace(cwd: string, items: Todo[]): Promise<Todo[]> {
    const next = { ...this.todos };
    if (items.length) next[cwd] = items;
    else delete next[cwd];
    this.todos = next;
    await this.save();
    return this.list(cwd);
  }

  // Gravação atômica e em fila, como em meta.ts: um arquivo temporário renomeado por cima do atual.
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.todos, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(FILE), { recursive: true });
      await writeFile(`${FILE}.tmp`, snapshot);
      await rename(`${FILE}.tmp`, FILE);
    });
    return this.writing;
  }
}
