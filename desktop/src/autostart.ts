import { app } from 'electron';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * "Iniciar com o sistema": um `.desktop` no autostart do XDG, que GNOME, KDE e os outros seguem.
 * Sobe com `--hidden`, só na bandeja, para o servidor estar de pé quando o celular chamar.
 */

const FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', 'editr.desktop');

export const autostartEnabled = (): boolean => existsSync(FILE);

// Aspas do `Exec` da especificação de desktop entries.
const quote = (arg: string) => `"${arg.replace(/(["`$\\])/g, '\\$1')}"`;

export function setAutostart(on: boolean): void {
  if (!on) {
    rmSync(FILE, { force: true });
    return;
  }
  // No AppImage, o executável é o do ponto de montagem, que muda a cada abertura: vale o arquivo dele.
  // Rodando do repositório, o do node_modules do app, sem a versão que o pnpm põe no caminho do processo.
  const dev = join(app.getAppPath(), 'node_modules', 'electron', 'dist', 'electron');
  const exe = process.env.APPIMAGE ?? (!app.isPackaged && existsSync(dev) ? dev : process.execPath);
  // Rodando do repositório, o Electron precisa da pasta do app.
  const args = app.isPackaged ? [] : [app.getAppPath()];
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(
    FILE,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=edit.r',
      'Comment=O edit.r na bandeja, para o celular achar o PC',
      `Exec=${[exe, ...args].map(quote).join(' ')} --hidden`,
      'Icon=editr',
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'),
  );
}
