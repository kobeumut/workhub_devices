import { accountIdFor, addAccount, createAccountClient, logout as logoutAccount, scopedKey, type Account, type AccountId, type LogoutReport, type SecretStore } from './accounts';
import { checkCompatibility, fetchServerCapabilities, fetchWorkhubBootstrap, type CompatibilityIssue, type WorkhubBootstrap } from './capabilities';
import { pollLoginFlow, startLoginFlow, type LoginFlowStart } from './loginFlow';
import { OcsError, type FetchLike, type OcsClient } from './ocs';
import { dismissNotification, listNotifications, type InboxNotification } from './routing';
import { normalizeServerUrl, type NormalizeOptions, type ServerBase } from './serverUrl';
import { fetchChat, listRooms, markRead, sendMessage, type ChatFetchResult, type RoomListResult, type TalkMessage } from './talk';
import { openTaskFromNotification, workhubApi, type BoardPayload, type ProjectSummary, type Task, type TaskComment, type TaskOpenResult } from './workhub';

/**
 * The single domain API every UI talks to. It is implemented once here ("direct", used by the
 * mobile app and by the Electron MAIN process) and proxied over a narrow, validated IPC channel
 * in the desktop renderer — so the renderer never sees credentials or performs authenticated
 * fetches itself. All arguments and results are plain serializable data.
 */
export interface AccountSummary {
  id: AccountId;
  serverBase: ServerBase;
  loginName: string;
}

export interface SessionInfo {
  account: AccountSummary;
  nextcloudVersion: string | null;
  talkVersion: string | null;
  talkFeatures: string[];
  issues: CompatibilityIssue[];
  workhub: WorkhubBootstrap | null;
  /** Notifications Web Push available (`webpush` capability). */
  webPush: boolean;
}

export interface ChatRequest {
  lookIntoFuture: boolean;
  lastKnownMessageId?: number;
  limit?: number;
  timeout?: number;
  /** Lets the caller cancel a running long-poll with `cancel(pollId)`. */
  pollId?: string;
}

export interface TaskUpdate {
  title?: string;
  description?: string;
  done?: boolean;
  assignees?: string[];
  dueDate?: string | null;
  priority?: 'urgent' | 'high' | 'normal' | 'low' | null;
}

export interface Backend {
  listAccounts(): Promise<AccountSummary[]>;
  beginLogin(serverUrl: string): Promise<{ flowId: string; loginUrl: string }>;
  completeLogin(flowId: string): Promise<AccountSummary>;
  cancel(id: string): Promise<void>;
  logout(accountId: AccountId): Promise<LogoutReport>;
  session(accountId: AccountId): Promise<SessionInfo>;

  rooms(accountId: AccountId, modifiedSince?: number): Promise<RoomListResult>;
  chat(accountId: AccountId, token: string, req: ChatRequest): Promise<ChatFetchResult>;
  send(accountId: AccountId, token: string, message: string, referenceId: string, replyTo?: number): Promise<TalkMessage | null>;
  markRead(accountId: AccountId, token: string, lastReadMessage: number): Promise<void>;
  createOneToOne(accountId: AccountId, userId: string): Promise<{ token: string }>;

  notifications(accountId: AccountId): Promise<InboxNotification[]>;
  dismissNotification(accountId: AccountId, id: number): Promise<void>;

  projects(accountId: AccountId): Promise<ProjectSummary[]>;
  board(accountId: AccountId, boardId: number): Promise<BoardPayload>;
  openTask(accountId: AccountId, cardId: number): Promise<TaskOpenResult>;
  comments(accountId: AccountId, cardId: number): Promise<TaskComment[]>;
  addComment(accountId: AccountId, cardId: number, message: string, idempotencyKey: string): Promise<TaskComment | null>;
  updateTask(accountId: AccountId, cardId: number, patch: TaskUpdate): Promise<Task | null>;
  moveTask(accountId: AccountId, cardId: number, stackId: number, order: number): Promise<Task | null>;
  createTask(accountId: AccountId, boardId: number, stackId: number, title: string, idempotencyKey: string): Promise<Task | null>;
}

/** Non-secret persistent key/value storage (AsyncStorage / a JSON file in the Electron main). */
export interface PlainStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Remove every key starting with `prefix` (account wipe on logout). */
  deletePrefix(prefix: string): Promise<void>;
}

export interface DirectBackendDeps {
  secrets: SecretStore;
  plain: PlainStore;
  fetch?: FetchLike;
  userAgent?: string;
  urlOptions?: NormalizeOptions;
  /** Platform hook, e.g. web push unregister + local notification cleanup. */
  onLogout?: (account: Account, client: OcsClient) => Promise<boolean>;
}

const ACCOUNTS_KEY = 'accounts:v1';
let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function createDirectBackend(deps: DirectBackendDeps): Backend {
  const flows = new Map<string, { serverBase: ServerBase; start: LoginFlowStart; abort: AbortController }>();
  const polls = new Map<string, AbortController>();
  const clients = new Map<AccountId, OcsClient>();
  const clientOpts = { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.userAgent ? { userAgent: deps.userAgent } : {}) };

  const readAccounts = async (): Promise<Account[]> => {
    const raw = await deps.plain.get(ACCOUNTS_KEY);
    if (!raw) return [];
    try {
      const list = JSON.parse(raw) as Account[];
      return Array.isArray(list) ? list.filter((a) => a && typeof a.id === 'string') : [];
    } catch {
      return [];
    }
  };
  const writeAccounts = (list: Account[]) => deps.plain.set(ACCOUNTS_KEY, JSON.stringify(list));
  const account = async (id: AccountId): Promise<Account> => {
    const a = (await readAccounts()).find((x) => x.id === id);
    if (!a) throw new OcsError('unauthorized', undefined, 'unknown account');
    return a;
  };
  const client = async (id: AccountId): Promise<OcsClient> => {
    let c = clients.get(id);
    if (!c) {
      c = createAccountClient(await account(id), deps.secrets, clientOpts);
      clients.set(id, c);
    }
    return c;
  };
  const summary = (a: Account): AccountSummary => ({ id: a.id, serverBase: a.serverBase, loginName: a.loginName });

  return {
    async listAccounts() {
      return (await readAccounts()).map(summary);
    },

    async beginLogin(serverUrl) {
      const serverBase = normalizeServerUrl(serverUrl, deps.urlOptions);
      const start = await startLoginFlow(serverBase, { ...clientOpts, ...(deps.urlOptions ? { urlOptions: deps.urlOptions } : {}) });
      const flowId = newId('login');
      flows.set(flowId, { serverBase, start, abort: new AbortController() });
      return { flowId, loginUrl: start.loginUrl };
    },

    async completeLogin(flowId) {
      const flow = flows.get(flowId);
      if (!flow) throw new OcsError('client', undefined, 'unknown login flow');
      try {
        const result = await pollLoginFlow(flow.serverBase, flow.start, {
          signal: flow.abort.signal,
          ...clientOpts,
          ...(deps.urlOptions ? { urlOptions: deps.urlOptions } : {}),
        });
        const acc = await addAccount(deps.secrets, result);
        const list = (await readAccounts()).filter((a) => a.id !== acc.id);
        await writeAccounts([...list, acc]);
        clients.delete(acc.id);
        return summary(acc);
      } finally {
        flows.delete(flowId);
      }
    },

    async cancel(id) {
      flows.get(id)?.abort.abort();
      polls.get(id)?.abort();
    },

    async logout(accountId) {
      const acc = await account(accountId);
      const c = await client(accountId);
      const report = await logoutAccount(acc, deps.secrets, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.onLogout ? { deregisterPush: (a: Account) => deps.onLogout!(a, c) } : {}),
        wipeLocalData: (id) => deps.plain.deletePrefix(scopedKey(id)),
      });
      clients.delete(accountId);
      await writeAccounts((await readAccounts()).filter((a) => a.id !== accountId));
      return report;
    },

    async session(accountId) {
      const c = await client(accountId);
      const caps = await fetchServerCapabilities(c);
      let workhub: WorkhubBootstrap | null = null;
      if (caps.workhub.installed) {
        try {
          workhub = await fetchWorkhubBootstrap(c);
        } catch (e) {
          if (!(e instanceof OcsError) || (e.kind !== 'forbidden' && e.kind !== 'not_found')) throw e;
        }
      }
      return {
        account: summary(await account(accountId)),
        nextcloudVersion: caps.nextcloudVersion,
        talkVersion: caps.talk.version,
        talkFeatures: [...caps.talk.features],
        issues: checkCompatibility(caps),
        workhub,
        webPush: caps.notifications.push.has('webpush'),
      };
    },

    async rooms(accountId, modifiedSince) {
      return listRooms(await client(accountId), modifiedSince ? { modifiedSince } : {});
    },

    async chat(accountId, token, req) {
      const c = await client(accountId);
      const abort = new AbortController();
      if (req.pollId) polls.set(req.pollId, abort);
      try {
        return await fetchChat(c, token, {
          lookIntoFuture: req.lookIntoFuture,
          ...(req.lastKnownMessageId ? { lastKnownMessageId: req.lastKnownMessageId } : {}),
          ...(req.limit ? { limit: req.limit } : {}),
          ...(req.timeout ? { timeout: req.timeout } : {}),
          setReadMarker: false,
          signal: abort.signal,
        });
      } finally {
        if (req.pollId) polls.delete(req.pollId);
      }
    },

    async send(accountId, token, message, referenceId, replyTo) {
      if (!message.trim()) throw new OcsError('client', undefined, 'empty message');
      return sendMessage(await client(accountId), token, { message, referenceId, ...(replyTo ? { replyTo } : {}) });
    },

    async markRead(accountId, token, lastReadMessage) {
      await markRead(await client(accountId), token, lastReadMessage);
    },

    async createOneToOne(accountId, userId) {
      const r = await (await client(accountId)).request<{ token: string }>('/ocs/v2.php/apps/spreed/api/v4/room', {
        method: 'POST',
        body: { roomType: 1, invite: userId },
      });
      if (!r.data?.token) throw new OcsError('invalid_response');
      return { token: r.data.token };
    },

    async notifications(accountId) {
      return (await listNotifications(await client(accountId))).items ?? [];
    },

    async dismissNotification(accountId, id) {
      await dismissNotification(await client(accountId), id);
    },

    async projects(accountId) {
      return workhubApi.projects(await client(accountId));
    },
    async board(accountId, boardId) {
      return workhubApi.board(await client(accountId), boardId);
    },
    async openTask(accountId, cardId) {
      const c = await client(accountId);
      let projectsEnabled = true;
      try {
        projectsEnabled = (await fetchWorkhubBootstrap(c)).modules.projects;
      } catch {
        projectsEnabled = true; // let the task request itself decide (403 → feature_off/forbidden)
      }
      return openTaskFromNotification(c, cardId, projectsEnabled);
    },
    async comments(accountId, cardId) {
      return workhubApi.comments(await client(accountId), cardId);
    },
    async addComment(accountId, cardId, message, idempotencyKey) {
      return workhubApi.addComment(await client(accountId), cardId, message, idempotencyKey);
    },
    async updateTask(accountId, cardId, patch) {
      return workhubApi.updateTask(await client(accountId), cardId, patch);
    },
    async moveTask(accountId, cardId, stackId, order) {
      return workhubApi.moveTask(await client(accountId), cardId, stackId, order);
    },
    async createTask(accountId, boardId, stackId, title, idempotencyKey) {
      if (!Number.isInteger(boardId) || boardId <= 0) throw new OcsError('client', undefined, 'invalid id');
      const r = await (await client(accountId)).request<Task>(`/ocs/v2.php/apps/workhub/api/v1/projects/${boardId}/tasks`, {
        method: 'POST',
        body: { stackId, title },
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      return r.data;
    },
  };
}

// ---- IPC transport helpers (desktop) -------------------------------------------

/** Every Backend method name; the Electron main rejects anything else. */
export const BACKEND_METHODS = [
  'listAccounts', 'beginLogin', 'completeLogin', 'cancel', 'logout', 'session',
  'rooms', 'chat', 'send', 'markRead', 'createOneToOne',
  'notifications', 'dismissNotification',
  'projects', 'board', 'openTask', 'comments', 'addComment', 'updateTask', 'moveTask', 'createTask',
] as const satisfies ReadonlyArray<keyof Backend>;
export type BackendMethod = (typeof BACKEND_METHODS)[number];

export type WireResult = { ok: true; value: unknown } | { ok: false; error: { kind: string; status?: number; message?: string; errorCode?: string } };

const isAccountId = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length < 2048;
const isStr = (max: number) => (v: unknown) => typeof v === 'string' && v.length <= max;
const isInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
const isOptInt = (v: unknown) => v === undefined || isInt(v);
const isObj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Argument shape validation for untrusted IPC input. */
const VALIDATORS: Record<BackendMethod, (a: unknown[]) => boolean> = {
  listAccounts: (a) => a.length === 0,
  beginLogin: (a) => a.length === 1 && isStr(2048)(a[0]),
  completeLogin: (a) => a.length === 1 && isStr(128)(a[0]),
  cancel: (a) => a.length === 1 && isStr(128)(a[0]),
  logout: (a) => a.length === 1 && isAccountId(a[0]),
  session: (a) => a.length === 1 && isAccountId(a[0]),
  rooms: (a) => (a.length === 1 || a.length === 2) && isAccountId(a[0]) && isOptInt(a[1]),
  chat: (a) => a.length === 3 && isAccountId(a[0]) && isStr(64)(a[1]) && isObj(a[2]),
  send: (a) => (a.length === 4 || a.length === 5) && isAccountId(a[0]) && isStr(64)(a[1]) && isStr(32000)(a[2]) && isStr(128)(a[3]) && isOptInt(a[4]),
  markRead: (a) => a.length === 3 && isAccountId(a[0]) && isStr(64)(a[1]) && isInt(a[2]),
  createOneToOne: (a) => a.length === 2 && isAccountId(a[0]) && isStr(256)(a[1]),
  notifications: (a) => a.length === 1 && isAccountId(a[0]),
  dismissNotification: (a) => a.length === 2 && isAccountId(a[0]) && isInt(a[1]),
  projects: (a) => a.length === 1 && isAccountId(a[0]),
  board: (a) => a.length === 2 && isAccountId(a[0]) && isInt(a[1]),
  openTask: (a) => a.length === 2 && isAccountId(a[0]) && isInt(a[1]),
  comments: (a) => a.length === 2 && isAccountId(a[0]) && isInt(a[1]),
  addComment: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isStr(10000)(a[2]) && isStr(128)(a[3]),
  updateTask: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isObj(a[2]),
  moveTask: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && Number.isInteger(a[3]),
  createTask: (a) => a.length === 5 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && isStr(255)(a[3]) && isStr(128)(a[4]),
};

/** Main-process side: validate + dispatch + serialize errors. */
export async function dispatchWire(backend: Backend, method: unknown, args: unknown): Promise<WireResult> {
  if (typeof method !== 'string' || !(BACKEND_METHODS as readonly string[]).includes(method) || !Array.isArray(args)) {
    return { ok: false, error: { kind: 'client', message: 'rejected' } };
  }
  const m = method as BackendMethod;
  if (!VALIDATORS[m](args)) return { ok: false, error: { kind: 'client', message: 'invalid arguments' } };
  try {
    const value = await (backend[m] as (...x: unknown[]) => Promise<unknown>)(...args);
    return { ok: true, value };
  } catch (e) {
    if (e instanceof OcsError) {
      return { ok: false, error: { kind: e.kind, ...(e.status ? { status: e.status } : {}), ...(e.ocsMessage ? { message: e.ocsMessage } : {}), ...(e.errorCode ? { errorCode: e.errorCode } : {}) } };
    }
    // Never forward raw exception text (could contain URLs/tokens); give a category only.
    const name = e instanceof Error ? e.name : 'Error';
    return { ok: false, error: { kind: name === 'LoginFlowError' ? `login:${(e as { code?: string }).code ?? 'failed'}` : name === 'ServerUrlError' ? `url:${(e as { code?: string }).code ?? 'invalid'}` : 'internal' } };
  }
}

/** Renderer side: a Backend whose calls go through `invoke`. */
export function createWireBackend(invoke: (method: BackendMethod, args: unknown[]) => Promise<WireResult>): Backend {
  const call = async (method: BackendMethod, args: unknown[]) => {
    const r = await invoke(method, args);
    if (r.ok) return r.value;
    throw new OcsError(r.error.kind as never, r.error.status, r.error.message, undefined, r.error.errorCode);
  };
  return Object.fromEntries(BACKEND_METHODS.map((m) => [m, (...args: unknown[]) => call(m, args)])) as unknown as Backend;
}

export { accountIdFor };
