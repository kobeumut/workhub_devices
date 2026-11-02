import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountSummary, AppRoute, Backend, PickedFile, RoutedTarget } from '@workhub-devices/core';

/** Microphone → finished voice note (WAV, staged in the shell; the UI only gets a handle). */
export interface VoiceRecorder {
  /** Rejects when the microphone permission is denied or no input device exists. */
  start(): Promise<void>;
  /** `null` when the recording was too short/empty. */
  stop(): Promise<PickedFile | null>;
  cancel(): Promise<void>;
}

export interface AudioPlayback {
  stop(): void;
  /** Resolves when playback ends (or was stopped). */
  ended: Promise<void>;
}

/** Platform capabilities the shared UI needs; each shell implements these at its trust boundary. */
export interface PlatformServices {
  /** Open the Nextcloud login page in the SYSTEM browser (never an in-app webview). */
  openExternal(url: string): Promise<void>;
  /** Platform name for small UX differences (e.g. keyboard shortcuts). */
  kind: 'ios' | 'android' | 'desktop';
  /** Called after login/logout so the shell can (de)register push for that account. */
  onAccountsChanged?(accounts: AccountSummary[]): void;
  /** Lets the shell suppress OS banners for the chat that is open on screen. */
  onForegroundRoute?(target: RoutedTarget | null): void;
  /** Subscribe to routes coming from notifications / deep links. Returns an unsubscribe. */
  subscribeRoutes?(cb: (target: RoutedTarget) => void): () => void;
  appVersion?: string;
  /**
   * Hand a generated file (e.g. a CSV export) to the OS: desktop shows a save dialog, mobile the
   * share sheet. Absent → the UI hides export actions. Content is data from the server only.
   */
  saveFile?(filename: string, content: string, mime: 'text/csv'): Promise<'saved' | 'cancelled'>;
  /**
   * Talk attachments: the OS file picker. Returns opaque handles (+ name/size/type); the file
   * itself stays in the shell (Electron main / native module). Absent → no attach button.
   */
  files?: {
    pick(): Promise<PickedFile[]>;
    /** Drop a picked file that will not be sent. */
    release(handle: string): Promise<void>;
  };
  /** Voice notes; absent → no record button. */
  voice?: VoiceRecorder;
  /** Play a downloaded voice note (bytes from the Backend, never a URL with credentials). */
  playAudio?(clip: { mime: string; base64: string }): Promise<AudioPlayback>;
}

interface Ctx {
  backend: Backend;
  platform: PlatformServices;
}

const ServicesContext = createContext<Ctx | null>(null);

export function ServicesProvider({ backend, platform, children }: Ctx & { children: ReactNode }) {
  return <ServicesContext.Provider value={{ backend, platform }}>{children}</ServicesContext.Provider>;
}

export function useServices(): Ctx {
  const c = useContext(ServicesContext);
  if (!c) throw new Error('ServicesProvider missing');
  return c;
}

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (fn: (prev: T | undefined) => T | undefined) => void;
}

/** Minimal async loader: cancels stale results, keeps last data while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setDataState] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const gen = useRef(0);
  useEffect(() => {
    const my = ++gen.current;
    setLoading(true);
    setError(undefined);
    fn().then(
      (d) => {
        if (gen.current === my) {
          setDataState(d);
          setLoading(false);
        }
      },
      (e) => {
        if (gen.current === my) {
          setError(e);
          setLoading(false);
        }
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  const setData = useCallback((f: (p: T | undefined) => T | undefined) => setDataState((p) => f(p)), []);
  return { data, error, loading, reload, setData };
}

export type { AppRoute };
