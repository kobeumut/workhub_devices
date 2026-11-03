/**
 * Offline design preview: the real shared UI (`@workhub-devices/features`) on a fixture backend,
 * used for screenshots when no live server is available (`npm run preview:shots`). Not part of
 * the shipped renderer bundle. Writes are applied to the in-memory fixture so moves/toggles show.
 */
import { createRoot } from 'react-dom/client';
import { callCapabilitiesOf, CallEngine, type Backend, type BoardPayload, type MediaStreamLike, type RoutedTarget, type RtcPeerLike, type SignalEvent, type Task, type TaskDetail } from '@workhub-devices/core';
import { createDesktopCallMedia } from '../src/renderer/call';
import { WorkhubApp, type PlatformServices } from '@workhub-devices/features';

const now = Date.now();
const day = (d: number) => new Date(now + d * 86_400_000).toISOString();
const people = {
  ayse: { type: 'user' as const, id: 'ayse', displayName: 'Ayşe Yılmaz' },
  mehmet: { type: 'user' as const, id: 'mehmet', displayName: 'Mehmet Demir' },
  zeynep: { type: 'user' as const, id: 'zeynep', displayName: 'Zeynep Kaya' },
  can: { type: 'user' as const, id: 'can', displayName: 'Can Öztürk' },
};
let seq = 200;
const task = (id: number, stackId: number, order: number, title: string, o: Partial<Task> = {}): Task => ({
  id, boardId: 7, stackId, order, title, labels: [], priority: null, assignees: [], startDate: null, dueDate: null, done: null, archived: false, lastModified: '', url: '', subtasks: { done: 0, total: 0 }, ...o,
});
const board: BoardPayload = {
  project: {
    board: { id: 7, title: 'Dermo Mobil Uygulama', color: '0082c9' },
    stacks: [
      { id: 1, title: 'Yapılacak', order: 0, isDone: false },
      { id: 2, title: 'Devam ediyor', order: 1, isDone: false },
      { id: 3, title: 'İncelemede', order: 2, isDone: false },
      { id: 4, title: 'Tamamlandı', order: 3, isDone: true },
    ],
    labels: [
      { id: 11, title: 'Tasarım', color: '7c3aed', priority: null },
      { id: 12, title: 'Backend', color: '0891b2', priority: null },
      { id: 13, title: 'Mobil', color: 'd97706', priority: null },
    ],
    members: Object.values(people).map((p) => ({ uid: p.id, displayName: p.displayName })),
    permissions: { read: true, edit: true, manage: true, share: true },
  },
  tasks: [
    task(101, 1, 0, 'Giriş ekranı için yeni tasarım', { priority: 'high', labels: [11, 13], assignees: [people.ayse], dueDate: day(3), subtasks: { done: 1, total: 4 } }),
    task(102, 1, 1, 'Bildirim izinleri metinleri', { priority: 'low', labels: [13], dueDate: day(9) }),
    task(103, 1, 2, 'Talk arama API araştırması', { priority: 'normal', labels: [12], assignees: [people.can, people.mehmet] }),
    task(104, 2, 0, 'Kanban sürükle-bırak', { priority: 'urgent', labels: [13], assignees: [people.mehmet, people.zeynep, people.ayse, people.can], dueDate: day(-1), subtasks: { done: 3, total: 5 } }),
    task(105, 2, 1, 'Proje sayaçlarını yenile', { priority: 'normal', labels: [12], assignees: [people.zeynep], dueDate: day(0) }),
    task(106, 3, 0, 'Premium ikon seti (Lucide)', { priority: 'high', labels: [11], assignees: [people.ayse], subtasks: { done: 6, total: 6 } }),
    task(107, 4, 0, 'Login Flow v2', { assignees: [people.mehmet], done: day(-4), dueDate: day(-5), subtasks: { done: 2, total: 2 } }),
    task(108, 4, 1, 'Çoklu hesap desteği', { labels: [12], assignees: [people.can], done: day(-2) }),
  ],
};
const detail = (id: number): TaskDetail => {
  const t = board.tasks.find((x) => x.id === id)!;
  return { ...t, description: 'Web’deki Workhub ekranıyla aynı görünüm: sütunlar, kartlar, öncelik ve tarih rozetleri.', estimateSec: 5400, subtaskItems: [], predecessors: [], successors: [] };
};
const projects = [
  { id: 7, title: 'Dermo Mobil Uygulama', color: '0082c9', archived: false, edit: true, manage: true, share: true, openCount: 6, doneCount: 2, overdueCount: 1 },
  { id: 8, title: 'Pazarlama Q4', color: 'db2777', archived: false, edit: true, manage: false, openCount: 12, doneCount: 30, overdueCount: 0 },
  { id: 9, title: 'Altyapı', color: '059669', archived: false, edit: true, manage: false, openCount: 4, doneCount: 9, overdueCount: 2 },
];
const account = { id: 'acc1', serverBase: 'https://bulut.ornek.com.tr', loginName: 'ayse' };
const fixtures: Partial<Record<keyof Backend, (...a: any[]) => unknown>> = {
  listAccounts: () => [account],
  session: () => ({
    account, nextcloudVersion: '35.0.2', talkVersion: '25.0.6', talkFeatures: [], talkCanCreate: true, talkAttachmentsAllowed: true, issues: [], webPush: true,
    talkCall: callCapabilitiesOf(['audio', 'video', 'signaling-v3', 'call-notification-state-api'], { enabled: true }),
    workhub: { apiVersion: '1', user: { uid: 'ayse', displayName: 'Ayşe Yılmaz', isAdmin: false, timezone: 'Europe/Istanbul' }, modules: { projects: true, dashboard: true, ai: true, goals: true, requests: true, time: true }, permissions: { canViewTeamReport: true }, backend: 'native' },
  }),
  rooms: () => ({
    rooms: [
      { token: 'r1', type: 2, name: 'mobil', displayName: 'Mobil ekip', unreadMessages: 3, unreadMention: true, isFavorite: true, lastActivity: now / 1000 - 120, readOnly: 0, lastMessage: { id: 1, message: 'Kanban ekranı hazır mı?', actorDisplayName: 'Mehmet Demir' } },
      { token: 'r2', type: 1, name: 'zeynep', displayName: 'Zeynep Kaya', unreadMessages: 0, unreadMention: false, isFavorite: false, lastActivity: now / 1000 - 3600, readOnly: 0, lastMessage: { id: 2, message: 'Teşekkürler!', actorDisplayName: 'Zeynep Kaya' } },
    ],
    modifiedBefore: null, talkHash: null,
  }),
  projects: () => projects,
  board: () => structuredClone(board),
  openTask: (_a: string, id: number) => ({ state: 'ok', task: detail(id) }),
  comments: () => [{ id: 1, actorDisplayName: 'Mehmet Demir', createdAt: day(-1), message: 'Tasarım web ile aynı olsun.' }],
  moveTask: (_a: string, id: number, stackId: number, order: number) => {
    const t = board.tasks.find((x) => x.id === id)!;
    const ids = board.tasks.filter((x) => x.stackId === stackId && x.id !== id).sort((a, b) => a.order - b.order).map((x) => x.id);
    ids.splice(order, 0, id);
    t.stackId = stackId;
    ids.forEach((tid, i) => (board.tasks.find((x) => x.id === tid)!.order = i));
    return t;
  },
  updateTask: (_a: string, id: number, patch: { done?: boolean }) => {
    const t = board.tasks.find((x) => x.id === id)!;
    if (patch.done !== undefined) t.done = patch.done ? new Date().toISOString() : null;
    return t;
  },
  createTask: (_a: string, _b: number, stackId: number, title: string) => {
    const t = task(++seq, stackId, 99, title);
    board.tasks.push(t);
    return t;
  },
  notifications: () => [],
  // ---- calls: a second CallEngine in the page plays the remote participant (real WebRTC) ----
  talkRoom: (_a: string, token: string) => ({
    token, type: token === 'r2' ? 1 : 2, name: token, displayName: token === 'r2' ? 'Zeynep Kaya' : 'Mobil ekip', unreadMessages: 0, unreadMention: false, isFavorite: false,
    lastActivity: now / 1000, readOnly: 0, participantType: 1, permissions: 254, canStartCall: true, hasCall: token === 'r1', callFlag: token === 'r1' ? 7 : 0, lobbyState: 0,
  }),
  chat: async (_a: string, _t: string, req: { lookIntoFuture: boolean }) => {
    if (req.lookIntoFuture) await new Promise((r) => setTimeout(r, 30_000)); // long-poll: nothing new
    return { messages: [], lastGiven: null };
  },
  markRead: async () => undefined,
  participants: () => [{ attendeeId: 1, actorType: 'users', actorId: 'zeynep', displayName: 'Zeynep Kaya', participantType: 3 }],
  callRinging: () => true,
  callJoin: async () => {
    queue.length = 0;
    const stream = (await navigator.mediaDevices.getUserMedia({ audio: true, video: true })) as unknown as MediaStreamLike;
    remote = new CallEngine({
      selfSessionId: 'zz-remote', mode: 'mesh', iceServers: [], localStream: stream, onChange: () => undefined,
      createPeer: (c) => new RTCPeerConnection(c) as unknown as RtcPeerLike,
      send: async (_to, data) => void push({ type: 'message', from: 'zz-remote', data: JSON.parse(JSON.stringify(data)) }),
    });
    const users: SignalEvent = { type: 'participants', full: true, users: [{ sessionId: 'self', userId: 'ayse', inCall: 7 }, { sessionId: 'zz-remote', userId: 'zeynep', inCall: 7 }] };
    setTimeout(() => {
      push(users);
      void remote!.handle(users);
    }, 300);
    return { callId: 'call-preview-1', sessionId: 'self', mode: 'mesh', iceServers: [], flags: 7, gate: { available: true, reason: null, hasCall: true, canJoin: true, audio: true, video: true } };
  },
  callEvents: async (_id: string, timeout: number) => {
    if (!queue.length) await new Promise<void>((r) => { wake = r; setTimeout(r, Math.min(timeout, 1000)); });
    return queue.splice(0);
  },
  callSend: async (_id: string, _to: string, data: unknown) => {
    setTimeout(() => void remote?.handle({ type: 'message', from: 'self', data: JSON.parse(JSON.stringify(data)) }), 5);
  },
  callLeave: async () => {
    remote?.close();
    remote = null;
  },
  callMedia: async () => undefined,
  cancel: async () => undefined,
};
const queue: SignalEvent[] = [];
let wake: (() => void) | null = null;
let remote: CallEngine | null = null;
const push = (e: SignalEvent) => {
  queue.push(e);
  wake?.();
};
const routeListeners = new Set<(t: RoutedTarget) => void>();
(window as unknown as { previewRoute: (t: RoutedTarget) => void }).previewRoute = (t) => routeListeners.forEach((cb) => cb(t));
const backend = new Proxy({} as Backend, {
  get: (_t, name: string) => async (...args: unknown[]) => {
    const f = fixtures[name as keyof Backend];
    if (!f) throw Object.assign(new Error(`Önizlemede yok: ${name}`), { kind: 'client' });
    return f(...args);
  },
});
const call = createDesktopCallMedia(() => undefined);
const platform: PlatformServices = {
  kind: 'desktop', openExternal: async () => undefined, appVersion: 'preview', ...(call ? { call } : {}),
  subscribeRoutes: (cb) => {
    routeListeners.add(cb);
    return () => routeListeners.delete(cb);
  },
} as PlatformServices;
createRoot(document.getElementById('root')!).render(<WorkhubApp backend={backend} platform={platform} />);
