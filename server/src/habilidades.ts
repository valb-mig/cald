import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CACHE_DIR, DATA_DIR } from './config.ts';
import { HttpError } from './errors.ts';
import { worktreeOf } from './worktrees.ts';

/**
 * As habilidades do cald: skills que são do cald, e não do Claude Code. Cada uma é global (vale em
 * todo projeto) ou de um projeto, e nas conversas do painel vira uma skill de verdade para o Claude:
 * o cald monta um plugin "cald" só com as que valem ali (ver `writePlugin`) e o passa ao abrir a
 * conversa. O Claude carrega cada uma pela descrição, quando ela serve, e responde a `/cald:nome`.
 * Em cada conversa dá para desligar uma ou outra (ver meta.ts). As abertas no terminal não as veem.
 */
export type Habilidade = {
  id: string;
  /** O nome dela para o Claude: minúsculas, números e hífen. Vira o `/cald:nome`. */
  name: string;
  /** Quando usar: é por ela que o Claude decide carregar a habilidade. */
  description: string;
  /** As instruções, em Markdown. */
  body: string;
  /** `null`: global. Senão, a pasta do projeto. */
  project: string | null;
  createdAt: number;
  updatedAt: number;
};

export type HabilidadeInput = { id?: string; name: string; description: string; body: string; project: string | null };

type Trashed = Habilidade & { deletedAt: number };

export const MAX_DESCRIPTION = 1024;
export const MAX_BODY = 50_000;
const NAME = /^[a-z0-9][a-z0-9-]{0,49}$/;
const TRASH_DAYS = 30;

// Dado seu, como o TODO: fica com os dados do app, não no cache.
const FILE = process.env.HABILIDADES_FILE ?? join(DATA_DIR, 'habilidades.json');
// Os plugins montados para cada conversa: refeitos a cada abertura, então ficam no cache.
const PLUGINS_DIR = join(CACHE_DIR, 'habilidades');

/** O projeto de uma pasta, para casar com as habilidades dele: a conversa num worktree conta como do projeto. */
const projectOf = (cwd: string) => worktreeOf(cwd)?.project ?? cwd;
const inside = (cwd: string, project: string) => {
  const dir = projectOf(cwd);
  return dir === project || dir.startsWith(`${project}/`);
};

export class HabilidadeStore extends EventEmitter {
  private items: Habilidade[] = [];
  private trash: Trashed[] = [];
  private writing = Promise.resolve();

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(FILE, 'utf8')) as { items?: Habilidade[]; trash?: Trashed[] };
      this.items = Array.isArray(data.items) ? data.items : [];
      const cutoff = Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000;
      this.trash = (Array.isArray(data.trash) ? data.trash : []).filter((t) => t.deletedAt > cutoff);
    } catch {
      // Primeiro uso ou arquivo ilegível: começa vazio.
    }
  }

  /** As globais, as do projeto de `cwd` (se veio) e a lixeira das duas. */
  list(cwd?: string): { global: Habilidade[]; project: Habilidade[]; trash: Trashed[] } {
    const mine = (h: Habilidade) => h.project === null || (cwd !== undefined && inside(cwd, h.project));
    const byName = (a: Habilidade, b: Habilidade) => a.name.localeCompare(b.name);
    return {
      global: this.items.filter((h) => h.project === null).sort(byName),
      project: cwd ? this.items.filter((h) => h.project !== null && inside(cwd, h.project)).sort(byName) : [],
      trash: this.trash.filter(mine).sort((a, b) => b.deletedAt - a.deletedAt),
    };
  }

  /** As que valem numa conversa em `cwd`: as globais e as do projeto, e a do projeto ganha da global de mesmo nome. */
  visibleIn(cwd: string): Habilidade[] {
    const { global, project } = this.list(cwd);
    const names = new Set(project.map((h) => h.name));
    return [...project, ...global.filter((h) => !names.has(h.name))].sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(input: HabilidadeInput): Promise<Habilidade> {
    const name = input.name.trim().toLowerCase();
    if (!NAME.test(name)) throw new HttpError(400, 'invalid_habilidade_name');
    const description = input.description.trim();
    if (!description || description.length > MAX_DESCRIPTION) throw new HttpError(400, 'invalid_habilidade_description');
    if (input.body.length > MAX_BODY) throw new HttpError(413, 'habilidade_too_long');
    const project = input.project ? projectOf(input.project) : null;
    // O nome é o que o Claude chama: dois iguais no mesmo lugar (global, ou o mesmo projeto) não dá.
    if (this.items.some((h) => h.id !== input.id && h.name === name && h.project === project)) throw new HttpError(409, 'habilidade_exists', { name });
    const now = Date.now();
    const old = input.id ? this.items.find((h) => h.id === input.id) : undefined;
    if (input.id && !old) throw new HttpError(404, 'habilidade_not_found');
    const saved: Habilidade = { id: old?.id ?? randomUUID(), name, description, body: input.body, project, createdAt: old?.createdAt ?? now, updatedAt: now };
    this.items = old ? this.items.map((h) => (h.id === old.id ? saved : h)) : [...this.items, saved];
    await this.persist();
    return saved;
  }

  /** Para a lixeira, de onde volta igual por 30 dias. */
  async toTrash(id: string): Promise<void> {
    const h = this.items.find((x) => x.id === id);
    if (!h) throw new HttpError(404, 'habilidade_not_found');
    this.items = this.items.filter((x) => x.id !== id);
    this.trash = [{ ...h, deletedAt: Date.now() }, ...this.trash];
    await this.persist();
  }

  async restore(id: string): Promise<Habilidade> {
    const t = this.trash.find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'habilidade_not_found');
    if (this.items.some((h) => h.name === t.name && h.project === t.project)) throw new HttpError(409, 'habilidade_exists', { name: t.name });
    const { deletedAt: _deletedAt, ...h } = t;
    this.trash = this.trash.filter((x) => x.id !== id);
    this.items = [...this.items, h];
    await this.persist();
    return h;
  }

  /** Apaga de vez da lixeira. */
  async purge(id: string): Promise<void> {
    this.trash = this.trash.filter((x) => x.id !== id);
    await this.persist();
  }

  // Gravação atômica e em fila; avisa quem monta os plugins das conversas abertas (ver Manager).
  private persist(): Promise<void> {
    const snapshot = JSON.stringify({ items: this.items, trash: this.trash }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(FILE), { recursive: true });
      await writeFile(`${FILE}.tmp`, snapshot);
      await rename(`${FILE}.tmp`, FILE);
    });
    this.emit('change');
    return this.writing;
  }
}

/** Uma pasta nova para o plugin de uma conversa, que `writePlugin` preenche. */
export const pluginDir = () => join(PLUGINS_DIR, randomUUID());

/**
 * Monta (ou refaz) o plugin "cald" de uma conversa em `dir`, só com `items`: um `SKILL.md` por
 * habilidade, no formato das skills do Claude Code. Sempre existe, mesmo vazio: o Claude Code só
 * recarrega um plugin que já veio na abertura.
 */
export async function writePlugin(dir: string, items: Habilidade[]): Promise<void> {
  await rm(join(dir, 'skills'), { recursive: true, force: true });
  await mkdir(join(dir, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'cald', description: 'Habilidades do cald, ligadas nesta conversa pelo painel.', version: '1.0.0' }),
  );
  for (const h of items) {
    const skill = join(dir, 'skills', h.name);
    await mkdir(skill, { recursive: true });
    // A descrição entre aspas (JSON é YAML válido): dois-pontos e aspas no texto não quebram o cabeçalho.
    await writeFile(join(skill, 'SKILL.md'), `---\nname: ${h.name}\ndescription: ${JSON.stringify(h.description)}\n---\n\n${h.body.trim()}\n`);
  }
}

/** A conversa saiu: o plugin dela vai junto. */
export const removePlugin = (dir: string) => rm(dir, { recursive: true, force: true }).catch(() => undefined);

/** Ao subir, os plugins de conversas de antes (o servidor caiu sem limpar) saem. */
export const clearPlugins = () => rm(PLUGINS_DIR, { recursive: true, force: true }).catch(() => undefined);
