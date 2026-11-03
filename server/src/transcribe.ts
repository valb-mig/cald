import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WHISPER_CLI, WHISPER_MODEL } from './config.ts';
import { HttpError } from './errors.ts';

const exec = promisify(execFile);

/** Áudio aceito: WAV de até ~10 min em 16 kHz mono (o navegador converte antes de mandar). */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 180_000;
// Deixa dois núcleos para o resto do PC; mais threads quase não aceleram.
const THREADS = Math.max(2, Math.min(10, availableParallelism() - 2));

/** Whisper instalado? Confere a cada pedido: instalar depois não exige reiniciar o servidor. */
export function whisperAvailable(): boolean {
  return existsSync(WHISPER_CLI) && existsSync(WHISPER_MODEL);
}

// O Whisper inventa frases em trechos de silêncio, quase sempre as mesmas (vêm das legendas com que
// foi treinado); e marca o que não é fala entre colchetes ou parênteses.
const HALLUCINATIONS = [
  /legendas? (pela|por) .*amara\.org/i,
  /^obrigad[oa] (por|pela) assistir/i,
  /^inscreva-se no canal/i,
  /^tchau[,.!]? tchau/i,
];
const NOT_SPEECH = /^[[(].*[\])]$/;

// Uma letra solta ("e", "a.") é ruído virando palavra, não ditado.
const LONE_LETTER = /^\p{L}[.!?…]?$/u;

export function cleanTranscript(raw: string): string {
  const text = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !NOT_SPEECH.test(line) && !HALLUCINATIONS.some((h) => h.test(line)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return LONE_LETTER.test(text) ? '' : text;
}

// Uma transcrição por vez: o modelo ocupa memória e todos os núcleos enquanto roda.
let queue: Promise<unknown> = Promise.resolve();

/** Texto falado num WAV, transcrito no próprio PC pelo whisper.cpp, em português. */
export function transcribe(wav: Buffer): Promise<string> {
  if (!whisperAvailable()) throw new HttpError(503, 'whisper_unavailable');
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new HttpError(400, 'invalid_audio');
  }
  const run = queue.then(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cald-voz-'));
    try {
      const file = join(dir, 'fala.wav');
      await writeFile(file, wav);
      const args = ['-m', WHISPER_MODEL, '-l', 'pt', '-t', String(THREADS), '-nt', '-np', '-sns', '-f', file];
      const { stdout } = await exec(WHISPER_CLI, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }).catch((err: { killed?: boolean; stderr?: string }) => {
        throw err.killed ? new HttpError(504, 'transcribe_timeout') : new HttpError(500, 'transcribe_failed', { detail: err.stderr?.slice(-500) });
      });
      return cleanTranscript(stdout);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  queue = run.catch(() => {});
  return run;
}
