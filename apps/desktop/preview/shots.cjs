// Screenshots of the fixture preview: `npm run preview:shots` (electron, headless). Output: PREVIEW_OUT.
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const out = process.env.PREVIEW_OUT || join(__dirname, '..', 'preview-out');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const results = [];
  for (const [label, w, h] of [['desktop', 1440, 900], ['phone', 412, 900]]) {
    const win = new BrowserWindow({ show: false, width: w, height: h, webPreferences: { offscreen: false } });
    win.setContentSize(w, h);
    await win.loadFile(join(__dirname, '..', 'dist-preview', 'index.html'));
    const js = (c) => win.webContents.executeJavaScript(c, true);
    const click = (text) => js(`(() => { const el = [...document.querySelectorAll('[role=button],[role=tab],[role=checkbox],[role=menuitem]')].find(e => e.innerText.trim() === ${JSON.stringify(text)} || e.getAttribute('aria-label') === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`);
    const shot = async (name) => { await sleep(1500); writeFileSync(join(out, `${label}-${name}.png`), (await win.webContents.capturePage()).toPNG()); };
    const must = async (ok, what) => { results.push(`${label}: ${what} ${ok ? 'ok' : 'FAILED'}`); };
    await sleep(1200);
    await shot('01-chats');
    await must(await click('İşler'), 'tasks tab');
    await shot('02-workhub-home');
    await must(await js(`(() => { const el = [...document.querySelectorAll('[role=button]')].find(e => (e.getAttribute('aria-label') || '').startsWith('Dermo Mobil Uygulama')); if (!el) return false; el.click(); return true; })()`), 'open project');
    await shot('03-kanban');
    await must(await click('Filtreler'), 'filters');
    await must(await click('Acil'), 'priority filter');
    await shot('04-kanban-filtered');
    await click('Temizle'); await click('Filtreler');
    await must(await click('Talk arama API araştırması: işlemler'), 'card menu');
    await shot('05-card-menu');
    await must(await click('Sağa taşı: Devam ediyor'), 'move right');
    await sleep(500);
    await must(await js(`!!document.querySelector('[aria-label="Devam ediyor, 3 görev"]')`), 'card moved (Devam ediyor has 3)');
    await must(await click('Görev ekle'), 'add task');
    await js(`(() => { const el = document.querySelector('input[aria-label$="listesinde yeni görev"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, 'Önizleme görevi'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await must(await click('Ekle'), 'submit');
    await sleep(500);
    await must(await js(`document.body.innerText.includes('Önizleme görevi')`), 'new card visible');
    if (label === 'desktop') {
      // Mouse drag & drop through real DOM drag events: card #102 → end of "İncelemede".
      const dnd = await js(`(async () => {
        const card = document.querySelector('[data-task-id="102"]');
        const col = document.querySelector('[aria-label^="İncelemede, "]');
        if (!card || !col) return 'missing';
        const dt = new DataTransfer();
        card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        await new Promise((r) => setTimeout(r, 300));
        const r = col.getBoundingClientRect();
        const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.bottom - 5 };
        col.dispatchEvent(new DragEvent('dragover', at));
        await new Promise((r) => setTimeout(r, 300));
        col.dispatchEvent(new DragEvent('drop', at));
        card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        return 'ok';
      })()`);
      await sleep(800);
      await must(dnd === 'ok' && (await js(`!!document.querySelector('[aria-label="İncelemede, 2 görev"]')`)), 'drag & drop card into İncelemede');
      await shot('05b-after-drag');
    }
    await must(await click('Giriş ekranı için yeni tasarım'), 'open task');
    await shot('06-task');
    if (label === 'phone') await click('Geri'); else await click('Kapat');
    await sleep(400);
    await must(await click('Pano'), 'pano tab');
    await shot('07-pano-list');
    await win.close();
  }
  writeFileSync(join(out, 'result.txt'), results.join('\n') + '\n');
  console.log(results.join('\n'));
  app.quit();
});
