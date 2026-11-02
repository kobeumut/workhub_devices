import { encodeBasicAuth, OcsClient, type FetchLike } from './ocs';
import { revokeAppPassword, type LoginResult } from './loginFlow';
import type { ServerBase } from './serverUrl';

export type AccountId = string & { readonly __brand: 'AccountId' };

export interface Account {
  id: AccountId;
  serverBase: ServerBase;
  loginName: string;
}

/**
 * Platform secret storage: iOS Keychain / Android Keystore / OS credential store in the
 * Electron main process. Implementations MUST NOT fall back to plain-text storage.
 */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function accountIdFor(serverBase: ServerBase, loginName: string): AccountId {
  return `${encodeURIComponent(loginName)}|${serverBase}` as AccountId;
}

/** Every cache/draft/notification key is namespaced by account so equal room/card ids never collide. */
export function scopedKey(accountId: AccountId, ...parts: ReadonlyArray<string | number>): string {
  return [accountId, ...parts.map((p) => encodeURIComponent(String(p)))].join('::');
}

const secretKey = (id: AccountId) => scopedKey(id, 'app-password');

export async function addAccount(store: SecretStore, login: LoginResult): Promise<Account> {
  const account: Account = {
    id: accountIdFor(login.serverBase, login.loginName),
    serverBase: login.serverBase,
    loginName: login.loginName,
  };
  await store.set(secretKey(account.id), login.appPassword);
  return account;
}

export class MissingCredentialError extends Error {
  constructor() {
    super('Hesap için kayıtlı kimlik bilgisi yok; tekrar giriş gerekli.');
    this.name = 'MissingCredentialError';
  }
}

export function createAccountClient(account: Account, store: SecretStore, opts: { fetch?: FetchLike; userAgent?: string } = {}): OcsClient {
  return new OcsClient({
    serverBase: account.serverBase,
    getCredentials: async () => {
      const appPassword = await store.get(secretKey(account.id));
      if (!appPassword) throw new MissingCredentialError();
      return { loginName: account.loginName, appPassword };
    },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
  });
}

export interface LogoutReport {
  pushDeregistered: boolean | 'skipped';
  appPasswordRevoked: boolean;
  localWiped: true;
}

/**
 * Logout never blocks on the network: remote cleanup is best-effort and reported,
 * local secret + caches of THIS account are always wiped; other accounts are untouched.
 */
export async function logout(
  account: Account,
  store: SecretStore,
  deps: {
    fetch?: FetchLike;
    deregisterPush?: (account: Account) => Promise<boolean>;
    wipeLocalData: (accountId: AccountId) => Promise<void>;
  },
): Promise<LogoutReport> {
  const appPassword = await store.get(secretKey(account.id));
  let pushDeregistered: boolean | 'skipped' = 'skipped';
  if (deps.deregisterPush && appPassword) pushDeregistered = await deps.deregisterPush(account).catch(() => false);
  const appPasswordRevoked = appPassword
    ? await revokeAppPassword(account.serverBase, encodeBasicAuth(account.loginName, appPassword), deps.fetch)
    : false;
  await store.delete(secretKey(account.id));
  await deps.wipeLocalData(account.id);
  return { pushDeregistered, appPasswordRevoked, localWiped: true };
}
