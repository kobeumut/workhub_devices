import type { FetchLike } from '../src/ocs';

export interface Call {
  url: string;
  init: RequestInit;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 || status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export const ocs = (data: unknown, statuscode = 200, status = 'ok') => ({ ocs: { meta: { status, statuscode, message: 'OK' }, data } });

/** Scripted fetch: responses are consumed in order; every call is recorded. */
export function scriptedFetch(...responses: Array<Response | Error | ((c: Call) => Response | Promise<Response>)>): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(call) : next;
  }) as FetchLike & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

export function headerOf(c: Call | undefined, name: string): string | undefined {
  return (c?.init.headers as Record<string, string> | undefined)?.[name];
}
