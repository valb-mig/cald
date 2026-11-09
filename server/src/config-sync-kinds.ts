import { cp, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { DATA_DIR } from './config.ts';
import type { Detalhe, DetalheStore } from './detalhes.ts';
import { splitFrontmatter } from './frontmatter.ts';
import { git, remoteWebUrl } from './git.ts';
import type { Habilidade, HabilidadeStore } from './habilidades.ts';
import { CLAUDE_HOME } from './providers/claude/env.ts';
import { folderOf, indexLinks, MEMORY_INDEX } from './providers/claude/memory.ts';
import type { AgentPrefs, ProviderRegistry } from './providers/registry.ts';
import type { SavedCommand, SavedCommandStore } from './saved-commands.ts';
import type { Team, TeamStore } from './teams.ts';
import type { Todo, TodoStore } from './todos.ts';
import type { Workspace, WorkspaceStore } from './workspaces.ts';

/**
 * O que vai para o repositório de configuração (ver config-sync.ts), por categoria: de onde cada uma
 * lê o desta máquina (`units`) e como aplica aqui o que veio de lá (`apply`). Cada item tem um id que
 * não muda entre máquinas e a data da última edição, que decide quem fica: o mais novo.
 */

export const REPO_DIR = process.env.CONFIG_REPO_DIR ?? join(DATA_DIR, 'config-repo');
// O que um "Trazer" trocou fica aqui, por vez, para voltar à mão se precisar.
const BACKUP_DIR = join(DATA_DIR, 'config-backup');
const KEEP_BACKUPS = 10;

export const KIND_IDS = [
  'teams',
  'workspaces',
  'habilidades',
  'detalhes',
  'todos',
  'commands',
  'memory',
  'claude-config',
  'claude-agents',
  'claude-skills',
  'agents',
  'appearance',
] as const;
export type KindId = (typeof KIND_IDS)[number];

export type SyncDeps = {
  teams: TeamStore;
  workspaces: WorkspaceStore;
  habilidades: HabilidadeStore;
  detalhes: DetalheStore;
  todos: TodoStore;
  commands: SavedCommandStore;
  providers: ProviderRegistry;
  /** Os projetos desta máquina (ver Manager.projects). */
  projects: () => Promise<string[]>;
  /** Recusa a pasta que não é projeto conhecido daqui (ver Manager.knownCwd). */
  knownCwd: (cwd: string) => Promise<string>;
};

// ---- o índice do repositório (cald.json) ----

/** Um projeto no repositório: achado em outra máquina pelo remoto do git (e a subpasta) ou por um dos caminhos. */
export type ProjectRef = { name: string; remote: string | null; sub: string; paths: string[] };
/** Um item no repositório: onde está, como aparece na tela, quando mudou, de que máquina veio e de que projeto é. */
export type Entry = { path: string; label: string; updatedAt: number; machine: string; project?: string };
export type RepoIndex = {
  format: 1;
  items: Record<string, Entry>;
  projects: Record<string, ProjectRef>;
  lastPush?: { machine: string; at: number };
};

// ---- conteúdo: um arquivo, ou uma pasta (caminho dentro dela → arquivo) ----

export type Blob = { data: Buffer; mode: number };
export type Content = Blob | Map<string, Blob>;

export type Unit = {
  id: string;
  label: string;
  /** Onde fica no repositório (arquivo ou pasta, conforme o conteúdo). */
  path: string;
  updatedAt: number;
  /** A chave do projeto no índice, se o item é de um. */
  project?: string;
  read: () => Promise<Content>;
};

/** Um item do repositório que ganhou do daqui, com o projeto já no caminho desta máquina. */
export type Incoming = { id: string; entry: Entry; project?: string; content: Content };

export type Kind = {
  id: KindId;
  units: (ctx: Ctx) => Promise<Unit[]>;
  /** Aplica o que veio; devolve os ids que ficaram de fora (inválidos ou em conflito). */
  apply: (ctx: Ctx, items: Incoming[]) => Promise<string[]>;
  /** Depois dos itens, o que se junta em vez de trocar (o índice da memória); devolve o que mudou. */
  afterPush?: (ctx: Ctx) => Promise<string[]>;
  afterPull?: (ctx: Ctx) => Promise<string[]>;
};

const HOME = homedir();
// Caminhos da pasta pessoal viram isto no repositório e voltam como a pasta pessoal da outra máquina.
const HOME_TOKEN = '{{HOME}}';
const HOME_RE = new RegExp(`${HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/"'\\s:]|$)`, 'g');
const MAX_FILE = 25 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__']);
// Variáveis do settings.json que ficam na máquina: chaves, tokens, senhas.
const SECRET = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE/i;
const SCRIPT = /^[\w.-]+\.(?:sh|bash|zsh|mjs|cjs|js|ts|py)$/;
const MEMORY_FILE = /^[\w.-]{1,200}\.md$/;
const SKILL_DIR = /^[\w][\w.-]{0,120}$/;

/** As datas de arquivo vão em segundos: o milissegundo não volta igual depois do `utimes`. */
const seconds = (ms: number) => Math.floor(ms / 1000) * 1000;
const tilde = (p: string) => (p === HOME ? '~' : p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);
const untilde = (p: string) => (p === '~' ? HOME : p.startsWith('~/') ? join(HOME, p.slice(2)) : p);

/** Um caminho relativo que não sai da pasta de onde parte. */
export function safeRel(rel: string): boolean {
  if (!rel || isAbsolute(rel)) return false;
  const n = normalize(rel);
  return n !== '..' && !n.startsWith('../') && !n.split('/').includes('.git');
}

function slug(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/, '') || 'item'
  );
}

const isText = (buf: Buffer) => !buf.subarray(0, 8000).includes(0);
const toRepoText = (b: Blob): Blob => (isText(b.data) ? { ...b, data: Buffer.from(b.data.toString('utf8').replace(HOME_RE, HOME_TOKEN)) } : b);
const fromRepoText = (b: Blob): Blob => (isText(b.data) ? { ...b, data: Buffer.from(b.data.toString('utf8').replaceAll(HOME_TOKEN, HOME)) } : b);
const mapBlobs = (c: Content, fn: (b: Blob) => Blob): Content => (c instanceof Map ? new Map([...c].map(([k, b]) => [k, fn(b)])) : fn(c));

const json = (value: unknown): Blob => ({ data: Buffer.from(`${JSON.stringify(value, null, 2)}\n`), mode: 0o644 });
function single(c: Content | undefined): Blob {
  if (!c || c instanceof Map) throw new Error('esperava um arquivo');
  return c;
}
const parse = <T>(c: Content | undefined): T => JSON.parse(single(c).data.toString('utf8')) as T;

/** Markdown com cabeçalho, cada valor em JSON (que é YAML válido): o que se lê no GitHub e volta igual. */
function toMd(fields: Record<string, unknown>, body: string): Blob {
  const head = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return { data: Buffer.from(`---\n${head.join('\n')}\n---\n\n${body.trim()}\n`), mode: 0o644 };
}

function fromMd(c: Content): { fields: Record<string, unknown>; body: string } {
  const text = single(c).data.toString('utf8');
  const parts = splitFrontmatter(text);
  const fields: Record<string, unknown> = {};
  for (const line of parts?.head ?? []) {
    const m = /^([\w-]+):\s?(.*)$/.exec(line);
    if (!m) continue;
    try {
      fields[m[1]] = JSON.parse(m[2]);
    } catch {
      fields[m[1]] = m[2];
    }
  }
  return { fields, body: (parts ? parts.body : text).replace(/\n+$/, '') };
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// ---- arquivos ----

type Found = { abs: string; mtime: number; mode: number };

/** Os arquivos de uma pasta, por caminho relativo; sem links, `.git`, `node_modules` e arquivos enormes. */
async function walk(root: string): Promise<Map<string, Found>> {
  const out = new Map<string, Found>();
  const visit = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isSymbolicLink()) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await visit(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const info = await stat(abs).catch(() => null);
      if (!info || info.size > MAX_FILE) continue;
      out.set(relative(root, abs), { abs, mtime: seconds(info.mtimeMs), mode: info.mode });
    }
  };
  await visit(root);
  return out;
}

async function readFound(files: Map<string, Found>): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>();
  for (const [rel, f] of files) out.set(rel, { data: await readFile(f.abs), mode: f.mode });
  return out;
}

/** O conteúdo que está no repositório (ou numa pasta qualquer); `null` se não existe. */
export async function readContent(abs: string): Promise<Content | null> {
  const info = await stat(abs).catch(() => null);
  if (!info) return null;
  if (info.isDirectory()) return readFound(await walk(abs));
  return { data: await readFile(abs), mode: info.mode };
}

async function writeBlob(abs: string, blob: Blob, mtime?: number): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  // Gravação atômica, como nos stores: um temporário renomeado por cima.
  const tmp = `${abs}.cald-tmp`;
  await writeFile(tmp, blob.data, { mode: blob.mode & 0o111 ? 0o755 : 0o644 });
  await rename(tmp, abs);
  if (mtime) await utimes(abs, new Date(mtime), new Date(mtime));
}

/** Grava um arquivo, ou troca a pasta inteira; com `mtime`, os arquivos ficam com essa data. */
export async function writeContent(abs: string, content: Content, mtime?: number): Promise<void> {
  if (!(content instanceof Map)) return writeBlob(abs, content, mtime);
  await rm(abs, { recursive: true, force: true });
  for (const [rel, blob] of content) if (safeRel(rel)) await writeBlob(join(abs, rel), blob, mtime);
}

const exists = (abs: string) => stat(abs).then(
  () => true,
  () => false,
);

// ---- o contexto de uma vez: os projetos de cá e de lá, e a cópia do que for trocado ----

type Ref = { name: string; remote: string | null; sub: string; tilde: string };

export class Ctx {
  private refs = new Map<string, Promise<Ref>>();
  private paths = new Map<string, Promise<string | null>>();
  private locals?: Promise<{ path: string; ref: Ref }[]>;
  private backupAt?: string;
  private storesSaved = false;
  readonly deps: SyncDeps;
  readonly index: RepoIndex;
  readonly mode: 'push' | 'pull';
  readonly dry: boolean;

  constructor(deps: SyncDeps, index: RepoIndex, mode: 'push' | 'pull', dry: boolean) {
    this.deps = deps;
    this.index = index;
    this.mode = mode;
    this.dry = dry;
  }

  /** De onde o projeto é: o remoto do git (`github.com/dono/repo`) e a subpasta, ou só o caminho. */
  private refOf(cwd: string): Promise<Ref> {
    let hit = this.refs.get(cwd);
    if (!hit) {
      hit = (async () => {
        const top = await git(cwd, ['rev-parse', '--show-toplevel']).then(
          (r) => r.stdout.trim(),
          () => '',
        );
        const url = top
          ? await git(top, ['remote', 'get-url', 'origin']).then(
              (r) => r.stdout.trim(),
              () => '',
            )
          : '';
        const remote = url ? (remoteWebUrl(url)?.replace(/^https:\/\//, '').toLowerCase() ?? null) : null;
        return { name: basename(cwd), remote, sub: remote ? relative(top, cwd) : '', tilde: tilde(cwd) };
      })();
      this.refs.set(cwd, hit);
    }
    return hit;
  }

  /** Todas as pastas de projeto que esta máquina conhece: as do Manager e as que os stores guardam. */
  async localPaths(): Promise<string[]> {
    const { deps } = this;
    const fromStores = [
      ...Object.keys(deps.todos.all()),
      ...Object.keys(deps.detalhes.all()),
      ...deps.habilidades.all().flatMap((h) => (h.project ? [h.project] : [])),
      ...deps.commands.all().flatMap((c) => (c.project ? [c.project] : [])),
      ...deps.workspaces.list().flatMap((w) => w.projects),
    ];
    return [...new Set([...(await deps.projects()), ...fromStores])];
  }

  private localProjects(): Promise<{ path: string; ref: Ref }[]> {
    this.locals ??= (async () => {
      const paths = await this.localPaths();
      const out: { path: string; ref: Ref }[] = [];
      // Aos poucos: um `git` por projeto, e são dezenas.
      for (let i = 0; i < paths.length; i += 8) {
        const batch = paths.slice(i, i + 8);
        out.push(...(await Promise.all(batch.map(async (path) => ({ path, ref: await this.refOf(path) })))));
      }
      return out;
    })();
    return this.locals;
  }

  private findKey(ref: Ref): string | null {
    const entries = Object.entries(this.index.projects);
    if (ref.remote) {
      const hit = entries.find(([, p]) => p.remote === ref.remote && p.sub === ref.sub);
      if (hit) return hit[0];
    }
    return entries.find(([, p]) => p.paths.includes(ref.tilde))?.[0] ?? null;
  }

  /**
   * A chave do projeto no repositório. Ao enviar, o projeto novo ganha uma (pelo nome da pasta); ao
   * trazer, só vale a que aponta de volta para esta mesma pasta, e as outras ficam sem (`null`).
   */
  async keyOf(cwd: string): Promise<string | null> {
    const ref = await this.refOf(cwd);
    let key = this.findKey(ref);
    if (this.mode === 'pull') return key && (await this.pathOf(key)) === cwd ? key : null;
    if (!key) {
      const base = slug(ref.name);
      key = base;
      for (let n = 2; this.index.projects[key]; n++) key = `${base}-${n}`;
      this.index.projects[key] = { name: ref.name, remote: ref.remote, sub: ref.sub, paths: [] };
    }
    const p = this.index.projects[key]!;
    if (!p.paths.includes(ref.tilde)) p.paths.push(ref.tilde);
    return key;
  }

  /** A pasta daqui de um projeto do repositório: pelo remoto, por um dos caminhos ou, sem remoto, pelo nome. */
  pathOf(key: string): Promise<string | null> {
    let hit = this.paths.get(key);
    if (!hit) {
      hit = (async () => {
        const p = this.index.projects[key];
        if (!p) return null;
        const locals = await this.localProjects();
        if (p.remote) {
          const byRemote = locals.find((l) => l.ref.remote === p.remote && l.ref.sub === p.sub);
          if (byRemote) return byRemote.path;
        }
        for (const t of p.paths) {
          const abs = untilde(t);
          if (locals.some((l) => l.path === abs)) return abs;
          if ((await exists(abs)) && (await this.known(abs))) return abs;
        }
        const byName = locals.filter((l) => basename(l.path) === p.name && (!p.remote || !l.ref.remote));
        return byName.length === 1 ? byName[0]!.path : null;
      })();
      this.paths.set(key, hit);
    }
    return hit;
  }

  known(cwd: string): Promise<boolean> {
    return this.deps.knownCwd(cwd).then(
      () => true,
      () => false,
    );
  }

  /** `@chave/sub` (de um projeto do repositório) ou `~/…` no caminho desta máquina; `null` sem o projeto. */
  async fromPortable(p: string): Promise<string | null> {
    const m = /^@([^/]+)(?:\/(.*))?$/.exec(p);
    if (!m) return untilde(p);
    const root = await this.pathOf(m[1]!);
    return root && (!m[2] || safeRel(m[2])) ? (m[2] ? join(root, m[2]) : root) : null;
  }

  private backupDir(): string {
    this.backupAt ??= join(BACKUP_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
    return this.backupAt;
  }

  /** Antes de trocar um arquivo (ou pasta) daqui, guarda uma cópia dele. */
  async backup(abs: string): Promise<void> {
    if (this.dry || !(await exists(abs))) return;
    await cp(abs, join(this.backupDir(), 'arquivos', relative('/', abs)), { recursive: true });
  }

  /**
   * O que os stores tinham antes do "Trazer", num arquivo só, uma vez por "Trazer" e só se algo vai ser
   * aplicado; as cópias além das últimas KEEP_BACKUPS saem.
   */
  async backupStores(): Promise<void> {
    if (this.dry || this.storesSaved) return;
    this.storesSaved = true;
    const { deps } = this;
    const snapshot = {
      teams: deps.teams.list(),
      workspaces: deps.workspaces.list(),
      habilidades: deps.habilidades.all(),
      detalhes: deps.detalhes.all(),
      todos: deps.todos.all(),
      commands: deps.commands.all(),
      agents: deps.providers.prefsSnapshot(),
    };
    await mkdir(this.backupDir(), { recursive: true });
    await writeFile(join(this.backupDir(), 'cald.json'), JSON.stringify(snapshot, null, 2));
    const all = (await readdir(BACKUP_DIR).catch(() => [] as string[])).sort();
    await Promise.all(all.slice(0, -KEEP_BACKUPS).map((d) => rm(join(BACKUP_DIR, d), { recursive: true, force: true })));
  }
}

// ---- as categorias ----

/** Os itens que vieram, por pasta de projeto (os sem projeto ficam de fora). */
function byProject(items: Incoming[]): Map<string, Incoming[]> {
  const out = new Map<string, Incoming[]>();
  for (const i of items) if (i.project) out.set(i.project, [...(out.get(i.project) ?? []), i]);
  return out;
}

const projectName = (ctx: Ctx, key: string | null, cwd: string) => (key && ctx.index.projects[key]?.name) || basename(cwd);

const teams: Kind = {
  id: 'teams',
  units: async (ctx) =>
    ctx.deps.teams.list().map((t) => ({ id: t.id, label: t.name, path: `times/${slug(t.name)}.json`, updatedAt: t.updatedAt, read: async () => json(t) })),
  apply: (ctx, items) => ctx.deps.teams.importTeams(items.map((i) => ({ ...parse<Team>(i.content), id: i.id, updatedAt: i.entry.updatedAt }))),
};

const workspaces: Kind = {
  id: 'workspaces',
  async units(ctx) {
    const units: Unit[] = [];
    for (const ws of ctx.deps.workspaces.list()) {
      const keys = await Promise.all(ws.projects.map((p) => ctx.keyOf(p)));
      // Os projetos viram `@chave` (e `@chave/sub`, nos comandos); o que for de fora, `~/…`.
      const portable = (p: string) => {
        for (const [i, root] of ws.projects.entries()) {
          const key = keys[i];
          if (!key) continue;
          if (p === root) return `@${key}`;
          if (p.startsWith(`${root}/`)) return `@${key}/${p.slice(root.length + 1)}`;
        }
        return tilde(p);
      };
      units.push({
        id: ws.id,
        label: ws.name,
        path: `workspaces/${slug(ws.name)}`,
        updatedAt: ws.updatedAt,
        project: keys[0] ?? undefined,
        read: async () => {
          const data: Workspace = {
            ...ws,
            projects: ws.projects.map(portable),
            defaultFor: ws.defaultFor.map(portable),
            commands: ws.commands.map((c) => ({ ...c, cwd: c.cwd ? portable(c.cwd) : undefined })),
          };
          const out = new Map<string, Blob>([['workspace.json', json(data)]]);
          for (const f of ws.files) {
            const path = await ctx.deps.workspaces.filePath(ws.id, f.id);
            if (path) out.set(`arquivos/${f.id}/${basename(path)}`, { data: await readFile(path), mode: 0o644 });
          }
          return out;
        },
      });
    }
    return units;
  },
  async apply(ctx, items) {
    const skipped: string[] = [];
    const list: Parameters<WorkspaceStore['importWorkspaces']>[0] = [];
    for (const i of items) {
      if (!(i.content instanceof Map) || !i.content.has('workspace.json')) {
        skipped.push(i.id);
        continue;
      }
      const ws = parse<Workspace>(i.content.get('workspace.json'));
      const local = async (list: string[]) => {
        const out: string[] = [];
        for (const p of list) {
          const path = await ctx.fromPortable(p);
          if (path && (await ctx.known(path))) out.push(path);
        }
        return out;
      };
      const projects = await local(ws.projects ?? []);
      const commands = await Promise.all(
        (ws.commands ?? []).map(async (c) => ({ ...c, cwd: c.cwd ? ((await ctx.fromPortable(c.cwd)) ?? undefined) : undefined })),
      );
      const files = [...i.content].flatMap(([rel, b]) => {
        const [top, id] = rel.split('/');
        const meta = ws.files?.find((f) => f.id === id);
        return top === 'arquivos' && meta ? [{ id: meta.id, name: meta.name, data: b.data }] : [];
      });
      list.push({
        ws: { ...ws, id: i.id, projects, defaultFor: await local(ws.defaultFor ?? []), commands, files: ws.files ?? [], rules: ws.rules ?? [], updatedAt: i.entry.updatedAt },
        files,
      });
    }
    await ctx.deps.workspaces.importWorkspaces(list);
    return skipped;
  },
};

const habilidades: Kind = {
  id: 'habilidades',
  async units(ctx) {
    const units: Unit[] = [];
    for (const h of ctx.deps.habilidades.all()) {
      const key = h.project ? await ctx.keyOf(h.project) : null;
      units.push({
        id: h.id,
        label: h.project ? `${projectName(ctx, key, h.project)}: /cald:${h.name}` : `/cald:${h.name}`,
        path: key ? `projetos/${key}/habilidades/${h.name}.md` : `habilidades/${h.name}.md`,
        updatedAt: h.updatedAt,
        project: key ?? undefined,
        read: async () => toMd({ id: h.id, name: h.name, description: h.description, createdAt: h.createdAt }, h.body),
      });
    }
    return units;
  },
  apply(ctx, items) {
    const list = items.map((i): Habilidade => {
      const { fields, body } = fromMd(i.content);
      return {
        id: i.id,
        name: str(fields.name),
        description: str(fields.description),
        body,
        project: i.project ?? null,
        createdAt: num(fields.createdAt, i.entry.updatedAt),
        updatedAt: i.entry.updatedAt,
      };
    });
    return ctx.deps.habilidades.importItems(list);
  },
};

const detalhes: Kind = {
  id: 'detalhes',
  async units(ctx) {
    const units: Unit[] = [];
    for (const [cwd, items] of Object.entries(ctx.deps.detalhes.all())) {
      if (!items.length) continue;
      const key = await ctx.keyOf(cwd);
      for (const d of items) {
        units.push({
          id: d.id,
          label: `${projectName(ctx, key, cwd)}: ${d.title}`,
          path: `projetos/${key}/detalhes/${d.chave}.md`,
          updatedAt: d.updatedAt ?? d.createdAt,
          project: key ?? undefined,
          read: async () => toMd({ id: d.id, title: d.title, createdAt: d.createdAt }, d.body),
        });
      }
    }
    return units;
  },
  async apply(ctx, items) {
    for (const [cwd, list] of byProject(items)) {
      await ctx.deps.detalhes.merge(
        cwd,
        list
          .map((i): Detalhe => {
          const { fields, body } = fromMd(i.content);
          return { id: i.id, chave: '', title: str(fields.title, 'Detalhe'), body, createdAt: num(fields.createdAt, i.entry.updatedAt), updatedAt: i.entry.updatedAt };
        })
          .sort((x, y) => x.createdAt - y.createdAt),
      );
    }
    return [];
  },
};

const todos: Kind = {
  id: 'todos',
  async units(ctx) {
    const units: Unit[] = [];
    for (const [cwd, items] of Object.entries(ctx.deps.todos.all())) {
      if (!items.length) continue;
      const key = await ctx.keyOf(cwd);
      for (const t of items) {
        units.push({
          id: t.id,
          label: `${projectName(ctx, key, cwd)}: TODO:${t.n} ${t.title}`,
          path: `projetos/${key}/todos/${String(t.n).padStart(3, '0')}-${slug(t.title)}.md`,
          updatedAt: t.updatedAt ?? t.createdAt,
          project: key ?? undefined,
          // Os anexos ficam no PC: o item vai sem eles.
          read: async () => toMd({ id: t.id, n: t.n, title: t.title, done: t.done, createdAt: t.createdAt }, t.body),
        });
      }
    }
    return units;
  },
  async apply(ctx, items) {
    for (const [cwd, list] of byProject(items)) {
      await ctx.deps.todos.merge(
        cwd,
        // Os novos entram no fim na ordem dos números de lá.
        list
          .map((i): Todo => {
          const { fields, body } = fromMd(i.content);
          return {
            id: i.id,
            n: num(fields.n, 0),
            title: str(fields.title, 'Sem título'),
            body,
            done: fields.done === true,
            createdAt: num(fields.createdAt, i.entry.updatedAt),
            updatedAt: i.entry.updatedAt,
            files: [],
          };
        })
          .sort((x, y) => x.n - y.n),
      );
    }
    return [];
  },
};

const commands: Kind = {
  id: 'commands',
  async units(ctx) {
    const units: Unit[] = [];
    for (const c of ctx.deps.commands.all()) {
      const key = c.project ? await ctx.keyOf(c.project) : null;
      const name = slug(c.label || c.command);
      units.push({
        id: c.id,
        label: `${c.project ? `${projectName(ctx, key, c.project)}: ` : ''}${c.label || c.command}`,
        path: key ? `projetos/${key}/comandos/${name}.json` : `comandos/${name}.json`,
        updatedAt: c.updatedAt,
        project: key ?? undefined,
        read: async () => json({ id: c.id, label: c.label, command: c.command, pinned: c.pinned, createdAt: c.createdAt }),
      });
    }
    return units;
  },
  async apply(ctx, items) {
    const list = items.map((i): SavedCommand => {
      const c = parse<Partial<SavedCommand>>(i.content);
      return {
        id: i.id,
        label: str(c.label),
        command: str(c.command),
        project: i.project ?? null,
        pinned: c.pinned === true,
        createdAt: num(c.createdAt, i.entry.updatedAt),
        updatedAt: i.entry.updatedAt,
      };
    });
    await ctx.deps.commands.importItems(list);
    return [];
  },
};

// A memória do Claude Code de cada projeto (ver providers/claude/memory.ts): um arquivo por lembrança.
// O índice (MEMORY.md) não troca inteiro: as linhas de lá que faltam aqui entram no fim, e vice-versa.
const memoryDir = (cwd: string) => join(CLAUDE_HOME, 'projects', folderOf(cwd), 'memory');

async function memoryFiles(cwd: string): Promise<string[]> {
  return (await readdir(memoryDir(cwd)).catch(() => [] as string[])).filter((f) => f !== MEMORY_INDEX && MEMORY_FILE.test(f));
}

/** As linhas de `extra` que citam arquivos que `base` não cita entram no fim de `base`. */
function mergeIndex(base: string, extra: string, keep: (file: string) => boolean = () => true): string {
  if (!base.trim()) return extra;
  const lines = base.replace(/\n+$/, '').split('\n');
  const have = indexLinks(base);
  const added: string[] = [];
  for (const line of extra.split('\n')) {
    const files = [...indexLinks(line)];
    if (!files.length || files.some((f) => have.has(f)) || !files.some(keep)) continue;
    files.forEach((f) => have.add(f));
    added.push(line);
  }
  return added.length ? `${[...lines, ...added].join('\n')}\n` : base;
}

const memory: Kind = {
  id: 'memory',
  async units(ctx) {
    const units: Unit[] = [];
    for (const cwd of await ctx.localPaths()) {
      const files = await memoryFiles(cwd);
      if (!files.length) continue;
      const key = await ctx.keyOf(cwd);
      if (!key) continue;
      for (const file of files) {
        const abs = join(memoryDir(cwd), file);
        const info = await stat(abs).catch(() => null);
        if (!info?.isFile()) continue;
        units.push({
          id: `${key}/${file}`,
          label: `${projectName(ctx, key, cwd)}: ${file.replace(/\.md$/, '')}`,
          path: `projetos/${key}/memoria/${file}`,
          updatedAt: seconds(info.mtimeMs),
          project: key,
          read: async () => toRepoText({ data: await readFile(abs), mode: 0o644 }),
        });
      }
    }
    return units;
  },
  async apply(ctx, items) {
    const skipped: string[] = [];
    for (const i of items) {
      const file = i.id.slice(i.id.indexOf('/') + 1);
      if (!i.project || !MEMORY_FILE.test(file) || file === MEMORY_INDEX) {
        skipped.push(i.id);
        continue;
      }
      const dest = join(memoryDir(i.project), file);
      await ctx.backup(dest);
      await writeContent(dest, fromRepoText(single(i.content)), i.entry.updatedAt);
    }
    return skipped;
  },
  async afterPush(ctx) {
    const changed: string[] = [];
    for (const cwd of await ctx.localPaths()) {
      if (!(await memoryFiles(cwd)).length) continue;
      const local = await readFile(join(memoryDir(cwd), MEMORY_INDEX), 'utf8').catch(() => null);
      const key = local === null ? null : await ctx.keyOf(cwd);
      if (local === null || !key) continue;
      const target = join(REPO_DIR, 'projetos', key, 'memoria', MEMORY_INDEX);
      const repo = await readFile(target, 'utf8').catch(() => '');
      const merged = mergeIndex(repo, local.replace(HOME_RE, HOME_TOKEN));
      if (merged === repo) continue;
      if (!ctx.dry) await writeContent(target, { data: Buffer.from(merged), mode: 0o644 });
      changed.push(`${projectName(ctx, key, cwd)}: índice da memória`);
    }
    return changed;
  },
  async afterPull(ctx) {
    const changed: string[] = [];
    for (const key of Object.keys(ctx.index.projects)) {
      const repo = await readFile(join(REPO_DIR, 'projetos', key, 'memoria', MEMORY_INDEX), 'utf8').catch(() => null);
      const cwd = repo === null ? null : await ctx.pathOf(key);
      if (repo === null || !cwd) continue;
      const dir = memoryDir(cwd);
      const local = await readFile(join(dir, MEMORY_INDEX), 'utf8').catch(() => '');
      const present = new Set(await memoryFiles(cwd));
      // Na prévia, as memórias que o "Trazer" vai criar ainda não existem: valem as do repositório.
      const keep = (f: string) => present.has(f) || (ctx.dry && ctx.index.items[`memory:${key}/${f}`] !== undefined);
      const merged = mergeIndex(local, repo.replaceAll(HOME_TOKEN, HOME), keep);
      if (merged === local) continue;
      if (!ctx.dry) {
        await ctx.backup(join(dir, MEMORY_INDEX));
        await writeContent(join(dir, MEMORY_INDEX), { data: Buffer.from(merged), mode: 0o644 });
      }
      changed.push(`${projectName(ctx, key, cwd)}: índice da memória`);
    }
    return changed;
  },
};

/** Um arquivo de ~/.claude, com os caminhos da pasta pessoal trocados (ver HOME_TOKEN). */
async function claudeFile(id: string, abs: string, path: string): Promise<Unit | null> {
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile() || info.size > MAX_FILE) return null;
  return { id, label: id, path, updatedAt: seconds(info.mtimeMs), read: async () => toRepoText({ data: await readFile(abs), mode: info.mode }) };
}

/** Uma pasta de ~/.claude (uma skill, os hooks): vale a data do arquivo mais novo dela. */
async function claudeDir(id: string, abs: string, path: string): Promise<Unit | null> {
  const files = await walk(abs);
  if (!files.size) return null;
  const updatedAt = Math.max(...[...files.values()].map((f) => f.mtime));
  return { id, label: id, path, updatedAt, read: async () => mapBlobs(await readFound(files), toRepoText) };
}

/** Grava em ~/.claude o que veio, com cópia do que estava e a data de lá. */
async function writeClaude(ctx: Ctx, abs: string, i: Incoming): Promise<void> {
  await ctx.backup(abs);
  await writeContent(abs, mapBlobs(i.content, fromRepoText), i.entry.updatedAt);
}

const SETTINGS = join(CLAUDE_HOME, 'settings.json');

/** O settings.json sem as variáveis de ambiente secretas (ver SECRET), que ficam em cada máquina. */
function publicSettings(text: string): Blob | null {
  try {
    const data = JSON.parse(text) as { env?: Record<string, string> };
    if (data.env) data.env = Object.fromEntries(Object.entries(data.env).filter(([k]) => !SECRET.test(k)));
    return toRepoText(json(data));
  } catch {
    return null;
  }
}

const claudeConfig: Kind = {
  id: 'claude-config',
  async units() {
    const units: (Unit | null)[] = [];
    const info = await stat(SETTINGS).catch(() => null);
    const settings = info?.isFile() ? publicSettings(await readFile(SETTINGS, 'utf8')) : null;
    if (info && settings) units.push({ id: 'settings.json', label: 'settings.json', path: 'claude/settings.json', updatedAt: seconds(info.mtimeMs), read: async () => settings });
    units.push(await claudeFile('CLAUDE.md', join(CLAUDE_HOME, 'CLAUDE.md'), 'claude/CLAUDE.md'));
    // Os scripts soltos em ~/.claude (a linha de status, os hooks) e a pasta hooks, se houver.
    for (const name of await readdir(CLAUDE_HOME).catch(() => [] as string[])) {
      if (SCRIPT.test(name)) units.push(await claudeFile(`scripts/${name}`, join(CLAUDE_HOME, name), `claude/scripts/${name}`));
    }
    units.push(await claudeDir('hooks', join(CLAUDE_HOME, 'hooks'), 'claude/hooks'));
    return units.filter((u): u is Unit => u !== null);
  },
  async apply(ctx, items) {
    const skipped: string[] = [];
    for (const i of items) {
      if (i.id === 'settings.json') {
        // As variáveis secretas daqui continuam: o repositório não as tem.
        const local = await readFile(SETTINGS, 'utf8')
          .then((t) => JSON.parse(t) as { env?: Record<string, string> })
          .catch(() => ({}) as { env?: Record<string, string> });
        const incoming = JSON.parse(fromRepoText(single(i.content)).data.toString('utf8')) as { env?: Record<string, string> };
        const secrets = Object.entries(local.env ?? {}).filter(([k]) => SECRET.test(k));
        if (secrets.length) incoming.env = { ...incoming.env, ...Object.fromEntries(secrets) };
        await ctx.backup(SETTINGS);
        await writeContent(SETTINGS, json(incoming), i.entry.updatedAt);
      } else if (i.id === 'CLAUDE.md' || i.id === 'hooks') {
        await writeClaude(ctx, join(CLAUDE_HOME, i.id), i);
      } else if (i.id.startsWith('scripts/') && SCRIPT.test(i.id.slice(8))) {
        await writeClaude(ctx, join(CLAUDE_HOME, i.id.slice(8)), i);
      } else {
        skipped.push(i.id);
      }
    }
    return skipped;
  },
};

const claudeAgents: Kind = {
  id: 'claude-agents',
  async units() {
    const dir = join(CLAUDE_HOME, 'agents');
    const units: Unit[] = [];
    for (const [rel, f] of await walk(dir)) {
      if (!rel.endsWith('.md')) continue;
      units.push({
        id: rel,
        label: rel.replace(/\.md$/, ''),
        path: `claude/agents/${rel}`,
        updatedAt: f.mtime,
        read: async () => toRepoText({ data: await readFile(f.abs), mode: f.mode }),
      });
    }
    return units;
  },
  async apply(ctx, items) {
    const skipped: string[] = [];
    for (const i of items) {
      if (!safeRel(i.id) || !i.id.endsWith('.md')) skipped.push(i.id);
      else await writeClaude(ctx, join(CLAUDE_HOME, 'agents', i.id), i);
    }
    return skipped;
  },
};

const claudeSkills: Kind = {
  id: 'claude-skills',
  async units() {
    const units: (Unit | null)[] = [];
    const skills = join(CLAUDE_HOME, 'skills');
    for (const name of await readdir(skills).catch(() => [] as string[])) {
      // `synced` são as skills que o Claude Code baixa do claude.ai: já chegam sozinhas na outra máquina.
      if (name === 'synced' || !SKILL_DIR.test(name)) continue;
      const abs = join(skills, name);
      if (!(await stat(abs).catch(() => null))?.isDirectory()) continue;
      const unit = await claudeDir(`skills/${name}`, abs, `claude/skills/${name}`);
      units.push(unit && { ...unit, label: `/${name}` });
    }
    for (const [rel, f] of await walk(join(CLAUDE_HOME, 'commands'))) {
      if (!rel.endsWith('.md')) continue;
      units.push({
        id: `commands/${rel}`,
        label: `/${rel.replace(/\.md$/, '').replaceAll('/', ':')} (comando)`,
        path: `claude/commands/${rel}`,
        updatedAt: f.mtime,
        read: async () => toRepoText({ data: await readFile(f.abs), mode: f.mode }),
      });
    }
    return units.filter((u): u is Unit => u !== null);
  },
  async apply(ctx, items) {
    const skipped: string[] = [];
    for (const i of items) {
      const [top, ...rest] = i.id.split('/');
      const rel = rest.join('/');
      if (top === 'skills' && SKILL_DIR.test(rel) && i.content instanceof Map) await writeClaude(ctx, join(CLAUDE_HOME, 'skills', rel), i);
      else if (top === 'commands' && safeRel(rel) && rel.endsWith('.md')) await writeClaude(ctx, join(CLAUDE_HOME, 'commands', rel), i);
      else skipped.push(i.id);
    }
    return skipped;
  },
};

const agents: Kind = {
  id: 'agents',
  async units(ctx) {
    const prefs = ctx.deps.providers.prefsSnapshot();
    // Nunca mexido aqui: não há escolha para levar.
    if (!prefs.updatedAt) return [];
    return [{ id: 'agents', label: 'Agentes ligados e o padrão', path: 'cald/agentes.json', updatedAt: prefs.updatedAt, read: async () => json(prefs) }];
  },
  async apply(ctx, items) {
    for (const i of items) await ctx.deps.providers.adopt({ ...parse<AgentPrefs>(i.content), updatedAt: i.entry.updatedAt });
    return [];
  },
};

/** Na ordem em que aparecem no relatório. A aparência é à parte (vem do navegador, ver config-sync.ts). */
export const KINDS: Kind[] = [teams, workspaces, habilidades, detalhes, todos, commands, memory, claudeConfig, claudeAgents, claudeSkills, agents];
