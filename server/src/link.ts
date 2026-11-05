import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { PORT, STATE_DIR } from './config.ts';
import { HttpError } from './errors.ts';

const exec = promisify(execFile);

/**
 * O link de acesso remoto: o `tailscale serve` que publica este servidor na tailnet. O painel
 * Computador confere o que falta para o celular chegar até aqui (Tailscale, MagicDNS, HTTPS, o
 * celular na tailnet), desliga o link e o religa como estava.
 */

/** O que o app mostra para ligar um celular (ver web/src/components/access-settings.tsx). */
export type LinkCheck = {
  tailscale: 'missing' | 'stopped' | 'running';
  /** O login do dono na tailnet: o celular entra no Tailscale com essa mesma conta. */
  login?: string;
  magicDns: boolean;
  https: boolean;
  published: boolean;
  /** O endereço que o celular abre; vem mesmo com o link desligado, se o Tailscale souber o nome. */
  url?: string;
  /** O atalho em http (`http://valb`), se publicado. */
  shortcut?: string;
  phones: { name: string; os: string; online: boolean }[];
};

/** Uma porta do `tailscale serve` que aponta para este servidor. */
type Published = { proto: 'https' | 'http'; port: number };

type Node = { DNSName?: string; HostName?: string; OS?: string; Online?: boolean; UserID?: number };
type Status = {
  BackendState?: string;
  CertDomains?: string[] | null;
  CurrentTailnet?: { MagicDNSEnabled?: boolean } | null;
  Self?: Node;
  Peer?: Record<string, Node> | null;
  User?: Record<string, { LoginName?: string }> | null;
};
type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
};

// O que estava publicado antes de desligar pelo app, para religar igual (uma instância de teste
// numa porta extra volta na dela, e não na 443 da instância principal).
const SAVED_FILE = join(STATE_DIR, `link-off-${PORT}.json`);
const MOBILE_OS = new Set(['android', 'iOS']);
const DEFAULT: Published[] = [
  { proto: 'https', port: 443 },
  { proto: 'http', port: 80 },
];
// A checagem roda a cada abertura da seção e a cada aparelho que entra ou sai: dois `tailscale` por vez no máximo.
const FRESH_MS = 5_000;

const TARGETS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

async function tailscale(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('tailscale', args, { timeout: 10_000 });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') throw new HttpError(503, 'tailscale_missing');
    const message = (e.stderr || e.message || '').trim();
    if (/denied|operator/i.test(message)) throw new HttpError(403, 'serve_denied', { message });
    throw new HttpError(502, 'serve_failed', { message });
  }
}

/** As portas do `tailscale serve` que levam a este servidor, e as que levam a outra coisa. */
function ownPorts(config: ServeConfig): { own: Published[]; busy: Set<number> } {
  const own: Published[] = [];
  const busy = new Set<number>();
  for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
    const port = Number(hostPort.split(':').at(-1));
    if (!port) continue;
    const proxies = Object.values(web.Handlers ?? {}).map((h) => h.Proxy?.replace(/\/$/, ''));
    if (!proxies.some((p) => p && TARGETS.has(p))) {
      busy.add(port);
      continue;
    }
    own.push({ proto: config.TCP?.[String(port)]?.HTTPS ? 'https' : 'http', port });
  }
  return { own, busy };
}

export class RemoteLink {
  private cached: { at: number; check: LinkCheck } | null = null;
  private running: Promise<LinkCheck> | null = null;

  /** Como está o link agora (com cache curto: os aparelhos entrando e saindo pedem de novo). */
  check(fresh = false): Promise<LinkCheck> {
    if (!fresh && this.cached && Date.now() - this.cached.at < FRESH_MS) return Promise.resolve(this.cached.check);
    this.running ??= this.read()
      .then((check) => {
        this.cached = { at: Date.now(), check };
        return check;
      })
      .finally(() => (this.running = null));
    return this.running;
  }

  private async read(): Promise<LinkCheck> {
    let status: Status;
    try {
      status = JSON.parse(await tailscale(['status', '--json'])) as Status;
    } catch (err) {
      const missing = err instanceof HttpError && err.code === 'tailscale_missing';
      return { tailscale: missing ? 'missing' : 'stopped', magicDns: false, https: false, published: false, phones: [] };
    }
    const self = status.Self;
    const host = self?.DNSName?.replace(/\.$/, '');
    const login = status.User?.[String(self?.UserID)]?.LoginName;
    const phones = Object.values(status.Peer ?? {}).flatMap((p) =>
      p.UserID === self?.UserID && MOBILE_OS.has(p.OS ?? '')
        ? [{ name: p.DNSName?.split('.')[0] || p.HostName || '?', os: p.OS ?? '', online: Boolean(p.Online) }]
        : [],
    );
    const base: LinkCheck = {
      tailscale: status.BackendState === 'Running' ? 'running' : 'stopped',
      login,
      magicDns: Boolean(status.CurrentTailnet?.MagicDNSEnabled),
      https: Boolean(status.CertDomains?.length),
      published: false,
      phones,
    };
    if (base.tailscale !== 'running') return base;

    // Sem ler o `serve` (o Tailscale ainda subindo), o resto da checagem vale do mesmo jeito.
    const { own } = ownPorts(await this.serveConfig().catch(() => ({})));
    const secure = own.find((p) => p.proto === 'https');
    const plain = own.find((p) => p.proto === 'http' && p.port === 80);
    // Desligado, o endereço é o que vai voltar ao religar (o guardado, ou o padrão na 443).
    const port = secure?.port ?? (await this.saved())?.find((p) => p.proto === 'https')?.port ?? 443;
    return {
      ...base,
      published: Boolean(secure),
      url: host ? `https://${host}${port === 443 ? '' : `:${port}`}` : undefined,
      shortcut: plain && host ? `http://${host.split('.')[0]}` : undefined,
    };
  }

  private async serveConfig(): Promise<ServeConfig> {
    const text = await tailscale(['serve', 'status', '--json']);
    return text.trim() ? (JSON.parse(text) as ServeConfig) : {};
  }

  private async saved(): Promise<Published[] | null> {
    try {
      const list = JSON.parse(await readFile(SAVED_FILE, 'utf8')) as Published[];
      return Array.isArray(list) && list.length ? list : null;
    } catch {
      return null;
    }
  }

  /** Tira este servidor da tailnet: só as portas que levam a ele, guardadas para religar igual. */
  async off(): Promise<void> {
    const { own } = ownPorts(await this.serveConfig());
    if (own.length) {
      await mkdir(dirname(SAVED_FILE), { recursive: true });
      await writeFile(SAVED_FILE, JSON.stringify(own));
    }
    for (const p of own) await tailscale(['serve', `--${p.proto}=${p.port}`, 'off']);
    this.cached = null;
  }

  /** Publica de novo como estava (ou na 443 e no atalho da 80), sem tomar porta de outro serviço. */
  async on(): Promise<void> {
    const { own, busy } = ownPorts(await this.serveConfig());
    const wanted = ((await this.saved()) ?? DEFAULT).filter((p) => !own.some((o) => o.port === p.port));
    const secure = wanted.find((p) => p.proto === 'https');
    if (secure && busy.has(secure.port)) throw new HttpError(409, 'port_busy', { port: secure.port });
    for (const p of wanted) {
      // O atalho em http é um extra: com a 80 ocupada por outro serviço, fica sem ele.
      if (busy.has(p.port)) continue;
      await tailscale(['serve', '--bg', `--${p.proto}=${p.port}`, `http://127.0.0.1:${PORT}`]);
    }
    await rm(SAVED_FILE, { force: true });
    this.cached = null;
  }
}
