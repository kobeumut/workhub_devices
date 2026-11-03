import { createRoot } from 'react-dom/client';
import { createWireBackend, type BackendMethod, type PickedFile, type RoutedTarget, type WireResult } from '@workhub-devices/core';
import { WorkhubApp, type PlatformServices } from '@workhub-devices/features';
import { createVoiceRecorder, playAudio } from './voice';
import { createDesktopCallMedia } from './call';
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
      setForeground(target: RoutedTarget | null): void;
      onRoute(cb: (t: RoutedTarget) => void): () => void;
      setCallActive(active: boolean, title: string | null): void;
      platform: string;
    };
  }
}

const bridge = window.workhub;
const backend = createWireBackend((m, a) => bridge.invoke(m, a));
const call = createDesktopCallMedia((active, title) => bridge.setCallActive(active, title));
const platform: PlatformServices = {
  kind: 'desktop',
  openExternal: async (url) => {
    await bridge.openExternal(url);
  },
  saveFile: (filename, content, mime) => bridge.saveFile(filename, content, mime),
  files: { pick: () => bridge.pickFiles(), release: (h) => bridge.releaseFile(h) },
  ...(typeof navigator.mediaDevices?.getUserMedia === 'function' ? { voice: createVoiceRecorder((wav) => bridge.stageRecording(wav)) } : {}),
  playAudio,
  ...(call ? { call } : {}),
  onForegroundRoute: (t) => bridge.setForeground(t),
  subscribeRoutes: (cb) => bridge.onRoute(cb),
  appVersion: identity.version,
};

createRoot(document.getElementById('root')!).render(<WorkhubApp backend={backend} platform={platform} />);
