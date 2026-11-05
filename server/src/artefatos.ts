import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR, HOST, PORT } from './config.ts';
import { HttpError } from './errors.ts';
import { resolveInside } from './explorer.ts';
import { hidden, locatePage, PROTOTYPE_CSP, VIEW_TYPES } from './prototypes.ts';

const exec = promisify(execFile);

/**
 * Os artefatos do cald: uma página HTML que o Claude publica pelo MCP do cald (`publicar_artefato`). Cada
 * publicação congela o HTML e os arquivos que ele usa numa versão que não muda mais (v1, v2…), e o
 * artefato tem um link fixo na tailnet (`/a/<id>/`), que mostra a versão mais nova numa casca no jeito do
 * cald, sem depender do arquivo que o Claude continua editando.
 *
 * O link público é escolha sua, no app (a ferramenta não tem como ligar): um servidor à parte, só em
 * 127.0.0.1, que serve apenas `/a/<token>/` dos artefatos públicos, exposto na internet pelo Tailscale
 * Funnel, que o cald liga quando o primeiro fica público e desliga quando não sobra nenhum. O público mostra
 * a versão de quando foi ligado: publicar de novo não muda o que está na internet até você atualizar.
 */

export type ArtefatoVersao = {
  n: number;
  at: number;
  /** O HTML, relativo à pasta da versão. */
  entry: string;
  files: number;
  bytes: number;
  label?: string;
  /** Do conteúdo: publicar de novo sem mudança nenhuma não cria versão. */
  hash: string;
};

type Stored = {
  id: string;
  title: string;
  description?: string;
  cwd?: string;
  sessionId?: string;
  /** O HTML de origem, absoluto: publicar o mesmo arquivo de novo cria uma versão deste artefato. */
  source: string;
  createdAt: number;
  updatedAt: number;
  versions: ArtefatoVersao[];
  public: { token: string; since: number; n: number } | null;
};
type StoredLixo = Stored & { deletedAt: number };

/** O que o app recebe: o link fixo como caminho, e o público já como endereço completo. */
export type Artefato = Omit<Stored, 'public'> & { link: string; public: { url: string; since: number; n: number } | null };
export type ArtefatoLixo = Artefato & { deletedAt: number };

export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 500;
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 500;
const TRASH_DAYS = 30;
// Só o que o HTML, o CSS e o JS de uma página costumam ter de tamanho: lido para achar as referências.
const MAX_PARSE = 5 * 1024 * 1024;

const FILE = process.env.ARTEFATOS_FILE ?? join(DATA_DIR, 'artefatos.json');
const DIR = process.env.ARTEFATOS_DIR ?? join(DATA_DIR, 'artefatos');
/** O servidor público (só em 127.0.0.1; a internet chega pelo Funnel). */
export const PUBLIC_PORT = Number(process.env.ARTEFATOS_PUBLIC_PORT ?? PORT + 2);
/** A porta do Funnel: 8443 ou 10000 (as que o Tailscale libera além da 443, que é a do próprio cald). */
export const FUNNEL_PORT = Number(process.env.ARTEFATOS_FUNNEL_PORT ?? 8443);

const newId = () => randomBytes(16).toString('base64url');
const versionDir = (id: string, n: number) => join(DIR, id, `v${n}`);

/* ---------------------------------------------------------------- o que a página usa */

// Referências que um HTML, um CSS ou um JS faz a outros arquivos da pasta dele.
const HTML_REFS = /\b(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi;
const SRCSET = /\bsrcset\s*=\s*["']([^"']+)["']/gi;
const CSS_REFS = /url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(["'])([^"']+)\3/gi;
const JS_REFS =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']|new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url|\bfetch\(\s*["']([^"']+)["']/g;

/** Os caminhos que o arquivo cita, como estão no texto. */
function refsOf(path: string, text: string): string[] {
  const ext = extname(path).toLowerCase();
  const out: string[] = [];
  const all = (re: RegExp, pick: (m: RegExpExecArray) => (string | undefined)[]) => {
    for (const m of text.matchAll(re)) for (const v of pick(m)) if (v) out.push(v);
  };
  if (ext === '.html' || ext === '.htm' || ext === '.svg') {
    all(HTML_REFS, (m) => [m[1]]);
    all(SRCSET, (m) => m[1]!.split(',').map((part) => part.trim().split(/\s+/)[0]));
  }
  // O CSS e o JS também aparecem dentro do HTML (`<style>`, `style=""`, `<script type="module">`).
  if (ext !== '.js' && ext !== '.mjs') all(CSS_REFS, (m) => [m[2], m[4]]);
  if (ext !== '.css') all(JS_REFS, (m) => [m[1], m[2], m[3], m[4]]);
  return out;
}

/** Relativo à página e dentro da pasta dela; `null` para links da internet, `data:`, âncoras e afins. */
function localRef(ref: string, from: string): string | null {
  let clean = ref.trim().split('#')[0]!.split('?')[0]!;
  if (!clean || clean.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
  try {
    clean = decodeURIComponent(clean);
  } catch {
    return null;
  }
  // Especificador de pacote (`import 'react'`) não é arquivo.
  const rel = posix.normalize(posix.join(posix.dirname(from), clean));
  if (rel.startsWith('../') || rel === '..' || hidden(rel)) return null;
  return rel;
}

type Picked = { rel: string; abs: string; size: number };

/**
 * O HTML e o que ele usa, seguindo as referências (um CSS que cita uma fonte, um script que importa
 * outro), só dentro da pasta dele e nunca os ocultos. Um link para fora da pasta (ou um atalho que
 * aponta para fora dela) fica de fora. Página solta (ver `locatePage`) sai sozinha.
 */
async function collect(root: string, entry: string, single: boolean): Promise<Picked[]> {
  const picked = new Map<string, Picked>();
  const queue = [entry];
  let bytes = 0;
  while (queue.length) {
    const rel = queue.shift()!;
    if (picked.has(rel)) continue;
    const abs = await resolveInside(root, rel).catch(() => null);
    if (!abs) continue;
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) continue;
    bytes += info.size;
    if (picked.size + 1 > MAX_FILES || bytes > MAX_BYTES) {
      throw new HttpError(413, 'artefato_too_big', { maxBytes: MAX_BYTES, maxFiles: MAX_FILES });
    }
    picked.set(rel, { rel, abs, size: info.size });
    if (single) break;
    if (!['.html', '.htm', '.css', '.js', '.mjs', '.svg'].includes(extname(rel).toLowerCase()) || info.size > MAX_PARSE) continue;
    const text = await readFile(abs, 'utf8').catch(() => '');
    for (const ref of refsOf(rel, text)) {
      const next = localRef(ref, rel);
      if (next && !picked.has(next)) queue.push(next);
    }
  }
  return [...picked.values()];
}

async function hashOf(files: Picked[]): Promise<string> {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    h.update(f.rel).update('\0').update(await readFile(f.abs)).update('\0');
  }
  return h.digest('hex');
}

/** O `<title>` da página, no começo do arquivo. */
async function titleOf(abs: string): Promise<string | undefined> {
  const head = (await readFile(abs, 'utf8').catch(() => '')).slice(0, 8192);
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(head);
  return m?.[1]?.replace(/\s+/g, ' ').trim() || undefined;
}

/* ---------------------------------------------------------------- o Funnel */

/** Liga ou desliga o Funnel da porta dos artefatos; falhou, diz por quê em uma linha. */
async function funnel(on: boolean): Promise<void> {
  if (FUNNEL_PORT === 443) throw new HttpError(409, 'funnel_unavailable', { detail: 'a porta 443 é a do próprio cald' });
  const args = on ? ['funnel', '--bg', `--https=${FUNNEL_PORT}`, `http://${HOST}:${PUBLIC_PORT}`] : ['funnel', `--https=${FUNNEL_PORT}`, 'off'];
  try {
    await exec('tailscale', args, { timeout: 15_000 });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || '').split('\n').find((l) => l.trim())?.trim().slice(0, 200);
    throw new HttpError(409, 'funnel_unavailable', { detail });
  }
}

/* ---------------------------------------------------------------- a loja */

export type PublishInput = { path: string; cwd?: string; sessionId?: string; title?: string; description?: string; label?: string };
export type PublishResult = { artefato: Artefato; version: ArtefatoVersao; novo: boolean };

/** Avisa `change` a cada gravação, venha do app ou do Claude (ver cald-mcp.ts). */
export class ArtefatoStore extends EventEmitter {
  private items: Stored[] = [];
  private trash: StoredLixo[] = [];
  private writing = Promise.resolve();
  // Publicar é em fila: duas publicações do mesmo arquivo ao mesmo tempo não disputam o número da versão.
  private publishing: Promise<unknown> = Promise.resolve();
  private funnelOn = false;

  /** O nome do PC na tailnet (`<máquina>.<tailnet>.ts.net`), quando o Tailscale já respondeu. */
  private readonly host: () => string | undefined;

  constructor(host: () => string | undefined) {
    super();
    this.host = host;
  }

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(FILE, 'utf8')) as { items?: Stored[]; trash?: StoredLixo[] };
      const valid = (a: Stored) => a && typeof a.id === 'string' && Array.isArray(a.versions) && a.versions.length > 0;
      this.items = Array.isArray(data.items) ? data.items.filter(valid) : [];
      const cutoff = Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000;
      const trash = Array.isArray(data.trash) ? data.trash.filter(valid) : [];
      this.trash = trash.filter((a) => a.deletedAt > cutoff);
      // O que passou dos 30 dias na lixeira some de vez, com as versões.
      const expired = trash.filter((a) => a.deletedAt <= cutoff);
      if (expired.length) {
        await Promise.all(expired.map((a) => rm(join(DIR, a.id), { recursive: true, force: true })));
        await this.persist();
      }
    } catch {
      // Primeiro uso ou arquivo ilegível: começa vazio.
    }
  }

  /** Com algum artefato público, o Funnel precisa estar ligado (o serviço reiniciou, o PC religou). */
  async syncFunnel(): Promise<void> {
    if (!this.items.some((a) => a.public)) return;
    await funnel(true);
    this.funnelOn = true;
  }

  list(): Artefato[] {
    return [...this.items].sort((a, b) => b.updatedAt - a.updatedAt).map((a) => this.out(a));
  }

  trashed(): ArtefatoLixo[] {
    return [...this.trash].sort((a, b) => b.deletedAt - a.deletedAt).map((a) => ({ ...this.out(a), deletedAt: a.deletedAt }));
  }

  get(id: string): Artefato {
    return this.out(this.stored(id));
  }

  /** O endereço completo do link fixo, para o Claude passar adiante (ver cald-mcp.ts). */
  linkUrl(id: string): string {
    const base = process.env.CALD_URL?.replace(/\/+$/, '') ?? (this.host() ? `https://${this.host()}` : `http://${HOST}:${PORT}`);
    return `${base}/a/${id}/`;
  }

  private stored(id: string): Stored {
    const a = this.items.find((x) => x.id === id);
    if (!a) throw new HttpError(404, 'artefato_not_found');
    return a;
  }

  private out(a: Stored): Artefato {
    const host = this.host();
    const pub = a.public && host ? { url: `https://${host}:${FUNNEL_PORT}/a/${a.public.token}/`, since: a.public.since, n: a.public.n } : null;
    return { ...a, link: `/a/${a.id}/`, public: pub };
  }

  /**
   * Congela `path` numa versão nova: do artefato que já veio desse arquivo (fora da lixeira) ou de um
   * novo. Sem mudança nenhuma desde a última versão, devolve a última.
   */
  publish(input: PublishInput): Promise<PublishResult> {
    const run = this.publishing.then(() => this.doPublish(input));
    this.publishing = run.catch(() => {});
    return run;
  }

  private async doPublish(input: PublishInput): Promise<PublishResult> {
    const page = await locatePage(input.path, input.cwd);
    const source = join(page.root, page.entry);
    const files = await collect(page.root, page.entry, page.single);
    const hash = await hashOf(files);
    const existing = this.items.find((a) => a.source === source);
    const title = input.title?.trim().slice(0, MAX_TITLE) || undefined;
    const description = input.description?.trim().slice(0, MAX_DESCRIPTION) || undefined;
    const last = existing?.versions.at(-1);
    if (existing && last && last.hash === hash) {
      if (title) existing.title = title;
      if (description) existing.description = description;
      if (title || description) await this.persist();
      return { artefato: this.out(existing), version: last, novo: false };
    }

    const id = existing?.id ?? newId();
    const n = (last?.n ?? 0) + 1;
    // Copiada numa pasta temporária e renomeada no fim: uma versão nunca fica pela metade.
    const tmp = join(DIR, id, `.v${n}-${randomBytes(4).toString('hex')}`);
    try {
      for (const f of files) {
        const to = join(tmp, f.rel);
        await mkdir(dirname(to), { recursive: true });
        await copyFile(f.abs, to);
      }
      await rename(tmp, versionDir(id, n));
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw err;
    }

    const now = Date.now();
    const version: ArtefatoVersao = {
      n,
      at: now,
      entry: page.entry,
      files: files.length,
      bytes: files.reduce((sum, f) => sum + f.size, 0),
      label: input.label?.trim().slice(0, 60) || undefined,
      hash,
    };
    let a = existing;
    if (a) {
      a.versions.push(version);
      a.updatedAt = now;
      if (title) a.title = title;
      if (description) a.description = description;
    } else {
      a = {
        id,
        title: title ?? (await titleOf(join(page.root, page.entry))) ?? page.entry,
        description,
        cwd: input.cwd,
        sessionId: input.sessionId,
        source,
        createdAt: now,
        updatedAt: now,
        versions: [version],
        public: null,
      };
      this.items.push(a);
    }
    await this.persist();
    return { artefato: this.out(a), version, novo: !existing };
  }

  /**
   * Liga (ou desliga) o link público. Ligar de novo um que já está público passa a mostrar a versão mais
   * nova, com o mesmo link; desligar revoga o link (ligar depois dá outro).
   */
  async setPublic(id: string, on: boolean): Promise<Artefato> {
    const a = this.stored(id);
    const latest = a.versions.at(-1)!.n;
    if (on) {
      if (!this.host()) throw new HttpError(409, 'funnel_unavailable', { detail: 'o Tailscale ainda não respondeu' });
      if (!this.funnelOn) {
        await funnel(true);
        this.funnelOn = true;
      }
      a.public = a.public ? { ...a.public, n: latest } : { token: newId(), since: Date.now(), n: latest };
    } else {
      a.public = null;
    }
    await this.persist();
    await this.funnelIfIdle();
    return this.out(a);
  }

  /** Sem nenhum público, o Funnel desliga: a porta não fica aberta à toa. */
  private async funnelIfIdle(): Promise<void> {
    if (!this.funnelOn || this.items.some((a) => a.public)) return;
    await funnel(false).catch(() => {});
    this.funnelOn = false;
  }

  /** Para a lixeira, de onde volta igual por 30 dias; o link público é revogado na hora. */
  async toTrash(id: string): Promise<void> {
    const a = this.stored(id);
    this.items = this.items.filter((x) => x.id !== id);
    this.trash = [{ ...a, public: null, deletedAt: Date.now() }, ...this.trash];
    await this.persist();
    await this.funnelIfIdle();
  }

  async restore(id: string): Promise<Artefato> {
    const t = this.trash.find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'artefato_not_found');
    const { deletedAt: _deletedAt, ...a } = t;
    this.trash = this.trash.filter((x) => x.id !== id);
    this.items.push(a);
    await this.persist();
    return this.out(a);
  }

  /** Apaga de vez da lixeira, com as versões. */
  async purge(id: string): Promise<void> {
    if (!this.trash.some((x) => x.id === id)) throw new HttpError(404, 'artefato_not_found');
    this.trash = this.trash.filter((x) => x.id !== id);
    await this.persist();
    await rm(join(DIR, id), { recursive: true, force: true });
  }

  /** Um arquivo da versão `n` (vazio: o HTML dela). */
  async file(id: string, n: number, rel: string): Promise<{ path: string; mediaType: string }> {
    return fileOf(this.stored(id), n, rel);
  }

  /** O artefato público do `token`, na versão que está na internet. */
  byToken(token: string): { a: Artefato; n: number } | null {
    const a = this.items.find((x) => x.public?.token === token);
    return a?.public ? { a: this.out(a), n: a.public.n } : null;
  }

  async publicFile(token: string, rel: string): Promise<{ path: string; mediaType: string }> {
    const a = this.items.find((x) => x.public?.token === token);
    if (!a?.public) throw new HttpError(404, 'not_found');
    return fileOf(a, a.public.n, rel);
  }

  // Gravação atômica e em fila: um arquivo temporário renomeado por cima do atual.
  private persist(): Promise<void> {
    const snapshot = JSON.stringify({ items: this.items, trash: this.trash }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(FILE), { recursive: true });
      await writeFile(`${FILE}.tmp`, snapshot);
      await rename(`${FILE}.tmp`, FILE);
    });
    this.emit('change');
    return this.writing;
  }
}

async function fileOf(a: Pick<Stored, 'id' | 'versions'>, n: number, rel: string): Promise<{ path: string; mediaType: string }> {
  const v = a.versions.find((x) => x.n === n);
  if (!v) throw new HttpError(404, 'not_found');
  const wanted = rel || v.entry;
  if (hidden(wanted)) throw new HttpError(404, 'not_found');
  let full = await resolveInside(versionDir(a.id, n), wanted);
  let info = await stat(full);
  if (info.isDirectory()) {
    full = join(full, 'index.html');
    info = await stat(full).catch(() => {
      throw new HttpError(404, 'not_found');
    });
  }
  if (!info.isFile()) throw new HttpError(404, 'not_found');
  return { path: full, mediaType: VIEW_TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream' };
}

/* ---------------------------------------------------------------- a casca do link */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const when = (at: number) => new Date(at).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' }).replace('.', '');

const CALD_MARK =
  '<svg viewBox="1 1.5 30 30" width="18" height="18" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M11.64 5.56A5 5 0 0 1 20.36 5.56L29.86 22.56A5 5 0 0 1 25.5 30L6.5 30A5 5 0 0 1 2.14 22.56ZM7.5 19.6a3.3 4.5 0 1 0 6.6 0a3.3 4.5 0 1 0 -6.6 0ZM17.9 19.6a3.3 4.5 0 1 0 6.6 0a3.3 4.5 0 1 0 -6.6 0Z"/></svg>';

/** A casca não roda script nenhum: só ela mesma, o estilo e a página no iframe isolado. */
/** As páginas das versões, servidas pelo cald na tailnet (sem o PIN: o id aleatório é a credencial). */
export const ARTEFATO_VIEW_ROUTE = '/api/artefato/view/:id/:n/*';

export const SHELL_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src 'self'; base-uri 'none'; form-action 'none'";

/**
 * A página do link: a barra no jeito do cald (a marca, o título, a versão e, na tailnet, as outras
 * versões num menu sem script) e, embaixo, a página num iframe isolado, como a janela de uma conversa.
 * `frame`: o endereço da página; `versions`: os links das versões (só na tailnet).
 */
export function shellHtml(a: Artefato, n: number, frame: string, versions?: { n: number; href: string; label?: string; at: number }[]): string {
  const v = a.versions.find((x) => x.n === n)!;
  const menu = versions && versions.length > 1
    ? `<details class="menu"><summary>v${n}<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><div class="pop">${[...versions]
        .reverse()
        .map((x) => `<a href="${esc(x.href)}"${x.n === n ? ' aria-current="page"' : ''}><b>v${x.n}</b><span>${esc(x.label ?? '')}</span><i>${when(x.at)}</i></a>`)
        .join('')}</div></details>`
    : `<span class="tag">v${n}</span>`;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(a.title)}</title>
<style>
:root { --bg: oklch(0.995 0 0); --fg: oklch(0.18 0 0); --muted: oklch(0.52 0 0); --shell: oklch(0.94 0 0); --pop: oklch(1 0 0); color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: oklch(0.19 0 0); --fg: oklch(0.96 0 0); --muted: oklch(0.69 0 0); --shell: oklch(0.12 0 0); --pop: oklch(0.24 0 0); } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--shell); color: var(--fg); font: 14px/1.4 'Geist Variable', 'Geist', ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
body { display: flex; flex-direction: column; padding: 0 6px 6px; }
header { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 8px 0 10px; flex-shrink: 0; min-width: 0; }
header .mark { display: flex; color: var(--fg); opacity: .85; }
header h1 { margin: 0; font-size: 14px; font-weight: 500; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; }
header .when { color: var(--muted); font-size: 12px; white-space: nowrap; }
header .grow { flex: 1; }
.tag, summary { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border-radius: 8px; font-size: 12px; color: var(--muted); background: color-mix(in oklab, var(--fg) 6%, transparent); }
summary { cursor: pointer; list-style: none; user-select: none; }
summary::-webkit-details-marker { display: none; }
summary:hover { color: var(--fg); }
.menu { position: relative; }
.pop { position: absolute; right: 0; top: 34px; z-index: 2; width: 260px; max-height: 60vh; overflow: auto; padding: 4px; border-radius: 14px; background: var(--pop); box-shadow: 0 0 0 1px color-mix(in oklab, var(--fg) 6%, transparent), 0 12px 32px -12px oklch(0 0 0 / 30%); }
.pop a { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 6px 10px; border-radius: 10px; color: inherit; text-decoration: none; font-size: 13px; }
.pop a:hover { background: color-mix(in oklab, var(--fg) 5%, transparent); }
.pop a[aria-current] { background: color-mix(in oklab, var(--fg) 8%, transparent); }
.pop span { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--muted); }
.pop i { font-style: normal; font-size: 12px; color: var(--muted); }
.open { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 28px; border-radius: 8px; color: var(--muted); }
.open:hover { color: var(--fg); background: color-mix(in oklab, var(--fg) 6%, transparent); }
main { flex: 1; min-height: 0; border-radius: 14px; overflow: hidden; background: var(--bg); box-shadow: 0 1px 2px 0 oklch(0 0 0 / 6%); }
iframe { display: block; width: 100%; height: 100%; border: 0; background: var(--bg); }
@media (max-width: 40rem) { header .when { display: none; } }
</style>
</head>
<body>
<header>
<span class="mark" title="cald">${CALD_MARK}</span>
<h1>${esc(a.title)}</h1>
<span class="when">${when(v.at)}</span>
<span class="grow"></span>
${menu}
<a class="open" href="${esc(frame)}" target="_blank" rel="noreferrer" title="Só a página" aria-label="Só a página"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></a>
</header>
<main><iframe src="${esc(frame)}" title="${esc(a.title)}" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads" referrerpolicy="no-referrer"></iframe></main>
</body>
</html>`;
}

/* ---------------------------------------------------------------- o servidor público */

/**
 * O servidor do link público: só GET e HEAD, só `/a/<token>/` (a casca) e `/a/<token>/f/<arquivo>` (a
 * versão que está na internet). Fica num processo HTTP à parte do cald, sem a API, o app, o PIN nem o
 * WebSocket: o que o Funnel expõe é só isto.
 */
export function startPublicServer(store: ArtefatoStore, log: (msg: string, err?: unknown) => void): Server {
  const server = createServer(async (req, res) => {
    const base = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
    };
    const notFound = () => {
      res.writeHead(404, { ...base, 'content-type': 'text/plain; charset=utf-8' }).end('Não encontrado');
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...base, allow: 'GET, HEAD' }).end();
      return;
    }
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const m = /^\/a\/([\w-]{16,64})(\/.*)?$/.exec(url.pathname);
      if (!m) return notFound();
      const token = m[1]!;
      const rest = m[2] ?? '';
      if (rest === '') {
        res.writeHead(301, { ...base, location: `/a/${token}/` }).end();
        return;
      }
      const hit = store.byToken(token);
      if (!hit) return notFound();
      if (rest === '/') {
        const v = hit.a.versions.find((x) => x.n === hit.n)!;
        const html = shellHtml(hit.a, hit.n, `/a/${token}/f/${encodeURI(v.entry)}`);
        res.writeHead(200, { ...base, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': SHELL_CSP, 'cache-control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : html);
        return;
      }
      if (!rest.startsWith('/f/')) return notFound();
      const rel = decodeURIComponent(rest.slice(3));
      const file = await store.publicFile(token, rel);
      res.writeHead(200, {
        ...base,
        'content-type': file.mediaType,
        'content-security-policy': PROTOTYPE_CSP,
        'cache-control': 'public, max-age=60',
      });
      if (req.method === 'HEAD') return void res.end();
      createReadStream(file.path).on('error', () => res.destroy()).pipe(res);
    } catch (err) {
      if (err instanceof HttpError || (err as NodeJS.ErrnoException).code === 'ENOENT') return notFound();
      log('artefato público: erro ao servir', err);
      if (!res.headersSent) res.writeHead(500, base);
      res.end();
    }
  });
  server.on('error', (err) => log(`artefato público: não deu para ouvir em ${HOST}:${PUBLIC_PORT}`, err));
  server.listen(PUBLIC_PORT, HOST);
  return server;
}

