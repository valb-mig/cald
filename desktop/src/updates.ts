import { Notification, app, shell } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { basename, dirname, join } from 'node:path';
import { TRAY_ICON } from './paths.ts';
import { cleanEnv } from './shell-env.ts';

/**
 * A versão nova do app, dos Releases do GitHub (publicados pelo .github/workflows/desktop.yml). O
 * AppImage se atualiza sozinho: baixa em segundo plano e troca o arquivo ao sair do app, ou na hora,
 * por "Reiniciar para atualizar" na bandeja. O .deb e o .pacman só avisam e abrem a página da versão,
 * porque instalar pede a senha de administrador.
 */

const RELEASES = 'https://github.com/valb-mig/editr/releases/latest';
const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 3_600_000;

/** `available`: há versão nova para baixar (.deb, .pacman); `downloaded`: a do AppImage já está aqui. */
export type UpdateState = { kind: 'available'; version: string } | { kind: 'downloaded'; version: string; file: string };

export class Updates extends EventEmitter {
  state: UpdateState | null = null;
  /** No AppImage, o próprio app troca o arquivo dele. */
  private readonly appImage = process.env.APPIMAGE;
  private notified?: string;

  /** Só no app instalado: rodando do repositório, não há versão publicada para comparar. */
  start(): void {
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = Boolean(this.appImage);
    autoUpdater.autoInstallOnAppQuit = Boolean(this.appImage);
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      if (!this.appImage) this.set({ kind: 'available', version: info.version });
    });
    autoUpdater.on('update-downloaded', (info: UpdateInfo & { downloadedFile: string }) =>
      this.set({ kind: 'downloaded', version: info.version, file: info.downloadedFile }),
    );
    // Sem rede ou sem Releases ainda: tenta de novo na próxima vez.
    autoUpdater.on('error', (err: Error) => console.warn('[edit.r] atualização:', err.message));
    const check = () => void autoUpdater.checkForUpdates().catch(() => {});
    setTimeout(check, FIRST_CHECK_MS);
    setInterval(check, CHECK_EVERY_MS);
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.emit('change');
    if (this.notified === state.version || !Notification.isSupported()) return;
    this.notified = state.version;
    const body =
      state.kind === 'downloaded'
        ? `A v${state.version} já está baixada: entra quando você sair do app, ou agora, por "Reiniciar para atualizar", na bandeja.`
        : `A v${state.version} está nos Releases do GitHub. Clique para baixar.`;
    const notification = new Notification({ title: 'Versão nova do edit.r', body, icon: TRAY_ICON });
    if (state.kind === 'available') notification.on('click', () => this.openReleases());
    notification.show();
  }

  openReleases(): void {
    void shell.openExternal(RELEASES);
  }

  /**
   * Troca o AppImage e abre o novo depois que este sair. Quem chama já encerrou o servidor: o app novo
   * só sobe com este processo terminado, sem disputar a porta nem a instância única.
   */
  installAndRestart(): void {
    if (this.state?.kind !== 'downloaded' || !this.appImage) return;
    // Onde o arquivo novo vai ficar (ver AppImageUpdater): no lugar do atual se o nome dele não tem
    // versão (o do Release, `editr-x86_64.AppImage`); senão, ao lado, com o nome do baixado.
    const current = basename(this.appImage);
    const next = current === basename(this.state.file) || !/\d+\.\d+\.\d+/.test(current) ? this.appImage : join(dirname(this.appImage), basename(this.state.file));
    // Quem abre o novo é um shell à parte, de fora do AppImage: o `app.relaunch` do Electron sai de
    // dentro da montagem do AppImage, que some junto com este processo, e o app não volta.
    spawn('/bin/sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2"', 'editr-relaunch', String(process.pid), next], {
      detached: true,
      stdio: 'ignore',
      env: cleanEnv(),
    }).unref();
    autoUpdater.quitAndInstall(true, false);
    // Se a troca falhar, o updater não sai: sai assim mesmo, para não ficar sem servidor.
    setTimeout(() => app.quit(), 5_000);
  }
}
