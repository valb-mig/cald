import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { FastifyRequest } from 'fastify';
import { MACHINE_NAME, ORIGINS_FILE } from './config.ts';
import type { Sent } from './events.ts';
import type { PromptMark } from './transcript.ts';

const exec = promisify(execFile);

/** O aparelho de onde saiu um pedido. */
export type Device = { name: string; mobile: boolean };

/** O próprio PC: pelo 127.0.0.1 ou pelos IPs dele na tailnet. */
export const HERE: Device = { name: MACHINE_NAME, mobile: false };
const MOBILE_OS = new Set(['android', 'iOS']);
// Aparelho que não estava no tailnet da última leitura (acabou de entrar): lê de novo, no máximo a cada 30 s.
const REREAD_MS = 30_000;

type Node = { DNSName?: string; HostName?: string; OS?: string; TailscaleIPs?: string[] };

/** O IP do aparelho na tailnet, que o `tailscale serve` repassa; vazio quando o pedido veio do próprio PC. */
export function ipOf(req: FastifyRequest): string {
  return String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() ?? '';
}

/**
 * Quem fez cada pedido. O `tailscale serve` repassa o IP do aparelho no `X-Forwarded-For`, e o
 * `tailscale status` dá o nome e o sistema de cada IP do tailnet. Sem o cabeçalho, o pedido veio do
 * próprio PC (127.0.0.1).
 */
export class DeviceDirectory {
  private byIp = new Map<string, Device>();
  private readAt = 0;
  private running: Promise<void> | null = null;

  /** `undefined`: veio pelo tailnet de um IP que o Tailscale não conhece. */
  async of(req: FastifyRequest): Promise<Device | undefined> {
    const ip = ipOf(req);
    if (!ip) return HERE;
    if (!this.byIp.has(ip) && Date.now() - this.readAt > REREAD_MS) await this.read();
    return this.byIp.get(ip);
  }

  private read(): Promise<void> {
    this.running ??= (async () => {
      try {
        const { stdout } = await exec('tailscale', ['status', '--json'], { timeout: 5_000 });
        const status = JSON.parse(stdout) as { Self?: Node; Peer?: Record<string, Node> };
        const byIp = new Map<string, Device>();
        for (const ip of status.Self?.TailscaleIPs ?? []) byIp.set(ip, HERE);
        for (const p of Object.values(status.Peer ?? {})) {
          // O nome do MagicDNS é o que aparece no painel do Tailscale; o HostName de um Android costuma ser "localhost".
          const name = p.DNSName?.split('.')[0] || p.HostName;
          if (name) for (const ip of p.TailscaleIPs ?? []) byIp.set(ip, { name, mobile: MOBILE_OS.has(p.OS ?? '') });
        }
        this.byIp = byIp;
      } catch {
        // Tailscale fora do ar: o aparelho fica sem nome.
      } finally {
        this.readAt = Date.now();
        this.running = null;
      }
    })();
    return this.running;
  }
}

/** O que o cald guarda de cada mensagem mandada pelo app, pelo UUID dela no transcript. */
type Origin = { uuid: string; at: number; device?: string; mobile?: boolean };

// Quem gravou a mensagem, segundo o `entrypoint` do transcript. `sdk-ts` é o próprio cald (o Agent
// SDK), e `sdk-cli` é o `claude -p`, que se roda no terminal.
const VIA: Record<string, Sent['via']> = {
  cli: 'terminal',
  'sdk-cli': 'terminal',
  'claude-vscode': 'vscode',
  'claude-desktop': 'desktop',
  'sdk-ts': 'cald',
};

/**
 * De que aparelho saiu cada mensagem do app. O transcript do Claude Code tem a hora e o `entrypoint`,
 * que é o mesmo para qualquer aparelho que use o cald: o resto o cald guarda aqui, uma linha por
 * mensagem, pelo UUID que ele mesmo dá a ela (ver PanelSession.send).
 */
export class OriginLog {
  private byUuid = new Map<string, Origin>();

  async load(): Promise<void> {
    const text = await readFile(ORIGINS_FILE, 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const origin = JSON.parse(line) as Origin;
        if (typeof origin.uuid === 'string') this.byUuid.set(origin.uuid, origin);
      } catch {
        // Linha cortada (o PC desligou no meio da gravação): fica sem aparelho.
      }
    }
  }

  record(origin: Origin): void {
    this.byUuid.set(origin.uuid, origin);
    void appendFile(ORIGINS_FILE, `${JSON.stringify(origin)}\n`).catch(() => {});
  }

  /** Por onde, de onde e quando: o que o cald guardou ou, sem isso, o que o transcript diz. */
  sentOf(uuid: string, mark?: PromptMark): Sent | undefined {
    const own = this.byUuid.get(uuid);
    if (own) return { via: 'cald', device: own.device, mobile: own.mobile, at: own.at };
    if (!mark) return undefined;
    const via = mark.entrypoint ? VIA[mark.entrypoint] : undefined;
    // O terminal e o VSCode rodam aqui mesmo, no PC dono do transcript; do app, não se sabe qual aparelho foi.
    return { via, device: via && via !== 'cald' ? MACHINE_NAME : undefined, at: mark.at };
  }
}
