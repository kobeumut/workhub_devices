import { createRoot } from 'react-dom/client';
import { createWireBackend, type BackendMethod, type RoutedTarget, type WireResult } from '@workhub-devices/core';
import { WorkhubApp, type PlatformServices } from '@workhub-devices/features';

declare global {
  interface Window {
    workhub: {
      invoke(method: BackendMethod, args: unknown[]): Promise<WireResult>;
      openExternal(url: string): Promise<boolean>;
      saveFile(filename: string, content: string, mime: string): Promise<'saved' | 'cancelled'>;
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
  openExternal: async (url) => {
    await bridge.openExternal(url);
  },
  saveFile: (filename, content, mime) => bridge.saveFile(filename, content, mime),
  onForegroundRoute: (t) => bridge.setForeground(t),
  subscribeRoutes: (cb) => bridge.onRoute(cb),
  appVersion: '0.1.0',
};

createRoot(document.getElementById('root')!).render(<WorkhubApp backend={backend} platform={platform} />);
