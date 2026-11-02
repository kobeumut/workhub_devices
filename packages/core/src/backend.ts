import { accountIdFor, addAccount, createAccountClient, logout as logoutAccount, scopedKey, type Account, type AccountId, type LogoutReport, type SecretStore } from './accounts';
import { checkCompatibility, fetchServerCapabilities, fetchWorkhubBootstrap, type CompatibilityIssue, type WorkhubBootstrap } from './capabilities';
import { pollLoginFlow, startLoginFlow, type LoginFlowStart } from './loginFlow';
import { OcsError, type FetchLike, type OcsClient } from './ocs';
import { dismissNotification, listNotifications, type InboxNotification } from './routing';
import { normalizeServerUrl, type NormalizeOptions, type ServerBase } from './serverUrl';
import { fetchChat, listRooms, markRead, sendMessage, type ChatFetchResult, type RoomListResult, type TalkMessage } from './talk';
import {
  openTaskFromNotification, requestsApi, timeApi, workhubApi, workhubModulesApi, REPORT_STATES,
  SHARE_OBJECT_TYPES, SHARE_ROLES,
  type CsvScope, type RequestDecision, type RequestEvent, type RequestPage, type RequestReport, type RequestReportFilters, type ReviewAction, type ReviewItem, type SubmissionResult, type TeamReport, type TimeEntryInput, type TimeEntryPatch, type TimeEntryResult,
  type BoardPayload, type GoalSummary, type MemberGrant, type ObjectShare, type ObjectShares, type Principal, type ShareObjectType, type StackSummary, type SubtaskList, type TaskPatch, type ProjectSummary, type RequestContext, type Task, type TaskComment, type TaskOpenResult, type TimeEntry, type Timer, type TimeWeek, type WorkRequest,
} from './workhub';

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

export type TaskUpdate = TaskPatch;

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
  addSubtask(accountId: AccountId, cardId: number, text: string): Promise<SubtaskList | null>;
  updateSubtask(accountId: AccountId, cardId: number, index: number, expectedText: string, change: { text?: string; done?: boolean }): Promise<SubtaskList | null>;
  deleteSubtask(accountId: AccountId, cardId: number, index: number, expectedText: string): Promise<SubtaskList | null>;
  addDependency(accountId: AccountId, predecessorId: number, successorId: number): Promise<{ id: number } | null>;
  removeDependency(accountId: AccountId, cardId: number, dependencyId: number): Promise<void>;

  createProject(accountId: AccountId, title: string, color: string | null, idempotencyKey: string): Promise<{ id: number; title: string } | null>;
  renameProject(accountId: AccountId, boardId: number, title: string): Promise<{ id: number; title: string } | null>;
  addProjectMember(accountId: AccountId, boardId: number, grant: MemberGrant, idempotencyKey: string): Promise<{ id: number } | null>;
  createStack(accountId: AccountId, boardId: number, title: string, order: number): Promise<StackSummary | null>;
  renameStack(accountId: AccountId, stackId: number, title: string): Promise<{ id: number; title: string } | null>;
  principals(accountId: AccountId, query: string): Promise<Principal[]>;
  objectShares(accountId: AccountId, type: ShareObjectType, objectId: number): Promise<ObjectShares>;
  setObjectShares(accountId: AccountId, type: ShareObjectType, objectId: number, shares: Array<Pick<ObjectShare, 'principalType' | 'principalId' | 'role'>>): Promise<{ shares: ObjectShare[] } | null>;

  timer(accountId: AccountId): Promise<{ timer: Timer | null; serverTime: string }>;
  timerStart(accountId: AccountId, cardId: number | null, description: string, idempotencyKey: string): Promise<{ timer: Timer } | null>;
  timerStop(accountId: AccountId): Promise<{ entries: TimeEntry[]; totalSec: number } | null>;
  timeWeek(accountId: AccountId, date?: string): Promise<TimeWeek>;
  timeEntryCreate(accountId: AccountId, input: TimeEntryInput, idempotencyKey: string): Promise<TimeEntryResult | null>;
  /** Range ↔ duration conversion is refused by the server (`KIND_IMMUTABLE`). */
  timeEntryUpdate(accountId: AccountId, entryId: number, patch: TimeEntryPatch): Promise<TimeEntryResult | null>;
  timeEntryDelete(accountId: AccountId, entryId: number, version: number): Promise<void>;
  timeSubmit(accountId: AccountId, periodId: number, periodVersion: number, idempotencyKey: string): Promise<SubmissionResult | null>;
  timeWithdraw(accountId: AccountId, submissionId: number, periodVersion: number, idempotencyKey: string): Promise<SubmissionResult | null>;
  /** Reviewer only (`permissions.canViewTeamReport`); fails closed with 403 otherwise. */
  timeReviews(accountId: AccountId, status: 'pending' | 'approved'): Promise<ReviewItem[]>;
  timeDecide(accountId: AccountId, submissionId: number, action: ReviewAction, periodVersion: number, reason: string | null, idempotencyKey: string): Promise<SubmissionResult | null>;
  timeTeam(accountId: AccountId, from: string, to: string): Promise<TeamReport>;
  /** CSV text from the server; the shell saves it (desktop dialog / mobile share sheet). */
  timeCsv(accountId: AccountId, scope: CsvScope, from: string, to: string): Promise<{ filename: string; csv: string }>;
  requests(accountId: AccountId, scope: 'mine' | 'received' | 'team'): Promise<WorkRequest[]>;
  requestContext(accountId: AccountId): Promise<RequestContext>;
  createRequest(accountId: AccountId, title: string, description: string, recipientUid: string | null, idempotencyKey: string): Promise<{ id: number } | null>;
  /** Detail incl. the linked task (re-reconciled by the server). */
  requestDetail(accountId: AccountId, requestId: number): Promise<WorkRequest>;
  requestHistory(accountId: AccountId, requestId: number, before: number | null): Promise<RequestPage<RequestEvent>>;
  /** Recipient of a pending request only (server: 404 otherwise); `reason` required for reject. */
  requestRespond(accountId: AccountId, requestId: number, version: number, decision: RequestDecision, reason: string | null, idempotencyKey: string): Promise<WorkRequest | null>;
  /** Manager only (gate: `requestContext.isManager`, fail closed); the server re-checks the chain. */
  requestResolve(accountId: AccountId, requestId: number, version: number, reason: string, idempotencyKey: string): Promise<WorkRequest | null>;
  requestConvert(accountId: AccountId, requestId: number, version: number, boardId: number, stackId: number, idempotencyKey: string): Promise<WorkRequest | null>;
  requestReport(accountId: AccountId, filters: RequestReportFilters): Promise<RequestReport>;
  goals(accountId: AccountId): Promise<GoalSummary[]>;
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

  /** Per-user Workhub bootstrap, cached briefly so gated calls don't double every request. */
  const bootstraps = new Map<AccountId, { at: number; value: WorkhubBootstrap }>();
  const bootstrap = async (id: AccountId, c: OcsClient) => {
    const hit = bootstraps.get(id);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const value = await fetchWorkhubBootstrap(c);
    bootstraps.set(id, { at: Date.now(), value });
    return value;
  };
  /**
   * Time module gate (fail closed): the module must be on for this user, and reviewer-only calls
   * need `permissions.canViewTeamReport` (native direct management). The server re-checks both.
   */
  const timeClient = async (id: AccountId, reviewer = false): Promise<OcsClient> => {
    const c = await client(id);
    const b = await bootstrap(id, c);
    if (!b.modules.time) throw new OcsError('forbidden', 403, undefined, undefined, 'TIME_DISABLED');
    if (reviewer && !b.permissions.canViewTeamReport) throw new OcsError('forbidden', 403, undefined, undefined, 'TEAM_REPORT_FORBIDDEN');
    return c;
  };

  /** Request context (manager flag), cached like the bootstrap. */
  const requestContexts = new Map<AccountId, { at: number; value: RequestContext }>();
  /**
   * Requests gate (fail closed): the module must be on for this user; resolve/convert need a
   * management relation (`isManager`). The server re-checks the actual chain per request.
   */
  const requestClient = async (id: AccountId, manager = false): Promise<OcsClient> => {
    const c = await client(id);
    const b = await bootstrap(id, c);
    if (!b.modules.requests) throw new OcsError('forbidden', 403, undefined, undefined, 'REQUESTS_DISABLED');
    if (manager) {
      const hit = requestContexts.get(id);
      const ctx = hit && Date.now() - hit.at < 30_000 ? hit.value : await workhubModulesApi.requestContext(c);
      requestContexts.set(id, { at: hit && hit.value === ctx ? hit.at : Date.now(), value: ctx });
      if (!ctx.isManager) throw new OcsError('forbidden', 403, undefined, undefined, 'REQUEST_MANAGER_REQUIRED');
    }
    return c;
  };

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
      bootstraps.delete(accountId);
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
    async addSubtask(accountId, cardId, text) {
      return workhubApi.addSubtask(await client(accountId), cardId, text);
    },
    async updateSubtask(accountId, cardId, index, expectedText, change) {
      return workhubApi.updateSubtask(await client(accountId), cardId, index, expectedText, change);
    },
    async deleteSubtask(accountId, cardId, index, expectedText) {
      return workhubApi.deleteSubtask(await client(accountId), cardId, index, expectedText);
    },
    async addDependency(accountId, predecessorId, successorId) {
      return workhubApi.addDependency(await client(accountId), predecessorId, successorId);
    },
    async removeDependency(accountId, cardId, dependencyId) {
      await workhubApi.removeDependency(await client(accountId), cardId, dependencyId);
    },
    async createProject(accountId, title, color, idempotencyKey) {
      return workhubApi.createProject(await client(accountId), title, color ?? undefined, idempotencyKey);
    },
    async renameProject(accountId, boardId, title) {
      return workhubApi.renameProject(await client(accountId), boardId, title);
    },
    async addProjectMember(accountId, boardId, grant, idempotencyKey) {
      return workhubApi.addProjectMember(await client(accountId), boardId, grant, idempotencyKey);
    },
    async createStack(accountId, boardId, title, order) {
      return workhubApi.createStack(await client(accountId), boardId, title, order);
    },
    async renameStack(accountId, stackId, title) {
      return workhubApi.renameStack(await client(accountId), stackId, title);
    },
    async principals(accountId, query) {
      return workhubApi.principals(await client(accountId), query);
    },
    async objectShares(accountId, type, objectId) {
      return workhubApi.objectShares(await client(accountId), type, objectId);
    },
    async setObjectShares(accountId, type, objectId, shares) {
      return workhubApi.setObjectShares(await client(accountId), type, objectId, shares);
    },

    async timer(accountId) {
      return workhubModulesApi.timer(await client(accountId));
    },
    async timerStart(accountId, cardId, description, idempotencyKey) {
      return workhubModulesApi.timerStart(await client(accountId), { ...(cardId ? { cardId } : {}), ...(description ? { description } : {}) }, idempotencyKey);
    },
    async timerStop(accountId) {
      return workhubModulesApi.timerStop(await client(accountId));
    },
    async timeWeek(accountId, date) {
      return timeApi.week(await timeClient(accountId), date);
    },
    async timeEntryCreate(accountId, input, idempotencyKey) {
      return timeApi.createEntry(await timeClient(accountId), input, idempotencyKey);
    },
    async timeEntryUpdate(accountId, entryId, patch) {
      return timeApi.updateEntry(await timeClient(accountId), entryId, patch);
    },
    async timeEntryDelete(accountId, entryId, version) {
      await timeApi.deleteEntry(await timeClient(accountId), entryId, version);
    },
    async timeSubmit(accountId, periodId, periodVersion, idempotencyKey) {
      return timeApi.submit(await timeClient(accountId), periodId, periodVersion, idempotencyKey);
    },
    async timeWithdraw(accountId, submissionId, periodVersion, idempotencyKey) {
      return timeApi.withdraw(await timeClient(accountId), submissionId, periodVersion, idempotencyKey);
    },
    async timeReviews(accountId, status) {
      return timeApi.reviews(await timeClient(accountId, true), status);
    },
    async timeDecide(accountId, submissionId, action, periodVersion, reason, idempotencyKey) {
      if (action !== 'approve' && !reason?.trim()) throw new OcsError('client', 422, undefined, undefined, 'REASON_REQUIRED');
      return timeApi.decide(await timeClient(accountId, true), submissionId, action, periodVersion, reason?.trim() || null, idempotencyKey);
    },
    async timeTeam(accountId, from, to) {
      return timeApi.team(await timeClient(accountId, true), from, to);
    },
    async timeCsv(accountId, scope, from, to) {
      return timeApi.csv(await timeClient(accountId, scope === 'team'), scope, from, to);
    },
    async requests(accountId, scope) {
      return workhubModulesApi.requests(await requestClient(accountId), scope);
    },
    async requestContext(accountId) {
      const c = await requestClient(accountId);
      const value = await workhubModulesApi.requestContext(c);
      requestContexts.set(accountId, { at: Date.now(), value });
      return value;
    },
    async createRequest(accountId, title, description, recipientUid, idempotencyKey) {
      return workhubModulesApi.createRequest(await requestClient(accountId), { title, description, ...(recipientUid ? { recipientUid } : {}) }, idempotencyKey);
    },
    async requestDetail(accountId, requestId) {
      return requestsApi.get(await requestClient(accountId), requestId);
    },
    async requestHistory(accountId, requestId, before) {
      return requestsApi.history(await requestClient(accountId), requestId, before ?? undefined);
    },
    async requestRespond(accountId, requestId, version, decision, reason, idempotencyKey) {
      const r = reason?.trim() || null;
      if (decision === 'reject' && !r) throw new OcsError('client', undefined, 'reason required', undefined, 'REASON_REQUIRED');
      return requestsApi.respond(await requestClient(accountId), requestId, version, decision, r, idempotencyKey);
    },
    async requestResolve(accountId, requestId, version, reason, idempotencyKey) {
      const r = reason.trim();
      if (!r) throw new OcsError('client', undefined, 'reason required', undefined, 'REASON_REQUIRED');
      return requestsApi.resolve(await requestClient(accountId, true), requestId, version, r, idempotencyKey);
    },
    async requestConvert(accountId, requestId, version, boardId, stackId, idempotencyKey) {
      return requestsApi.convert(await requestClient(accountId, true), requestId, version, boardId, stackId, idempotencyKey);
    },
    async requestReport(accountId, filters) {
      return requestsApi.report(await requestClient(accountId), filters);
    },
    async goals(accountId) {
      return workhubModulesApi.goals(await client(accountId));
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
  'addSubtask', 'updateSubtask', 'deleteSubtask', 'addDependency', 'removeDependency',
  'createProject', 'renameProject', 'addProjectMember', 'createStack', 'renameStack', 'principals', 'objectShares', 'setObjectShares',
  'timer', 'timerStart', 'timerStop', 'timeWeek',
  'timeEntryCreate', 'timeEntryUpdate', 'timeEntryDelete', 'timeSubmit', 'timeWithdraw', 'timeReviews', 'timeDecide', 'timeTeam', 'timeCsv',
  'requests', 'requestContext', 'createRequest', 'requestDetail', 'requestHistory', 'requestRespond', 'requestResolve', 'requestConvert', 'requestReport', 'goals',
] as const satisfies ReadonlyArray<keyof Backend>;
export type BackendMethod = (typeof BACKEND_METHODS)[number];

export type WireResult = { ok: true; value: unknown } | { ok: false; error: { kind: string; status?: number; message?: string; errorCode?: string } };

const isAccountId = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length < 2048;
const isStr = (max: number) => (v: unknown) => typeof v === 'string' && v.length <= max;
const isInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
const isOptInt = (v: unknown) => v === undefined || isInt(v);
const isObj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
const isIndex = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 10000;
const isDateOrNull = (v: unknown) => v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(v));
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];

/** Task PATCH: only known fields with the right types; anything else is rejected, not forwarded. */
const TASK_PATCH: Record<keyof TaskPatch, (v: unknown) => boolean> = {
  title: (v) => isStr(255)(v) && (v as string).trim().length > 0,
  description: isStr(100000),
  done: (v) => typeof v === 'boolean',
  assignees: (v) => Array.isArray(v) && v.length <= 50 && v.every((x) => isStr(64)(x) && (x as string).length > 0),
  labels: (v) => Array.isArray(v) && v.length <= 50 && v.every(isInt),
  startDate: isDateOrNull,
  dueDate: isDateOrNull,
  estimateSec: (v) => v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000 * 3600),
  priority: (v) => v === null || PRIORITIES.includes(v as string),
};
export const isValidTaskPatch = (v: unknown): v is TaskPatch => {
  if (!isObj(v)) return false;
  const entries = Object.entries(v as object);
  return entries.length > 0 && entries.every(([k, x]) => Object.hasOwn(TASK_PATCH, k) && TASK_PATCH[k as keyof TaskPatch](x));
};
const isSubtaskChange = (v: unknown) => {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  return keys.length > 0 && keys.every((k) => k === 'text' || k === 'done') && (o.text === undefined || isStr(1000)(o.text)) && (o.done === undefined || typeof o.done === 'boolean');
};

const isTitle = (max: number) => (v: unknown) => isStr(max)(v) && (v as string).trim().length > 0;
const isKey = (v: unknown) => typeof v === 'string' && /^[0-9a-fA-F-]{8,64}$/.test(v);
const isPrincipalId = (v: unknown) => isStr(64)(v) && (v as string).length > 0;
const isPrincipalType = (v: unknown) => v === 'user' || v === 'group';
const hasOnly = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k)) && keys.every((k) => Object.hasOwn(o, k));
export const isValidMemberGrant = (v: unknown): v is MemberGrant => {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  return hasOnly(o, ['type', 'participant', 'edit', 'share', 'manage']) && isPrincipalType(o.type) && isPrincipalId(o.participant)
    && typeof o.edit === 'boolean' && typeof o.share === 'boolean' && typeof o.manage === 'boolean';
};
export const isValidShareList = (v: unknown): boolean =>
  Array.isArray(v) && v.length <= 100 && v.every((x) => {
    if (!isObj(x)) return false;
    const o = x as Record<string, unknown>;
    return hasOnly(o, ['principalType', 'principalId', 'role']) && isPrincipalType(o.principalType) && isPrincipalId(o.principalId) && (SHARE_ROLES as readonly unknown[]).includes(o.role);
  });
const isShareType = (v: unknown) => (SHARE_OBJECT_TYPES as readonly unknown[]).includes(v);

// ---- Time entry wire validation: exact field sets, server formats, no unknown keys ----
const isIsoUtc = (v: unknown) => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/.test(v);
const isDay = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isZone = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_+\-/]+$/.test(v);
const isSeconds = (v: unknown) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 7 * 86400;
const isVersion = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 2 ** 31;
const ENTRY_COMMON: Record<string, (v: unknown) => boolean> = {
  timezone: isZone,
  description: (v) => v === null || isStr(1000)(v),
  billable: (v) => typeof v === 'boolean',
  cardId: (v) => v === null || isInt(v),
};
const ENTRY_RANGE = { ...ENTRY_COMMON, kind: (v: unknown) => v === 'range', startUtc: isIsoUtc, endUtc: isIsoUtc };
const ENTRY_DURATION = { ...ENTRY_COMMON, kind: (v: unknown) => v === 'duration', localDate: isDay, durationSeconds: isSeconds };
const fieldsOk = (o: Record<string, unknown>, spec: Record<string, (v: unknown) => boolean>, required: string[]) =>
  Object.entries(o).every(([k, x]) => Object.hasOwn(spec, k) && spec[k]!(x)) && required.every((k) => Object.hasOwn(o, k));
export const isValidTimeEntryInput = (v: unknown): v is TimeEntryInput => {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.kind === 'range') return fieldsOk(o, ENTRY_RANGE, ['kind', 'startUtc', 'endUtc', 'timezone']);
  if (o.kind === 'duration') return fieldsOk(o, ENTRY_DURATION, ['kind', 'localDate', 'durationSeconds', 'timezone']);
  return false;
};
const ENTRY_PATCH: Record<string, (v: unknown) => boolean> = { ...ENTRY_COMMON, version: isVersion, startUtc: isIsoUtc, endUtc: isIsoUtc, localDate: isDay, durationSeconds: isSeconds };
export const isValidTimeEntryPatch = (v: unknown): v is TimeEntryPatch => {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  return fieldsOk(o, ENTRY_PATCH, ['version']) && !((o.startUtc !== undefined || o.endUtc !== undefined) && (o.localDate !== undefined || o.durationSeconds !== undefined));
};
const isDayRange = (from: unknown, to: unknown, maxDays: number) =>
  isDay(from) && isDay(to) && (from as string) <= (to as string) && (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 < maxDays;

export const isValidReportFilters = (v: unknown): v is RequestReportFilters => {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  return hasOnly(o, ['scope', 'type', 'state', 'from', 'to']) && ['all', 'mine', 'received', 'team'].includes(o.scope as string)
    && ['all', 'request', 'timesheet'].includes(o.type as string) && (REPORT_STATES as readonly unknown[]).includes(o.state) && isDayRange(o.from, o.to, 366);
};

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
  updateTask: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isValidTaskPatch(a[2]),
  moveTask: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && Number.isInteger(a[3]),
  createTask: (a) => a.length === 5 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && isStr(255)(a[3]) && isStr(128)(a[4]),
  addSubtask: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isStr(1000)(a[2]),
  updateSubtask: (a) => a.length === 5 && isAccountId(a[0]) && isInt(a[1]) && isIndex(a[2]) && isStr(4000)(a[3]) && isSubtaskChange(a[4]),
  deleteSubtask: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isIndex(a[2]) && isStr(4000)(a[3]),
  addDependency: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && a[1] !== a[2],
  removeDependency: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]),
  createProject: (a) => a.length === 4 && isAccountId(a[0]) && isTitle(255)(a[1]) && (a[2] === null || (typeof a[2] === 'string' && /^#?[0-9a-fA-F]{6}$/.test(a[2]))) && isKey(a[3]),
  renameProject: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isTitle(100)(a[2]),
  addProjectMember: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isValidMemberGrant(a[2]) && isKey(a[3]),
  createStack: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isTitle(255)(a[2]) && isIndex(a[3]),
  renameStack: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isTitle(100)(a[2]),
  principals: (a) => a.length === 2 && isAccountId(a[0]) && isStr(64)(a[1]),
  objectShares: (a) => a.length === 3 && isAccountId(a[0]) && isShareType(a[1]) && isInt(a[2]),
  setObjectShares: (a) => a.length === 4 && isAccountId(a[0]) && isShareType(a[1]) && isInt(a[2]) && isValidShareList(a[3]),
  timer: (a) => a.length === 1 && isAccountId(a[0]),
  timerStart: (a) => a.length === 4 && isAccountId(a[0]) && (a[1] === null || isInt(a[1])) && isStr(1000)(a[2]) && isStr(128)(a[3]),
  timerStop: (a) => a.length === 1 && isAccountId(a[0]),
  timeWeek: (a) => (a.length === 1 || a.length === 2) && isAccountId(a[0]) && (a[1] === undefined || (typeof a[1] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a[1]))),
  timeEntryCreate: (a) => a.length === 3 && isAccountId(a[0]) && isValidTimeEntryInput(a[1]) && isKey(a[2]),
  timeEntryUpdate: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isValidTimeEntryPatch(a[2]),
  timeEntryDelete: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isVersion(a[2]),
  timeSubmit: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isVersion(a[2]) && isKey(a[3]),
  timeWithdraw: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isVersion(a[2]) && isKey(a[3]),
  timeReviews: (a) => a.length === 2 && isAccountId(a[0]) && (a[1] === 'pending' || a[1] === 'approved'),
  timeDecide: (a) => a.length === 6 && isAccountId(a[0]) && isInt(a[1]) && ['approve', 'request_changes', 'reopen'].includes(a[2] as string) && isVersion(a[3])
    && (a[4] === null || isStr(2000)(a[4])) && (a[2] === 'approve' || (typeof a[4] === 'string' && a[4].trim().length > 0)) && isKey(a[5]),
  timeTeam: (a) => a.length === 3 && isAccountId(a[0]) && isDayRange(a[1], a[2], 93),
  timeCsv: (a) => a.length === 4 && isAccountId(a[0]) && (a[1] === 'own' || a[1] === 'team') && isDayRange(a[2], a[3], 366),
  requests: (a) => a.length === 2 && isAccountId(a[0]) && ['mine', 'received', 'team'].includes(a[1] as string),
  requestContext: (a) => a.length === 1 && isAccountId(a[0]),
  createRequest: (a) => a.length === 5 && isAccountId(a[0]) && isStr(255)(a[1]) && isStr(10000)(a[2]) && (a[3] === null || isStr(64)(a[3])) && isStr(128)(a[4]),
  requestDetail: (a) => a.length === 2 && isAccountId(a[0]) && isInt(a[1]),
  requestHistory: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && (a[2] === null || isInt(a[2])),
  requestRespond: (a) => a.length === 6 && isAccountId(a[0]) && isInt(a[1]) && isVersion(a[2]) && (a[3] === 'approve' || a[3] === 'reject')
    && (a[4] === null || isStr(2000)(a[4])) && (a[3] === 'approve' || (typeof a[4] === 'string' && a[4].trim().length > 0)) && isKey(a[5]),
  requestResolve: (a) => a.length === 5 && isAccountId(a[0]) && isInt(a[1]) && isVersion(a[2]) && isTitle(2000)(a[3]) && isKey(a[4]),
  requestConvert: (a) => a.length === 6 && isAccountId(a[0]) && isInt(a[1]) && isVersion(a[2]) && isInt(a[3]) && isInt(a[4]) && isKey(a[5]),
  requestReport: (a) => a.length === 2 && isAccountId(a[0]) && isValidReportFilters(a[1]),
  goals: (a) => a.length === 1 && isAccountId(a[0]),
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
