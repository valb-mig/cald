import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.ts';

/** Um anexo de um item do TODO (imagem ou documento), guardado no PC. */
export type TodoFile = { id: string; name: string; mediaType: string; size: number };

/**
 * Um item do TODO de um projeto, a lista do próprio Claude Remote, sem nada do GitHub. `n` é o número
 * dele no projeto, que não se repete (como o de uma issue): é o que o chat menciona, `TODO:3`. A
 * descrição é Markdown, com menções `@caminho` a arquivos do projeto.
 */
export type Todo = {
  id: string;
  n: number;
  title: string;
  body: string;
  done: boolean;
  createdAt: number;
  updatedAt?: number;
  files: TodoFile[];
};

/** O que o app manda: sem `n`, o item é novo e ganha o próximo número do projeto. */
export type TodoInput = Omit<Todo, 'n' | 'files'> & { n?: number; files?: TodoFile[] };

export const MAX_TODOS = 500;
export const MAX_TODO_TITLE = 300;
export const MAX_TODO_BODY = 20_000;
export const MAX_TODO_FILES = 20;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Dado seu, como o histórico de uso: fica com os dados do app, não no cache.
const FILE = process.env.TODOS_FILE ?? join(homedir(), '.local', 'share', 'claude-remote', 'todos.json');
// Um anexo por pasta, com o nome original (limpo): o caminho que o Claude lê é legível.
const FILES_DIR = join(dirname(FILE), 'todo-files');

type Project = { next: number; items: Todo[] };
type Saved = { version: 2; projects: Record<string, Project> };
type OldTodo = { id: string; text: string; done: boolean; createdAt: number };

function safeName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '');
  return cleaned.slice(-120) || 'arquivo';
}

/** O TODO de cada projeto, pela pasta. A lista vai inteira a cada mudança: é pequena e só sua. */
export class TodoStore {
  private projects: Record<string, Project> = {};
  private writing = Promise.resolve();

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(FILE, 'utf8')) as Saved | Record<string, OldTodo[]>;
      if (data && typeof data === 'object' && (data as Saved).version === 2) {
        this.projects = (data as Saved).projects;
      } else if (data && typeof data === 'object') {
        // A lista de antes, só com texto: o texto vira o título, e cada item ganha um número na ordem.
        for (const [cwd, items] of Object.entries(data as Record<string, OldTodo[]>)) {
          if (!Array.isArray(items)) continue;
          this.projects[cwd] = {
            next: items.length + 1,
            items: items.map((t, i) => ({ id: t.id, n: i + 1, title: t.text, body: '', done: t.done, createdAt: t.createdAt, files: [] })),
          };
        }
      }
    } catch {
      // Primeiro uso ou arquivo ilegível: começa vazio.
    }
  }

  list(cwd: string): Todo[] {
    return this.projects[cwd]?.items ?? [];
  }

  /** Os itens a fazer de todos os projetos, para a inbox. */
  open(): { cwd: string; todo: Todo }[] {
    return Object.entries(this.projects).flatMap(([cwd, p]) => p.items.filter((t) => !t.done).map((todo) => ({ cwd, todo })));
  }

  /**
   * A lista como o app mandou. Item sem número ganha o próximo do projeto; os anexos de um item que
   * saiu (ou que tiraram do item) são apagados do disco.
   */
  async replace(cwd: string, incoming: TodoInput[]): Promise<Todo[]> {
    const current = this.projects[cwd] ?? { next: 1, items: [] };
    let next = Math.max(current.next, ...current.items.map((t) => t.n + 1), 1);
    const used = new Set<number>();
    const items = incoming.map((t): Todo => {
      let n = t.n && t.n > 0 && !used.has(t.n) ? t.n : 0;
      if (!n) n = next++;
      used.add(n);
      next = Math.max(next, n + 1);
      return { ...t, n, title: t.title.trim(), files: t.files ?? [] };
    });
    const kept = new Set(items.flatMap((t) => t.files.map((f) => f.id)));
    const gone = current.items.flatMap((t) => t.files).filter((f) => !kept.has(f.id));
    const projects = { ...this.projects };
    if (items.length) projects[cwd] = { next, items };
    else if (current.next > 1) projects[cwd] = { next, items: [] };
    else delete projects[cwd];
    this.projects = projects;
    await this.save();
    await Promise.all(gone.map((f) => rm(join(FILES_DIR, f.id), { recursive: true, force: true })));
    return this.list(cwd);
  }

  /** Guarda um anexo (em base64, como os do chat) e devolve o que o item leva dele. */
  async saveFile(file: { name: string; mediaType: string; data: string }): Promise<TodoFile> {
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'attachment_too_large', { name: file.name });
    const id = randomUUID();
    const dir = join(FILES_DIR, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, safeName(file.name)), bytes);
    return { id, name: file.name, mediaType: file.mediaType || 'application/octet-stream', size: bytes.length };
  }

  /** Onde o anexo está no PC; `null` se não existe mais. */
  async filePath(id: string): Promise<string | null> {
    if (!/^[\w-]{1,64}$/.test(id)) return null;
    const names = await readdir(join(FILES_DIR, id)).catch(() => []);
    return names[0] ? join(FILES_DIR, id, names[0]) : null;
  }

  /**
   * O que o Claude precisa saber dos `TODO:n` mencionados numa mensagem: título, se está feito, a
   * descrição (com as menções a arquivos como estão) e o caminho de cada anexo no PC, que ele consegue
   * abrir. Vai num bloco à parte, que a tela do chat não mostra (ver `userTextEvents`).
   */
  async context(cwd: string, text: string): Promise<string | null> {
    const wanted = [...new Set([...text.matchAll(/\bTODO:(\d+)\b/gi)].map((m) => Number(m[1])))];
    if (!wanted.length) return null;
    const items = this.list(cwd);
    const parts: string[] = [];
    for (const n of wanted) {
      const t = items.find((x) => x.n === n);
      if (!t) continue;
      const files = await Promise.all(
        t.files.map(async (f) => {
          const path = await this.filePath(f.id);
          return path ? `@${path}` : null;
        }),
      );
      parts.push(
        [
          `<claude-remote-todo n="${t.n}">`,
          `TODO:${t.n} da lista de tarefas deste projeto no Claude Remote (${t.done ? 'já feito' : 'a fazer'}).`,
          `Título: ${t.title}`,
          t.body.trim() ? `Descrição:\n${t.body.trim()}` : 'Sem descrição.',
          files.some(Boolean) ? `Anexos, no PC:\n${files.filter(Boolean).join('\n')}` : '',
          '</claude-remote-todo>',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    return parts.length ? parts.join('\n\n') : null;
  }

  // Gravação atômica e em fila, como em meta.ts: um arquivo temporário renomeado por cima do atual.
  private save(): Promise<void> {
    const snapshot = JSON.stringify({ version: 2, projects: this.projects } satisfies Saved, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(FILE), { recursive: true });
      await writeFile(`${FILE}.tmp`, snapshot);
      await rename(`${FILE}.tmp`, FILE);
    });
    return this.writing;
  }
}
