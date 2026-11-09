import type { StoredImage } from './images.ts';
import { toWebp } from './sharp.ts';

/** Lado maior das miniaturas (chat e grade de mídia): nítidas em tela de celular com 2-3x de densidade. */
const THUMB_SIDE = 512;
const MAX_BYTES = 30 * 1024 * 1024;

export type Thumbnail = { mediaType: string; data: Buffer };

const cache = new Map<string, Thumbnail>();
let bytes = 0;

function remember(id: string, thumb: Thumbnail): void {
  cache.set(id, thumb);
  bytes += thumb.data.length;
  for (const [k, v] of cache) {
    if (bytes <= MAX_BYTES) break;
    cache.delete(k);
    bytes -= v.data.length;
  }
}

/**
 * Versão reduzida (WebP, até 512 px) de uma imagem do chat: o celular baixa isto nas miniaturas e
 * deixa o original para a imagem ampliada. Guardada em memória, com as mais antigas descartadas.
 */
export async function thumbnail(id: string, image: StoredImage): Promise<Thumbnail> {
  const hit = cache.get(id);
  if (hit) {
    // Reinsere para marcar como recém-usada.
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  const original = Buffer.from(image.data, 'base64');
  let thumb: Thumbnail = { mediaType: image.mediaType, data: original };
  try {
    // Sem o sharp nesta máquina, a miniatura é a própria imagem, como antes.
    const data = await toWebp(original, { width: THUMB_SIDE, height: THUMB_SIDE, fit: 'inside', withoutEnlargement: true, quality: 72 });
    if (data && data.length < original.length) thumb = { mediaType: 'image/webp', data };
  } catch {
    // Formato que o sharp não lê: segue o original.
  }
  remember(id, thumb);
  return thumb;
}
