import { app } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Onde fica cada coisa. Empacotado, o servidor e o app web vão em `resources/` (ver
 * electron-builder.yml); rodando do repositório (`pnpm --filter editr-desktop start`), nos de sempre.
 */

const env = process.env;

// O main.js compilado fica em desktop/dist; a raiz do repositório é dois acima.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = app.isPackaged ? process.resourcesPath : REPO;

export const PACKAGED = app.isPackaged;

// A porta do servidor: a de sempre, ou outra para testar sem mexer no que já roda.
export const PORT = Number(env.EDITR_PORT ?? 7337);
export const BASE = `http://127.0.0.1:${PORT}`;

// O app de teste de uma branch (ver deploy/test-build.sh), na instância de teste dela: pasta própria
// por porta, para abrir ao lado do app de sempre sem um travar ou focar o outro (a trava de instância
// única é a da pasta), nem misturar o tamanho da janela e as preferências.
export const TEST = env.EDITR_TEST === '1';
if (TEST) {
  app.setPath('userData', join(app.getPath('appData'), 'edit.r-teste', String(PORT)));
  app.setAppLogsPath();
}

export const SERVER_ENTRY = join(ROOT, 'server', 'src', 'index.ts');
export const WEB_DIST = app.isPackaged ? join(ROOT, 'web') : join(REPO, 'web', 'dist');
export const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs');

// Os ícones saem do próprio app web (os do PWA).
export const ICON = join(WEB_DIST, 'pwa-512.png');
export const TRAY_ICON = join(WEB_DIST, 'pwa-192.png');

// O que é do app fica na pasta dele (~/.config/edit.r), e não nas do servidor: criadas antes de um
// servidor novo subir, elas atrapalhariam a migração das pastas do nome antigo (ver server/src/config.ts).
export const SETTINGS_FILE = join(app.getPath('userData'), 'desktop.json');
export const SERVER_LOG = join(app.getPath('logs'), 'server.log');
