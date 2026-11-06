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
  /** Like waitText, but scrolls virtualised lists (boards/Gantt grow with every smoke run on the dev server). */
  const reveal = async (text: string, timeoutMs = 30_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await js<boolean>(`document.body.innerText.includes(${JSON.stringify(text)})`)) return true;
      await js(`(() => { for (const el of document.querySelectorAll('div')) if (el.scrollHeight > el.clientHeight + 10 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop += 600; })()`);
      await sleep(300);
    }
    throw new Error(`text not found: ${text}`);
  };
  const click = (text: string, exact = true) =>
    js<boolean>(`(() => {
      const els = [...document.querySelectorAll('[role=button],[role=tab],[role=checkbox],button')];
      const el = els.find(e => ${exact ? `e.innerText.trim() === ${JSON.stringify(text)} || e.getAttribute('aria-label') === ${JSON.stringify(text)}` : `e.innerText.includes(${JSON.stringify(text)})`});
      if (!el) return false; el.click(); return true; })()`);
  const webTab = () => js<boolean>(`[...document.querySelectorAll('[role=tab]')].some(e => ['Diğer', 'Yönetim'].includes(e.innerText.trim()))`);
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
  let firstBoardTitle = '';
  const firstProjectOpenCount = () =>
    js<number | null>(`(() => {
      const el = [...document.querySelectorAll('[role=button]')].find(e => (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(firstBoardTitle)}) && / açık/.test(e.getAttribute('aria-label') || ''));
      const m = el && el.getAttribute('aria-label').match(/(\\d+) açık/); return m ? Number(m[1]) : null; })()`);
  /** Opens the first project: a project-list row or the sidebar item (both labelled "<title>…N açık…"). */
  const openProject = () =>
    js<boolean>(`(() => { const el = [...document.querySelectorAll('[role=button]')].find(e => (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(firstBoardTitle)}) && / açık/.test(e.getAttribute('aria-label') || '')); if (!el) return false; el.click(); return true; })()`);
  const waitLabel = async (label: string, timeoutMs = 15_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await js<boolean>(`!!document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`)) return true;
      await sleep(300);
    }
    throw new Error(`label not found: ${label}`);
  };
  /** Kanban quick add: header "Görev ekle" opens the first column's input. */
  const addTask = async (title: string) => {
    if (!(await click('Görev ekle'))) throw new Error('add task button');
    await sleep(300);
    if (!(await type('input[aria-label$="listesinde yeni görev"]', title))) throw new Error('new task input');
    if (!(await click('Ekle'))) throw new Error('add task');
  };

  try {
    await new Promise<void>((r) => (wc.isLoading() ? wc.once('did-finish-load', () => r()) : r()));
    // Offscreen smoke simulates foreground; it cannot verify native OS focus/visibility.
    await js(`Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true });
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      window.dispatchEvent(new Event('focus'));`);
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
    // Talk extensions (GENE-57): the other participant (B) acts over the REST API while the UI is open.
    const bUser = process.env.WORKHUB_SMOKE_B_USER ?? '';
    const bPass = process.env.WORKHUB_SMOKE_B_PASS ?? '';
    const asB = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const r = await fetch(`${process.env.WORKHUB_SMOKE_SERVER}${path}${path.includes('?') ? '&' : '?'}format=json`, {
        method,
        headers: { Authorization: `Basic ${Buffer.from(`${bUser}:${bPass}`).toString('base64')}`, 'OCS-APIRequest': 'true', Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!r.ok) throw new Error(`B ${method} → ${r.status}`);
      return ((await r.json()) as { ocs: { data: T } }).ocs.data;
    };
    /** Click the LAST matching button: the chat pane comes after the room list (whose rows preview the same text). */
    const clickLast = (text: string) =>
      js<boolean>(`(() => {
        const els = [...document.querySelectorAll('[role=button]')].filter(e => e.innerText.includes(${JSON.stringify(text)}) || e.getAttribute('aria-label') === ${JSON.stringify(text)});
        const el = els[els.length - 1]; if (!el) return false; el.click(); return true; })()`);
    const textareaValue = () => js<string>(`(document.querySelector('textarea') || {}).value || ''`);
    if (bUser && bPass) {
      const stamp = new Date().toISOString().slice(11, 19);
      const roomName = `Masaüstü Talk ${stamp}`;
      let token = '';
      await step('talk: new group conversation → description → add participant (autocomplete) → promote', async () => {
        await click('Sohbetler');
        if (!(await click('+ Yeni sohbet'))) throw new Error('new room button');
        if (!(await type('input[aria-label="Sohbet adı"]', roomName))) throw new Error('room name input');
        if (!(await click('Sohbeti oluştur'))) throw new Error('create');
        await waitText(roomName, 15_000);
        // The info button appears once the fresh room read has returned.
        const endI = Date.now() + 10_000;
        while (!(await click('Sohbet bilgileri'))) {
          if (Date.now() > endI) throw new Error('info button');
          await sleep(300);
        }
        await waitText('Katılımcılar', 10_000);
        if (!(await type('textarea[aria-label="Açıklama"]', 'Masaüstü smoke açıklaması'))) throw new Error('description');
        if (!(await click('Bilgileri kaydet'))) throw new Error('save info');
        await waitText('Sohbet bilgileri kaydedildi.', 10_000);
        if (!(await type('input[aria-label="Katılımcı ekle: kişi veya grup ara"]', bUser.slice(0, 3)))) throw new Error('invite search');
        const member = process.env.WORKHUB_SMOKE_MEMBER ?? 'Bob';
        const end = Date.now() + 10_000;
        while (!(await click(`${member} ekle`))) {
          if (Date.now() > end) throw new Error('invite candidate');
          await sleep(300);
        }
        await waitText(`${member} eklendi.`, 10_000);
        if (!(await click(`${member}: moderatör yap`))) throw new Error('promote');
        const promotedBy = Date.now() + 10_000;
        while (!(await js<boolean>(`!!document.querySelector('[aria-label=${JSON.stringify(`${member}: moderatörlüğü al`)}]')`))) {
          if (Date.now() > promotedBy) throw new Error('promote not applied');
          await sleep(300);
        }
        await shot('03b-talk-room-settings');
        if (!(await click(`${member}: moderatörlüğü al`))) throw new Error('demote');
        const end2 = Date.now() + 10_000;
        while (!(await js<boolean>(`!!document.querySelector('[aria-label=${JSON.stringify(`${member}: moderatör yap`)}]')`))) {
          if (Date.now() > end2) throw new Error('demote not applied');
          await sleep(300);
        }
        if (!(await click('Kapat'))) throw new Error('close info');
        await waitText('Masaüstü smoke açıklaması', 10_000);
        const rooms = await asB<Array<{ token: string; displayName: string }>>('GET', '/ocs/v2.php/apps/spreed/api/v4/room');
        token = rooms.find((r) => r.displayName === roomName)?.token ?? '';
        if (!token) throw new Error('B does not see the room');
        return `room ${token}; B sees it`;
      });
      const first = `Talk ilk ${stamp}`;
      let firstId = 0;
      await step('talk: mention autocomplete → send; B reacts + edits own message → visible live in the UI', async () => {
        if (!(await type('textarea', `@${bUser.slice(0, 2)}`))) throw new Error('composer');
        const end = Date.now() + 10_000;
        while (!(await click(`Bahset: ${process.env.WORKHUB_SMOKE_MEMBER ?? 'Bob'}`))) {
          if (Date.now() > end) throw new Error('mention suggestion');
          await sleep(300);
        }
        const v = await textareaValue();
        if (!v.startsWith(`@${bUser}`) && !v.startsWith(`@"${bUser}"`)) throw new Error(`mention not inserted: ${v.length} chars`);
        await type('textarea', `${v}${first}`);
        if (!(await click('Gönder'))) throw new Error('send');
        await waitText(first, 15_000);
        await waitText(`@${process.env.WORKHUB_SMOKE_MEMBER ?? 'Bob'}`, 10_000);
        // The pending bubble shows the text immediately; wait until the server has it.
        let m: { id: number; message: string; messageParameters: unknown } | undefined;
        for (const endB = Date.now() + 15_000; !m && Date.now() < endB; await sleep(500)) {
          const msgs = await asB<Array<{ id: number; message: string; messageParameters: unknown }>>('GET', `/ocs/v2.php/apps/spreed/api/v1/chat/${token}?lookIntoFuture=0&limit=20`);
          m = msgs.find((x) => x.message.includes(first));
        }
        if (!m) throw new Error('B does not see the message');
        if (!JSON.stringify(m.messageParameters).includes(`"id":"${bUser}"`)) throw new Error('mention not parsed by server');
        firstId = m.id;
        await asB('POST', `/ocs/v2.php/apps/spreed/api/v1/reaction/${token}/${firstId}`, { reaction: '👍' });
        const bMsg = await asB<{ id: number }>('POST', `/ocs/v2.php/apps/spreed/api/v1/chat/${token}`, { message: `B mesajı ${stamp}` });
        await asB('PUT', `/ocs/v2.php/apps/spreed/api/v1/chat/${token}/${bMsg.id}`, { message: `B düzeltti ${stamp}` });
        await waitText('👍 1', 45_000);
        await waitText(`B düzeltti ${stamp}`, 45_000);
        await waitText('düzenlendi', 5_000);
        await shot('03c-talk-live-updates');
        return `mention parsed for ${bUser}; reaction + edit from B arrived through the long-poll`;
      });
      const edited = `Talk düzenlendi ${stamp}`;
      await step('talk: reply (quote) → edit own → add reaction → who reacted → search → delete; B sees each change', async () => {
        if (!(await clickLast(first))) throw new Error('select message');
        if (!(await click('Yanıtla'))) throw new Error('reply button');
        await waitText('Yanıtlanıyor', 5_000);
        await type('textarea', `Yanıt ${stamp}`);
        if (!(await click('Gönder'))) throw new Error('send reply');
        await waitText(`Yanıt ${stamp}`, 15_000);
        if (!(await clickLast(first))) throw new Error('select again');
        if (!(await click('Mesajı düzenle'))) throw new Error('edit button');
        await waitText('Mesaj düzenleniyor', 5_000);
        const cur = await textareaValue();
        if (!cur.includes(first)) throw new Error('edit box not prefilled');
        await type('textarea', cur.replace(first, edited));
        if (!(await click('Düzenlemeyi kaydet'))) throw new Error('save edit');
        await waitText(edited, 15_000);
        if (!(await clickLast(edited))) throw new Error('select edited');
        if (!(await click('Tepki ekle'))) throw new Error('reaction picker');
        if (!(await click('🎉 tepkisi ekle'))) throw new Error('pick 🎉');
        await waitText('🎉 1', 10_000);
        if (!(await clickLast(edited))) throw new Error('select for reactors');
        if (!(await click('Tepki verenler'))) throw new Error('reactors');
        await waitText(`👍 ${process.env.WORKHUB_SMOKE_MEMBER ?? 'Bob'}`, 10_000);
        await shot('03d-talk-actions');
        // B's view after edit + reaction: the quote in the reply carries the edited text
        const seen = await asB<Array<{ id: number; message: string; reactions?: Record<string, number>; lastEditTimestamp?: number; parent?: { id: number; message?: string } }>>('GET', `/ocs/v2.php/apps/spreed/api/v1/chat/${token}?lookIntoFuture=0&limit=30`);
        const orig = seen.find((x) => x.id === firstId);
        if (!orig?.message.includes(edited) || !orig.lastEditTimestamp) throw new Error('B does not see the edit');
        if (orig.reactions?.['🎉'] !== 1 || orig.reactions?.['👍'] !== 1) throw new Error('B does not see both reactions');
        const reply = seen.find((x) => x.message === `Yanıt ${stamp}`);
        if (reply?.parent?.id !== firstId) throw new Error('reply has no quote for B');
        // search (unified search, this conversation)
        if (!(await click('Bu sohbette ara'))) throw new Error('search button');
        if (!(await type('input[aria-label="Bu sohbette ara"]', 'düzenlendi'))) throw new Error('search input');
        if (!(await click('Aramayı başlat'))) throw new Error('search run');
        const endS = Date.now() + 15_000;
        while (!(await js<boolean>(`[...document.querySelectorAll('[role=button]')].some(e => e.innerText.includes(${JSON.stringify(stamp)}) && e.innerText.includes('düzenlendi') && !e.innerText.includes('Yanıt'))`))) {
          if (Date.now() > endS) throw new Error('search found nothing');
          await sleep(300);
        }
        await shot('03e-talk-search');
        if (!(await click('Kapat'))) throw new Error('close search');
        // delete
        if (!(await clickLast(edited))) throw new Error('select for delete');
        if (!(await click('Mesajı sil'))) throw new Error('delete button');
        if (!(await click('Evet, sil'))) throw new Error('confirm delete');
        await waitText('Bu mesaj silindi', 10_000);
        const after = await asB<Array<{ id: number; messageType: string }>>('GET', `/ocs/v2.php/apps/spreed/api/v1/chat/${token}?lookIntoFuture=0&limit=30`);
        if (after.find((x) => x.id === firstId)?.messageType !== 'comment_deleted') throw new Error('B does not see the deletion');
        return 'B: edit + 🎉/👍 + quote + deletion confirmed';
      });
      // Talk files (GENE-58): upload with caption + progress tray, download/open of B's file, voice note.
      const bAuth = `Basic ${Buffer.from(`${bUser}:${bPass}`).toString('base64')}`;
      const davB = (method: string, path: string, body?: Uint8Array) =>
        fetch(`${process.env.WORKHUB_SMOKE_SERVER}/remote.php/dav/files/${encodeURIComponent(bUser)}/${path.split('/').map(encodeURIComponent).join('/')}`, {
          method, headers: { Authorization: bAuth }, ...(body ? { body: body as BodyInit } : {}),
        });
      type Msg = { id: number; message: string; messageType: string; messageParameters: Record<string, { type: string; name?: string }> | [] };
      const fileName = (m: Msg) => (Array.isArray(m.messageParameters) ? undefined : m.messageParameters.file?.name);
      const bFeed = () => asB<Msg[]>('GET', `/ocs/v2.php/apps/spreed/api/v1/chat/${token}?lookIntoFuture=0&limit=30`);
      await step('talk files: attach (caption from composer) → progress tray → shared; B gets the file + caption', async () => {
        const caption = `Ek açıklaması ${stamp}`;
        await type('textarea', caption);
        if (!(await click('Dosya ekle'))) throw new Error('attach button');
        await waitText('Masaüstü ek', 10_000);
        const end = Date.now() + 30_000;
        let file: Msg | undefined;
        while (!(file = (await bFeed()).find((m) => fileName(m)?.startsWith('Masaüstü ek')))) {
          if (Date.now() > end) throw new Error('B does not see the file');
          await sleep(500);
        }
        if (file.message !== caption) throw new Error('caption missing for B');
        await waitText(caption, 10_000);
        const trayGone = Date.now() + 10_000;
        while (await js<boolean>(`!!document.querySelector('[aria-label="Dosya yüklemeleri"]')`)) {
          if (Date.now() > trayGone) throw new Error('upload tray still visible');
          await sleep(300);
        }
        if (await textareaValue()) throw new Error('composer not cleared');
        await shot('03f-talk-file');
        return `B: ${fileName(file)} + caption`;
      });
      await step('talk files: B shares a PDF → Download (main writes it; bytes identical) → Open (safe type)', async () => {
        const name = `B rapor ${stamp}.pdf`;
        const bytes = new TextEncoder().encode(`%PDF-1.4\n% GENE-58 ${stamp}\n`.repeat(100));
        await davB('MKCOL', 'Talk');
        const put = await davB('PUT', `Talk/${name}`, bytes);
        if (!put.ok) throw new Error(`B upload ${put.status}`);
        await asB('POST', '/ocs/v2.php/apps/files_sharing/api/v1/shares', { shareType: 10, shareWith: token, path: `/Talk/${name}`, talkMetaData: JSON.stringify({ messageType: 'comment' }) });
        await waitText(name, 20_000);
        if (!(await click(`İndir: ${name}`))) throw new Error('download button');
        await waitText('Kaydedildi.', 20_000);
        const saved = await fs.readFile(join(out, `saved-${name.replace(/:/g, '_')}`));
        if (Buffer.compare(saved, Buffer.from(bytes)) !== 0) throw new Error('saved bytes differ');
        if (!(await click(`Aç: ${name}`))) throw new Error('open button');
        await waitText('Açıldı.', 20_000);
        await fs.stat(join(out, `opened-${name.replace(/:/g, '_')}`));
        await shot('03g-talk-download');
        await davB('DELETE', `Talk/${name}`);
        return `${saved.byteLength} bytes, sha match`;
      });
      await step('talk files: voice note (fake mic) → record → send → B gets voice-message (WAV) → play', async () => {
        if (!(await click('Sesli not kaydet'))) throw new Error('record button');
        await waitText('Kaydediliyor', 10_000);
        await sleep(3000);
        if (!(await click('Sesli notu gönder'))) throw new Error('send voice');
        const end = Date.now() + 30_000;
        let voice: Msg | undefined;
        while (!(voice = (await bFeed()).find((m) => m.messageType === 'voice-message'))) {
          if (Date.now() > end) throw new Error('B has no voice-message');
          await sleep(500);
        }
        await waitText('🎤 Sesli not', 10_000);
        await shot('03h-talk-voice');
        const playClicked = await js<boolean>(`(() => { const els = [...document.querySelectorAll('[role=button]')].filter(e => (e.getAttribute('aria-label') || '').startsWith('Dinle: ')); const el = els[els.length - 1]; if (!el) return false; el.click(); return true; })()`);
        if (!playClicked) throw new Error('play button');
        const endP = Date.now() + 10_000;
        let played = false;
        while (Date.now() < endP && !played) {
          played = await js<boolean>(`document.body.innerText.includes('■ Durdur')`);
          if (!played) await sleep(150);
        }
        const err = await js<boolean>(`[...document.querySelectorAll('[role=alert]')].some(e => /hata|başarısız|ulaşılam/i.test(e.innerText))`);
        if (err) throw new Error('playback error shown');
        return `B: ${fileName(voice)} (${voice.messageType}); playback ${played ? 'started' : 'not observed (clip ended)'}`;
      });
      await step('talk: delete the conversation for everyone → gone from the list and for B', async () => {
        if (!(await click('Sohbet bilgileri'))) throw new Error('info');
        if (!(await click('Sohbeti herkes için sil'))) throw new Error('delete room');
        if (!(await click('Evet, kalıcı olarak sil'))) throw new Error('confirm delete room');
        const end = Date.now() + 15_000;
        while (await js<boolean>(`document.body.innerText.includes(${JSON.stringify(roomName)})`)) {
          if (Date.now() > end) throw new Error('room still listed');
          await sleep(500);
        }
        const rooms = await asB<Array<{ token: string }>>('GET', '/ocs/v2.php/apps/spreed/api/v4/room');
        if (rooms.some((r) => r.token === token)) throw new Error('B still has the room');
        token = '';
      });
      if (token) await asB('DELETE', `/ocs/v2.php/apps/spreed/api/v4/room/${token}/participants/self`).catch(() => undefined);
    }
    await step('tasks: projects + board', async () => {
      await click('İşler');
      await waitText('açık', 20_000);
      await shot('04-projects');
      firstBoardTitle = await js<string>(`(() => { const el = [...document.querySelectorAll('[role=button]')].find(e => /: \\d+ açık, /.test(e.getAttribute('aria-label') || '')); return el ? el.getAttribute('aria-label').replace(/: \\d+ açık, .*$/, '') : ''; })()`);
      openBefore = await firstProjectOpenCount();
      if (!(await openProject())) throw new Error('project row');
      await waitText('To Do', 20_000);
      await shot('05-board');
    });
    const editedTitle = `Düzenlendi ${new Date().toISOString().slice(11, 19)}`;
    const subtask = `Alt iş ${new Date().toISOString().slice(11, 19)}`;
    const taskTitle = `Masaüstü görevi ${new Date().toISOString().slice(11, 19)}`;
    await step('task: create → open detail → comment', async () => {
      await addTask(taskTitle);
      await reveal(taskTitle);
      await shot('05b-kanban-added');
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
      await waitText('1.5 sa', 15_000);
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
    await step('project views: Gantt (edited task as milestone) → activity stream (title change, paging)', async () => {
      if (!(await openProject())) throw new Error('project row');
      await waitText('To Do', 20_000);
      if (!(await click('Gantt'))) throw new Error('gantt tab');
      await waitText('Zaman çizelgesi', 20_000);
      await reveal(editedTitle);
      const row = await js<string | null>(`(() => { const el = [...document.querySelectorAll('[role=button]')].find(e => (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(editedTitle)})); return el ? el.getAttribute('aria-label') : null; })()`);
      if (!row || !row.includes('Kilometre taşı')) throw new Error(`gantt row label: ${row}`);
      await shot('19-gantt');
      if (!(await click('Etkinlik'))) throw new Error('activity tab');
      await waitText('başlığı değiştirdi', 20_000);
      if (!(await click('Filtre: Alt işler'))) throw new Error('subtasks filter');
      await waitText('alt işi tamamladı', 15_000);
      await shot('20-activity');
      if (!(await click('Filtre: Tümü'))) throw new Error('all filter');
      await waitText('başlığı değiştirdi', 15_000);
      const paged = (await click('Daha eski')) ? 'older page loaded' : 'single page';
      await sleep(1500);
      if (!(await click('Pano'))) throw new Error('board tab');
      await waitText(editedTitle, 15_000);
      await shot('19b-pano-list');
      if (!(await click('Kanban'))) throw new Error('kanban tab');
      return `gantt label: "${row.slice(0, 80)}…"; activity ${paged}`;
    });
    await step('workload matrix: person × day table with spoken cells; no web-fallback tab', async () => {
      if (!(await click('İş yükü'))) throw new Error('workload tab');
      await waitText('Kişi', 20_000);
      const t = await js<{ headers: number; rows: number; cell: string | null }>(`(() => { const t = document.querySelector('[role=table]'); const c = t && [...t.querySelectorAll('[role=button]')].find(e => (e.getAttribute('aria-label') || '').includes('planlanan')); return { headers: t ? t.querySelectorAll('[role=columnheader]').length : 0, rows: t ? t.querySelectorAll('[role=row]').length : 0, cell: c ? c.getAttribute('aria-label') : null }; })()`);
      if (t.headers !== 9 || t.rows < 2 || !t.cell) throw new Error(`workload table ${JSON.stringify(t)}`);
      if (!(await click('2 hafta'))) throw new Error('span chip');
      await sleep(1500);
      const wide = await js<number>(`document.querySelector('[role=table]')?.querySelectorAll('[role=columnheader]').length ?? 0`);
      if (wide !== 16) throw new Error(`2-week headers ${wide}`);
      await click(t.cell);
      await sleep(800);
      await shot('21-workload');
      // GENE-56: the web-fallback tab ("Diğer") is gone; only admins get "Yönetim" (web, password confirmation).
      if (await webTab()) throw new Error('web fallback tab visible for a non-admin');
      const links = await js<boolean>(`document.body.innerText.includes('İş yükü ↗') || document.body.innerText.includes('Gantt ve etkinlik')`);
      if (links) throw new Error('web fallback links still listed');
      await click('Projeler');
      return `${t.headers} columns × ${t.rows} rows; cell "${t.cell.slice(0, 90)}…"`;
    });
    await step('dashboards: create (project summary) → KPI + distribution tables → drill-down → task; widget add/edit/CSV/remove; delete', async () => {
      const dashTitle = `Masaüstü dashboard ${new Date().toISOString().slice(11, 19)}`;
      const until = async (fn: () => Promise<boolean>, what: string, ms = 15_000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          if (await fn()) return;
          await sleep(300);
        }
        throw new Error(what);
      };
      await click('İşler');
      await sleep(500);
      if (!(await click('Dashboard'))) throw new Error('dashboard tab');
      await waitText('Yeni dashboard', 20_000);
      if (!(await type('input[aria-label="Dashboard başlığı"]', dashTitle))) throw new Error('title input');
      if (!(await click('Dashboard oluştur'))) throw new Error('create');
      await waitText('Distribution by column', 20_000);
      await until(() => js<boolean>(`document.querySelectorAll('[role=table]').length >= 2`), 'widget results (tables)', 30_000);
      const t = await js<{ tables: number; headers: string[]; kpi: string | null }>(`(() => {
        const tables = [...document.querySelectorAll('[role=table]')];
        const kpi = [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).find(l => /^Total work: \\d/.test(l || ''));
        return { tables: tables.length, headers: tables[0] ? [...tables[0].querySelectorAll('[role=columnheader]')].map(e => e.innerText.trim()).filter(Boolean) : [], kpi: kpi || null }; })()`);
      if (t.tables < 2 || t.headers.join('|') !== 'Grup|Değer|Pay' || !t.kpi) throw new Error(`dashboard tables ${JSON.stringify(t)}`);
      await shot('22-dashboard');
      await js(`document.querySelector('[role=table]')?.scrollIntoView()`);
      await shot('22b-dashboard-distribution');
      // Distribution group → cards of that group only.
      const group = await js<string | null>(`(() => { const b = [...document.querySelectorAll('[role=table] [role=button]')].find(e => (e.getAttribute('aria-label') || '').endsWith('. Kartları aç')); return b ? b.getAttribute('aria-label') : null; })()`);
      if (!group || !(await click(group))) throw new Error('distribution group button');
      await waitText('kart gösteriliyor', 20_000);
      if (!(await click('‹ Dashboard'))) throw new Error('back from group');
      // KPI drill-down → card list → task detail.
      await until(() => click('Total work: kartları aç'), 'kpi drill-down');
      await waitText('kart gösteriliyor', 20_000);
      const shown = await js<string>(`document.body.innerText.match(/(\\d+) kart gösteriliyor/)?.[1] ?? '0'`);
      const task = await js<string | null>(`(() => { const b = [...document.querySelectorAll('[role=table] [role=button]')].find(e => (e.getAttribute('aria-label') || '').endsWith('. Görevi aç')); return b ? b.getAttribute('aria-label') : null; })()`);
      if (!task || !(await click(task))) throw new Error('task row in drill-down');
      await waitText('Yorumlar', 20_000);
      await shot('23-dashboard-drilldown');
      if (!(await click('‹ Dashboard'))) throw new Error('back from drill-down');
      // Widget CRUD + CSV.
      await until(() => click('Widget ekle'), 'add widget');
      await until(() => click('Card list (Kart listesi)'), 'card list type');
      await until(() => type('input[aria-label="Başlık (boş = Card list)"]', 'Smoke listesi'), 'widget title');
      if (!(await click('Completed'))) throw new Error('preset chip');
      if (!(await click('Ekle'))) throw new Error('add');
      await waitText('Widget eklendi.', 15_000);
      await until(() => click('Smoke listesi: CSV indir'), 'widget csv');
      await waitText('Kaydedildi: workhub-dashboard-', 15_000);
      if (!(await click("Smoke listesi: widget'ı düzenle"))) throw new Error('edit widget');
      await until(() => type('input[aria-label="Başlık (boş = Card list)"]', 'Smoke listesi 2'), 'edit title');
      if (!(await click('Kaydet'))) throw new Error('save widget');
      await waitText('Widget kaydedildi.', 15_000);
      await until(() => click("Smoke listesi 2: widget'ı kaldır"), 'remove widget');
      await until(() => click('Evet, kaldır'), 'confirm remove');
      await waitText('Widget kaldırıldı.', 15_000);
      if (!(await click('Sil'))) throw new Error('delete dashboard');
      if (!(await click('Evet, sil'))) throw new Error('confirm delete');
      await waitText('Yeni dashboard', 15_000);
      await sleep(1000);
      if (await js<boolean>(`document.body.innerText.includes(${JSON.stringify(dashTitle)})`)) throw new Error('dashboard still listed');
      // GENE-56: the web-fallback tab ("Diğer") is gone; only admins get "Yönetim" (web, password confirmation).
      if (await webTab()) throw new Error('web fallback tab visible for a non-admin');
      if (await js<boolean>(`document.body.innerText.includes("Dashboard'lar ve widget'lar")`)) throw new Error('dashboard web link still listed');
      await click('Projeler');
      return `${t.tables} tables, "${t.kpi}", drill-down ${shown} cards → task; widget add/edit/CSV/remove; deleted`;
    });
    await step('workflows: create from sample → set lists → save → start run → task → complete → hand-off from task screen; cancel a run; delete', async () => {
      const wfTitle = `Masaüstü akış ${new Date().toISOString().slice(11, 19)}`;
      const until = async (fn: () => Promise<boolean>, what: string, ms = 15_000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          if (await fn()) return;
          await sleep(300);
        }
        throw new Error(what);
      };
      /** Clicks the n-th control whose aria-label starts with `prefix`; returns its label. */
      const nth = (prefix: string, n = 0) => js<string | null>(`(() => { const els = [...document.querySelectorAll('[role=button],[role=checkbox],[role=tab]')].filter(e => (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(prefix)})); const el = els[${n}]; if (!el) return null; el.click(); return el.getAttribute('aria-label'); })()`);
      const pickList = async () => {
        await until(async () => !!(await nth('Kartın oluşturulacağı liste: liste seç')), 'list picker');
        await until(async () => !!(await nth('Proje: ')), 'project chip', 20_000);
        await until(async () => !!(await nth('Liste: ')), 'stack chip', 20_000);
      };
      await click('İşler');
      await sleep(500);
      if (!(await click('İş akışları'))) throw new Error('workflows tab');
      await waitText('Sizi bekleyenler', 20_000);
      await shot('24-workflows-pending');
      if (!(await click('Şablonlar'))) throw new Error('templates tab');
      await waitText('Yeni iş akışı', 20_000);
      if (!(await type('input[aria-label="İş akışı başlığı"]', wfTitle))) throw new Error('title input');
      // Third sample = "prepare and review" (2 steps: fixed → hand-off → chosen).
      await until(async () => !!(await nth('Örnek: ', 2)), 'sample chip', 20_000);
      if (!(await click('İş akışı oluştur'))) throw new Error('create');
      await waitText('Çalıştırmalar', 20_000);
      await waitText('hedef listesi yok', 10_000);
      if (!(await click('Adımlar'))) throw new Error('steps');
      await pickList();
      if (!(await nth('Adım: ', 1))) throw new Error('second step chip');
      await pickList();
      await shot('25-workflow-editor');
      if (!(await click('Adımları kaydet'))) throw new Error('save steps');
      await waitText('Adımlar kaydedildi.', 15_000);
      await sleep(800);
      if (await js<boolean>(`document.body.innerText.includes('hedef listesi yok')`)) throw new Error('issues still listed after save');
      // Run 1 → open its first card → complete → hand over from the task screen.
      if (!(await click('Çalıştırmayı başlat'))) throw new Error('start panel');
      if (!(await type('input[aria-label="Çalıştırma başlığı (boş = iş akışı başlığı)"]', `${wfTitle} koşu`))) throw new Error('run title');
      if (!(await click('Başlat'))) throw new Error('start');
      await waitText('Çalıştırma başlatıldı', 20_000);
      await waitText('— Açık', 15_000);
      await shot('26-workflow-run');
      const cardBtn = await nth('Kart: ');
      if (!cardBtn) throw new Error('card button in run');
      await waitText('Yorumlar', 20_000);
      if (!(await click('Tamamlandı olarak işaretle'))) throw new Error('mark done');
      await waitText('İş akışı: sizi bekleyen devirler', 20_000);
      const handoff = await js<string | null>(`(() => { const el = [...document.querySelectorAll('[role=button]')].find(e => (e.getAttribute('aria-label') || '').endsWith(': devret')); if (!el) return null; el.click(); return el.getAttribute('aria-label'); })()`);
      if (!handoff) throw new Error('handoff button on task screen');
      await until(() => click('Devret ve kartı oluştur'), 'handoff submit');
      await waitText('devredildi; kart oluşturuldu', 20_000);
      await shot('27-workflow-handoff');
      // Back in the workflow: run 1 shows the new open step; run 2 is cancelled.
      await until(() => click(`Çalıştırma: ${wfTitle} koşu, Çalışıyor`), 'run row');
      await sleep(1500);
      await until(() => click(`Çalıştırma: ${wfTitle} koşu, Çalışıyor`), 'run row re-open');
      await waitText('— Tamamlandı', 15_000);
      if (!(await click('Çalıştırmayı başlat'))) throw new Error('start panel 2');
      if (!(await click('Başlat'))) throw new Error('start 2');
      // The start message of run 1 is still on screen: wait for the second running run instead.
      await waitText('2 çalışıyor', 20_000);
      await until(async () => (await js<number>(`[...document.querySelectorAll('[role=button]')].filter(e => (e.getAttribute('aria-label') || '') === 'Çalıştırmayı iptal et' || e.innerText.trim() === 'Çalıştırmayı iptal et').length`)) === 1, 'only the new run is expanded', 20_000);
      await until(() => click('Çalıştırmayı iptal et'), 'cancel run');
      if (!(await click('Evet, iptal et'))) throw new Error('confirm cancel');
      await waitText('Çalıştırma iptal edildi', 15_000);
      await waitText('1 çalışıyor', 15_000);
      if (!(await js<boolean>(`document.body.innerText.includes(${JSON.stringify(`${wfTitle} koşu`)}) && [...document.querySelectorAll('[role=button]')].some(e => e.getAttribute('aria-label') === ${JSON.stringify(`Çalıştırma: ${wfTitle} koşu, Çalışıyor`)})`))) throw new Error('run 1 must still be running');
      await shot('28-workflow-cancelled');
      if (!(await click('Sil'))) throw new Error('delete');
      if (!(await click('Evet, sil'))) throw new Error('confirm delete');
      await waitText('Yeni iş akışı', 15_000);
      await sleep(1000);
      if (await js<boolean>(`[...document.querySelectorAll('[role=button]')].some(e => e.getAttribute('aria-label') === ${JSON.stringify(`İş akışı: ${wfTitle}`)})`)) throw new Error('workflow still listed');
      // GENE-56: the web-fallback tab ("Diğer") is gone; only admins get "Yönetim" (web, password confirmation).
      if (await webTab()) throw new Error('web fallback tab visible for a non-admin');
      if (await js<boolean>(`document.body.innerText.includes('İş akışları ↗')`)) throw new Error('workflow web link still listed');
      await click('Projeler');
      return `created "${wfTitle}", lists set, run → ${cardBtn.slice(0, 60)} → done → ${handoff}; second run cancelled; deleted`;
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
    await step('time entries: add → edit → submit (locked) → withdraw → delete', async () => {
      const label = `Masaüstü kayıt ${new Date().toISOString().slice(11, 19)}`;
      if (!(await click('Kayıt ekle'))) throw new Error('add entry');
      await waitText('Yeni kayıt', 10_000);
      if (!(await type('input[aria-label="Başlangıç (SS:DD)"]', '06:00'))) throw new Error('start input');
      await type('input[aria-label="Bitiş (SS:DD)"]', '06:30');
      if (!(await type('textarea[aria-label="Açıklama"]', label)) && !(await type('input[aria-label="Açıklama"]', label))) throw new Error('description input');
      if (!(await click('Kaydı ekle'))) throw new Error('save new');
      await waitText(label, 15_000);
      await waitText('06:00–06:30', 15_000);
      if (!(await click(`Kaydı düzenle: ${label}`))) throw new Error('edit button');
      await waitText('Kaydı düzenle', 10_000);
      await type('input[aria-label="Bitiş (SS:DD)"]', '07:00');
      if (!(await click('Kaydı kaydet'))) throw new Error('save edit');
      await waitText('06:00–07:00', 15_000);
      if (!(await click('Dönemi onaya gönder'))) throw new Error('submit');
      await waitText('Dönem onaya gönderildi.', 15_000);
      await waitText('kayıtlar salt okunur', 15_000);
      if (await js<boolean>(`[...document.querySelectorAll('[role=button]')].some(e => e.getAttribute('aria-label') === ${JSON.stringify(`Kaydı sil: ${label}`)})`)) throw new Error('delete visible on a locked period');
      await shot('12-time-submitted');
      if (!(await click('Gönderimi geri çek'))) throw new Error('withdraw');
      await waitText('Gönderim geri çekildi.', 15_000);
      const end = Date.now() + 10_000;
      while (!(await click(`Kaydı sil: ${label}`))) {
        if (Date.now() > end) throw new Error('delete button after withdraw');
        await sleep(300);
      }
      await waitText('Kayıt silindi.', 15_000);
      return 'entry created, edited, locked on submit, unlocked on withdraw, deleted';
    });
    await step('time entry linked to a task: add → task picker (project → search → task) → listed under the task → delete', async () => {
      if (!firstBoardTitle) throw new Error('project title not captured');
      if (!(await click('Kayıt ekle'))) throw new Error('add entry');
      await waitText('Yeni kayıt', 10_000);
      await type('input[aria-label="Başlangıç (SS:DD)"]', '05:00');
      await type('input[aria-label="Bitiş (SS:DD)"]', '05:30');
      if (!(await click('Görev bağla'))) throw new Error('link task button');
      await waitText(firstBoardTitle, 10_000);
      if (!(await click(firstBoardTitle))) throw new Error('project chip');
      const end = Date.now() + 10_000;
      while (!(await type('input[aria-label="Görev ara"]', editedTitle))) {
        if (Date.now() > end) throw new Error('task search');
        await sleep(300);
      }
      await sleep(500);
      if (!(await click(editedTitle))) throw new Error('task chip');
      await waitText('Görevi değiştir', 5_000);
      await shot('12b-time-task-link');
      if (!(await click('Kaydı ekle'))) throw new Error('save new');
      await waitText('05:00–05:30', 15_000);
      const end2 = Date.now() + 10_000;
      while (!(await click(`Kaydı sil: ${editedTitle}`))) {
        if (Date.now() > end2) throw new Error('entry not listed under the task title');
        await sleep(300);
      }
      await waitText('Kayıt silindi.', 15_000);
      return `entry linked to "${editedTitle}" in "${firstBoardTitle}", deleted`;
    });
    await step('AI: status + quota → project summary request → polled to a terminal state with the server explanation → history; client-side rule; no admin tab', async () => {
      if (!firstBoardTitle) throw new Error('project title not captured');
      await click('İşler');
      await sleep(500);
      if (!(await click('AI asistanı'))) throw new Error('AI tab');
      await waitText('Bugün kalan', 15_000);
      if (await webTab()) throw new Error('admin/web tab visible for a non-admin');
      // Client-side rule: a question needs text (never sent).
      if (!(await click('Soru sor'))) throw new Error('question chip');
      await waitText(firstBoardTitle, 10_000);
      await click(firstBoardTitle);
      if (!(await click('Soru sor isteğini gönder'))) throw new Error('send question');
      await waitText('Soru veya talimat yazın.', 5_000);
      if (!(await click('Proje özeti'))) throw new Error('board summary chip');
      await sleep(300);
      if (!(await click(firstBoardTitle))) throw new Error('project chip');
      if (!(await click('Proje özeti isteğini gönder'))) throw new Error('send');
      await waitText('Kaynaklar', 15_000);
      const end = Date.now() + 90_000;
      let state = '';
      while (Date.now() < end) {
        state = await js<string>(`(() => { const t = document.body.innerText; return ['Tamamlandı', 'Başarısız', 'İptal edildi'].find(s => t.includes(s + ' · ')) || ''; })()`);
        if (state) break;
        await sleep(1000);
      }
      if (!state) throw new Error('request did not finish');
      const detail = await js<{ alert: string; answer: boolean; source: boolean }>(`(() => ({ alert: [...document.querySelectorAll('[role=alert]')].map(e => e.innerText).join(' | '), answer: !!document.querySelector('[aria-label="AI yanıtı"]'), source: document.body.innerText.includes(${JSON.stringify(`Proje: ${firstBoardTitle}`)}) }))()`);
      if (!detail.source) throw new Error('source project not listed');
      if (state === 'Başarısız' && !detail.alert) throw new Error('failure without explanation');
      if (state === 'Tamamlandı' && !detail.answer) throw new Error('answer missing');
      await shot('24-ai-request');
      if (!(await click('AI listesine dön'))) throw new Error('back');
      await waitText('Geçmiş', 10_000);
      if (!(await click('Geçmiş'))) throw new Error('history tab');
      await waitText(`${state} · `, 10_000);
      await shot('25-ai-history');
      // Back to Time for the CSV step that follows.
      if (!(await click('Zaman'))) throw new Error('time tab');
      await waitText('Zamanlayıcı', 15_000);
      return `request ${state}${detail.alert ? ` — "${detail.alert.slice(0, 80)}"` : ''}; listed in history`;
    });
    await step('own CSV export → save (smoke: written to the output dir)', async () => {
      if (!(await click('CSV indir'))) throw new Error('own csv');
      await waitText('Kaydedildi: workhub-time-own-', 20_000);
    });
    const subject = process.env.WORKHUB_SMOKE_SUBJECT ?? '';
    if (subject) {
      await step('review queue: approve → reopen (reason required); team report table; team CSV', async () => {
        if (!(await click('İnceleme'))) throw new Error('review tab (reviewer gate)');
        await waitText(subject, 15_000);
        await shot('13-time-review');
        if (!(await click(`Onayla: ${subject}`))) throw new Error('approve button');
        await waitText('İncelemenizi bekleyen dönem yok.', 15_000);
        // approve is allowed without reason; then reopen requires one
        if (!(await click('Onaylananlar'))) throw new Error('approved tab');
        await waitText(subject, 15_000);
        const until = async (fn: () => Promise<boolean>, what: string) => {
          const end = Date.now() + 15_000;
          while (!(await fn())) {
            if (Date.now() > end) throw new Error(what);
            await sleep(300);
          }
        };
        await until(() => click(`Yeniden aç: ${subject}`), 'reopen button');
        await waitText('Gerekçe yazın.', 5_000);
        if (!(await type(`textarea[aria-label="Gerekçe: ${subject}"]`, 'Smoke: lütfen düzelt'))) throw new Error('reason input');
        if (!(await click(`Yeniden aç: ${subject}`))) throw new Error('reopen button 2');
        await waitText('Onaylanmış dönem yok.', 15_000);
        if (!(await click('Takım raporu'))) throw new Error('team tab');
        await waitText('Faturalı', 15_000);
        await waitText(subject, 15_000);
        const table = await js<{ headers: number; rows: number }>(`(() => { const t = document.querySelector('[role=table]'); return { headers: t ? t.querySelectorAll('[role=columnheader]').length : 0, rows: t ? t.querySelectorAll('[role=row]').length : 0 }; })()`);
        if (table.headers !== 5 || table.rows < 3) throw new Error(`table semantics ${JSON.stringify(table)}`);
        await shot('14-time-team');
        if (!(await click('Takım CSV indir'))) throw new Error('team csv');
        await waitText('Kaydedildi: workhub-time-team-', 20_000);
        return `approve → reopen (reason enforced); table ${table.headers} columns × ${table.rows} rows`;
      });
    }
    const stamp = new Date().toISOString().slice(11, 19);
    const projectTitle = `Masaüstü projesi ${stamp}`;
    await step('project management: create → rename → add/rename column → add member', async () => {
      await click('İşler');
      await sleep(500);
      if (!(await click('Projeler'))) throw new Error('projects tab');
      if (!(await type('input[aria-label="Yeni proje"]', projectTitle))) throw new Error('new project input');
      if (!(await click('Oluştur'))) throw new Error('create project');
      await waitText('To Do', 20_000);
      if (!(await click('Proje ayarları'))) throw new Error('manage button');
      await waitText('Sütunlar', 10_000);
      if (!(await type('input[aria-label="Proje adı"]', `${projectTitle} (yeni ad)`))) throw new Error('project name input');
      if (!(await click('Projeyi yeniden adlandır'))) throw new Error('rename project');
      await waitText(`${projectTitle} (yeni ad)`, 15_000);
      if (!(await type('input[aria-label="Yeni sütun"]', 'İnceleme'))) throw new Error('new column input');
      if (!(await click('Sütun ekle'))) throw new Error('add column');
      await waitLabel('İnceleme, 0 görev');
      if (!(await type('input[aria-label="Sütun adı: İnceleme"]', 'QA'))) throw new Error('column name input');
      if (!(await click('Yeniden adlandır: İnceleme'))) throw new Error('rename column');
      await waitLabel('QA, 0 görev');
      const member = process.env.WORKHUB_SMOKE_MEMBER ?? '';
      if (member) {
        if (!(await type('input[aria-label="Üye ekle: kişi veya grup ara"]', member))) throw new Error('member search');
        const end = Date.now() + 10_000;
        while (!(await click(`Seç: ${member}`))) {
          if (Date.now() > end) throw new Error('member result');
          await sleep(300);
        }
        await waitText('projeye eklendi.', 15_000);
      }
      await shot('10-project-admin');
      return member ? `member ${member} added` : 'member step skipped (no WORKHUB_SMOKE_MEMBER)';
    });
    const goal = process.env.WORKHUB_SMOKE_GOAL ?? '';
    if (goal) {
      await step('goal shares: share with a group → save → server list reloaded', async () => {
        await click('İşler');
        await sleep(500);
        if (!(await click('Hedefler'))) throw new Error('goals tab');
        await waitText(goal, 15_000);
        if (!(await click(`Hedef: ${goal}`))) throw new Error('open goal');
        await waitText('Hedef değerler', 15_000);
        if (!(await click(`Paylaş: ${goal}`))) throw new Error('share button');
        await waitText('Henüz kimseyle paylaşılmadı.', 15_000);
        const group = process.env.WORKHUB_SMOKE_GROUP ?? 'staff';
        if (!(await type('input[aria-label="Paylaş: kişi veya grup ara"]', group))) throw new Error('share search');
        const end = Date.now() + 10_000;
        while (!(await click(`Seç: ${group}`))) {
          if (Date.now() > end) throw new Error('group result');
          await sleep(300);
        }
        if (!(await click('Kaydet'))) throw new Error('save shares');
        await waitText('Paylaşımlar kaydedildi.', 15_000);
        await shot('11-goal-shares');
        return `shared with group ${group}`;
      });
      const has = (label: string) => js<boolean>(`!!document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`);
      const until = async (fn: () => Promise<boolean>, what: string, ms = 15_000) => {
        const end = Date.now() + ms;
        while (!(await fn())) {
          if (Date.now() > end) throw new Error(what);
          await sleep(300);
        }
      };
      await step('goals: add currency target → bad decimal refused → delta check-in → history → archive/reactivate', async () => {
        if (!(await click('Para'))) throw new Error('currency chip');
        if (!(await type('input[aria-label="Hedef değer başlığı"]', 'Ciro'))) throw new Error('target title');
        if (!(await type('input[aria-label="Hedef"]', '1000,5'))) throw new Error('target value');
        if (!(await click('Ekle'))) throw new Error('add target');
        await waitText('Hedef değer eklendi.', 15_000);
        await waitText('Şu an 0,00 TRY · hedef 1000,50 TRY', 15_000);
        await until(() => click('Check-in: Ciro'), 'check-in button');
        if (!(await click('Artış (+/−)'))) throw new Error('delta chip');
        await type('input[aria-label="Değer: Ciro"]', '1,234');
        if (!(await click('Check-in kaydet: Ciro'))) throw new Error('save check-in');
        await waitText('en fazla 2 ondalık', 5_000);
        await type('input[aria-label="Değer: Ciro"]', '250,25');
        await type('input[aria-label="Not: Ciro"]', 'Masaüstü check-in');
        if (!(await click('Check-in kaydet: Ciro'))) throw new Error('save check-in 2');
        await waitText('Check-in kaydedildi.', 15_000);
        await waitText('Şu an 250,25 TRY', 15_000);
        await until(() => click('Geçmiş: Ciro'), 'history button');
        await waitText('0,00 TRY → 250,25 TRY (artış) · “Masaüstü check-in”', 15_000);
        await shot('19-goal-checkin');
        if (!(await click(`Arşivle: ${goal}`))) throw new Error('archive');
        await waitText('Hedef arşivlendi.', 15_000);
        await waitText('Arşivdeki hedefte hedef değer', 15_000);
        if (await has('Check-in: Ciro')) throw new Error('check-in offered on an archived goal');
        if (!(await click(`Yeniden etkinleştir: ${goal}`))) throw new Error('reactivate');
        await waitText('Hedef yeniden etkin.', 15_000);
        await until(() => has('Check-in: Ciro'), 'check-in back after reactivate');
        return 'target 1000,50 TRY; 1,234 refused locally; +250,25 → %25; archived (no writes) → reactivated';
      });
      await step('goals ↔ task: open task → link to goal → listed with progress → unlink', async () => {
        await click('İşler');
        await sleep(500);
        if (!(await click('Projeler'))) throw new Error('projects tab');
        // The project list is virtualised and grows with every smoke run: scroll it into view first.
        await reveal(`${projectTitle} (yeni ad)`);
        await until(() => click(`${projectTitle} (yeni ad)`, false), 'project row');
        await waitText('To Do', 20_000);
        const linkTask = `Hedef görevi ${stamp}`;
        await addTask(linkTask);
        await waitText(linkTask, 15_000);
        if (!(await click(linkTask, false))) throw new Error('task row');
        await waitText('Bu görev bir hedefe bağlı değil.', 20_000);
        if (!(await click('Hedefe bağla'))) throw new Error('link button');
        await until(() => click(`Bağla: ${goal}`), 'goal in picker');
        await waitText(`Görev “${goal}” hedefine bağlandı.`, 15_000);
        await until(() => has(`Hedeften çıkar: ${goal}`), 'linked goal listed');
        await shot('20-task-goal-linked');
        if (!(await click(`Hedeften çıkar: ${goal}`))) throw new Error('unlink');
        await waitText('Görev hedeften çıkarıldı.', 15_000);
        await waitText('Bu görev bir hedefe bağlı değil.', 15_000);
        return `task "${linkTask}" linked → unlinked`;
      });
      await step('goals: transfer ownership to another user (picker: users only) → previous owner keeps manage', async () => {
        await click('İşler');
        await sleep(500);
        if (!(await click('Hedefler'))) throw new Error('goals tab');
        await until(() => click(`Hedef: ${goal}`), 'open goal');
        await waitText('Hedef değerler', 15_000);
        if (!(await click(`Sahipliği devret: ${goal}`))) throw new Error('transfer button');
        const member = process.env.WORKHUB_SMOKE_MEMBER ?? 'Bob';
        if (!(await type('input[aria-label="Kişi ara"]', member))) throw new Error('person search');
        await until(() => click(`Seç: ${member}`), 'person result');
        if (!(await click(`Devret: ${member}`))) throw new Error('confirm transfer');
        await waitText('Sahiplik devredildi; yönetme yetkiniz sürüyor.', 15_000);
        await waitText(`Sahip: ${member} · Rolünüz: yönetir`, 15_000);
        await shot('21-goal-transferred');
        return `owner → ${member}; caller role manage`;
      });
    }
    const reqApprove = process.env.WORKHUB_SMOKE_REQ_APPROVE ?? '';
    const reqReject = process.env.WORKHUB_SMOKE_REQ_REJECT ?? '';
    const until = async (fn: () => Promise<boolean>, what: string, ms = 15_000) => {
      const end = Date.now() + ms;
      while (!(await fn())) {
        if (Date.now() > end) throw new Error(what);
        await sleep(300);
      }
    };
    const has = (label: string) => js<boolean>(`!!document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`);
    if (reqApprove && reqReject) {
      await step('requests: recipient approves one, reject needs a reason, no manager actions', async () => {
        await click('İşler');
        await sleep(500);
        if (!(await click('Talepler'))) throw new Error('requests tab');
        await until(() => click('Bana gelenler'), 'received tab');
        await waitText(reqApprove, 15_000);
        await until(() => click(`Ayrıntı: ${reqApprove}`), 'open approve request');
        await until(() => click(`Onayla: ${reqApprove}`), 'approve button');
        await waitText('Talep onaylandı; yöneticiye iletildi.', 15_000);
        await waitText('Alıcı onayladı', 15_000);
        // A is the recipient, not the requester's manager here → no resolve / convert.
        if ((await has(`Çöz: ${reqApprove}`)) || (await has(`Göreve dönüştür: ${reqApprove}`))) throw new Error('manager actions visible to recipient');
        await shot('15-request-approved');
        if (!(await click('Kapat'))) throw new Error('close');
        await until(() => click(`Ayrıntı: ${reqReject}`), 'open reject request');
        await until(() => click(`Reddet: ${reqReject}`), 'reject button');
        await waitText('Reddetmek için gerekçe yazın.', 5_000);
        if (!(await type(`textarea[aria-label="Gerekçe: ${reqReject}"]`, 'Smoke: bütçe yok'))) throw new Error('reason input');
        if (!(await click(`Reddet: ${reqReject}`))) throw new Error('reject button 2');
        await waitText('Talep reddedildi.', 15_000);
        await waitText('Ret gerekçesi: Smoke: bütçe yok', 15_000);
        await shot('16-request-rejected');
        if (!(await click('Kapat'))) throw new Error('close 2');
        return 'approve ✓, reject reason enforced ✓, resolve/convert hidden for recipient ✓';
      });
    }
    const reqConvert = process.env.WORKHUB_SMOKE_REQ_CONVERT ?? '';
    const reqResolve = process.env.WORKHUB_SMOKE_REQ_RESOLVE ?? '';
    if (reqConvert && reqResolve) {
      await step('requests (manager): convert → project/column picker → task; resolve needs a reason; report table', async () => {
        await click('İşler');
        await sleep(500);
        if (!(await click('Talepler'))) throw new Error('requests tab');
        await until(() => click('Ekibim'), 'team tab (manager only)');
        await waitText(reqConvert, 15_000);
        await until(() => click(`Ayrıntı: ${reqConvert}`), 'open convert request');
        await waitText('Göreve dönüştür', 15_000);
        // Destination: the project created above (A can edit it), first open column preselected.
        await type(`input[aria-label="Proje ara: ${reqConvert}"]`, projectTitle);
        await until(() => click(`${projectTitle} (yeni ad)`), 'project chip');
        await waitText('Sütun', 15_000);
        const checked = () => js<string[]>(`[...document.querySelectorAll('[role=checkbox]')].filter(e => e.getAttribute('aria-checked') === 'true').map(e => e.innerText.trim())`);
        try {
          await until(async () => (await checked()).includes('To Do'), 'default column', 10_000);
        } catch {
          throw new Error(`default column; checked=${JSON.stringify(await checked())}`);
        }
        if (!(await click(`Göreve dönüştür: ${reqConvert}`))) throw new Error('convert button');
        await waitText('Görev oluşturuldu.', 20_000);
        await waitText(`Görev: ${reqConvert} · ${projectTitle} (yeni ad) / To Do`, 15_000);
        await waitText('Göreve dönüştürüldü', 15_000);
        await shot('17-request-converted');
        if (!(await click('Kapat'))) throw new Error('close');
        await until(() => click(`Ayrıntı: ${reqResolve}`), 'open resolve request');
        await until(() => click(`Çöz: ${reqResolve}`), 'resolve button');
        await waitText('Çözüm gerekçesi yazın.', 5_000);
        if (!(await type(`textarea[aria-label="Çözüm gerekçesi: ${reqResolve}"]`, 'Smoke: görev gerekmiyor'))) throw new Error('resolve reason');
        if (!(await click(`Çöz: ${reqResolve}`))) throw new Error('resolve button 2');
        await waitText('Talep görevsiz çözüldü.', 15_000);
        await waitText('Görevsiz çözüldü', 15_000);
        if (!(await click('Kapat'))) throw new Error('close 2');
        if (!(await click('Rapor'))) throw new Error('report tab');
        await waitText('Talep eden', 15_000);
        await until(() => click('Ekip'), 'report team scope');
        await waitText(reqConvert, 15_000);
        const table = await js<{ headers: number; rows: number }>(`(() => { const t = document.querySelector('[role=table]'); return { headers: t ? t.querySelectorAll('[role=columnheader]').length : 0, rows: t ? t.querySelectorAll('[role=row]').length : 0 }; })()`);
        if (table.headers !== 5 || table.rows < 3) throw new Error(`report table ${JSON.stringify(table)}`);
        await shot('18-request-report');
        return `converted into "${projectTitle} (yeni ad)" / To Do; resolved; report ${table.headers} columns × ${table.rows} rows`;
      });
    }
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
