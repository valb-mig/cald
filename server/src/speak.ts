import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { PIPER_BIN, PIPER_VOICE } from './config.ts';
import { HttpError } from './errors.ts';

/** Texto aceito de uma vez: o app manda uma frase por pedido (ver web/src/lib/speech.ts). */
export const MAX_SPEAK_CHARS = 1000;
const TIMEOUT_MS = 30_000;

/** Piper instalado? Confere a cada pedido: instalar depois não exige reiniciar o servidor. */
export function piperAvailable(): boolean {
  return existsSync(PIPER_BIN) && existsSync(PIPER_VOICE) && existsSync(`${PIPER_VOICE}.json`);
}

// Taxa da voz, do `.onnx.json` ao lado do modelo: o Piper solta só as amostras, sem cabeçalho.
let voiceRate: Promise<number> | undefined;
function sampleRate(): Promise<number> {
  voiceRate ??= readFile(`${PIPER_VOICE}.json`, 'utf8').then(
    (raw) => Number((JSON.parse(raw) as { audio?: { sample_rate?: number } }).audio?.sample_rate) || 22_050,
    () => 22_050,
  );
  return voiceRate;
}

/** Amostras de 16 bits, mono, num WAV que o navegador toca. */
function wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Uma frase falada em pt-BR pelo Piper, no próprio PC, em WAV. */
export async function speak(text: string): Promise<Buffer> {
  if (!piperAvailable()) throw new HttpError(503, 'piper_unavailable');
  const rate = await sampleRate();
  return new Promise((resolve, reject) => {
    const child = spawn(PIPER_BIN, ['--model', PIPER_VOICE, '--output-raw'], { timeout: TIMEOUT_MS });
    const pcm: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => pcm.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    child.on('error', (err) => reject(new HttpError(500, 'speak_failed', { detail: err.message })));
    child.on('close', (code, signal) => {
      if (code === 0) resolve(wav(Buffer.concat(pcm), rate));
      else reject(signal ? new HttpError(504, 'speak_timeout') : new HttpError(500, 'speak_failed', { detail: stderr.slice(-500) }));
    });
    // O Piper lê uma fala por linha.
    child.stdin.end(`${text.replace(/\s+/g, ' ').trim()}\n`);
  });
}
