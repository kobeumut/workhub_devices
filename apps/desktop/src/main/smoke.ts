import type { BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Automated UI smoke (only when WORKHUB_SMOKE_OUT is set): drives the real renderer through
 * DOM events — login (approved externally), chats, send a message, tasks, board, inbox —
 * and writes screenshots + result.json. Never compiled into behaviour without the env flag.
 */
export async function runSmoke(win: BrowserWindow, out: string) {
  const steps: Array<{ step: string; ok: boolean; note?: string }> = [];
  const wc = win.webContents;
  const js = <T>(code: string) => wc.executeJavaScript(code, true) as Promise<T>;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitText = async (text: string, timeoutMs = 30_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await js<boolean>(`document.body.innerText.includes(${JSON.stringify(text)})`)) return true;
      await sleep(300);
    }
    throw new Error(`text not found: ${text}`);
  };
  const click = (text: string, exact = true) =>
    js<boolean>(`(() => {
      const els = [...document.querySelectorAll('[role=button],[role=tab],[role=checkbox],button')];
      const el = els.find(e => ${exact ? `e.innerText.trim() === ${JSON.stringify(text)} || e.getAttribute('aria-label') === ${JSON.stringify(text)}` : `e.innerText.includes(${JSON.stringify(text)})`});
      if (!el) return false; el.click(); return true; })()`);
  const type = (selector: string, value: string) =>
    js<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const shot = async (name: string) => {
    await sleep(800);
    const img = await wc.capturePage();
    await fs.writeFile(join(out, `${name}.png`), img.toPNG());
  };
  const step = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const note = await fn();
      steps.push({ step: name, ok: true, ...(note ? { note } : {}) });
    } catch (e) {
      steps.push({ step: name, ok: false, note: (e as Error).message });
      await shot(`fail-${steps.length}`).catch(() => undefined);
      throw e;
    }
  };

  let openBefore: number | null = null;
  const firstProjectOpenCount = () =>
    js<number | null>(`(() => {
      const el = [...document.querySelectorAll('[role=button]')].find(e => / açık · /.test(e.innerText));
      const m = el && el.innerText.match(/(\\d+) açık/); return m ? Number(m[1]) : null; })()`);

  try {
    await new Promise<void>((r) => (wc.isLoading() ? wc.once('did-finish-load', () => r()) : r()));
    win.setMinimumSize(320, 320);
    win.setContentSize(Number(process.env.WORKHUB_SMOKE_WIDTH ?? 1280), Number(process.env.WORKHUB_SMOKE_HEIGHT ?? 820));
    await step('login screen', async () => {
      await waitText('Bağlan');
      await shot('01-login');
    });
    await step('login flow v2 (approved by smoke script)', async () => {
      await type('input', process.env.WORKHUB_SMOKE_SERVER ?? '');
      if (!(await click('Bağlan'))) throw new Error('connect button');
      await waitText('Sohbetler', 120_000);
    });
    await step('chats list', async () => {
      await waitText(process.env.WORKHUB_SMOKE_ROOM ?? '', 30_000);
      await shot('02-chats');
    });
    const msg = `Masaüstünden merhaba ${new Date().toISOString().slice(11, 19)}`;
    await step('open room + send message via composer', async () => {
      if (!(await click(process.env.WORKHUB_SMOKE_ROOM ?? '', false))) throw new Error('room row');
      const end = Date.now() + 15_000;
      while (!(await js<boolean>(`!!document.querySelector('textarea')`))) {
        if (Date.now() > end) throw new Error('composer not found');
        await sleep(300);
      }
      await sleep(1500);
      await type('textarea', msg);
      if (!(await click('Gönder'))) throw new Error('send');
      await waitText(msg, 15_000);
      await sleep(1500);
      const pending = await js<boolean>(`document.body.innerText.includes('gönderiliyor')`);
      await shot('03-chat');
      return pending ? 'still pending' : `sent: ${msg}`;
    });
    await step('tasks: projects + board', async () => {
      await click('İşler');
      await waitText('açık', 20_000);
      await shot('04-projects');
      openBefore = await firstProjectOpenCount();
      if (!(await click('açık', false))) throw new Error('project row');
      await waitText('To Do', 20_000);
      await shot('05-board');
    });
    const editedTitle = `Düzenlendi ${new Date().toISOString().slice(11, 19)}`;
    const subtask = `Alt iş ${new Date().toISOString().slice(11, 19)}`;
    const taskTitle = `Masaüstü görevi ${new Date().toISOString().slice(11, 19)}`;
    await step('task: create → open detail → comment', async () => {
      await type('input', taskTitle);
      if (!(await click('+'))) throw new Error('add task');
      await waitText(taskTitle, 15_000);
      if (!(await click(taskTitle, false))) throw new Error('task row');
      await waitText('Yorumlar', 15_000);
      await type('textarea', 'Masaüstünden yorum');
      if (!(await click('Yorum ekle'))) throw new Error('comment');
      await waitText('Masaüstünden yorum', 15_000);
      await shot('06-task');
    });
    await step('task: edit fields + subtask, project counter refreshes', async () => {
      if (!(await click('Düzenle'))) throw new Error('edit button');
      await waitText('Görevi düzenle', 10_000);
      if (!(await type('input[aria-label="Başlık"]', editedTitle))) throw new Error('title input');
      if (!(await type('input[aria-label="Bitiş (YYYY-AA-GG)"]', '2026-12-31'))) throw new Error('due input');
      if (!(await type('input[aria-label="Tahmini süre (saat)"]', '1,5'))) throw new Error('estimate input');
      if (!(await click('Yüksek'))) throw new Error('priority chip');
      if (!(await click('Kaydet'))) throw new Error('save');
      await waitText(editedTitle, 15_000);
      await waitText('Tahmini: 1.5 sa', 15_000);
      if (!(await type('input[aria-label="Yeni alt iş"]', subtask))) throw new Error('subtask input');
      if (!(await click('Alt iş ekle'))) throw new Error('add subtask');
      await waitText(subtask, 15_000);
      if (!(await click(subtask))) throw new Error('subtask checkbox');
      await waitText('(1/1)', 15_000);
      await shot('06b-task-edit');
      // Wide layout keeps the project list visible: its open counter must include the new task.
      if (openBefore !== null) {
        const end = Date.now() + 15_000;
        let now = await firstProjectOpenCount();
        while (now !== openBefore + 1 && Date.now() < end) {
          await sleep(500);
          now = await firstProjectOpenCount();
        }
        if (now !== openBefore + 1) throw new Error(`counter stale: ${openBefore} → ${now}`);
        return `open counter ${openBefore} → ${now}`;
      }
      return 'counter not visible';
    });
    await step('time module: start → stop timer', async () => {
      await click('İşler');
      await sleep(500);
      if (!(await click('Zaman'))) throw new Error('time tab');
      await waitText('Zamanlayıcı', 15_000);
      if (await js<boolean>(`document.body.innerText.includes('Durdur')`)) await click('Durdur');
      await waitText('Başlat', 15_000);
      await type('input', 'Masaüstü smoke');
      await click('Başlat');
      await waitText('Durdur', 15_000);
      await shot('07-time');
      await click('Durdur');
      await waitText('Başlat', 15_000);
    });
    await step('inbox', async () => {
      await click('Bildirimler');
      await sleep(2500);
      await shot('08-inbox');
    });
    await step('account', async () => {
      await click('Hesap');
      await waitText('Çıkış yap');
      await shot('09-account');
    });
  } catch {
    /* recorded in steps */
  } finally {
    await fs.writeFile(join(out, 'result.json'), JSON.stringify({ steps }, null, 2));
  }
}
