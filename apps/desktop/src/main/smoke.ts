import type { BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { setLocale } from '@workhub-devices/features/src/i18n/core';
import { messages, t as cm } from '@workhub-devices/features/src/i18n/messages';

/**
 * Automated UI smoke (only when WORKHUB_SMOKE_OUT is set): drives the real renderer through
 * DOM events — login (approved externally), chats, send a message, tasks, board, inbox —
 * and writes screenshots + result.json. Never compiled into behaviour without the env flag.
 *
 * The smoke finds controls by their visible ENGLISH text, so the run must use the English UI
 * (`scripts/smoke.mjs` sets `WORKHUB_LOCALE=en`). The texts are not copied here: they are read from
 * the same catalogs the UI renders (`packages/features/src/i18n/catalogs`), so renaming a string
 * cannot silently break the smoke, and a removed key fails the type check. Only data the smoke
 * itself creates (titles, messages) and texts that come from the server are literals.
 */
const { talk: tk, tasks: ts, dashboards: db, workflows: wf, time: tm, ai, goals: gl, requests: rq, modules: md } = messages;

const SENTINEL = '\u0001';
type Template = (...args: never[]) => string;
const render = (fn: Template) => (fn as unknown as (...a: string[]) => string)(SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL);
/** Fixed text before the first parameter of a catalog template: `lead(tk.replyingTo)` → "Replying to ". */
const lead = (fn: Template) => render(fn).split(SENTINEL)[0]!;
/** Fixed text after the last parameter of a catalog template: `tail(ts.openCount)` → " open". */
const tail = (fn: Template) => render(fn).split(SENTINEL).pop()!;
/** Escapes text for use inside a `RegExp` source. */
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function runSmoke(win: BrowserWindow, out: string) {
  setLocale('en'); // texts above resolve against the main process' own locale state
  /** The marker next to the time of an edited chat message ("· edited"), without the separator. */
  const EDITED = tk.messageTime('', true).replace(/^[\s·]+/, '');
  /** Editor warning for a step without a target list: `Step "<label>" has no target list.` (text after the label). */
  const NO_LIST = tail(wf.issueNoList).replace(/^"\s*/, '').replace(/\.$/, '');
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
  // Non-admins have no web-fallback / administration tab (admins only get the server settings pointer).
  const webTab = () => js<boolean>(`[...document.querySelectorAll('[role=tab]')].some(e => e.innerText.trim() === ${JSON.stringify(md.sectionAdmin)})`);
  const webLinks = () => js<boolean>(`document.body.innerText.includes('↗')`);
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
  // Project rows and sidebar items are labelled "<title>: N open, M done" / "<title>, N open tasks".
  const OPEN_WORD = tail(ts.openCount); // " open"
  const firstProjectOpenCount = () =>
    js<number | null>(`(() => {
      const el = [...document.querySelectorAll('[role=button]')].find(e => (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(firstBoardTitle)}) && (e.getAttribute('aria-label') || '').includes(${JSON.stringify(OPEN_WORD)}));
      const m = el && el.getAttribute('aria-label').match(new RegExp('(\\\\d+)' + ${JSON.stringify(esc(OPEN_WORD))})); return m ? Number(m[1]) : null; })()`);
  /** Opens the first project: a project-list row or the sidebar item (both labelled "<title>…N open…"). */
  const openProject = () =>
    js<boolean>(`(() => { const el = [...document.querySelectorAll('[role=button]')].find(e => (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(firstBoardTitle)}) && (e.getAttribute('aria-label') || '').includes(${JSON.stringify(OPEN_WORD)})); if (!el) return false; el.click(); return true; })()`);
  /** True when a button/tab/checkbox shows exactly `text` (visible text or accessible name). */
  const hasButton = (text: string) =>
    js<boolean>(`[...document.querySelectorAll('[role=button],[role=tab],[role=checkbox],button')].some(e => e.innerText.trim() === ${JSON.stringify(text)} || e.getAttribute('aria-label') === ${JSON.stringify(text)})`);
  /** Waits for a button by its exact text; unlike `waitText` this cannot be satisfied by a word inside other text. */
  const waitButton = async (text: string, timeoutMs = 15_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await hasButton(text)) return true;
      await sleep(300);
    }
    throw new Error(`button not found: ${text}`);
  };
  const waitLabel = async (label: string, timeoutMs = 15_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await js<boolean>(`!!document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`)) return true;
      await sleep(300);
    }
    throw new Error(`label not found: ${label}`);
  };
  /** Kanban quick add: header "Add task" opens the first column's input ("New task in <list>"). */
  const addTask = async (title: string) => {
    if (!(await click(ts.addTask))) throw new Error('add task button');
    await sleep(300);
    if (!(await type(`input[aria-label^=${JSON.stringify(lead(ts.newTaskInList))}]`, title))) throw new Error('new task input');
    if (!(await click(ts.add))) throw new Error('add task');
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
      await waitText(cm.connect);
      await shot('01-login');
    });
    await step('login flow v2 (approved by smoke script)', async () => {
      await type('input', process.env.WORKHUB_SMOKE_SERVER ?? '');
      if (!(await click(cm.connect))) throw new Error('connect button');
      await waitText(cm.chats, 120_000);
    });
    await step('chats list', async () => {
      await waitText(process.env.WORKHUB_SMOKE_ROOM ?? '', 30_000);
      await shot('02-chats');
    });
    const msg = `Hello from the desktop ${new Date().toISOString().slice(11, 19)}`;
    await step('open room + send message via composer', async () => {
      if (!(await click(process.env.WORKHUB_SMOKE_ROOM ?? '', false))) throw new Error('room row');
      const end = Date.now() + 15_000;
      while (!(await js<boolean>(`!!document.querySelector('textarea')`))) {
        if (Date.now() > end) throw new Error('composer not found');
        await sleep(300);
      }
      await sleep(1500);
      await type('textarea', msg);
      if (!(await click(cm.send))) throw new Error('send');
      await waitText(msg, 15_000);
      await sleep(1500);
      const pending = await js<boolean>(`document.body.innerText.includes(${JSON.stringify(cm.sending)})`);
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
      const roomName = `Desktop Talk ${stamp}`;
      let token = '';
      await step('talk: new group conversation → description → add participant (autocomplete) → promote', async () => {
        await click(cm.chats);
        if (!(await click(tk.newChat))) throw new Error('new room button');
        if (!(await type(`input[aria-label=${JSON.stringify(tk.chatName)}]`, roomName))) throw new Error('room name input');
        if (!(await click(tk.createChat))) throw new Error('create');
        await waitText(roomName, 15_000);
        // The info button appears once the fresh room read has returned.
        const endI = Date.now() + 10_000;
        while (!(await click(tk.chatInfo))) {
          if (Date.now() > endI) throw new Error('info button');
          await sleep(300);
        }
        await waitText(lead(tk.participantsTitle), 10_000);
        if (!(await type(`textarea[aria-label=${JSON.stringify(tk.description)}]`, 'Desktop smoke description'))) throw new Error('description');
        if (!(await click(tk.saveInfo))) throw new Error('save info');
        await waitText(tk.infoSaved, 10_000);
        if (!(await type(`input[aria-label=${JSON.stringify(tk.addParticipant)}]`, bUser.slice(0, 3)))) throw new Error('invite search');
        const member = process.env.WORKHUB_SMOKE_MEMBER ?? 'Bob';
        const end = Date.now() + 10_000;
        while (!(await click(tk.addPerson(member)))) {
          if (Date.now() > end) throw new Error('invite candidate');
          await sleep(300);
        }
        await waitText(tk.personAdded(member), 10_000);
        if (!(await click(tk.moderatorToggleLabel(member, false)))) throw new Error('promote');
        const promotedBy = Date.now() + 10_000;
        while (!(await js<boolean>(`!!document.querySelector('[aria-label=${JSON.stringify(tk.moderatorToggleLabel(member, true))}]')`))) {
          if (Date.now() > promotedBy) throw new Error('promote not applied');
          await sleep(300);
        }
        await shot('03b-talk-room-settings');
        if (!(await click(tk.moderatorToggleLabel(member, true)))) throw new Error('demote');
        const end2 = Date.now() + 10_000;
        while (!(await js<boolean>(`!!document.querySelector('[aria-label=${JSON.stringify(tk.moderatorToggleLabel(member, false))}]')`))) {
          if (Date.now() > end2) throw new Error('demote not applied');
          await sleep(300);
        }
        if (!(await click(cm.close))) throw new Error('close info');
        await waitText('Desktop smoke description', 10_000);
        const rooms = await asB<Array<{ token: string; displayName: string }>>('GET', '/ocs/v2.php/apps/spreed/api/v4/room');
        token = rooms.find((r) => r.displayName === roomName)?.token ?? '';
        if (!token) throw new Error('B does not see the room');
        return `room ${token}; B sees it`;
      });
      const first = `Talk first ${stamp}`;
      let firstId = 0;
      await step('talk: mention autocomplete → send; B reacts + edits own message → visible live in the UI', async () => {
        if (!(await type('textarea', `@${bUser.slice(0, 2)}`))) throw new Error('composer');
        const end = Date.now() + 10_000;
        while (!(await click(tk.mentionUser(process.env.WORKHUB_SMOKE_MEMBER ?? 'Bob')))) {
          if (Date.now() > end) throw new Error('mention suggestion');
          await sleep(300);
        }
        const v = await textareaValue();
        if (!v.startsWith(`@${bUser}`) && !v.startsWith(`@"${bUser}"`)) throw new Error(`mention not inserted: ${v.length} chars`);
        await type('textarea', `${v}${first}`);
        if (!(await click(cm.send))) throw new Error('send');
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
        const bMsg = await asB<{ id: number }>('POST', `/ocs/v2.php/apps/spreed/api/v1/chat/${token}`, { message: `B message ${stamp}` });
        await asB('PUT', `/ocs/v2.php/apps/spreed/api/v1/chat/${token}/${bMsg.id}`, { message: `B fixed ${stamp}` });
        await waitText('👍 1', 45_000);
        await waitText(`B fixed ${stamp}`, 45_000);
        await waitText(EDITED, 5_000);
        await shot('03c-talk-live-updates');
        return `mention parsed for ${bUser}; reaction + edit from B arrived through the long-poll`;
      });
      const edited = `Talk edited ${stamp}`;
      await step('talk: reply (quote) → edit own → add reaction → who reacted → search → delete; B sees each change', async () => {
        if (!(await clickLast(first))) throw new Error('select message');
        if (!(await click(tk.reply))) throw new Error('reply button');
        await waitText(lead(tk.replyingTo), 5_000);
        await type('textarea', `Reply ${stamp}`);
        if (!(await click(cm.send))) throw new Error('send reply');
        await waitText(`Reply ${stamp}`, 15_000);
        if (!(await clickLast(first))) throw new Error('select again');
        if (!(await click(tk.editMessage))) throw new Error('edit button');
        await waitText(tk.editingMessage, 5_000);
        const cur = await textareaValue();
        if (!cur.includes(first)) throw new Error('edit box not prefilled');
        await type('textarea', cur.replace(first, edited));
        if (!(await click(tk.saveEdit))) throw new Error('save edit');
        await waitText(edited, 15_000);
        if (!(await clickLast(edited))) throw new Error('select edited');
        if (!(await click(tk.addReaction))) throw new Error('reaction picker');
        if (!(await click(tk.quickReaction('🎉', false)))) throw new Error('pick 🎉');
        await waitText('🎉 1', 10_000);
        if (!(await clickLast(edited))) throw new Error('select for reactors');
        if (!(await click(tk.whoReacted))) throw new Error('reactors');
        await waitText(`👍 ${process.env.WORKHUB_SMOKE_MEMBER ?? 'Bob'}`, 10_000);
        await shot('03d-talk-actions');
        // B's view after edit + reaction: the quote in the reply carries the edited text
        const seen = await asB<Array<{ id: number; message: string; reactions?: Record<string, number>; lastEditTimestamp?: number; parent?: { id: number; message?: string } }>>('GET', `/ocs/v2.php/apps/spreed/api/v1/chat/${token}?lookIntoFuture=0&limit=30`);
        const orig = seen.find((x) => x.id === firstId);
        if (!orig?.message.includes(edited) || !orig.lastEditTimestamp) throw new Error('B does not see the edit');
        if (orig.reactions?.['🎉'] !== 1 || orig.reactions?.['👍'] !== 1) throw new Error('B does not see both reactions');
        const reply = seen.find((x) => x.message === `Reply ${stamp}`);
        if (reply?.parent?.id !== firstId) throw new Error('reply has no quote for B');
        // search (unified search, this conversation)
        if (!(await click(tk.searchThisChat))) throw new Error('search button');
        if (!(await type(`input[aria-label=${JSON.stringify(tk.searchThisChat)}]`, 'edited'))) throw new Error('search input');
        if (!(await click(tk.startSearch))) throw new Error('search run');
        const endS = Date.now() + 15_000;
        while (!(await js<boolean>(`[...document.querySelectorAll('[role=button]')].some(e => e.innerText.includes(${JSON.stringify(stamp)}) && e.innerText.includes('edited') && !e.innerText.includes('Reply'))`))) {
          if (Date.now() > endS) throw new Error('search found nothing');
          await sleep(300);
        }
        await shot('03e-talk-search');
        if (!(await click(cm.close))) throw new Error('close search');
        // delete
        if (!(await clickLast(edited))) throw new Error('select for delete');
        if (!(await click(tk.deleteMessage))) throw new Error('delete button');
        if (!(await click(tk.yesDelete))) throw new Error('confirm delete');
        await waitText(tk.messageWasDeleted, 10_000);
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
        const caption = `Attachment caption ${stamp}`;
        await type('textarea', caption);
        if (!(await click(tk.attachFile))) throw new Error('attach button');
        await waitText('Desktop attachment', 10_000);
        const end = Date.now() + 30_000;
        let file: Msg | undefined;
        while (!(file = (await bFeed()).find((m) => fileName(m)?.startsWith('Desktop attachment')))) {
          if (Date.now() > end) throw new Error('B does not see the file');
          await sleep(500);
        }
        if (file.message !== caption) throw new Error('caption missing for B');
        await waitText(caption, 10_000);
        const trayGone = Date.now() + 10_000;
        while (await js<boolean>(`!!document.querySelector(${JSON.stringify(`[aria-label="${tk.uploadsLabel}"]`)})`)) {
          if (Date.now() > trayGone) throw new Error('upload tray still visible');
          await sleep(300);
        }
        if (await textareaValue()) throw new Error('composer not cleared');
        await shot('03f-talk-file');
        return `B: ${fileName(file)} + caption`;
      });
      await step('talk files: B shares a PDF → Download (main writes it; bytes identical) → Open (safe type)', async () => {
        const name = `B report ${stamp}.pdf`;
        const bytes = new TextEncoder().encode(`%PDF-1.4\n% GENE-58 ${stamp}\n`.repeat(100));
        await davB('MKCOL', 'Talk');
        const put = await davB('PUT', `Talk/${name}`, bytes);
        if (!put.ok) throw new Error(`B upload ${put.status}`);
        await asB('POST', '/ocs/v2.php/apps/files_sharing/api/v1/shares', { shareType: 10, shareWith: token, path: `/Talk/${name}`, talkMetaData: JSON.stringify({ messageType: 'comment' }) });
        await waitText(name, 20_000);
        if (!(await click(tk.downloadLabel(name)))) throw new Error('download button');
        await waitText(tk.saved, 20_000);
        const saved = await fs.readFile(join(out, `saved-${name.replace(/:/g, '_')}`));
        if (Buffer.compare(saved, Buffer.from(bytes)) !== 0) throw new Error('saved bytes differ');
        if (!(await click(tk.openLabel(name)))) throw new Error('open button');
        await waitText(tk.opened, 20_000);
        await fs.stat(join(out, `opened-${name.replace(/:/g, '_')}`));
        await shot('03g-talk-download');
        await davB('DELETE', `Talk/${name}`);
        return `${saved.byteLength} bytes, sha match`;
      });
      await step('talk files: voice note (fake mic) → record → send → B gets voice-message (WAV) → play', async () => {
        if (!(await click(tk.recordVoiceNote))) throw new Error('record button');
        await waitText(lead(tk.recordingText).trim(), 10_000);
        await sleep(3000);
        if (!(await click(tk.sendVoiceNote))) throw new Error('send voice');
        const end = Date.now() + 30_000;
        let voice: Msg | undefined;
        while (!(voice = (await bFeed()).find((m) => m.messageType === 'voice-message'))) {
          if (Date.now() > end) throw new Error('B has no voice-message');
          await sleep(500);
        }
        await waitText(`🎤 ${tk.voiceNote}`, 10_000);
        await shot('03h-talk-voice');
        const playClicked = await js<boolean>(`(() => { const els = [...document.querySelectorAll('[role=button]')].filter(e => (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(lead(tk.listenLabel))})); const el = els[els.length - 1]; if (!el) return false; el.click(); return true; })()`);
        if (!playClicked) throw new Error('play button');
        const endP = Date.now() + 10_000;
        let played = false;
        while (Date.now() < endP && !played) {
          played = await js<boolean>(`document.body.innerText.includes(${JSON.stringify(tk.stopPlayback)})`);
          if (!played) await sleep(150);
        }
        // Heuristic for "an error alert is showing" (playback failed, server unreachable, …).
        const err = await js<boolean>(`[...document.querySelectorAll('[role=alert]')].some(e => /error|failed|cannot|could not/i.test(e.innerText))`);
        if (err) throw new Error('playback error shown');
        return `B: ${fileName(voice)} (${voice.messageType}); playback ${played ? 'started' : 'not observed (clip ended)'}`;
      });
      await step('talk: delete the conversation for everyone → gone from the list and for B', async () => {
        if (!(await click(tk.chatInfo))) throw new Error('info');
        if (!(await click(tk.deleteChatForAll))) throw new Error('delete room');
        if (!(await click(tk.yesDeletePermanently))) throw new Error('confirm delete room');
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
      await click(cm.tasks);
      await waitText(OPEN_WORD.trim(), 20_000);
      await shot('04-projects');
      const projectRowRe = JSON.stringify(`: \\d+${esc(OPEN_WORD)}, `);
      firstBoardTitle = await js<string>(`(() => { const re = new RegExp(${projectRowRe}); const el = [...document.querySelectorAll('[role=button]')].find(e => re.test(e.getAttribute('aria-label') || '')); return el ? el.getAttribute('aria-label').replace(new RegExp(${JSON.stringify(`: \\d+${esc(OPEN_WORD)}, .*$`)}), '') : ''; })()`);
      openBefore = await firstProjectOpenCount();
      if (!(await openProject())) throw new Error('project row');
      await waitText('To Do', 20_000);
      await shot('05-board');
    });
    const editedTitle = `Edited ${new Date().toISOString().slice(11, 19)}`;
    const subtask = `Subtask ${new Date().toISOString().slice(11, 19)}`;
    const taskTitle = `Desktop task ${new Date().toISOString().slice(11, 19)}`;
    await step('task: create → open detail → comment', async () => {
      await addTask(taskTitle);
      await reveal(taskTitle);
      await shot('05b-kanban-added');
      if (!(await click(taskTitle, false))) throw new Error('task row');
      await waitText(cm.comments, 15_000);
      await type('textarea', 'Comment from the desktop');
      if (!(await click(cm.addComment))) throw new Error('comment');
      await waitText('Comment from the desktop', 15_000);
      await shot('06-task');
    });
    await step('task: edit fields + subtask, project counter refreshes', async () => {
      if (!(await click(cm.edit))) throw new Error('edit button');
      await waitText(cm.editTask, 10_000);
      if (!(await type(`input[aria-label=${JSON.stringify(ts.fieldTitle)}]`, editedTitle))) throw new Error('title input');
      if (!(await type(`input[aria-label=${JSON.stringify(ts.fieldDue)}]`, '2026-12-31'))) throw new Error('due input');
      if (!(await type(`input[aria-label=${JSON.stringify(ts.fieldEstimate)}]`, '1.5'))) throw new Error('estimate input');
      if (!(await click(ts.priorityHigh))) throw new Error('priority chip');
      if (!(await click(cm.save))) throw new Error('save');
      await waitText(editedTitle, 15_000);
      await waitText(ts.hoursAbbr(1.5), 15_000);
      if (!(await type(`input[aria-label=${JSON.stringify(ts.newSubtask)}]`, subtask))) throw new Error('subtask input');
      if (!(await click(ts.addSubtask))) throw new Error('add subtask');
      await waitText(subtask, 15_000);
      if (!(await click(subtask))) throw new Error('subtask checkbox');
      await waitText('(1/1)', 15_000); // subtask counter in the section heading
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
      if (!(await click(ts.viewGantt))) throw new Error('gantt tab');
      await waitText(ts.ganttTitle, 20_000);
      await reveal(editedTitle);
      const row = await js<string | null>(`(() => { const el = [...document.querySelectorAll('[role=button]')].find(e => (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(editedTitle)})); return el ? el.getAttribute('aria-label') : null; })()`);
      if (!row || !row.includes(lead(ts.ganttMilestone))) throw new Error(`gantt row label: ${row}`);
      await shot('19-gantt');
      if (!(await click(ts.viewActivity))) throw new Error('activity tab');
      await waitText(lead(ts.actTitle).replace(/: “$/, ''), 20_000); // "changed the title"
      if (!(await click(ts.activityFilterLabel(ts.typeSubtasks)))) throw new Error('subtasks filter');
      await waitText(lead(ts.actSubtaskCheck).replace(/: $/, ''), 15_000); // "completed subtask"
      await shot('20-activity');
      if (!(await click(ts.activityFilterLabel(ts.typeAll)))) throw new Error('all filter');
      await waitText(lead(ts.actTitle).replace(/: “$/, ''), 15_000);
      const paged = (await click(ts.activityOlder)) ? 'older page loaded' : 'single page';
      await sleep(1500);
      if (!(await click(ts.viewList))) throw new Error('board tab');
      await waitText(editedTitle, 15_000);
      await shot('19b-list-view');
      if (!(await click(ts.viewKanban))) throw new Error('kanban tab');
      return `gantt label: "${row.slice(0, 80)}…"; activity ${paged}`;
    });
    await step('workload matrix: person × day table with spoken cells; no web-fallback tab', async () => {
      if (!(await click(ts.viewWorkload))) throw new Error('workload tab');
      await waitText(ts.person, 20_000);
      const t = await js<{ headers: number; rows: number; cell: string | null }>(`(() => { const t = document.querySelector('[role=table]'); const c = t && [...t.querySelectorAll('[role=button]')].find(e => (e.getAttribute('aria-label') || '').includes(${JSON.stringify(lead(ts.loadPlanned).trim())})); return { headers: t ? t.querySelectorAll('[role=columnheader]').length : 0, rows: t ? t.querySelectorAll('[role=row]').length : 0, cell: c ? c.getAttribute('aria-label') : null }; })()`);
      if (t.headers !== 9 || t.rows < 2 || !t.cell) throw new Error(`workload table ${JSON.stringify(t)}`);
      if (!(await click(ts.twoWeeks))) throw new Error('span chip');
      await sleep(1500);
      const wide = await js<number>(`document.querySelector('[role=table]')?.querySelectorAll('[role=columnheader]').length ?? 0`);
      if (wide !== 16) throw new Error(`2-week headers ${wide}`);
      await click(t.cell);
      await sleep(800);
      await shot('21-workload');
      // GENE-56: the web-fallback tab is gone; only admins get "Administration" (web, password confirmation).
      if (await webTab()) throw new Error('web fallback tab visible for a non-admin');
      if (await webLinks()) throw new Error('web fallback links still listed');
      await click(md.sectionProjects);
      return `${t.headers} columns × ${t.rows} rows; cell "${t.cell.slice(0, 90)}…"`;
    });
    await step('dashboards: create (project summary) → KPI + distribution tables → drill-down → task; widget add/edit/CSV/remove; delete', async () => {
      const dashTitle = `Desktop dashboard ${new Date().toISOString().slice(11, 19)}`;
      const until = async (fn: () => Promise<boolean>, what: string, ms = 15_000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          if (await fn()) return;
          await sleep(300);
        }
        throw new Error(what);
      };
      await click(cm.tasks);
      await sleep(500);
      if (!(await click(md.sectionDashboards))) throw new Error('dashboard tab');
      await waitText(db.newDashboard, 20_000);
      if (!(await type(`input[aria-label=${JSON.stringify(db.dashboardTitleLabel)}]`, dashTitle))) throw new Error('title input');
      if (!(await click(db.createDashboard))) throw new Error('create');
      await waitText('Distribution by column', 20_000);
      await until(() => js<boolean>(`document.querySelectorAll('[role=table]').length >= 2`), 'widget results (tables)', 30_000);
      const t = await js<{ tables: number; headers: string[]; kpi: string | null }>(`(() => {
        const tables = [...document.querySelectorAll('[role=table]')];
        const kpi = [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).find(l => /^Total work: \\d/.test(l || ''));
        return { tables: tables.length, headers: tables[0] ? [...tables[0].querySelectorAll('[role=columnheader]')].map(e => e.innerText.trim()).filter(Boolean) : [], kpi: kpi || null }; })()`);
      if (t.tables < 2 || t.headers.join('|') !== [db.colGroup, db.colValue, db.colShare].join('|') || !t.kpi) throw new Error(`dashboard tables ${JSON.stringify(t)}`);
      await shot('22-dashboard');
      await js(`document.querySelector('[role=table]')?.scrollIntoView()`);
      await shot('22b-dashboard-distribution');
      // Distribution group → cards of that group only.
      const group = await js<string | null>(`(() => { const b = [...document.querySelectorAll('[role=table] [role=button]')].find(e => (e.getAttribute('aria-label') || '').endsWith(${JSON.stringify(tail(db.groupDrillLabel))})); return b ? b.getAttribute('aria-label') : null; })()`);
      if (!group || !(await click(group))) throw new Error('distribution group button');
      await waitText(lead(db.drillMeta), 20_000);
      if (!(await click(db.backToDashboard))) throw new Error('back from group');
      // KPI drill-down → card list → task detail.
      await until(() => click(db.openCardsLabel('Total work')), 'kpi drill-down');
      await waitText(lead(db.drillMeta), 20_000);
      const shown = await js<string>(`document.body.innerText.match(new RegExp(${JSON.stringify(`${esc(lead(db.drillMeta))}(\\d+) `)}))?.[1] ?? '0'`);
      const task = await js<string | null>(`(() => { const b = [...document.querySelectorAll('[role=table] [role=button]')].find(e => (e.getAttribute('aria-label') || '').endsWith(${JSON.stringify(tail(db.cardOpenLabel))})); return b ? b.getAttribute('aria-label') : null; })()`);
      if (!task || !(await click(task))) throw new Error('task row in drill-down');
      await waitText(cm.comments, 20_000);
      await shot('23-dashboard-drilldown');
      if (!(await click(db.backToDashboard))) throw new Error('back from drill-down');
      // Widget CRUD + CSV. The type chip reads "<server label> (<kind>)" and the title field "Title (empty = <server label>)".
      const widgetTitleSelector = `input[aria-label=${JSON.stringify(db.widgetTitleField('Card list'))}]`;
      await until(() => click(db.addWidget), 'add widget');
      await until(() => click(`Card list (${db.kindList})`), 'card list type');
      await until(() => type(widgetTitleSelector, 'Smoke list'), 'widget title');
      if (!(await click('Completed'))) throw new Error('preset chip'); // preset label comes from the server
      if (!(await click(db.add))) throw new Error('add');
      await waitText(db.widgetAdded, 15_000);
      await until(() => click(db.downloadCsvLabel('Smoke list')), 'widget csv');
      await waitText(db.savedFile('workhub-dashboard-'), 15_000);
      if (!(await click(db.editWidgetLabel('Smoke list')))) throw new Error('edit widget');
      await until(() => type(widgetTitleSelector, 'Smoke list 2'), 'edit title');
      if (!(await click(cm.save))) throw new Error('save widget');
      await waitText(db.widgetSaved, 15_000);
      await until(() => click(db.removeWidgetLabel('Smoke list 2')), 'remove widget');
      await until(() => click(db.confirmRemoveYes), 'confirm remove');
      await waitText(db.widgetRemoved, 15_000);
      if (!(await click(db.delete))) throw new Error('delete dashboard');
      if (!(await click(db.confirmDeleteYes))) throw new Error('confirm delete');
      await waitText(db.newDashboard, 15_000);
      await sleep(1000);
      if (await js<boolean>(`document.body.innerText.includes(${JSON.stringify(dashTitle)})`)) throw new Error('dashboard still listed');
      // GENE-56: the web-fallback tab is gone; only admins get "Administration" (web, password confirmation).
      if (await webTab()) throw new Error('web fallback tab visible for a non-admin');
      if (await webLinks()) throw new Error('dashboard web link still listed');
      await click(md.sectionProjects);
      return `${t.tables} tables, "${t.kpi}", drill-down ${shown} cards → task; widget add/edit/CSV/remove; deleted`;
    });
    await step('workflows: create from sample → set lists → save → start run → task → complete → hand-off from task screen; cancel a run; delete', async () => {
      const wfTitle = `Desktop flow ${new Date().toISOString().slice(11, 19)}`;
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
        await until(async () => !!(await nth(wf.pickListA11y(wf.cardList))), 'list picker');
        await until(async () => !!(await nth(lead(wf.projectChip))), 'project chip', 20_000);
        await until(async () => !!(await nth(lead(wf.listChip))), 'stack chip', 20_000);
      };
      await click(cm.tasks);
      await sleep(500);
      if (!(await click(md.sectionWorkflows))) throw new Error('workflows tab');
      await waitText(lead(wf.tabPending), 20_000);
      await shot('24-workflows-pending');
      if (!(await click(wf.tabTemplates))) throw new Error('templates tab');
      await waitText(wf.newWorkflow, 20_000);
      if (!(await type(`input[aria-label=${JSON.stringify(wf.workflowTitleA11y)}]`, wfTitle))) throw new Error('title input');
      // Third sample = "prepare and review" (2 steps: fixed → hand-off → chosen).
      await until(async () => !!(await nth(lead(wf.sampleChip), 2)), 'sample chip', 20_000);
      if (!(await click(wf.createWorkflow))) throw new Error('create');
      await waitText(wf.runs, 20_000);
      await waitText(NO_LIST, 10_000);
      if (!(await click(wf.steps))) throw new Error('steps');
      await pickList();
      if (!(await nth(lead(wf.stepChip), 1))) throw new Error('second step chip');
      await pickList();
      await shot('25-workflow-editor');
      if (!(await click(wf.saveSteps))) throw new Error('save steps');
      await waitText(wf.stepsSaved, 15_000);
      await sleep(800);
      if (await js<boolean>(`document.body.innerText.includes(${JSON.stringify(NO_LIST)})`)) throw new Error('issues still listed after save');
      // Run 1 → open its first card → complete → hand over from the task screen.
      const runTitle = `${wfTitle} run`;
      if (!(await click(wf.startRun))) throw new Error('start panel');
      if (!(await type(`input[aria-label=${JSON.stringify(wf.runTitleField)}]`, runTitle))) throw new Error('run title');
      if (!(await click(wf.startButton))) throw new Error('start');
      await waitText(lead(wf.runStarted).trim(), 20_000);
      await waitText(`— ${wf.stepStateOpen}`, 15_000);
      await shot('26-workflow-run');
      const cardBtn = await nth(lead(wf.cardA11y));
      if (!cardBtn) throw new Error('card button in run');
      await waitText(cm.comments, 20_000);
      if (!(await click(cm.markDone))) throw new Error('mark done');
      await waitText(wf.taskSectionTitle, 20_000);
      const handoff = await js<string | null>(`(() => { const el = [...document.querySelectorAll('[role=button]')].find(e => (e.getAttribute('aria-label') || '').endsWith(${JSON.stringify(tail(wf.handOverA11y))})); if (!el) return null; el.click(); return el.getAttribute('aria-label'); })()`);
      if (!handoff) throw new Error('handoff button on task screen');
      await until(() => click(wf.handOverAndCreate), 'handoff submit');
      await waitText(tail(wf.handedOverDone).replace(/^"\s*/, '').replace(/\.$/, ''), 20_000); // "handed over; card created"
      await shot('27-workflow-handoff');
      // Back in the workflow: run 1 shows the new open step; run 2 is cancelled.
      const runRow = wf.runA11y(runTitle, wf.runStateRunning);
      await until(() => click(runRow), 'run row');
      await sleep(1500);
      await until(() => click(runRow), 'run row re-open');
      await waitText(`— ${wf.stepStateDone}`, 15_000);
      if (!(await click(wf.startRun))) throw new Error('start panel 2');
      if (!(await click(wf.startButton))) throw new Error('start 2');
      // The start message of run 1 is still on screen: wait for the second running run instead.
      const running = (n: number) => `${n} ${wf.runStateRunning.toLowerCase()}`;
      await waitText(running(2), 20_000);
      await until(async () => (await js<number>(`[...document.querySelectorAll('[role=button]')].filter(e => (e.getAttribute('aria-label') || '') === ${JSON.stringify(wf.cancelRun)} || e.innerText.trim() === ${JSON.stringify(wf.cancelRun)}).length`)) === 1, 'only the new run is expanded', 20_000);
      await until(() => click(wf.cancelRun), 'cancel run');
      if (!(await click(wf.yesCancel))) throw new Error('confirm cancel');
      await waitText(wf.runCancelled.split(';')[0]!, 15_000); // "Run cancelled"
      await waitText(running(1), 15_000);
      if (!(await js<boolean>(`document.body.innerText.includes(${JSON.stringify(runTitle)}) && [...document.querySelectorAll('[role=button]')].some(e => e.getAttribute('aria-label') === ${JSON.stringify(runRow)})`))) throw new Error('run 1 must still be running');
      await shot('28-workflow-cancelled');
      if (!(await click(wf.deleteAction))) throw new Error('delete');
      if (!(await click(wf.yesDelete))) throw new Error('confirm delete');
      await waitText(wf.newWorkflow, 15_000);
      await sleep(1000);
      if (await js<boolean>(`[...document.querySelectorAll('[role=button]')].some(e => e.getAttribute('aria-label') === ${JSON.stringify(wf.workflowA11y(wfTitle))})`)) throw new Error('workflow still listed');
      // GENE-56: the web-fallback tab is gone; only admins get "Administration" (web, password confirmation).
      if (await webTab()) throw new Error('web fallback tab visible for a non-admin');
      if (await webLinks()) throw new Error('workflow web link still listed');
      await click(md.sectionProjects);
      return `created "${wfTitle}", lists set, run → ${cardBtn.slice(0, 60)} → done → ${handoff}; second run cancelled; deleted`;
    });
    await step('time module: start → stop timer', async () => {
      await click(cm.tasks);
      await sleep(500);
      if (!(await click(md.sectionTime))) throw new Error('time tab');
      await waitText(tm.timer, 15_000);
      if (await hasButton(tm.stop)) await click(tm.stop);
      await waitButton(tm.start);
      await type('input', 'Desktop smoke');
      await click(tm.start);
      await waitButton(tm.stop);
      await shot('07-time');
      await click(tm.stop);
      await waitButton(tm.start);
    });
    await step('time entries: add → edit → submit (locked) → withdraw → delete', async () => {
      const label = `Desktop entry ${new Date().toISOString().slice(11, 19)}`;
      const startSel = `input[aria-label=${JSON.stringify(tm.startField)}]`;
      const endSel = `input[aria-label=${JSON.stringify(tm.endField)}]`;
      if (!(await click(tm.addEntry))) throw new Error('add entry');
      await waitText(tm.newEntry, 10_000);
      if (!(await type(startSel, '06:00'))) throw new Error('start input');
      await type(endSel, '06:30');
      if (!(await type(`textarea[aria-label=${JSON.stringify(tm.description)}]`, label)) && !(await type(`input[aria-label=${JSON.stringify(tm.description)}]`, label))) throw new Error('description input');
      if (!(await click(tm.addEntryLabel))) throw new Error('save new');
      await waitText(label, 15_000);
      await waitText('06:00–06:30', 15_000);
      if (!(await click(tm.editEntryLabel(label)))) throw new Error('edit button');
      await waitText(tm.editEntry, 10_000);
      await type(endSel, '07:00');
      if (!(await click(tm.saveEntryLabel))) throw new Error('save edit');
      await waitText('06:00–07:00', 15_000);
      if (!(await click(tm.submitPeriod))) throw new Error('submit');
      await waitText(tm.periodSubmittedDone, 15_000);
      await waitText(tm.periodSummary('', false, '', '').split(' · ')[1]!, 15_000); // "entries are read-only 🔒"
      if (await hasButton(tm.deleteEntryLabel(label))) throw new Error('delete visible on a locked period');
      await shot('12-time-submitted');
      if (!(await click(tm.withdrawSubmission))) throw new Error('withdraw');
      await waitText(tm.submissionWithdrawnDone, 15_000);
      const end = Date.now() + 10_000;
      while (!(await click(tm.deleteEntryLabel(label)))) {
        if (Date.now() > end) throw new Error('delete button after withdraw');
        await sleep(300);
      }
      await waitText(tm.entryDeleted, 15_000);
      return 'entry created, edited, locked on submit, unlocked on withdraw, deleted';
    });
    await step('time entry linked to a task: add → task picker (project → search → task) → listed under the task → delete', async () => {
      if (!firstBoardTitle) throw new Error('project title not captured');
      if (!(await click(tm.addEntry))) throw new Error('add entry');
      await waitText(tm.newEntry, 10_000);
      await type(`input[aria-label=${JSON.stringify(tm.startField)}]`, '05:00');
      await type(`input[aria-label=${JSON.stringify(tm.endField)}]`, '05:30');
      if (!(await click(tm.linkTask))) throw new Error('link task button');
      await waitText(firstBoardTitle, 10_000);
      if (!(await click(firstBoardTitle))) throw new Error('project chip');
      const end = Date.now() + 10_000;
      while (!(await type(`input[aria-label=${JSON.stringify(ts.searchTask)}]`, editedTitle))) {
        if (Date.now() > end) throw new Error('task search');
        await sleep(300);
      }
      await sleep(500);
      if (!(await click(editedTitle))) throw new Error('task chip');
      await waitText(tm.changeTask, 5_000);
      await shot('12b-time-task-link');
      if (!(await click(tm.addEntryLabel))) throw new Error('save new');
      await waitText('05:00–05:30', 15_000);
      const end2 = Date.now() + 10_000;
      while (!(await click(tm.deleteEntryLabel(editedTitle)))) {
        if (Date.now() > end2) throw new Error('entry not listed under the task title');
        await sleep(300);
      }
      await waitText(tm.entryDeleted, 15_000);
      return `entry linked to "${editedTitle}" in "${firstBoardTitle}", deleted`;
    });
    await step('AI: status + quota → project summary request → polled to a terminal state with the server explanation → history; client-side rule; no admin tab', async () => {
      if (!firstBoardTitle) throw new Error('project title not captured');
      await click(cm.tasks);
      await sleep(500);
      if (!(await click(md.sectionAi))) throw new Error('AI tab');
      await waitText(lead(ai.quotaLine).trim(), 15_000);
      if (await webTab()) throw new Error('admin/web tab visible for a non-admin');
      // Client-side rule: a question needs text (never sent).
      if (!(await click(ai.actionQuestion))) throw new Error('question chip');
      await waitText(firstBoardTitle, 10_000);
      await click(firstBoardTitle);
      if (!(await click(ai.sendRequestLabel(ai.actionQuestion)))) throw new Error('send question');
      await waitText(ai.inputMessageRequired, 5_000);
      if (!(await click(ai.actionBoardSummary))) throw new Error('board summary chip');
      await sleep(300);
      if (!(await click(firstBoardTitle))) throw new Error('project chip');
      if (!(await click(ai.sendRequestLabel(ai.actionBoardSummary)))) throw new Error('send');
      await waitText(ai.sources, 15_000);
      const end = Date.now() + 90_000;
      let state = '';
      const terminal = [ai.stateSucceeded, ai.stateFailed, ai.stateCancelled];
      while (Date.now() < end) {
        state = await js<string>(`(() => { const t = document.body.innerText; return ${JSON.stringify(terminal)}.find(s => t.includes(s + ' · ')) || ''; })()`);
        if (state) break;
        await sleep(1000);
      }
      if (!state) throw new Error('request did not finish');
      const detail = await js<{ alert: string; answer: boolean; source: boolean }>(`(() => ({ alert: [...document.querySelectorAll('[role=alert]')].map(e => e.innerText).join(' | '), answer: !!document.querySelector(${JSON.stringify(`[aria-label="${ai.answerLabel}"]`)}), source: document.body.innerText.includes(${JSON.stringify(ai.sourceBoard(firstBoardTitle))}) }))()`);
      if (!detail.source) throw new Error('source project not listed');
      if (state === ai.stateFailed && !detail.alert) throw new Error('failure without explanation');
      if (state === ai.stateSucceeded && !detail.answer) throw new Error('answer missing');
      await shot('24-ai-request');
      if (!(await click(ai.backLabel))) throw new Error('back');
      await waitText(ai.tabHistory, 10_000);
      if (!(await click(ai.tabHistory))) throw new Error('history tab');
      await waitText(`${state} · `, 10_000);
      await shot('25-ai-history');
      // Back to Time for the CSV step that follows.
      if (!(await click(md.sectionTime))) throw new Error('time tab');
      await waitText(tm.timer, 15_000);
      return `request ${state}${detail.alert ? ` — "${detail.alert.slice(0, 80)}"` : ''}; listed in history`;
    });
    await step('own CSV export → save (smoke: written to the output dir)', async () => {
      if (!(await click(tm.csvDownload))) throw new Error('own csv');
      await waitText(tm.savedFile('workhub-time-own-'), 20_000);
    });
    const subject = process.env.WORKHUB_SMOKE_SUBJECT ?? '';
    if (subject) {
      await step('review queue: approve → reopen (reason required); team report table; team CSV', async () => {
        if (!(await click(tm.tabReview))) throw new Error('review tab (reviewer gate)');
        await waitText(subject, 15_000);
        await shot('13-time-review');
        if (!(await click(tm.approveLabel(subject)))) throw new Error('approve button');
        await waitText(tm.noPendingReviews, 15_000);
        // approve is allowed without reason; then reopen requires one
        if (!(await click(tm.queueApproved))) throw new Error('approved tab');
        await waitText(subject, 15_000);
        const until = async (fn: () => Promise<boolean>, what: string) => {
          const end = Date.now() + 15_000;
          while (!(await fn())) {
            if (Date.now() > end) throw new Error(what);
            await sleep(300);
          }
        };
        await until(() => click(tm.reopenLabel(subject)), 'reopen button');
        await waitText(tm.errReasonRequired, 5_000);
        if (!(await type(`textarea[aria-label=${JSON.stringify(tm.reasonLabel(subject))}]`, 'Smoke: please fix'))) throw new Error('reason input');
        if (!(await click(tm.reopenLabel(subject)))) throw new Error('reopen button 2');
        await waitText(tm.noApprovedPeriods, 15_000);
        if (!(await click(tm.tabTeamReport))) throw new Error('team tab');
        await waitText(tm.colBillable, 15_000);
        await waitText(subject, 15_000);
        const table = await js<{ headers: number; rows: number }>(`(() => { const t = document.querySelector('[role=table]'); return { headers: t ? t.querySelectorAll('[role=columnheader]').length : 0, rows: t ? t.querySelectorAll('[role=row]').length : 0 }; })()`);
        if (table.headers !== 5 || table.rows < 3) throw new Error(`table semantics ${JSON.stringify(table)}`);
        await shot('14-time-team');
        if (!(await click(tm.csvDownloadTeam))) throw new Error('team csv');
        await waitText(tm.savedFile('workhub-time-team-'), 20_000);
        return `approve → reopen (reason enforced); table ${table.headers} columns × ${table.rows} rows`;
      });
    }
    const stamp = new Date().toISOString().slice(11, 19);
    const projectTitle = `Desktop project ${stamp}`;
    const renamedProject = `${projectTitle} (renamed)`;
    await step('project management: create → rename → add/rename column → add member', async () => {
      await click(cm.tasks);
      await sleep(500);
      if (!(await click(md.sectionProjects))) throw new Error('projects tab');
      if (!(await type(`input[aria-label=${JSON.stringify(cm.newProject)}]`, projectTitle))) throw new Error('new project input');
      if (!(await click(cm.create))) throw new Error('create project');
      await waitText('To Do', 20_000);
      if (!(await click(cm.projectSettings))) throw new Error('manage button');
      await waitText(cm.columns, 10_000);
      if (!(await type(`input[aria-label=${JSON.stringify(cm.projectName)}]`, renamedProject))) throw new Error('project name input');
      if (!(await click(cm.renameProject))) throw new Error('rename project');
      await waitText(renamedProject, 15_000);
      if (!(await type(`input[aria-label=${JSON.stringify(cm.newColumn)}]`, 'Triage'))) throw new Error('new column input');
      if (!(await click(cm.addColumn))) throw new Error('add column');
      await waitLabel(ts.columnLabel('Triage', 0));
      if (!(await type(`input[aria-label=${JSON.stringify(`${cm.columnName}: Triage`)}]`, 'QA'))) throw new Error('column name input');
      if (!(await click(`${cm.rename}: Triage`))) throw new Error('rename column');
      await waitLabel(ts.columnLabel('QA', 0));
      const member = process.env.WORKHUB_SMOKE_MEMBER ?? '';
      if (member) {
        if (!(await type(`input[aria-label=${JSON.stringify(cm.addMember)}]`, member))) throw new Error('member search');
        const end = Date.now() + 10_000;
        while (!(await click(`${cm.pick}: ${member}`))) {
          if (Date.now() > end) throw new Error('member result');
          await sleep(300);
        }
        await waitText(cm.memberAdded, 15_000);
      }
      await shot('10-project-admin');
      return member ? `member ${member} added` : 'member step skipped (no WORKHUB_SMOKE_MEMBER)';
    });
    const goal = process.env.WORKHUB_SMOKE_GOAL ?? '';
    if (goal) {
      await step('goal shares: share with a group → save → server list reloaded', async () => {
        await click(cm.tasks);
        await sleep(500);
        if (!(await click(md.sectionGoals))) throw new Error('goals tab');
        await waitText(goal, 15_000);
        if (!(await click(gl.openGoalLabel(goal)))) throw new Error('open goal');
        await waitText(gl.targetsHeading, 15_000);
        if (!(await click(gl.shareLabel(goal)))) throw new Error('share button');
        await waitText(cm.noShares, 15_000);
        const group = process.env.WORKHUB_SMOKE_GROUP ?? 'staff';
        if (!(await type(`input[aria-label=${JSON.stringify(cm.addShare)}]`, group))) throw new Error('share search');
        const end = Date.now() + 10_000;
        while (!(await click(`${cm.pick}: ${group}`))) {
          if (Date.now() > end) throw new Error('group result');
          await sleep(300);
        }
        if (!(await click(cm.save))) throw new Error('save shares');
        await waitText(cm.sharesSaved, 15_000);
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
        // The decimal separator and the "Now … · target …" line come from the catalog; the server returns 2 decimals for TRY.
        const targetLine = gl.targetValues('0.00 TRY', '1000.50 TRY', SENTINEL);
        if (!(await click(gl.typeCurrency))) throw new Error('currency chip');
        if (!(await type(`input[aria-label=${JSON.stringify(gl.targetTitleLabel)}]`, 'Revenue'))) throw new Error('target title');
        if (!(await type(`input[aria-label=${JSON.stringify(gl.target)}]`, '1000.5'))) throw new Error('target value');
        if (!(await click(gl.add))) throw new Error('add target');
        await waitText(gl.doneTargetAdded, 15_000);
        await waitText(targetLine.slice(0, targetLine.lastIndexOf(' (')), 15_000); // up to the "(start …)" part
        await until(() => click(gl.checkinLabel('Revenue')), 'check-in button');
        if (!(await click(gl.changeMode))) throw new Error('delta chip');
        await type(`input[aria-label=${JSON.stringify(gl.valueLabel('Revenue'))}]`, '1.234');
        if (!(await click(gl.saveCheckinLabel('Revenue')))) throw new Error('save check-in');
        await waitText(gl.errDecimalScaleExample(2), 5_000);
        await type(`input[aria-label=${JSON.stringify(gl.valueLabel('Revenue'))}]`, '250.25');
        await type(`input[aria-label=${JSON.stringify(gl.noteLabel('Revenue'))}]`, 'Desktop check-in');
        if (!(await click(gl.saveCheckinLabel('Revenue')))) throw new Error('save check-in 2');
        await waitText(gl.doneCheckin, 15_000);
        await waitText(`${lead(gl.targetValues)}250.25 TRY`, 15_000);
        await until(() => click(gl.historyLabel('Revenue')), 'history button');
        await waitText(`${gl.checkinChange('0.00 TRY', '250.25 TRY', true)} · “Desktop check-in”`, 15_000);
        await shot('19-goal-checkin');
        if (!(await click(gl.archiveLabel(goal)))) throw new Error('archive');
        await waitText(gl.doneArchived, 15_000);
        await waitText(gl.archivedNotice, 15_000);
        if (await has(gl.checkinLabel('Revenue'))) throw new Error('check-in offered on an archived goal');
        if (!(await click(gl.reactivateLabel(goal)))) throw new Error('reactivate');
        await waitText(gl.doneReactivated, 15_000);
        await until(() => has(gl.checkinLabel('Revenue')), 'check-in back after reactivate');
        return 'target 1000.50 TRY; 1.234 refused locally; +250.25 → 25%; archived (no writes) → reactivated';
      });
      await step('goals ↔ task: open task → link to goal → listed with progress → unlink', async () => {
        await click(cm.tasks);
        await sleep(500);
        if (!(await click(md.sectionProjects))) throw new Error('projects tab');
        // The project list is virtualised and grows with every smoke run: scroll it into view first.
        await reveal(renamedProject);
        await until(() => click(renamedProject, false), 'project row');
        await waitText('To Do', 20_000);
        const linkTask = `Goal task ${stamp}`;
        await addTask(linkTask);
        await waitText(linkTask, 15_000);
        if (!(await click(linkTask, false))) throw new Error('task row');
        await waitText(gl.notLinked, 20_000);
        if (!(await click(gl.linkToGoal))) throw new Error('link button');
        await until(() => click(gl.linkLabel(goal)), 'goal in picker');
        await waitText(gl.doneTaskLinked(goal), 15_000);
        await until(() => has(gl.unlinkLabel(goal, null)), 'linked goal listed');
        await shot('20-task-goal-linked');
        if (!(await click(gl.unlinkLabel(goal, null)))) throw new Error('unlink');
        await waitText(gl.doneTaskUnlinked, 15_000);
        await waitText(gl.notLinked, 15_000);
        return `task "${linkTask}" linked → unlinked`;
      });
      await step('goals: transfer ownership to another user (picker: users only) → previous owner keeps manage', async () => {
        await click(cm.tasks);
        await sleep(500);
        if (!(await click(md.sectionGoals))) throw new Error('goals tab');
        await until(() => click(gl.openGoalLabel(goal)), 'open goal');
        await waitText(gl.targetsHeading, 15_000);
        if (!(await click(gl.transferOwnershipLabel(goal)))) throw new Error('transfer button');
        const member = process.env.WORKHUB_SMOKE_MEMBER ?? 'Bob';
        if (!(await type(`input[aria-label=${JSON.stringify(gl.searchPerson)}]`, member))) throw new Error('person search');
        await until(() => click(`${cm.pick}: ${member}`), 'person result');
        if (!(await click(gl.transferLabel(member)))) throw new Error('confirm transfer');
        await waitText(gl.doneTransferred, 15_000);
        await waitText(gl.goalDetailMeta(member, gl.roleManage, null), 15_000);
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
        await click(cm.tasks);
        await sleep(500);
        if (!(await click(md.sectionRequests))) throw new Error('requests tab');
        await until(() => click(rq.tabReceived), 'received tab');
        await waitText(reqApprove, 15_000);
        await until(() => click(rq.detailsLabel(reqApprove)), 'open approve request');
        await until(() => click(rq.approveLabel(reqApprove)), 'approve button');
        await waitText(rq.doneApproved, 15_000);
        await waitText(rq.eventApproved, 15_000);
        // A is the recipient, not the requester's manager here → no resolve / convert.
        if ((await has(rq.resolveLabel(reqApprove))) || (await has(rq.convertLabel(reqApprove)))) throw new Error('manager actions visible to recipient');
        await shot('15-request-approved');
        if (!(await click(cm.close))) throw new Error('close');
        await until(() => click(rq.detailsLabel(reqReject)), 'open reject request');
        await until(() => click(rq.rejectLabel(reqReject)), 'reject button');
        await waitText(rq.errRejectReasonRequired, 5_000);
        if (!(await type(`textarea[aria-label=${JSON.stringify(rq.reasonLabel(reqReject))}]`, 'Smoke: no budget'))) throw new Error('reason input');
        if (!(await click(rq.rejectLabel(reqReject)))) throw new Error('reject button 2');
        await waitText(rq.doneRejected, 15_000);
        await waitText(rq.rejectionReason('Smoke: no budget'), 15_000);
        await shot('16-request-rejected');
        if (!(await click(cm.close))) throw new Error('close 2');
        return 'approve ✓, reject reason enforced ✓, resolve/convert hidden for recipient ✓';
      });
    }
    const reqConvert = process.env.WORKHUB_SMOKE_REQ_CONVERT ?? '';
    const reqResolve = process.env.WORKHUB_SMOKE_REQ_RESOLVE ?? '';
    if (reqConvert && reqResolve) {
      await step('requests (manager): convert → project/column picker → task; resolve needs a reason; report table', async () => {
        await click(cm.tasks);
        await sleep(500);
        if (!(await click(md.sectionRequests))) throw new Error('requests tab');
        await until(() => click(rq.tabTeam), 'team tab (manager only)');
        await waitText(reqConvert, 15_000);
        await until(() => click(rq.detailsLabel(reqConvert)), 'open convert request');
        await waitText(rq.convertToTask, 15_000);
        // Destination: the project created above (A can edit it), first open column preselected.
        await type(`input[aria-label=${JSON.stringify(rq.searchProjectLabel(reqConvert))}]`, projectTitle);
        await until(() => click(renamedProject), 'project chip');
        await waitText(rq.column, 15_000);
        const checked = () => js<string[]>(`[...document.querySelectorAll('[role=checkbox]')].filter(e => e.getAttribute('aria-checked') === 'true').map(e => e.innerText.trim())`);
        try {
          await until(async () => (await checked()).includes('To Do'), 'default column', 10_000);
        } catch {
          throw new Error(`default column; checked=${JSON.stringify(await checked())}`);
        }
        if (!(await click(rq.convertLabel(reqConvert)))) throw new Error('convert button');
        await waitText(rq.doneConverted, 20_000);
        await waitText(rq.linkedTaskLine(reqConvert, renamedProject, 'To Do', false), 15_000);
        await waitText(rq.eventConverted, 15_000);
        await shot('17-request-converted');
        if (!(await click(cm.close))) throw new Error('close');
        await until(() => click(rq.detailsLabel(reqResolve)), 'open resolve request');
        await until(() => click(rq.resolveLabel(reqResolve)), 'resolve button');
        await waitText(rq.errResolveReasonRequired, 5_000);
        if (!(await type(`textarea[aria-label=${JSON.stringify(rq.resolutionReasonLabel(reqResolve))}]`, 'Smoke: no task needed'))) throw new Error('resolve reason');
        if (!(await click(rq.resolveLabel(reqResolve)))) throw new Error('resolve button 2');
        await waitText(rq.doneResolved, 15_000);
        await waitText(rq.eventResolved, 15_000);
        if (!(await click(cm.close))) throw new Error('close 2');
        if (!(await click(rq.tabReport))) throw new Error('report tab');
        await waitText(rq.colRequester, 15_000);
        await until(() => click(rq.scopeTeam), 'report team scope');
        await waitText(reqConvert, 15_000);
        const table = await js<{ headers: number; rows: number }>(`(() => { const t = document.querySelector('[role=table]'); return { headers: t ? t.querySelectorAll('[role=columnheader]').length : 0, rows: t ? t.querySelectorAll('[role=row]').length : 0 }; })()`);
        if (table.headers !== 5 || table.rows < 3) throw new Error(`report table ${JSON.stringify(table)}`);
        await shot('18-request-report');
        return `converted into "${renamedProject}" / To Do; resolved; report ${table.headers} columns × ${table.rows} rows`;
      });
    }
    await step('inbox', async () => {
      await click(cm.inbox);
      await sleep(2500);
      await shot('08-inbox');
    });
    await step('account', async () => {
      await click(cm.account);
      await waitText(cm.logout);
      await shot('09-account');
    });
  } catch {
    /* recorded in steps */
  } finally {
    await fs.writeFile(join(out, 'result.json'), JSON.stringify({ steps }, null, 2));
  }
}
