// Test helper: approves a Nextcloud Login Flow v2 the way a user would in the browser, using
// the documented "app token" path (POST /login/v2/apptoken with an existing app password).
// Usage: node approve-login.mjs <loginUrl> <user>   (password via WH_APPROVE_PASS env)
const [loginUrl, user] = process.argv.slice(2);
const password = process.env.WH_APPROVE_PASS;
if (!loginUrl || !user || !password) throw new Error('usage: approve-login.mjs <loginUrl> <user> (WH_APPROVE_PASS)');
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
async function req(url, init = {}) {
  let res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie: cookieHeader() } });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) return req(new URL(res.headers.get('location'), url).toString());
  return res;
}
const page = await (await req(loginUrl)).text();
const requesttoken = /data-requesttoken="([^"]+)"/.exec(page)?.[1];
const stateB64 = /id="initial-state-core-loginFlowAuth" value="([^"]+)"/.exec(page)?.[1];
if (!requesttoken || !stateB64) throw new Error('flow page format not recognised');
const { stateToken } = JSON.parse(Buffer.from(stateB64, 'base64').toString('utf8'));
const origin = new URL(loginUrl).origin;
const r = await req(`${origin}/login/v2/apptoken`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', requesttoken },
  body: new URLSearchParams({ stateToken, user, password, requesttoken }).toString(),
});
const done = await r.text();
if (r.status !== 200 || !/loginFlowState|done|Account connected/i.test(done)) throw new Error(`approve failed: HTTP ${r.status}`);
console.log('login flow approved');
