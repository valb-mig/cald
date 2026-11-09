import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { DATA_DIR } from './config.ts';
import { HttpError } from './errors.ts';
import type { Workspace } from './workspaces.ts';
import { worktreeOf } from './worktrees.ts';

/**
 * Os comandos salvos do terminal do painel, na mini barra à direita dele (ver
 * web/src/components/terminal-commands.tsx): cada um é de um projeto ou global, e pode ser fixado no
 * alto. Junto vão as sugestões da pasta do terminal: os scripts do package.json, os alvos do Makefile
 * e os comandos dos workspaces do projeto, para a barra já começar útil.
 */
export type SavedCommand = {
  id: string;
  /** O nome curto; vazio, a barra mostra o próprio comando. */
  label: string;
  command: string;
  /** `null`: global. Senão, a raiz do projeto (num worktree, a do projeto de origem). */
  project: string | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
};

/** `project`: uma pasta do projeto (vale a raiz dele), ou `null` para global. */
export type SavedCommandInput = { id?: string; label: string; command: string; project: string | null; pinned: boolean };

export type CommandSuggestion = { label: string; command: string; source: 'package' | 'make' | 'workspace'; from?: string };

type Trashed = SavedCommand & { deletedAt: number };

export const MAX_COMMAND = 4000;
export const MAX_LABEL = 60;
const TRASH_DAYS = 30;
// Por origem: um package.json de monorepo chega a ter dezenas de scripts.
const MAX_PER_SOURCE = 20;

// Dado seu, como o TODO: fica com os dados do app, não no cache.
const FILE = process.env.COMMANDS_FILE ?? join(DATA_DIR, 'commands.json');

const exists = (path: string) => access(path).then(
  () => true,
  () => false,
);

/** A raiz do repositório de `dir` (a pasta com `.git`, que num worktree é um arquivo), subindo; `null` fora de um. */
async function repoRoot(dir: string): Promise<string | null> {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (await exists(join(d, '.git'))) return d;
    if (d === dirname(d)) return null;
  }
}

/** O projeto de uma pasta, para casar com os salvos dele: a raiz do repositório, e a de origem num worktree. */
async function projectOf(dir: string): Promise<{ root: string; project: string } | null> {
  const root = await repoRoot(dir);
  return root ? { root, project: worktreeOf(root)?.root ?? root } : null;
}

/** De `dir` até `top` (inclusive), da mais funda para cima; sem `top`, só `dir`. */
function upTo(dir: string, top: string | null): string[] {
  const dirs = [resolve(dir)];
  if (!top) return dirs;
  while (dirs.at(-1) !== top && dirs.at(-1) !== dirname(dirs.at(-1)!)) dirs.push(dirname(dirs.at(-1)!));
  return dirs;
}

async function firstWith(dirs: string[], names: string[]): Promise<{ dir: string; name: string } | null> {
  for (const dir of dirs) for (const name of names) if (await exists(join(dir, name))) return { dir, name };
  return null;
}

const quote = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

// Comandos do próprio gerenciador: um script com um destes nomes só roda com `run` na frente.
const BUILTINS = new Set(['add', 'audit', 'config', 'create', 'deploy', 'dlx', 'exec', 'import', 'info', 'init', 'install', 'link', 'list', 'ls', 'outdated', 'pack', 'patch', 'publish', 'rebuild', 'remove', 'up', 'update', 'why']);
// Ganchos que o gerenciador roda sozinho: não são para tocar à mão.
const HOOKS = /^(pre|post)(install|publish|pack|version|prepare)$|^(prepare|prepublishOnly|install)$/;

/** Os scripts do package.json mais perto, com o gerenciador do lockfile (ou do `packageManager`). */
async function packageScripts(dirs: string[], root: string | null): Promise<CommandSuggestion[]> {
  const found = await firstWith(dirs, ['package.json']);
  if (!found) return [];
  let pkg: { scripts?: Record<string, unknown>; packageManager?: unknown };
  try {
    pkg = JSON.parse(await readFile(join(found.dir, found.name), 'utf8'));
  } catch {
    return [];
  }
  const scripts = Object.entries(pkg.scripts ?? {}).filter(([name, body]) => typeof body === 'string' && !HOOKS.test(name));
  if (!scripts.length) return [];
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : undefined;
  const lock = await firstWith(dirs.slice(dirs.indexOf(found.dir)), ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json']);
  const manager = declared ?? (lock?.name.startsWith('pnpm') ? 'pnpm' : lock?.name.startsWith('yarn') ? 'yarn' : lock?.name.startsWith('bun') ? 'bun' : 'npm');
  const from = relative(root ?? found.dir, join(found.dir, found.name));
  return scripts.slice(0, MAX_PER_SOURCE).map(([name, body]) => ({
    label: name,
    // pnpm e yarn rodam o script pelo nome; npm e bun pedem `run`.
    command: manager === 'pnpm' || manager === 'yarn' ? `${manager} ${BUILTINS.has(name) ? 'run ' : ''}${quote(name)}` : `${manager} run ${quote(name)}`,
    source: 'package' as const,
    from: `${from}: ${body as string}`.slice(0, 200),
  }));
}

/** Os alvos do Makefile mais perto; fora da pasta do terminal, com `make -C`. */
async function makeTargets(dirs: string[], cwd: string, root: string | null): Promise<CommandSuggestion[]> {
  const found = await firstWith(dirs, ['GNUmakefile', 'makefile', 'Makefile']);
  if (!found) return [];
  let text: string;
  try {
    text = await readFile(join(found.dir, found.name), 'utf8');
  } catch {
    return [];
  }
  const targets = new Set<string>();
  // `alvo:` no começo da linha; fora variáveis (`x := 1`), alvos especiais (`.PHONY`) e padrões (`%.o`).
  for (const m of text.matchAll(/^([A-Za-z0-9][\w./-]*)\s*:(?!=)/gm)) targets.add(m[1]!);
  const at = relative(resolve(cwd), found.dir);
  return [...targets].slice(0, MAX_PER_SOURCE).map((target) => ({
    label: target,
    command: `make ${at ? `-C ${quote(at)} ` : ''}${quote(target)}`,
    source: 'make' as const,
    from: relative(root ?? found.dir, join(found.dir, found.name)),
  }));
}

/** Os comandos dos workspaces que têm o projeto; os de outra pasta, num subshell, para o terminal não sair de onde está. */
function workspaceCommands(workspaces: Workspace[], project: string | null): CommandSuggestion[] {
  if (!project) return [];
  return workspaces
    .filter((w) => w.projects.includes(project))
    .flatMap((w) =>
      w.commands.map((c) => ({
        label: c.label || c.command,
        command: c.cwd ? `(cd ${quote(c.cwd)} && ${c.command})` : c.command,
        source: 'workspace' as const,
        from: w.name,
      })),
    )
    .slice(0, MAX_PER_SOURCE);
}

const nameOf = (c: SavedCommand) => c.label || c.command;
const byName = (a: SavedCommand, b: SavedCommand) => nameOf(a).localeCompare(nameOf(b), 'pt-BR');

/** Avisa `change` a cada gravação, venha de qual aparelho vier. */
export class SavedCommandStore extends EventEmitter {
  private items: SavedCommand[] = [];
  private trash: Trashed[] = [];
  private writing = Promise.resolve();
  private workspaces: () => Workspace[];

  /** `workspaces`: os de agora, para as sugestões do projeto. */
  constructor(workspaces: () => Workspace[]) {
    super();
    this.workspaces = workspaces;
  }

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(FILE, 'utf8')) as { items?: SavedCommand[]; trash?: Trashed[] };
      const valid = (c: SavedCommand) => c && typeof c.id === 'string' && typeof c.command === 'string';
      this.items = Array.isArray(data.items) ? data.items.filter(valid) : [];
      const cutoff = Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000;
      this.trash = (Array.isArray(data.trash) ? data.trash : []).filter((t) => valid(t) && t.deletedAt > cutoff);
    } catch {
      // Primeiro uso ou arquivo ilegível: começa vazio.
    }
  }

  /** Para a pasta `cwd` (se veio): os do projeto dela, os globais, a lixeira dos dois e as sugestões que ainda não foram salvas. */
  async list(cwd?: string) {
    const place = cwd ? await projectOf(cwd) : null;
    const projectDir = place?.project ?? null;
    const project = projectDir ? this.items.filter((c) => c.project === projectDir).sort(byName) : [];
    const global = this.items.filter((c) => c.project === null).sort(byName);
    const saved = new Set([...project, ...global].map((c) => c.command));
    let suggestions: CommandSuggestion[] = [];
    if (cwd) {
      const dirs = upTo(cwd, place?.root ?? null);
      const all = [
        ...(await packageScripts(dirs, place?.root ?? null)),
        ...(await makeTargets(dirs, cwd, place?.root ?? null)),
        ...workspaceCommands(this.workspaces(), projectDir),
      ];
      const seen = new Set<string>();
      suggestions = all.filter((s) => !saved.has(s.command) && !seen.has(s.command) && seen.add(s.command));
    }
    return {
      projectDir,
      project,
      global,
      trash: this.trash.filter((t) => t.project === null || t.project === projectDir).sort((a, b) => b.deletedAt - a.deletedAt),
      suggestions,
    };
  }

  /** Cria (sem `id`) ou edita. */
  async save(input: SavedCommandInput): Promise<SavedCommand> {
    const command = input.command.trim();
    if (!command) throw new HttpError(400, 'command_required');
    if (command.length > MAX_COMMAND) throw new HttpError(413, 'command_too_long');
    let project: string | null = null;
    if (input.project) {
      project = (await projectOf(input.project))?.project ?? null;
      // Fora de um repositório não há projeto para guardar: só global.
      if (!project) throw new HttpError(400, 'not_a_project');
    }
    const old = input.id ? this.items.find((c) => c.id === input.id) : undefined;
    if (input.id && !old) throw new HttpError(404, 'command_not_found');
    const now = Date.now();
    const saved: SavedCommand = {
      id: old?.id ?? randomUUID(),
      label: input.label.trim().slice(0, MAX_LABEL),
      command,
      project,
      pinned: Boolean(input.pinned),
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
    this.items = old ? this.items.map((c) => (c.id === old.id ? saved : c)) : [...this.items, saved];
    await this.persist();
    return saved;
  }

  /** Todos, globais e de todos os projetos (sem a lixeira). */
  all(): SavedCommand[] {
    return this.items;
  }

  /** Comandos vindos de outra máquina (ver config-sync.ts), com o projeto já no caminho daqui: o mesmo id e as datas de lá. */
  async importItems(list: SavedCommand[]): Promise<void> {
    const valid = list.filter((c) => c.command.trim() && c.command.length <= MAX_COMMAND);
    if (!valid.length) return;
    const ids = new Set(valid.map((c) => c.id));
    this.items = [...this.items.filter((c) => !ids.has(c.id)), ...valid.map((c) => ({ ...c, label: c.label.slice(0, MAX_LABEL), pinned: Boolean(c.pinned) }))];
    this.trash = this.trash.filter((t) => !ids.has(t.id));
    await this.persist();
  }

  /** Para a lixeira, de onde volta igual por 30 dias. */
  async toTrash(id: string): Promise<void> {
    const c = this.items.find((x) => x.id === id);
    if (!c) throw new HttpError(404, 'command_not_found');
    this.items = this.items.filter((x) => x.id !== id);
    this.trash = [{ ...c, deletedAt: Date.now() }, ...this.trash];
    await this.persist();
  }

  async restore(id: string): Promise<SavedCommand> {
    const t = this.trash.find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'command_not_found');
    const { deletedAt: _deletedAt, ...c } = t;
    this.trash = this.trash.filter((x) => x.id !== id);
    this.items = [...this.items, c];
    await this.persist();
    return c;
  }

  /** Apaga de vez da lixeira. */
  async purge(id: string): Promise<void> {
    this.trash = this.trash.filter((x) => x.id !== id);
    await this.persist();
  }

  // Gravação atômica e em fila: um arquivo temporário renomeado por cima do atual.
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
