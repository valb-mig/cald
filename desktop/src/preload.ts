import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * O que o app web vê do app do PC, em `window.editr` (ver web/src/lib/desktop.ts). Só a janela
 * principal recebe; as páginas abertas a partir dela (artefatos, protótipos) não.
 */

type Prefs = { enabled: boolean; done: boolean; pc: boolean };

contextBridge.exposeInMainWorld('editr', {
  notifications: {
    get: (): Promise<Prefs> => ipcRenderer.invoke('notifications:get'),
    set: (next: Prefs): Promise<Prefs> => ipcRenderer.invoke('notifications:set', next),
    test: (): Promise<void> => ipcRenderer.invoke('notifications:test'),
  },
  onNavigate: (cb: (url: string) => void) => {
    const listener = (_e: IpcRendererEvent, url: string) => cb(url);
    ipcRenderer.on('navigate', listener);
    return () => void ipcRenderer.off('navigate', listener);
  },
});
