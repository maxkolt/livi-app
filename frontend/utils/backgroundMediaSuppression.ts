import { NativeModules, Platform } from 'react-native';

/** Android: PAUSE + transient media focus на время входящего/активного звонка. */
export function beginBackgroundMediaSuppression(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.beginBackgroundMediaSuppression?.();
  } catch {}
}

/** Android: снять подавление и повторно PAUSE после звонка (против автовозобновления фонового медиа). */
export function pauseBackgroundMediaAfterCall(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.pauseBackgroundMediaAfterCall?.();
  } catch {}
}
