import { render, type WebpJob } from './sharp.ts';

/**
 * O processo à parte do sharp no app do PC em Linux (ver sharp.ts): recebe as imagens pelo canal do
 * fork e devolve cada uma em WebP. Sai junto com o servidor.
 */

type Job = { id: number; input: string; job: WebpJob };

process.on('disconnect', () => process.exit(0));

const sharp = await import('sharp').then((m) => m.default, () => null);

process.on('message', async ({ id, input, job }: Job) => {
  try {
    const data = await render(sharp!, Buffer.from(input, 'base64'), job);
    process.send?.({ id, data: data.toString('base64') });
  } catch (err) {
    process.send?.({ id, error: err instanceof Error ? err.message : String(err) });
  }
});

process.send?.({ ready: true, available: Boolean(sharp) });
