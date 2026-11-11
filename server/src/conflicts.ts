import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from './errors.ts';
import { git, gitWrite } from './git.ts';

/*
 * Resolver o conflito de um PR com a base pelo edit.r, como o editor de conflitos do site do GitHub: o
 * merge da base na branch é feito só no banco de objetos do git (`git merge-tree`), sem pasta de
 * trabalho. O checkout do projeto e os worktrees das conversas ficam como estão; quem tem a branch no
 * PC traz o merge depois, com um pull.
 */

/** Acima disso, o arquivo não vai em trechos: escolhe-se um lado inteiro. */
const MAX_TEXT = 512 * 1024;
const SHA = /^[0-9a-f]{40,64}$/;

/** Um arquivo em conflito. */
export type ConflictFile = {
  path: string;
  /**
   * O texto com as marcas de conflito (`<<<<<<<`, `=======`, `>>>>>>>`), para escolher trecho a trecho.
   * `null` (binário, grande demais, apagado de um lado): escolhe-se o arquivo inteiro de um lado.
   */
  text: string | null;
  /** Se o arquivo existe na branch e na base: apagado de um lado, escolher esse lado é apagar. */
  branch: boolean;
  base: boolean;
};

/** Os conflitos do merge da base na branch, com as pontas de cada lado em que foram vistos. */
export type PrConflicts = { branch: string; base: string; head: string; baseSha: string; files: ConflictFile[] };

/** O que fica de cada arquivo: o texto resolvido, ou o arquivo inteiro de um lado. */
export type ConflictResolution = { path: string; content: string } | { path: string; side: 'branch' | 'base' };

type Stage = { mode: string; oid: string };
/** O arquivo em conflito pelos estágios do git: 1 o ancestral comum, 2 a branch, 3 a base. */
type Stages = Partial<Record<1 | 2 | 3, Stage>>;

/** Nome de branch que dá para pôr num refspec sem virar opção nem padrão. */
function checkBranch(name: string): void {
  if (!/^[\w./-]+$/.test(name) || name.startsWith('-') || name.includes('..') || name.endsWith('/') || name.endsWith('.lock'))
    throw new HttpError(400, 'invalid_branch', { branch: name });
}

/**
 * O merge da base (`theirs`) na branch (`ours`), só em objetos: a árvore que sairia (com as marcas nos
 * arquivos em conflito) e os estágios de cada arquivo em conflito. O `merge-tree` sai com 1 quando há
 * conflito, e a saída vale do mesmo jeito.
 */
async function mergeTree(cwd: string, ours: string, theirs: string): Promise<{ tree: string; conflicts: Map<string, Stages> }> {
  const stdout = await git(cwd, ['merge-tree', '--write-tree', '-z', ours, theirs]).then(
    (r) => r.stdout,
    (err: { code?: number; stdout?: string; stderr?: string }) => {
      if (err.code === 1 && err.stdout) return err.stdout;
      throw new HttpError(409, 'git_failed', { message: (err.stderr ?? '').trim().split('\n').slice(-6).join('\n') });
    },
  );
  // A árvore, os arquivos em conflito (`<modo> <objeto> <estágio>\t<caminho>`) e, depois de um vazio, as mensagens.
  const [tree = '', ...rest] = stdout.split('\0');
  const conflicts = new Map<string, Stages>();
  for (const entry of rest) {
    const m = /^(\d+) ([0-9a-f]+) ([123])\t(.+)$/s.exec(entry);
    if (!m) break;
    const stages = conflicts.get(m[4]!) ?? {};
    stages[Number(m[3]) as 1 | 2 | 3] = { mode: m[1]!, oid: m[2]! };
    conflicts.set(m[4]!, stages);
  }
  return { tree, conflicts };
}

/** O texto do arquivo na árvore do merge, se ele tem as marcas e dá para mostrar; senão `null`. */
async function markedText(cwd: string, tree: string, path: string, stages: Stages): Promise<string | null> {
  if (!stages[2] || !stages[3]) return null;
  const size = await git(cwd, ['cat-file', '-s', `${tree}:${path}`]).then(
    (r) => Number(r.stdout.trim()),
    () => Infinity,
  );
  if (size > MAX_TEXT) return null;
  const text = await git(cwd, ['cat-file', 'blob', `${tree}:${path}`]).then(
    (r) => r.stdout,
    () => null,
  );
  return text !== null && !text.includes('\0') && /^<{7}(?: |$)/m.test(text) ? text : null;
}

/** Traz a branch e a base do GitHub e diz em que pontas elas estão agora. */
async function fetchTips(cwd: string, branch: string, base: string): Promise<{ head: string; baseSha: string }> {
  checkBranch(branch);
  checkBranch(base);
  await gitWrite(cwd, [
    'fetch',
    '--no-tags',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    `+refs/heads/${base}:refs/remotes/origin/${base}`,
  ]);
  const tip = async (name: string) => (await git(cwd, ['rev-parse', '--verify', `refs/remotes/origin/${name}^{commit}`])).stdout.trim();
  return { head: await tip(branch), baseSha: await tip(base) };
}

/** Os conflitos que o PR tem agora: o merge de `base` em `branch`, as duas como estão no GitHub. */
export async function prConflicts(cwd: string, branch: string, base: string): Promise<PrConflicts> {
  const { head, baseSha } = await fetchTips(cwd, branch, base);
  const { tree, conflicts } = await mergeTree(cwd, head, baseSha);
  const files: ConflictFile[] = [];
  for (const [path, stages] of conflicts)
    files.push({ path, text: await markedText(cwd, tree, path, stages), branch: Boolean(stages[2]), base: Boolean(stages[3]) });
  return { branch, base, head, baseSha, files };
}

/**
 * Fecha o merge com o que foi escolhido para cada arquivo e sobe na branch do PR: o mesmo merge de
 * `prConflicts` (das mesmas pontas), a árvore dele num índice à parte com as resoluções por cima, um
 * commit com as duas pontas como pais e o push. Se a branch mudou no GitHub no meio, o push é recusado
 * (sem `--force`) e nada sobe.
 */
export async function resolvePrConflicts(
  cwd: string,
  c: { branch: string; base: string; head: string; baseSha: string; files: ConflictResolution[] },
): Promise<{ sha: string }> {
  checkBranch(c.branch);
  checkBranch(c.base);
  if (!SHA.test(c.head) || !SHA.test(c.baseSha)) throw new HttpError(400, 'invalid_sha');
  const { tree, conflicts } = await mergeTree(cwd, c.head, c.baseSha);
  if (!conflicts.size) throw new HttpError(409, 'no_conflict');
  const chosen = new Map(c.files.filter((f) => 'content' in f || f.side === 'branch' || f.side === 'base').map((f) => [f.path, f]));
  const missing = [...conflicts.keys()].filter((p) => !chosen.has(p));
  if (missing.length) throw new HttpError(400, 'conflict_unresolved', { files: missing.slice(0, 20) });

  const dir = await mkdtemp(join(tmpdir(), 'editr-conflito-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    await gitWrite(cwd, ['read-tree', tree], undefined, env);
    for (const [path, stages] of conflicts) {
      const r = chosen.get(path)!;
      let entry: Stage | undefined;
      if ('content' in r) {
        const oid = (await gitWrite(cwd, ['hash-object', '-w', '--stdin'], r.content)).stdout.trim();
        entry = { mode: stages[2]?.mode ?? stages[3]?.mode ?? '100644', oid };
      } else entry = stages[r.side === 'branch' ? 2 : 3];
      // O lado escolhido não tem o arquivo: escolher esse lado é apagá-lo.
      if (entry) await gitWrite(cwd, ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.oid},${path}`], undefined, env);
      else await gitWrite(cwd, ['update-index', '--force-remove', '--', path], undefined, env);
    }
    const merged = (await gitWrite(cwd, ['write-tree'], undefined, env)).stdout.trim();
    const message = `Merge branch '${c.base}' into ${c.branch}`;
    const sha = (await gitWrite(cwd, ['commit-tree', merged, '-p', c.head, '-p', c.baseSha, '-m', message])).stdout.trim();
    await gitWrite(cwd, ['push', 'origin', `${sha}:refs/heads/${c.branch}`]).catch(async (err: unknown) => {
      // Recusado porque a branch andou no GitHub: pela ponta de lá, e não pelo texto do git, que vem no idioma dele.
      const tip = await gitWrite(cwd, ['ls-remote', 'origin', `refs/heads/${c.branch}`]).then(
        (r) => r.stdout.split(/\s/)[0] ?? '',
        () => c.head,
      );
      if (tip !== c.head) throw new HttpError(409, 'branch_moved', { branch: c.branch });
      throw err;
    });
    return { sha };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
