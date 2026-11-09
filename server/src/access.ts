import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { ACCESS_FILE } from './config.ts';
import { HttpError } from './errors.ts';
import { HERE, ipOf, type DeviceDirectory } from './origins.ts';

/**
 * Quem usa o painel: os aparelhos com o app aberto agora (um WebSocket `/ws` por janela), os que já
 * passaram por aqui, as tentativas barradas e os aparelhos que você desconectou, que ficam de fora até
 * você liberar. Aparelho novo e tentativa barrada viram aviso no celular (ver index.ts).
 */

export type AccessEventKind =
  | 'new_device'
  | 'connect'
  | 'denied_login'
  | 'pin_wrong'
  | 'pin_blocked'
  | 'kicked'
  | 'unblocked'
  | 'link_off'
  | 'link_on';

export type AccessEvent = {
  at: number;
  kind: AccessEventKind;
  /** O aparelho: o IP dele na tailnet, ou `local` (o próprio PC). */
  key?: string;
  name?: string;
  mobile?: boolean;
  /** Em `denied_login`: a conta do Tailscale que tentou. */
  login?: string;
  /** Repetições juntadas (o PIN errado três vezes em poucos minutos). */
  count?: number;
};

export type AccessBlocked = { key: string; name: string; mobile: boolean; at: number };

export type AccessConnection = {
  key: string;
  name: string;
  mobile: boolean;
  local: boolean;
  /** O aparelho que pediu a lista. */
  self: boolean;
  since: number;
  /** Janelas do app abertas nele. */
  tabs: number;
  client?: string;
  login?: string;
};

/** Uma janela do app aberta. */
type Visit = { key: string; name: string; mobile: boolean; local: boolean; since: number; client?: string; login?: string };

type Known = { name: string; mobile: boolean; firstAt: number; lastAt: number };

type AccessFile = { known: Record<string, Known>; events: AccessEvent[]; blocked: Record<string, AccessBlocked> };

export const LOCAL = 'local';
const MAX_EVENTS = 100;
// O mesmo acontecimento do mesmo aparelho logo em seguida vira um só (a tela de bloqueio errando o PIN, o app de outra conta tentando de novo).
const MERGE_MS = 10 * 60_000;
// Voltar antes disso (a rede piscou, o app foi para o fundo) não conta como acesso novo.
const RETURN_MS = 15 * 60_000;
// Aparelho entrando ou saindo: os outros recarregam a lista uma vez só, juntando o que veio junto.
const CHANGE_DELAY_MS = 500;
const SAVE_DELAY_MS = 5_000;

/** O aparelho do pedido: o IP na tailnet ou, sem ele, o próprio PC. */
export const keyOf = (req: FastifyRequest): string => ipOf(req) || LOCAL;

/** "Chrome · Android", pelo User-Agent: o bastante para separar o app do celular do navegador do PC. */
function clientOf(ua: string): string | undefined {
  const browser = /Edg(A|iOS)?\//.test(ua)
    ? 'Edge'
    : /Firefox\/|FxiOS/.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS/.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : undefined;
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : undefined;
  return [browser, os].filter(Boolean).join(' · ') || undefined;
}

/**
 * Emite `change` quando algo da lista muda (para os aparelhos recarregarem) e `alert` com título e
 * texto quando vale um aviso no celular: um aparelho que nunca entrou ou uma tentativa barrada.
 */
export class AccessMonitor extends EventEmitter {
  private visits = new Map<WebSocket, Visit>();
  private data: AccessFile = { known: {}, events: [], blocked: {} };
  private devices: DeviceDirectory;
  private changeTimer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private writing = Promise.resolve();

  constructor(devices: DeviceDirectory) {
    super();
    this.devices = devices;
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(ACCESS_FILE, 'utf8')) as Partial<AccessFile>;
      this.data = {
        known: saved.known ?? {},
        events: Array.isArray(saved.events) ? saved.events.slice(0, MAX_EVENTS) : [],
        blocked: saved.blocked ?? {},
      };
    } catch {
      // Primeiro uso: ninguém passou por aqui ainda.
    }
  }

  /** Desconectado por você: nem a API nem o WebSocket atendem até liberar. O próprio PC nunca. */
  isBlocked(req: FastifyRequest): boolean {
    const key = keyOf(req);
    return key !== LOCAL && key in this.data.blocked;
  }

  /** Abriu o app (o WebSocket do painel): entra na lista de agora até a janela fechar. */
  async open(socket: WebSocket, req: FastifyRequest): Promise<void> {
    const key = keyOf(req);
    const device = await this.devices.of(req);
    if (socket.readyState !== socket.OPEN) return;
    const local = key === LOCAL || device === HERE;
    const login = String(req.headers['tailscale-user-login'] ?? '') || undefined;
    const ua = String(req.headers['user-agent'] ?? '');
    const visit: Visit = {
      key,
      name: device?.name ?? key,
      // Fora do `tailscale status` (acabou de entrar), o navegador diz se é celular.
      mobile: device?.mobile ?? /Android|iPhone|iPad/.test(ua),
      local,
      since: Date.now(),
      client: clientOf(ua),
      login,
    };
    const here = [...this.visits.values()].some((v) => v.key === key);
    this.visits.set(socket, visit);
    socket.once('close', () => this.close(socket));

    if (!local) {
      const known = this.data.known[key];
      const now = Date.now();
      if (!known) {
        this.note({ kind: 'new_device', key, name: visit.name, mobile: visit.mobile });
        this.emit('alert', 'Aparelho novo no edit.r', `${visit.name} abriu o painel pela primeira vez.`);
      } else if (!here && now - known.lastAt > RETURN_MS) {
        this.note({ kind: 'connect', key, name: visit.name, mobile: visit.mobile });
      }
      this.data.known[key] = { name: visit.name, mobile: visit.mobile, firstAt: known?.firstAt ?? now, lastAt: now };
      this.saveLater();
    }
    this.changed();
  }

  private close(socket: WebSocket): void {
    const visit = this.visits.get(socket);
    if (!visit) return;
    this.visits.delete(socket);
    const known = this.data.known[visit.key];
    if (known) {
      known.lastAt = Date.now();
      this.saveLater();
    }
    this.changed();
  }

  /** Barrado no guard: a conta do Tailscale não é a do dono. */
  async deniedLogin(req: FastifyRequest): Promise<void> {
    const key = keyOf(req);
    const device = await this.devices.of(req);
    const login = String(req.headers['tailscale-user-login'] ?? '') || undefined;
    const fresh = this.note({ kind: 'denied_login', key, name: device?.name ?? key, mobile: device?.mobile, login }, false);
    if (fresh) this.emit('alert', 'Acesso barrado no edit.r', `${login ?? 'Uma conta sem login'} tentou abrir o painel${device ? ` de ${device.name}` : ''}.`);
  }

  /** PIN errado na tela de bloqueio; `blocked`: errou tanto que o servidor passou a fazer esperar. */
  async pinFailed(req: FastifyRequest, blocked: boolean): Promise<void> {
    const key = keyOf(req);
    const device = await this.devices.of(req);
    const name = device?.name ?? key;
    const fresh = this.note({ kind: blocked ? 'pin_blocked' : 'pin_wrong', key, name, mobile: device?.mobile });
    if (blocked && fresh) this.emit('alert', 'PIN errado demais no edit.r', `Erraram o PIN várias vezes em ${name}. O painel está fazendo esperar.`);
  }

  /** Ligou ou desligou o link remoto (ver link.ts), de que aparelho. */
  async linkToggled(req: FastifyRequest, on: boolean): Promise<void> {
    const device = await this.devices.of(req);
    this.note({ kind: on ? 'link_on' : 'link_off', key: keyOf(req), name: device?.name, mobile: device?.mobile }, false);
  }

  /**
   * Desconecta e bloqueia um aparelho; quem chama fecha os WebSockets dele (os do painel, do terminal
   * e do editor). Não vale para o próprio PC nem para quem pede, que perderia o acesso pelo próprio botão.
   */
  kick(key: string, req: FastifyRequest): void {
    if (key === LOCAL) throw new HttpError(409, 'cannot_kick_local');
    if (key === keyOf(req)) throw new HttpError(409, 'cannot_kick_self');
    const visit = [...this.visits.values()].find((v) => v.key === key);
    const known = this.data.known[key];
    if (visit?.local) throw new HttpError(409, 'cannot_kick_local');
    if (!visit && !known) throw new HttpError(404, 'device_not_found');
    const name = visit?.name ?? known!.name;
    const mobile = visit?.mobile ?? known!.mobile;
    this.data.blocked[key] = { key, name, mobile, at: Date.now() };
    this.note({ kind: 'kicked', key, name, mobile }, false);
  }

  unblock(key: string): void {
    const blocked = this.data.blocked[key];
    if (!blocked) throw new HttpError(404, 'device_not_found');
    delete this.data.blocked[key];
    this.note({ kind: 'unblocked', key, name: blocked.name, mobile: blocked.mobile }, false);
  }

  /** O que a seção Acesso mostra, do ponto de vista de quem pede. */
  list(req: FastifyRequest): { connected: AccessConnection[]; events: AccessEvent[]; blocked: AccessBlocked[] } {
    const me = keyOf(req);
    const byKey = new Map<string, AccessConnection>();
    for (const v of this.visits.values()) {
      const current = byKey.get(v.key);
      if (current) {
        current.tabs++;
        current.since = Math.min(current.since, v.since);
        continue;
      }
      byKey.set(v.key, { key: v.key, name: v.name, mobile: v.mobile, local: v.local, self: v.key === me, since: v.since, tabs: 1, client: v.client, login: v.login });
    }
    return {
      connected: [...byKey.values()].sort((a, b) => Number(b.self) - Number(a.self) || a.since - b.since),
      events: this.data.events,
      blocked: Object.values(this.data.blocked).sort((a, b) => b.at - a.at),
    };
  }

  /**
   * Guarda um acontecimento, do mais novo para o mais antigo. O mesmo, do mesmo aparelho, há pouco
   * tempo, só atualiza a hora (e a conta, se `counted`). Devolve se entrou um novo.
   */
  private note(event: Omit<AccessEvent, 'at'>, counted = true): boolean {
    const now = Date.now();
    const last = this.data.events.find((e) => e.kind === event.kind && e.key === event.key && e.login === event.login);
    if (last && now - last.at < MERGE_MS && event.kind !== 'link_off' && event.kind !== 'link_on') {
      last.at = now;
      if (counted) last.count = (last.count ?? 1) + 1;
      this.data.events = [last, ...this.data.events.filter((e) => e !== last)];
      // Uma conta barrada carregando o app repete a cada arquivo: grava junto, mais tarde.
      this.saveLater();
      this.changed();
      return false;
    }
    this.data.events = [{ ...event, at: now }, ...this.data.events].slice(0, MAX_EVENTS);
    this.save();
    this.changed();
    return true;
  }

  private changed(): void {
    this.changeTimer ??= setTimeout(() => {
      this.changeTimer = undefined;
      this.emit('change');
    }, CHANGE_DELAY_MS).unref();
  }

  private saveLater(): void {
    this.saveTimer ??= setTimeout(() => this.save(), SAVE_DELAY_MS).unref();
  }

  private save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const data = JSON.stringify(this.data);
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(ACCESS_FILE), { recursive: true });
        const tmp = `${ACCESS_FILE}.tmp`;
        await writeFile(tmp, data, { mode: 0o600 });
        await rename(tmp, ACCESS_FILE);
      })
      .catch(() => {});
  }
}
