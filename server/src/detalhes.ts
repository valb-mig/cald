import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { HttpError } from './errors.ts';
import { worktreeOf } from './worktrees.ts';

/**
 * Um detalhe de um projeto: como uma parte dele funciona, escrito por você ou pelo Claude a seu pedido
 * ("Avatares" → "o ícone vem de tal arquivo, cai para tal coisa…"). A descrição é Markdown, com menções `@caminho` a arquivos do
 * projeto. A `chave` sai do título e é por ela que o Claude pede o detalhe (ver cald-mcp.ts): ele recebe
 * só a lista de chaves e títulos ao abrir a conversa e lê o que precisa, em vez de varrer o código.
 */
export type Detalhe = {
  id: string;
  chave: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt?: number;
};

/** O que o app manda: a chave é do servidor, que a tira do título. */
export type DetalheInput = Omit<Detalhe, 'chave'> & { chave?: string };

export const MAX_DETALHES = 200;
export const MAX_DETALHE_TITLE = 120;
export const MAX_DETALHE_BODY = 50_000;

const FILE = process.env.DETALHES_FILE ?? join(DATA_DIR, 'detalhes.json');

/** `rev` sobe a cada mudança: o app manda o que leu, e uma lista velha não passa por cima (como no TODO). */
type Project = { items: Detalhe[]; rev?: number };
type Saved = { version: 1; projects: Record<string, Project> };

/** Os detalhes de um worktree são os do projeto de que ele é cópia, como o TODO. */
const projectOf = (cwd: string) => worktreeOf(cwd)?.project ?? cwd;

/** "Avatares e ícones" → `avatares-e-icones`: o que o Claude escreve para pedir o detalhe. */
export function chaveOf(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'detalhe';
}

/**
 * Os detalhes de cada projeto, pela pasta. Como o TODO, a lista vai inteira a cada mudança e avisa
 * `change` (com a pasta) a cada gravação.
 */
export class DetalheStore extends EventEmitter {
  private projects: Record<string, Project> = {};
  private writing = Promise.resolve();

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(FILE, 'utf8')) as Saved;
      if (data?.version === 1 && data.projects && typeof data.projects === 'object') this.projects = data.projects;
    } catch {
      // Primeiro uso ou arquivo ilegível: começa vazio.
    }
  }

  list(cwd: string): Detalhe[] {
    return this.projects[projectOf(cwd)]?.items ?? [];
  }

  rev(cwd: string): number {
    return this.projects[projectOf(cwd)]?.rev ?? 0;
  }

  /** Os detalhes pelas chaves, na ordem pedida; a que não existe volta em `missing`. */
  read(cwd: string, chaves: string[]): { found: Detalhe[]; missing: string[] } {
    const items = this.list(cwd);
    const found: Detalhe[] = [];
    const missing: string[] = [];
    for (const wanted of chaves) {
      // Aceita o título também: o Claude pode ter guardado o nome em vez da chave.
      const key = chaveOf(wanted);
      const d = items.find((x) => x.chave === wanted.trim() || x.chave === key);
      if (!d) missing.push(wanted);
      else if (!found.includes(d)) found.push(d);
    }
    return { found, missing };
  }

  /**
   * A lista como o app mandou. Cada item ganha a chave do título; dois títulos com a mesma chave ficam
   * com `-2`, `-3`, na ordem da lista. Com `rev`, só grava se ninguém mexeu desde que o app leu.
   */
  async replace(cwd: string, incoming: DetalheInput[], rev?: number): Promise<Detalhe[]> {
    cwd = projectOf(cwd);
    if (rev !== undefined && rev !== this.rev(cwd)) throw new HttpError(409, 'detalhes_changed');
    if (incoming.length > MAX_DETALHES) throw new HttpError(400, 'too_many_detalhes', { max: MAX_DETALHES });
    const used = new Set<string>();
    const items = incoming.map((d): Detalhe => {
      const title = d.title.trim().slice(0, MAX_DETALHE_TITLE);
      if (!title) throw new HttpError(400, 'detalhe_title_required');
      const base = chaveOf(title);
      let chave = base;
      for (let i = 2; used.has(chave); i++) chave = `${base}-${i}`;
      used.add(chave);
      return { id: d.id, chave, title, body: d.body.slice(0, MAX_DETALHE_BODY), createdAt: d.createdAt, updatedAt: d.updatedAt };
    });
    const current = this.projects[cwd];
    const projects = { ...this.projects };
    if (items.length || current) projects[cwd] = { items, rev: (current?.rev ?? 0) + 1 };
    this.projects = projects;
    await this.save(cwd);
    return this.list(cwd);
  }

  /**
   * Um detalhe novo no fim da lista, pelo MCP do cald. Título com a chave de um que já existe é recusado,
   * para o Claude editar aquele em vez de criar um `-2` ao lado.
   */
  async add(cwd: string, input: { title: string; body: string }): Promise<Detalhe> {
    const items = this.list(cwd);
    const chave = chaveOf(input.title.trim().slice(0, MAX_DETALHE_TITLE));
    if (items.some((d) => d.chave === chave)) throw new HttpError(409, 'detalhe_exists', { chave });
    const id = randomUUID();
    const saved = await this.replace(cwd, [...items, { id, title: input.title, body: input.body, createdAt: Date.now() }]);
    return saved.find((d) => d.id === id)!;
  }

  /** Muda um detalhe pela chave (ou pelo título), pelo MCP do cald; o que não vier fica como está. */
  async update(cwd: string, wanted: string, patch: { title?: string; body?: string }): Promise<Detalhe> {
    const items = this.list(cwd);
    const [old] = this.read(cwd, [wanted]).found;
    if (!old) throw new HttpError(404, 'detalhe_not_found', { existentes: items.map((d) => d.chave) });
    const next = items.map((d) => (d === old ? { ...d, title: patch.title ?? d.title, body: patch.body ?? d.body, updatedAt: Date.now() } : d));
    const saved = await this.replace(cwd, next);
    return saved.find((d) => d.id === old.id)!;
  }

  /**
   * O índice que vai nas instruções do MCP de uma conversa do projeto (ver cald-mcp.ts): só chave e
   * título, poucos tokens. `null` sem detalhe nenhum, para não pesar no prompt de quem não usa.
   */
  index(cwd: string): string | null {
    const items = this.list(cwd).filter((d) => d.body.trim());
    if (!items.length) return null;
    return items.map((d) => `- ${d.chave}: ${d.title}`).join('\n');
  }

  // Gravação atômica e em fila, como em todos.ts.
  private save(cwd: string): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, projects: this.projects } satisfies Saved, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(FILE), { recursive: true });
      await writeFile(`${FILE}.tmp`, snapshot);
      await rename(`${FILE}.tmp`, FILE);
    });
    this.emit('change', cwd);
    return this.writing;
  }
}
