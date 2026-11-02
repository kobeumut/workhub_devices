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
      const els = [...document.querySelectorAll('[role=button],[role=tab],button')];
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
      if (!(await click('açık', false))) throw new Error('project row');
      await waitText('To Do', 20_000);
      await shot('05-board');
    });
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
