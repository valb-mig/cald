import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HttpError } from './errors.ts';
import { git, gitWrite, requireRepo } from './git.ts';
import { isDirectory } from './project-folders.ts';

const exec = promisify(execFile);

/**
 * Worktrees das conversas: quando outra conversa já mexe no projeto, a nova pode abrir num checkout só
 * dela, em `<projeto>/.claude/worktrees/<nome>` (o mesmo lugar do `claude --worktree`), numa branch
 * `cald/<nome>` que sai do HEAD do projeto. O "Trazer" faz o merge dela de volta na branch de origem.
 */
const DIR = '.claude/worktrees';
/** Branches de passagem: voltam para a de origem pelo "Trazer" e somem com o worktree. */
const BRANCH_PREFIX = 'cald/';
const NAME_MAX = 24;
const INSTALL_TIMEOUT_MS = 180_000;

/** Um worktree visto pelo caminho: o checkout principal, o do worktree e o projeto a que ele pertence. */
export type WorktreeRef = {
  name: string;
  /** O checkout principal (onde fica o `.git`). */
  root: string;
  /** A pasta do worktree. */
  path: string;
  /** O projeto que ele espelha: o checkout principal, ou a subpasta dele em que a conversa abriu. */
  project: string;
};

/** O que fica gravado de um worktree criado aqui (ver meta.ts). */
export type WorktreeInfo = { branch: string; base: string; createdAt: number };

/** O que a lista mostra do worktree de uma conversa. */
export type WorktreeTag = { name: string; project: string; branch?: string; base?: string };

/** O worktree de um `cwd`, criado aqui ou pelo `claude --worktree`; `null` se ele não está num. */
export function worktreeOf(cwd: string): WorktreeRef | null {
  const m = /^(.+?)\/\.claude\/worktrees\/([^/]+)(\/.*)?$/.exec(resolve(cwd));
  if (!m) return null;
  const [, root, name, rest = ''] = m;
  return { name, root: root!, path: `${root}/${DIR}/${name}`, project: root + rest };
}

export function tagOf(ref: WorktreeRef, info?: WorktreeInfo): WorktreeTag {
  return { name: ref.name, project: ref.project, branch: info?.branch, base: info?.base };
}

/** Avisa o Claude de que está num worktree, para ele não ir mexer no checkout das outras conversas. */
export function worktreePrompt(ref: WorktreeRef, info?: WorktreeInfo): string {
  const branch = info ? `, na branch \`${info.branch}\`, que saiu de \`${info.base}\`` : '';
  return [
    '# Worktree',
    `Esta conversa roda num git worktree próprio (${ref.path}${branch}), para não atrapalhar outras conversas que trabalham no mesmo projeto.`,
    `O checkout principal (${ref.root}) é delas: leia de lá se precisar, mas não edite arquivos, não faça commit nem troque de branch lá.`,
    `O trabalho volta para ${info ? `\`${info.base}\`` : 'a branch do projeto'} quando o usuário usa o "Trazer" do cald, que leva só o que estiver commitado neste worktree.`,
  ].join('\n');
}

/** O que a conversa nova leva: onde abrir, o que gravar e como foi a instalação das dependências. */
export type CreatedWorktree = { cwd: string; ref: WorktreeRef; info: WorktreeInfo; install: InstallResult };

/**
 * Cria o worktree de uma conversa nova a partir do HEAD do projeto em `cwd`, com nome tirado de `hint`
 * (o título ou o começo do prompt). `allowed` diz se a pasta do worktree pode receber conversa: um
 * repositório que começa acima das raízes (a pasta pessoal versionada) o poria fora delas.
 */
export async function createWorktree(cwd: string, hint: string, allowed: (dir: string) => boolean): Promise<CreatedWorktree> {
  if (worktreeOf(cwd)) throw new HttpError(409, 'already_in_worktree');
  const top = await git(cwd, ['rev-parse', '--show-toplevel']).then(
    (r) => r.stdout.trim(),
    () => '',
  );
  if (!top) throw new HttpError(400, 'not_a_repository');
  const base = await git(top, ['symbolic-ref', '--short', '-q', 'HEAD']).then(
    (r) => r.stdout.trim(),
    () => '',
  );
  if (!base) throw new HttpError(409, 'detached_head');
  const born = await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
    () => true,
    () => false,
  );
  if (!born) throw new HttpError(409, 'no_commits');

  const name = await freeName(top, slug(hint));
  const path = join(top, DIR, name);
  if (!allowed(path)) throw new HttpError(403, 'cwd_outside_roots');
  const branch = BRANCH_PREFIX + name;
  await excludeWorktrees(top);
  await gitWrite(top, ['worktree', 'add', '-b', branch, path, 'HEAD']);
  // Aberta numa subpasta do repositório: a conversa abre na mesma subpasta, dentro do worktree.
  const rel = relative(top, resolve(cwd));
  const inside = rel && !rel.startsWith('..') ? join(path, rel) : path;
  return { cwd: inside, ref: worktreeOf(inside)!, info: { branch, base, createdAt: Date.now() }, install: await installDeps(path) };
}

/** "filtrar a inbox por data" → "filtrar-a-inbox-por-data", sem acento e cortado em palavra inteira. */
function slug(text: string): string {
  const words = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  let out = '';
  for (const w of words) {
    const next = out ? `${out}-${w}` : w.slice(0, NAME_MAX);
    if (next.length > NAME_MAX) break;
    out = next;
  }
  return out || 'conversa';
}

/** O nome com um sufixo curto, para duas conversas com o mesmo começo não disputarem pasta nem branch. */
async function freeName(top: string, base: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const name = `${base}-${randomBytes(2).toString('hex')}`;
    const taken =
      (await isDirectory(join(top, DIR, name))) ||
      (await git(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH_PREFIX}${name}`]).then(
        () => true,
        () => false,
      ));
    if (!taken) return name;
  }
  throw new HttpError(409, 'worktree_name_taken');
}

/**
 * Sem isto, o worktree apareceria como pasta nova no `git status` do projeto. Vai no `info/exclude`,
 * que é só desta máquina, e não no `.gitignore`, que é do repositório.
 */
async function excludeWorktrees(top: string): Promise<void> {
  const ignored = await git(top, ['check-ignore', '-q', `${DIR}/x`]).then(
    () => true,
    () => false,
  );
  if (ignored) return;
  const file = resolve(top, (await git(top, ['rev-parse', '--git-path', 'info/exclude'])).stdout.trim());
  await mkdir(dirname(file), { recursive: true });
  const current = await readFile(file, 'utf8').catch(() => '');
  await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}/${DIR}/\n`);
}

export type InstallResult = { tool: string; ok: true } | { tool: string; ok: false; error: string } | null;

/** Pelo lockfile, o gerenciador do projeto; cada um tenta primeiro o jeito mais rápido (o cache local). */
const INSTALLERS: { lock: string; tool: string; attempts: string[][] }[] = [
  { lock: 'pnpm-lock.yaml', tool: 'pnpm', attempts: [['install', '--offline', '--frozen-lockfile'], ['install', '--frozen-lockfile', '--prefer-offline']] },
  { lock: 'bun.lock', tool: 'bun', attempts: [['install', '--frozen-lockfile']] },
  { lock: 'bun.lockb', tool: 'bun', attempts: [['install', '--frozen-lockfile']] },
  { lock: 'yarn.lock', tool: 'yarn', attempts: [['install', '--frozen-lockfile']] },
  { lock: 'package-lock.json', tool: 'npm', attempts: [['ci', '--prefer-offline', '--no-audit', '--no-fund']] },
];

/**
 * As dependências do worktree, antes da conversa começar: senão o primeiro build do Claude correria
 * contra uma instalação pela metade. `null`: o projeto não tem lockfile que se conheça.
 */
async function installDeps(dir: string): Promise<InstallResult> {
  let found: (typeof INSTALLERS)[number] | undefined;
  for (const i of INSTALLERS) {
    if (await readFile(join(dir, i.lock)).then(() => true, () => false)) {
      found = i;
      break;
    }
  }
  if (!found) return null;
  let error = '';
  for (const args of found.attempts) {
    try {
      await exec(found.tool, args, { cwd: dir, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: '1' } });
      return { tool: found.tool, ok: true };
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      error = (e.stderr || e.stdout || e.message || '').trim().split('\n').slice(-8).join('\n');
    }
  }
  return { tool: found.tool, ok: false, error };
}

export type WorktreeStatus = {
  name: string;
  path: string;
  project: string;
  /** A branch do worktree agora (o Claude pode ter trocado); `null` sem branch (HEAD solto). */
  branch: string | null;
  /** Para onde o "Trazer" leva: a branch de onde ele saiu (sem registro, a do checkout principal). */
  base: string | null;
  /** A branch do checkout principal agora: o "Trazer" só vai se for a base. */
  current: string | null;
  /** Commits do worktree que a base ainda não tem. */
  ahead: number;
  /**
   * Desses, os que a base não tem nem com outro hash (o `git cherry`): um commit rebaseado ou trazido por
   * outro caminho já está lá, e apagar o worktree não perde nada dele.
   */
  unmerged: number;
  /** Commits da base que o worktree ainda não tem. */
  behind: number;
  /** Arquivos alterados, novos ou apagados no worktree, ainda sem commit. */
  changed: number;
};

export async function worktreeStatus(ref: WorktreeRef, info?: WorktreeInfo): Promise<WorktreeStatus> {
  if (!(await isDirectory(ref.path))) throw new HttpError(410, 'worktree_removed');
  const status = await requireRepo(ref.path);
  const current = await git(ref.root, ['symbolic-ref', '--short', '-q', 'HEAD']).then(
    (r) => r.stdout.trim() || null,
    () => null,
  );
  const base = info?.base ?? current;
  let ahead = 0;
  let behind = 0;
  if (base && status.branch) {
    const counts = await git(ref.path, ['rev-list', '--left-right', '--count', `refs/heads/${base}...HEAD`]).then(
      (r) => r.stdout.trim().split(/\s+/).map(Number),
      () => [0, 0],
    );
    behind = counts[0] ?? 0;
    ahead = counts[1] ?? 0;
  }
  const unmerged =
    ahead > 0 && base
      ? await git(ref.path, ['cherry', `refs/heads/${base}`, 'HEAD']).then(
          (r) => r.stdout.split('\n').filter((l) => l.startsWith('+')).length,
          () => ahead,
        )
      : 0;
  return { name: ref.name, path: ref.path, project: ref.project, branch: status.branch, base, current, ahead, unmerged, behind, changed: status.files.length };
}

/**
 * Traz os commits do worktree para a branch de origem, no checkout principal: avança quando dá, e
 * senão faz um commit de merge. Em conflito, desfaz o merge (o checkout principal volta como estava) e
 * diz em quais arquivos: quem resolve é o Claude, no worktree, trazendo a base para lá.
 */
export async function mergeWorktree(ref: WorktreeRef, info?: WorktreeInfo): Promise<{ commits: number }> {
  const s = await worktreeStatus(ref, info);
  if (!s.branch) throw new HttpError(409, 'detached_head');
  if (s.changed) throw new HttpError(409, 'worktree_dirty', { changed: s.changed });
  if (!s.ahead) throw new HttpError(409, 'nothing_to_merge');
  if (!s.base || s.current !== s.base) throw new HttpError(409, 'base_not_checked_out', { base: s.base, current: s.current });
  try {
    await gitWrite(ref.root, ['merge', '--no-edit', s.branch]);
  } catch (err) {
    const merging = await git(ref.root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(
      () => true,
      () => false,
    );
    if (!merging) throw err;
    const files = await git(ref.root, ['diff', '--name-only', '--diff-filter=U']).then(
      (r) => r.stdout.split('\n').filter(Boolean),
      () => [],
    );
    await gitWrite(ref.root, ['merge', '--abort']);
    throw new HttpError(409, 'merge_conflict', { files: files.slice(0, 20), base: s.base });
  }
  return { commits: s.ahead };
}

/** O que se perderia removendo o worktree: commits que a base não tem (nem rebaseados) e mudanças sem commit. */
export const unsaved = (s: WorktreeStatus) => s.unmerged > 0 || s.changed > 0;

/**
 * Apaga o worktree e, se tudo dela já está na base, a branch dele. Quem chama já conferiu `unsaved` (ou
 * o usuário confirmou a perda) e fechou as conversas que estavam lá.
 */
export async function removeWorktree(ref: WorktreeRef, s: WorktreeStatus): Promise<void> {
  await gitWrite(ref.root, ['worktree', 'remove', ...(unsaved(s) ? ['--force'] : []), ref.path]);
  // A branch sai junto só se tudo dela já está na base: com commits que não voltaram ela fica, e o
  // trabalho ainda dá para trazer depois. A do checkout principal nunca sai.
  if (s.branch && s.unmerged === 0 && s.branch !== s.current) await gitWrite(ref.root, ['branch', '-D', s.branch]).catch(() => undefined);
}

/** Um worktree do repositório na lista da aba Claude: o status dele e de onde veio. */
export type ListedWorktree = WorktreeStatus & {
  /** Criado pelo cald ou pelo `claude --worktree` (fica em `.claude/worktrees` do projeto). */
  managed: boolean;
  /** A pasta sumiu (apagada à mão): só sobra o registro no git, que o "Apagar" limpa. */
  missing: boolean;
};

/** O que o `git worktree list --porcelain` diz de cada worktree, o checkout principal primeiro. */
async function listed(cwd: string): Promise<{ path: string; branch: string | null; bare: boolean }[]> {
  const { stdout } = await git(cwd, ['worktree', 'list', '--porcelain']);
  return stdout
    .split('\n\n')
    .filter((b) => b.startsWith('worktree '))
    .map((block) => {
      const lines = block.split('\n');
      const path = lines[0]!.slice('worktree '.length);
      const branch = lines.find((l) => l.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null;
      return { path, branch, bare: lines.includes('bare') };
    });
}

/** O worktree de `path`, visto do checkout principal `root`, venha ele de onde vier. */
const refAt = (root: string, path: string): WorktreeRef => worktreeOf(path) ?? { name: basename(path), root, path, project: path };

/**
 * Os worktrees do repositório de `cwd` (fora o checkout principal), com o status de cada um: os das
 * conversas, os do `claude --worktree` e os criados à mão em qualquer pasta.
 */
export async function listWorktrees(cwd: string, infoOf: (path: string) => WorktreeInfo | undefined): Promise<{ root: string; worktrees: ListedWorktree[] }> {
  const all = await listed(cwd).catch(() => {
    throw new HttpError(400, 'not_a_repository');
  });
  const root = all[0]?.path;
  if (!root) throw new HttpError(400, 'not_a_repository');
  const worktrees = await Promise.all(
    all.slice(1).filter((w) => !w.bare).map(async (w): Promise<ListedWorktree> => {
      const ref = refAt(root, w.path);
      const managed = Boolean(worktreeOf(w.path));
      if (!(await isDirectory(w.path))) {
        return { name: ref.name, path: w.path, project: w.path, branch: w.branch, base: null, current: null, ahead: 0, unmerged: 0, behind: 0, changed: 0, managed, missing: true };
      }
      // Um worktree que o git não consegue ler (corrompido, no meio de um rebase) aparece sem números.
      const status = await worktreeStatus(ref, infoOf(w.path)).catch(
        (): WorktreeStatus => ({ name: ref.name, path: w.path, project: w.path, branch: w.branch, base: null, current: null, ahead: 0, unmerged: 0, behind: 0, changed: 0 }),
      );
      return { ...status, managed, missing: false };
    }),
  );
  return { root, worktrees };
}

/**
 * O checkout principal do repositório de `dir` (o mesmo para o projeto e para os worktrees dele);
 * `null` fora do git ou num repositório sem checkout (bare).
 */
export async function repoRootOf(dir: string): Promise<string | null> {
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then(
    (r) => r.stdout.trim(),
    () => '',
  );
  return common && basename(common) === '.git' ? dirname(common) : null;
}

/** O worktree `path` da lista do repositório de `cwd`; quem não está na lista não é tocado. */
export async function listedWorktree(cwd: string, path: string): Promise<{ ref: WorktreeRef; missing: boolean }> {
  const all = await listed(cwd).catch(() => []);
  const root = all[0]?.path;
  const found = all.slice(1).find((w) => w.path === path);
  if (!root || !found) throw new HttpError(404, 'worktree_not_found');
  return { ref: refAt(root, path), missing: !(await isDirectory(path)) };
}

/** Limpa o registro dos worktrees cuja pasta sumiu. */
export const pruneWorktrees = (root: string) => gitWrite(root, ['worktree', 'prune']);
