import { Notification } from 'electron';
import { setTimeout as sleep } from 'node:timers/promises';
import { BASE, TRAY_ICON } from './paths.ts';
import type { NotificationPrefs, Settings } from './settings.ts';

/** O aviso como o servidor manda ao celular (ver server/src/push.ts). */
type Payload = { title: string; body: string; tag: string; url: string };
type Options = { needs: ('done' | 'pc')[] };

const RETRY_MIN_MS = 3_000;
// Servidor de antes do canal local (o serviço ainda sem atualizar): tenta de vez em quando.
const RETRY_MAX_MS = 60_000;

/**
 * Os avisos do Claude como notificações do sistema. O Electron não tem Web Push: o app ouve o canal
 * local do servidor (`/api/push/local`, em Server-Sent Events), que recebe os mesmos avisos do
 * celular, inclusive os repassados pelas suas outras máquinas, e mostra cada um aqui.
 */
export class Notifications {
  private readonly settings: Settings;
  private readonly open: (url: string) => void;
  private readonly inFront: () => boolean;
  private readonly abort = new AbortController();
  /** Um aviso por conversa, como no celular: o novo troca o anterior com a mesma `tag`. */
  private readonly shown = new Map<string, Notification>();

  /**
   * @param open traz a janela e abre a tela do aviso clicado.
   * @param inFront a janela está na frente: o aviso não aparece, como no celular com o app aberto.
   */
  constructor(settings: Settings, open: (url: string) => void, inFront: () => boolean) {
    this.settings = settings;
    this.open = open;
    this.inFront = inFront;
  }

  get prefs(): NotificationPrefs {
    return this.settings.data.notifications;
  }

  set prefs(next: NotificationPrefs) {
    this.settings.update({ notifications: next });
  }

  start(): void {
    void this.listen();
  }

  stop(): void {
    this.abort.abort();
  }

  /** O "Enviar teste" da tela de notificações: aparece mesmo com a janela na frente. */
  test(): void {
    this.show({ title: 'Notificações ligadas', body: 'É assim que os avisos do Claude vão chegar.', tag: 'test', url: '/' });
  }

  private async listen(): Promise<void> {
    let wait = RETRY_MIN_MS;
    while (!this.abort.signal.aborted) {
      try {
        const res = await fetch(`${BASE}/api/push/local`, { signal: this.abort.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        wait = RETRY_MIN_MS;
        let buffer = '';
        for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            this.onMessage(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
          }
        }
      } catch {
        // Servidor reiniciando, ou de antes do canal local: tenta de novo, cada vez mais devagar.
        wait = Math.min(wait * 2, RETRY_MAX_MS);
      }
      await sleep(wait).catch(() => {});
    }
  }

  private onMessage(message: string): void {
    for (const line of message.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const { payload, opts } = JSON.parse(line.slice(6)) as { payload: Payload; opts: Options };
        const prefs = this.prefs;
        if (!prefs.enabled || !opts.needs.every((k) => prefs[k]) || this.inFront()) continue;
        this.show(payload);
      } catch {
        // Linha que não é um aviso.
      }
    }
  }

  private show(payload: Payload): void {
    if (!Notification.isSupported()) return;
    this.shown.get(payload.tag)?.close();
    const notification = new Notification({ title: payload.title, body: payload.body, icon: TRAY_ICON });
    notification.on('click', () => this.open(payload.url));
    notification.on('close', () => {
      if (this.shown.get(payload.tag) === notification) this.shown.delete(payload.tag);
    });
    this.shown.set(payload.tag, notification);
    notification.show();
  }
}
