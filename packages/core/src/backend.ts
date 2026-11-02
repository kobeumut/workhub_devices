import { accountIdFor, addAccount, createAccountClient, logout as logoutAccount, scopedKey, type Account, type AccountId, type LogoutReport, type SecretStore } from './accounts';
import { checkCompatibility, fetchServerCapabilities, fetchWorkhubBootstrap, type CompatibilityIssue, type WorkhubBootstrap } from './capabilities';
import { pollLoginFlow, startLoginFlow, type LoginFlowStart } from './loginFlow';
import { OcsError, type FetchLike, type OcsClient } from './ocs';
import { dismissNotification, listNotifications, type InboxNotification } from './routing';
import { normalizeServerUrl, type NormalizeOptions, type ServerBase } from './serverUrl';
import {
  fetchChat, listRooms, markRead, sendMessage, editMessage, deleteMessage, addReaction, removeReaction, listReactions, mentionSuggestions,
  searchMessages, inviteCandidates, talkRoomApi, talkFeaturesOf, roomActions, isReaction, ROOM_TYPE, TALK_LIMITS,
  type ChatFetchResult, type InviteCandidate, type MentionSuggestion, type MessageSearchPage, type ReactionMap, type RoomActions, type RoomKind,
  type RoomListResult, type RoomPatch, type TalkFeatures, type TalkMessage, type TalkParticipant, type TalkRoom,
} from './talk';
import {
  openTaskFromNotification, requestsApi, timeApi, workhubApi, workhubModulesApi, goalsApi, cardSetWithout, REPORT_STATES, GOAL_MAX_SCALE,
  SHARE_OBJECT_TYPES, SHARE_ROLES,
  type CsvScope, type RequestDecision, type RequestEvent, type RequestPage, type RequestReport, type RequestReportFilters, type ReviewAction, type ReviewItem, type SubmissionResult, type TeamReport, type TimeEntryInput, type TimeEntryPatch, type TimeEntryResult,
  projectViewsApi, ACTIVITY_TYPES, WORKLOAD_MAX_DAYS,
  type ActivityFilter, type ActivityPage, type GanttPayload, type WorkloadMatrix, type WorkloadQuery,
  dashboardsApi, dashboardRoleAtLeast, DASHBOARD_FILTER_FIELDS, DASHBOARD_FILTER_LIMITS, DASHBOARD_MAX_SOURCES, DASHBOARD_MAX_WIDGETS, DASHBOARD_TEMPLATES, DASHBOARD_GRID_COLUMNS,
  type Dashboard, type DashboardFilter, type DashboardInput, type DashboardPatch, type DashboardQueryOptions, type DashboardQueryResult, type DashboardRole, type DashboardSummary,
  type DashboardWidget, type DrilldownOptions, type DrilldownPage, type WidgetInput, type WidgetPatch, type WidgetTypeDef,
  type CardGoal, type GoalCheckin, type GoalCheckinInput, type GoalCheckinResult, type GoalDetail, type GoalInput, type GoalListFilter, type GoalPatch, type GoalTarget, type GoalTargetInput, type GoalTargetPatch,
  type BoardPayload, type GoalSummary, type MemberGrant, type ObjectShare, type ObjectShares, type Principal, type ShareObjectType, type StackSummary, type SubtaskList, type TaskPatch, type ProjectSummary, type RequestContext, type Task, type TaskComment, type TaskOpenResult, type TimeEntry, type Timer, type TimeWeek, type WorkRequest,
} from './workhub';
import {
  workflowsApi, workflowRoleAtLeast, stepActions, isActionableStep, WORKFLOW_CATEGORIES, WORKFLOW_ID_RE, WORKFLOW_LIMITS,
  type WorkflowDetail, type WorkflowGraph, type WorkflowHandoff, type WorkflowHandoffInput, type WorkflowInput, type WorkflowPatch, type WorkflowRun,
  type WorkflowSample, type WorkflowStartInput, type WorkflowSummary,
} from './workflows';
import {
  uploadFile, shareToRoom, downloadFile as downloadToSink, fetchFileBytes, fetchMessage, fileOf, quotaFree, canOpenSafely, bytesToBase64,
  FILE_HANDLE_RE, FILE_LIMITS, TRANSFER_ID_RE, VOICE_MIME_TYPES,
  type FileHandle, type FileHost, type SinkMode, type TransferProgress, type UploadResult,
} from './files';
import {
  aiApi, aiInputError, proposalActions, isAiActive, AI_ACTIONS, AI_LIMITS, AI_REQUEST_ID_RE,
  type AiAcceptResult, type AiProposal, type AiRequestBase, type AiRequestDetail, type AiRequestInput, type AiRequestSummary, type AiStatus,
} from './ai';

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
  /** `spreed.config.conversations.can-create` for this user. */
  talkCanCreate: boolean;
  /** `spreed.config.attachments.allowed` (and a folder is configured). */
  talkAttachmentsAllowed: boolean;
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

export interface ShareFileOptions {
  transferId: string;
  referenceId: string;
  caption?: string;
  replyTo?: number;
  voice?: boolean;
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

  /**
   * Talk extensions. Every call is capability-gated (`talkFeatures`, fail closed) and the role
   * gates use a FRESH room read (never a cached list row); the server re-checks everything.
   */
  talkRoom(accountId: AccountId, token: string): Promise<TalkRoom>;
  /** Own message or moderator (not 1:1), ≤ 24 h (note-to-self: unlimited). Returns the `message_edited` system message. */
  editMessage(accountId: AccountId, token: string, messageId: number, message: string): Promise<TalkMessage>;
  deleteMessage(accountId: AccountId, token: string, messageId: number): Promise<TalkMessage>;
  /** Add (`true`) or remove (`false`) the caller's reaction; returns the full reaction map. */
  react(accountId: AccountId, token: string, messageId: number, reaction: string, add: boolean): Promise<ReactionMap>;
  reactions(accountId: AccountId, token: string, messageId: number): Promise<ReactionMap>;
  mentions(accountId: AccountId, token: string, search: string): Promise<MentionSuggestion[]>;
  /** Unified search `talk-message`; `token` limits it to one conversation. */
  searchMessages(accountId: AccountId, term: string, token: string | null, cursor: number | null): Promise<MessageSearchPage>;
  createRoom(accountId: AccountId, kind: RoomKind, name: string): Promise<TalkRoom>;
  updateRoom(accountId: AccountId, token: string, patch: RoomPatch): Promise<TalkRoom>;
  participants(accountId: AccountId, token: string): Promise<TalkParticipant[]>;
  inviteCandidates(accountId: AccountId, token: string, search: string): Promise<InviteCandidate[]>;
  addParticipant(accountId: AccountId, token: string, source: 'users' | 'groups', id: string): Promise<TalkParticipant[]>;
  removeParticipant(accountId: AccountId, token: string, attendeeId: number): Promise<TalkParticipant[]>;
  setModerator(accountId: AccountId, token: string, attendeeId: number, moderator: boolean): Promise<TalkParticipant[]>;
  leaveRoom(accountId: AccountId, token: string): Promise<void>;
  deleteRoom(accountId: AccountId, token: string): Promise<void>;

  /**
   * Talk files. Gate: `attachments.allowed` + chat permission on the CURRENT room (voice notes:
   * `voice-message-sharing` and WAV/MP3 only; caption: `media-caption`). Quota is checked before
   * the upload; the server re-checks everything. The handle comes from the platform picker /
   * recorder and is released after a successful share. Progress: `transfer(transferId)`;
   * cancel: `cancel(transferId)`.
   */
  shareFile(accountId: AccountId, token: string, handle: FileHandle, opts: ShareFileOptions): Promise<UploadResult>;
  /** Fresh message read (`chat-get-context`); refused when the owner hid downloads, `open` only for safe types. */
  downloadFile(accountId: AccountId, token: string, messageId: number, mode: SinkMode, transferId: string): Promise<'saved' | 'opened' | 'cancelled'>;
  /** A voice note's bytes (base64, bounded) for in-app playback. */
  voiceClip(accountId: AccountId, token: string, messageId: number): Promise<{ mime: string; base64: string }>;
  transfer(transferId: string): Promise<TransferProgress | null>;

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
  /** Goals module (gate: `modules.goals`, fail closed). Default filter: all visible, active. */
  goals(accountId: AccountId, filter?: GoalListFilter): Promise<GoalSummary[]>;
  goalDetail(accountId: AccountId, goalId: number): Promise<GoalDetail>;
  goalCreate(accountId: AccountId, input: GoalInput): Promise<GoalDetail | null>;
  /** Header fields / archive / reactivate (role gate: `canEdit`). */
  goalUpdate(accountId: AccountId, goalId: number, patch: GoalPatch): Promise<GoalDetail | null>;
  /** Role gate: `canManage`. */
  goalDelete(accountId: AccountId, goalId: number, version: number): Promise<void>;
  /** Role gate: `canManage`; the new owner must be an enabled user with the Goals module. */
  goalTransfer(accountId: AccountId, goalId: number, version: number, newOwnerUid: string): Promise<GoalDetail | null>;
  /** Target / check-in / card-set writes need `canEdit` on an ACTIVE goal (gate, then server re-check). */
  goalTargetAdd(accountId: AccountId, goalId: number, input: GoalTargetInput): Promise<GoalTarget | null>;
  goalTargetUpdate(accountId: AccountId, goalId: number, targetId: number, patch: GoalTargetPatch): Promise<GoalTarget | null>;
  goalTargetDelete(accountId: AccountId, goalId: number, targetId: number, version: number): Promise<void>;
  goalCheckin(accountId: AccountId, goalId: number, targetId: number, input: GoalCheckinInput, idempotencyKey: string): Promise<GoalCheckinResult | null>;
  goalCheckins(accountId: AccountId, goalId: number, targetId: number): Promise<GoalCheckin[]>;
  goalSetCards(accountId: AccountId, goalId: number, targetId: number, version: number, cardIds: number[]): Promise<GoalTarget | null>;
  /** Goals the card is linked to that the caller may see (404 when the card is not readable). */
  cardGoals(accountId: AccountId, cardId: number): Promise<CardGoal[]>;
  cardLinkGoal(accountId: AccountId, cardId: number, goalId: number): Promise<GoalDetail | null>;
  /** Removes the card from that task target using the target's current version. */
  cardUnlinkGoal(accountId: AccountId, cardId: number, goalId: number, targetId: number): Promise<GoalTarget | null>;

  /** Project views (gate: `modules.projects`, fail closed; the server checks board read access). */
  projectGantt(accountId: AccountId, boardId: number): Promise<GanttPayload>;
  /** One page, newest first; pass the previous page's `nextCursor` for older events. */
  projectActivity(accountId: AccountId, boardId: number, filter: ActivityFilter, cursor: string | null): Promise<ActivityPage>;
  /** Member × day matrix over the readable boards (optionally restricted). */
  workload(accountId: AccountId, query: WorkloadQuery): Promise<WorkloadMatrix>;

  /** Dashboards (gate: `modules.dashboard`, fail closed; the server re-checks the object ACL and Deck scope). */
  dashboards(accountId: AccountId, cursor: string | null): Promise<{ items: DashboardSummary[]; nextCursor: string | null }>;
  /** Widget types enabled for this user (module providers are hidden when their module is off). */
  dashboardWidgetTypes(accountId: AccountId): Promise<WidgetTypeDef[]>;
  dashboard(accountId: AccountId, dashboardId: number): Promise<Dashboard>;
  dashboardCreate(accountId: AccountId, input: DashboardInput, idempotencyKey: string): Promise<Dashboard | null>;
  /** Needs `edit` on the CURRENT dashboard (fresh read). */
  dashboardUpdate(accountId: AccountId, dashboardId: number, patch: DashboardPatch): Promise<Dashboard | null>;
  /** Needs `manage`. */
  dashboardDelete(accountId: AccountId, dashboardId: number, version: number): Promise<void>;
  dashboardWidgetAdd(accountId: AccountId, dashboardId: number, input: WidgetInput): Promise<DashboardWidget | null>;
  dashboardWidgetUpdate(accountId: AccountId, dashboardId: number, widgetId: number, patch: WidgetPatch): Promise<DashboardWidget | null>;
  dashboardWidgetDelete(accountId: AccountId, dashboardId: number, widgetId: number): Promise<void>;
  /** Widget results scoped to the viewer's CURRENT Deck access. */
  dashboardQuery(accountId: AccountId, dashboardId: number, options: DashboardQueryOptions): Promise<DashboardQueryResult>;
  /** Cards behind a widget (optionally one distribution group), 50 per page. */
  dashboardDrilldown(accountId: AccountId, dashboardId: number, widgetId: number, options: DrilldownOptions): Promise<DrilldownPage>;
  dashboardCsv(accountId: AccountId, dashboardId: number, widgetId: number, filters: DashboardFilter | null): Promise<{ filename: string; csv: string }>;

  /** Workflows (gate: `modules.projects`, fail closed; the server re-checks the object ACL and Deck access). */
  workflows(accountId: AccountId): Promise<{ workflows: WorkflowSummary[]; pendingHandoffs: number }>;
  /** Built-in starting points (no lists / people) and the placeholder names. */
  workflowSamples(accountId: AccountId): Promise<{ items: WorkflowSample[]; placeholders: string[] }>;
  workflow(accountId: AccountId, workflowId: number): Promise<WorkflowDetail>;
  workflowCreate(accountId: AccountId, input: WorkflowInput, idempotencyKey: string): Promise<WorkflowDetail | null>;
  /** Needs `edit` on the CURRENT template (fresh read); version CAS on the server. */
  workflowUpdate(accountId: AccountId, workflowId: number, patch: WorkflowPatch): Promise<WorkflowDetail | null>;
  /** Needs `manage`; refused when the template changed since `version` (the server has no CAS on delete). */
  workflowDelete(accountId: AccountId, workflowId: number, version: number): Promise<void>;
  /** Template must be enabled and have a first step (fresh read). */
  workflowStart(accountId: AccountId, workflowId: number, input: WorkflowStartInput, idempotencyKey: string): Promise<WorkflowRun | null>;
  /** Last 50 runs of a template, newest first. */
  workflowRuns(accountId: AccountId, workflowId: number): Promise<WorkflowRun[]>;
  workflowRun(accountId: AccountId, runId: number): Promise<WorkflowRun>;
  /** Needs `canManage` on the CURRENT run (starter or workflow editor) and a running run. */
  workflowCancel(accountId: AccountId, runId: number, version: number): Promise<WorkflowRun | null>;
  /** Steps waiting for this user (hand-offs and failed steps to retry). */
  workflowHandoffs(accountId: AccountId): Promise<WorkflowHandoff[]>;
  /** Pending hand-offs that stem from one card (shown after completing it). */
  cardWorkflowHandoffs(accountId: AccountId, cardId: number): Promise<WorkflowHandoff[]>;
  /** Hand over a pending step / retry a failed one; needs `canAct` on the CURRENT run's step. */
  workflowHandoff(accountId: AccountId, runId: number, stepId: number, input: WorkflowHandoffInput, idempotencyKey: string): Promise<WorkflowRun | null>;
  workflowSkip(accountId: AccountId, runId: number, stepId: number, reason: string): Promise<WorkflowRun | null>;

  /** AI (gate: `modules.ai`, fail closed; requests and drafts are personal — others get 404). */
  aiStatus(accountId: AccountId): Promise<AiStatus>;
  aiRequests(accountId: AccountId): Promise<AiRequestSummary[]>;
  /** Client-side rule check first (`AI_INVALID_SCOPE`), then the server re-checks READ/EDIT. */
  aiCreate(accountId: AccountId, input: AiRequestInput, idempotencyKey: string): Promise<{ requestId: string; pollAfterMs: number } | null>;
  aiRequest(accountId: AccountId, requestId: string): Promise<AiRequestDetail>;
  /** Only for an active request of the caller (fresh read): `AI_REQUEST_FINISHED` 409 otherwise. */
  aiCancel(accountId: AccountId, requestId: string): Promise<AiRequestBase | null>;
  aiProposal(accountId: AccountId, proposalId: number): Promise<AiProposal>;
  /** Fresh preview must be acceptable (ready, not stale/restricted, target editable). */
  aiAccept(accountId: AccountId, proposalId: number, version: number, idempotencyKey: string): Promise<AiAcceptResult | null>;
  aiDismiss(accountId: AccountId, proposalId: number, version: number): Promise<{ id: number; state: 'dismissed'; version: number } | null>;
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
  /** Platform file access for Talk attachments; absent → file calls fail closed (`FILES_UNSUPPORTED`). */
  files?: FileHost;
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

  /** Goals gate (fail closed): the module must be on for this user. */
  const goalClient = async (id: AccountId): Promise<OcsClient> => {
    const c = await client(id);
    const b = await bootstrap(id, c);
    if (!b.modules.goals) throw new OcsError('forbidden', 403, undefined, undefined, 'GOALS_DISABLED');
    return c;
  };
  /**
   * Role gate on the CURRENT goal (fresh detail, never a cached list row): `edit` writes need
   * `canEdit` (and an active goal unless `allowArchived`), `manage` writes need `canManage`.
   * The server re-checks the ACL and lifecycle on every command.
   */
  const goalFor = async (id: AccountId, goalId: number, need: 'edit' | 'manage', allowArchived = false) => {
    const c = await goalClient(id);
    const goal = await goalsApi.get(c, goalId);
    if (need === 'manage' && !goal.canManage) throw new OcsError('forbidden', 403, undefined, undefined, 'GOAL_MANAGE_REQUIRED');
    if (need === 'edit' && !goal.canEdit) throw new OcsError('forbidden', 403, undefined, undefined, 'GOAL_EDIT_REQUIRED');
    if (need === 'edit' && !allowArchived && goal.state !== 'active') throw new OcsError('conflict', 409, undefined, undefined, 'GOAL_ARCHIVED');
    return { c, goal };
  };

  /** Projects gate (fail closed): the module must be on for this user. */
  const projectsClient = async (id: AccountId): Promise<OcsClient> => {
    const c = await client(id);
    const b = await bootstrap(id, c);
    if (!b.modules.projects) throw new OcsError('forbidden', 403, undefined, undefined, 'PROJECTS_DISABLED');
    return c;
  };

  /** Dashboard gate (fail closed): the module must be on for this user. */
  const dashboardClient = async (id: AccountId): Promise<OcsClient> => {
    const c = await client(id);
    const b = await bootstrap(id, c);
    if (!b.modules.dashboard) throw new OcsError('forbidden', 403, undefined, undefined, 'DASHBOARD_DISABLED');
    return c;
  };
  /**
   * Role gate on the CURRENT dashboard (fresh detail, never a cached list row): widget and header
   * writes need `edit`, delete needs `manage`. The server re-checks the ACL on every command.
   */
  const dashboardFor = async (id: AccountId, dashboardId: number, need: DashboardRole) => {
    const c = await dashboardClient(id);
    const d = await dashboardsApi.get(c, dashboardId);
    if (!dashboardRoleAtLeast(d.role, need)) throw new OcsError('forbidden', 403, undefined, undefined, need === 'manage' ? 'DASHBOARD_MANAGE_REQUIRED' : 'DASHBOARD_EDIT_REQUIRED');
    return { c, d };
  };
  /** AI gate (fail closed): the module must be on for this user. Provider state is the server's (503). */
  const aiClient = async (id: AccountId): Promise<OcsClient> => {
    const c = await client(id);
    const b = await bootstrap(id, c);
    if (!b.modules.ai) throw new OcsError('forbidden', 403, undefined, undefined, 'AI_DISABLED');
    return c;
  };
  /** Gate on the CURRENT draft preview: never act on a cached list row. */
  const proposalFor = async (id: AccountId, proposalId: number, version: number, need: 'accept' | 'dismiss') => {
    const c = await aiClient(id);
    const p = await aiApi.proposal(c, proposalId);
    if (p.version !== version) throw new OcsError('conflict', 409, undefined, undefined, 'VERSION_CONFLICT');
    const can = proposalActions(p);
    if (need === 'accept' && !can.accept) {
      if (p.restricted) throw new OcsError('not_found', 404);
      if (p.stale) throw new OcsError('conflict', 409, undefined, undefined, 'SOURCE_CHANGED');
      if (p.state === 'ready') throw new OcsError('forbidden', 403, undefined, undefined, 'ACTION_FORBIDDEN');
      throw new OcsError('conflict', 409, undefined, undefined, p.state === 'expired' ? 'PROPOSAL_EXPIRED' : 'PROPOSAL_NOT_READY');
    }
    if (need === 'dismiss' && !can.dismiss) throw new OcsError('conflict', 409, undefined, undefined, 'PROPOSAL_NOT_READY');
    return c;
  };
  /** Role gate on the CURRENT template (fresh detail): graph/header writes need `edit`, delete `manage`. */
  const workflowFor = async (id: AccountId, workflowId: number, need: 'view' | 'edit' | 'manage') => {
    const c = await projectsClient(id);
    const w = await workflowsApi.get(c, workflowId);
    if (!workflowRoleAtLeast(w.role, need)) throw new OcsError('forbidden', 403, undefined, undefined, need === 'manage' ? 'WORKFLOW_MANAGE_REQUIRED' : 'WORKFLOW_EDIT_REQUIRED');
    return { c, w };
  };
  /**
   * Step gate on the CURRENT run: the step must belong to the run, still wait for a person on a
   * running run (else 409 WORKFLOW_STEP_HANDLED) and the server must say this viewer can act.
   */
  const stepFor = async (id: AccountId, runId: number, stepId: number) => {
    const c = await projectsClient(id);
    const run = await workflowsApi.run(c, runId);
    const step = run.steps.find((s) => s.id === stepId);
    if (!step) throw new OcsError('not_found', 404, undefined, undefined, 'RESOURCE_NOT_FOUND');
    if (run.state !== 'running' || !isActionableStep(step)) throw new OcsError('conflict', 409, undefined, undefined, 'WORKFLOW_STEP_HANDLED');
    if (!stepActions(run, step).skip) throw new OcsError('forbidden', 403, undefined, undefined, 'ACTION_FORBIDDEN');
    return { c, run, step };
  };
  const clientError = (code: string) => new OcsError('client', 422, undefined, undefined, code);

  /** Talk capabilities per account, cached briefly (they change only on server upgrades/config). */
  const talkCaps = new Map<AccountId, { at: number; features: TalkFeatures; canCreate: boolean; folder: string | null }>();
  const talkFor = async (id: AccountId, need?: keyof TalkFeatures) => {
    const c = await client(id);
    let hit = talkCaps.get(id);
    if (!hit || Date.now() - hit.at > 60_000) {
      const caps = await fetchServerCapabilities(c);
      hit = {
        at: Date.now(),
        features: talkFeaturesOf(caps.talk.features, { attachmentsAllowed: caps.talk.attachments.allowed }),
        canCreate: caps.talk.canCreate,
        folder: caps.talk.attachments.folder,
      };
      talkCaps.set(id, hit);
    }
    if (need && !hit.features[need]) throw new OcsError('forbidden', 403, undefined, undefined, 'TALK_FEATURE_MISSING');
    return { c, f: hit.features, canCreate: hit.canCreate, folder: hit.folder };
  };
  /** Room gate on the CURRENT room (fresh read). */
  const roomFor = async (id: AccountId, token: string, need: keyof RoomActions, feature?: keyof TalkFeatures) => {
    const { c, f } = await talkFor(id, feature);
    const room = await talkRoomApi.get(c, token);
    if (!roomActions(room, f)[need]) throw new OcsError('forbidden', 403, undefined, undefined, `TALK_${need.replace(/[A-Z]/g, (x) => `_${x}`).toUpperCase()}_FORBIDDEN`);
    return { c, f, room };
  };

  /** Running uploads/downloads: progress for polling + abort for `cancel(transferId)`. */
  const transfers = new Map<string, { abort: AbortController; progress: TransferProgress; doneAt: number | undefined }>();
  const startTransfer = (transferId: string) => {
    if (transfers.get(transferId) && !transfers.get(transferId)!.doneAt) throw new OcsError('conflict', 409, undefined, undefined, 'TRANSFER_RUNNING');
    for (const [k, v] of transfers) if (v.doneAt && Date.now() - v.doneAt > 60_000) transfers.delete(k);
    const t = { abort: new AbortController(), progress: { sent: 0, total: 0, phase: 'preparing' } as TransferProgress, doneAt: undefined as number | undefined };
    transfers.set(transferId, t);
    return {
      signal: t.abort.signal,
      onProgress: (p: TransferProgress) => {
        t.progress = p;
      },
      end: () => {
        t.doneAt = Date.now();
      },
    };
  };
  const fileHost = (): FileHost => {
    if (!deps.files) throw new OcsError('forbidden', 403, undefined, undefined, 'FILES_UNSUPPORTED');
    return deps.files;
  };
  /** Viewer uid for WebDAV paths (may differ from the login name), cached per account. */
  const uids = new Map<AccountId, string>();
  const uidFor = async (id: AccountId, c: OcsClient) => {
    let uid = uids.get(id);
    if (!uid) {
      uid = (await quotaFree(c)).uid;
      uids.set(id, uid);
    }
    return uid;
  };
  /** Fresh message → its file, with the download gates applied. */
  const fileFor = async (id: AccountId, token: string, messageId: number) => {
    const { c } = await talkFor(id, 'context');
    const file = fileOf(await fetchMessage(c, token, messageId));
    if (!file || !file.path) throw new OcsError('not_found', 404, undefined, undefined, 'NOT_A_FILE');
    if (file.hideDownload) throw new OcsError('forbidden', 403, undefined, undefined, 'DOWNLOAD_HIDDEN');
    return { c, file, uid: await uidFor(id, c) };
  };

  const widgetOf = (d: Dashboard, widgetId: number) => {
    const w = d.widgets.find((x) => x.id === widgetId);
    if (!w) throw new OcsError('not_found', 404, undefined, undefined, 'RESOURCE_NOT_FOUND');
    return w;
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
      transfers.get(id)?.abort.abort();
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
        talkCanCreate: caps.talk.canCreate,
        talkAttachmentsAllowed: caps.talk.attachments.allowed,
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
      const c = replyTo ? (await talkFor(accountId, 'reply')).c : await client(accountId);
      return sendMessage(c, token, { message, referenceId, ...(replyTo ? { replyTo } : {}) });
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

    async talkRoom(accountId, token) {
      return talkRoomApi.get(await client(accountId), token);
    },
    async editMessage(accountId, token, messageId, message) {
      if (!message.trim()) throw clientError('EMPTY_MESSAGE');
      const { c } = await roomFor(accountId, token, 'chat', 'edit');
      return editMessage(c, token, messageId, message);
    },
    async deleteMessage(accountId, token, messageId) {
      const { c } = await roomFor(accountId, token, 'chat', 'delete');
      return deleteMessage(c, token, messageId);
    },
    async react(accountId, token, messageId, reaction, add) {
      const { c } = await roomFor(accountId, token, 'react', 'reactions');
      return add ? addReaction(c, token, messageId, reaction) : removeReaction(c, token, messageId, reaction);
    },
    async reactions(accountId, token, messageId) {
      const { c } = await talkFor(accountId, 'reactions');
      return listReactions(c, token, messageId);
    },
    async mentions(accountId, token, search) {
      const { c } = await talkFor(accountId, 'mentions');
      return mentionSuggestions(c, token, search);
    },
    async searchMessages(accountId, term, token, cursor) {
      const { c } = await talkFor(accountId, 'search');
      return searchMessages(c, { term, token, cursor });
    },
    async createRoom(accountId, kind, name) {
      const { c, canCreate } = await talkFor(accountId);
      if (!canCreate) throw new OcsError('forbidden', 403, undefined, undefined, 'TALK_CREATE_FORBIDDEN');
      if (!name.trim()) throw clientError('EMPTY_NAME');
      return talkRoomApi.create(c, kind, name);
    },
    async updateRoom(accountId, token, patch) {
      if (patch.name !== undefined && !patch.name.trim()) throw clientError('EMPTY_NAME');
      const { c, f, room } = await roomFor(accountId, token, 'rename');
      if (patch.description !== undefined && !roomActions(room, f).describe) throw new OcsError('forbidden', 403, undefined, undefined, 'TALK_DESCRIBE_FORBIDDEN');
      if (patch.name !== undefined && patch.name.trim() !== room.displayName) await talkRoomApi.rename(c, token, patch.name);
      if (patch.description !== undefined && patch.description !== (room.description ?? '')) await talkRoomApi.describe(c, token, patch.description);
      return talkRoomApi.get(c, token);
    },
    async participants(accountId, token) {
      return talkRoomApi.participants(await client(accountId), token);
    },
    async inviteCandidates(accountId, token, search) {
      const { c } = await roomFor(accountId, token, 'manageParticipants');
      return inviteCandidates(c, token, search);
    },
    async addParticipant(accountId, token, source, id) {
      const { c } = await roomFor(accountId, token, 'manageParticipants');
      await talkRoomApi.addParticipant(c, token, source, id);
      return talkRoomApi.participants(c, token);
    },
    async removeParticipant(accountId, token, attendeeId) {
      const { c, room } = await roomFor(accountId, token, 'manageParticipants');
      if (attendeeId === room.attendeeId) throw clientError('USE_LEAVE');
      await talkRoomApi.removeAttendee(c, token, attendeeId);
      return talkRoomApi.participants(c, token);
    },
    async setModerator(accountId, token, attendeeId, moderator) {
      const { c, room } = await roomFor(accountId, token, 'manageParticipants');
      if (attendeeId === room.attendeeId) throw clientError('SELF_ROLE');
      await talkRoomApi.setModerator(c, token, attendeeId, moderator);
      return talkRoomApi.participants(c, token);
    },
    async leaveRoom(accountId, token) {
      const { c } = await roomFor(accountId, token, 'leave');
      await talkRoomApi.leave(c, token);
    },
    async deleteRoom(accountId, token) {
      const { c, room } = await roomFor(accountId, token, 'delete');
      if (room.type === ROOM_TYPE.oneToOne || room.type === ROOM_TYPE.formerOneToOne) throw new OcsError('forbidden', 403, undefined, undefined, 'TALK_DELETE_FORBIDDEN');
      await talkRoomApi.remove(c, token);
    },

    async shareFile(accountId, token, handle, opts) {
      const host = fileHost();
      const { c, f } = await roomFor(accountId, token, 'chat', 'files');
      const { folder } = await talkFor(accountId, 'files');
      if (!folder) throw new OcsError('forbidden', 403, undefined, undefined, 'TALK_FEATURE_MISSING');
      if (opts.voice && !f.voice) throw new OcsError('forbidden', 403, undefined, undefined, 'TALK_FEATURE_MISSING');
      if (opts.caption?.trim() && !f.caption) throw new OcsError('forbidden', 403, undefined, undefined, 'TALK_FEATURE_MISSING');
      if (opts.replyTo && !f.reply) throw new OcsError('forbidden', 403, undefined, undefined, 'TALK_FEATURE_MISSING');
      const st = await host.stat(handle);
      if (!st) throw new OcsError('not_found', 404, undefined, undefined, 'FILE_GONE');
      if (opts.voice && (!VOICE_MIME_TYPES.has(st.mime) || st.size > FILE_LIMITS.maxVoice)) throw clientError('INVALID_VOICE_MESSAGE');
      const tx = startTransfer(opts.transferId);
      try {
        // Quota pre-check (the PUT would fail with 507 anyway, but only after sending the bytes).
        const q = await quotaFree(c);
        uids.set(accountId, q.uid);
        if (q.free !== null && st.size > q.free) throw new OcsError('client', 507, undefined, undefined, 'QUOTA_EXCEEDED');
        const up = await uploadFile(c, host, handle, { uid: q.uid, folder }, { signal: tx.signal, onProgress: tx.onProgress });
        tx.onProgress({ sent: st.size, total: st.size, phase: 'sharing' });
        if (tx.signal.aborted) throw new OcsError('aborted');
        const shareId = await shareToRoom(c, token, up.path, {
          referenceId: opts.referenceId,
          ...(opts.caption?.trim() ? { caption: opts.caption } : {}),
          ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
          ...(opts.voice ? { voice: true } : {}),
        });
        tx.onProgress({ sent: st.size, total: st.size, phase: 'done' });
        await host.release(handle).catch(() => undefined);
        return { ...up, shareId };
      } finally {
        tx.end();
      }
    },
    async downloadFile(accountId, token, messageId, mode, transferId) {
      const host = fileHost();
      const { c, file, uid } = await fileFor(accountId, token, messageId);
      if (mode === 'open' && !canOpenSafely(file.name)) throw new OcsError('forbidden', 403, undefined, undefined, 'OPEN_NOT_ALLOWED');
      const sink = await host.openSink(file.name, file.mimetype, file.size, mode);
      if (!sink) return 'cancelled';
      const tx = startTransfer(transferId);
      try {
        return await downloadToSink(c, uid, file, sink, { signal: tx.signal, onProgress: tx.onProgress });
      } finally {
        tx.end();
      }
    },
    async voiceClip(accountId, token, messageId) {
      const { c, file, uid } = await fileFor(accountId, token, messageId);
      if (!file.voice && !file.mimetype.startsWith('audio/')) throw clientError('NOT_AUDIO');
      const bytes = await fetchFileBytes(c, uid, file, FILE_LIMITS.maxPlayback);
      return { mime: file.mimetype, base64: bytesToBase64(bytes) };
    },
    async transfer(transferId) {
      const t = transfers.get(transferId);
      return t ? { ...t.progress } : null;
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
    async goals(accountId, filter) {
      return goalsApi.list(await goalClient(accountId), filter);
    },
    async goalDetail(accountId, goalId) {
      return goalsApi.get(await goalClient(accountId), goalId);
    },
    async goalCreate(accountId, input) {
      const body: GoalInput = { title: input.title.trim() };
      if (input.description?.trim()) body.description = input.description.trim();
      if (input.dueDate) body.dueDate = input.dueDate;
      if (!body.title) throw new OcsError('client', 422, undefined, undefined, 'FIELD_REQUIRED');
      return goalsApi.create(await goalClient(accountId), body);
    },
    async goalUpdate(accountId, goalId, patch) {
      const { c } = await goalFor(accountId, goalId, 'edit', true);
      return goalsApi.update(c, goalId, patch);
    },
    async goalDelete(accountId, goalId, version) {
      const { c } = await goalFor(accountId, goalId, 'manage');
      await goalsApi.remove(c, goalId, version);
    },
    async goalTransfer(accountId, goalId, version, newOwnerUid) {
      const { c, goal } = await goalFor(accountId, goalId, 'manage');
      if (goal.owner.uid === newOwnerUid) throw new OcsError('client', 422, undefined, undefined, 'INVALID_OWNER');
      return goalsApi.transfer(c, goalId, version, newOwnerUid);
    },
    async goalTargetAdd(accountId, goalId, input) {
      const { c } = await goalFor(accountId, goalId, 'edit');
      return goalsApi.addTarget(c, goalId, input);
    },
    async goalTargetUpdate(accountId, goalId, targetId, patch) {
      const { c } = await goalFor(accountId, goalId, 'edit');
      return goalsApi.updateTarget(c, goalId, targetId, patch);
    },
    async goalTargetDelete(accountId, goalId, targetId, version) {
      const { c } = await goalFor(accountId, goalId, 'edit');
      await goalsApi.removeTarget(c, goalId, targetId, version);
    },
    async goalCheckin(accountId, goalId, targetId, input, idempotencyKey) {
      const { c, goal } = await goalFor(accountId, goalId, 'edit');
      const target = goal.targets.find((t) => t.id === targetId);
      if (!target) throw new OcsError('not_found', 404, undefined, undefined, 'RESOURCE_NOT_FOUND');
      if (target.type === 'task') throw new OcsError('client', 422, undefined, undefined, 'TARGET_NOT_MANUAL');
      if ((target.type === 'boolean') !== (typeof input.value === 'boolean')) throw new OcsError('client', 422, undefined, undefined, 'INVALID_FIELD');
      return goalsApi.checkin(c, goalId, targetId, input, idempotencyKey);
    },
    async goalCheckins(accountId, goalId, targetId) {
      return goalsApi.checkins(await goalClient(accountId), goalId, targetId);
    },
    async goalSetCards(accountId, goalId, targetId, version, cardIds) {
      const { c } = await goalFor(accountId, goalId, 'edit');
      return goalsApi.setCards(c, goalId, targetId, version, cardIds);
    },
    async cardGoals(accountId, cardId) {
      return goalsApi.cardGoals(await goalClient(accountId), cardId);
    },
    async cardLinkGoal(accountId, cardId, goalId) {
      const { c } = await goalFor(accountId, goalId, 'edit');
      return goalsApi.linkCard(c, cardId, goalId);
    },
    async cardUnlinkGoal(accountId, cardId, goalId, targetId) {
      const { c, goal } = await goalFor(accountId, goalId, 'edit');
      const target = goal.targets.find((t) => t.id === targetId && t.type === 'task');
      if (!target || !(target.cards ?? []).some((x) => x.id === cardId)) throw new OcsError('not_found', 404, undefined, undefined, 'RESOURCE_NOT_FOUND');
      return goalsApi.setCards(c, goalId, targetId, target.version, cardSetWithout(target, cardId));
    },

    async projectGantt(accountId, boardId) {
      return projectViewsApi.gantt(await projectsClient(accountId), boardId);
    },
    async projectActivity(accountId, boardId, filter, cursor) {
      return projectViewsApi.activity(await projectsClient(accountId), boardId, filter, cursor);
    },
    async workload(accountId, query) {
      return projectViewsApi.workload(await projectsClient(accountId), query);
    },

    async dashboards(accountId, cursor) {
      return dashboardsApi.list(await dashboardClient(accountId), cursor);
    },
    async dashboardWidgetTypes(accountId) {
      return dashboardsApi.widgetTypes(await dashboardClient(accountId));
    },
    async dashboard(accountId, dashboardId) {
      return dashboardsApi.get(await dashboardClient(accountId), dashboardId);
    },
    async dashboardCreate(accountId, input, idempotencyKey) {
      const body: DashboardInput = { ...input, title: input.title.trim() };
      if (!body.title) throw new OcsError('client', 422, undefined, undefined, 'FIELD_REQUIRED');
      return dashboardsApi.create(await dashboardClient(accountId), body, idempotencyKey);
    },
    async dashboardUpdate(accountId, dashboardId, patch) {
      const { c } = await dashboardFor(accountId, dashboardId, 'edit');
      return dashboardsApi.update(c, dashboardId, patch);
    },
    async dashboardDelete(accountId, dashboardId, version) {
      const { c } = await dashboardFor(accountId, dashboardId, 'manage');
      await dashboardsApi.remove(c, dashboardId, version);
    },
    async dashboardWidgetAdd(accountId, dashboardId, input) {
      const { c, d } = await dashboardFor(accountId, dashboardId, 'edit');
      if (d.widgets.length >= (d.limits?.widgets ?? DASHBOARD_MAX_WIDGETS)) throw new OcsError('client', 422, undefined, undefined, 'TOO_MANY_WIDGETS');
      return dashboardsApi.addWidget(c, dashboardId, input);
    },
    async dashboardWidgetUpdate(accountId, dashboardId, widgetId, patch) {
      const { c, d } = await dashboardFor(accountId, dashboardId, 'edit');
      widgetOf(d, widgetId);
      return dashboardsApi.updateWidget(c, dashboardId, widgetId, patch);
    },
    async dashboardWidgetDelete(accountId, dashboardId, widgetId) {
      const { c, d } = await dashboardFor(accountId, dashboardId, 'edit');
      widgetOf(d, widgetId);
      await dashboardsApi.removeWidget(c, dashboardId, widgetId);
    },
    async dashboardQuery(accountId, dashboardId, options) {
      return dashboardsApi.query(await dashboardClient(accountId), dashboardId, options);
    },
    async dashboardDrilldown(accountId, dashboardId, widgetId, options) {
      return dashboardsApi.drilldown(await dashboardClient(accountId), dashboardId, widgetId, options);
    },
    async dashboardCsv(accountId, dashboardId, widgetId, filters) {
      return dashboardsApi.csv(await dashboardClient(accountId), dashboardId, widgetId, filters ?? undefined);
    },

    async workflows(accountId) {
      return workflowsApi.list(await projectsClient(accountId));
    },
    async workflowSamples(accountId) {
      return workflowsApi.samples(await projectsClient(accountId));
    },
    async workflow(accountId, workflowId) {
      return workflowsApi.get(await projectsClient(accountId), workflowId);
    },
    async workflowCreate(accountId, input, idempotencyKey) {
      const body: WorkflowInput = { ...input, title: input.title.trim() };
      if (input.description !== undefined) body.description = input.description.trim();
      if (!body.title) throw clientError('FIELD_REQUIRED');
      return workflowsApi.create(await projectsClient(accountId), body, idempotencyKey);
    },
    async workflowUpdate(accountId, workflowId, patch) {
      const { c } = await workflowFor(accountId, workflowId, 'edit');
      return workflowsApi.update(c, workflowId, patch);
    },
    async workflowDelete(accountId, workflowId, version) {
      const { c, w } = await workflowFor(accountId, workflowId, 'manage');
      if (w.version !== version) throw new OcsError('conflict', 409, undefined, undefined, 'VERSION_CONFLICT');
      await workflowsApi.remove(c, workflowId);
    },
    async workflowStart(accountId, workflowId, input, idempotencyKey) {
      const { c, w } = await workflowFor(accountId, workflowId, 'view');
      if (!w.enabled) throw new OcsError('forbidden', 403, undefined, undefined, 'WORKFLOW_DISABLED');
      const entry = w.graph.start.nodeId ? w.graph.nodes.find((n) => n.id === w.graph.start.nodeId) : undefined;
      if (!entry) throw clientError('WORKFLOW_NO_ENTRY');
      if (input.cardId === undefined && entry.stackId === null) throw clientError('WORKFLOW_STEP_NO_LIST');
      if (input.assigneeUid) {
        // A fixed step ignores a chosen assignee; refuse instead of silently dropping it.
        if (entry.assigneeMode !== 'choose' || input.cardId !== undefined) throw clientError('WORKFLOW_ASSIGNEE_FIXED');
        if (entry.assignees.length && !entry.assignees.includes(input.assigneeUid)) throw clientError('WORKFLOW_ASSIGNEE_NOT_ALLOWED');
      }
      return workflowsApi.start(c, workflowId, input, idempotencyKey);
    },
    async workflowRuns(accountId, workflowId) {
      return workflowsApi.runs(await projectsClient(accountId), workflowId);
    },
    async workflowRun(accountId, runId) {
      return workflowsApi.run(await projectsClient(accountId), runId);
    },
    async workflowCancel(accountId, runId, version) {
      const c = await projectsClient(accountId);
      const run = await workflowsApi.run(c, runId);
      if (!run.canManage) throw new OcsError('forbidden', 403, undefined, undefined, 'ACTION_FORBIDDEN');
      if (run.state !== 'running') throw new OcsError('conflict', 409, undefined, undefined, 'WORKFLOW_RUN_FINISHED');
      return workflowsApi.cancel(c, runId, version);
    },
    async workflowHandoffs(accountId) {
      return workflowsApi.handoffs(await projectsClient(accountId));
    },
    async cardWorkflowHandoffs(accountId, cardId) {
      return workflowsApi.cardHandoffs(await projectsClient(accountId), cardId);
    },
    async workflowHandoff(accountId, runId, stepId, input, idempotencyKey) {
      const { c, step } = await stepFor(accountId, runId, stepId);
      if (input.assigneeUid) {
        if (step.node?.assigneeMode !== 'choose') throw clientError('WORKFLOW_ASSIGNEE_FIXED');
        if (step.node.assignees.length && !step.node.assignees.some((p) => p.uid === input.assigneeUid)) throw clientError('WORKFLOW_ASSIGNEE_NOT_ALLOWED');
      }
      return workflowsApi.handoff(c, stepId, input, idempotencyKey);
    },
    async workflowSkip(accountId, runId, stepId, reason) {
      const { c } = await stepFor(accountId, runId, stepId);
      return workflowsApi.skip(c, stepId, reason.trim());
    },
    async aiStatus(accountId) {
      return aiApi.status(await aiClient(accountId));
    },
    async aiRequests(accountId) {
      return aiApi.list(await aiClient(accountId));
    },
    async aiCreate(accountId, input, idempotencyKey) {
      const message = input.message?.trim();
      const body: AiRequestInput = { action: input.action, scope: { ...input.scope }, ...(message ? { message } : {}) };
      if (aiInputError(body)) throw new OcsError('client', 422, undefined, undefined, 'AI_INVALID_SCOPE');
      const r = await aiApi.create(await aiClient(accountId), body, idempotencyKey);
      return r ? { requestId: r.requestId, pollAfterMs: r.pollAfterMs } : null;
    },
    async aiRequest(accountId, requestId) {
      return aiApi.get(await aiClient(accountId), requestId);
    },
    async aiCancel(accountId, requestId) {
      const c = await aiClient(accountId);
      const current = await aiApi.get(c, requestId);
      if (!isAiActive(current.state)) throw new OcsError('conflict', 409, undefined, undefined, 'AI_REQUEST_FINISHED');
      return aiApi.cancel(c, requestId);
    },
    async aiProposal(accountId, proposalId) {
      return aiApi.proposal(await aiClient(accountId), proposalId);
    },
    async aiAccept(accountId, proposalId, version, idempotencyKey) {
      return aiApi.accept(await proposalFor(accountId, proposalId, version, 'accept'), proposalId, version, idempotencyKey);
    },
    async aiDismiss(accountId, proposalId, version) {
      return aiApi.dismiss(await proposalFor(accountId, proposalId, version, 'dismiss'), proposalId, version);
    },
  };
}

// ---- IPC transport helpers (desktop) -------------------------------------------

/** Every Backend method name; the Electron main rejects anything else. */
export const BACKEND_METHODS = [
  'listAccounts', 'beginLogin', 'completeLogin', 'cancel', 'logout', 'session',
  'rooms', 'chat', 'send', 'markRead', 'createOneToOne',
  'talkRoom', 'editMessage', 'deleteMessage', 'react', 'reactions', 'mentions', 'searchMessages', 'createRoom', 'updateRoom',
  'participants', 'inviteCandidates', 'addParticipant', 'removeParticipant', 'setModerator', 'leaveRoom', 'deleteRoom',
  'shareFile', 'downloadFile', 'voiceClip', 'transfer',
  'notifications', 'dismissNotification',
  'projects', 'board', 'openTask', 'comments', 'addComment', 'updateTask', 'moveTask', 'createTask',
  'addSubtask', 'updateSubtask', 'deleteSubtask', 'addDependency', 'removeDependency',
  'createProject', 'renameProject', 'addProjectMember', 'createStack', 'renameStack', 'principals', 'objectShares', 'setObjectShares',
  'timer', 'timerStart', 'timerStop', 'timeWeek',
  'timeEntryCreate', 'timeEntryUpdate', 'timeEntryDelete', 'timeSubmit', 'timeWithdraw', 'timeReviews', 'timeDecide', 'timeTeam', 'timeCsv',
  'requests', 'requestContext', 'createRequest', 'requestDetail', 'requestHistory', 'requestRespond', 'requestResolve', 'requestConvert', 'requestReport',
  'goals', 'goalDetail', 'goalCreate', 'goalUpdate', 'goalDelete', 'goalTransfer', 'goalTargetAdd', 'goalTargetUpdate', 'goalTargetDelete',
  'goalCheckin', 'goalCheckins', 'goalSetCards', 'cardGoals', 'cardLinkGoal', 'cardUnlinkGoal',
  'projectGantt', 'projectActivity', 'workload',
  'dashboards', 'dashboardWidgetTypes', 'dashboard', 'dashboardCreate', 'dashboardUpdate', 'dashboardDelete',
  'dashboardWidgetAdd', 'dashboardWidgetUpdate', 'dashboardWidgetDelete', 'dashboardQuery', 'dashboardDrilldown', 'dashboardCsv',
  'workflows', 'workflowSamples', 'workflow', 'workflowCreate', 'workflowUpdate', 'workflowDelete', 'workflowStart',
  'workflowRuns', 'workflowRun', 'workflowCancel', 'workflowHandoffs', 'cardWorkflowHandoffs', 'workflowHandoff', 'workflowSkip',
  'aiStatus', 'aiRequests', 'aiCreate', 'aiRequest', 'aiCancel', 'aiProposal', 'aiAccept', 'aiDismiss',
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

// ---- Goals wire validation: exact field sets per target type, server decimal format ----
const isDecimal = (v: unknown) => typeof v === 'string' && /^-?\d{1,30}(\.\d{1,4})?$/.test(v);
const isGoalTitle = isTitle(200);
const isGoalDesc = isStr(4000);
const isDueOrNull = (v: unknown) => v === null || isDay(v);
const isCurrency = (v: unknown) => typeof v === 'string' && /^[A-Z]{3}$/.test(v);
const isUid = (v: unknown) => isStr(64)(v) && (v as string).trim().length > 0;
export const isValidGoalFilter = (v: unknown): v is GoalListFilter => {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  return hasOnly(o, ['owner', 'state']) && ['me', 'shared', 'all'].includes(o.owner as string) && ['active', 'archived', 'any'].includes(o.state as string);
};
export const isValidGoalInput = (v: unknown): v is GoalInput =>
  isObj(v) && fieldsOk(v as Record<string, unknown>, { title: isGoalTitle, description: isGoalDesc, dueDate: isDueOrNull }, ['title']);
export const isValidGoalPatch = (v: unknown): v is GoalPatch => {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  return Object.keys(o).length > 1 && fieldsOk(o, { version: isVersion, title: isGoalTitle, description: isGoalDesc, dueDate: isDueOrNull, state: (x) => x === 'active' || x === 'archived' }, ['version']);
};
export const isValidTargetInput = (v: unknown): v is GoalTargetInput => {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.type === 'boolean' || o.type === 'task') return hasOnly(o, ['type', 'title']) && isGoalTitle(o.title);
  if (o.type !== 'number' && o.type !== 'currency') return false;
  const spec: Record<string, (x: unknown) => boolean> = {
    type: () => true, title: isGoalTitle, start: isDecimal, target: isDecimal, current: isDecimal,
    scale: (x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= GOAL_MAX_SCALE,
    ...(o.type === 'currency' ? { currencyCode: isCurrency } : {}),
  };
  return fieldsOk(o, spec, o.type === 'currency' ? ['type', 'title', 'start', 'target', 'currencyCode'] : ['type', 'title', 'start', 'target']) && o.start !== o.target;
};
export const isValidTargetPatch = (v: unknown): v is GoalTargetPatch => {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  return Object.keys(o).length > 1 && fieldsOk(o, { version: isVersion, title: isGoalTitle, start: isDecimal, target: isDecimal, currencyCode: isCurrency }, ['version']);
};
export const isValidCheckin = (v: unknown): v is GoalCheckinInput => {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  const note = { note: isStr(1000) };
  if (typeof o.value === 'boolean') return fieldsOk(o, { version: isVersion, value: () => true, ...note }, ['version', 'value']);
  return fieldsOk(o, { version: isVersion, mode: (x) => x === 'absolute' || x === 'delta', value: isDecimal, ...note }, ['version', 'mode', 'value']);
};
const isCardIds = (v: unknown) => Array.isArray(v) && v.length <= 500 && v.every(isInt) && new Set(v).size === v.length;

// ---- Project views wire validation ----
/** A real calendar day (the server's date parser silently rolls 2026-13-01 over). */
const isCalendarDay = (v: unknown) => {
  if (!isDay(v)) return false;
  const t = Date.parse(`${v as string}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(v as string);
};
const isCursor = (v: unknown) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 200 && /^[A-Za-z0-9+/=]+$/.test(v));
export const isValidActivityFilter = (v: unknown): v is ActivityFilter => {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.from !== undefined && o.to !== undefined && !isDayRange(o.from, o.to, 3660)) return false;
  return fieldsOk(o, { type: (x) => (ACTIVITY_TYPES as readonly unknown[]).includes(x), actor: isUid, from: isCalendarDay, to: isCalendarDay, q: isStr(200) }, ['type']);
};
export const isValidWorkloadQuery = (v: unknown): v is WorkloadQuery => {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  return fieldsOk(o, {
    from: isCalendarDay, to: isCalendarDay,
    boardIds: (x) => Array.isArray(x) && x.length <= 200 && x.every(isInt) && new Set(x).size === x.length,
    members: (x) => Array.isArray(x) && x.length <= 200 && x.every((u) => isUid(u) && !(u as string).includes(',')) && new Set(x).size === x.length,
  }, ['from', 'to']) && isDayRange(o.from, o.to, WORKLOAD_MAX_DAYS);
};

// ---- Dashboard wire validation: FilterSpec / ConfigSchema shapes, server limits ----
const isIdSet = (max: number) => (x: unknown) => Array.isArray(x) && x.length <= max && x.every(isInt) && new Set(x).size === x.length;
/** Server uid charset (FilterSpec::uidList). */
const isFilterUid = (x: unknown) => typeof x === 'string' && /^[a-zA-Z0-9 _.@\-']{1,64}$/.test(x);
export const isValidDashboardFilter = (v: unknown): v is DashboardFilter => {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  if (!Object.keys(o).every((k) => (DASHBOARD_FILTER_FIELDS as readonly string[]).includes(k))) return false;
  const ok = fieldsOk(o, {
    boardIds: isIdSet(DASHBOARD_FILTER_LIMITS.boardIds),
    stackIds: isIdSet(DASHBOARD_FILTER_LIMITS.stackIds),
    labelIds: isIdSet(DASHBOARD_FILTER_LIMITS.labelIds),
    assigneeUids: (x) => Array.isArray(x) && x.length <= DASHBOARD_FILTER_LIMITS.assigneeUids && x.every(isFilterUid) && new Set(x).size === x.length,
    doneState: (x) => x === 'any' || x === 'open' || x === 'done',
    dueFrom: isCalendarDay, dueTo: isCalendarDay, createdFrom: isCalendarDay, createdTo: isCalendarDay,
    includeArchived: (x) => typeof x === 'boolean',
  }, []);
  if (!ok) return false;
  if (o.dueFrom !== undefined && o.dueTo !== undefined && (o.dueFrom as string) > (o.dueTo as string)) return false;
  if (o.createdFrom !== undefined && o.createdTo !== undefined && (o.createdFrom as string) > (o.createdTo as string)) return false;
  // The drill-down/CSV query parameter is capped at 8000 bytes by the server.
  return JSON.stringify(o).length <= 8000;
};
const isRefreshSec = (x: unknown) => Number.isInteger(x) && ((x as number) === 0 || ((x as number) >= 60 && (x as number) <= 86400));
const isConfigValue = (x: unknown) =>
  x === null || typeof x === 'boolean' || (Number.isInteger(x) && Math.abs(x as number) < 2 ** 31) || isStr(200)(x) || (Array.isArray(x) && x.length <= 100 && x.every(isInt));
/** Widget config: a flat object of scalar / id-list values (the server validates against the type's schema). */
export const isValidWidgetConfig = (v: unknown): v is Record<string, unknown> => {
  if (!isObj(v)) return false;
  const e = Object.entries(v as object);
  return e.length <= 20 && e.every(([k, x]) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k) && isConfigValue(x)) && JSON.stringify(v).length <= 4000;
};
const DASHBOARD_FIELDS: Record<string, (v: unknown) => boolean> = {
  title: isTitle(200), description: isStr(2000), zone: isZone, refreshSec: isRefreshSec,
  sources: isIdSet(DASHBOARD_MAX_SOURCES), filters: isValidDashboardFilter,
};
export const isValidDashboardInput = (v: unknown): v is DashboardInput =>
  isObj(v) && fieldsOk(v as Record<string, unknown>, { ...DASHBOARD_FIELDS, template: (x) => (DASHBOARD_TEMPLATES as readonly unknown[]).includes(x) }, ['title']);
export const isValidDashboardPatch = (v: unknown): v is DashboardPatch =>
  isObj(v) && Object.keys(v as object).length > 1 && fieldsOk(v as Record<string, unknown>, { ...DASHBOARD_FIELDS, version: isVersion }, ['version']);
const WIDGET_LAYOUT: Record<string, (v: unknown) => boolean> = {
  x: (x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) < DASHBOARD_GRID_COLUMNS,
  y: (x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 999,
  w: (x) => Number.isInteger(x) && (x as number) >= 3 && (x as number) <= DASHBOARD_GRID_COLUMNS,
  h: (x) => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 4,
};
const WIDGET_FIELDS: Record<string, (v: unknown) => boolean> = { title: isStr(200), config: isValidWidgetConfig, filter: isValidDashboardFilter, ...WIDGET_LAYOUT };
const fitsGrid = (o: Record<string, unknown>) => o.x === undefined || o.w === undefined || (o.x as number) + (o.w as number) <= DASHBOARD_GRID_COLUMNS;
export const isValidWidgetInput = (v: unknown): v is WidgetInput =>
  isObj(v) && fieldsOk(v as Record<string, unknown>, { ...WIDGET_FIELDS, type: (x) => typeof x === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(x) }, ['type']) && fitsGrid(v as Record<string, unknown>);
export const isValidWidgetPatch = (v: unknown): v is WidgetPatch =>
  isObj(v) && Object.keys(v as object).length > 1 && fieldsOk(v as Record<string, unknown>, { ...WIDGET_FIELDS, version: isVersion }, ['version']) && fitsGrid(v as Record<string, unknown>);
export const isValidDashboardQuery = (v: unknown): v is DashboardQueryOptions =>
  isObj(v) && fieldsOk(v as Record<string, unknown>, { widgetIds: isIdSet(DASHBOARD_MAX_WIDGETS), refresh: (x) => typeof x === 'boolean', filters: isValidDashboardFilter }, []);
/** Drill-down cursor: url-safe base64 from DeckWidgetProvider::listPage. */
const isDrillCursor = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 1000 && /^[A-Za-z0-9_-]+$/.test(x);
/** Group keys: stack/board/label ids, `user:<uid>`, `group:<gid>`, `none` — printable, no control chars. */
const isGroupKey = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 80 && !/[\u0000-\u001f\u007f]/.test(x);
export const isValidDrilldownOptions = (v: unknown): v is DrilldownOptions =>
  isObj(v) && fieldsOk(v as Record<string, unknown>, { groupKey: isGroupKey, cursor: isDrillCursor, filters: isValidDashboardFilter }, []);

// ---- Workflow wire validation: the server's graph shape and limits (`Graph`, `WorkflowService`) ----
const L = WORKFLOW_LIMITS;
const isWfId = (x: unknown) => typeof x === 'string' && WORKFLOW_ID_RE.test(x);
const isIdOrNull = (x: unknown) => x === null || isInt(x);
const isCoord = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= L.coord;
const isWfUid = (x: unknown) => typeof x === 'string' && x.trim().length > 0 && x.length <= 64 && !/[\u0000-\u001f\u007f]/.test(x);
const isNode = (v: unknown) => isObj(v) && fieldsOk(v as Record<string, unknown>, {
  id: isWfId, type: (x) => x === 'task', label: isTitle(L.label), title: isStr(L.stepTitle), description: isStr(L.stepDescription),
  stackId: isIdOrNull, boardId: isIdOrNull, assigneeMode: (x) => x === 'fixed' || x === 'choose',
  assignees: (x) => Array.isArray(x) && x.length <= L.assignees && x.every(isWfUid) && new Set(x).size === x.length,
  dueDays: (x) => x === null || (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= L.dueDays), x: isCoord, y: isCoord,
}, ['id', 'label']);
const isEdge = (v: unknown) => isObj(v) && fieldsOk(v as Record<string, unknown>, { id: isWfId, from: isWfId, to: isWfId, mode: (x) => x === 'auto' || x === 'manual' }, ['id', 'from', 'to', 'mode']);
const isStart = (v: unknown) => isObj(v) && fieldsOk(v as Record<string, unknown>, {
  mode: (x) => x === 'manual' || x === 'auto', nodeId: (x) => x === null || isWfId(x), stackId: isIdOrNull, boardId: isIdOrNull, x: isCoord, y: isCoord,
}, ['mode']);
/** Shape + referential checks only; graph rules (loops, auto → choose, lists) stay with the server. */
export const isValidWorkflowGraph = (v: unknown): v is WorkflowGraph => {
  if (!isObj(v)) return false;
  const o = v as Record<string, unknown>;
  if (!hasOnly(o, ['start', 'nodes', 'edges']) || !isStart(o.start) || !Array.isArray(o.nodes) || !Array.isArray(o.edges)) return false;
  if (o.nodes.length > L.nodes || o.edges.length > L.edges || !o.nodes.every(isNode) || !o.edges.every(isEdge)) return false;
  const ids = new Set((o.nodes as Array<{ id: string }>).map((n) => n.id));
  const edgeIds = new Set((o.edges as Array<{ id: string }>).map((e) => e.id));
  const start = o.start as { nodeId?: string | null };
  return ids.size === o.nodes.length && edgeIds.size === o.edges.length
    && (o.edges as Array<{ from: string; to: string }>).every((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
    && (start.nodeId === undefined || start.nodeId === null || ids.has(start.nodeId));
};
const isCategory = (x: unknown) => (WORKFLOW_CATEGORIES as readonly unknown[]).includes(x);
const isDueDay = (x: unknown) => x === null || isCalendarDay(x);
export const isValidWorkflowInput = (v: unknown): v is WorkflowInput =>
  isObj(v) && fieldsOk(v as Record<string, unknown>, { title: isTitle(L.title), description: isStr(L.description), category: isCategory, graph: isValidWorkflowGraph }, ['title']);
export const isValidWorkflowPatch = (v: unknown): v is WorkflowPatch =>
  isObj(v) && Object.keys(v as object).length > 1
  && fieldsOk(v as Record<string, unknown>, { version: isVersion, title: isTitle(L.title), description: isStr(L.description), category: isCategory, enabled: (x) => typeof x === 'boolean', graph: isValidWorkflowGraph }, ['version']);
export const isValidWorkflowStart = (v: unknown): v is WorkflowStartInput =>
  isObj(v) && fieldsOk(v as Record<string, unknown>, { title: isStr(L.title), cardId: isInt, assigneeUid: (x) => x === null || isWfUid(x), description: isStr(L.description), dueDate: isDueDay }, []);
export const isValidHandoffInput = (v: unknown): v is WorkflowHandoffInput =>
  isObj(v) && fieldsOk(v as Record<string, unknown>, { assigneeUid: (x) => x === null || isWfUid(x), title: isStr(L.stepTitle), description: isStr(L.stepDescription), dueDate: isDueDay }, []);

// ---- AI wire validation: exact body shape, server limits and per-action rules (`AiRequestService`) ----
const isIdList = (max: number) => (x: unknown) => Array.isArray(x) && x.length <= max && x.every(isInt) && new Set(x).size === x.length;
const isAiScope = (v: unknown) => isObj(v) && fieldsOk(v as Record<string, unknown>, {
  cardIds: isIdList(AI_LIMITS.cardIds), boardIds: isIdList(AI_LIMITS.boardIds), stackId: isInt, includeComments: (x) => typeof x === 'boolean',
}, ['cardIds', 'boardIds']);
export const isValidAiRequestInput = (v: unknown): v is AiRequestInput =>
  isObj(v)
  && fieldsOk(v as Record<string, unknown>, { action: (x) => (AI_ACTIONS as readonly unknown[]).includes(x), scope: isAiScope, message: isStr(AI_LIMITS.message) }, ['action', 'scope'])
  && aiInputError(v as AiRequestInput) === null;
const isAiRequestId = (v: unknown) => typeof v === 'string' && AI_REQUEST_ID_RE.test(v);
/** The server requires a UUID Idempotency-Key for AI create/accept. */
const isUuidKey = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ---- Talk wire validation ----
/** Talk route requirement is `[a-z0-9]{4,30}`. */
const isToken = (v: unknown) => typeof v === 'string' && /^[a-z0-9]{4,30}$/.test(v);
export const isValidRoomPatch = (v: unknown): v is RoomPatch =>
  isObj(v) && Object.keys(v as object).length > 0
  && fieldsOk(v as Record<string, unknown>, { name: isTitle(TALK_LIMITS.roomName), description: isStr(TALK_LIMITS.description) }, []);

const isTransferId = (v: unknown) => typeof v === 'string' && TRANSFER_ID_RE.test(v);
const isReferenceId = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const isValidShareFileOptions = (v: unknown): v is ShareFileOptions =>
  isObj(v) && fieldsOk(v as Record<string, unknown>, {
    transferId: isTransferId, referenceId: isReferenceId, caption: isStr(FILE_LIMITS.caption), replyTo: isInt, voice: (x) => typeof x === 'boolean',
  }, ['transferId', 'referenceId']);

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
  talkRoom: (a) => a.length === 2 && isAccountId(a[0]) && isToken(a[1]),
  editMessage: (a) => a.length === 4 && isAccountId(a[0]) && isToken(a[1]) && isInt(a[2]) && isTitle(TALK_LIMITS.message)(a[3]),
  deleteMessage: (a) => a.length === 3 && isAccountId(a[0]) && isToken(a[1]) && isInt(a[2]),
  react: (a) => a.length === 5 && isAccountId(a[0]) && isToken(a[1]) && isInt(a[2]) && isReaction(a[3]) && typeof a[4] === 'boolean',
  reactions: (a) => a.length === 3 && isAccountId(a[0]) && isToken(a[1]) && isInt(a[2]),
  mentions: (a) => a.length === 3 && isAccountId(a[0]) && isToken(a[1]) && isStr(64)(a[2]),
  searchMessages: (a) => a.length === 4 && isAccountId(a[0]) && isTitle(TALK_LIMITS.searchTerm)(a[1]) && (a[2] === null || isToken(a[2])) && (a[3] === null || isInt(a[3])),
  createRoom: (a) => a.length === 3 && isAccountId(a[0]) && (a[1] === 'group' || a[1] === 'public') && isTitle(TALK_LIMITS.roomName)(a[2]),
  updateRoom: (a) => a.length === 3 && isAccountId(a[0]) && isToken(a[1]) && isValidRoomPatch(a[2]),
  participants: (a) => a.length === 2 && isAccountId(a[0]) && isToken(a[1]),
  inviteCandidates: (a) => a.length === 3 && isAccountId(a[0]) && isToken(a[1]) && isStr(64)(a[2]),
  addParticipant: (a) => a.length === 4 && isAccountId(a[0]) && isToken(a[1]) && (a[2] === 'users' || a[2] === 'groups') && isUid(a[3]),
  removeParticipant: (a) => a.length === 3 && isAccountId(a[0]) && isToken(a[1]) && isInt(a[2]),
  setModerator: (a) => a.length === 4 && isAccountId(a[0]) && isToken(a[1]) && isInt(a[2]) && typeof a[3] === 'boolean',
  leaveRoom: (a) => a.length === 2 && isAccountId(a[0]) && isToken(a[1]),
  deleteRoom: (a) => a.length === 2 && isAccountId(a[0]) && isToken(a[1]),
  shareFile: (a) => a.length === 4 && isAccountId(a[0]) && isToken(a[1]) && typeof a[2] === 'string' && FILE_HANDLE_RE.test(a[2]) && isValidShareFileOptions(a[3]),
  downloadFile: (a) => a.length === 5 && isAccountId(a[0]) && isToken(a[1]) && isInt(a[2]) && (a[3] === 'save' || a[3] === 'open') && isTransferId(a[4]),
  voiceClip: (a) => a.length === 3 && isAccountId(a[0]) && isToken(a[1]) && isInt(a[2]),
  transfer: (a) => a.length === 1 && isTransferId(a[0]),
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
  goals: (a) => (a.length === 1 || a.length === 2) && isAccountId(a[0]) && (a[1] === undefined || isValidGoalFilter(a[1])),
  goalDetail: (a) => a.length === 2 && isAccountId(a[0]) && isInt(a[1]),
  goalCreate: (a) => a.length === 2 && isAccountId(a[0]) && isValidGoalInput(a[1]),
  goalUpdate: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isValidGoalPatch(a[2]),
  goalDelete: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isVersion(a[2]),
  goalTransfer: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isVersion(a[2]) && isUid(a[3]),
  goalTargetAdd: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isValidTargetInput(a[2]),
  goalTargetUpdate: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && isValidTargetPatch(a[3]),
  goalTargetDelete: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && isVersion(a[3]),
  goalCheckin: (a) => a.length === 5 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && isValidCheckin(a[3]) && isKey(a[4]),
  goalCheckins: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]),
  goalSetCards: (a) => a.length === 5 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && isVersion(a[3]) && isCardIds(a[4]),
  cardGoals: (a) => a.length === 2 && isAccountId(a[0]) && isInt(a[1]),
  cardLinkGoal: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]),
  cardUnlinkGoal: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && isInt(a[3]),
  projectGantt: (a) => a.length === 2 && isAccountId(a[0]) && isInt(a[1]),
  projectActivity: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isValidActivityFilter(a[2]) && isCursor(a[3]),
  workload: (a) => a.length === 2 && isAccountId(a[0]) && isValidWorkloadQuery(a[1]),
  dashboards: (a) => a.length === 2 && isAccountId(a[0]) && (a[1] === null || isCursor(a[1])),
  dashboardWidgetTypes: (a) => a.length === 1 && isAccountId(a[0]),
  dashboard: (a) => a.length === 2 && isAccountId(a[0]) && isInt(a[1]),
  dashboardCreate: (a) => a.length === 3 && isAccountId(a[0]) && isValidDashboardInput(a[1]) && isKey(a[2]),
  dashboardUpdate: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isValidDashboardPatch(a[2]),
  dashboardDelete: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isVersion(a[2]),
  dashboardWidgetAdd: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isValidWidgetInput(a[2]),
  dashboardWidgetUpdate: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && isValidWidgetPatch(a[3]),
  dashboardWidgetDelete: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]),
  dashboardQuery: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isValidDashboardQuery(a[2]),
  dashboardDrilldown: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && isValidDrilldownOptions(a[3]),
  dashboardCsv: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && (a[3] === null || isValidDashboardFilter(a[3])),
  workflows: (a) => a.length === 1 && isAccountId(a[0]),
  workflowSamples: (a) => a.length === 1 && isAccountId(a[0]),
  workflow: (a) => a.length === 2 && isAccountId(a[0]) && isInt(a[1]),
  workflowCreate: (a) => a.length === 3 && isAccountId(a[0]) && isValidWorkflowInput(a[1]) && isKey(a[2]),
  workflowUpdate: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isValidWorkflowPatch(a[2]),
  workflowDelete: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isVersion(a[2]),
  workflowStart: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isValidWorkflowStart(a[2]) && isKey(a[3]),
  workflowRuns: (a) => a.length === 2 && isAccountId(a[0]) && isInt(a[1]),
  workflowRun: (a) => a.length === 2 && isAccountId(a[0]) && isInt(a[1]),
  workflowCancel: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isVersion(a[2]),
  workflowHandoffs: (a) => a.length === 1 && isAccountId(a[0]),
  cardWorkflowHandoffs: (a) => a.length === 2 && isAccountId(a[0]) && isInt(a[1]),
  workflowHandoff: (a) => a.length === 5 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && isValidHandoffInput(a[3]) && isKey(a[4]),
  workflowSkip: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isInt(a[2]) && isStr(L.skipReason)(a[3]),
  aiStatus: (a) => a.length === 1 && isAccountId(a[0]),
  aiRequests: (a) => a.length === 1 && isAccountId(a[0]),
  aiCreate: (a) => a.length === 3 && isAccountId(a[0]) && isValidAiRequestInput(a[1]) && isUuidKey(a[2]),
  aiRequest: (a) => a.length === 2 && isAccountId(a[0]) && isAiRequestId(a[1]),
  aiCancel: (a) => a.length === 2 && isAccountId(a[0]) && isAiRequestId(a[1]),
  aiProposal: (a) => a.length === 2 && isAccountId(a[0]) && isInt(a[1]),
  aiAccept: (a) => a.length === 4 && isAccountId(a[0]) && isInt(a[1]) && isVersion(a[2]) && isUuidKey(a[3]),
  aiDismiss: (a) => a.length === 3 && isAccountId(a[0]) && isInt(a[1]) && isVersion(a[2]),
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
