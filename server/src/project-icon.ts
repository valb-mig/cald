import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { HttpError } from './errors.ts';
import { resolveInside } from './explorer.ts';
import { toWebp } from './sharp.ts';

/**
 * A marca de um projeto para o app (lista de conversas, Projetos, hub): a logo que você escolheu para
 * ele no app ou, sem uma, a logo ou o favicon que o próprio repositório já tem, num quadrado de 128 px
 * em WebP. Sem nenhuma, o app desenha a inicial.
 */

/** `custom`: escolhida no app; `repo`: achada no repositório. */
export type ProjectIcon = { mediaType: string; data: Buffer; source: 'custom' | 'repo' };

// As escolhidas no app ficam no PC, fora do repositório: nada aparece no git do projeto.
const CUSTOM_DIR = join(DATA_DIR, 'project-icons');
const customPath = (cwd: string) => join(CUSTOM_DIR, `${createHash('sha1').update(cwd).digest('hex').slice(0, 20)}.webp`);

/** Onde fica o app web num monorepo, além da raiz. */
const BASES = ['', 'web/', 'frontend/', 'client/', 'apps/web/', 'packages/web/'];

/** Onde os projetos costumam guardar a marca: logos e ícones antes dos favicons, vetor antes de bitmap. */
const FILES = [
  'public/logo.svg',
  'public/icon.svg',
  'public/favicon.svg',
  'app/icon.svg',
  'src/app/icon.svg',
  'src/assets/logo.svg',
  'assets/logo.svg',
  '.github/logo.svg',
  'logo.svg',
  'icon.svg',
  'static/favicon.svg',
  'public/logo.png',
  'public/icon.png',
  'public/apple-touch-icon.png',
  'public/favicon.png',
  'app/icon.png',
  'src/app/icon.png',
  'app/apple-icon.png',
  'src/app/apple-icon.png',
  'src/assets/logo.png',
  'assets/logo.png',
  '.github/logo.png',
  'logo.png',
  'icon.png',
  'static/favicon.png',
  'public/favicon.ico',
  'app/favicon.ico',
  'src/app/favicon.ico',
  'static/favicon.ico',
  'favicon.ico',
];

const SIDE = 128;
const MAX_BYTES = 2 * 1024 * 1024;
// A logo muda pouco: procurar de novo de tempos em tempos basta, sem vigiar as pastas.
const TTL_MS = 10 * 60_000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Favicons que vêm no esqueleto de um framework (sha256), não do projeto: o triângulo da Vercel do
// create-next-app. Achar um desses é o mesmo que não ter marca.
const SKELETON = new Set(['2b8ad2d33455a8f736fc3a8ebf8f0bdea8848ad4c0db48a2833bd0f9cd775932']);

const cache = new Map<string, { at: number; icon: Promise<ProjectIcon | null> }>();

/** Do .ico, a maior imagem guardada como PNG: o sharp não lê ICO, e as em BMP ficam de fora. */
function pngInIco(buf: Buffer): Buffer | null {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  let best: Buffer | null = null;
  let bestSide = 0;
  for (let i = 0; i < buf.readUInt16LE(4); i++) {
    const at = 6 + i * 16;
    if (at + 16 > buf.length) break;
    // 0 no byte do tamanho quer dizer 256 px.
    const side = buf[at] || 256;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    const data = buf.subarray(offset, offset + size);
    if (data.length === size && data.subarray(0, 8).equals(PNG) && side > bestSide) {
      best = data;
      bestSide = side;
    }
  }
  return best;
}

/** O primeiro arquivo de marca do projeto, dentro dele (link para fora não vale), já lido. */
async function findIcon(cwd: string): Promise<{ path: string; data: Buffer } | null> {
  for (const base of BASES) {
    if (base && !(await stat(`${cwd}/${base}`).then((s) => s.isDirectory(), () => false))) continue;
    for (const file of FILES) {
      const path = await resolveInside(cwd, base + file).catch(() => null);
      if (!path) continue;
      const info = await stat(path).catch(() => null);
      // O favicon.ico vazio do esqueleto do Laravel não é uma marca.
      if (!info?.isFile() || info.size === 0 || info.size > MAX_BYTES) continue;
      const data = await readFile(path);
      if (!SKELETON.has(createHash('sha256').update(data).digest('hex'))) return { path, data };
    }
  }
  return null;
}

const isIco = (buf: Buffer) => buf.length >= 4 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1;

/**
 * A imagem no quadrado da marca, em WebP. SVG desenhado com densidade alta, para sair nítido mesmo
 * pequeno; tudo vira bitmap, então nenhum script de um SVG chega a rodar no app. `null`: sem o sharp,
 * e nenhum projeto tem marca; `undefined`: não é imagem.
 */
async function toMark(buf: Buffer): Promise<Buffer | null | undefined> {
  const input = isIco(buf) ? pngInIco(buf) : buf;
  if (!input) return undefined;
  return toWebp(input, { width: SIDE, height: SIDE, fit: 'contain', density: 300, quality: 85 }).catch(() => undefined);
}

/** A achada no repositório, sem olhar a escolhida no app. */
async function fromRepo(cwd: string): Promise<ProjectIcon | null> {
  const found = await findIcon(cwd);
  const data = found && (await toMark(found.data));
  return data ? { mediaType: 'image/webp', data, source: 'repo' } : null;
}

async function render(cwd: string): Promise<ProjectIcon | null> {
  const custom = await readFile(customPath(cwd)).catch(() => null);
  if (custom) return { mediaType: 'image/webp', data: custom, source: 'custom' };
  return fromRepo(cwd);
}

export function projectIcon(cwd: string): Promise<ProjectIcon | null> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.icon;
  const icon = render(cwd).catch(() => null);
  cache.set(cwd, { at: Date.now(), icon });
  return icon;
}

/** De onde vem a marca agora e se o repositório tem uma, para o menu do projeto saber o que oferecer. */
export async function projectIconInfo(cwd: string): Promise<{ source: ProjectIcon['source'] | null; repo: boolean }> {
  const [icon, repo] = await Promise.all([projectIcon(cwd), fromRepo(cwd)]);
  return { source: icon?.source ?? null, repo: Boolean(repo) };
}

/** Guarda a logo escolhida no app para o projeto; ela passa na frente da do repositório. */
export async function setProjectIcon(cwd: string, image: Buffer): Promise<void> {
  const data = await toMark(image);
  if (data === null) throw new HttpError(503, 'sharp_unavailable');
  if (!data) throw new HttpError(400, 'invalid_image');
  await mkdir(CUSTOM_DIR, { recursive: true });
  await writeFile(customPath(cwd), data);
  cache.delete(cwd);
}

/** Tira a escolhida no app: volta a valer a do repositório, se houver. */
export async function clearProjectIcon(cwd: string): Promise<void> {
  await rm(customPath(cwd), { force: true });
  cache.delete(cwd);
}
