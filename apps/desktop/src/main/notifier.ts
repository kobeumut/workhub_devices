import { Notification } from 'electron';
import {
  presentNotification, routeForObject, parseServerLink, shouldRaiseOsAlert,
  type AccountSummary, type Backend, type InboxNotification, type RoutedTarget,
} from '@workhub-devices/core';

/**
 * Desktop notifications while the app runs (window open OR hidden in the tray).
 * Native mobile-style push does not exist for desktop processes; when the app is fully quit
 * nothing is received — documented in README ("Masaüstü bildirim davranışı").
 *
 * - Polls each account's Notifications inbox (ETag-less list; 60 s; backs off on errors).
 * - `shouldNotify=false` → no OS alert (server decided another client shows it).
 * - Chat open on screen (same account + room) → no banner.
 * - macOS: inline reply (`hasReply`) sends a Talk message from the MAIN process.
 *   Windows/Linux: no inline reply in Electron → click/"Yanıtla" focuses the composer.
 */
export class DesktopNotifier {
  private seen = new Map<string, Set<number>>();
  private primed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private foreground: RoutedTarget | null = null;
  private failures = 0;
  showPreview = false;

  constructor(
    private readonly backend: Backend,
    private readonly onOpen: (t: RoutedTarget) => void,
    private readonly intervalMs = 60_000,
  ) {}

  setForeground(t: RoutedTarget | null) {
    this.foreground = t;
  }

  start() {
    if (this.timer) return;
    const tick = async () => {
      try {
        await this.pollAll();
        this.failures = 0;
      } catch {
        this.failures++;
      }
      this.timer = setTimeout(tick, Math.min(this.intervalMs * 2 ** this.failures, 15 * 60_000));
    };
    this.timer = setTimeout(tick, 2_000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async pollAll() {
    const accounts = await this.backend.listAccounts();
    for (const a of accounts) await this.pollAccount(a).catch(() => undefined);
  }

  private routeOf(a: AccountSummary, n: InboxNotification): RoutedTarget {
    const r = routeForObject(n.app, n.objectType, n.objectId, n.id);
    return { accountId: a.id, route: r.name === 'inbox' ? (n.link && parseServerLink(a.serverBase, n.link)) || r : r };
  }

  async pollAccount(a: AccountSummary) {
    const items = await this.backend.notifications(a.id);
    const seen = this.seen.get(a.id) ?? new Set<number>();
    const first = !this.primed.has(a.id);
    for (const n of items) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      // First poll after start only primes: don't replay the whole inbox as banners.
      if (first) continue;
      const target = this.routeOf(a, n);
      if (!shouldRaiseOsAlert(n, this.foreground, target)) continue;
      this.show(a, n, target);
    }
    this.seen.set(a.id, seen);
    this.primed.add(a.id);
  }

  private show(a: AccountSummary, n: InboxNotification, target: RoutedTarget) {
    if (!Notification.isSupported()) return;
    const p = presentNotification(n, this.showPreview);
    const canReply = process.platform === 'darwin' && target.route.name === 'room';
    const note = new Notification({
      title: p.title,
      body: p.body,
      silent: false,
      ...(canReply ? { hasReply: true, replyPlaceholder: 'Yanıt yazın' } : {}),
      ...(process.platform !== 'darwin' && target.route.name === 'room' ? { actions: [{ type: 'button' as const, text: 'Yanıtla' }] } : {}),
    });
    note.on('click', () => this.onOpen(target));
    note.on('action', () => this.onOpen(target)); // Windows/Linux fallback: focused composer
    note.on('reply', (_e, reply: string) => {
      const r = target.route;
      if (r.name !== 'room' || !reply.trim()) return;
      const ref = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
      this.backend.send(a.id, r.token, reply, ref).catch(() => {
        new Notification({ title: 'Yanıt gönderilemedi', body: 'Sohbeti açıp tekrar deneyin.' }).show();
      });
    });
    note.show();
  }
}
