import { useEffect, useState } from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';

/**
 * Bottom padding the app root needs so nothing sits under the Android soft keyboard.
 *
 * Android 15+ enforces edge-to-edge (Android 16 removed the opt-out), so `adjustResize` no longer
 * shrinks the window: the app keeps drawing under the IME. React Native reports the keyboard as
 * `ime.bottom - systemBars.bottom` (`ReactRootView.checkForKeyboardEvents`), and the root
 * SafeAreaView already pads by the navigation-bar inset, so padding by the reported height puts
 * the bottom of the content exactly on the keyboard's top edge — on every screen at once.
 */
export function keyboardPadding(e: Pick<KeyboardEvent, 'endCoordinates'> | null): number {
  const h = e?.endCoordinates?.height;
  return typeof h === 'number' && Number.isFinite(h) && h > 0 ? Math.round(h) : 0;
}

/** Android only; iOS keeps per-screen KeyboardAvoidingView (`keyboardAvoidBehavior`). */
export function useAndroidKeyboardPadding(): number {
  const [pad, setPad] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    // Android emits only the Did* events; Did*Show is re-sent when the height changes (emoji panel).
    const show = Keyboard.addListener('keyboardDidShow', (e) => setPad(keyboardPadding(e)));
    const hide = Keyboard.addListener('keyboardDidHide', () => setPad(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return pad;
}
