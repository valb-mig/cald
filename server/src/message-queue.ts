import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attachment } from './attachments.ts';
import { STATE_DIR } from './config.ts';
import type { Device } from './origins.ts';

const DIR = process.env.QUEUES_DIR ?? join(STATE_DIR, 'queues');
/** O tanto do texto que vai na lista (o catálogo vai para todo aparelho a cada mudança); o inteiro sai no `take`. */
const PREVIEW_CHARS = 400;
/** Quanto uma mensagem aberta na caixa fica segura (ver `hold`), se o aparelho que a abriu sumir. */
const HOLD_MS = 10 * 60_000;

/** Uma mensagem esperando a vez: o que você escreveu, os anexos e o modelo e o esforço com que ela vai. */
export type QueuedMessage = {
  id: string;
  text: string;
  attachments: Attachment[];
  model?: string;
  effort?: string;
  /** De que aparelho ela saiu, para o "enviada do celular" quando ela for. */
  from?: Device;
  /** Pausada: fica no lugar e a fila passa por ela, até você a soltar (ou mandar agora). */
  paused?: boolean;
  createdAt: number;
};

/** O que a lista mostra de cada uma: sem o conteúdo dos anexos, só o nome, o tipo e a miniatura. */
export type QueueItemView = {
  id: string;
  text: string;
  attachments: { name: string; mediaType: string; thumb?: string }[];
  model?: string;
  effort?: string;
  paused?: boolean;
  createdAt: number;
};

/**
 * `paused`: a fila não anda sozinha. Fica assim quando um turno é interrompido ou dá erro, e quando o
 * serviço reinicia; volta a andar quando você manda uma mensagem.
 */
type Queue = { paused: boolean; items: QueuedMessage[] };

export const viewOf = (m: QueuedMessage): QueueItemView => ({
  id: m.id,
  text: m.text.length > PREVIEW_CHARS ? `${m.text.slice(0, PREVIEW_CHARS)}…` : m.text,
  attachments: m.attachments.map((a) => ({ name: a.name, mediaType: a.mediaType, thumb: a.thumb })),
  model: m.model,
  effort: m.effort,
  paused: m.paused,
  createdAt: m.createdAt,
});

/**
 * A fila de mensagens de cada conversa: o que você mandou enquanto o Claude trabalhava, para ir quando o
 * turno acabar (ver Manager.dispatch). Um arquivo por conversa, em `queues/`, porque os anexos vão
 * junto, e só a conversa que mudou é regravada.
 */
export class MessageQueues {
  private readonly queues = new Map<string, Queue>();
  private readonly writing = new Map<string, Promise<void>>();
  /** A mensagem de cada conversa aberta na caixa para editar: ela não sai enquanto isso (só em memória). */
  private readonly holds = new Map<string, { id: string; at: number }>();

  async load(): Promise<void> {
    await mkdir(DIR, { recursive: true });
    for (const file of await readdir(DIR).catch(() => [])) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(await readFile(join(DIR, file), 'utf8')) as Partial<Queue>;
        const items = Array.isArray(data.items) ? data.items.filter((i) => typeof i?.id === 'string' && typeof i.text === 'string') : [];
        // Volta pausada: o turno em que ela esperava foi cortado pelo reinício, e ela sair sozinha surpreenderia.
        if (items.length) this.queues.set(file.slice(0, -5), { paused: true, items });
      } catch {
        // Arquivo ilegível: fica de fora.
      }
    }
  }

  get(sessionId: string): Queue | undefined {
    return this.queues.get(sessionId);
  }

  /** A fila como a lista mostra, ou nada se ela está vazia. */
  view(sessionId: string): { items: QueueItemView[]; paused: boolean } | undefined {
    const q = this.queues.get(sessionId);
    return q?.items.length ? { items: q.items.map(viewOf), paused: q.paused } : undefined;
  }

  add(sessionId: string, message: Omit<QueuedMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: number }, index?: number): QueuedMessage {
    const q = this.queues.get(sessionId) ?? { paused: false, items: [] };
    const item: QueuedMessage = { ...message, id: message.id ?? randomUUID(), createdAt: message.createdAt ?? Date.now() };
    const at = index === undefined ? q.items.length : Math.max(0, Math.min(index, q.items.length));
    q.items.splice(at, 0, item);
    this.queues.set(sessionId, q);
    this.save(sessionId);
    return item;
  }

  /** Tira e devolve a mensagem (inteira, com os anexos), ou `undefined` se ela já saiu. */
  take(sessionId: string, id: string): QueuedMessage | undefined {
    const q = this.queues.get(sessionId);
    const at = q?.items.findIndex((i) => i.id === id) ?? -1;
    if (!q || at < 0) return undefined;
    const [item] = q.items.splice(at, 1);
    if (this.holds.get(sessionId)?.id === id) this.holds.delete(sessionId);
    this.save(sessionId);
    return item;
  }

  /**
   * A próxima da vez, se a fila está andando, passando pelas pausadas. A primeira aberta na caixa segura a
   * fila: a ordem vale.
   */
  next(sessionId: string): QueuedMessage | undefined {
    const q = this.queues.get(sessionId);
    const first = q?.paused ? undefined : q?.items.find((i) => !i.paused);
    if (!first) return undefined;
    const hold = this.holds.get(sessionId);
    if (hold?.id === first.id && Date.now() - hold.at < HOLD_MS) return undefined;
    return this.take(sessionId, first.id);
  }

  /** Alguma vai sair sozinha no fim do turno: a fila anda e nem todas estão pausadas. */
  flowing(sessionId: string): boolean {
    const q = this.queues.get(sessionId);
    return Boolean(q && !q.paused && q.items.some((i) => !i.paused));
  }

  /** Pausa ou solta uma mensagem, no lugar dela; `false` se ela já saiu. */
  pauseItem(sessionId: string, id: string, paused: boolean): boolean {
    const item = this.queues.get(sessionId)?.items.find((i) => i.id === id);
    if (!item) return false;
    if (paused) item.paused = true;
    else delete item.paused;
    this.save(sessionId);
    return true;
  }

  /** Segura (`id`) ou solta (`null`) a mensagem aberta na caixa; uma por conversa. */
  hold(sessionId: string, id: string | null): void {
    if (id) this.holds.set(sessionId, { id, at: Date.now() });
    else this.holds.delete(sessionId);
  }

  /** Muda o texto, os anexos, o modelo e o esforço de uma mensagem, no lugar dela; `false` se ela já saiu. */
  update(sessionId: string, id: string, change: Pick<QueuedMessage, 'text' | 'attachments' | 'model' | 'effort'>): boolean {
    const item = this.queues.get(sessionId)?.items.find((i) => i.id === id);
    if (!item) return false;
    Object.assign(item, change);
    this.save(sessionId);
    return true;
  }

  /** A nova ordem, pelos ids; os que faltarem na lista vão para o fim, na ordem em que estavam. */
  order(sessionId: string, ids: string[]): void {
    const q = this.queues.get(sessionId);
    if (!q) return;
    const rank = new Map(ids.map((id, i) => [id, i]));
    q.items = q.items
      .map((item, i) => ({ item, i }))
      .sort((a, b) => (rank.get(a.item.id) ?? ids.length + a.i) - (rank.get(b.item.id) ?? ids.length + b.i))
      .map(({ item }) => item);
    this.save(sessionId);
  }

  /** Muda se a fila anda sozinha; devolve se mudou. */
  setPaused(sessionId: string, paused: boolean): boolean {
    const q = this.queues.get(sessionId);
    if (!q || q.paused === paused) return false;
    q.paused = paused;
    this.save(sessionId);
    return true;
  }

  /** A conversa ganhou id novo (um /clear, uma sessão nova do agente): a fila segue com ela. */
  rekey(from: string, to: string): void {
    const hold = this.holds.get(from);
    if (hold) {
      this.holds.delete(from);
      this.holds.set(to, hold);
    }
    const q = this.queues.get(from);
    if (!q) return;
    this.queues.delete(from);
    this.queues.set(to, q);
    this.save(from);
    this.save(to);
  }

  /** Grava a fila da conversa, uma gravação de cada vez; vazia, o arquivo sai. */
  private save(sessionId: string): void {
    const file = join(DIR, `${sessionId}.json`);
    const prev = this.writing.get(sessionId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const q = this.queues.get(sessionId);
      if (!q?.items.length) {
        this.queues.delete(sessionId);
        await rm(file, { force: true });
        return;
      }
      await writeFile(`${file}.tmp`, JSON.stringify(q));
      await rename(`${file}.tmp`, file);
    });
    const settled = next.catch(() => undefined);
    this.writing.set(sessionId, settled);
    void settled.then(() => {
      if (this.writing.get(sessionId) === settled) this.writing.delete(sessionId);
    });
  }
}
