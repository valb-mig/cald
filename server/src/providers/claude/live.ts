import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CLAUDE_BIN, CLAUDE_HOME, LIVE_FALLBACK_POLL_MS, childEnv } from './env.ts';
import { HttpError } from '../../errors.ts';
import type { ExternalSession, ExternalSessions } from '../types.ts';

const exec = promisify(execFile);

/** Linha de `claude agents --json` (formato documentado) com processo vivo. */
export type LiveSession = ExternalSession & {
  pid: number;
  /** Só sessões em background: id curto aceito por `claude stop`. */
  id?: string;
  state?: string;
};

/** Sessões que o próprio servidor sobe para tarefas avulsas (a mensagem do commit): não são conversas. */
export const hiddenSessions = new Set<string>();

export async function fetchLive(): Promise<LiveSession[]> {
  const { stdout } = await exec(CLAUDE_BIN, ['agents', '--json'], { timeout: 10_000, env: childEnv() });
  const rows = JSON.parse(stdout) as LiveSession[];
  const live = rows.filter((r) => r.pid && r.sessionId && r.status && !hiddenSessions.has(r.sessionId));
  // De onde cada uma é sai do registro do processo, o mesmo que o stopPcSession confere.
  return Promise.all(live.map(async (r) => ({ ...r, ...originOf(r, (await readRegistryEntry(r.pid))?.entrypoint) })));
}

/** O `entrypoint` do registro em nome de gente, e se dá para fechar lá e continuar aqui. */
function originOf(r: LiveSession, entrypoint: string | undefined): Pick<LiveSession, 'via' | 'takeover'> {
  const takeover = r.kind === 'background' ? Boolean(r.id) : TAKEOVER_ENTRYPOINTS.has(entrypoint ?? '');
  if (!entrypoint || entrypoint === 'cli') return { via: 'terminal', takeover };
  if (entrypoint.includes('vscode')) return { via: 'vscode', takeover };
  if (entrypoint.includes('desktop')) return { via: 'desktop', takeover };
  return { via: 'app', takeover };
}

/**
 * Espelho das sessões vivas no PC. A fonte de verdade é `claude agents --json`;
 * o diretório ~/.claude/sessions é observado apenas como gatilho para reconsultar.
 */
export class LiveRegistry extends EventEmitter implements ExternalSessions {
  private sessions = new Map<string, LiveSession>();
  private snapshot = '';
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private inflight?: Promise<void>;

  async start(): Promise<void> {
    await this.refresh();
    try {
      this.watcher = watch(join(CLAUDE_HOME, 'sessions'), () => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.refresh().catch(() => {}), 250);
      });
    } catch {
      // Sem o diretório, o polling de fallback continua funcionando.
    }
    const tick = () => {
      this.timer = setTimeout(() => void this.refresh().catch(() => {}).finally(tick), LIVE_FALLBACK_POLL_MS);
    };
    tick();
  }

  stop(): void {
    this.watcher?.close();
    clearTimeout(this.timer);
    clearTimeout(this.debounce);
  }

  /** Reconsulta agora; chamadas simultâneas compartilham a mesma execução. */
  refresh(): Promise<void> {
    this.inflight ??= fetchLive()
      .then((rows) => {
        const next = JSON.stringify(rows);
        this.sessions = new Map(rows.map((r) => [r.sessionId, r]));
        if (next !== this.snapshot) {
          this.snapshot = next;
          this.emit('change');
        }
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  get(sessionId: string): LiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  all(): LiveSession[] {
    return [...this.sessions.values()];
  }

  async close(session: ExternalSession): Promise<void> {
    const live = this.sessions.get(session.sessionId);
    if (!live) return;
    await stopPcSession(live);
  }
}

/** Campo 22 de /proc/<pid>/stat: instante de início do processo (ticks desde o boot). */
async function procStartOf(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

type RegistryEntry = { sessionId?: string; procStart?: string; entrypoint?: string };

// Arquivo interno do Claude Code; usado só para confirmar identidade antes de encerrar um processo.
async function readRegistryEntry(pid: number): Promise<RegistryEntry | null> {
  try {
    return JSON.parse(await readFile(join(CLAUDE_HOME, 'sessions', `${pid}.json`), 'utf8')) as RegistryEntry;
  } catch {
    return null;
  }
}

async function waitForExit(pid: number, procStart: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await procStartOf(pid)) !== procStart) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// Só TUIs de terminal: encerrar o processo da extensão do VSCode ou de outro host SDK
// pode fazê-lo reiniciar e retomar a mesma conversa, bifurcando-a.
const TAKEOVER_ENTRYPOINTS = new Set(['cli']);

/**
 * Encerra uma sessão viva no PC para que o painel possa retomá-la.
 * Recusa (fail-closed) se a sessão não estiver ociosa ou se a identidade do processo não bater.
 */
export async function stopPcSession(live: LiveSession): Promise<void> {
  if (live.status !== 'idle') {
    throw new HttpError(409, 'busy_on_pc', { status: live.status, waitingFor: live.waitingFor });
  }

  if (live.kind === 'background') {
    if (!live.id) throw new HttpError(409, 'background_without_id');
    const procStart = await procStartOf(live.pid);
    await exec(CLAUDE_BIN, ['stop', live.id], { timeout: 15_000, env: childEnv() });
    if (procStart && !(await waitForExit(live.pid, procStart, 10_000))) throw new HttpError(500, 'did_not_exit');
    return;
  }

  const entry = await readRegistryEntry(live.pid);
  if (!entry || entry.sessionId !== live.sessionId || !entry.procStart) {
    throw new HttpError(409, 'registry_mismatch');
  }
  if (!TAKEOVER_ENTRYPOINTS.has(entry.entrypoint ?? '')) {
    throw new HttpError(409, 'unsupported_entrypoint', { entrypoint: entry.entrypoint });
  }
  if ((await procStartOf(live.pid)) !== entry.procStart) {
    throw new HttpError(409, 'pid_mismatch');
  }

  process.kill(live.pid, 'SIGTERM');
  if (!(await waitForExit(live.pid, entry.procStart, 8_000))) throw new HttpError(500, 'did_not_exit');
}
