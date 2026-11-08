import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CLAUDE_HOME } from './env.ts';

// IDs viram nomes de arquivo: nada de `..` nem `/`.
export const SAFE_ID = /^[\w-]{1,64}$/;

export type TranscriptFile = { path: string; size: number; mtimeMs: number };

/** Onde cada conversa já foi achada: o arquivo não muda de pasta. */
const paths = new Map<string, string>();

/**
 * ~/.claude/projects/<projeto>/<sessão>.jsonl, com tamanho e data. Procura em todos os projetos só
 * na primeira vez; depois confere o caminho achado e, se o arquivo sumiu de lá, procura de novo.
 */
export async function transcriptFile(sessionId: string): Promise<TranscriptFile | null> {
  if (!SAFE_ID.test(sessionId)) return null;
  const known = paths.get(sessionId);
  if (known) {
    const info = await stat(known).catch(() => null);
    if (info?.isFile()) return { path: known, size: info.size, mtimeMs: info.mtimeMs };
    paths.delete(sessionId);
  }
  const root = join(CLAUDE_HOME, 'projects');
  for (const project of await readdir(root).catch(() => [])) {
    const path = join(root, project, `${sessionId}.jsonl`);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    paths.set(sessionId, path);
    return { path, size: info.size, mtimeMs: info.mtimeMs };
  }
  return null;
}

export async function transcriptPath(sessionId: string): Promise<string | null> {
  return (await transcriptFile(sessionId))?.path ?? null;
}

/** Só os encontrados: a pasta de uma conversa não muda depois da primeira mensagem. */
const cwds = new Map<string, string>();

/**
 * Pasta da conversa lida do próprio transcript. O SDK só procura o `cwd` nos primeiros 64 KiB
 * do arquivo; quando a primeira mensagem traz uma imagem, ele fica além disso e a conversa
 * aparece sem projeto (e não reabre no painel).
 */
export async function transcriptCwd(sessionId: string): Promise<string | undefined> {
  const known = cwds.get(sessionId);
  if (known) return known;
  const path = await transcriptPath(sessionId);
  const cwd = path ? await firstCwd(path) : undefined;
  if (cwd) cwds.set(sessionId, cwd);
  return cwd;
}

async function firstCwd(path: string): Promise<string | undefined> {
  const input = createReadStream(path);
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!line.includes('"cwd"')) continue;
      try {
        const { cwd } = JSON.parse(line) as { cwd?: unknown };
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch {
        // Linha cortada (o Claude Code ainda está gravando): segue para a próxima.
      }
    }
    return undefined;
  } finally {
    input.destroy();
  }
}

/**
 * Passa a `onLine` as linhas completas de `path` a partir do byte `start` e devolve onde a última
 * terminou. Uma linha sem `\n` no fim (o Claude Code ainda está gravando) fica para a próxima leitura.
 */
async function readLines(path: string, start: number, onLine: (line: string) => void): Promise<number> {
  let end = start;
  let pending: Buffer[] = [];
  for await (const chunk of createReadStream(path, { start }) as AsyncIterable<Buffer>) {
    let from = 0;
    for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, from)) {
      const piece = chunk.subarray(from, nl);
      // Linha que começou num pedaço anterior: junta tudo de uma vez só quando ela fecha.
      const line = pending.length ? Buffer.concat([...pending, piece]) : piece;
      pending = [];
      end += line.length + 1;
      onLine(line.toString('utf8'));
      from = nl + 1;
    }
    if (from < chunk.length) pending.push(chunk.subarray(from));
  }
  return end;
}

/**
 * Soma feita linha a linha sobre transcripts, guardada junto com o ponto até onde cada arquivo foi
 * lido. O Claude Code só acrescenta linhas no fim: quando o arquivo cresce, lê só o trecho novo
 * (os da sessão passam de 60 MB); se ele encolher ou for trocado por outro, refaz do zero.
 */
export class TranscriptTally<T> {
  private readonly files = new Map<string, { ino: number; size: number; mtimeMs: number; done: Promise<{ state: T; end: number }> }>();
  private readonly add: (state: T, line: string) => void;

  constructor(add: (state: T, line: string) => void) {
    this.add = add;
  }

  /** A soma até o fim atual de `path`; `fresh` dá o estado vazio quando é preciso começar do zero. */
  async read(path: string, fresh: () => T): Promise<T> {
    const info = await stat(path);
    const hit = this.files.get(path);
    if (hit && hit.ino === info.ino && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return (await hit.done).state;
    // Leituras do mesmo arquivo vão em fila: cada uma continua de onde a anterior parou.
    const done = (async () => {
      const prev = hit?.ino === info.ino ? await hit.done.catch(() => null) : null;
      const base = prev && prev.end <= info.size ? prev : { state: fresh(), end: 0 };
      const end = await readLines(path, base.end, (line) => this.add(base.state, line));
      return { state: base.state, end };
    })();
    this.files.set(path, { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, done });
    done.catch(() => {
      if (this.files.get(path)?.done === done) this.files.delete(path);
    });
    return (await done).state;
  }
}

/** Quando uma mensagem sua foi gravada e quem a gravou (`cli`, `claude-vscode`, `sdk-ts`…). */
export type PromptMark = { at: number; entrypoint?: string };

/** O que o transcript tem ao lado de cada mensagem e o `getSessionMessages` não traz, por UUID. */
export type TranscriptMarks = { efforts: ReadonlyMap<string, string>; prompts: ReadonlyMap<string, PromptMark> };

/**
 * O Claude Code grava ao lado de cada resposta o esforço com que ela foi pensada (`perTurnEffort`,
 * quando o turno mudou o esforço, ou `effort`, o da sessão), e ao lado de cada mensagem sua a hora e
 * por onde ela entrou (`entrypoint`). O `getSessionMessages` do SDK não repassa nada disso: sai daqui,
 * lido só no trecho novo do arquivo.
 */
const marks = new TranscriptTally<{ efforts: Map<string, string>; prompts: Map<string, PromptMark> }>((state, line) => {
  if (line.includes('"type":"assistant"') && line.includes('ffort"')) {
    try {
      const d = JSON.parse(line) as { type?: string; uuid?: unknown; effort?: unknown; perTurnEffort?: unknown };
      const effort = d.perTurnEffort ?? d.effort;
      if (d.type === 'assistant' && typeof d.uuid === 'string' && typeof effort === 'string') state.efforts.set(d.uuid, effort);
    } catch {
      // Linha cortada (o Claude Code ainda está gravando): fica sem esforço.
    }
  }
  // Resultados de ferramenta também são "user", e são as linhas mais pesadas: ficam de fora sem parse.
  if (line.includes('"type":"user"') && !line.includes('"tool_use_id"')) {
    try {
      const d = JSON.parse(line) as { type?: string; uuid?: unknown; timestamp?: unknown; entrypoint?: unknown; isMeta?: unknown };
      const at = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN;
      if (d.type === 'user' && !d.isMeta && typeof d.uuid === 'string' && !Number.isNaN(at)) {
        state.prompts.set(d.uuid, { at, entrypoint: typeof d.entrypoint === 'string' ? d.entrypoint : undefined });
      }
    } catch {
      // Linha cortada: a mensagem fica sem hora.
    }
  }
});

const NO_MARKS: TranscriptMarks = { efforts: new Map(), prompts: new Map() };

export async function transcriptMarks(sessionId: string): Promise<TranscriptMarks> {
  const path = await transcriptPath(sessionId);
  return path ? marks.read(path, () => ({ efforts: new Map(), prompts: new Map() })).catch(() => NO_MARKS) : NO_MARKS;
}

/**
 * Quando cada mensagem foi gravada, por UUID. O `getSessionMessages` também não traz a hora; no
 * transcript, o `uuid` e o `timestamp` vêm juntos depois da mensagem, então sai por expressão regular,
 * sem desmontar o JSON de cada linha (os transcripts passam de 60 MB).
 */
const STAMP = /"uuid":"([^"]+)","timestamp":"([^"]+)"/;
const times = new TranscriptTally<Map<string, number>>((state, line) => {
  if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) return;
  const m = STAMP.exec(line);
  const at = m ? Date.parse(m[2]!) : NaN;
  if (m && !Number.isNaN(at)) state.set(m[1]!, at);
});

export async function transcriptTimes(sessionId: string): Promise<ReadonlyMap<string, number>> {
  const path = await transcriptPath(sessionId);
  return path ? times.read(path, () => new Map()).catch(() => new Map()) : new Map();
}
