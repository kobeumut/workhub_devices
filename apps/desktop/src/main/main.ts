import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray, type WebContents } from 'electron';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { createDirectBackend, dispatchWire, isWithinServer, unregisterWebPush, type RoutedTarget } from '@workhub-devices/core';
import { createPlainStore, createSecretStore } from './stores';
import { DesktopNotifier } from './notifier';
import { runSmoke } from './smoke';
import { createDesktopFiles } from './files';
import identity from '../../../../config/app-identity.json';

const smokeOut = process.env.WORKHUB_SMOKE_OUT;
const allowHttp = process.env.WORKHUB_ALLOW_HTTP === '1' && (!app.isPackaged || !!smokeOut);

if (!app.requestSingleInstanceLock()) app.quit();

const dataDir = app.getPath('userData');
const secrets = createSecretStore(dataDir);
const plain = createPlainStore(dataDir);
// Smoke: a fake microphone (beep) and auto-accepted capture, so the voice-note step runs headless.
if (smokeOut) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}
let win: BrowserWindow | null = null;
const files = createDesktopFiles(() => win, smokeOut);
const backend = createDirectBackend({
  secrets,
  plain,
  files: files.host,
  userAgent: `WorkhubDesktop/${identity.version} (${process.platform})`,
  ...(allowHttp ? { urlOptions: { allowInsecureHttp: true } } : {}),
  onLogout: async (_a, client) => {
    try {
      await unregisterWebPush(client);
    } catch {
      /* desktop has no web push subscription today */
    }
    return true;
  },
});

/** Login pages the renderer may ask to open: only URLs main itself received from beginLogin. */
const allowedExternal = new Set<string>();
let tray: Tray | null = null;
let badgeCount = 0;
function updateBadge(count: number) {
  badgeCount = count;
  if (process.platform === 'darwin' || process.platform === 'linux') app.badgeCount = count;
  tray?.setToolTip(count ? `Workhub — ${count} okunmamış mesaj` : 'Workhub');
  if (process.platform === 'darwin') tray?.setTitle(count ? String(count) : '');
}
let quitting = false;
const rendererIndex = join(__dirname, 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererIndex).toString();

const notifier = new DesktopNotifier(backend, (t) => focusWith(t));

function isOurFrame(wc: WebContents, frameUrl: string | undefined) {
  return wc === win?.webContents && !!frameUrl && frameUrl.startsWith(rendererUrl.replace(/index\.html$/, ''));
}

function focusWith(target: RoutedTarget | null) {
  if (!win) createWindow();
  win!.show();
  win!.focus();
  if (target) win!.webContents.send('workhub:route', target);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 520,
    title: 'Workhub',
    show: !smokeOut,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      ...(smokeOut ? { offscreen: true } : {}),
    },
  });
  win.removeMenu();
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== rendererUrl) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (e) => {
    // Closing the window keeps the app in the tray so notifications continue; Quit from tray menu.
    if (!quitting && tray && !smokeOut) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('blur', () => notifier.setForeground(null));
  win.on('hide', () => notifier.setForeground(null));
  win.on('minimize', () => notifier.setForeground(null));
  win.on('closed', () => {
    notifier.setForeground(null);
    win = null;
  });
  void win.loadFile(rendererIndex);
  return win;
}

function createTray() {
  // 16x16 blue square; replaced by the brand icon in packaging (build/icons).
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR4nGNgYGD4z0ABYBzVPKp5VPOo5mGjGQD5hgEPS3YHEwAAAABJRU5ErkJggg==',
  );
  tray = new Tray(icon);
  updateBadge(badgeCount);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Workhub’u aç', click: () => focusWith(null) },
      { type: 'separator' },
      {
        label: 'Çıkış (bildirimler durur)',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => focusWith(null));
}

ipcMain.handle('workhub:invoke', async (e, method: unknown, args: unknown) => {
  if (!isOurFrame(e.sender, e.senderFrame?.url)) return { ok: false, error: { kind: 'client', message: 'rejected' } };
  const result = await dispatchWire(backend, method, args);
  if (method === 'beginLogin' && result.ok) allowedExternal.add((result.value as { loginUrl: string }).loginUrl);
  if ((method === 'completeLogin' || method === 'logout') && result.ok) void notifier.pollAll().catch(() => undefined);
  return result;
});

ipcMain.handle('workhub:openExternal', async (e, url: unknown) => {
  if (!isOurFrame(e.sender, e.senderFrame?.url) || typeof url !== 'string') return false;
  // Allowed: login pages main issued, or https pages on a logged-in account's own server (web fallback).
  const onOwnServer = (await backend.listAccounts()).some((a) => isWithinServer(a.serverBase, url) && /^https?:\/\//.test(url));
  if (!allowedExternal.has(url) && !onOwnServer) return false;
  if (smokeOut) {
    await fs.writeFile(join(smokeOut, 'login-url.txt'), url);
    return true;
  }
  await shell.openExternal(url);
  return true;
});

/**
 * Save a generated export through the OS save dialog. Only a plain `.csv` basename and bounded
 * text are accepted; the user picks the location. The renderer never gets a path or fs access.
 */
ipcMain.handle('workhub:saveFile', async (e, filename: unknown, content: unknown, mime: unknown) => {
  if (!isOurFrame(e.sender, e.senderFrame?.url) || !win) return 'cancelled';
  if (mime !== 'text/csv' || typeof content !== 'string' || content.length > 50 * 1024 * 1024) return 'cancelled';
  if (typeof filename !== 'string' || basename(filename) !== filename || !/^[\w.-]{1,120}\.csv$/.test(filename)) return 'cancelled';
  if (smokeOut) {
    await fs.writeFile(join(smokeOut, filename), content, 'utf8');
    return 'saved';
  }
  const r = await dialog.showSaveDialog(win, {
    defaultPath: join(app.getPath('downloads'), filename),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return 'cancelled';
  await fs.writeFile(r.filePath, content, 'utf8');
  return 'saved';
});

/** Talk attachments: the renderer only ever receives opaque handles + name/size/type. */
ipcMain.handle('workhub:pickFiles', async (e) => {
  if (!isOurFrame(e.sender, e.senderFrame?.url)) return [];
  return files.pick();
});
ipcMain.handle('workhub:stageRecording', async (e, bytes: unknown) => {
  if (!isOurFrame(e.sender, e.senderFrame?.url)) return null;
  return files.stageRecording(bytes);
});
ipcMain.handle('workhub:releaseFile', async (e, handle: unknown) => {
  if (isOurFrame(e.sender, e.senderFrame?.url)) files.release(handle);
});

ipcMain.on('workhub:badge', (e, count: unknown) => {
  if (!isOurFrame(e.sender, e.senderFrame?.url) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 2_147_483_647) return;
  updateBadge(count);
});

ipcMain.on('workhub:foreground', (e, target: unknown) => {
  if (!isOurFrame(e.sender, e.senderFrame?.url)) return;
  const t = target as RoutedTarget | null;
  notifier.setForeground(win?.isVisible() && win.isFocused() && t && typeof t.accountId === 'string' && t.route && typeof t.route.name === 'string' ? t : null);
});

app.on('second-instance', () => focusWith(null));
app.on('before-quit', () => {
  quitting = true;
});

app.whenReady().then(async () => {
  // Deny every permission (camera, notifications-from-web, geolocation…) to the renderer. The
  // only exception is the MICROPHONE for voice notes, requested by our own top frame.
  const audioOnly = (types: readonly string[] | undefined) => !!types && types.length > 0 && types.every((t) => t === 'audio');
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
    const d = details as { mediaTypes?: string[]; requestingUrl?: string };
    cb(perm === 'media' && wc === win?.webContents && audioOnly(d.mediaTypes) && isOurFrame(wc, d.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((wc, perm, _origin, details) =>
    perm === 'media' && !!wc && wc === win?.webContents && (details as { mediaType?: string }).mediaType === 'audio');
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'"],
      },
    });
  });
  const w = createWindow();
  if (smokeOut) {
    await runSmoke(w, smokeOut);
    quitting = true;
    app.quit();
    return;
  }
  createTray();
  notifier.start();
});

app.on('window-all-closed', () => {
  if (!tray || process.platform !== 'darwin') {
    if (quitting || !tray) app.quit();
  }
});
app.on('activate', () => focusWith(null));
