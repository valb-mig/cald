import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * O sharp das miniaturas (ver thumbs.ts) e das marcas dos projetos (ver project-icon.ts): lê a imagem
 * e devolve um WebP. No app do PC em Linux, o servidor roda no Node do Electron, e o sharp ali dentro
 * derruba o processo de tempos em tempos (o Electron traz a glib dele para o processo, e as duas se
 * atropelam; ver https://sharp.pixelplumbing.com/install#electron-and-linux), levando junto o chat e
 * as conversas. Ali, então, ele roda num processo à parte (ver sharp-worker.ts): no Node do sistema,
 * se houver um que rode o worker, senão no do próprio Electron, onde uma queda perde só aquela imagem.
 */

export type WebpJob = {
  width: number;
  height: number;
  /** `inside`: cabe no quadro sem cortar; `contain`: ocupa o quadro, com fundo transparente no que sobra. */
  fit: 'inside' | 'contain';
  withoutEnlargement?: boolean;
  /** Densidade em que um SVG é desenhado. */
  density?: number;
  quality: number;
};

type Sharp = typeof import('sharp').default;

export function render(sharp: Sharp, input: Buffer, job: WebpJob): Promise<Buffer> {
  return sharp(input, job.density ? { density: job.density } : undefined)
    .resize(job.width, job.height, {
      fit: job.fit,
      withoutEnlargement: job.withoutEnlargement,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: job.quality })
    .toBuffer();
}

const ISOLATED = Boolean(process.versions.electron) && process.platform === 'linux';

// Sob demanda; sem o binário do sharp para esta máquina, não há conversão.
let loading: Promise<Sharp | null> | undefined;
const loadSharp = () => (loading ??= import('sharp').then((m) => m.default, () => null));

/**
 * A imagem em WebP; `null` sem o sharp nesta máquina. Rejeita quando ela não é uma imagem que o sharp
 * leia (ou quando o processo à parte cai no meio).
 */
export async function toWebp(input: Buffer, job: WebpJob): Promise<Buffer | null> {
  if (!ISOLATED) {
    const sharp = await loadSharp();
    return sharp && render(sharp, input, job);
  }
  if (broken) return null;
  const worker = await (starting ??= start());
  if (worker === 'unavailable') return null;
  return worker.run(input, job);
}

const WORKER = fileURLToPath(new URL('./sharp-worker.ts', import.meta.url));
// Parado à toa por um minuto, o processo sai; a próxima imagem sobe outro.
const IDLE_MS = 60_000;
// Uma imagem que não volta nesse tempo travou o processo: ele sai, e a próxima sobe outro.
const JOB_TIMEOUT_MS = 30_000;

/** Respostas do worker: a primeira diz se ele achou o sharp; as outras, o resultado de cada imagem. */
type Reply = { ready: true; available: boolean } | { id: number; data?: string; error?: string };

let starting: Promise<Worker | 'unavailable'> | undefined;
// O worker no Node do Electron caiu: ali o sharp tende a cair de novo a cada imagem, e cada queda deixa
// um core dump. Até o servidor reiniciar, fica sem conversão, como numa máquina sem o sharp.
let broken = false;
const CRASHES = new Set(['SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGABRT', 'SIGFPE']);

/** Sobe o worker no Node do sistema e, se ele não rodar ali (não há, ou é antigo demais), no do Electron. */
async function start(): Promise<Worker | 'unavailable'> {
  const system = await spawn('node', {});
  const child = system ?? (await spawn(process.execPath, { ELECTRON_RUN_AS_NODE: '1' }));
  if (!child) {
    starting = undefined;
    throw new Error('sharp_worker_failed');
  }
  if (child === 'unavailable') return child;
  child.once('exit', (_code, signal) => {
    starting = undefined;
    if (!system && signal && CRASHES.has(signal)) broken = true;
  });
  return new Worker(child);
}

/** O worker de pé e pronto; `null` se ele não chegou a subir. */
function spawn(execPath: string, env: Record<string, string>): Promise<ChildProcess | 'unavailable' | null> {
  return new Promise((resolve) => {
    // As mensagens vão em JSON, com as imagens em base64: o Node do sistema e o do Electron podem ter
    // V8 de versões diferentes, e a serialização "advanced" é a do V8.
    const child = fork(WORKER, [], { execPath, execArgv: [], env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const fail = () => resolve(null);
    child.once('error', fail);
    child.once('exit', fail);
    child.once('message', (msg: Reply) => {
      child.off('error', fail);
      child.off('exit', fail);
      if ('ready' in msg && msg.available) return resolve(child);
      child.kill();
      resolve('unavailable');
    });
  });
}

class Worker {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (data: Buffer) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  private idle?: NodeJS.Timeout;

  constructor(child: ChildProcess) {
    this.child = child;
    child.on('message', (msg: Reply) => {
      if (!('id' in msg)) return;
      const job = this.pending.get(msg.id);
      if (!job) return;
      this.settle(msg.id);
      if (msg.data !== undefined) job.resolve(Buffer.from(msg.data, 'base64'));
      else job.reject(new Error(msg.error ?? 'sharp_failed'));
    });
    child.on('exit', () => {
      clearTimeout(this.idle);
      for (const [id, job] of this.pending) {
        clearTimeout(job.timer);
        this.pending.delete(id);
        job.reject(new Error('sharp_worker_exit'));
      }
    });
    // Erro no canal (o processo já saiu): o `exit` resolve o que ficou pendente.
    child.on('error', () => {});
    this.rest();
  }

  run(input: Buffer, job: WebpJob): Promise<Buffer> {
    clearTimeout(this.idle);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.child.kill('SIGKILL'), JOB_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, input: input.toString('base64'), job });
    });
  }

  private settle(id: number): void {
    clearTimeout(this.pending.get(id)?.timer);
    this.pending.delete(id);
    if (!this.pending.size) this.rest();
  }

  /** Sem imagem na fila: o processo sai se ficar à toa, sem segurar o servidor aberto. */
  private rest(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.child.kill(), IDLE_MS);
  }
}
