import { createRoot } from 'react-dom/client';
import { createWireBackend, type BackendMethod, type PickedFile, type RoutedTarget, type WireResult } from '@workhub-devices/core';
import { WorkhubApp, type PlatformServices } from '@workhub-devices/features';
import { createVoiceRecorder, playAudio } from './voice';
import identity from '../../../../config/app-identity.json';

declare global {
  interface Window {
    workhub: {
      invoke(method: BackendMethod, args: unknown[]): Promise<WireResult>;
      openExternal(url: string): Promise<boolean>;
      saveFile(filename: string, content: string, mime: string): Promise<'saved' | 'cancelled'>;
      pickFiles(): Promise<PickedFile[]>;
      stageRecording(wav: Uint8Array): Promise<PickedFile | null>;
      releaseFile(handle: string): Promise<void>;
      setBadgeCount(count: number): void;
    setForeground(target: RoutedTarget | null): void;
      onRoute(cb: (t: RoutedTarget) => void): () => void;
      platform: string;
    };
  }
}

const bridge = window.workhub;
const backend = createWireBackend((m, a) => bridge.invoke(m, a));
const platform: PlatformServices = {
  kind: 'desktop',
  setBadgeCount: (count) => bridge.setBadgeCount(count),
  isActive: () => document.visibilityState === 'visible' && document.hasFocus(),
  subscribeActivity: (cb) => {
    const report = () => cb(document.visibilityState === 'visible' && document.hasFocus());
    document.addEventListener('visibilitychange', report);
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    window.addEventListener('online', report);
    return () => {
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
      window.removeEventListener('online', report);
    };
  },
  openExternal: async (url) => {
    await bridge.openExternal(url);
  },
  saveFile: (filename, content, mime) => bridge.saveFile(filename, content, mime),
  files: { pick: () => bridge.pickFiles(), release: (h) => bridge.releaseFile(h) },
  ...(typeof navigator.mediaDevices?.getUserMedia === 'function' ? { voice: createVoiceRecorder((wav) => bridge.stageRecording(wav)) } : {}),
  playAudio,
  onForegroundRoute: (t) => bridge.setForeground(t),
  subscribeRoutes: (cb) => bridge.onRoute(cb),
  appVersion: identity.version,
};

createRoot(document.getElementById('root')!).render(<WorkhubApp backend={backend} platform={platform} />);
