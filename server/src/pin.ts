import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { watchFile } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { STATE_DIR } from './config.ts';
import { HttpError } from './errors.ts';

/**
 * PIN do painel, por cima da identidade do Tailscale: protege do celular desbloqueado na mão de outra
 * pessoa (que segue na tailnet). O PIN é definido no PC (`editr -pin`, ver pin-cli.ts) e só o hash fica
 * aqui; acertar dá um token, que o guard (ver guard.ts) exige em toda rota da API e no WebSocket. Sem
 * arquivo de PIN, nada disso vale e o painel abre direto, como antes.
 */

export const PIN_FILE = process.env.PIN_FILE ?? join(STATE_DIR, 'pin.json');
const TOKENS_FILE = join(dirname(PIN_FILE), 'pin-tokens.json');

export const PIN_MIN = 4;
export const PIN_MAX = 8;

// Custo do scrypt: ~100 ms por tentativa, que somado à espera entre erros segura tentativa no chute.
const SCRYPT: ScryptOptions = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 32;

// O token cai depois de tanto tempo sem uso (pedido ou WebSocket aberto). O travamento fino, por
// inatividade, é o do app (ver web/src/lib/lock.ts); este é o limite para um token que vazou.
const IDLE_MS = 12 * 60 * 60 * 1000;
// Erros seguidos liberados antes de começar a espera, que dobra a cada erro a mais.
const FREE_TRIES = 5;
const BASE_WAIT_MS = 30_000;
const MAX_WAIT_MS = 15 * 60 * 1000;
// O último uso de cada token vai para o disco no máximo uma vez por minuto.
const SAVE_EVERY_MS = 60_000;

type PinFile = { salt: string; hash: string; length: number };

const derive = (pin: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => scrypt(pin, salt, KEY_LEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));

const digest = (token: string) => createHash('sha256').update(token).digest('base64url');

export const validPin = (pin: string) => new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin);

/** Grava o PIN novo (usado pela CLI). Trocar o PIN derruba todos os tokens: o servidor vê o arquivo mudar. */
export async function writePin(pin: string): Promise<void> {
  if (!validPin(pin)) throw new Error(`O PIN precisa ter de ${PIN_MIN} a ${PIN_MAX} dígitos.`);
  const salt = randomBytes(16);
  const hash = await derive(pin, salt);
  const data: PinFile = { salt: salt.toString('base64'), hash: hash.toString('base64'), length: pin.length };
  await mkdir(dirname(PIN_FILE), { recursive: true });
  const tmp = `${PIN_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await rename(tmp, PIN_FILE);
}

export async function removePin(): Promise<void> {
  await rm(PIN_FILE, { force: true });
}

async function readPin(): Promise<PinFile | null> {
  try {
    const data = JSON.parse(await readFile(PIN_FILE, 'utf8')) as Partial<PinFile>;
    if (typeof data.salt !== 'string' || typeof data.hash !== 'string' || typeof data.length !== 'number') return null;
    return { salt: data.salt, hash: data.hash, length: data.length };
  } catch {
    return null;
  }
}

/** Emite `revoke` quando tokens deixam de valer (travou, PIN trocado), para fechar os WebSockets deles. */
export class PinLock extends EventEmitter {
  private pin: PinFile | null = null;
  /** Hash do token → último uso. */
  private tokens = new Map<string, number>();
  private failures = 0;
  private blockedUntil = 0;
  private saveTimer: NodeJS.Timeout | undefined;
  private writing = Promise.resolve();

  async load(): Promise<void> {
    this.pin = await readPin();
    try {
      const data = JSON.parse(await readFile(TOKENS_FILE, 'utf8')) as Record<string, number>;
      const now = Date.now();
      for (const [hash, seen] of Object.entries(data)) if (typeof seen === 'number' && now - seen < IDLE_MS) this.tokens.set(hash, seen);
    } catch {
      // Primeiro uso: nenhum token.
    }
    // `editr -pin` grava o arquivo com o servidor rodando: vale na hora, sem reiniciar.
    watchFile(PIN_FILE, { interval: 2_000 }, () => void this.reload()).unref();
  }

  private async reload(): Promise<void> {
    const next = await readPin();
    if (next?.hash === this.pin?.hash) return;
    this.pin = next;
    this.failures = 0;
    this.blockedUntil = 0;
    this.revokeAll();
  }

  get enabled(): boolean {
    return this.pin !== null;
  }

  /** O que a tela de bloqueio precisa saber antes de pedir o PIN. */
  status(): { enabled: boolean; length?: number; retryAfter?: number } {
    if (!this.pin) return { enabled: false };
    const wait = this.blockedUntil - Date.now();
    return { enabled: true, length: this.pin.length, ...(wait > 0 ? { retryAfter: Math.ceil(wait / 1000) } : {}) };
  }

  /** Confere o PIN e devolve um token novo; errar demais faz esperar (429). */
  async unlock(pin: string): Promise<string> {
    if (!this.pin) throw new HttpError(409, 'pin_disabled');
    const wait = this.blockedUntil - Date.now();
    if (wait > 0) throw new HttpError(429, 'pin_blocked', { retryAfter: Math.ceil(wait / 1000) });
    const expected = Buffer.from(this.pin.hash, 'base64');
    const got = validPin(pin) ? await derive(pin, Buffer.from(this.pin.salt, 'base64')) : Buffer.alloc(expected.length);
    if (!validPin(pin) || !timingSafeEqual(got, expected)) {
      this.failures++;
      const over = this.failures - FREE_TRIES;
      if (over >= 0) {
        this.blockedUntil = Date.now() + Math.min(MAX_WAIT_MS, BASE_WAIT_MS * 2 ** over);
        throw new HttpError(429, 'pin_blocked', { retryAfter: Math.ceil((this.blockedUntil - Date.now()) / 1000) });
      }
      throw new HttpError(403, 'pin_wrong', { attemptsLeft: FREE_TRIES - this.failures });
    }
    this.failures = 0;
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(digest(token), Date.now());
    this.save();
    return token;
  }

  /** Token ainda vale? Conta como uso: renova o prazo. */
  check(token: string | undefined): boolean {
    if (!token) return false;
    const hash = digest(token);
    const seen = this.tokens.get(hash);
    if (seen === undefined) return false;
    const now = Date.now();
    if (now - seen > IDLE_MS) {
      this.tokens.delete(hash);
      this.save();
      return false;
    }
    this.tokens.set(hash, now);
    this.saveLater();
    return true;
  }

  /** O app travou: o token dele deixa de valer, aqui e nos WebSockets abertos com ele. */
  lock(token: string | undefined): void {
    if (!token || !this.tokens.delete(digest(token))) return;
    this.save();
    this.emit('revoke');
  }

  private revokeAll(): void {
    if (!this.tokens.size) return;
    this.tokens.clear();
    this.save();
    this.emit('revoke');
  }

  private saveLater(): void {
    this.saveTimer ??= setTimeout(() => this.save(), SAVE_EVERY_MS).unref();
  }

  private save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const data = JSON.stringify(Object.fromEntries(this.tokens));
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(TOKENS_FILE), { recursive: true });
        const tmp = `${TOKENS_FILE}.tmp`;
        await writeFile(tmp, data, { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, TOKENS_FILE);
      })
      .catch(() => {});
  }
}
