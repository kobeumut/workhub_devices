import {
  createAccountClient, getVapidKey, registerWebPush, relayEndpoint, scopedKey, unregisterWebPush,
  type Account, type AccountSummary, type OcsClient,
} from '@workhub-devices/core';
import identity from '../../../config/app-identity.json';
import { native, plainStore, secretStore } from './native';

const RELAY_BASE: string = (identity.push as { relayBase?: string }).relayBase ?? '';
const tagKey = (a: { id: string }) => scopedKey(a.id as never, 'push-tag');

export type PushStatus = 'registered' | 'not-configured' | 'server-disabled' | 'no-permission' | 'error';

/** Stable opaque per-account tag (lets the device pick the right keys/credentials for a push). */
export async function accountTag(a: { id: string }): Promise<string> {
  let tag = await plainStore.get(tagKey(a));
  if (!tag) {
    tag = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await plainStore.set(tagKey(a), tag);
  }
  return tag;
}

/**
 * Register ONE Web Push subscription (appTypes=talk,workhub) for this account via the Firebase
 * relay. The activation push is handled natively (it has the credentials), so this works even if
 * the user closes the app right after login.
 */
export async function ensurePush(a: AccountSummary, webPushEnabledOnServer: boolean): Promise<PushStatus> {
  if (!RELAY_BASE) return 'not-configured';
  if (!webPushEnabledOnServer) return 'server-disabled';
  try {
    if (!(await native.requestNotificationPermission())) return 'no-permission';
    const tag = await accountTag(a);
    const keys = await native.pushPrepare(tag, a.serverBase, a.loginName, scopedKey(a.id, 'app-password'));
    if (!keys.fcmToken) return 'not-configured'; // Firebase config (google-services / APNs) not added yet
    const client = createAccountClient(a as Account, secretStore);
    const vapid = await getVapidKey(client);
    await registerWebPush(client, relayEndpoint(RELAY_BASE, keys.fcmToken, vapid, tag), keys);
    return 'registered';
  } catch {
    return 'error';
  }
}

export async function removePush(a: Account, client: OcsClient): Promise<boolean> {
  try {
    if (RELAY_BASE) await unregisterWebPush(client);
    return true;
  } catch {
    return false;
  } finally {
    await native.pushForget(await accountTag(a)).catch(() => undefined);
  }
}
