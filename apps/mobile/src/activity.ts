import { AppState, Platform } from 'react-native';

/** Android's notification drawer blurs the app without changing AppState. */
export function mobileActivity() {
  let focused = true;
  const isActive = () => focused && AppState.currentState === 'active';
  return {
    isActive,
    subscribeActivity(cb: (active: boolean) => void) {
      const subs = [AppState.addEventListener('change', () => cb(isActive()))];
      if (Platform.OS === 'android') {
        subs.push(AppState.addEventListener('blur', () => { focused = false; cb(false); }));
        subs.push(AppState.addEventListener('focus', () => { focused = true; cb(isActive()); }));
      }
      return () => subs.forEach((s) => s.remove());
    },
  };
}
