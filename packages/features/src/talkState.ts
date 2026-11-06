import { useCallback, useEffect, useRef, useState } from 'react';
import { unreadTotal, watchTalk, type AccountId, type TalkRoom } from '@workhub-devices/core';
import { useServices } from './services';

// Viewport coverage also admits messages taller than the screen; fully visible short rows qualify.
export const chatReadViewability = { viewAreaCoveragePercentThreshold: 50, minimumViewTime: 300 };

export function useActivity(): boolean {
  const { platform } = useServices();
  const [active, setActive] = useState(() => platform.isActive?.() ?? false);
  useEffect(() => {
    const unsubscribe = platform.subscribeActivity?.(setActive);
    setActive(platform.isActive?.() ?? false);
    return unsubscribe;
  }, [platform]);
  return active;
}

export interface TalkState {
  data: TalkRoom[] | undefined;
  error: unknown;
  presenceError: unknown;
  loading: boolean;
  reload(): void;
}

/** AccountShell owns this snapshot even while a different tab/detail is selected. */
export function useTalkState(accountId: AccountId, enabled: boolean): TalkState {
  const { backend, platform } = useServices();
  const active = useActivity();
  const [data, setData] = useState<TalkRoom[]>();
  const [error, setError] = useState<unknown>();
  const [presenceError, setPresenceError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const watcher = useRef<ReturnType<typeof watchTalk> | null>(null);
  useEffect(() => {
    if (!active || !enabled) return;
    setLoading(true);
    const sync = watchTalk({
      rooms: () => backend.rooms(accountId),
      heartbeat: () => platform.isActive?.() ? backend.heartbeat(accountId) : Promise.resolve(false),
      onRooms: (rooms) => {
        if (!platform.isActive?.()) return;
        setData(rooms);
        setError(undefined);
        setLoading(false);
      },
      onError: (e) => { setError(e); setLoading(false); },
      onPresenceError: setPresenceError,
    });
    watcher.current = sync;
    return () => { sync.stop(); watcher.current = null; };
  }, [accountId, backend, platform, active, enabled]);
  useEffect(() => { platform.setBadgeCount(enabled ? unreadTotal(data ?? []) : 0); }, [platform, data, enabled]);
  useEffect(() => () => platform.setBadgeCount(0), [platform, accountId]);
  const reload = useCallback(() => watcher.current?.refresh(), []);
  // Never present a cached online label as current after disconnect/background.
  const visibleData = !active || loading || error ? data?.map(({ status: _status, ...room }) => room) : data;
  return { data: visibleData, error, presenceError, loading, reload };
}
