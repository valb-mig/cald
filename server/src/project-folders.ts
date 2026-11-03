import { execFile } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HttpError } from './errors.ts';

const exec = promisify(execFile);

/** Uma pasta da navegação: o nome e se já é um repositório git (para reconhecer projetos de olho). */
export type Folder = { name: string; path: string; git: boolean };
export type FolderListing = { path: string; parent: string | null; folders: Folder[] };

// Pastas demais numa só (um node_modules, um cache): a lista para aqui, para a resposta não pesar.
const MAX_FOLDERS = 500;

/** `~` e `~/…` viram a pasta pessoal; o resto é resolvido como caminho absoluto. */
export function expandHome(path: string): string {
  const p = path.trim();
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return resolve(p);
}

export async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

/** As subpastas de `path` (as ocultas ficam de fora), para escolher uma pasta de projeto no celular. */
export async function listFolders(path: string): Promise<FolderListing> {
  const dir = expandHome(path || '~');
  if (!(await isDirectory(dir))) throw new HttpError(404, 'folder_not_found');
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => {
    throw new HttpError(403, 'folder_not_readable');
  });
  const names = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }))
    .slice(0, MAX_FOLDERS);
  const folders = await Promise.all(
    names.map(async (name) => {
      const full = join(dir, name);
      return { name, path: full, git: Boolean(await stat(join(full, '.git')).catch(() => null)) };
    }),
  );
  const parent = dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, folders };
}

// Nome de pasta que funciona em qualquer terminal: letras, números, espaço, ponto, hífen e sublinhado,
// sem começar por ponto (ficaria oculta) nem ter barras (sairia da raiz).
const NAME = /^[\p{L}\p{N}_\- ][\p{L}\p{N}_.\- ]*$/u;

/** Cria a pasta `name` em `root`; com `git`, já começa o repositório. Recusa se ela já existir. */
export async function createProjectDir(root: string, name: string, git: boolean): Promise<string> {
  const clean = name.trim();
  if (!NAME.test(clean) || clean.length > 100) throw new HttpError(400, 'invalid_project_name');
  const dir = join(root, clean);
  await mkdir(root, { recursive: true });
  await mkdir(dir).catch((err: NodeJS.ErrnoException) => {
    throw err.code === 'EEXIST' ? new HttpError(409, 'project_exists') : err;
  });
  if (git) await exec('git', ['init', '--quiet'], { cwd: dir, timeout: 15_000 });
  return dir;
}
