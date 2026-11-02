import type { FetchLike } from './ocs';
import { isWithinServer, normalizeServerUrl, sameOrigin, type NormalizeOptions, type ServerBase } from './serverUrl';

/** Nextcloud Login Flow v2 (per-device app password; the user's main password never touches the app). */
export class LoginFlowError extends Error {
  constructor(
    readonly code: 'start_failed' | 'untrusted_endpoint' | 'cancelled' | 'expired' | 'network' | 'invalid_result',
    message: string,
  ) {
    super(message);
    this.name = 'LoginFlowError';
  }
}

export interface LoginFlowStart {
  /** Open in the system browser (never an embedded webview that could read the password). */
  loginUrl: string;
  pollEndpoint: string;
  pollToken: string;
}

export interface LoginResult {
  serverBase: ServerBase;
  loginName: string;
  appPassword: string;
}

export interface LoginFlowDeps {
  fetch?: FetchLike;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  userAgent?: string;
  urlOptions?: NormalizeOptions;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new LoginFlowError('cancelled', 'Giriş iptal edildi.'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export async function startLoginFlow(serverBase: ServerBase, deps: LoginFlowDeps = {}): Promise<LoginFlowStart> {
  const fetchFn = deps.fetch ?? ((i, init) => fetch(i, init));
  let res: Response;
  try {
    res = await fetchFn(`${serverBase}/index.php/login/v2`, {
      method: 'POST',
      headers: { Accept: 'application/json', ...(deps.userAgent ? { 'User-Agent': deps.userAgent } : {}) },
      redirect: 'manual',
      credentials: 'omit',
    });
  } catch {
    throw new LoginFlowError('network', 'Sunucuya ulaşılamadı.');
  }
  if (!res.ok) throw new LoginFlowError('start_failed', `Giriş başlatılamadı (${res.status}).`);
  const json = (await res.json().catch(() => null)) as { login?: unknown; poll?: { token?: unknown; endpoint?: unknown } } | null;
  const loginUrl = json?.login;
  const token = json?.poll?.token;
  const endpoint = json?.poll?.endpoint;
  if (typeof loginUrl !== 'string' || typeof token !== 'string' || typeof endpoint !== 'string' || !token) {
    throw new LoginFlowError('start_failed', 'Sunucu Login Flow v2 yanıtı geçersiz.');
  }
  // The poll token is a secret and the login page receives the password: both must stay on this server.
  if (!isWithinServer(serverBase, loginUrl) || !isWithinServer(serverBase, endpoint)) {
    throw new LoginFlowError('untrusted_endpoint', 'Giriş adresi sunucu dışına yönlendiriyor.');
  }
  return { loginUrl, pollEndpoint: endpoint, pollToken: token };
}

export async function pollLoginFlow(
  serverBase: ServerBase,
  start: LoginFlowStart,
  opts: { signal?: AbortSignal; intervalMs?: number; maxDurationMs?: number } & LoginFlowDeps = {},
): Promise<LoginResult> {
  const fetchFn = opts.fetch ?? ((i, init) => fetch(i, init));
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.maxDurationMs ?? 20 * 60_000); // server-side token lifetime is 20 min
  const interval = opts.intervalMs ?? 2_000;
  if (!isWithinServer(serverBase, start.pollEndpoint)) {
    throw new LoginFlowError('untrusted_endpoint', 'Giriş adresi sunucu dışına yönlendiriyor.');
  }

  while (now() < deadline) {
    if (opts.signal?.aborted) throw new LoginFlowError('cancelled', 'Giriş iptal edildi.');
    let res: Response | undefined;
    try {
      res = await fetchFn(start.pollEndpoint, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: start.pollToken }).toString(),
        redirect: 'manual',
        credentials: 'omit',
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch {
      if (opts.signal?.aborted) throw new LoginFlowError('cancelled', 'Giriş iptal edildi.');
      res = undefined; // transient network error: keep polling until the deadline
    }
    if (res?.status === 200) {
      const json = (await res.json().catch(() => null)) as { server?: unknown; loginName?: unknown; appPassword?: unknown } | null;
      if (typeof json?.server !== 'string' || typeof json.loginName !== 'string' || typeof json.appPassword !== 'string' || !json.appPassword) {
        throw new LoginFlowError('invalid_result', 'Sunucu giriş sonucu geçersiz.');
      }
      let returned: ServerBase;
      try {
        returned = normalizeServerUrl(json.server, opts.urlOptions);
      } catch {
        throw new LoginFlowError('invalid_result', 'Sunucu giriş sonucu geçersiz.');
      }
      // Never accept credentials bound to another origin than the one the user chose.
      if (!sameOrigin(returned, serverBase)) {
        throw new LoginFlowError('untrusted_endpoint', 'Sunucu farklı bir adres bildirdi.');
      }
      return { serverBase: returned, loginName: json.loginName, appPassword: json.appPassword };
    }
    // 404 = not yet authorised. Anything else is treated as transient until the deadline.
    await sleep(interval, opts.signal);
  }
  throw new LoginFlowError('expired', 'Giriş süresi doldu, tekrar deneyin.');
}

/** Revoke the app password on logout (best effort; caller wipes local state regardless). */
export async function revokeAppPassword(serverBase: ServerBase, authorization: string, fetchFn: FetchLike = (i, init) => fetch(i, init)): Promise<boolean> {
  try {
    const res = await fetchFn(`${serverBase}/ocs/v2.php/core/apppassword?format=json`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'OCS-APIRequest': 'true', Authorization: authorization },
      redirect: 'manual',
      credentials: 'omit',
    });
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}
