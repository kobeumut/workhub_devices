import { NativeModules } from 'react-native';
import { mediaDevices, MediaStream, RTCPeerConnection, RTCView } from 'react-native-webrtc';
import type { MediaStreamLike, RtcPeerLike } from '@workhub-devices/core';
import type { CallMedia } from '@workhub-devices/features';
import { native, nativeEvents } from './native';

/**
 * Talk calls on mobile: react-native-webrtc for media; the shell keeps the call alive (Android
 * foreground service phoneCall|microphone|camera + communication audio mode, `CallService.kt`).
 * Camera/microphone runtime permissions are requested by react-native-webrtc on first use; a
 * denial rejects getUserMedia and the call screen shows it.
 */
type Facing = 'user' | 'environment';
const facingOf = new WeakMap<object, Facing>();

export function createMobileCallMedia(): CallMedia | undefined {
  if (!NativeModules.WebRTCModule || !native.callStart) return undefined;
  return {
    async getUserMedia({ audio, video, facing }) {
      const stream = await mediaDevices.getUserMedia({
        audio,
        video: video ? { facingMode: facing, width: 1280, height: 720, frameRate: 24 } : false,
      });
      facingOf.set(stream, facing);
      return stream as unknown as MediaStreamLike;
    },
    createPeer: (config) => new RTCPeerConnection({ iceServers: config.iceServers, bundlePolicy: 'max-bundle' }) as unknown as RtcPeerLike,
    VideoView: ({ stream, mirror, fit = 'cover', style }) => (
      <RTCView streamURL={(stream as unknown as MediaStream).toURL()} objectFit={fit} mirror={!!mirror} zOrder={mirror ? 1 : 0} style={style} />
    ),
    async switchCamera(stream) {
      const track = stream.getVideoTracks()[0] as unknown as { applyConstraints?: (c: object) => Promise<void>; _switchCamera?: () => void } | undefined;
      if (!track) return;
      const next: Facing = facingOf.get(stream) === 'environment' ? 'user' : 'environment';
      if (track.applyConstraints) await track.applyConstraints({ facingMode: next });
      else track._switchCamera?.();
      facingOf.set(stream, next);
    },
    setSpeaker: (on) => native.callSpeaker?.(on),
    ringtone: { start: () => native.ringStart?.(), stop: () => native.ringStop?.() },
    onCallActive: (info) => {
      if (info) {
        native.callNotificationsClear?.();
        native.callStart?.(info.title, info.video);
        native.networkWatch?.(true);
      } else {
        native.networkWatch?.(false);
        native.callStop?.();
      }
    },
    subscribeNetwork(cb) {
      const sub = nativeEvents.addListener('WorkhubNetwork', () => cb());
      return () => sub.remove();
    },
  };
}
