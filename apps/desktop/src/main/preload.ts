import { contextBridge, ipcRenderer } from 'electron';

/**
 * The ONLY surface the renderer gets: named domain calls (validated again in main), opening a
 * login URL main already issued, saving a generated file through the OS save dialog, foreground-route hints and route events. No credentials, no
 * generic fetch, no shell, no raw ipcRenderer.
 */
contextBridge.exposeInMainWorld('workhub', {
  invoke: (method: string, args: unknown[]) => ipcRenderer.invoke('workhub:invoke', method, args),
  openExternal: (url: string) => ipcRenderer.invoke('workhub:openExternal', url),
  saveFile: (filename: string, content: string, mime: string) => ipcRenderer.invoke('workhub:saveFile', filename, content, mime),
  setForeground: (target: unknown) => ipcRenderer.send('workhub:foreground', target),
  onRoute: (cb: (target: unknown) => void) => {
    const h = (_e: unknown, t: unknown) => cb(t);
    ipcRenderer.on('workhub:route', h);
    return () => ipcRenderer.removeListener('workhub:route', h);
  },
  platform: process.platform,
});
