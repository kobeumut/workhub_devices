import { LogBox } from 'react-native';

/**
 * Debug builds only (LogBox is a no-op in release). The LogBox notification toast is drawn at the
 * bottom of the screen, over the tab bar and the message composer, and in this app it is mostly
 * dev-infrastructure noise (Metro/Fast Refresh reconnects). Toasts are turned off; nothing is lost:
 * - every warning/error is still printed to the Metro terminal and logcat (`ReactNativeJS`),
 * - fatal JS errors still open the full-screen LogBox (only the toast is disabled).
 * Set `WORKHUB_LOGBOX_TOASTS = true` locally to see the toasts while debugging a warning.
 */
const WORKHUB_LOGBOX_TOASTS = false;

export function configureDevLogs(): void {
  if (!__DEV__ || WORKHUB_LOGBOX_TOASTS) return;
  LogBox.ignoreAllLogs(true);
}
