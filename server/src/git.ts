import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HttpError } from './errors.ts';

const exec = promisify(execFile);

const MAX_DIFF = 512 * 1024;

/** Linhas a mais e a menos; `null` em arquivo binário. */
export type LineCount = { additions: number | null; deletions: number | null };

export type GitFile = {
  path: string;
  /** Caminho anterior, em renomeações. */
  from?: string;
  /** Códigos do `git status`: staged (índice) e não staged (árvore de trabalho). */
  index: string;
  worktree: string;
  untracked: boolean;
  /** Staged e não staged somados. */
  additions: number | null;
  deletions: number | null;
  /** Cada lado separado, para as listas do controle de código-fonte; `null` se o lado não mudou. */
  staged: LineCount | null;
  unstaged: LineCount | null;
};

export type GitStatus = {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  /** Página do repositório no navegador (ex.: https://github.com/dono/repo), pelo remoto do upstream ou o origin. */
  remote: string | null;
};

export function git(cwd: string, args: string[]) {
  return exec('git', args, { cwd, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Endereço do remoto como página web: "git@github.com:dono/repo.git", "ssh://git@host:22/dono/repo"
 * e "https://usuario:token@host/dono/repo.git" viram "https://host/dono/repo", sem credenciais.
 * Remoto em pasta local não tem página: `null`.
 */
export function remoteWebUrl(remote: string): string | null {
  const m = /^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?([^/:@]+)(?::\d+)?[:/]([^/].*?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `https://${m[1]}/${m[2]}` : null;
}

/** `git diff --numstat -z`: "a\td\tcaminho\0" ou, em renomeação, "a\td\t\0antigo\0novo\0". */
function parseNumstat(out: string): Map<string, LineCount> {
  const counts = new Map<string, LineCount>();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const [a, d, path] = tokens[i]!.split('\t');
    if (a === undefined || d === undefined) continue;
    const target = path ? path : tokens[(i += 2)];
    if (!target) continue;
    const n = (v: string) => (v === '-' ? null : Number(v)); // "-" = binário
    counts.set(target, { additions: n(a), deletions: n(d) });
  }
  return counts;
}

const sum = (a: number | null | undefined, b: number | null | undefined) =>
  a === null || b === null ? null : (a ?? 0) + (b ?? 0);

/** `git status --porcelain=v2 --branch -z`: branch, upstream e arquivos, ainda sem as linhas alteradas. */
function parseStatus(out: string): GitStatus {
  const status: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, files: [], remote: null };
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i]!;
    if (line.startsWith('# branch.head ')) {
      const head = line.slice(14);
      status.branch = head === '(detached)' ? null : head;
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice(18);
    } else if (line.startsWith('# branch.ab ')) {
      const [, ahead, behind] = /\+(\d+) -(\d+)/.exec(line) ?? [];
      status.ahead = Number(ahead ?? 0);
      status.behind = Number(behind ?? 0);
    } else if (line.startsWith('1 ') || line.startsWith('u ')) {
      const parts = line.split(' ');
      const xy = parts[1]!;
      status.files.push({ path: parts.slice(line.startsWith('1 ') ? 8 : 10).join(' '), index: xy[0]!, worktree: xy[1]!, untracked: false, additions: null, deletions: null, staged: null, unstaged: null });
    } else if (line.startsWith('2 ')) {
      // Renomeação: o caminho antigo vem no token seguinte.
      const parts = line.split(' ');
      const xy = parts[1]!;
      status.files.push({ path: parts.slice(9).join(' '), from: tokens[++i], index: xy[0]!, worktree: xy[1]!, untracked: false, additions: null, deletions: null, staged: null, unstaged: null });
    } else if (line.startsWith('? ')) {
      status.files.push({ path: line.slice(2), index: '?', worktree: '?', untracked: true, additions: null, deletions: null, staged: null, unstaged: null });
    }
  }
  return status;
}

/** Só o `git status`; `null` se o projeto não usa git. */
function readStatus(cwd: string): Promise<GitStatus | null> {
  return git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']).then(
    (r) => parseStatus(r.stdout),
    () => null,
  );
}

/** Estado do repositório; `null` se o projeto não usa git. */
export async function gitStatus(cwd: string): Promise<GitStatus | null> {
  const status = await readStatus(cwd);
  if (!status) return null;

  // Linhas alteradas de cada lado, e os dois somados por arquivo.
  const [unstagedOut, stagedOut, remote] = await Promise.all([
    git(cwd, ['diff', '--numstat', '-z']).catch(() => ({ stdout: '' })),
    git(cwd, ['diff', '--numstat', '-z', '--cached']).catch(() => ({ stdout: '' })),
    git(cwd, ['remote', 'get-url', status.upstream?.split('/')[0] || 'origin']).catch(() => ({ stdout: '' })),
  ]);
  status.remote = remoteWebUrl(remote.stdout);
  const unstaged = parseNumstat(unstagedOut.stdout);
  const staged = parseNumstat(stagedOut.stdout);
  for (const f of status.files) {
    f.staged = staged.get(f.path) ?? null;
    f.unstaged = unstaged.get(f.path) ?? null;
    if (f.staged || f.unstaged) {
      f.additions = sum(f.staged?.additions, f.unstaged?.additions);
      f.deletions = sum(f.staged?.deletions, f.unstaged?.deletions);
    }
  }
  return status;
}

/** Caminho relativo dentro do projeto: nada de absoluto nem "../". */
function checkPath(path: string): void {
  if (!path || isAbsolute(path) || path.split('/').includes('..')) throw new HttpError(400, 'invalid_path');
}

/** Um lado só do diff, como nas duas listas do VSCode: o que está staged ou o que ainda não está. */
export type DiffSide = 'staged' | 'unstaged';

/**
 * Diff de um arquivo. Sem `side`, contra o último commit (staged + não staged); com ele, só aquele
 * lado. Arquivo novo, ainda fora do índice, é comparado com o vazio.
 */
export async function gitDiff(cwd: string, path: string, side?: DiffSide): Promise<string> {
  checkPath(path);
  const status = await gitStatus(cwd);
  if (!status) throw new HttpError(404, 'not_a_repository');
  const file = status.files.find((f) => f.path === path);

  let out: string;
  if (side === 'staged') {
    out = (await git(cwd, ['diff', '--cached', '--', path])).stdout;
  } else if (side === 'unstaged' && !file?.untracked) {
    out = (await git(cwd, ['diff', '--', path])).stdout;
  } else if (file?.untracked) {
    // Sem histórico: compara com /dev/null (o git sai com código 1 quando há diferença).
    out = await git(cwd, ['diff', '--no-index', '--', '/dev/null', path]).then(
      (r) => r.stdout,
      (err: { stdout?: string }) => err.stdout ?? '',
    );
  } else {
    out = await git(cwd, ['diff', 'HEAD', '--', path]).then(
      (r) => r.stdout,
      // Repositório sem commits: junta staged e não staged.
      async () => {
        const [a, b] = await Promise.all([git(cwd, ['diff', '--cached', '--', path]), git(cwd, ['diff', '--', path])]);
        return a.stdout + b.stdout;
      },
    );
  }
  return out.length > MAX_DIFF ? `${out.slice(0, MAX_DIFF)}\n… diff cortado (${Math.round(out.length / 1024)} KB)` : out;
}

/**
 * O arquivo como está no último commit, para o editor do painel marcar o que mudou enquanto se digita.
 * Fora do histórico (arquivo novo), `''`: tudo nele é novo. Ignorado pelo git, ou fora de um
 * repositório, `null`: nada a marcar.
 */
export async function gitBase(cwd: string, path: string): Promise<string | null> {
  checkPath(path);
  const show = (spec: string) => git(cwd, ['show', spec]).then((r) => r.stdout, () => null);
  const head = await show(`HEAD:./${path}`);
  if (head !== null) return head;
  const status = await gitStatus(cwd);
  if (!status) return null;
  const file = status.files.find((f) => f.path === path);
  if (file?.untracked) return '';
  // Repositório sem commits: o que já foi preparado.
  return (await show(`:./${path}`)) ?? (file ? '' : null);
}

// ---- ações do controle de código-fonte ----

/** O git, para o que muda o repositório: sem pedir senha nem abrir editor, e com tempo para hooks e rede. */
export function gitWrite(cwd: string, args: string[]) {
  return exec('git', args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=10',
    },
  }).catch((err: { stderr?: string; stdout?: string; message?: string }) => {
    // O que o git disse (hook que falhou, conflito, remoto recusando) vai para a tela como está.
    const message = (err.stderr || err.stdout || err.message || '').trim().split('\n').slice(-6).join('\n');
    throw new HttpError(409, 'git_failed', { message });
  });
}

export async function requireRepo(cwd: string): Promise<GitStatus> {
  const status = await readStatus(cwd);
  if (!status) throw new HttpError(404, 'not_a_repository');
  return status;
}

function checkPaths(paths: string[]): void {
  if (paths.length === 0) throw new HttpError(400, 'invalid_path');
  paths.forEach(checkPath);
}

/** Prepara (stage) os arquivos; apagados também, por isso o `-A`. */
export async function gitStage(cwd: string, paths: string[]): Promise<void> {
  checkPaths(paths);
  await requireRepo(cwd);
  await gitWrite(cwd, ['add', '-A', '--', ...paths]);
}

/** Tira do stage, sem mexer no arquivo. Num repositório ainda sem commits não há HEAD para voltar. */
export async function gitUnstage(cwd: string, paths: string[]): Promise<void> {
  checkPaths(paths);
  await requireRepo(cwd);
  const born = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
    () => true,
    () => false,
  );
  await gitWrite(cwd, born ? ['restore', '--staged', '--', ...paths] : ['rm', '--cached', '-r', '-q', '--', ...paths]);
}

/** Commit do que está staged; com `all`, prepara tudo antes (como o commit sem nada staged do VSCode). */
export async function gitCommit(cwd: string, message: string, all: boolean): Promise<{ sha: string }> {
  if (!message.trim()) throw new HttpError(400, 'empty_message');
  const status = await requireRepo(cwd);
  if (all) {
    if (status.files.length === 0) throw new HttpError(409, 'nothing_to_commit');
    await gitWrite(cwd, ['add', '-A']);
  } else if (!status.files.some((f) => f.index !== '.' && f.index !== '?')) {
    throw new HttpError(409, 'nothing_to_commit');
  }
  await gitWrite(cwd, ['commit', '-m', message]);
  const sha = await git(cwd, ['rev-parse', '--short', 'HEAD']).then((r) => r.stdout.trim());
  return { sha };
}

/** O que entra no próximo commit, para o Claude escrever a mensagem (ver commit-message.ts). */
export type PendingCommit = {
  /** O `--stat`: todos os arquivos, mesmo quando o patch é cortado. */
  stat: string;
  patch: string;
  /** As últimas mensagens (sem merges nem trailers), para seguir o jeito do repositório. */
  log: string[];
  /** O `user.name` do git, quando serve de prefixo de branch ("valb-mig/…"). */
  user: string | null;
};

const MAX_PENDING_PATCH = 40_000;
const TRAILER = /^(co-authored-by|signed-off-by):.*$/gim;

/**
 * O diff do próximo commit: o que está staged, ou, com `all`, tudo, como o commit faria. Para tudo,
 * prepara numa cópia do índice, assim os arquivos novos entram sem mexer no que você preparou.
 */
export async function gitPending(cwd: string, all: boolean): Promise<PendingCommit> {
  await requireRepo(cwd);
  let env: NodeJS.ProcessEnv | undefined;
  let index: string | undefined;
  if (all) {
    index = join(tmpdir(), `cr-index-${randomUUID()}`);
    const real = resolve(cwd, (await git(cwd, ['rev-parse', '--git-path', 'index'])).stdout.trim());
    // Repositório sem nada preparado ainda não tem índice: começa do vazio.
    await copyFile(real, index).catch(() => undefined);
    env = { ...process.env, GIT_INDEX_FILE: index };
  }
  const run = (args: string[]) => exec('git', args, { cwd, env, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 }).then((r) => r.stdout);
  try {
    if (all) await run(['add', '-A']);
    const [stat, patch, log, user] = await Promise.all([
      run(['diff', '--cached', '--stat=200', '--no-color']),
      run(['diff', '--cached', '--no-color', '--no-ext-diff', '-M']),
      run(['log', '-n', '12', '--no-merges', '--format=%B%x00']).catch(() => ''),
      run(['config', 'user.name']).catch(() => ''),
    ]);
    if (!stat.trim()) throw new HttpError(409, 'nothing_to_commit');
    const name = user.trim();
    return {
      stat: stat.trim(),
      patch: patch.length > MAX_PENDING_PATCH ? `${patch.slice(0, MAX_PENDING_PATCH)}\n… diff cortado` : patch,
      log: log
        .split('\0')
        .map((m) => m.replace(TRAILER, '').trim())
        .filter(Boolean),
      user: /^[\w.-]+$/.test(name) ? name : null,
    };
  } finally {
    if (index) await rm(index, { force: true });
  }
}

/** Cria a branch e passa para ela, levando junto o que está alterado e preparado. */
export async function gitCreateBranch(cwd: string, name: string): Promise<void> {
  await requireRepo(cwd);
  const valid = await git(cwd, ['check-ref-format', '--branch', name]).then(
    () => true,
    () => false,
  );
  if (!valid || name.startsWith('-')) throw new HttpError(400, 'invalid_branch');
  await gitWrite(cwd, ['switch', '-c', name]);
}

/**
 * Sincroniza com o remoto: traz o que chegou (só avançando, nunca um merge escondido) e envia o que
 * falta. Branch sem upstream é publicada no origin.
 */
export async function gitSync(cwd: string): Promise<void> {
  const status = await requireRepo(cwd);
  if (!status.branch) throw new HttpError(409, 'detached_head');
  if (!status.upstream) {
    await gitWrite(cwd, ['push', '-u', 'origin', 'HEAD']);
    return;
  }
  await gitWrite(cwd, ['pull', '--ff-only']);
  const after = await requireRepo(cwd);
  if (after.ahead > 0) await gitWrite(cwd, ['push']);
}

/** O que a lista de projetos mostra de cada repositório. */
export type GitSummary = {
  branch: string | null;
  upstream: string | null;
  /** Arquivos alterados, novos ou apagados, staged ou não. */
  changed: number;
  /** Commits ainda não enviados ao upstream. */
  ahead: number;
  /** Commits do upstream que ainda não vieram (até o último `git fetch`). */
  behind: number;
};

const FETCH_EVERY_MS = 10 * 60_000;
const FETCH_PARALLEL = 6;
const fetches = new Map<string, { at: number; run: Promise<void> }>();

/**
 * `git fetch` do upstream, no máximo a cada 10 min por projeto. Nunca pede senha: sem chave ou
 * credencial que funcione sozinha, falha calado e o projeto fica com o que já se sabia do remoto.
 */
function fetchRemote(cwd: string): Promise<void> {
  const last = fetches.get(cwd);
  if (last && Date.now() - last.at < FETCH_EVERY_MS) return last.run;
  const run = exec('git', ['fetch', '--quiet'], {
    cwd,
    timeout: 20_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=10',
    },
  }).then(
    () => undefined,
    () => undefined,
  );
  fetches.set(cwd, { at: Date.now(), run });
  return run;
}

/**
 * Resumo do git de cada projeto (os que não usam git ficam de fora). Com `fetch`, consulta antes
 * o remoto dos que têm upstream, para saber se chegou commit novo.
 */
export async function gitSummaries(cwds: string[], fetch: boolean): Promise<Record<string, GitSummary>> {
  const out: Record<string, GitSummary> = {};
  const queue = [...cwds];
  const worker = async () => {
    for (let cwd = queue.shift(); cwd !== undefined; cwd = queue.shift()) {
      let status = await readStatus(cwd);
      if (status?.upstream && fetch) {
        await fetchRemote(cwd);
        status = (await readStatus(cwd)) ?? status;
      }
      if (status) {
        const { branch, upstream, ahead, behind, files } = status;
        out[cwd] = { branch, upstream, changed: files.length, ahead, behind };
      }
    }
  };
  await Promise.all(Array.from({ length: FETCH_PARALLEL }, worker));
  return out;
}
