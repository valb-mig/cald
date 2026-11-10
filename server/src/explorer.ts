import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { cp, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { DATA_DIR } from './config.ts';
import { HttpError } from './errors.ts';

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_RAW_BYTES = 25 * 1024 * 1024;

export const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
};

/** Caminho dentro do projeto, seguindo links: nada de "../" nem link que aponte para fora. */
export async function resolveInside(root: string, rel: string): Promise<string> {
  const realRoot = await realpath(root);
  const full = await realpath(resolve(realRoot, rel || '.')).catch(() => {
    throw new HttpError(404, 'not_found');
  });
  if (full !== realRoot && !full.startsWith(realRoot + sep)) throw new HttpError(403, 'outside_project');
  return full;
}

export type TreeEntry = { name: string; path: string; type: 'dir' | 'file'; size?: number; ignored?: boolean };

/** Um nível da árvore (carregado sob demanda): pastas primeiro; ignorados pelo git vêm marcados. */
export async function listDir(root: string, rel: string): Promise<TreeEntry[]> {
  const dir = await resolveInside(root, rel);
  const realRoot = await realpath(root);
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    dirents
      .filter((d) => d.name !== '.git')
      .map(async (d): Promise<TreeEntry | null> => {
        const full = join(dir, d.name);
        const path = relative(realRoot, full);
        try {
          // Links: classifica pelo destino (o acesso depois passa por resolveInside).
          const info = d.isSymbolicLink() ? await stat(full) : null;
          const isDir = info ? info.isDirectory() : d.isDirectory();
          const size = isDir ? undefined : (info ?? (await stat(full))).size;
          return { name: d.name, path, type: isDir ? 'dir' : 'file', size };
        } catch {
          return null; // link quebrado
        }
      }),
  );
  const list = entries.filter((e): e is TreeEntry => e !== null);

  // Como no VSCode: o que o .gitignore cobre aparece esmaecido.
  const ignored = await gitIgnored(realRoot, list.map((e) => e.path));
  for (const e of list) if (ignored.has(e.path)) e.ignored = true;

  return list.sort(
    (a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name, 'pt-BR', { numeric: true }),
  );
}

async function gitIgnored(root: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  return new Promise((done) => {
    const child = execFile('git', ['check-ignore', '--stdin', '-z'], { cwd: root, timeout: 5_000 }, (_err, stdout) => {
      // Saída 1 = nada ignorado; fora de repositório também cai aqui com stdout vazio.
      done(new Set(String(stdout ?? '').split('\0').filter(Boolean)));
    });
    child.stdin?.end(paths.join('\0'));
  });
}

/**
 * O que identifica o conteúdo lido, para o editor saber se o arquivo mudou desde então. Só o pedaço que
 * o painel mostra conta (ver `MAX_TEXT_BYTES`): arquivo maior abre só para leitura.
 */
const hashOf = (data: Buffer) => createHash('sha1').update(data.subarray(0, MAX_TEXT_BYTES)).digest('hex');

export type FileView =
  /** `hash` só no que o editor pode salvar: texto inteiro (sem corte) e em UTF-8. */
  | { kind: 'text'; size: number; content: string; truncated: boolean; hash?: string }
  | { kind: 'image' | 'pdf' | 'binary' | 'large'; size: number };

/** Conteúdo para leitura no celular: texto até 1 MB; imagem/PDF são abertos pelo /raw. */
export async function readProjectFile(root: string, rel: string): Promise<FileView> {
  const full = await resolveInside(root, rel);
  const info = await stat(full);
  if (info.isDirectory()) throw new HttpError(400, 'is_a_directory');
  const media = MEDIA_TYPES[extname(full).toLowerCase()];
  if (media?.startsWith('image/')) return { kind: 'image', size: info.size };
  if (media === 'application/pdf') return { kind: 'pdf', size: info.size };

  const handle = await open(full, 'r');
  try {
    const length = Math.min(info.size, MAX_TEXT_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    // Byte nulo no começo = binário.
    if (buffer.subarray(0, 8_000).includes(0)) return { kind: 'binary', size: info.size };
    const truncated = info.size > MAX_TEXT_BYTES;
    // Fora do UTF-8 (Latin-1, por exemplo), o texto vira � onde não decodifica: dá para ler, mas
    // salvar gravaria os � no lugar dos bytes. Sem `hash`, o editor abre só para leitura.
    const editable = !truncated && isUtf8(buffer);
    return { kind: 'text', size: info.size, content: buffer.toString('utf8'), truncated, ...(editable ? { hash: hashOf(buffer) } : {}) };
  } finally {
    await handle.close();
  }
}

/** Caminho validado e tipo do arquivo original (imagens, PDF), para servir como está. */
export async function rawProjectFile(root: string, rel: string): Promise<{ path: string; mediaType: string }> {
  const full = await resolveInside(root, rel);
  const info = await stat(full);
  if (!info.isFile()) throw new HttpError(400, 'not_a_file');
  if (info.size > MAX_RAW_BYTES) throw new HttpError(413, 'file_too_large');
  return { path: full, mediaType: MEDIA_TYPES[extname(full).toLowerCase()] ?? 'text/plain; charset=utf-8' };
}

/**
 * Grava o texto editado no painel por cima do arquivo, que precisa já existir. `base` é o hash dele
 * quando o app o leu: se mudou desde então (o Claude ou outro editor mexeu nele), recusa em vez de
 * apagar a mudança, a não ser com `force` (quem pediu viu o aviso e escolheu manter o seu). Grava no
 * lugar, e não num temporário renomeado: o arquivo segue o mesmo, com as permissões, os links e quem o observa.
 */
export async function saveProjectFile(
  root: string,
  rel: string,
  content: string,
  base: string,
  force: boolean,
): Promise<{ hash: string; size: number }> {
  const full = await resolveInside(root, rel);
  const info = await stat(full);
  if (!info.isFile()) throw new HttpError(400, 'not_a_file');
  if (info.size > MAX_TEXT_BYTES) throw new HttpError(413, 'file_too_large');
  const current = await readFile(full);
  if (!isUtf8(current)) throw new HttpError(415, 'not_utf8');
  if (!force) {
    const hash = hashOf(current);
    if (hash !== base) throw new HttpError(409, 'file_changed', { hash });
  }
  const data = Buffer.from(content, 'utf8');
  await writeFile(full, data);
  return { hash: hashOf(data), size: data.length };
}

/**
 * Chama `onChange` com o hash do arquivo agora e a cada vez que ele muda no disco (`null` se sumiu),
 * para o editor do painel acompanhar o que o Claude grava nele. Observa a pasta, e não o arquivo: quem
 * grava num temporário e renomeia troca o arquivo, e o aviso de um arquivo trocado se perde. Devolve
 * quem para de observar.
 */
export async function watchProjectFile(root: string, rel: string, onChange: (hash: string | null) => void): Promise<() => void> {
  const full = await resolveInside(root, rel);
  const name = basename(full);
  // A pasta inteira também pode sair do lugar (para a lixeira do explorador): aí o aviso vem com o nome dela.
  const folder = basename(dirname(full));
  let last: string | null | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    const hash = await readFile(full).then(hashOf, () => null);
    if (hash === last) return;
    last = hash;
    onChange(hash);
  };
  // Uma gravação chega em vários avisos seguidos (truncar, escrever, renomear): confere uma vez só, no fim.
  const watcher = watch(dirname(full), (_event, file) => {
    if (file && file !== name && file !== folder) return;
    clearTimeout(timer);
    timer = setTimeout(() => void check(), 80);
  });
  // A pasta apagada: o aviso de `null` já saiu pelo `check`, e não há mais o que observar.
  watcher.on('error', () => watcher.close());
  await check();
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

// ---- criar e apagar pelo painel ----

/**
 * Apagar pelo painel não é definitivo: o arquivo ou a pasta vai inteiro para esta lixeira do edit.r,
 * como as skills (claude-trash) e a memória (memory-trash), e o id devolvido o põe de volta no mesmo
 * lugar (o Desfazer). A do sistema (`gio trash`) não diz onde guardou cada coisa, e não existe fora do
 * Linux nem num /tmp: aqui o id basta. Some sozinho depois de TRASH_DAYS.
 */
const TRASH = process.env.FILES_TRASH_DIR ?? join(DATA_DIR, 'files-trash');
const TRASH_DAYS = 30;
const DAY = 86_400_000;
const TRASH_ID = /^[0-9a-f-]{36}$/;
// Na caixa de cada id, o que foi apagado tem sempre este nome: o nome original fica no meta.json.
const ITEM = 'item';
// Contar o que tem numa pasta, para a confirmação, para aqui: de um node_modules ninguém precisa do número exato.
const COUNT_MAX = 10_000;

type Trashed = { id: string; root: string; path: string; type: 'dir' | 'file'; deletedAt: number };

/** A `.git` (pasta, ou o arquivo de um worktree) é do git: o painel não cria nem apaga nada nela. */
const isGitPart = (part: string) => part === '.git';

/** Os pedaços de um caminho novo (`a/b/c.ts`): relativo, sem pedaço vazio, "." ou "..". */
function newPathParts(rel: string): string[] {
  const parts = rel.split('/');
  if (rel.startsWith('/') || parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\0') || Buffer.byteLength(p) > 255)) {
    throw new HttpError(400, 'invalid_name');
  }
  if (parts.some(isGitPart)) throw new HttpError(403, 'protected_path');
  return parts;
}

const missing = (err: unknown) => {
  if (err instanceof HttpError && err.status === 404) return null;
  throw err;
};

/**
 * A pasta `parts` do projeto, criando o que faltar dela. O pedaço que já existe passa por resolveInside
 * (um link para fora barra aqui); o resto nasce dentro dele, e por isso também fica no projeto.
 */
async function ensureDir(realRoot: string, parts: string[]): Promise<string> {
  let i = parts.length;
  let dir = await resolveInside(realRoot, parts.join('/')).catch(missing);
  while (!dir) dir = await resolveInside(realRoot, parts.slice(0, --i).join('/')).catch(missing);
  if (!(await stat(dir)).isDirectory()) throw new HttpError(409, 'not_a_directory', { path: relative(realRoot, dir) });
  for (const part of parts.slice(i)) {
    dir = join(dir, part);
    await mkdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
  }
  return dir;
}

/** Erros do disco que o app sabe explicar; o resto segue como está. */
function diskError(err: unknown, realRoot: string, full: string): never {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EEXIST') throw new HttpError(409, 'file_exists', { path: relative(realRoot, full) });
  if (code === 'ENOTDIR') throw new HttpError(409, 'not_a_directory', { path: relative(realRoot, dirname(full)) });
  if (code === 'EACCES' || code === 'EPERM') throw new HttpError(403, 'permission_denied', { path: relative(realRoot, full) || '.' });
  throw err;
}

/**
 * Cria um arquivo vazio ou uma pasta; com subpastas no caminho (`a/b/c.ts`), cria as que faltam.
 * Nunca por cima: o que já existe (até um link quebrado) recusa com `file_exists`.
 */
export async function createProjectEntry(root: string, rel: string, type: 'dir' | 'file'): Promise<{ path: string }> {
  const parts = newPathParts(rel);
  const realRoot = await realpath(root);
  let full = join(realRoot, rel);
  try {
    full = join(await ensureDir(realRoot, parts.slice(0, -1)), parts.at(-1)!);
    if (type === 'dir') await mkdir(full);
    else await writeFile(full, '', { flag: 'wx' });
  } catch (err) {
    diskError(err, realRoot, full);
  }
  return { path: relative(realRoot, full) };
}

/**
 * O item do projeto em si, sem seguir um link no fim do caminho: apagar um link leva o link, não o que
 * ele aponta. A raiz do projeto e o que fica fora dela não servem.
 */
async function entryInside(root: string, rel: string): Promise<{ realRoot: string; full: string; path: string; type: 'dir' | 'file' }> {
  const norm = normalize(rel);
  if (!rel || norm === '.') throw new HttpError(403, 'project_root');
  if (isAbsolute(norm) || norm === '..' || norm.startsWith(`..${sep}`)) throw new HttpError(403, 'outside_project');
  if (norm.split(sep).some(isGitPart)) throw new HttpError(403, 'protected_path');
  const realRoot = await realpath(root);
  const full = join(await resolveInside(realRoot, dirname(norm)), basename(norm));
  const info = await lstat(full).catch(() => {
    throw new HttpError(404, 'not_found');
  });
  return { realRoot, full, path: relative(realRoot, full), type: info.isDirectory() ? 'dir' : 'file' };
}

/** Quantos itens (arquivos e pastas, a fundo) tem a pasta, até COUNT_MAX; links não são seguidos. */
async function countInside(dir: string): Promise<{ items: number; capped: boolean }> {
  let items = 0;
  const queue = [dir];
  while (queue.length) {
    const dirents = await readdir(queue.pop()!, { withFileTypes: true }).catch(() => []);
    for (const d of dirents) {
      if (++items >= COUNT_MAX) return { items, capped: true };
      if (d.isDirectory()) queue.push(join(d.parentPath, d.name));
    }
  }
  return { items, capped: false };
}

/** O que vai para a lixeira, para a confirmação dizer: arquivo ou pasta, e quantos itens ela tem. */
export async function projectEntryInfo(root: string, rel: string): Promise<{ path: string; type: 'dir' | 'file'; items?: number; capped?: boolean }> {
  const { full, path, type } = await entryInside(root, rel);
  return type === 'dir' ? { path, type, ...(await countInside(full)) } : { path, type };
}

/** A cópia chegou inteira, mas parte da origem não saiu (sem permissão numa subpasta). */
class PartlyMoved extends Error {}

// O projeto e a lixeira podem estar em discos diferentes (um projeto no /tmp): aí o rename não serve.
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // Os links voltam como eram (relativos inclusive), e as datas também.
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
    await rm(from, { recursive: true, force: true }).catch(() => {
      throw new PartlyMoved();
    });
  }
}

async function readTrashed(id: string): Promise<Trashed | null> {
  if (!TRASH_ID.test(id)) return null;
  try {
    return JSON.parse(await readFile(join(TRASH, id, 'meta.json'), 'utf8')) as Trashed;
  } catch {
    return null;
  }
}

/** Tira da lixeira o que passou de TRASH_DAYS. Caixa sem meta.json pode ser uma nascendo agora: fica. */
async function purgeTrash(): Promise<void> {
  const now = Date.now();
  for (const id of await readdir(TRASH).catch(() => [] as string[])) {
    const meta = await readTrashed(id);
    if (meta && now - meta.deletedAt > TRASH_DAYS * DAY) await rm(join(TRASH, id), { recursive: true, force: true });
  }
}

/** Manda o arquivo ou a pasta (inteira) para a lixeira do edit.r; o `id` devolvido o põe de volta. */
export async function trashProjectEntry(root: string, rel: string): Promise<{ id: string; path: string; type: 'dir' | 'file' }> {
  const { realRoot, full, path, type } = await entryInside(root, rel);
  // O projeto é a pasta pessoal e o item, o ~/.local: a lixeira iria para dentro dela mesma.
  if (TRASH === full || TRASH.startsWith(full + sep)) throw new HttpError(409, 'trash_inside');
  void purgeTrash().catch(() => {});
  const id = randomUUID();
  const box = join(TRASH, id);
  await mkdir(box, { recursive: true, mode: 0o700 });
  try {
    const meta: Trashed = { id, root: realRoot, path, type, deletedAt: Date.now() };
    await writeFile(join(box, 'meta.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
    await move(full, join(box, ITEM));
  } catch (err) {
    // A cópia inteira está na caixa e parte do original já se foi: a caixa fica, senão nada teria volta.
    if (err instanceof PartlyMoved) throw new HttpError(500, 'trash_partial', { path });
    await rm(box, { recursive: true, force: true });
    diskError(err, realRoot, full);
  }
  return { id, path, type };
}

/** Desfaz: o item volta para onde estava (recriando as pastas de cima, se foram junto), nunca por cima de outro. */
export async function restoreProjectEntry(root: string, id: string): Promise<{ path: string; type: 'dir' | 'file' }> {
  const meta = await readTrashed(id);
  const realRoot = await realpath(root);
  if (!meta || meta.root !== realRoot) throw new HttpError(404, 'trash_not_found');
  const parts = meta.path.split(sep);
  let dest = join(realRoot, meta.path);
  try {
    dest = join(await ensureDir(realRoot, parts.slice(0, -1)), parts.at(-1)!);
    if (await lstat(dest).then(() => true, () => false)) throw new HttpError(409, 'restore_exists', { path: meta.path });
    await move(join(TRASH, id, ITEM), dest);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Voltou inteiro, e o que sobrou na caixa sai com ela, logo abaixo.
    if (!(err instanceof PartlyMoved)) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'trash_not_found');
      diskError(err, realRoot, dest);
    }
  }
  await rm(join(TRASH, id), { recursive: true, force: true });
  return { path: relative(realRoot, dest), type: meta.type };
}
