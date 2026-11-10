import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_DIR, CHANNEL, SUPERVISOR } from './config.ts';
import { HttpError } from './errors.ts';

/** Raiz do repositório do próprio painel (server/src → ../..). */
export const REPO_DIR = fileURLToPath(new URL('../..', import.meta.url));
const REMOTE = 'origin';
/**
 * A branch das versões: a main recebe os commits do dia a dia, e a release só o que foi publicado. No
 * canal dev (o PC de quem desenvolve), a main, puxada sozinha a cada merge.
 */
const BRANCH = CHANNEL === 'dev' ? 'main' : 'release';
/** Atualiza o `origin/release` mesmo num clone de uma branch só (`--single-branch`), sem o refspec dela. */
const FETCH_REFSPEC = `+refs/heads/${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}`;
const FETCH_EVERY_MS = 30_000;
/** No canal dev, de quanto em quanto tempo procura merge novo na main (e reinicia o que ficou pronto). */
const WATCH_EVERY_MS = 60_000;
const LOG_TAIL = 4_000;

/** Conversas do painel abertas antes do reinício, para reabrir na volta (com os mesmos ajustes). */
const RESUME_FILE = process.env.RESUME_FILE ?? join(CACHE_DIR, 'resume.json');
const RESUME_MAX_AGE_MS = 10 * 60_000;

/** Saída com erro de propósito: o serviço tem `Restart=on-failure` e sobe de novo em 3 s (o app do PC também). */
export const RESTART_EXIT_CODE = 75;

export type UpdateStep = 'fetch' | 'switch' | 'merge' | 'install' | 'build' | 'desktop' | 'restart';
export type UpdateJob = { step: UpdateStep; startedAt: number; error?: string; log?: string; done?: boolean };
export type Commit = { sha: string; subject: string };

export type UpdateStatus = {
  /** `dev`: segue a main e se atualiza sozinho; `release`: a versão publicada, atualizada pelo botão. */
  channel: 'release' | 'dev';
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
  /** Uma versão nova já compilada no disco, esperando nenhuma conversa estar trabalhando para reiniciar. */
  pendingRestart: boolean;
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

/** O que muda o `node_modules`: com isso no merge, instala, e o web e o app do PC compilam de novo. */
const DEPS = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);

/**
 * Atualizar o PC pelo celular: deixa o repositório na release do GitHub, instala, compila e reinicia o
 * serviço. Recusa com mudanças locais, release local divergente ou conversa do painel trabalhando. Um
 * PC noutra branch que já tem tudo da release (a main de quem desenvolve) fica como está, em dia.
 *
 * No canal dev, o mesmo com a main e sozinho (ver `boot`), quando nenhuma conversa está trabalhando: o
 * merge troca o código, as dependências e o web/dist debaixo do servidor que roda, e uma conversa
 * aberta nesse meio sairia do processo velho com os arquivos novos.
 */
export class Updater {
  private job: UpdateJob | null = null;
  private fetchedAt = 0;
  private readonly busy: () => Promise<string[]>;
  private readonly restart: () => Promise<void>;
  private readonly repo: string;
  /** O commit que este processo está rodando, e o último que compilou inteiro (o próximo reinício sobe nele). */
  private running = '';
  private built = '';
  private ready?: Promise<void>;
  /** A ponta da main em que a atualização sozinha falhou: só tenta de novo com outro merge. */
  private failed = '';
  private watching = false;

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

  private get jobRunning(): boolean {
    return Boolean(this.job && !this.job.error && !this.job.done);
  }

  /** Marca o commit que está rodando; no canal dev, com quem suba o servidor de novo, passa a se atualizar sozinho. */
  boot(): Promise<void> {
    this.ready ??= this.git('rev-parse', 'HEAD').then(
      (head) => {
        this.running = this.built = head;
      },
      () => {},
    );
    if (CHANNEL === 'dev' && SUPERVISOR && !this.watching) {
      this.watching = true;
      setInterval(() => void this.watch().catch(() => {}), WATCH_EVERY_MS).unref();
    }
    return this.ready;
  }

  async status(): Promise<UpdateStatus> {
    await this.boot();
    let fetchError: string | undefined;
    if (!this.jobRunning && Date.now() - this.fetchedAt > FETCH_EVERY_MS) {
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
      channel: CHANNEL,
      branch: branch === 'HEAD' ? null : branch,
      target: BRANCH,
      head: commits(head)[0] ?? { sha: '', subject: '' },
      incoming: commits(incoming),
      behind: Number(behind),
      ahead: Number(ahead),
      dirty: dirty.length > 0,
      busy,
      canRestart: SUPERVISOR !== null,
      pendingRestart: Boolean(SUPERVISOR) && this.built !== this.running,
      job: this.job,
      fetchError,
    };
  }

  /** Começa a atualização em segundo plano; o andamento aparece em `status().job`. */
  async start(): Promise<UpdateStatus> {
    if (this.jobRunning) throw new HttpError(409, 'update_running');
    this.fetchedAt = 0;
    const s = await this.status();
    if (s.fetchError) throw new HttpError(502, 'update_fetch_failed', { log: s.fetchError });
    if (s.dirty) throw new HttpError(409, 'update_dirty');
    if (s.branch === BRANCH && s.ahead > 0) throw new HttpError(409, 'update_diverged', { ahead: s.ahead });
    if (s.busy.length) throw new HttpError(409, 'update_busy', { sessions: s.busy });
    if (s.behind === 0) throw new HttpError(409, 'update_up_to_date');
    // A do canal dev pode ter começado enquanto o GitHub respondia.
    if (this.jobRunning) throw new HttpError(409, 'update_running');

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

  /**
   * Canal dev, sem conversa trabalhando: com merge novo na main, atualiza e reinicia; com uma versão
   * compilada esperando (uma conversa começou durante a compilação), só reinicia. Mudança local ou main
   * local divergente fica para o terminal, como no botão.
   */
  private async watch(): Promise<void> {
    if (this.jobRunning) return;
    const s = await this.status();
    if (this.jobRunning || s.fetchError || s.busy.length) return;
    if (s.behind > 0) {
      if (s.dirty || (s.branch === BRANCH && s.ahead > 0)) return;
      const tip = await this.git('rev-parse', `${REMOTE}/${BRANCH}`);
      if (tip === this.failed || this.jobRunning) return;
      this.job = { step: 'fetch', startedAt: Date.now() };
      await this.steps(s.branch).catch(() => {
        this.failed = tip;
      });
      return;
    }
    if (s.pendingRestart) await this.restart();
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
    const head = await this.git('rev-parse', 'HEAD');
    // O que mudou desde a última compilação inteira: só recompila o que foi mexido. Sem ela para
    // comparar, tudo.
    const changed = this.built ? (await this.git('diff', '--name-only', this.built, head).catch(() => null))?.split('\n') : null;
    const deps = !changed || changed.some((f) => DEPS.has(f.split('/').pop()!));
    const touched = (dir: string) => deps || changed.some((f) => f.startsWith(dir));
    if (deps) await step('install', 'pnpm', ['install', '--frozen-lockfile']);
    // Sem o `tsc` do `pnpm build`: a main já passou pelo `pnpm check` antes do PR, e conferir os tipos
    // de novo aqui levava dois terços da compilação sem mudar nada no que vai para o celular.
    if (touched('web/')) await step('build', 'pnpm', ['--filter', 'web', 'run', 'bundle']);
    // O app do PC rodando deste repositório (`deploy/install.sh --dev`): ele vê o main.js novo e se
    // reinicia (ver desktop/src/updates.ts). Sem o desktop/dist, ninguém usa o app daqui.
    if (touched('desktop/') && existsSync(join(this.repo, 'desktop', 'dist', 'main.js'))) {
      // O binário do Electron de uma versão nova: o pnpm não roda o postinstall dele (fora do allowBuilds).
      if (deps) await step('desktop', 'node', ['desktop/node_modules/electron/install.js']);
      await step('desktop', 'pnpm', ['--filter', 'editr-desktop', 'run', 'build']);
    }
    this.built = head;
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
