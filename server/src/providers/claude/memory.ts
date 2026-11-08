import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DATA_DIR } from '../../config.ts';
import { CLAUDE_HOME } from './env.ts';
import { HttpError } from '../../errors.ts';
import { readFields, setField, splitFrontmatter } from '../../frontmatter.ts';
import { SAFE_ID } from './transcript.ts';

/**
 * A memória automática do Claude Code: em ~/.claude/projects/<pasta>/memory, um arquivo por
 * lembrança, com cabeçalho (nome, descrição, tipo), e o índice MEMORY.md, que o Claude lê no começo
 * de cada conversa naquele projeto. Aqui ela é listada com o que pede limpeza, editada e mandada para
 * uma lixeira do cald, de onde volta igual, com a linha do índice no mesmo lugar.
 */

const PROJECTS = join(CLAUDE_HOME, 'projects');
// Dado seu, como o TODO: fica com os dados do app. Some sozinho depois de TRASH_DAYS.
const TRASH = process.env.MEMORY_TRASH_DIR ?? join(DATA_DIR, 'memory-trash');
const INDEX = 'MEMORY.md';
const DAY = 86_400_000;
const STALE_DAYS = 60;
const TRASH_DAYS = 30;
/** O Claude Code só lê o começo do índice: o que passa destas linhas não chega a ele. */
export const INDEX_LIMIT = 200;

const FOLDER = /^-[A-Za-z0-9-]{0,254}$/;
const FILE = /^[\w.-]{1,200}\.md$/;
const INDEX_LINK = /\]\((?:\.\/)?([^)\s/]+\.md)\)/g;
const WIKI_LINK = /\[\[([^\]\n|#]+)(?:[|#][^\]\n]*)?\]\]/g;

export const MAX_MEMORY_TEXT = 100_000;
export const MAX_MEMORY_DESCRIPTION = 1_000;

/**
 * O que pede limpeza: `stale`, sem mudar há STALE_DAYS; `orphan`, o projeto não existe mais;
 * `unindexed`, fora do MEMORY.md (o Claude não a vê); `broken-link`, um `[[nome]]` sem memória.
 */
export type MemorySignal = 'stale' | 'orphan' | 'unindexed' | 'broken-link';

export type Memory = {
  file: string;
  name: string;
  description: string;
  type: string | null;
  body: string;
  /** Quando mudou: o `modified` do cabeçalho ou, sem ele, a data do arquivo. */
  modified: number;
  /** A data do arquivo, que volta na edição: se mudou no meio, quem editou foi outro (o Claude). */
  mtime: number;
  /** A conversa que a criou, e se ela ainda existe (o Claude Code apaga as antigas). */
  origin: string | null;
  originExists: boolean;
  links: string[];
  brokenLinks: string[];
  /** Os arquivos das memórias que apontam para esta com `[[nome]]`. */
  citedBy: string[];
  indexed: boolean;
  signals: MemorySignal[];
};

export type MemoryFolder = {
  /** O nome da pasta em ~/.claude/projects. */
  folder: string;
  /** A pasta da memória, para o Claude achar quando o app pede uma revisão. */
  dir: string;
  /** O projeto dela; null quando a pasta dele não existe mais. */
  cwd: string | null;
  /** Linhas do MEMORY.md (o Claude lê só as primeiras INDEX_LIMIT); null sem índice. */
  indexLines: number | null;
  /** Arquivos que o índice cita e não existem. */
  missing: string[];
  memories: Memory[];
};

export type TrashedMemory = {
  id: string;
  folder: string;
  cwd: string | null;
  file: string;
  name: string;
  description: string;
  deletedAt: number;
};

// Cada linha do índice que apontava para ela, com a posição, para voltar ao mesmo lugar.
type TrashMeta = TrashedMemory & { index: { at: number; line: string }[] };

/** O nome da pasta de um projeto em ~/.claude/projects: o caminho com tudo que não é letra ou número trocado por "-". */
export const folderOf = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-');

/**
 * O caminho de volta, que a troca por "-" não guarda (`abraz-dev` ou `abraz/dev`?): desce pelo
 * disco a partir da raiz, pelas pastas cujo nome trocado bate com o começo do que falta. Sem caminho
 * que bata, o projeto não existe mais (worktree removido, pasta apagada). `dirs` guarda as leituras
 * de pasta de uma listagem inteira, porque os projetos dividem quase todo o caminho.
 */
async function projectOf(folder: string, dirs: Map<string, Promise<string[]>>): Promise<string | null> {
  const children = (dir: string) => {
    let hit = dirs.get(dir);
    if (!hit) {
      hit = readdir(dir, { withFileTypes: true }).then(
        (entries) => entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name),
        () => [],
      );
      dirs.set(dir, hit);
    }
    return hit;
  };
  const walk = async (dir: string, rest: string): Promise<string | null> => {
    if (!rest) return dir;
    for (const name of await children(dir)) {
      const part = `-${folderOf(name)}`;
      if (rest !== part && !rest.startsWith(`${part}-`)) continue;
      const found = await walk(join(dir, name), rest.slice(part.length));
      if (found) return found;
    }
    return null;
  };
  return walk('/', folder);
}

// As conversas que ainda existem, para o "de onde veio" de cada memória. A aba de cada projeto em foco
// pede a lista, então ela fica guardada um pouco: conversa nova não muda o que já foi guardado antes dela.
const SESSIONS_TTL = 60_000;
let sessionsCache: { at: number; ids: Promise<Set<string>> } | undefined;
function sessionIds(): Promise<Set<string>> {
  if (sessionsCache && Date.now() - sessionsCache.at < SESSIONS_TTL) return sessionsCache.ids;
  const ids = (async () => {
    const found = new Set<string>();
    for (const project of await readdir(PROJECTS).catch(() => [])) {
      for (const name of await readdir(join(PROJECTS, project)).catch(() => [])) if (name.endsWith('.jsonl')) found.add(name.slice(0, -6));
    }
    return found;
  })();
  sessionsCache = { at: Date.now(), ids };
  return ids;
}

const indexed = (line: string) => [...line.matchAll(INDEX_LINK)].map((m) => m[1]);
const stem = (file: string) => file.slice(0, -3);

async function readMemory(dir: string, file: string): Promise<Memory | null> {
  const path = join(dir, file);
  const [info, text] = await Promise.all([stat(path).catch(() => null), readFile(path, 'utf8').catch(() => null)]);
  if (!info?.isFile() || text === null) return null;
  const parts = splitFrontmatter(text);
  const fields = readFields(parts?.head ?? []);
  const body = parts ? parts.body : text;
  const origin = fields['metadata.originSessionId'] ?? fields.originSessionId ?? null;
  const mtime = Math.floor(info.mtimeMs);
  return {
    file,
    name: fields.name || stem(file),
    description: fields.description ?? '',
    type: fields['metadata.type'] ?? fields.type ?? null,
    body,
    modified: Date.parse(fields['metadata.modified'] ?? fields.modified ?? '') || mtime,
    mtime,
    origin: origin && SAFE_ID.test(origin) ? origin : null,
    originExists: false,
    links: [...new Set([...body.matchAll(WIKI_LINK)].map((m) => m[1].trim()))],
    brokenLinks: [],
    citedBy: [],
    indexed: false,
    signals: [],
  };
}

type Context = { dirs: Map<string, Promise<string[]>>; sessions: Set<string>; now: number };

async function readFolder(folder: string, ctx: Context, cwdKnown?: string): Promise<MemoryFolder | null> {
  const dir = join(PROJECTS, folder, 'memory');
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n !== INDEX && FILE.test(n));
  const index = await readFile(join(dir, INDEX), 'utf8').catch(() => null);
  if (!names.length && index === null) return null;
  const lines = index === null ? [] : index.replace(/\n+$/, '').split('\n');
  const listed = new Set(lines.flatMap(indexed));
  const [cwd, read] = await Promise.all([cwdKnown ?? projectOf(folder, ctx.dirs), Promise.all(names.map((n) => readMemory(dir, n)))]);
  const memories = read.filter((m): m is Memory => m !== null);
  const known = new Set(memories.flatMap((m) => [m.name, stem(m.file)]));
  for (const m of memories) {
    const names = [m.name, stem(m.file)];
    m.brokenLinks = m.links.filter((l) => !known.has(l));
    m.citedBy = memories.filter((o) => o !== m && o.links.some((l) => names.includes(l))).map((o) => o.file);
    m.indexed = listed.has(m.file);
    m.originExists = m.origin !== null && ctx.sessions.has(m.origin);
    if (ctx.now - m.modified > STALE_DAYS * DAY) m.signals.push('stale');
    if (!cwd) m.signals.push('orphan');
    if (!m.indexed) m.signals.push('unindexed');
    if (m.brokenLinks.length) m.signals.push('broken-link');
  }
  memories.sort((a, b) => b.modified - a.modified);
  return {
    folder,
    dir,
    cwd,
    indexLines: index === null ? null : lines.length,
    missing: [...listed].filter((f) => !names.includes(f)),
    memories,
  };
}

/**
 * As memórias de todos os projetos desta máquina ou, com `cwd`, só as dele; e a lixeira (também só a
 * dele, com `cwd`). Passar por aqui já tira da lixeira o que passou de TRASH_DAYS.
 */
export async function listMemory(cwd?: string): Promise<{ folders: MemoryFolder[]; trash: TrashedMemory[] }> {
  const ctx: Context = { dirs: new Map(), sessions: await sessionIds(), now: Date.now() };
  const only = cwd ? folderOf(cwd) : null;
  const names = only ? [only] : await readdir(PROJECTS).catch(() => [] as string[]);
  // Com `cwd`, o projeto já se sabe: não precisa descer pelo disco.
  const folders = (await Promise.all(names.filter((f) => FOLDER.test(f)).map((f) => readFolder(f, ctx, cwd)))).filter(
    (f): f is MemoryFolder => f !== null,
  );
  // Os de projeto que não existe mais vão para o fim.
  folders.sort((a, b) => Number(!a.cwd) - Number(!b.cwd) || (a.cwd ?? a.folder).localeCompare(b.cwd ?? b.folder));
  const trash = await listTrash();
  return { folders, trash: only ? trash.filter((t) => t.folder === only) : trash };
}

function memoryPath(folder: string, file: string): string {
  if (!FOLDER.test(folder) || !FILE.test(file) || file === INDEX) throw new HttpError(400, 'invalid_memory');
  return join(PROJECTS, folder, 'memory', file);
}

// Gravação atômica, como em todos os stores do cald: um temporário renomeado por cima.
async function atomicWrite(path: string, text: string): Promise<void> {
  await writeFile(`${path}.cald-tmp`, text);
  await rename(`${path}.cald-tmp`, path);
}

// ~/.claude e ~/.local podem estar em discos diferentes: aí o rename não serve.
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await unlink(from);
  }
}

// Para devolver da lixeira: nunca por cima de um arquivo que apareceu com o mesmo nome (o Claude pode
// ter criado outra memória assim). `link` falha se o destino existe; entre discos, a cópia exclusiva.
async function moveNew(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new HttpError(409, 'memory_exists', { file: basename(to) });
    if (code !== 'EXDEV' && code !== 'EPERM') throw err;
    await copyFile(from, to, constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => {
      throw e.code === 'EEXIST' ? new HttpError(409, 'memory_exists', { file: basename(to) }) : e;
    });
  }
  await unlink(from);
}

const readIndex = (folder: string) =>
  readFile(join(PROJECTS, folder, 'memory', INDEX), 'utf8').then(
    (text) => text.split('\n'),
    () => null,
  );
const writeIndex = (folder: string, lines: string[]) => atomicWrite(join(PROJECTS, folder, 'memory', INDEX), lines.join('\n'));

// Uma mudança por vez: duas mexendo no mesmo índice ao mesmo tempo perderiam uma linha.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Grava a descrição e o texto, mantendo o resto do cabeçalho, e marca o `modified`. `mtime` é a data
 * do arquivo quando o app o leu: se mudou desde então (o Claude mexeu nela), recusa em vez de
 * apagar a mudança dele.
 */
export function saveMemory(input: { folder: string; file: string; description: string; body: string; mtime: number }): Promise<{ mtime: number }> {
  return serial(async () => {
    const path = memoryPath(input.folder, input.file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, 'memory_not_found');
    if (Math.floor(info.mtimeMs) !== input.mtime) throw new HttpError(409, 'memory_changed');
    const parts = splitFrontmatter(await readFile(path, 'utf8'));
    let head = parts?.head ?? [`name: ${JSON.stringify(stem(input.file))}`];
    head = setField(head, 'description', input.description.replace(/\s+/g, ' ').trim(), true);
    head = setField(head, 'metadata.modified', new Date().toISOString());
    await atomicWrite(path, `---\n${head.join('\n')}\n---\n\n${input.body.trim()}\n`);
    return { mtime: Math.floor((await stat(path)).mtimeMs) };
  });
}

export const MEMORY_INDEX = INDEX;

/**
 * O arquivo que um Write ou Edit do Claude vai gravar, se for da memória: um arquivo direto na pasta
 * de memória de um projeto em ~/.claude/projects, o índice (MEMORY.md) inclusive.
 */
export function memoryTarget(path: string): { folder: string; file: string } | null {
  const full = resolve(path);
  const dir = dirname(full);
  if (basename(dir) !== 'memory' || dirname(dirname(dir)) !== PROJECTS) return null;
  const folder = basename(dirname(dir));
  const file = basename(full);
  return FOLDER.test(folder) && FILE.test(file) ? { folder, file } : null;
}

/** Os arquivos que um texto de índice cita. */
export const indexLinks = (text: string) => new Set(text.split('\n').flatMap(indexed));

/** O texto de uma memória (ou do índice) e a data do arquivo; null se ele não existe. */
export async function readMemoryFile(folder: string, file: string): Promise<{ text: string; mtime: number } | null> {
  if (!FOLDER.test(folder) || !FILE.test(file)) throw new HttpError(400, 'invalid_memory');
  const path = join(PROJECTS, folder, 'memory', file);
  const [info, text] = await Promise.all([stat(path).catch(() => null), readFile(path, 'utf8').catch(() => null)]);
  return info?.isFile() && text !== null ? { text, mtime: Math.floor(info.mtimeMs) } : null;
}

/**
 * Grava uma memória que o Claude sugeriu e você aceitou (ver memory-suggestions.ts), com a linha dela
 * no fim do índice se ainda não houver uma. `base`: a data do arquivo quando a sugestão chegou, ou
 * null se ela era nova; se ele mudou (ou apareceu) desde então, recusa em vez de passar por cima.
 */
export function addMemory(input: { folder: string; file: string; text: string; base: number | null; line: string }): Promise<void> {
  return serial(async () => {
    const path = memoryPath(input.folder, input.file);
    const info = await stat(path).catch(() => null);
    if (input.base === null && info) throw new HttpError(409, 'memory_exists', { file: input.file });
    if (input.base !== null && (!info || Math.floor(info.mtimeMs) !== input.base)) throw new HttpError(409, 'memory_changed');
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, input.text);
    const lines = (await readIndex(input.folder)) ?? [''];
    if (lines.some((l) => indexed(l).includes(input.file))) return;
    lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, input.line);
    await writeIndex(input.folder, lines);
  });
}

/**
 * Tira do índice a linha de uma memória que não existe: o Claude pode pôr a linha junto da memória
 * que virou sugestão, e ela fica apontando para o nada quando a sugestão é recusada.
 */
export function dropIndexLine(folder: string, file: string): Promise<void> {
  return serial(async () => {
    if (await stat(memoryPath(folder, file)).catch(() => null)) return;
    const lines = await readIndex(folder);
    if (!lines?.some((l) => onlyFor(l, file))) return;
    await writeIndex(folder, lines.filter((l) => !onlyFor(l, file)));
  });
}

// A linha do índice que é só desta memória. Uma linha que cita outras também fica: tirá-la
// esconderia as outras do Claude.
const onlyFor = (line: string, file: string) => {
  const files = indexed(line);
  return files.length > 0 && files.every((f) => f === file);
};

/** Manda para a lixeira do cald, tirando do índice as linhas que apontavam para ela. Devolve os ids na lixeira. */
export function trashMemories(items: { folder: string; file: string }[]): Promise<string[]> {
  return serial(async () => {
    // Repetidas saem uma vez; e todas são conferidas antes de mexer em qualquer uma.
    const unique = [...new Map(items.map((i) => [`${i.folder}/${i.file}`, i])).values()];
    const texts = await Promise.all(unique.map(({ folder, file }) => readFile(memoryPath(folder, file), 'utf8').catch(() => null)));
    if (texts.some((t) => t === null)) throw new HttpError(404, 'memory_not_found');
    const ids: string[] = [];
    const dirs = new Map<string, Promise<string[]>>();
    for (const [n, { folder, file }] of unique.entries()) {
      const fields = readFields(splitFrontmatter(texts[n]!)?.head ?? []);
      const id = randomUUID();
      const box = join(TRASH, id);
      await mkdir(box, { recursive: true });
      await move(memoryPath(folder, file), join(box, file));
      // O índice é lido e regravado em seguida, para não perder uma linha que o Claude tenha acabado de pôr.
      const lines = await readIndex(folder);
      const index: TrashMeta['index'] = [];
      const kept: string[] = [];
      lines?.forEach((line, at) => (onlyFor(line, file) ? index.push({ at, line }) : kept.push(line)));
      if (index.length) await writeIndex(folder, kept);
      const meta: TrashMeta = {
        id,
        folder,
        cwd: await projectOf(folder, dirs),
        file,
        name: fields.name || stem(file),
        description: fields.description ?? '',
        deletedAt: Date.now(),
        index,
      };
      await atomicWrite(join(box, 'meta.json'), JSON.stringify(meta, null, 2));
      ids.push(id);
    }
    return ids;
  });
}

async function readTrash(id: string): Promise<TrashMeta | null> {
  if (!SAFE_ID.test(id)) return null;
  try {
    return JSON.parse(await readFile(join(TRASH, id, 'meta.json'), 'utf8')) as TrashMeta;
  } catch {
    // Sem meta (a gravação parou no meio): o arquivo continua na pasta, mas fica fora da lista.
    return null;
  }
}

/** Devolve da lixeira, com as linhas do índice no lugar de antes (ou no fim, se o índice encolheu). */
export function restoreMemories(ids: string[]): Promise<void> {
  return serial(async () => {
    for (const id of ids) {
      const meta = await readTrash(id);
      if (!meta) throw new HttpError(404, 'memory_not_found');
      const path = memoryPath(meta.folder, meta.file);
      await mkdir(join(PROJECTS, meta.folder, 'memory'), { recursive: true });
      await moveNew(join(TRASH, id, meta.file), path);
      const lines = (await readIndex(meta.folder)) ?? [''];
      const missing = meta.index.filter((i) => !lines.some((l) => indexed(l).includes(meta.file)));
      for (const { at, line } of missing) lines.splice(Math.min(at, lines.at(-1) === '' ? lines.length - 1 : lines.length), 0, line);
      if (missing.length) await writeIndex(meta.folder, lines);
      await rm(join(TRASH, id), { recursive: true, force: true });
    }
  });
}

/** Apaga de vez: as escolhidas ou, sem `ids`, a lixeira inteira. */
export function emptyTrash(ids?: string[]): Promise<void> {
  return serial(async () => {
    const all = ids ?? (await readdir(TRASH).catch(() => [] as string[]));
    await Promise.all(all.filter((id) => SAFE_ID.test(id)).map((id) => rm(join(TRASH, id), { recursive: true, force: true })));
  });
}

async function listTrash(): Promise<TrashedMemory[]> {
  const now = Date.now();
  const out: TrashedMemory[] = [];
  for (const id of await readdir(TRASH).catch(() => [] as string[])) {
    const meta = await readTrash(id);
    if (!meta) continue;
    if (now - meta.deletedAt > TRASH_DAYS * DAY) {
      await rm(join(TRASH, id), { recursive: true, force: true });
      continue;
    }
    const { index: _, ...item } = meta;
    out.push(item);
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}
