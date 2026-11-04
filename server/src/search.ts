import { spawn } from 'node:child_process';
import { HttpError } from './errors.ts';

/**
 * A busca de texto nos arquivos do projeto, como o "Buscar" do VSCode: o ripgrep roda na hora, sem
 * índice, respeitando o .gitignore (e pulando o .git, os binários e os arquivos acima de 1 MB). Sem o
 * `rg` instalado no PC, a busca avisa.
 */

export type SearchMatch = {
  /** Contando de 1. */
  line: number;
  /** A linha para mostrar, cortada em volta do achado quando é comprida. */
  text: string;
  /** Os trechos achados em `text`, em caracteres. */
  ranges: [number, number][];
  /** O primeiro achado na linha inteira (coluna e tamanho, em caracteres), para o editor selecionar. */
  col: number;
  len: number;
};

export type SearchResult = { files: { path: string; matches: SearchMatch[] }[]; total: number; truncated: boolean };

export type SearchOptions = { regex: boolean; caseSensitive: boolean; word: boolean };

const MAX_MATCHES = 2_000;
const MAX_PER_FILE = 100;
const SHOWN = 240;
const BEFORE = 60;
const TIMEOUT_MS = 15_000;

type RgMatch = {
  type: string;
  data: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: { start: number; end: number }[];
  };
};

/** Posição em bytes (o que o ripgrep dá) para posição em caracteres do JavaScript. */
const charAt = (bytes: Buffer, at: number) => bytes.subarray(0, at).toString('utf8').length;

function toMatch(line: string, number: number, submatches: { start: number; end: number }[]): SearchMatch {
  const text = line.replace(/\r?\n$/, '');
  const bytes = Buffer.from(text, 'utf8');
  const ranges = submatches.map((s): [number, number] => [charAt(bytes, s.start), charAt(bytes, Math.min(s.end, bytes.length))]);
  const first = ranges[0] ?? [0, 0];
  // Linha longa (código minificado): só um pedaço em volta do primeiro achado.
  const from = text.length > SHOWN ? Math.max(0, first[0] - BEFORE) : 0;
  const cut = text.slice(from, from + SHOWN);
  const lead = from > 0 ? '…' : '';
  const shown = ranges
    .map(([a, b]): [number, number] => [a - from + lead.length, Math.min(b - from, cut.length) + lead.length])
    .filter(([a, b]) => b > a && a >= lead.length);
  return { line: number, text: lead + cut + (from + SHOWN < text.length ? '…' : ''), ranges: shown, col: first[0], len: first[1] - first[0] };
}

export function searchProject(cwd: string, query: string, opts: SearchOptions): Promise<SearchResult> {
  const args = [
    '--json',
    '--hidden',
    '--glob',
    '!.git',
    '--max-filesize',
    '1M',
    '--max-count',
    String(MAX_PER_FILE),
    '--sort',
    'path',
    opts.caseSensitive ? '--case-sensitive' : '--ignore-case',
    ...(opts.regex ? [] : ['--fixed-strings']),
    ...(opts.word ? ['--word-regexp'] : []),
    // Com `--regexp`, um termo que começa com "-" não vira opção do rg.
    '--regexp',
    query,
    '--',
    '.',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const files = new Map<string, SearchMatch[]>();
    let total = 0;
    let truncated = false;
    let rest = '';
    let stderr = '';
    const timer = setTimeout(() => {
      truncated = true;
      child.kill();
    }, TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (truncated) return;
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const raw of lines) {
        if (!raw.startsWith('{"type":"match"')) continue;
        const m = JSON.parse(raw) as RgMatch;
        const path = m.data.path?.text?.replace(/^\.\//, '');
        if (!path || m.data.lines?.text === undefined || !m.data.line_number) continue;
        const list = files.get(path) ?? [];
        files.set(path, list);
        list.push(toMatch(m.data.lines.text, m.data.line_number, m.data.submatches ?? []));
        total += m.data.submatches?.length || 1;
        if (total >= MAX_MATCHES) {
          // Achados demais: para aqui, e a tela pede um termo mais específico.
          truncated = true;
          child.kill();
          break;
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new HttpError(501, 'rg_unavailable') : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 1: nada achado. 2: algum erro; só a regex inválida vira aviso (um arquivo sem permissão não estraga a busca).
      if (code === 2 && !truncated && files.size === 0 && /regex|parse/i.test(stderr)) {
        return reject(new HttpError(400, 'invalid_search', { message: stderr.trim().split('\n').slice(-3).join('\n') }));
      }
      resolve({ files: [...files].map(([path, matches]) => ({ path, matches })), total, truncated });
    });
  });
}
