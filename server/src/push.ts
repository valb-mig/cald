import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import webpush, { WebPushError, type Urgency } from 'web-push';
import { STATE_DIR } from './config.ts';
import { HttpError } from './errors.ts';

/** O que cada aparelho quer receber além de perguntas, aprovações e erros, que sempre avisam. */
export type PushPrefs = { done: boolean; pc: boolean };

/** Inscrição criada pelo navegador do celular (`PushSubscription.toJSON()`). */
export type PushSubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };

type StoredSubscription = PushSubscriptionInput & { prefs: PushPrefs; createdAt: number };

/** Aviso entregue ao service worker do celular (web/src/sw.ts). */
export type PushPayload = {
  title: string;
  body: string;
  /** Uma notificação por conversa: a nova substitui a anterior. */
  tag: string;
  /** Tela aberta ao tocar; se já estiver visível, o aviso não aparece. */
  url: string;
  ts: number;
};

export type SendOptions = {
  /** Preferências que o aparelho precisa ter ligadas para receber. */
  needs: (keyof PushPrefs)[];
  urgency: Urgency;
  /** Segundos que o serviço de push guarda o aviso com o celular fora de alcance. */
  ttl: number;
  /** Avisos ainda não entregues com o mesmo tópico são trocados pelo mais novo. */
  topic?: string;
};

type PushFile = { vapid: { publicKey: string; privateKey: string }; subscriptions: StoredSubscription[] };

const FILE = process.env.PUSH_FILE ?? join(STATE_DIR, 'push.json');

// Contato exigido pelo VAPID; os serviços de push só o usam para avisar de abuso.
const SUBJECT = 'https://github.com/valb-mig/cald';

/**
 * Web Push: chaves VAPID do PC e inscrições dos aparelhos. O aviso sai criptografado
 * para o serviço de push do navegador (FCM no Chrome), que o entrega ao celular.
 */
export class PushService extends EventEmitter {
  private data: PushFile = { vapid: { publicKey: '', privateKey: '' }, subscriptions: [] };
  private writing = Promise.resolve();

  /**
   * `peers`: endereços das outras máquinas suas com o edit.r (ver machines.ts). O celular só
   * se inscreve na máquina de onde o app foi instalado; os avisos daqui vão também para elas, e a
   * que tiver a inscrição entrega.
   */
  private peers: () => string[];

  constructor(peers: () => string[] = () => []) {
    super();
    this.peers = peers;
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(FILE, 'utf8')) as Partial<PushFile>;
      if (saved.vapid?.publicKey && saved.vapid.privateKey) {
        this.data = { vapid: saved.vapid, subscriptions: Array.isArray(saved.subscriptions) ? saved.subscriptions : [] };
        return;
      }
    } catch {
      // Primeiro uso ou arquivo ilegível: chaves novas (os aparelhos se reinscrevem ao abrir o app).
    }
    this.data = { vapid: webpush.generateVAPIDKeys(), subscriptions: [] };
    await this.save();
  }

  get publicKey(): string {
    return this.data.vapid.publicKey;
  }

  get hasSubscribers(): boolean {
    return this.data.subscriptions.length > 0 || this.peers().length > 0;
  }

  /** Cadastra o aparelho ou atualiza as preferências dele. */
  async subscribe(sub: PushSubscriptionInput, prefs: PushPrefs): Promise<void> {
    const current = this.data.subscriptions.find((s) => s.endpoint === sub.endpoint);
    const others = this.data.subscriptions.filter((s) => s !== current);
    const entry = { endpoint: sub.endpoint, keys: sub.keys, prefs, createdAt: current?.createdAt ?? Date.now() };
    this.data = { ...this.data, subscriptions: [...others, entry] };
    await this.save();
  }

  async unsubscribe(endpoint: string): Promise<void> {
    const subscriptions = this.data.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (subscriptions.length === this.data.subscriptions.length) return;
    this.data = { ...this.data, subscriptions };
    await this.save();
  }

  /** Envia aos aparelhos inscritos aqui e repassa às outras máquinas; falhas viram evento `error`. */
  async notify(payload: PushPayload, opts: SendOptions): Promise<void> {
    await Promise.all([this.notifyHere(payload, opts), ...this.peers().map((base) => this.relay(base, payload, opts))]);
  }

  /**
   * Só aos aparelhos inscritos nesta máquina (aviso repassado por outra; não repassa de novo). Sai
   * também como `local`, para o app do PC, que não tem Web Push e mostra como aviso do sistema.
   */
  async notifyHere(payload: PushPayload, opts: SendOptions): Promise<void> {
    this.emit('local', payload, opts);
    const targets = this.data.subscriptions.filter((s) => opts.needs.every((p) => s.prefs[p]));
    await Promise.all(targets.map((s) => this.deliver(s, payload, opts).catch((err: unknown) => this.emit('error', err))));
  }

  private async relay(base: string, payload: PushPayload, opts: SendOptions): Promise<void> {
    try {
      const res = await fetch(`${base}/api/push/relay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload, opts }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`repasse para ${base}: HTTP ${res.status}`);
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** Aviso de teste para um aparelho; o erro do serviço de push volta para a tela. */
  async test(endpoint: string): Promise<void> {
    const sub = this.data.subscriptions.find((s) => s.endpoint === endpoint);
    if (!sub) throw new HttpError(404, 'subscription_not_found');
    const payload = {
      title: 'Notificações ligadas',
      body: 'É assim que os avisos do Claude vão chegar.',
      tag: 'test',
      url: '/',
      ts: Date.now(),
    };
    try {
      await this.deliver(sub, payload, { needs: [], urgency: 'high', ttl: 60 });
    } catch (err) {
      const status = err instanceof WebPushError ? err.statusCode : undefined;
      throw new HttpError(502, 'push_failed', { status, message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async deliver(sub: StoredSubscription, payload: PushPayload, opts: SendOptions): Promise<void> {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), {
        vapidDetails: { subject: SUBJECT, ...this.data.vapid },
        contentEncoding: 'aes128gcm',
        urgency: opts.urgency,
        TTL: opts.ttl,
        topic: opts.topic,
        timeout: 15_000,
      });
    } catch (err) {
      // Inscrição descartada pelo navegador (app desinstalado, permissão revogada): não volta mais.
      if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
        await this.unsubscribe(sub.endpoint);
      }
      throw err;
    }
  }

  // Mesma gravação do meta.json, mas só legível pelo dono: o arquivo guarda a chave privada.
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(FILE), { recursive: true });
      await writeFile(`${FILE}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${FILE}.tmp`, FILE);
    });
    return this.writing;
  }
}
