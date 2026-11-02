import { safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { PlainStore, SecretStore } from '@workhub-devices/core';

/** Atomic JSON map file (write to temp + rename). */
class JsonFile {
  private cache: Record<string, string> | null = null;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  async read(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await fs.readFile(this.path, 'utf8'));
    } catch {
      this.cache = {};
    }
    return this.cache!;
  }
  async update(fn: (m: Record<string, string>) => void): Promise<void> {
    this.chain = this.chain.then(async () => {
      const m = { ...(await this.read()) };
      fn(m);
      const tmp = `${this.path}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(m), { mode: 0o600 });
      await fs.rename(tmp, this.path);
      this.cache = m;
    });
    return this.chain;
  }
}

export class SecureStoreUnavailableError extends Error {
  constructor() {
    super('OS credential store unavailable');
    this.name = 'SecureStoreUnavailableError';
  }
}

/**
 * App passwords encrypted with the OS credential store via Electron safeStorage
 * (macOS Keychain, Windows DPAPI, Linux libsecret/KWallet). If only Chromium's hard-coded
 * "basic_text" key is available on Linux, storing is REFUSED (no silent plain-text fallback),
 * unless the explicit test flag WORKHUB_TEST_INSECURE_STORE=1 is set by an automated test.
 */
export function createSecretStore(dir: string): SecretStore & { available(): boolean } {
  const file = new JsonFile(join(dir, 'secrets.json'));
  const insecureTest = process.env.WORKHUB_TEST_INSECURE_STORE === '1';
  const available = () => {
    if (insecureTest) return true;
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  };
  return {
    available,
    async get(key) {
      const v = (await file.read())[key];
      if (!v) return null;
      if (insecureTest && v.startsWith('test:')) return Buffer.from(v.slice(5), 'base64').toString('utf8');
      if (!available()) throw new SecureStoreUnavailableError();
      return safeStorage.decryptString(Buffer.from(v, 'base64'));
    },
    async set(key, value) {
      if (!available()) throw new SecureStoreUnavailableError();
      const enc = insecureTest ? `test:${Buffer.from(value, 'utf8').toString('base64')}` : safeStorage.encryptString(value).toString('base64');
      await file.update((m) => {
        m[key] = enc;
      });
    },
    async delete(key) {
      await file.update((m) => {
        delete m[key];
      });
    },
  };
}

export function createPlainStore(dir: string): PlainStore {
  const file = new JsonFile(join(dir, 'state.json'));
  return {
    async get(key) {
      return (await file.read())[key] ?? null;
    },
    async set(key, value) {
      await file.update((m) => {
        m[key] = value;
      });
    },
    async delete(key) {
      await file.update((m) => {
        delete m[key];
      });
    },
    async deletePrefix(prefix) {
      await file.update((m) => {
        for (const k of Object.keys(m)) if (k.startsWith(prefix)) delete m[k];
      });
    },
  };
}
