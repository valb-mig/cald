import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AccessMonitor } from './access.ts';
import { ALLOWED_LOGINS, EXTRA_ORIGINS, PORT } from './config.ts';
import type { PinLock } from './pin.ts';
import { ARTEFATO_VIEW_ROUTE } from './artefatos.ts';
import { VIEW_ROUTE } from './prototypes.ts';

const exec = promisify(execFile);

export type AccessPolicy = {
  localHosts: Set<string>;
  tailnetHost?: string;
  origins: Set<string>;
  logins: Set<string>;
};

/** Monta a política; o lado Tailscale pode ficar vazio até `refreshTailnet` conseguir ler o nó. */
export async function loadAccessPolicy(): Promise<AccessPolicy> {
  const localHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  const policy: AccessPolicy = {
    localHosts,
    origins: new Set([...localHosts].map((h) => `http://${h}`).concat(EXTRA_ORIGINS)),
    logins: new Set(ALLOWED_LOGINS),
  };
  await refreshTailnet(policy);
  return policy;
}

/**
 * Lê o nome MagicDNS e o login do dono deste nó. Retorna false enquanto o Tailscale
 * não responde (ex.: logo após o boot); até lá só o acesso local funciona.
 */
export async function refreshTailnet(policy: AccessPolicy): Promise<boolean> {
  try {
    const { stdout } = await exec('tailscale', ['status', '--json'], { timeout: 5_000 });
    const status = JSON.parse(stdout) as {
      Self?: { DNSName?: string; UserID?: number };
      User?: Record<string, { LoginName?: string }>;
    };
    const host = status.Self?.DNSName?.replace(/\.$/, '');
    const owner = status.User?.[String(status.Self?.UserID)]?.LoginName;
    if (!host || !owner) return false;
    policy.tailnetHost = host;
    policy.origins.add(`https://${host}`);
    if (ALLOWED_LOGINS.length === 0) policy.logins.add(owner);
    return true;
  } catch {
    return false;
  }
}

/**
 * Origem conhecida. Numa porta HTTPS extra do `tailscale serve` (ex.: uma instância de teste em
 * :10000), o navegador manda a porta na origem — o app busca os próprios arquivos com `crossorigin`
 * —, enquanto as origens guardadas não têm porta. O Host já é comparado assim (ver `accessGuard`).
 */
function knownOrigin(policy: AccessPolicy, origin: string): boolean {
  if (policy.origins.has(origin)) return true;
  const name = origin.replace(/^(https:\/\/[^/:]+):\d+$/, '$1');
  return name !== origin && policy.origins.has(name);
}

// Abertas mesmo com o PIN ligado: a tela de bloqueio, a sondagem, os avisos entre as suas máquinas
// (ver machines.ts e push.ts) e as páginas dos protótipos e dos artefatos, cujo id aleatório é a
// credencial (ver prototypes.ts e artefatos.ts). Continuam valendo o Host, a origem e o login do Tailscale.
const PAGE_ROUTES = new Set([VIEW_ROUTE, ARTEFATO_VIEW_ROUTE]);
// O canal de avisos do app do PC também, mas só pela porta local (ver `localOnly`).
const PIN_FREE = new Set(['/api/health', '/api/pin', '/api/pin/unlock', '/api/pin/lock', '/api/push/relay', '/api/push/local', ...PAGE_ROUTES]);

/**
 * Pedido feito no próprio PC, direto na porta local: o `tailscale serve` sempre manda o
 * `X-Forwarded-For`, e o Host de quem vem pela tailnet é o nome dela. É assim que fala o app do PC.
 */
export function localOnly(policy: AccessPolicy, req: FastifyRequest): boolean {
  return policy.localHosts.has(req.headers.host ?? '') && !('x-forwarded-for' in req.headers) && !('tailscale-user-login' in req.headers);
}

/** O token do PIN: no cabeçalho (fetch) ou em `?t=` (WebSocket, `<img>` e links, que não mandam cabeçalho). */
export function pinToken(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const t = (req.query as Record<string, unknown> | undefined)?.t;
  return typeof t === 'string' ? t : undefined;
}

/**
 * A identidade vem do Tailscale. Barra DNS rebinding (Host), CSRF de outros sites no navegador do PC
 * (Origin + JSON) e acessos do tailnet que não sejam do dono. Com PIN (ver pin.ts), a API e o
 * WebSocket pedem também o token de quem acertou; os arquivos do app ficam abertos, para a tela de bloqueio carregar.
 * Um aparelho desconectado pela seção Acesso (ver access.ts) fica sem API e WebSocket até ser liberado.
 */
export function accessGuard(policy: AccessPolicy, pin: PinLock, access: AccessMonitor) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const host = req.headers.host ?? '';
    // Numa porta HTTPS extra do `tailscale serve` (ex.: uma instância de teste em :10000), o Host traz a porta.
    const name = host.replace(/:\d+$/, '');

    // Pelo tailnet sem https: o atalho `http://valb` (o nome da máquina, pelo MagicDNS, com o
    // `tailscale serve --http=80`) ou o endereço completo sem o "s". Vai para o endereço https: o
    // certificado só vale para ele, e sem https o navegador não deixa o app instalar, notificar nem usar o
    // microfone. O `tailscale serve` só manda o `X-Forwarded-Proto` no https; nada é servido por aqui,
    // então não precisa conferir quem pede.
    if (policy.tailnetHost && 'x-forwarded-for' in req.headers && req.headers['x-forwarded-proto'] !== 'https') {
      return reply.redirect(`https://${policy.tailnetHost}${req.url}`, 302);
    }
    const viaTailnet =
      name === policy.tailnetHost || 'x-forwarded-for' in req.headers || 'tailscale-user-login' in req.headers;

    if (!policy.localHosts.has(host) && name !== policy.tailnetHost) {
      return reply.code(403).send({ error: 'host_not_allowed' });
    }
    if (viaTailnet) {
      const login = String(req.headers['tailscale-user-login'] ?? '');
      if (!policy.logins.has(login)) {
        void access.deniedLogin(req);
        return reply.code(403).send({ error: 'tailnet_identity_required' });
      }
    }

    // Pela rota que casou, e não pela URL crua: `/%61pi/...` cai na mesma rota da API.
    const route = req.routeOptions.url ?? '';
    const origin = req.headers.origin;
    // A página de um protótipo ou de um artefato roda com origem opaca (ver prototypes.ts): o que ela
    // busca da própria pasta com fetch ou como módulo chega com `Origin: null`. Só ali, e só para ler.
    const sandboxed = origin === 'null' && PAGE_ROUTES.has(route) && (req.method === 'GET' || req.method === 'HEAD');
    if (origin && !sandboxed && !knownOrigin(policy, origin)) {
      return reply.code(403).send({ error: 'origin_not_allowed' });
    }
    // App servido por outra máquina sua (ver machines.ts): o navegador só entrega a resposta com
    // este cabeçalho, e antes de um POST com JSON pergunta com um OPTIONS.
    if (origin) reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
    if (origin && req.method === 'OPTIONS') {
      return reply
        .header('access-control-allow-methods', 'GET, POST')
        .header('access-control-allow-headers', 'content-type, authorization')
        .header('access-control-allow-private-network', 'true')
        .header('access-control-max-age', '600')
        .code(204)
        .send();
    }

    const unsafe = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    if (unsafe && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return reply.code(415).send({ error: 'json_required' });
    }

    const guarded = route.startsWith('/api/') || route === '/ws' || route.startsWith('/ws/');
    if (guarded && access.isBlocked(req)) return reply.code(403).send({ error: 'device_blocked' });
    if (pin.enabled && guarded && !PIN_FREE.has(route) && !pin.check(pinToken(req))) {
      return reply.code(401).send({ error: 'pin_required' });
    }
  };
}
