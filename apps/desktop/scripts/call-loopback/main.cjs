// Electron entry for the call loopback smoke (fake media devices, hidden window).
const { app, BrowserWindow, session } = require('electron');
const { join } = require('node:path');
const { writeFileSync } = require('node:fs');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(join(__dirname, 'index.html'));
  const result = await win.webContents.executeJavaScript('window.loopback');
  const out = process.env.WH_LOOPBACK_OUT;
  if (out) writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
});
