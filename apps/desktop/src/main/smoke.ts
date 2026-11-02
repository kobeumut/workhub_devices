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
      if (!(await type('input[aria-label="Yeni görev"]', taskTitle))) throw new Error('new task input');
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
    await step('project views: Gantt (edited task as milestone) → activity stream (title change, paging)', async () => {
      if (!(await click('açık', false))) throw new Error('project row');
      await waitText('To Do', 20_000);
      if (!(await click('Gantt'))) throw new Error('gantt tab');
      await waitText('Zaman çizelgesi', 20_000);
      await waitText(editedTitle, 15_000);
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
      return `gantt label: "${row.slice(0, 80)}…"; activity ${paged}`;
    });
    await step('workload matrix: person × day table with spoken cells; web links gone from "Diğer"', async () => {
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
      if (!(await click('Diğer'))) throw new Error('more tab');
      await sleep(800);
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
      if (!(await click("Smoke listesi 2: widget'ı kaldır"))) throw new Error('remove widget');
      if (!(await click('Evet, kaldır'))) throw new Error('confirm remove');
      await waitText('Widget kaldırıldı.', 15_000);
      if (!(await click('Sil'))) throw new Error('delete dashboard');
      if (!(await click('Evet, sil'))) throw new Error('confirm delete');
      await waitText('Yeni dashboard', 15_000);
      await sleep(1000);
      if (await js<boolean>(`document.body.innerText.includes(${JSON.stringify(dashTitle)})`)) throw new Error('dashboard still listed');
      if (!(await click('Diğer'))) throw new Error('more tab');
      await sleep(800);
      if (await js<boolean>(`document.body.innerText.includes("Dashboard'lar ve widget'lar")`)) throw new Error('dashboard web link still listed');
      await click('Projeler');
      return `${t.tables} tables, "${t.kpi}", drill-down ${shown} cards → task; widget add/edit/CSV/remove; deleted`;
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
      await waitText('İnceleme (0)', 15_000);
      if (!(await type('input[aria-label="Sütun adı: İnceleme"]', 'QA'))) throw new Error('column name input');
      if (!(await click('Yeniden adlandır: İnceleme'))) throw new Error('rename column');
      await waitText('QA (0)', 15_000);
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
        await until(() => click(`${projectTitle} (yeni ad)`, false), 'project row');
        await waitText('To Do', 20_000);
        const linkTask = `Hedef görevi ${stamp}`;
        if (!(await type('input[aria-label="Yeni görev"]', linkTask))) throw new Error('new task input');
        if (!(await click('+'))) throw new Error('add task');
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
