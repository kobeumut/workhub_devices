import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { AppRoute, PlainStore, SecretStore } from '@workhub-devices/core';

/**
 * Bridge to the platform module (android: WorkhubNativeModule.kt, ios: WorkhubNative.swift).
 * Secrets live in Android Keystore / iOS Keychain (shared with the notification extension) so
 * native push handling and quick reply work while JS is not running.
 */
interface WorkhubNativeSpec {
  secretGet(key: string): Promise<string | null>;
  secretSet(key: string, value: string): Promise<void>;
  secretDelete(key: string): Promise<void>;
  plainGet(key: string): Promise<string | null>;
  plainSet(key: string, value: string): Promise<void>;
  plainDelete(key: string): Promise<void>;
  plainDeletePrefix(prefix: string): Promise<void>;
  pushPrepare(tag: string, serverBase: string, loginName: string, secretKey: string): Promise<{ publicKey: string; auth: string; fcmToken: string | null }>;
  pushForget(tag: string): Promise<void>;
  consumeInitialRoute(): Promise<string | null>;
  setForeground(tag: string | null, roomToken: string | null): void;
  requestNotificationPermission(): Promise<boolean>;
  /** System share sheet for a generated export; resolves 'saved' once handed to the OS. */
  shareFile(filename: string, content: string, mime: string): Promise<'saved' | 'cancelled'>;
  // Talk attachments (Android, TalkFiles.kt). Optional: absent on platforms without them → UI hides.
  filePick?(): Promise<Array<{ id: string; name: string; size: number; mime: string }>>;
  fileStat?(id: string): Promise<{ id: string; name: string; size: number; mime: string } | null>;
  fileRead?(id: string, offset: number, length: number): Promise<string>;
  fileRelease?(id: string): void;
  sinkOpen?(name: string): Promise<string>;
  sinkWrite?(id: string, base64: string): Promise<void>;
  sinkFinish?(id: string, mime: string, mode: 'save' | 'open'): Promise<'saved' | 'opened' | 'cancelled'>;
  sinkAbort?(id: string): void;
  voiceStart?(): Promise<void>;
  voiceStop?(name: string): Promise<{ id: string; name: string; size: number; mime: string } | null>;
  voiceCancel?(): void;
  audioPlay?(base64: string): Promise<void>;
  audioStop?(): void;
}

const mod = NativeModules.WorkhubNative as WorkhubNativeSpec | undefined;
if (!mod) throw new Error(`WorkhubNative module missing on ${Platform.OS}`);
export const native: WorkhubNativeSpec = mod;
export const nativeEvents = new NativeEventEmitter(NativeModules.WorkhubNative);

export const secretStore: SecretStore = {
  get: (k) => native.secretGet(k),
  set: (k, v) => native.secretSet(k, v),
  delete: (k) => native.secretDelete(k),
};

export const plainStore: PlainStore = {
  get: (k) => native.plainGet(k),
  set: (k, v) => native.plainSet(k, v),
  delete: (k) => native.plainDelete(k),
  deletePrefix: (p) => native.plainDeletePrefix(p),
};

/** Route events carry the opaque account tag + a JSON AppRoute produced natively. */
export interface NativeRoute {
  tag: string;
  route: AppRoute;
}

export function parseNativeRoute(raw: string | null): NativeRoute | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { tag?: unknown; route?: { name?: unknown; token?: unknown; cardId?: unknown } };
    if (typeof v.tag !== 'string' || !v.route) return null;
    const r = v.route;
    if (r.name === 'room' && typeof r.token === 'string' && /^[a-z0-9]{1,64}$/i.test(r.token)) return { tag: v.tag, route: { name: 'room', token: r.token } };
    if (r.name === 'task' && Number.isInteger(r.cardId) && (r.cardId as number) > 0) return { tag: v.tag, route: { name: 'task', cardId: r.cardId as number } };
    return { tag: v.tag, route: { name: 'inbox' } };
  } catch {
    return null;
  }
}
