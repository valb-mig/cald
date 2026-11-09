import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, nativeTheme, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { autostartEnabled, setAutostart } from './autostart.ts';
import { Notifications } from './notifications.ts';
import { BASE, ICON, PACKAGED, PRELOAD, SERVER_LOG, TRAY_ICON } from './paths.ts';
import { ServerSupervisor } from './server.ts';
import { Settings, type NotificationPrefs, type WindowState } from './settings.ts';
import { loginShellEnv } from './shell-env.ts';
import { Updates } from './updates.ts';

/**
 * O edit.r como app do PC: a janela no app web servido pelo servidor local, a bandeja e o próprio
 * servidor (ver server.ts). Fechar a janela deixa o app na bandeja, com o servidor de pé para o
 * celular; sair de verdade é pelo menu da bandeja ou Ctrl+Q.
 */

app.setName('edit.r');

// Aberto pelo autostart (ver autostart.ts): só a bandeja, sem a janela.
const startHidden = process.argv.includes('--hidden');

const settings = new Settings();
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let supervisor: ServerSupervisor | null = null;
let notifications: Notifications | null = null;
const updates = new Updates();
let quitting = false;
let serverStopped = false;

const sameOrigin = (url: string) => {
  try {
    return new URL(url).origin === BASE;
  } catch {
    return false;
  }
};

/** Link de fora do app: no navegador, e só os de web e e-mail. */
function openExternal(url: string): void {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

/** Uma tela de espera (ou de erro) no lugar do app, enquanto o servidor não responde. */
function splash(text: string, detail = ''): string {
  const dark = nativeTheme.shouldUseDarkColors;
  const html = `<!doctype html><meta charset="utf-8"><title>edit.r</title>
<style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;font:14px/1.5 system-ui,sans-serif;background:${dark ? '#141414' : '#fdfdfd'};color:${dark ? '#e5e5e5' : '#262626'}}
  main{max-width:32rem;padding:0 1rem;text-align:center}
  p{margin:.25rem 0} small{opacity:.6;word-break:break-all}
</style>
<main><p>${text}</p>${detail ? `<small>${detail}</small>` : ''}</main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function showWindow(url?: string): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (url) win.webContents.send('navigate', url);
}

function createWindow(): BrowserWindow {
  const saved = settings.data.window;
  const window = new BrowserWindow({
    title: 'edit.r',
    icon: ICON,
    width: saved?.width ?? 1400,
    height: saved?.height ?? 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 360,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#fdfdfd',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, spellcheck: true },
  });
  if (saved?.maximized) window.maximize();
  window.once('ready-to-show', () => {
    if (!startHidden) window.show();
  });

  // Fechar esconde: o servidor e os avisos seguem, e a bandeja traz de volta.
  window.on('close', (e) => {
    saveWindow(window);
    if (quitting) return;
    e.preventDefault();
    window.hide();
  });
  let saving: NodeJS.Timeout | undefined;
  const later = () => {
    clearTimeout(saving);
    saving = setTimeout(() => saveWindow(window), 1_000);
  };
  window.on('resize', later);
  window.on('move', later);

  // As páginas do próprio app (artefatos, protótipos) abrem numa janela nova; o resto, no navegador.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { icon: ICON, autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } } };
    }
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (e, url) => {
    if (sameOrigin(url)) return;
    e.preventDefault();
    openExternal(url);
  });
  return window;
}

function saveWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  const maximized = window.isMaximized();
  // Maximizada, guarda o tamanho de antes, para o "restaurar" voltar a ele.
  const b = maximized ? window.getNormalBounds() : window.getBounds();
  const state: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized };
  settings.update({ window: state });
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON).resize({ width: 24, height: 24 }));
  tray.setToolTip('edit.r');
  tray.on('click', () => (win?.isVisible() && win.isFocused() ? win.hide() : showWindow()));
  updateTray();
}

/** A versão nova, no topo da bandeja e do menu do app: reiniciar com ela (AppImage) ou baixar. */
function updateItems(): MenuItemConstructorOptions[] {
  const update = updates.state;
  if (update?.kind === 'downloaded') return [{ label: `Reiniciar para atualizar (v${update.version})`, click: () => void restartToUpdate() }, { type: 'separator' }];
  if (update?.kind === 'available') return [{ label: `Baixar a versão nova (v${update.version})`, click: () => updates.openReleases() }, { type: 'separator' }];
  return [];
}

function updateTray(): void {
  if (!tray) return;
  const owns = supervisor?.mode === 'own';
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...updateItems(),
      { label: 'Abrir o edit.r', click: () => showWindow() },
      { label: 'Link do celular', click: () => showWindow('/?computador=acesso') },
      { type: 'separator' },
      {
        label: 'Iniciar com o sistema',
        type: 'checkbox',
        checked: autostartEnabled(),
        click: (item) => {
          setAutostart(item.checked);
          updateTray();
        },
      },
      { type: 'separator' },
      // Com o servidor deste app, sair tira o painel do celular também.
      { label: owns ? 'Sair (o celular perde o acesso)' : 'Sair', click: () => app.quit() },
    ]),
  );
}

/** "Reiniciar para atualizar": encerra o servidor com calma antes, como no Sair, e troca o AppImage. */
async function restartToUpdate(): Promise<void> {
  quitting = true;
  notifications?.stop();
  await supervisor?.stop();
  serverStopped = true;
  updates.installAndRestart();
}

function createMenu(): void {
  // A barra fica escondida (Alt mostra); valem os atalhos de navegador de sempre e o Ctrl+Q.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'edit.r',
        submenu: [
          ...updateItems(),
          { role: 'reload', label: 'Recarregar' },
          { role: 'forceReload', label: 'Recarregar sem cache' },
          { role: 'toggleDevTools', label: 'Ferramentas do desenvolvedor' },
          { type: 'separator' },
          { role: 'resetZoom', label: 'Tamanho normal' },
          { role: 'zoomIn', label: 'Aumentar' },
          { role: 'zoomOut', label: 'Diminuir' },
          { role: 'togglefullscreen', label: 'Tela cheia' },
          { type: 'separator' },
          { label: 'Fechar a janela', click: () => win?.hide() },
          { label: 'Sair', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
        ],
      },
      { role: 'editMenu', label: 'Editar' },
    ]),
  );
}

/** Microfone (ditado), notificações e área de transferência, só para o próprio app. */
function grantPermissions(): void {
  const allowed = new Set(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => cb(allowed.has(permission) && sameOrigin(details.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && sameOrigin(origin));
}

/** O que a tela de notificações do app web pede (ver preload.ts); só a janela do app pode. */
function handleIpc(): void {
  const fromApp = (e: IpcMainInvokeEvent) => sameOrigin(e.senderFrame?.url ?? '');
  ipcMain.handle('notifications:get', (e) => (fromApp(e) ? notifications?.prefs : null));
  ipcMain.handle('notifications:set', (e, next: NotificationPrefs) => {
    if (!fromApp(e) || !notifications) return null;
    notifications.prefs = { enabled: Boolean(next.enabled), done: Boolean(next.done), pc: Boolean(next.pc) };
    return notifications.prefs;
  });
  ipcMain.handle('notifications:test', (e) => {
    if (fromApp(e)) notifications?.test();
  });
}

async function boot(): Promise<void> {
  createMenu();
  grantPermissions();
  handleIpc();
  win = createWindow();
  void win.loadURL(splash('Iniciando o edit.r…'));
  createTray();

  // Instalado (não rodando do repositório), liga o "iniciar com o sistema" na primeira vez; depois,
  // só acerta o caminho, que muda se o AppImage foi movido ou atualizado com outro nome.
  if (PACKAGED && !settings.data.autostartSet) {
    setAutostart(true);
    settings.update({ autostartSet: true });
    updateTray();
  } else if (PACKAGED && autostartEnabled()) setAutostart(true);
  updates.on('change', () => {
    updateTray();
    createMenu();
  });
  updates.start();

  supervisor = new ServerSupervisor(await loginShellEnv());
  supervisor.on('mode', updateTray);
  supervisor.on('error', (err) => console.error('[edit.r] o servidor não subiu:', err));
  try {
    await supervisor.start();
  } catch (err) {
    void win.loadURL(splash('O servidor do edit.r não respondeu.', err instanceof Error ? err.message : String(err)));
    return;
  }
  await win.loadURL(BASE);

  notifications = new Notifications(
    settings,
    (url) => showWindow(url),
    () => Boolean(win?.isVisible() && win.isFocused()),
  );
  notifications.start();
}

if (!app.requestSingleInstanceLock()) {
  // Já aberto: o outro traz a janela (ver `second-instance`).
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  // Na bandeja, sem janela: o app continua.
  app.on('window-all-closed', () => {});
  app.on('before-quit', (e) => {
    quitting = true;
    notifications?.stop();
    if (serverStopped || !supervisor) return;
    const owned = supervisor.owns;
    const stopping = supervisor.stop();
    serverStopped = !owned;
    if (!owned) return;
    // Espera o servidor deste app encerrar as conversas do painel com calma.
    e.preventDefault();
    void stopping.finally(() => {
      serverStopped = true;
      app.quit();
    });
  });
  void app.whenReady().then(boot).catch((err: unknown) => {
    console.error('[edit.r] falhou ao abrir:', err);
    void win?.loadURL(splash('O edit.r não conseguiu abrir.', `${err instanceof Error ? err.message : String(err)} · ${SERVER_LOG}`));
  });
}
