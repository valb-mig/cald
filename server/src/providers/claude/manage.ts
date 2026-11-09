import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { installedPlugins, onDisk, readJson, skillOverrides, USER_SETTINGS } from './setup.ts';
import { DATA_DIR } from '../../config.ts';
import { CLAUDE_BIN, CLAUDE_JSON, childEnv } from './env.ts';
import { HttpError } from '../../errors.ts';
import { readFields, splitFrontmatter } from '../../frontmatter.ts';
import { SAFE_ID } from './transcript.ts';

/**
 * O que o app muda no que o Claude Code carrega (ver claude-config.ts para o que ele só mostra):
 * ligar e desligar skills (`skillOverrides`, o mesmo do /skills) e plugins (pelo próprio `claude
 * plugin`), e mandar para uma lixeira do edit.r as skills, comandos e agentes seus ou do projeto e a
 * configuração de servidores MCP, de onde voltam iguais.
 */

const exec = promisify(execFile);
// Dado seu, como a lixeira da memória: some sozinho depois de TRASH_DAYS.
const TRASH = process.env.CLAUDE_TRASH_DIR ?? join(DATA_DIR, 'claude-trash');
const TRASH_DAYS = 30;
const DAY = 86_400_000;

export type McpScope = 'user' | 'local' | 'project';

export type ClaudeTrashed = {
  id: string;
  kind: 'skill' | 'command' | 'agent' | 'mcp';
  name: string;
  description: string;
  /** De onde saiu: `user` (seu, em todo projeto), `project` ou, nos servidores MCP, `local`. */
  scope: string;
  /** O projeto, para o que era só dele; null para o que era seu. */
  project: string | null;
  deletedAt: number;
};

// O caminho de volta (arquivo ou pasta da skill) ou a configuração do servidor, que pode ter segredo: fica só no PC.
type Meta = ClaudeTrashed & { path?: string; config?: unknown };

// Uma mudança por vez: duas mexendo nas mesmas settings ao mesmo tempo perderiam uma.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

// Settings que não abrem não são regravadas: seria apagar o que tem nelas.
async function readSettings(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return '{}';
    throw err;
  });
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HttpError(409, 'settings_invalid', { file: path });
  }
}

async function writeSettings(path: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.editr-tmp`, `${JSON.stringify(data, null, 2)}\n`);
  await rename(`${path}.editr-tmp`, path);
}

/**
 * Liga ou desliga uma skill (ou comando). Sem `cwd`, nas suas settings, e vale em todo projeto; com,
 * no `.claude/settings.local.json` do projeto, só ali. Ligar no projeto uma que está desligada nas
 * suas grava um "on" explícito, que ganha das suas.
 */
export function setSkill(cwd: string | undefined, name: string, enabled: boolean): Promise<void> {
  return serial(async () => {
    const file = cwd && cwd !== homedir() ? join(cwd, '.claude', 'settings.local.json') : USER_SETTINGS;
    const above = cwd && file !== USER_SETTINGS ? await skillOverrides(cwd, false) : {};
    const data = await readSettings(file);
    const overrides = { ...((data.skillOverrides as Record<string, string> | undefined) ?? {}) };
    if (!enabled) overrides[name] = 'off';
    else if (above[name] === 'off') overrides[name] = 'on';
    else delete overrides[name];
    if (Object.keys(overrides).length) data.skillOverrides = overrides;
    else delete data.skillOverrides;
    await writeSettings(file, data);
  });
}

// O próprio Claude Code muda o que é dele (as listas de plugins e de MCP no ~/.claude.json), com a trava dele.
async function claude(cwd: string, args: string[]): Promise<void> {
  try {
    await exec(CLAUDE_BIN, args, { cwd, env: childEnv(), timeout: 30_000 });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new HttpError(502, 'claude_cli_failed', { message: (e.stderr || e.stdout || e.message).trim().slice(0, 300) });
  }
}

/** Liga ou desliga um plugin inteiro (skills, agentes e servidores MCP dele), nas suas settings. */
export async function setPlugin(key: string, enabled: boolean): Promise<void> {
  if (!(await installedPlugins()).some((p) => p.key === key)) throw new HttpError(404, 'plugin_not_found');
  await serial(() => claude(homedir(), ['plugin', enabled ? 'enable' : 'disable', key, '--scope', 'user']));
}

// ~/.claude e ~/.local podem estar em discos diferentes: aí o rename não serve.
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
}

async function box(meta: Omit<Meta, 'id' | 'deletedAt'>): Promise<{ id: string; dir: string; save: () => Promise<void> }> {
  const id = randomUUID();
  const dir = join(TRASH, id);
  await mkdir(dir, { recursive: true });
  const full: Meta = { ...meta, id, deletedAt: Date.now() };
  return {
    id,
    dir,
    save: async () => {
      await writeFile(join(dir, 'meta.json.tmp'), JSON.stringify(full, null, 2), { mode: 0o600 });
      await rename(join(dir, 'meta.json.tmp'), join(dir, 'meta.json'));
    },
  };
}

/**
 * Manda para a lixeira uma skill (a pasta dela), um comando ou um agente, seus ou do projeto. Só
 * os que valem nesta pasta e estão no disco; os de plugin, do claude.ai e do Claude Code não.
 */
export function trashItem(cwd: string, path: string): Promise<string> {
  return serial(async () => {
    const found = [...(await onDisk(cwd)).entries()].find(([, f]) => f.path === path && (f.source === 'user' || f.source === 'project'));
    if (!found) throw new HttpError(404, 'not_found');
    const [key, f] = found;
    const target = f.kind === 'skill' ? dirname(path) : path;
    const text = await readFile(path, 'utf8').catch(() => '');
    const b = await box({
      kind: f.kind,
      name: key.slice(key.indexOf(':') + 1),
      description: readFields(splitFrontmatter(text)?.head ?? []).description ?? '',
      scope: f.source,
      project: f.source === 'project' ? cwd : null,
      path: target,
    });
    await move(target, join(b.dir, basename(target)));
    await b.save();
    return b.id;
  });
}

type ClaudeJson = { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };

/**
 * Tira a configuração de um servidor MCP (pelo `claude mcp remove`) e a guarda na lixeira, para
 * voltar igual (pelo `claude mcp add-json`). `project`: a pasta, nos de escopo `local` e `project`.
 */
export function trashMcp(name: string, scope: McpScope, project: string | null): Promise<string> {
  return serial(async () => {
    if (scope !== 'user' && !project) throw new HttpError(400, 'invalid_request');
    const dir = scope === 'user' ? homedir() : project!;
    const config =
      scope === 'project'
        ? (await readJson<ClaudeJson>(join(dir, '.mcp.json')))?.mcpServers?.[name]
        : scope === 'local'
          ? (await readJson<ClaudeJson>(CLAUDE_JSON))?.projects?.[dir]?.mcpServers?.[name]
          : (await readJson<ClaudeJson>(CLAUDE_JSON))?.mcpServers?.[name];
    if (!config) throw new HttpError(404, 'mcp_not_found');
    const b = await box({ kind: 'mcp', name, description: '', scope, project: scope === 'user' ? null : dir, config });
    // A configuração fica guardada antes de sair do Claude Code: se a remoção falhar, não se perde nada.
    await b.save();
    try {
      await claude(dir, ['mcp', 'remove', name, '--scope', scope]);
    } catch (err) {
      await rm(b.dir, { recursive: true, force: true });
      throw err;
    }
    return b.id;
  });
}

async function readMeta(id: string): Promise<Meta | null> {
  if (!SAFE_ID.test(id)) return null;
  try {
    return JSON.parse(await readFile(join(TRASH, id, 'meta.json'), 'utf8')) as Meta;
  } catch {
    return null;
  }
}

/** Devolve da lixeira: o arquivo ou a pasta para o mesmo lugar, o servidor para o mesmo escopo. */
export function restoreClaude(ids: string[]): Promise<void> {
  return serial(async () => {
    for (const id of ids) {
      const meta = await readMeta(id);
      if (!meta) throw new HttpError(404, 'not_found');
      if (meta.kind === 'mcp') {
        await claude(meta.project ?? homedir(), ['mcp', 'add-json', meta.name, JSON.stringify(meta.config), '--scope', meta.scope]);
      } else {
        const to = meta.path!;
        if (await stat(to).then(() => true, () => false)) throw new HttpError(409, 'claude_exists', { name: meta.name });
        await mkdir(dirname(to), { recursive: true });
        await move(join(TRASH, id, basename(to)), to);
      }
      await rm(join(TRASH, id), { recursive: true, force: true });
    }
  });
}

/** Apaga de vez: as escolhidas ou, sem `ids`, a lixeira inteira. */
export function emptyClaudeTrash(ids?: string[]): Promise<void> {
  return serial(async () => {
    const all = ids ?? (await readdir(TRASH).catch(() => [] as string[]));
    await Promise.all(all.filter((id) => SAFE_ID.test(id)).map((id) => rm(join(TRASH, id), { recursive: true, force: true })));
  });
}

/** A lixeira, sem a configuração dos servidores; com `project`, só o que era daquele projeto. */
export async function listClaudeTrash(project?: string): Promise<ClaudeTrashed[]> {
  const now = Date.now();
  const out: ClaudeTrashed[] = [];
  for (const id of await readdir(TRASH).catch(() => [] as string[])) {
    const meta = await readMeta(id);
    if (!meta) continue;
    if (now - meta.deletedAt > TRASH_DAYS * DAY) {
      await rm(join(TRASH, id), { recursive: true, force: true });
      continue;
    }
    if (project && meta.project !== project) continue;
    const { path: _, config: __, ...item } = meta;
    out.push(item);
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}
