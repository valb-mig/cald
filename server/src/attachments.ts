import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UPLOADS_DIR } from './config.ts';
import { HttpError } from './errors.ts';
import type { ImageSink } from './images.ts';
import type { TurnBlock } from './providers/types.ts';

/** Anexo enviado pelo celular, em base64. */
export type Attachment = {
  name: string;
  mediaType: string;
  data: string;
  /** Miniatura gerada no celular para a bandeja de anexos; o servidor não usa. */
  thumb?: string;
};

// Tipos que a API aceita como bloco de imagem; o resto vira arquivo no PC + menção @caminho.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function safeName(name: string): string {
  // "relatório final.txt" → "relatorio_final.txt": tira acentos antes de trocar o resto por "_".
  const cleaned = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '');
  return cleaned.slice(-120) || 'arquivo';
}

/**
 * Prepara um turno com anexos: imagens viram blocos de conteúdo; os demais arquivos
 * são gravados em UPLOADS_DIR/<sessão>/ e mencionados com @caminho, que o Claude Code lê.
 */
export async function prepareTurn(
  sessionId: string,
  text: string,
  attachments: Attachment[] = [],
  sink?: ImageSink,
): Promise<{ text: string; blocks: TurnBlock[]; images: string[] }> {
  const blocks: TurnBlock[] = [];
  const images: string[] = [];
  const mentions: string[] = [];

  for (const a of attachments) {
    const bytes = Buffer.from(a.data, 'base64');
    if (IMAGE_TYPES.has(a.mediaType) && bytes.length <= MAX_IMAGE_BYTES) {
      blocks.push({ type: 'image', mediaType: a.mediaType, data: a.data });
      // A imagem inteira vai para o cache: no chat ela abre em tamanho real.
      if (sink) images.push(sink({ mediaType: a.mediaType, data: a.data }));
      continue;
    }
    if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'attachment_too_large', { name: a.name });
    const dir = join(UPLOADS_DIR, sessionId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${safeName(a.name)}`);
    await writeFile(path, bytes);
    mentions.push(`@${path}`);
  }

  const finalText = [text.trim(), mentions.join(' ')].filter(Boolean).join('\n\n');
  if (!finalText && blocks.length === 0) throw new HttpError(400, 'empty_message');
  return { text: finalText, blocks, images };
}
