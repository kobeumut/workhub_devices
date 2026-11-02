import { app, BrowserWindow, ipcMain, Menu, nativeImage, session, shell, Tray, type WebContents } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { createDirectBackend, dispatchWire, unregisterWebPush, type RoutedTarget } from '@workhub-devices/core';
import { createPlainStore, createSecretStore } from './stores';
import { DesktopNotifier } from './notifier';
import { runSmoke } from './smoke';

const smokeOut = process.env.WORKHUB_SMOKE_OUT;
const allowHttp = process.env.WORKHUB_ALLOW_HTTP === '1' && (!app.isPackaged || !!smokeOut);

if (!app.requestSingleInstanceLock()) app.quit();

const dataDir = app.getPath('userData');
const secrets = createSecretStore(dataDir);
const plain = createPlainStore(dataDir);
const backend = createDirectBackend({
  secrets,
  plain,
  userAgent: `WorkhubDesktop/${app.getVersion()} (${process.platform})`,
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
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
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
  win.on('closed', () => {
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
  tray.setToolTip('Workhub');
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
  if (!isOurFrame(e.sender, e.senderFrame?.url) || typeof url !== 'string' || !allowedExternal.has(url)) return false;
  if (smokeOut) {
    await fs.writeFile(join(smokeOut, 'login-url.txt'), url);
    return true;
  }
  await shell.openExternal(url);
  return true;
});

ipcMain.on('workhub:foreground', (e, target: unknown) => {
  if (!isOurFrame(e.sender, e.senderFrame?.url)) return;
  const t = target as RoutedTarget | null;
  notifier.setForeground(t && typeof t.accountId === 'string' && t.route && typeof t.route.name === 'string' ? t : null);
});

app.on('second-instance', () => focusWith(null));
app.on('before-quit', () => {
  quitting = true;
});

app.whenReady().then(async () => {
  // Deny every permission (camera, mic, notifications-from-web, geolocation…) to the renderer.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'"],
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
