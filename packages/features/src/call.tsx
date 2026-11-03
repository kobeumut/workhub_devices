import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import {
  callGate, CallEngine, OcsError,
  type AccountId, type Backend, type CallBlockReason, type CallCapabilities, type CallEngineState, type CallGate, type CallJoinResult,
  type MediaStreamLike, type RemoteParticipant, type TalkRoom,
} from '@workhub-devices/core';
import { useServices, type CallMedia, type PlatformServices } from './services';
import { Icon, type IconName } from './icons';
import { colors, font, space } from './theme';
import { describeError } from './i18n';

/**
 * Talk audio/video calls (Phase 7). One call at a time per account shell:
 * `CallsProvider` owns it, the full-screen `CallScreen` / `IncomingCallScreen` overlay the app,
 * chat headers get call buttons, rooms with a running call get a "join" banner.
 */

export const CALL_BLOCK_TEXT: Record<CallBlockReason, string> = {
  server_disabled: 'Aramalar bu sunucuda kapalı.',
  feature_missing: 'Sunucudaki Talk sürümü aramaları desteklemiyor.',
  room_type: 'Bu sohbet türünde arama yapılamaz.',
  read_only: 'Sohbet salt okunur; arama yapılamaz.',
  lobby: 'Sohbet lobide; moderatör sizi içeri alana kadar aramaya katılamazsınız.',
  no_permission: 'Bu sohbette arama başlatma/katılma izniniz yok.',
};

export type MediaProblem = 'denied' | 'unavailable' | 'failed';

/** Platform getUserMedia errors → what the user can do about it. */
export function mediaProblemOf(e: unknown): MediaProblem {
  const name = (e as { name?: unknown })?.name;
  const msg = String((e as { message?: unknown })?.message ?? '');
  if (name === 'NotAllowedError' || name === 'SecurityError' || /permission|denied/i.test(msg)) return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError' || /not ?found|no device|busy/i.test(msg)) return 'unavailable';
  return 'failed';
}

const MEDIA_TEXT: Record<MediaProblem, string> = {
  denied: 'Mikrofon/kamera izni reddedildi. Sistem ayarlarından izin verip tekrar deneyin ya da mikrofonsuz katılın.',
  unavailable: 'Mikrofon/kamera bulunamadı veya başka bir uygulama kullanıyor.',
  failed: 'Mikrofon/kamera açılamadı.',
};

export type CallPhase = 'media' | 'joining' | 'active' | 'ended' | 'error';

export interface CallView {
  token: string;
  title: string;
  phase: CallPhase;
  error: unknown;
  /** Local media could not be opened (shown with a "join without microphone" option). */
  mediaProblem: MediaProblem | null;
  /** Camera failed but the microphone works: joined audio-only. */
  videoProblem: MediaProblem | null;
  participants: RemoteParticipant[];
  names: Record<string, string>;
  local: MediaStreamLike | null;
  audio: boolean;
  video: boolean;
  speaker: boolean;
  networkOk: boolean;
  startedAt: number | null;
  ended: CallEngineState['ended'] | 'hangup' | null;
  gate: CallGate;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One call: local media → join → signaling loop → engine. UI subscribes to `view`. */
export class CallController {
  private listeners = new Set<() => void>();
  private engine: CallEngine | null = null;
  private join: CallJoinResult | null = null;
  private closed = false;
  view: CallView;

  constructor(
    private readonly backend: Backend,
    private readonly media: CallMedia,
    private readonly accountId: AccountId,
    token: string,
    title: string,
    gate: CallGate,
    private readonly wantVideo: boolean,
    private readonly nick: string,
  ) {
    this.view = {
      token, title, phase: 'media', error: null, mediaProblem: null, videoProblem: null, participants: [], names: {}, local: null,
      audio: gate.audio, video: wantVideo && gate.video, speaker: wantVideo, networkOk: true, startedAt: null, ended: null, gate,
    };
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getView = () => this.view;
  private set(patch: Partial<CallView>) {
    this.view = { ...this.view, ...patch };
    for (const l of this.listeners) l();
  }

  get callId() {
    return this.join?.callId ?? null;
  }

  async start() {
    const { gate } = this.view;
    const wantVideo = this.wantVideo && gate.video;
    let stream: MediaStreamLike | null = null;
    let videoProblem: MediaProblem | null = null;
    if (gate.audio || wantVideo) {
      try {
        stream = await this.media.getUserMedia({ audio: gate.audio, video: wantVideo, facing: 'user' });
      } catch (e) {
        if (wantVideo && gate.audio) {
          // Camera refused/busy: still join with the microphone, and say why there is no video.
          videoProblem = mediaProblemOf(e);
          stream = await this.media.getUserMedia({ audio: true, video: false, facing: 'user' }).catch(() => null);
        }
        if (!stream) {
          this.set({ phase: 'error', mediaProblem: mediaProblemOf(e) });
          return;
        }
      }
    }
    await this.connect(stream, videoProblem);
  }

  /** After a media error: join listen-only (Talk allows "in call" without audio/video). */
  async startWithoutMedia() {
    if (this.closed) return;
    this.set({ mediaProblem: null, error: null });
    await this.connect(null, null);
  }

  private async connect(stream: MediaStreamLike | null, videoProblem: MediaProblem | null) {
    if (this.closed) return stopStream(stream);
    const audio = !!stream?.getAudioTracks().length;
    const video = !!stream?.getVideoTracks().length;
    this.set({ phase: 'joining', local: stream, audio, video, videoProblem, speaker: video || this.view.speaker });
    this.media.setSpeaker?.(video || this.view.speaker);
    try {
      this.join = await this.backend.callJoin(this.accountId, this.view.token, { audio, video }, false);
    } catch (e) {
      stopStream(stream);
      this.set({ phase: 'error', error: e, local: null });
      return;
    }
    if (this.closed) {
      await this.backend.callLeave(this.join.callId, false).catch(() => undefined);
      return stopStream(stream);
    }
    const callId = this.join.callId;
    this.engine = new CallEngine({
      selfSessionId: this.join.sessionId,
      mode: this.join.mode,
      createPeer: this.media.createPeer,
      iceServers: this.join.iceServers,
      localStream: stream,
      nick: this.nick,
      send: (to, data) => this.backend.callSend(callId, to, data),
      onChange: (s) => {
        this.set({ participants: s.participants, networkOk: s.networkOk });
        if (s.participants.some((p) => p.userId && !(p.userId in this.view.names))) void this.loadNames();
      },
    });
    this.set({ phase: 'active', startedAt: Date.now() });
    this.media.onCallActive?.({ token: this.view.token, title: this.view.title, video });
    void this.loadNames();
    void this.loop(callId);
  }

  private namesLoadedAt = 0;
  private async loadNames() {
    if (Date.now() - this.namesLoadedAt < 10_000) return;
    this.namesLoadedAt = Date.now();
    try {
      const list = await this.backend.participants(this.accountId, this.view.token);
      const names: Record<string, string> = { ...this.view.names };
      for (const p of list) if (p.actorType === 'users') names[p.actorId] = p.displayName || p.actorId;
      this.set({ names });
    } catch {
      /* names are cosmetic */
    }
  }

  private async loop(callId: string) {
    let failures = 0;
    while (!this.closed) {
      let events;
      try {
        events = await this.backend.callEvents(callId, 25_000);
        failures = 0;
      } catch (e) {
        if (this.closed) return;
        if (e instanceof OcsError && e.kind === 'not_found') return this.finish('session');
        if (++failures > 1) this.set({ networkOk: false });
        await sleep(Math.min(1000 * failures, 5000));
        continue;
      }
      for (const ev of events) {
        await this.engine?.handle(ev).catch(() => undefined);
      }
      const ended = this.engine?.state.ended;
      if (ended) return this.finish(ended);
    }
  }

  private finish(reason: NonNullable<CallView['ended']>) {
    if (this.closed) return;
    this.closed = true;
    this.engine?.close();
    stopStream(this.view.local);
    this.media.onCallActive?.(null);
    this.set({ phase: 'ended', ended: reason, local: null, participants: [] });
  }

  toggleAudio() {
    if (!this.view.local?.getAudioTracks().length) return;
    const on = !this.view.audio;
    this.engine?.setAudio(on);
    if (!this.engine) for (const t of this.view.local.getAudioTracks()) t.enabled = on;
    this.set({ audio: on });
  }

  toggleVideo() {
    if (!this.view.local?.getVideoTracks().length) return;
    const on = !this.view.video;
    this.engine?.setVideo(on);
    if (!this.engine) for (const t of this.view.local.getVideoTracks()) t.enabled = on;
    this.set({ video: on });
  }

  toggleSpeaker() {
    const on = !this.view.speaker;
    this.media.setSpeaker?.(on);
    this.set({ speaker: on });
  }

  async switchCamera() {
    if (this.view.local && this.media.switchCamera) await this.media.switchCamera(this.view.local).catch(() => undefined);
  }

  networkChanged() {
    this.engine?.networkChanged();
  }

  async hangup(endForAll = false) {
    const callId = this.join?.callId;
    const wasClosed = this.closed;
    this.finish('hangup');
    if (wasClosed && !callId) return;
    if (callId) {
      await this.backend.cancel(callId).catch(() => undefined);
      await this.backend.callLeave(callId, endForAll).catch(() => undefined);
    }
  }
}

function stopStream(s: MediaStreamLike | null | undefined) {
  for (const t of s?.getTracks() ?? []) {
    try {
      t.stop();
    } catch {
      /* already stopped */
    }
  }
}

// ---- Provider -------------------------------------------------------------------------

interface Incoming {
  token: string;
  autoAccept?: boolean;
}

interface CallsCtx {
  caps: CallCapabilities;
  /** Platform media present (else calls are not offered on this device). */
  supported: boolean;
  active: CallController | null;
  activeToken: string | null;
  start(room: { token: string; title: string }, gate: CallGate, video: boolean): void;
  ring(token: string, autoAccept?: boolean): void;
  show(): void;
}

const Ctx = createContext<CallsCtx | null>(null);

export function useCalls(): CallsCtx | null {
  return useContext(Ctx);
}

export function CallsProvider({ accountId, caps, nick, onOpenRoom, ring, children }: {
  accountId: AccountId;
  caps: CallCapabilities;
  nick: string;
  /** An incoming call to show (changes `seq` for every new request). */
  ring: { token: string; autoAccept: boolean; seq: number } | null;
  /** "Missed call" / declined: show the room instead. */
  onOpenRoom: (token: string) => void;
  children: ReactNode;
}) {
  const { backend, platform } = useServices();
  const [active, setActive] = useState<CallController | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const media = platform.call;

  const start = useCallback((room: { token: string; title: string }, gate: CallGate, video: boolean) => {
    if (!media) return;
    void activeRef.current?.hangup();
    const c = new CallController(backend, media, accountId, room.token, room.title, gate, video, nick);
    setActive(c);
    setMinimized(false);
    setIncoming(null);
    void c.start();
  }, [backend, media, accountId, nick]);

  useEffect(() => {
    if (!ring) return;
    const cur = activeRef.current;
    if (cur?.view.token === ring.token && cur.view.phase !== 'ended') setMinimized(false);
    else setIncoming({ token: ring.token, ...(ring.autoAccept ? { autoAccept: true } : {}) });
  }, [ring]);

  // Network changes → ICE restart on the running call.
  useEffect(() => media?.subscribeNetwork?.(() => activeRef.current?.networkChanged()), [media]);
  // Leaving the account shell (logout / switch) ends the call.
  useEffect(() => () => void activeRef.current?.hangup(), []);

  const ctx = useMemo<CallsCtx>(() => ({
    caps,
    supported: !!media,
    active,
    activeToken: active && active.view.phase !== 'ended' ? active.view.token : null,
    start,
    ring: (token, autoAccept) => {
      if (activeRef.current?.view.token === token && activeRef.current.view.phase !== 'ended') return setMinimized(false);
      setIncoming({ token, ...(autoAccept ? { autoAccept } : {}) });
    },
    show: () => setMinimized(false),
  }), [caps, media, active, start]);

  return (
    <Ctx.Provider value={ctx}>
      <View style={{ flex: 1 }}>
        {children}
        {active && minimized ? <ReturnToCallBar call={active} onPress={() => setMinimized(false)} /> : null}
        {active && !minimized ? (
          <View style={overlay}>
            <CallScreen call={active} media={media!} platform={platform} onMinimize={() => setMinimized(true)} onClose={() => setActive(null)} />
          </View>
        ) : null}
        {incoming && media ? (
          <View style={overlay}>
            <IncomingCallScreen
              accountId={accountId}
              token={incoming.token}
              caps={caps}
              media={media}
              autoAccept={!!incoming.autoAccept}
              onAccept={(room, gate, video) => start({ token: room.token, title: room.displayName }, gate, video)}
              onDismiss={(openRoom) => {
                setIncoming(null);
                if (openRoom) onOpenRoom(incoming.token);
              }}
            />
          </View>
        ) : null}
      </View>
    </Ctx.Provider>
  );
}

const overlay = { position: 'absolute' as const, left: 0, right: 0, top: 0, bottom: 0, zIndex: 50 };
const DARK = '#0f172a';
const DARK_TILE = '#1e293b';
const LIGHT = '#f8fafc';

function useCallView(call: CallController): CallView {
  return useSyncExternalStore(call.subscribe, call.getView, call.getView);
}

function useDuration(startedAt: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  if (!startedAt) return '';
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

function RoundButton({ icon, label, onPress, active = false, danger = false, size = 56 }: { icon: IconName; label: string; onPress: () => void; active?: boolean; danger?: boolean; size?: number }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active }} onPress={onPress} hitSlop={6}
      style={({ pressed }) => ({
        width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center',
        backgroundColor: danger ? '#dc2626' : active ? LIGHT : 'rgba(255,255,255,0.14)', opacity: pressed ? 0.7 : 1,
      })}>
      <Icon name={icon} size={size * 0.42} color={danger ? '#fff' : active ? DARK : '#fff'} />
    </Pressable>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
}

function Tile({ p, name, media, height }: { p: RemoteParticipant; name: string; media: CallMedia; height: number }) {
  const VideoView = media.VideoView;
  const showVideo = !!p.stream && p.video;
  return (
    <View accessible accessibilityLabel={`${name}${p.audio ? '' : ', mikrofonu kapalı'}${p.state === 'connected' ? '' : ', bağlanıyor'}`}
      style={{ flexGrow: 1, flexBasis: 280, height, borderRadius: 12, overflow: 'hidden', backgroundColor: DARK_TILE, margin: space(1) }}>
      {/* Always mounted when a stream exists: it also plays the participant's audio. */}
      {p.stream ? <VideoView stream={p.stream} fit="cover" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, opacity: showVideo ? 1 : 0 }} /> : null}
      {!showVideo ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 26, fontWeight: '700' }}>{initials(name)}</Text>
          </View>
        </View>
      ) : null}
      <View style={{ position: 'absolute', left: space(2), bottom: space(2), flexDirection: 'row', alignItems: 'center', gap: space(1), backgroundColor: 'rgba(15,23,42,0.6)', borderRadius: 8, paddingHorizontal: space(2), paddingVertical: 2 }}>
        {!p.audio ? <Icon name="micOff" size={14} color="#fca5a5" /> : null}
        <Text numberOfLines={1} style={{ color: '#fff', fontSize: font.small }}>{name}</Text>
        {p.state !== 'connected' ? <Text style={{ color: '#cbd5e1', fontSize: 11 }}>{p.state === 'reconnecting' ? 'yeniden bağlanıyor…' : 'bağlanıyor…'}</Text> : null}
      </View>
    </View>
  );
}

const ENDED_TEXT: Record<NonNullable<CallView['ended']>, string> = {
  hangup: 'Görüşmeden ayrıldınız.',
  ended: 'Görüşme moderatör tarafından herkes için sonlandırıldı.',
  session: 'Görüşme oturumu sona erdi.',
  conflict: 'Bu görüşmeye başka bir cihazdan katıldınız.',
  kicked: 'Görüşmeden çıkarıldınız.',
  network: 'Bağlantı koptu; görüşme sonlandı.',
};

export function CallScreen({ call, media, platform, onMinimize, onClose }: { call: CallController; media: CallMedia; platform: PlatformServices; onMinimize: () => void; onClose: () => void }) {
  const v = useCallView(call);
  const duration = useDuration(v.phase === 'active' ? v.startedAt : null);
  const { width, height } = useWindowDimensions();
  const VideoView = media.VideoView;
  const n = v.participants.length;
  const cols = width >= 900 ? Math.min(3, Math.max(1, Math.ceil(Math.sqrt(n)))) : 1;
  const rows = Math.max(1, Math.ceil(n / cols));
  const tileH = Math.max(140, Math.floor((height - 220) / Math.min(rows, width >= 900 ? 3 : 2)));
  const status =
    v.phase === 'media' ? 'Mikrofon/kamera açılıyor…'
    : v.phase === 'joining' ? 'Bağlanıyor…'
    : v.phase === 'active' ? (n === 0 ? 'Diğer katılımcılar bekleniyor…' : duration)
    : v.phase === 'ended' ? ENDED_TEXT[v.ended ?? 'hangup']
    : '';

  return (
    <View style={{ flex: 1, backgroundColor: DARK }} accessibilityViewIsModal>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: space(3), gap: space(2) }}>
        <View style={{ flex: 1 }}>
          <Text accessibilityRole="header" numberOfLines={1} style={{ color: '#fff', fontSize: font.title, fontWeight: '700' }}>{v.title}</Text>
          <Text accessibilityLiveRegion="polite" style={{ color: '#cbd5e1', fontSize: font.small }}>{status}</Text>
        </View>
        {v.phase !== 'ended' && v.phase !== 'error' ? <RoundButton icon="back" label="Görüşmeyi küçült" size={40} onPress={onMinimize} /> : null}
      </View>
      {!v.networkOk && v.phase === 'active' ? (
        <Text accessibilityRole="alert" style={{ color: '#fde68a', paddingHorizontal: space(3), paddingBottom: space(2) }}>Bağlantı sorunu — yeniden bağlanılıyor…</Text>
      ) : null}
      {v.videoProblem ? (
        <Text accessibilityRole="alert" style={{ color: '#fde68a', paddingHorizontal: space(3), paddingBottom: space(2) }}>
          Kamera açılamadı ({v.videoProblem === 'denied' ? 'izin reddedildi' : 'kullanılamıyor'}); yalnız sesle katıldınız.
        </Text>
      ) : null}

      {v.phase === 'error' ? (
        <View accessibilityRole="alert" style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(6), gap: space(3) }}>
          <Icon name="micOff" size={40} color="#fca5a5" />
          <Text style={{ color: '#fff', textAlign: 'center', fontSize: font.body }}>{v.mediaProblem ? MEDIA_TEXT[v.mediaProblem] : describeError(v.error)}</Text>
          <View style={{ flexDirection: 'row', gap: space(3) }}>
            {v.mediaProblem ? (
              <Pressable accessibilityRole="button" onPress={() => void call.startWithoutMedia()} style={pill(LIGHT)}>
                <Text style={{ color: DARK, fontWeight: '600' }}>Mikrofonsuz katıl</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" onPress={() => { void call.hangup(); onClose(); }} style={pill('rgba(255,255,255,0.14)')}>
              <Text style={{ color: '#fff', fontWeight: '600' }}>Kapat</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', padding: space(2) }}>
          {v.participants.map((p) => (
            <Tile key={p.sessionId} p={p} name={p.displayName || (p.userId && v.names[p.userId]) || p.userId || 'Misafir'} media={media} height={tileH} />
          ))}
        </ScrollView>
      )}

      {v.local && v.video ? (
        <View style={{ position: 'absolute', right: space(3), bottom: 120, width: width >= 900 ? 220 : 110, height: width >= 900 ? 140 : 160, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }}>
          <VideoView stream={v.local} muted mirror fit="cover" style={{ flex: 1 }} />
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: space(4), paddingVertical: space(5), paddingHorizontal: space(3), flexWrap: 'wrap' }}>
        {v.phase === 'ended' ? (
          <Pressable accessibilityRole="button" onPress={onClose} style={pill(LIGHT)}>
            <Text style={{ color: DARK, fontWeight: '600' }}>Kapat</Text>
          </Pressable>
        ) : v.phase !== 'error' ? (
          <>
            <RoundButton icon={v.audio ? 'mic' : 'micOff'} label={v.audio ? 'Mikrofonu kapat' : 'Mikrofonu aç'} active={!v.audio} onPress={() => call.toggleAudio()} />
            {v.local?.getVideoTracks().length ? (
              <RoundButton icon={v.video ? 'video' : 'videoOff'} label={v.video ? 'Kamerayı kapat' : 'Kamerayı aç'} active={!v.video} onPress={() => call.toggleVideo()} />
            ) : null}
            {media.switchCamera && v.local?.getVideoTracks().length ? <RoundButton icon="switchCamera" label="Kamerayı değiştir" onPress={() => void call.switchCamera()} /> : null}
            {media.setSpeaker && platform.kind !== 'desktop' ? (
              <RoundButton icon="speaker" label={v.speaker ? 'Ahizeye geç' : 'Hoparlöre geç'} active={v.speaker} onPress={() => call.toggleSpeaker()} />
            ) : null}
            <RoundButton icon="callEnd" label="Görüşmeyi bitir" danger size={64} onPress={() => void call.hangup()} />
          </>
        ) : null}
      </View>
    </View>
  );
}

const pill = (bg: string) => ({ backgroundColor: bg, paddingHorizontal: space(5), paddingVertical: space(3), borderRadius: 24 });

function ReturnToCallBar({ call, onPress }: { call: CallController; onPress: () => void }) {
  const v = useCallView(call);
  const duration = useDuration(v.phase === 'active' ? v.startedAt : null);
  if (v.phase === 'ended' || v.phase === 'error') return null;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Görüşmeye dön: ${v.title}`} onPress={onPress}
      style={{ position: 'absolute', left: space(3), right: space(3), bottom: space(20), zIndex: 40, backgroundColor: colors.ok, borderRadius: 12, padding: space(3), flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
      <Icon name="call" size={18} color="#fff" />
      <Text numberOfLines={1} style={{ flex: 1, color: '#fff', fontWeight: '600' }}>{v.title}</Text>
      <Text style={{ color: '#fff' }}>{duration || 'Bağlanıyor…'}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Görüşmeyi bitir" onPress={() => void call.hangup()} hitSlop={8}>
        <Icon name="callEnd" size={18} color="#fff" />
      </Pressable>
    </Pressable>
  );
}

// ---- Incoming --------------------------------------------------------------------------

export function IncomingCallScreen({ accountId, token, caps, media, autoAccept, onAccept, onDismiss }: {
  accountId: AccountId;
  token: string;
  caps: CallCapabilities;
  media: CallMedia;
  autoAccept: boolean;
  onAccept: (room: TalkRoom, gate: CallGate, video: boolean) => void;
  onDismiss: (openRoom: boolean) => void;
}) {
  const { backend } = useServices();
  const [room, setRoom] = useState<TalkRoom | null>(null);
  const [error, setError] = useState<unknown>();
  const [missed, setMissed] = useState(false);
  const accepted = useRef(false);

  useEffect(() => {
    let alive = true;
    backend.talkRoom(accountId, token).then((r) => alive && setRoom(r), (e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [backend, accountId, token]);

  const gate = room ? callGate(room, caps) : null;

  // Ring while the server says it still rings (answered elsewhere / caller hung up → stop).
  useEffect(() => {
    if (autoAccept || missed) return;
    media.ringtone?.start();
    let alive = true;
    const started = Date.now();
    const tick = async () => {
      if (!alive) return;
      const ringing = await backend.callRinging(accountId, token).catch(() => true);
      if (!alive) return;
      if (!ringing || Date.now() - started > 60_000) {
        media.ringtone?.stop();
        setMissed(true);
        return;
      }
      setTimeout(() => void tick(), 3000);
    };
    void tick();
    return () => {
      alive = false;
      media.ringtone?.stop();
    };
  }, [backend, accountId, token, media, autoAccept, missed]);

  useEffect(() => {
    if (autoAccept && room && gate?.canJoin && !accepted.current) {
      accepted.current = true;
      onAccept(room, gate, false);
    }
  }, [autoAccept, room, gate, onAccept]);

  const title = room?.displayName ?? 'Gelen arama';
  return (
    <View accessibilityViewIsModal style={{ flex: 1, backgroundColor: DARK, alignItems: 'center', justifyContent: 'space-between', paddingVertical: space(16), paddingHorizontal: space(6) }}>
      <View style={{ alignItems: 'center', gap: space(3) }}>
        <View style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="callIncoming" size={44} color="#fff" />
        </View>
        <Text accessibilityRole="header" numberOfLines={2} style={{ color: '#fff', fontSize: font.h1, fontWeight: '700', textAlign: 'center' }}>{title}</Text>
        <Text accessibilityLiveRegion="polite" style={{ color: '#cbd5e1' }}>
          {missed ? 'Cevapsız arama — arama sona erdi.' : error ? describeError(error) : gate && !gate.canJoin ? CALL_BLOCK_TEXT[gate.reason ?? 'no_permission'] : 'Gelen Talk araması…'}
        </Text>
      </View>
      {missed || error || (gate && !gate.canJoin) ? (
        <View style={{ flexDirection: 'row', gap: space(3) }}>
          <Pressable accessibilityRole="button" onPress={() => onDismiss(true)} style={pill(LIGHT)}>
            <Text style={{ color: DARK, fontWeight: '600' }}>Sohbeti aç</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => onDismiss(false)} style={pill('rgba(255,255,255,0.14)')}>
            <Text style={{ color: '#fff', fontWeight: '600' }}>Kapat</Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: space(8), alignItems: 'center' }}>
          <View style={{ alignItems: 'center', gap: space(2) }}>
            <RoundButton icon="callEnd" label="Reddet" danger size={68} onPress={() => onDismiss(false)} />
            <Text style={{ color: '#cbd5e1' }}>Reddet</Text>
          </View>
          {gate?.video ? (
            <View style={{ alignItems: 'center', gap: space(2) }}>
              <RoundButton icon="video" label="Görüntülü kabul et" size={68} onPress={() => room && gate && onAccept(room, gate, true)} />
              <Text style={{ color: '#cbd5e1' }}>Görüntülü</Text>
            </View>
          ) : null}
          <View style={{ alignItems: 'center', gap: space(2) }}>
            <Pressable accessibilityRole="button" accessibilityLabel="Sesli kabul et" disabled={!room || !gate} onPress={() => room && gate && onAccept(room, gate, false)}
              style={({ pressed }) => ({ width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: '#16a34a', opacity: pressed || !room ? 0.6 : 1 })}>
              <Icon name="call" size={30} color="#fff" />
            </Pressable>
            <Text style={{ color: '#cbd5e1' }}>Kabul et</Text>
          </View>
        </View>
      )}
    </View>
  );
}

// ---- Chat integration --------------------------------------------------------------------

/** Header buttons (audio + video) for a room; nothing when calls are unavailable. */
export function CallButtons({ room, title }: { room: TalkRoom | undefined; title: string }) {
  const calls = useCalls();
  if (!calls?.supported || !room) return null;
  const gate = callGate(room, calls.caps);
  if (!gate.available) return null;
  const inThis = calls.activeToken === room.token;
  const go = (video: boolean) => (inThis ? calls.show() : calls.start({ token: room.token, title }, gate, video));
  const btn = (icon: IconName, label: string, video: boolean) => (
    <Pressable key={icon} accessibilityRole="button" accessibilityLabel={label} onPress={() => go(video)} hitSlop={6}
      style={({ pressed }) => ({ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? colors.hover : 'transparent' })}>
      <Icon name={icon} size={20} color={inThis ? colors.ok : colors.primary} />
    </Pressable>
  );
  return (
    <View style={{ flexDirection: 'row' }}>
      {btn('call', inThis ? 'Görüşmeye dön' : gate.hasCall ? 'Sesli katıl' : 'Sesli arama', false)}
      {gate.video && !inThis ? btn('video', gate.hasCall ? 'Görüntülü katıl' : 'Görüntülü arama', true) : null}
    </View>
  );
}

/** Why there is no call button here (not shown for note-to-self/changelog rooms). */
export function callUnavailableText(room: TalkRoom | undefined, calls: CallsCtx | null): string | null {
  if (!room || !calls) return null;
  if (!calls.supported) return 'Bu cihazda arama desteklenmiyor.';
  const gate = callGate(room, calls.caps);
  if (gate.available || gate.reason === 'room_type') return null;
  return CALL_BLOCK_TEXT[gate.reason ?? 'no_permission'];
}

/** "A call is running — join" banner for a room. */
export function OngoingCallBanner({ room, title }: { room: TalkRoom | undefined; title: string }) {
  const calls = useCalls();
  if (!calls?.supported || !room?.hasCall || calls.activeToken === room.token) return null;
  const gate = callGate(room, calls.caps);
  if (!gate.available) return null;
  return (
    <View accessibilityRole="alert" style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), backgroundColor: colors.okSoft, paddingHorizontal: space(4), paddingVertical: space(2) }}>
      <Icon name="call" size={18} color={colors.ok} />
      <Text style={{ flex: 1, color: colors.ok, fontWeight: '600' }}>Bu sohbette görüşme sürüyor</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Görüşmeye katıl" onPress={() => calls.start({ token: room.token, title }, gate, false)}
        style={{ backgroundColor: colors.ok, borderRadius: 16, paddingHorizontal: space(4), paddingVertical: space(1) }}>
        <Text style={{ color: '#fff', fontWeight: '600' }}>Katıl</Text>
      </Pressable>
    </View>
  );
}

export const CALL_SYSTEM_MESSAGES: ReadonlySet<string> = new Set(['call_started', 'call_joined', 'call_left', 'call_ended', 'call_ended_everyone', 'call_missed', 'call_tried']);
