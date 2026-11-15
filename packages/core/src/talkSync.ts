import type { RoomListResult, TalkRoom } from './talk';
import { OcsError } from './ocs';

/** Server totals, never client-side message increments (own/replayed events cannot double count). */
export function unreadTotal(rooms: readonly TalkRoom[]): number {
  return rooms.reduce((n, r) => n + (Number.isSafeInteger(r.unreadMessages) && r.unreadMessages > 0 ? r.unreadMessages : 0), 0);
}

/** green = online, yellow = away, red = busy/dnd, gray = offline/unknown. */
export type PresenceTone = 'green' | 'yellow' | 'red' | 'gray';
export function presenceTone(status: unknown): PresenceTone {
  switch (status) {
    case 'online': return 'green';
    case 'away': return 'yellow';
    case 'busy':
    case 'dnd': return 'red';
    default: return 'gray';
  }
}

/**
 * Stable presence codes. `core` has no i18n: the UI maps these codes to localized text, either
 * with its own table or through the `labels` argument of `presenceLabel`.
 */
export type PresenceCode = 'online' | 'away' | 'busy' | 'dnd' | 'offline' | 'unknown';

/** Normalizes a server status string; `invisible` reads as `offline`, anything unrecognized as `unknown`. */
export function presenceCode(status: unknown): PresenceCode {
  switch (status) {
    case 'online': return 'online';
    case 'away': return 'away';
    case 'busy': return 'busy';
    case 'dnd': return 'dnd';
    case 'offline':
    case 'invisible': return 'offline';
    default: return 'unknown';
  }
}

/** English default labels, used when no localized table is passed to `presenceLabel`. */
export const PRESENCE_LABELS_EN: Readonly<Record<PresenceCode, string>> = {
  online: 'Online',
  away: 'Away',
  busy: 'Busy',
  dnd: 'Do not disturb',
  offline: 'Offline',
  unknown: 'Status unknown',
};

/** Human-readable presence; English unless the caller supplies localized `labels` for every code. */
export function presenceLabel(status: unknown, labels: Readonly<Record<PresenceCode, string>> = PRESENCE_LABELS_EN): string {
  return labels[presenceCode(status)];
}

/** One foreground/account lifetime. Full snapshots also reconcile remote reads and removals.
 * ponytail: full room list every 5s; use server deltas if large accounts make this costly.
 */
export function watchTalk(o: {
  rooms: () => Promise<RoomListResult>;
  heartbeat: () => Promise<boolean>;
  onRooms: (rooms: TalkRoom[]) => void;
  onError: (error: unknown) => void;
  onPresenceError: (error: unknown) => void;
  intervalMs?: number;
}) {
  let stopped = false;
  let running = false;
  let dirty = false;
  let rateLimited = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    if (stopped || rateLimited) return;
    if (running) { dirty = true; return; }
    clearTimeout(timer);
    running = true;
    let delay = o.intervalMs ?? 5000;
    do {
      dirty = false;
      try {
        const result = await o.rooms();
        // A read invalidated this in-flight snapshot: don't flash stale counts.
        if (!stopped && !dirty) o.onRooms(result.rooms);
      } catch (e) {
        if (!stopped) o.onError(e);
        if (e instanceof OcsError && e.retryAfterMs) { delay = Math.max(delay, e.retryAfterMs); dirty = false; rateLimited = true; }
      }
    } while (!stopped && dirty);
    running = false;
    if (!stopped) timer = setTimeout(() => { rateLimited = false; void refresh(); }, delay);
  };
  const beat = async () => {
    let supported = true;
    let delay = 60_000;
    try { supported = await o.heartbeat(); if (!stopped) o.onPresenceError(undefined); }
    catch (e) {
      if (!stopped) o.onPresenceError(e);
      if (e instanceof OcsError && e.retryAfterMs) delay = Math.max(delay, e.retryAfterMs);
    }
    // No away/offline write on cleanup: another client may still be active.
    if (!stopped && supported) heartbeatTimer = setTimeout(() => void beat(), delay);
  };
  void refresh();
  void beat();
  return {
    refresh: () => { void refresh(); },
    stop: () => { stopped = true; clearTimeout(timer); clearTimeout(heartbeatTimer); },
  };
}

/** Serialize monotonic read markers; retries are allowed after failure, never decrement locally. */
export function readMarker(send: (id: number) => Promise<void>, onRead: () => void, onError: (e: unknown) => void) {
  let stopped = false;
  let running = false;
  let wanted = 0;
  let confirmed = 0;
  let retryAt = 0;
  const read = async (id: number) => {
    if (stopped || !Number.isSafeInteger(id) || id <= 0) return;
    wanted = Math.max(wanted, id);
    if (running || wanted <= confirmed || Date.now() < retryAt) return;
    running = true;
    try {
      while (!stopped && wanted > confirmed) {
        const next = wanted;
        await send(next);
        confirmed = next;
        if (!stopped) onRead();
      }
    } catch (e) {
      if (e instanceof OcsError && e.retryAfterMs) retryAt = Date.now() + e.retryAfterMs;
      if (!stopped) onError(e);
    }
    finally { running = false; }
  };
  return { read: (id: number) => { void read(id); }, stop: () => { stopped = true; } };
}
