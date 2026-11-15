import { contextBridge, ipcRenderer } from 'electron';

/**
 * Language forced by the `WORKHUB_LOCALE=en|tr` environment variable (smoke tests and screenshots).
 * The main process hands it over as a `--workhub-locale=` argument; absent or invalid → `null`.
 */
const localeOverride = ((): 'en' | 'tr' | null => {
  const arg = process.argv.find((a) => a.startsWith('--workhub-locale='));
  const v = arg?.slice('--workhub-locale='.length);
  return v === 'en' || v === 'tr' ? v : null;
})();

/**
 * The ONLY surface the renderer gets: named domain calls (validated again in main), opening a
 * login URL main already issued, saving a generated file through the OS save dialog, picking
 * files / staging a recorded voice note (opaque handles), foreground-route hints and route events, plus the
 * read-only `localeOverride` test aid. No credentials, no generic fetch, no shell, no raw ipcRenderer.
 */
contextBridge.exposeInMainWorld('workhub', {
  invoke: (method: string, args: unknown[]) => ipcRenderer.invoke('workhub:invoke', method, args),
  openExternal: (url: string) => ipcRenderer.invoke('workhub:openExternal', url),
  saveFile: (filename: string, content: string, mime: string) => ipcRenderer.invoke('workhub:saveFile', filename, content, mime),
  // Talk attachments: opaque handles only (paths and bytes of picked files stay in main).
  pickFiles: () => ipcRenderer.invoke('workhub:pickFiles'),
  stageRecording: (wav: Uint8Array) => ipcRenderer.invoke('workhub:stageRecording', wav),
  releaseFile: (handle: string) => ipcRenderer.invoke('workhub:releaseFile', handle),
  setBadgeCount: (count: number) => ipcRenderer.send('workhub:badge', count),
  setForeground: (target: unknown) => ipcRenderer.send('workhub:foreground', target),
  onRoute: (cb: (target: unknown) => void) => {
    const h = (_e: unknown, t: unknown) => cb(t);
    ipcRenderer.on('workhub:route', h);
    return () => ipcRenderer.removeListener('workhub:route', h);
  },
  platform: process.platform,
  localeOverride,
});
