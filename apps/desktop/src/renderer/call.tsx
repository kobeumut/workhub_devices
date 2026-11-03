import { useEffect, useRef, type ComponentProps, type CSSProperties } from 'react';
import { StyleSheet, View } from 'react-native';
import type { MediaStreamLike, RtcPeerLike } from '@workhub-devices/core';
import type { CallMedia } from '@workhub-devices/features';

/**
 * Calls in the Electron renderer: Chromium WebRTC. Main grants microphone/camera to our own
 * top frame only (see `main.ts` permission handlers); signaling runs in main (Backend over IPC).
 */

function VideoView({ stream, muted, mirror, fit = 'cover', style }: ComponentProps<CallMedia['VideoView']>) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream as unknown as MediaStream;
    void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  const css: CSSProperties = { width: '100%', height: '100%', objectFit: fit, transform: mirror ? 'scaleX(-1)' : undefined, backgroundColor: 'transparent', display: 'block' };
  return (
    <View style={[{ overflow: 'hidden' }, StyleSheet.flatten(style)]}>
      <video ref={ref} autoPlay playsInline muted={!!muted} style={css} />
    </View>
  );
}

/** Two-tone ring (Web Audio; no audio file to ship). */
function createRingtone() {
  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const burst = () => {
    if (!ctx) return;
    const t0 = ctx.currentTime;
    for (const [i, f] of [[0, 440], [1, 480]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.05);
      gain.gain.setValueAtTime(0.12, t0 + 1.2);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + i * 0);
      osc.stop(t0 + 1.35);
    }
  };
  return {
    start() {
      if (timer) return;
      ctx = new AudioContext();
      burst();
      timer = setInterval(burst, 3000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      void ctx?.close().catch(() => undefined);
      ctx = null;
    },
  };
}

export function createDesktopCallMedia(onActive: (active: boolean, title: string | null) => void): CallMedia | undefined {
  if (typeof RTCPeerConnection !== 'function' || typeof navigator.mediaDevices?.getUserMedia !== 'function') return undefined;
  return {
    async getUserMedia({ audio, video }) {
      return (await navigator.mediaDevices.getUserMedia({
        audio: audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
        video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } } : false,
      })) as unknown as MediaStreamLike;
    },
    createPeer: (config) => new RTCPeerConnection({ iceServers: config.iceServers, bundlePolicy: 'max-bundle' }) as unknown as RtcPeerLike,
    VideoView,
    ringtone: createRingtone(),
    onCallActive: (info) => onActive(!!info, info?.title ?? null),
    subscribeNetwork(cb) {
      const conn = (navigator as { connection?: EventTarget }).connection;
      window.addEventListener('online', cb);
      conn?.addEventListener('change', cb);
      return () => {
        window.removeEventListener('online', cb);
        conn?.removeEventListener('change', cb);
      };
    },
  };
}
