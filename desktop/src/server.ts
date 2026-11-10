import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { BASE, PACKAGED, PORT, SERVER_ENTRY, SERVER_LOG, WEB_DIST } from './paths.ts';

const execFileAsync = promisify(execFile);

/** `own`: o servidor é deste app; `attached`: outro já respondia na porta (o serviço do systemd, por exemplo). */
export type ServerMode = 'own' | 'attached';

const CHECK_EVERY_MS = 5_000;
const START_TIMEOUT_MS = 30_000;
// Como o `TimeoutStopSec` do serviço: o servidor encerra as conversas do painel com calma.
const STOP_TIMEOUT_MS = 20_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
// O serviço de uma instalação pelo git (ver deploy/editr.service).
const SERVICE = 'editr.service';
// De pé, voltando de um reinício (o `auto-restart` do `RestartSec` conta como `activating`) ou
// encerrando: em nenhum desses a porta fica livre para um servidor deste app.
const SERVICE_UP = new Set(['active', 'activating', 'deactivating', 'reloading']);

/** O servidor responde na porta, e é um edit.r. */
export async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1_500) });
    return res.ok && Boolean(((await res.json()) as { ok?: boolean }).ok);
  } catch {
    return false;
  }
}

/**
 * O serviço do systemd cuida desta porta e está de pé ou voltando. No reinício da atualização ele
 * fica uns segundos fora do ar; um servidor deste app que pegasse a porta nesse meio o deixaria preso
 * em `EADDRINUSE`, com dois edit.r de versões diferentes se revezando no celular.
 */
async function serviceHoldsPort(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['--user', 'show', SERVICE, '--property=LoadState,ActiveState,Environment'], {
      timeout: 2_000,
    });
    const props = Object.fromEntries(stdout.trim().split('\n').map((line) => line.split(/=(.*)/s, 2)));
    if (props.LoadState !== 'loaded' || !SERVICE_UP.has(props.ActiveState)) return false;
    // Sem `PORT=` no serviço, ele usa a de sempre (ver server/src/config.ts).
    const port = /(?:^|[\s"])PORT=(\d+)/.exec(props.Environment ?? '')?.[1];
    return Number(port ?? 7337) === PORT;
  } catch {
    // Sem o systemd: só conta o que responde na porta.
    return false;
  }
}

/**
 * O servidor do app: se já há um edit.r na porta (o serviço de uma instalação pelo git), o app só
 * abre a janela nele; senão, sobe o que vem junto, no Node do próprio Electron. Como o systemd com
 * `Restart=on-failure`, sobe de novo quando ele sai (o reinício da atualização sai de propósito) e,
 * se o de fora some, assume a porta; o serviço voltando de um reinício, ele só espera.
 */
export class ServerSupervisor extends EventEmitter {
  mode: ServerMode | null = null;
  private readonly env: Record<string, string>;
  private readonly spawns: boolean;
  private child: ChildProcess | null = null;
  private timer?: NodeJS.Timeout;
  private checking = false;
  private stopping = false;

  /**
   * @param env o ambiente do servidor: o do seu shell de login (ver shell-env.ts).
   * @param spawns `false`: só abre a janela no que já responde na porta (o app de teste de uma branch,
   * cujo servidor é a instância de teste; um deste app pegaria os seus dados de verdade).
   */
  constructor(env: Record<string, string>, spawns = true) {
    super();
    this.env = env;
    this.spawns = spawns;
  }

  get owns(): boolean {
    return this.child !== null;
  }

  /** Acha ou sobe o servidor e espera ele responder. */
  async start(): Promise<void> {
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    await this.check();
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await healthy()) return;
      await sleep(250);
    }
    throw new Error(`O servidor não respondeu em ${START_TIMEOUT_MS / 1000} s. Veja ${SERVER_LOG}.`);
  }

  private async check(): Promise<void> {
    if (this.stopping || this.checking || this.child) return;
    this.checking = true;
    try {
      if ((await healthy()) || (await serviceHoldsPort())) this.setMode('attached');
      else if (this.spawns) this.spawn();
    } finally {
      this.checking = false;
    }
  }

  private setMode(mode: ServerMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit('mode', mode);
  }

  private spawn(): void {
    // A saída vai direto para o arquivo, sem passar por este processo: se o app cair, o servidor
    // segue de pé (e o app aberto de novo só o encontra na porta).
    const log = openLog();
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: dirname(dirname(SERVER_ENTRY)),
      env: {
        ...this.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(PORT),
        WEB_DIST,
        EDITR_SUPERVISOR: 'desktop',
        ...(PACKAGED ? { EDITR_PACKAGED: '1' } : {}),
      },
      stdio: ['ignore', log, log],
    });
    closeSync(log);
    this.child = child;
    this.setMode('own');
    child.once('exit', (code, signal) => {
      this.child = null;
      this.emit('exit', code, signal);
      // Um instante, como o `RestartSec` do serviço; se outro pegou a porta, vira `attached`.
      if (!this.stopping) setTimeout(() => void this.check(), 1_000);
    });
    child.once('error', (err) => this.emit('error', err));
  }

  /** Encerra o servidor deste app (o de fora fica como está). */
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    const child = this.child;
    if (!child) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const done = await Promise.race([exited.then(() => true), sleep(STOP_TIMEOUT_MS).then(() => false)]);
    if (!done) child.kill('SIGKILL');
  }
}

/** O log do servidor, com o anterior guardado ao lado quando passa de 5 MB. */
function openLog(): number {
  mkdirSync(dirname(SERVER_LOG), { recursive: true });
  try {
    if (statSync(SERVER_LOG).size > LOG_MAX_BYTES) renameSync(SERVER_LOG, `${SERVER_LOG}.1`);
  } catch {
    // Ainda não existe.
  }
  return openSync(SERVER_LOG, 'a');
}
