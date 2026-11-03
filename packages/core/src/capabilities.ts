import type { OcsClient } from './ocs';
import { callCapabilitiesOf, type CallCapabilities } from './call';

/** Raw `GET /ocs/v2.php/cloud/capabilities` data (only the parts we use). */
export interface RawServerCapabilities {
  version?: { major?: number; minor?: number; micro?: number; string?: string };
  capabilities?: {
    spreed?: { features?: unknown; config?: Record<string, unknown>; version?: string };
    notifications?: { 'ocs-endpoints'?: unknown; push?: unknown; 'admin-notifications'?: unknown };
    workhub?: { version?: string; apiVersion?: string; taskBackend?: string; modules?: Record<string, unknown> };
  };
}

export interface ServerCapabilities {
  nextcloudMajor: number | null;
  nextcloudVersion: string | null;
  talk: {
    available: boolean; version: string | null; features: ReadonlySet<string>; canCreate: boolean;
    /** `config.attachments`: may this user upload/share files, and where (e.g. `/Talk`). */
    attachments: { allowed: boolean; folder: string | null };
    /** Audio/video calls (`config.call.enabled` + `audio`/`video`/`signaling-v3`). */
    call: CallCapabilities;
  };
  notifications: { available: boolean; endpoints: ReadonlySet<string>; push: ReadonlySet<string> };
  /** Instance-wide Workhub info. NOT a per-user permission: use `getWorkhubBootstrap` for that. */
  workhub: { installed: boolean; version: string | null; apiVersion: string | null };
}

const strings = (v: unknown): Set<string> => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function attachmentsOf(raw: unknown): { allowed: boolean; folder: string | null } {
  const a = (raw ?? {}) as Record<string, unknown>;
  const folder = typeof a.folder === 'string' && a.folder.trim() && !a.folder.split('/').some((p) => p === '..' || p === '.') ? a.folder : null;
  // Fail closed: no folder → nowhere to upload.
  return { allowed: a.allowed === true && folder !== null, folder };
}

export function parseServerCapabilities(raw: RawServerCapabilities): ServerCapabilities {
  const caps = raw.capabilities ?? {};
  const talkFeatures = strings(caps.spreed?.features);
  return {
    nextcloudMajor: typeof raw.version?.major === 'number' ? raw.version.major : null,
    nextcloudVersion: raw.version?.string ?? null,
    talk: {
      available: talkFeatures.size > 0,
      version: caps.spreed?.version ?? null,
      features: talkFeatures,
      // `conversations.can-create` (admin may restrict creation to groups); missing → false (fail closed)
      canCreate: (caps.spreed?.config?.conversations as Record<string, unknown> | undefined)?.['can-create'] === true,
      attachments: attachmentsOf(caps.spreed?.config?.attachments),
      call: callCapabilitiesOf(talkFeatures, caps.spreed?.config?.call),
    },
    notifications: {
      available: !!caps.notifications,
      endpoints: strings(caps.notifications?.['ocs-endpoints']),
      push: strings(caps.notifications?.push),
    },
    workhub: {
      installed: !!caps.workhub,
      version: caps.workhub?.version ?? null,
      apiVersion: caps.workhub?.apiVersion ?? null,
    },
  };
}

export const REQUIRED_TALK_FEATURES = ['conversation-v4', 'chat-v2'] as const;

export type CompatibilityIssue =
  | { kind: 'talk_missing' }
  | { kind: 'talk_feature_missing'; feature: string }
  | { kind: 'notifications_missing' }
  | { kind: 'workhub_missing' }
  | { kind: 'workhub_api_unsupported'; apiVersion: string | null };

/** Empty list = the account is usable. Issues are shown on the "incompatible server" screen. */
export function checkCompatibility(caps: ServerCapabilities): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (!caps.talk.available) issues.push({ kind: 'talk_missing' });
  else for (const f of REQUIRED_TALK_FEATURES) if (!caps.talk.features.has(f)) issues.push({ kind: 'talk_feature_missing', feature: f });
  if (!caps.notifications.available) issues.push({ kind: 'notifications_missing' });
  if (!caps.workhub.installed) issues.push({ kind: 'workhub_missing' });
  else if (caps.workhub.apiVersion !== '1') issues.push({ kind: 'workhub_api_unsupported', apiVersion: caps.workhub.apiVersion });
  return issues;
}

/** Talk feature checks used to hide unsupported UI instead of failing at click time. */
export const talkSupports = (caps: ServerCapabilities, feature: string) => caps.talk.features.has(feature);

export const WORKHUB_MODULES = ['projects', 'dashboard', 'ai', 'goals', 'time', 'requests'] as const;
export type WorkhubModule = (typeof WORKHUB_MODULES)[number];

/** Per-user `GET /apps/workhub/api/v1/capabilities` (Workhub BootstrapState). */
export interface WorkhubBootstrap {
  apiVersion: string;
  user: { uid: string; displayName: string; isAdmin: boolean; timezone: string };
  modules: Record<WorkhubModule, boolean>;
  permissions: { canViewTeamReport: boolean };
  backend: 'deck' | 'native';
}

export function parseWorkhubBootstrap(raw: unknown): WorkhubBootstrap {
  const r = (raw ?? {}) as Record<string, any>;
  const modules = {} as Record<WorkhubModule, boolean>;
  // Unknown/missing module = disabled (fail closed).
  for (const m of WORKHUB_MODULES) modules[m] = r.modules?.[m] === true;
  return {
    apiVersion: String(r.apiVersion ?? ''),
    user: {
      uid: String(r.user?.uid ?? ''),
      displayName: String(r.user?.displayName ?? r.user?.uid ?? ''),
      isAdmin: r.user?.isAdmin === true,
      timezone: String(r.user?.timezone ?? 'UTC'),
    },
    modules,
    permissions: { canViewTeamReport: r.permissions?.canViewTeamReport === true },
    backend: r.deck?.backend === 'deck' ? 'deck' : 'native',
  };
}

export async function fetchServerCapabilities(client: OcsClient): Promise<ServerCapabilities> {
  return parseServerCapabilities(await client.get<RawServerCapabilities>('/ocs/v2.php/cloud/capabilities'));
}

export async function fetchWorkhubBootstrap(client: OcsClient): Promise<WorkhubBootstrap> {
  return parseWorkhubBootstrap(await client.get<unknown>('/ocs/v2.php/apps/workhub/api/v1/capabilities'));
}
