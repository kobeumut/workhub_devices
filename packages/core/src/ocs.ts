import type { ServerBase } from './serverUrl';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type OcsErrorKind =
  | 'unauthorized' // 401: app password revoked/invalid → re-login
  | 'forbidden' // 403: no permission / feature gate
  | 'not_found' // 404: stale or removed object
  | 'conflict' // 409/412: concurrent change, refresh and let the user retry
  | 'rate_limited' // 429: honour retryAfterMs
  | 'client' // other 4xx
  | 'server' // 5xx
  | 'redirect' // never follow redirects with credentials
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'invalid_response';

export class OcsError extends Error {
  constructor(
    readonly kind: OcsErrorKind,
    readonly status?: number,
    readonly ocsMessage?: string,
    readonly retryAfterMs?: number,
    /** App-specific code, e.g. Workhub `ocs.data.error` (`TASK_NOT_FOUND`, `PASSWORD_CONFIRMATION_REQUIRED`). */
    readonly errorCode?: string,
  ) {
    super(`OCS ${kind}${status ? ` (${status})` : ''}`);
    this.name = 'OcsError';
  }
  /** Safe to replay automatically? Only for idempotent reads. */
  get transient(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'server' || this.kind === 'rate_limited';
  }
}

export interface OcsCredentials {
  loginName: string;
  appPassword: string;
}

export interface OcsClientOptions {
  serverBase: ServerBase;
  /** Read lazily so the secret is held for the shortest time and never stored on the client. */
  getCredentials: () => Promise<OcsCredentials>;
  fetch?: FetchLike;
  timeoutMs?: number;
  userAgent?: string;
}

export type QueryValue = string | number | boolean | undefined | null | ReadonlyArray<string | number>;

export interface OcsRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OcsResponse<T> {
  status: number;
  /** `null` on 304 Not Modified / 204 No Content. */
  data: T | null;
  headers: Headers;
}

export function encodeBasicAuth(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Only relative, already-encoded API paths are accepted; absolute URLs never get credentials. */
export function assertSafeApiPath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || /(^|\/)\.\.?(\/|$)/.test(path) || /[\s?#\\]/.test(path)) {
    throw new OcsError('client', undefined, 'unsafe api path');
  }
}

export function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) params.append(`${key}[]`, String(v));
    else params.append(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function kindForStatus(status: number): OcsErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409 || status === 412) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'client';
}

interface OcsEnvelope {
  ocs?: { meta?: { status?: string; statuscode?: number; message?: string }; data?: unknown };
}

function appErrorCode(envelope: OcsEnvelope | undefined): string | undefined {
  const data = envelope?.ocs?.data as { error?: unknown } | null | undefined;
  return data && typeof data === 'object' && typeof data.error === 'string' ? data.error : undefined;
}

export class OcsClient {
  readonly serverBase: ServerBase;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: OcsClientOptions) {
    this.serverBase = options.serverBase;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Authenticated fetch to a relative path on THIS server only: no redirects followed, no
   * cookies, bounded time. Shared by OCS calls and plain app downloads (CSV).
   */
  private async send(path: string, req: OcsRequest, accept: string, query: Record<string, QueryValue>): Promise<Response> {
    assertSafeApiPath(path);
    const { loginName, appPassword } = await this.options.getCredentials();
    const headers: Record<string, string> = {
      Accept: accept,
      'OCS-APIRequest': 'true',
      Authorization: encodeBasicAuth(loginName, appPassword),
      ...(this.options.userAgent ? { 'User-Agent': this.options.userAgent } : {}),
      ...req.headers,
    };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }
    const url = `${this.serverBase}${path}${buildQuery(query)}`;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, req.timeoutMs ?? this.timeoutMs);
    const onAbort = () => controller.abort();
    if (req.signal?.aborted) controller.abort();
    req.signal?.addEventListener('abort', onAbort);

    let res: Response;
    try {
      const init: RequestInit = {
        method: req.method ?? 'GET',
        headers,
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
      };
      if (body !== undefined) init.body = body;
      res = await this.fetchFn(url, init);
    } catch {
      throw new OcsError(timedOut ? 'timeout' : req.signal?.aborted ? 'aborted' : 'network');
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }

    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400 && res.status !== 304)) {
      throw new OcsError('redirect', res.status || undefined);
    }
    // React Native's fetch cannot disable redirects (OkHttp/NSURLSession follow them). Detect a
    // followed redirect after the fact and refuse the response; OkHttp already strips the
    // Authorization header on cross-host redirects.
    if (res.redirected || (res.url && !res.url.startsWith(`${this.serverBase}/`))) {
      throw new OcsError('redirect', res.status || undefined);
    }
    return res;
  }

  /**
   * Non-OCS app route returning a file body (e.g. Workhub `/apps/workhub/csv/time`). Errors come
   * back as plain JSON `{error, message}`; they are mapped to `OcsError` like OCS failures.
   */
  async download(path: string, req: Omit<OcsRequest, 'method' | 'body'> = {}): Promise<{ text: string; contentType: string }> {
    const res = await this.send(path, { ...req, method: 'GET' }, 'text/csv, application/json;q=0.5', req.query ?? {});
    const contentType = res.headers.get('Content-Type') ?? '';
    if (!res.ok || contentType.includes('application/json')) {
      let err: { error?: unknown; message?: unknown } | undefined;
      try {
        err = (await res.json()) as typeof err;
      } catch {
        err = undefined;
      }
      throw new OcsError(
        res.ok ? 'invalid_response' : kindForStatus(res.status),
        res.status,
        typeof err?.message === 'string' ? err.message : undefined,
        parseRetryAfter(res.headers.get('Retry-After')),
        typeof err?.error === 'string' ? err.error : undefined,
      );
    }
    return { text: await res.text(), contentType };
  }

  async request<T>(path: string, req: OcsRequest = {}): Promise<OcsResponse<T>> {
    const res = await this.send(path, req, 'application/json', { format: 'json', ...req.query });
    if (res.status === 304 || res.status === 204) return { status: res.status, data: null, headers: res.headers };

    let envelope: OcsEnvelope | undefined;
    try {
      envelope = (await res.json()) as OcsEnvelope;
    } catch {
      envelope = undefined;
    }
    const meta = envelope?.ocs?.meta;
    if (!res.ok) {
      throw new OcsError(
        kindForStatus(res.status),
        res.status,
        meta?.message,
        parseRetryAfter(res.headers.get('Retry-After')),
        appErrorCode(envelope),
      );
    }
    if (!envelope?.ocs || typeof envelope.ocs !== 'object') throw new OcsError('invalid_response', res.status);
    // OCS v1 reports failures in meta with HTTP 200; v2 mirrors HTTP status. Check both.
    if (meta?.status === 'failure' || (meta?.statuscode !== undefined && meta.statuscode !== 100 && meta.statuscode >= 300)) {
      const code = meta.statuscode ?? 400;
      throw new OcsError(kindForStatus(code === 997 ? 401 : code === 998 ? 404 : code), res.status, meta.message, undefined, appErrorCode(envelope));
    }
    return { status: res.status, data: (envelope.ocs.data ?? null) as T | null, headers: res.headers };
  }

  async get<T>(path: string, req: Omit<OcsRequest, 'method' | 'body'> = {}): Promise<T> {
    const r = await this.request<T>(path, { ...req, method: 'GET' });
    if (r.data === null) throw new OcsError('invalid_response', r.status);
    return r.data;
  }
}
