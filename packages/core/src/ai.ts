import { OcsError, type OcsClient } from './ocs';

/**
 * Workhub AI (OCS `/ai/…`, Workhub 0.5): personal requests that a server-side worker runs against
 * the admin-configured provider, plus single-use drafts ("proposals") the owner accepts or
 * dismisses. Protocol implementation; DTOs are re-declared from the server contract
 * (`AiController`, `AiRequestService`, `ProposalService`), no server code is copied.
 *
 * Trust: results are model output. They are plain text, never HTML/markup to execute; the UI
 * renders them as text only. The server re-authorizes every source on every read (restricted →
 * no content) and re-checks the Deck permission on acceptance.
 */
const BASE = '/ocs/v2.php/apps/workhub/api/v1';

export const AI_ACTIONS = ['card_summary', 'board_summary', 'question', 'create_card_draft', 'update_card_draft', 'suggest_checklist'] as const;
export type AiAction = (typeof AI_ACTIONS)[number];
/** Actions whose result is a draft (proposal) instead of a text answer. */
export const AI_DRAFT_ACTIONS: readonly AiAction[] = ['create_card_draft', 'update_card_draft', 'suggest_checklist'];

export type AiRequestState = 'accepted' | 'queued' | 'running' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled';
/** `AiStore::ACTIVE_STATES`: still being processed; poll with `pollAfterMs`. */
export const AI_ACTIVE_STATES: readonly AiRequestState[] = ['accepted', 'queued', 'running', 'cancel_requested'];
export type AiProposalState = 'ready' | 'accepted' | 'dismissed' | 'stale' | 'expired';

/** Server limits (`AiRequestService::validate`). */
export const AI_LIMITS = { message: 4000, cardIds: 20, boardIds: 5 } as const;

/** `GET /ai/status` — `module` is the per-user gate, `enabled`/`configured` the admin settings. */
export interface AiStatus {
  module: boolean;
  enabled: boolean;
  configured: boolean;
  providerName: string;
  includeCommentsDefault: boolean;
  quota: { period: string; dailyLimit: number; usedToday: number; remainingToday: number; maxConcurrent: number; inFlight: number };
}

/** Content-free list row (`GET /ai/requests`, last 50 of the caller). */
export interface AiRequestSummary {
  requestId: string;
  action: AiAction;
  state: AiRequestState;
  errorCode: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  cardCount: number;
  boardCount: number;
}

export interface AiRequestBase {
  requestId: string;
  action: AiAction;
  state: AiRequestState;
  errorCode: string | null;
  /** Server-translated (viewer language) explanation of `errorCode`. */
  errorMessage: string | null;
  providerConfigVersion: number;
  attempt: number;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Non-null while active: wait this long before the next read. */
  pollAfterMs: number | null;
}

export interface AiRequestDetail extends AiRequestBase {
  /** A source is no longer readable by the viewer: no message, result or sources are returned. */
  restricted: boolean;
  message: string | null;
  /** Plain-text model answer, only for `succeeded` text actions. */
  result: string | null;
  sources: Array<{ cardId: number; boardId: number; title: string; url: string; truncated: boolean }>;
  boards: Array<{ boardId: number; title: string }>;
  /** Context was cut to the provider limit (`omitted` sources left out). */
  truncated: boolean;
  omitted: number;
  proposal: { id: number; state: AiProposalState; version: number } | null;
}

export interface AiDraftFields {
  title?: string;
  description?: string;
  due?: string | null;
  /** Only for card creation drafts (board members / labels the server matched). */
  assignees?: Array<{ uid: string; displayName: string }>;
  labels?: Array<{ id: number; title: string; color: string }>;
  /** Checklist suggestions (already appended to `description` by the server). */
  items?: string[] | null;
}

export type AiProposalTarget =
  | { type: 'stack'; boardId: number; boardTitle: string; stackId: number; stackTitle: string | null; canEdit: boolean }
  | { type: 'card'; cardId: number; boardId: number; boardTitle: string; url: string; canEdit: boolean };

/** `GET /ai/proposals/{id}` — preview, re-authorized for the current viewer. */
export interface AiProposal {
  id: number;
  requestId: string | null;
  action: AiAction;
  state: AiProposalState;
  /** Optimistic lock for accept / dismiss. */
  version: number;
  createdAt: string | null;
  expiresAt: string | null;
  /** `card:<id>` once accepted. */
  resultRef: string | null;
  restricted: boolean;
  /** The target changed (card edited / column removed) since the draft was prepared. */
  stale: boolean;
  target: AiProposalTarget | null;
  proposed: AiDraftFields | null;
  current: { title: string; description: string; due: string | null } | null;
}

export interface AiAcceptResult {
  alreadyApplied: boolean;
  resultRef: string | null;
  cardId: number | null;
  url?: string;
  proposal: { id: number; state: 'accepted'; version: number };
}

/** Request body (`POST /ai/requests`); the client always sends the canonical list form. */
export interface AiRequestInput {
  action: AiAction;
  scope: { cardIds: number[]; boardIds: number[]; stackId?: number; includeComments?: boolean };
  message?: string;
}

export type AiInputError =
  | 'message_required'
  | 'message_too_long'
  | 'card_required'
  | 'one_card'
  | 'too_many_cards'
  | 'one_board'
  | 'too_many_boards'
  | 'no_board_allowed'
  | 'scope_required'
  | 'stack_required'
  | 'stack_not_allowed';

/**
 * Mirrors the server's per-action scope rules (`AiRequestService::validate`) so the form can say
 * what is missing before sending. The server stays the authority (it also checks current Deck
 * READ for every source, EDIT for drafts and that the column belongs to the board).
 */
export function aiInputError(input: AiRequestInput): AiInputError | null {
  const { cardIds, boardIds, stackId } = input.scope;
  const message = (input.message ?? '').trim();
  if (message.length > AI_LIMITS.message) return 'message_too_long';
  if (cardIds.length > AI_LIMITS.cardIds) return 'too_many_cards';
  if (boardIds.length > AI_LIMITS.boardIds) return 'too_many_boards';
  if (input.action !== 'create_card_draft' && stackId !== undefined) return 'stack_not_allowed';
  switch (input.action) {
    case 'card_summary':
      if (cardIds.length === 0) return 'card_required';
      if (boardIds.length) return 'no_board_allowed';
      return null;
    case 'board_summary':
      return boardIds.length === 1 && cardIds.length === 0 ? null : 'one_board';
    case 'question':
      if (!message) return 'message_required';
      return cardIds.length || boardIds.length ? null : 'scope_required';
    case 'create_card_draft':
      if (!message) return 'message_required';
      if (boardIds.length !== 1 || cardIds.length) return 'one_board';
      return stackId === undefined ? 'stack_required' : null;
    case 'update_card_draft':
      if (!message) return 'message_required';
      if (boardIds.length) return 'no_board_allowed';
      return cardIds.length === 1 ? null : 'one_card';
    case 'suggest_checklist':
      if (boardIds.length) return 'no_board_allowed';
      return cardIds.length === 1 ? null : 'one_card';
  }
}

export const isAiActive = (state: AiRequestState) => AI_ACTIVE_STATES.includes(state);
/** Request ids are server UUIDs (v4, lowercase); anything else never reaches the URL. */
export const AI_REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the owner may do with a proposal, derived only from the server's preview: accept needs a
 * `ready`, not stale, not restricted draft whose target the viewer can still edit; dismiss works
 * for `ready` and `stale` drafts (server CAS on `version`).
 */
export function proposalActions(p: Pick<AiProposal, 'state' | 'stale' | 'restricted' | 'target'>): { accept: boolean; dismiss: boolean } {
  const accept = p.state === 'ready' && !p.stale && !p.restricted && !!p.target?.canEdit;
  return { accept, dismiss: p.state === 'ready' || p.state === 'stale' };
}

/** Card id from a `card:<id>` result reference (accepted drafts). */
export const aiResultCardId = (ref: string | null | undefined): number | null => {
  const m = typeof ref === 'string' ? /^card:(\d+)$/.exec(ref) : null;
  return m ? Number(m[1]) : null;
};

const requestId = (id: string) => {
  if (!AI_REQUEST_ID_RE.test(id)) throw new OcsError('client', undefined, 'invalid request id');
  return id.toLowerCase();
};
const posId = (id: number) => {
  if (!Number.isInteger(id) || id <= 0) throw new OcsError('client', undefined, 'invalid id');
  return id;
};

export const aiApi = {
  status: (c: OcsClient) => c.get<AiStatus>(`${BASE}/ai/status`),
  list: async (c: OcsClient) => (await c.get<{ requests: AiRequestSummary[] }>(`${BASE}/ai/requests`)).requests,
  /** 202 Accepted; the worker runs it later. `Idempotency-Key` must be a UUID (server rule). */
  create: async (c: OcsClient, input: AiRequestInput, idempotencyKey: string) =>
    (await c.request<{ requestId: string; state: AiRequestState; pollAfterMs: number; providerConfigVersion: number }>(`${BASE}/ai/requests`, {
      method: 'POST',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
    })).data,
  get: (c: OcsClient, id: string) => c.get<AiRequestDetail>(`${BASE}/ai/requests/${requestId(id)}`),
  /** Queued → cancelled; running → `cancel_requested` (the worker stops it). */
  cancel: async (c: OcsClient, id: string) => (await c.request<AiRequestBase>(`${BASE}/ai/requests/${requestId(id)}/cancel`, { method: 'POST', body: {} })).data,
  proposal: (c: OcsClient, id: number) => c.get<AiProposal>(`${BASE}/ai/proposals/${posId(id)}`),
  /** Single application: a second acceptance returns the first result (`alreadyApplied`). */
  accept: async (c: OcsClient, id: number, version: number, idempotencyKey: string) =>
    (await c.request<AiAcceptResult>(`${BASE}/ai/proposals/${posId(id)}/accept`, { method: 'POST', body: { version }, headers: { 'Idempotency-Key': idempotencyKey } })).data,
  dismiss: async (c: OcsClient, id: number, version: number) =>
    (await c.request<{ id: number; state: 'dismissed'; version: number }>(`${BASE}/ai/proposals/${posId(id)}/dismiss`, { method: 'POST', body: { version } })).data,
};
