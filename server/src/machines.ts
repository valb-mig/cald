import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EXTRA_MACHINES } from './config.ts';
import type { AccessPolicy } from './guard.ts';

const exec = promisify(execFile);

/** Outra máquina sua com o cald: o app do celular fala direto com ela. */
export type Machine = { id: string; name: string; base: string };

type Node = { DNSName?: string; HostName?: string; UserID?: number; Online?: boolean };

/** Máquinas do mesmo dono no Tailscale, fora esta. */
async function tailnetPeers(): Promise<{ host: string; name: string; online: boolean }[]> {
  try {
    const { stdout } = await exec('tailscale', ['status', '--json'], { timeout: 5_000 });
    const status = JSON.parse(stdout) as { Self?: Node; Peer?: Record<string, Node> };
    const owner = status.Self?.UserID;
    return Object.values(status.Peer ?? {}).flatMap((p) =>
      p.UserID === owner && p.DNSName
        ? [{ host: p.DNSName.replace(/\.$/, ''), name: p.HostName ?? p.DNSName, online: Boolean(p.Online) }]
        : [],
    );
  } catch {
    return [];
  }
}

/** Nome da máquina se ela responde como cald; `null` se não (desligada, outro serviço, celular). */
async function probe(base: string): Promise<{ name?: string } | null> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; name?: string };
    return body.ok ? { name: body.name } : null;
  } catch {
    return null;
  }
}

const FRESH_MS = 60_000;
// Nenhuma achada (ex.: as duas máquinas ligando juntas): tenta de novo mais cedo.
const EMPTY_FRESH_MS = 15_000;

/**
 * Outras máquinas suas no Tailscale com o cald, para o app juntar as conversas de todas.
 * Também libera, no guard, o app servido por qualquer máquina sua (ver guard.ts).
 */
export class MachineDirectory {
  private machines: Machine[] = [];
  private checkedAt = 0;
  private running: Promise<void> | null = null;

  private policy: AccessPolicy;

  constructor(policy: AccessPolicy) {
    this.policy = policy;
  }

  /** As que responderam na última busca; refaz se ela tiver mais de 1 min (15 s, se não achou nenhuma). */
  async list(): Promise<Machine[]> {
    if (Date.now() - this.checkedAt > (this.machines.length ? FRESH_MS : EMPTY_FRESH_MS)) await this.refresh();
    return this.machines;
  }

  /** Endereços das outras máquinas, sem esperar uma busca nova (repasse de avisos, ver push.ts). */
  bases(): string[] {
    return this.machines.map((m) => m.base);
  }

  refresh(): Promise<void> {
    this.running ??= this.search().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async search(): Promise<void> {
    const peers = await tailnetPeers();
    // Todas as máquinas do dono, mesmo desligadas: o app instalado a partir de uma delas segue
    // falando com as outras quando ela está fora do ar.
    for (const p of peers) this.policy.origins.add(`https://${p.host}`);
    const candidates = [
      ...peers.filter((p) => p.online).map((p) => ({ id: p.host, name: p.name, base: `https://${p.host}` })),
      ...EXTRA_MACHINES.map((base) => ({ id: new URL(base).host, name: new URL(base).host, base })),
    ];
    const found = await Promise.all(
      candidates.map(async (c) => {
        const health = await probe(c.base);
        return health ? { id: c.id, name: health.name ?? c.name, base: c.base } : null;
      }),
    );
    this.machines = found.filter((m): m is Machine => m !== null);
    this.checkedAt = Date.now();
  }
}
