import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_DIR, SUPERVISOR } from './config.ts';
import { HttpError } from './errors.ts';

/** Raiz do repositório do próprio painel (server/src → ../..). */
export const REPO_DIR = fileURLToPath(new URL('../..', import.meta.url));
const REMOTE = 'origin';
/** A branch das versões: a main recebe os commits do dia a dia, e a release só o que foi publicado. */
const BRANCH = 'release';
/** Atualiza o `origin/release` mesmo num clone de uma branch só (`--single-branch`), sem o refspec dela. */
const FETCH_REFSPEC = `+refs/heads/${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}`;
const FETCH_EVERY_MS = 30_000;
const LOG_TAIL = 4_000;

/** Conversas do painel abertas antes do reinício, para reabrir na volta (com os mesmos ajustes). */
const RESUME_FILE = process.env.RESUME_FILE ?? join(CACHE_DIR, 'resume.json');
const RESUME_MAX_AGE_MS = 10 * 60_000;

/** Saída com erro de propósito: o serviço tem `Restart=on-failure` e sobe de novo em 3 s (o app do PC também). */
export const RESTART_EXIT_CODE = 75;

export type UpdateStep = 'fetch' | 'switch' | 'merge' | 'install' | 'build' | 'restart';
export type UpdateJob = { step: UpdateStep; startedAt: number; error?: string; log?: string; done?: boolean };
export type Commit = { sha: string; subject: string };

export type UpdateStatus = {
  /** Branch atual do PC (`null` se o HEAD estiver solto). */
  branch: string | null;
  target: string;
  head: Commit;
  /** Commits da release do GitHub que o PC ainda não tem, do mais novo ao mais antigo (até 10). */
  incoming: Commit[];
  behind: number;
  /** Commits locais fora da release do GitHub (na release, impedem avançar sem merge). */
  ahead: number;
  /** Arquivos versionados com mudança não commitada no PC. */
  dirty: boolean;
  /** Conversas do painel trabalhando ou esperando resposta: reiniciar as derrubaria. */
  busy: string[];
  /** Rodando como serviço do systemd ou pelo app do PC, que sobem o servidor de novo depois de sair. */
  canRestart: boolean;
  job: UpdateJob | null;
  fetchError?: string;
};

export type ResumeEntry = { sessionId: string; model?: string; effort?: string | null; permissionMode?: string };

/** Roda um comando no repositório; no erro, a mensagem traz o fim da saída. */
function run(cmd: string, args: string[], cwd = REPO_DIR): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (chunk: Buffer) => {
      out = (out + chunk.toString()).slice(-LOG_TAIL * 4);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(Object.assign(new Error(`${cmd} ${args.join(' ')} saiu com ${code}`), { log: out.slice(-LOG_TAIL) }));
    });
  });
}

function commits(out: string): Commit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', subject = ''] = line.split('\0');
      return { sha, subject };
    });
}

/**
 * Atualizar o PC pelo celular: deixa o repositório na release do GitHub, instala, compila e reinicia o
 * serviço. Recusa com mudanças locais, release local divergente ou conversa do painel trabalhando. Um
 * PC noutra branch que já tem tudo da release (a main de quem desenvolve) fica como está, em dia.
 */
export class Updater {
  private job: UpdateJob | null = null;
  private fetchedAt = 0;
  private readonly busy: () => Promise<string[]>;
  private readonly restart: () => Promise<void>;
  private readonly repo: string;

  /**
   * @param busy conversas do painel que um reinício derrubaria (trabalhando ou esperando resposta).
   * @param restart grava o que reabrir e encerra o processo; o systemd (ou o app do PC) sobe de novo.
   */
  constructor(busy: () => Promise<string[]>, restart: () => Promise<void>, repo = REPO_DIR) {
    this.busy = busy;
    this.restart = restart;
    this.repo = repo;
  }

  private git(...args: string[]): Promise<string> {
    return run('git', args, this.repo).then((s) => s.trim());
  }

  async status(): Promise<UpdateStatus> {
    let fetchError: string | undefined;
    if (!this.job && Date.now() - this.fetchedAt > FETCH_EVERY_MS) {
      try {
        await this.git('fetch', '--quiet', REMOTE, FETCH_REFSPEC);
        this.fetchedAt = Date.now();
      } catch (err) {
        fetchError = (err as { log?: string }).log?.trim() || (err as Error).message;
      }
    }
    const upstream = `${REMOTE}/${BRANCH}`;
    const [branch, head, incoming, behind, ahead, dirty, busy] = await Promise.all([
      this.git('rev-parse', '--abbrev-ref', 'HEAD'),
      this.git('log', '-1', '--format=%h%x00%s'),
      this.git('log', '-10', '--format=%h%x00%s', `HEAD..${upstream}`).catch(() => ''),
      this.git('rev-list', '--count', `HEAD..${upstream}`).catch(() => '0'),
      this.git('rev-list', '--count', `${upstream}..HEAD`).catch(() => '0'),
      this.git('status', '--porcelain', '--untracked-files=no'),
      this.busy(),
    ]);
    return {
      branch: branch === 'HEAD' ? null : branch,
      target: BRANCH,
      head: commits(head)[0] ?? { sha: '', subject: '' },
      incoming: commits(incoming),
      behind: Number(behind),
      ahead: Number(ahead),
      dirty: dirty.length > 0,
      busy,
      canRestart: SUPERVISOR !== null,
      job: this.job,
      fetchError,
    };
  }

  /** Começa a atualização em segundo plano; o andamento aparece em `status().job`. */
  async start(): Promise<UpdateStatus> {
    if (this.job && !this.job.error && !this.job.done) throw new HttpError(409, 'update_running');
    this.fetchedAt = 0;
    const s = await this.status();
    if (s.fetchError) throw new HttpError(502, 'update_fetch_failed', { log: s.fetchError });
    if (s.dirty) throw new HttpError(409, 'update_dirty');
    if (s.branch === BRANCH && s.ahead > 0) throw new HttpError(409, 'update_diverged', { ahead: s.ahead });
    if (s.busy.length) throw new HttpError(409, 'update_busy', { sessions: s.busy });
    if (s.behind === 0) throw new HttpError(409, 'update_up_to_date');

    this.job = { step: 'fetch', startedAt: Date.now() };
    void this.steps(s.branch).catch(() => {});
    return { ...s, job: this.job };
  }

  /** Reinício que ficou adiado (uma conversa começou a trabalhar durante a compilação). */
  async restartNow(): Promise<void> {
    if (!SUPERVISOR) throw new HttpError(409, 'update_no_service');
    const busy = await this.busy();
    if (busy.length) throw new HttpError(409, 'update_busy', { sessions: busy });
    await this.restart();
  }

  private async steps(branch: string | null): Promise<void> {
    const job = this.job!;
    const step = async (name: UpdateStep, cmd: string, args: string[]) => {
      job.step = name;
      try {
        await run(cmd, args, this.repo);
      } catch (err) {
        job.error = (err as Error).message;
        job.log = (err as { log?: string }).log;
        throw err;
      }
    };
    await step('fetch', 'git', ['fetch', '--quiet', REMOTE, FETCH_REFSPEC]);
    if (branch !== BRANCH) {
      // Instalação de antes da release, ainda na main: a branch local nasce seguindo a do GitHub. O
      // upstream vai direto na config porque, num clone de uma branch só, o `--track` recusa um
      // origin/release que o refspec do remoto não cobre.
      if (await this.git('branch', '--list', BRANCH)) await step('switch', 'git', ['switch', BRANCH]);
      else {
        await step('switch', 'git', ['switch', '--no-track', '-c', BRANCH, `${REMOTE}/${BRANCH}`]);
        await step('switch', 'git', ['config', `branch.${BRANCH}.remote`, REMOTE]);
        await step('switch', 'git', ['config', `branch.${BRANCH}.merge`, `refs/heads/${BRANCH}`]);
      }
    }
    await step('merge', 'git', ['merge', '--ff-only', `${REMOTE}/${BRANCH}`]);
    await step('install', 'pnpm', ['install', '--frozen-lockfile']);
    // Sem o `tsc` do `pnpm build`: a main já passou pelo `pnpm check` antes do PR, e conferir os tipos
    // de novo aqui levava dois terços da compilação sem mudar nada no que vai para o celular.
    await step('build', 'pnpm', ['--filter', 'web', 'run', 'bundle']);
    job.step = 'restart';
    // Conversa que começou a trabalhar durante a compilação: não derruba; fica para reiniciar depois.
    const busy = await this.busy();
    if (!SUPERVISOR || busy.length) {
      job.done = true;
      if (busy.length) job.error = 'restart_postponed';
      return;
    }
    await this.restart();
  }
}

/** Guarda as conversas do painel para reabrir depois do reinício. */
export async function saveResume(entries: ResumeEntry[]): Promise<void> {
  await mkdir(join(RESUME_FILE, '..'), { recursive: true });
  await writeFile(RESUME_FILE, JSON.stringify({ at: Date.now(), sessions: entries }));
}

/** Lê e apaga a lista do último reinício; velha demais (ex.: serviço caiu e voltou dias depois), ignora. */
export async function takeResume(): Promise<ResumeEntry[]> {
  const raw = await readFile(RESUME_FILE, 'utf8').catch(() => null);
  if (raw === null) return [];
  await rm(RESUME_FILE, { force: true });
  try {
    const { at, sessions } = JSON.parse(raw) as { at: number; sessions: ResumeEntry[] };
    return Date.now() - at < RESUME_MAX_AGE_MS ? sessions : [];
  } catch {
    return [];
  }
}
