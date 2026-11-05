import { randomBytes } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PROJECT_ROOTS } from './config.ts';
import { HttpError } from './errors.ts';
import { MEDIA_TYPES, resolveInside } from './explorer.ts';

/**
 * Os protótipos do Claude: o HTML que a ferramenta Artifact do Claude Code publica no claude.ai, aberto
 * aqui numa aba de navegador. O claude.ai não deixa a página dele ser embutida, então o app mostra o
 * arquivo local, que é o mesmo que foi publicado (e o que o Claude continua editando).
 *
 * Abrir dá um id aleatório para a pasta do HTML, e a página e o que ela carrega (CSS, scripts,
 * imagens) vêm de `/api/prototype/view/<id>/…`, sem o PIN: a URL do iframe não leva o token, e o id é
 * a credencial. A resposta sai com a CSP `sandbox`, sem `allow-same-origin`: mesmo aberta direto numa
 * aba do navegador, a página roda com origem opaca e não alcança a API do cald.
 */

export const VIEW_ROUTE = '/api/prototype/view/:id/*';

/** Roda os scripts, abre links e baixa arquivos; `allow-same-origin` nunca entra. */
export const PROTOTYPE_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

// O que o Claude escreve com a página: estilos, scripts, imagens, fontes, dados e mídia.
const VIEW_TYPES: Record<string, string> = {
  ...MEDIA_TYPES,
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const isHtml = (path: string) => ['.html', '.htm'].includes(extname(path).toLowerCase());

/** Pastas e arquivos ocultos (.git, .env, .ssh) nunca saem por aqui. */
const hidden = (rel: string) => rel.split(/[\\/]/).some((part) => part.startsWith('.') && part !== '.');

type Prototype = {
  /** A pasta servida. */
  root: string;
  /** O HTML, relativo a `root`. */
  entry: string;
  /** Só o HTML sai, sem a pasta: ele está solto na pasta pessoal ou no /tmp, que não são do protótipo. */
  single: boolean;
};

const MAX_OPEN = 256;
const open = new Map<string, Prototype>();
const byPath = new Map<string, string>();

function remember(proto: Prototype): string {
  const path = join(proto.root, proto.entry);
  const known = byPath.get(path);
  if (known && open.has(known)) return known;
  const id = randomBytes(18).toString('base64url');
  open.set(id, proto);
  byPath.set(path, id);
  // Os mais antigos saem; a aba que ainda os mostra pede outro id ao abrir de novo.
  for (const [old, p] of open) {
    if (open.size <= MAX_OPEN) break;
    open.delete(old);
    byPath.delete(join(p.root, p.entry));
  }
  return id;
}

function get(id: string): Prototype {
  const proto = open.get(id);
  if (!proto) throw new HttpError(404, 'prototype_not_found');
  return proto;
}

/**
 * Prepara `path` (um .html, ou uma pasta com index.html; relativo, vale a partir de `cwd`) para abrir.
 * Só o que está dentro da pasta pessoal, das pastas de projetos ou do /tmp: o protótipo é coisa do
 * Claude, não do sistema.
 */
export async function openPrototype(path: string, cwd?: string): Promise<{ id: string; entry: string; name: string; mtime: number }> {
  if (!isAbsolute(path) && !cwd) throw new HttpError(400, 'path_not_absolute');
  let full = await realpath(resolve(cwd ?? '/', path)).catch(() => {
    throw new HttpError(404, 'prototype_not_found');
  });
  let info = await stat(full);
  if (info.isDirectory()) {
    full = join(full, 'index.html');
    info = await stat(full).catch(() => {
      throw new HttpError(404, 'prototype_not_found');
    });
  }
  if (!info.isFile() || !isHtml(full)) throw new HttpError(400, 'not_html');

  const real = (dir: string) => realpath(dir).catch(() => dir);
  const home = await real(homedir());
  const temps = await Promise.all([...new Set([tmpdir(), '/tmp'])].map(real));
  const roots = await Promise.all(PROJECT_ROOTS.map(real));
  const base = [home, ...roots, ...temps].find((dir) => full.startsWith(dir + sep));
  if (!base) throw new HttpError(403, 'path_not_allowed');

  const root = dirname(full);
  // Um HTML solto numa pasta oculta (`~/.ssh/x.html`) abriria a pasta inteira: só ele sai. Os worktrees
  // das conversas (`<projeto>/.claude/worktrees/…`) são projetos como os outros.
  const parts = relative(base, root).split(sep);
  const inHidden = parts.some((part, i) => part.startsWith('.') && !(part === '.claude' && parts[i + 1] === 'worktrees'));
  const loose = [home, ...roots, ...temps].includes(root);
  const proto: Prototype = { root, entry: basename(full), single: loose || inHidden };
  return { id: remember(proto), entry: proto.entry, name: proto.entry, mtime: await version(proto) };
}

/**
 * A versão do protótipo, para a aba recarregar quando o Claude mexe nele: a mudança mais recente entre o
 * HTML e os arquivos ao lado dele (o CSS e os scripts que ele costuma separar).
 */
async function version(proto: Prototype): Promise<number> {
  const page = (await stat(join(proto.root, proto.entry)).catch(() => null))?.mtimeMs;
  if (page === undefined) throw new HttpError(404, 'prototype_not_found');
  if (proto.single) return page;
  const dirents = await readdir(proto.root, { withFileTypes: true }).catch(() => []);
  const files = dirents.filter((d) => d.isFile() && !d.name.startsWith('.')).slice(0, 200);
  const times = await Promise.all(files.map((d) => stat(join(proto.root, d.name)).then((s) => s.mtimeMs, () => 0)));
  return Math.max(page, ...times);
}

export const prototypeVersion = async (id: string) => ({ mtime: await version(get(id)) });

/** Um arquivo do protótipo `id`; `rel` vazio é o próprio HTML. */
export async function prototypeFile(id: string, rel: string): Promise<{ path: string; mediaType: string }> {
  const proto = get(id);
  const wanted = rel || proto.entry;
  if (hidden(wanted) || (proto.single && wanted !== proto.entry)) throw new HttpError(404, 'not_found');
  let full = await resolveInside(proto.root, wanted);
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
