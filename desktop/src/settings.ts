import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SETTINGS_FILE } from './paths.ts';

/** Os avisos do sistema neste PC: ligados, e o que avisa além de perguntas, aprovações e erros. */
export type NotificationPrefs = { enabled: boolean; done: boolean; pc: boolean };

export type WindowState = { x?: number; y?: number; width: number; height: number; maximized: boolean };

type DesktopSettings = {
  window?: WindowState;
  notifications: NotificationPrefs;
  /** O "iniciar com o sistema" já foi ligado uma vez (na primeira abertura): daí em diante, é seu. */
  autostartSet?: boolean;
};

const DEFAULTS: DesktopSettings = { notifications: { enabled: true, done: true, pc: true } };

/** O que o app do PC guarda dele mesmo, em `~/.config/edit.r/desktop.json`. */
export class Settings {
  data: DesktopSettings;

  constructor() {
    try {
      const saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<DesktopSettings>;
      this.data = { ...DEFAULTS, ...saved, notifications: { ...DEFAULTS.notifications, ...saved.notifications } };
    } catch {
      this.data = structuredClone(DEFAULTS);
    }
  }

  update(patch: Partial<DesktopSettings>): void {
    this.data = { ...this.data, ...patch };
    try {
      mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
      writeFileSync(`${SETTINGS_FILE}.tmp`, JSON.stringify(this.data, null, 2));
      renameSync(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE);
    } catch (err) {
      console.warn('[edit.r] não deu para guardar as preferências do app:', err);
    }
  }
}
