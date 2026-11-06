import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ServicesProvider, type PlatformServices } from '../../../packages/features/src/services';
import { useTalkState, type TalkState } from '../../../packages/features/src/talkState';
import type { AccountId, Backend, TalkRoom } from '@workhub-devices/core';

jest.mock('@workhub-devices/core', () => require('../../../packages/core/src/talkSync'));

it('shared shell reconciles unread, hides stale presence, fences account switch and cleans activity subscriptions', async () => {
  jest.useFakeTimers();
  let active = true;
  const listeners = new Set<(value: boolean) => void>();
  const platform = {
    kind: 'android', openExternal: async () => {}, isActive: () => active, setBadgeCount: jest.fn(),
    subscribeActivity: (cb: (v: boolean) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  } satisfies PlatformServices;
  const makeRoom = (n: number) => ({ token: 'a', unreadMessages: n, status: 'online' }) as TalkRoom;
  const backend = {
    rooms: jest.fn().mockResolvedValue({ rooms: [makeRoom(3)] }), heartbeat: jest.fn().mockResolvedValue(true),
  } as unknown as Backend;
  let latest!: TalkState;
  function Probe({ id }: { id: AccountId }) { latest = useTalkState(id, true); return null; }
  const tree = (id: string) => <ServicesProvider backend={backend} platform={platform}><Probe key={id} id={id as AccountId} /></ServicesProvider>;
  let root!: ReactTestRenderer;
  try {
    await act(async () => { root = create(tree('one')); });
    expect(latest.data?.[0]?.unreadMessages).toBe(3);
    expect(platform.setBadgeCount).toHaveBeenLastCalledWith(3);
    expect(latest.data?.[0]?.status).toBe('online');
    const beats = (backend.heartbeat as jest.Mock).mock.calls.length;
    await act(async () => { active = false; listeners.forEach((cb) => cb(false)); });
    expect(latest.data?.[0]?.status).toBeUndefined();
    await act(async () => { jest.advanceTimersByTime(120_000); });
    expect(backend.heartbeat).toHaveBeenCalledTimes(beats);
    (backend.rooms as jest.Mock).mockResolvedValue({ rooms: [makeRoom(0)] });
    await act(async () => { active = true; listeners.forEach((cb) => cb(true)); });
    expect(latest.data?.[0]?.unreadMessages).toBe(0);
    expect(platform.setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(backend.heartbeat).toHaveBeenCalledTimes(beats + 1);
    let finishOld!: (v: { rooms: TalkRoom[] }) => void;
    (backend.rooms as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    await act(async () => { latest.reload(); });
    (backend.rooms as jest.Mock).mockResolvedValue({ rooms: [makeRoom(7)] });
    await act(async () => { root.update(tree('two')); });
    await act(async () => { finishOld({ rooms: [makeRoom(99)] }); });
    expect(latest.data?.[0]?.unreadMessages).toBe(7);
    expect(listeners.size).toBe(1);
    await act(async () => { root.unmount(); });
    expect(listeners.size).toBe(0);
    expect(platform.setBadgeCount).toHaveBeenLastCalledWith(0);
    const calls = (backend.rooms as jest.Mock).mock.calls.length;
    const lastBeats = (backend.heartbeat as jest.Mock).mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(120_000); });
    expect(backend.rooms).toHaveBeenCalledTimes(calls);
    expect(backend.heartbeat).toHaveBeenCalledTimes(lastBeats);
  } finally { jest.useRealTimers(); }
});
