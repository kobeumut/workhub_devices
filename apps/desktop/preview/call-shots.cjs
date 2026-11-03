// Call UI screenshots on the fixture preview (fake camera/mic, real WebRTC to an in-page peer):
// `npm run preview:call-shots`. Output: PREVIEW_OUT (default preview-out/).
const { app, BrowserWindow, session } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const out = process.env.PREVIEW_OUT || join(__dirname, '..', 'preview-out');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  const results = [];
  for (const [label, w, h] of [['desktop', 1440, 900], ['phone', 412, 900]]) {
    const win = new BrowserWindow({ show: false, width: w, height: h });
    win.setContentSize(w, h);
    await win.loadFile(join(__dirname, '..', 'dist-preview', 'index.html'));
    const js = (c) => win.webContents.executeJavaScript(c, true);
    const click = (text) => js(`(() => { const el = [...document.querySelectorAll('[role=button],[role=tab]')].find(e => e.innerText.trim() === ${JSON.stringify(text)} || e.getAttribute('aria-label') === ${JSON.stringify(text)} || (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
    const has = (text) => js(`document.body.innerText.includes(${JSON.stringify(text)})`);
    const shot = async (name) => { await sleep(1200); writeFileSync(join(out, `${label}-call-${name}.png`), (await win.webContents.capturePage()).toPNG()); };
    const must = (ok, what) => results.push(`${label}: ${what} ${ok ? 'ok' : 'FAILED'}`);
    await sleep(1200);
    must(await js(`(() => { const el = [...document.querySelectorAll('[role=button]')].find(e => e.innerText.includes('Mobil ekip')); if (!el) return false; el.click(); return true; })()`), 'open group room');
    await sleep(800);
    must(await has('Bu sohbette görüşme sürüyor'), 'ongoing call banner');
    must(await js(`!!document.querySelector('[aria-label="Sesli katıl"]') && !!document.querySelector('[aria-label="Görüntülü katıl"]')`), 'header join buttons');
    await shot('01-room-banner');
    must(await click('Görüntülü katıl'), 'join with video');
    let connected = false;
    for (let i = 0; i < 40 && !connected; i++) {
      await sleep(250);
      connected = await js(`[...document.querySelectorAll('video')].some(v => !v.muted && v.videoWidth > 0)`);
    }
    must(connected, 'remote video playing (real WebRTC)');
    must(await js(`!!document.querySelector('[aria-label="Mikrofonu kapat"]') && !!document.querySelector('[aria-label="Görüşmeyi bitir"]')`), 'call controls');
    await shot('02-call-video');
    must(await click('Mikrofonu kapat'), 'mute');
    must(await js(`!!document.querySelector('[aria-label="Mikrofonu aç"]')`), 'mute state shown');
    must(await click('Görüşmeyi küçült'), 'minimize');
    await shot('03-minimized');
    must(await click('Görüşmeye dön'), 'return to call');
    must(await click('Görüşmeyi bitir'), 'hang up');
    await sleep(500);
    must(await has('Görüşmeden ayrıldınız.'), 'ended state');
    await click('Kapat');
    await js(`window.previewRoute({ accountId: 'acc1', route: { name: 'call', token: 'r2' } })`);
    await sleep(800);
    must(await has('Gelen Talk araması'), 'incoming call screen');
    must(await js(`!!document.querySelector('[aria-label="Sesli kabul et"]') && !!document.querySelector('[aria-label="Reddet"]')`), 'accept / decline');
    await shot('04-incoming');
    must(await click('Reddet'), 'decline');
    await win.close();
  }
  writeFileSync(join(out, 'call-result.txt'), results.join('\n') + '\n');
  console.log(results.join('\n'));
  app.exit(results.some((r) => r.endsWith('FAILED')) ? 1 : 0);
});
