import { findNodeHandle, NativeModules, Platform, type View } from 'react-native';

const MIN_API_FOR_RENDER_EFFECT = 31;

/** Android 12+: Gaussian blur on TextureView (GSM / external call hold). */
export function supportsCallVideoHoldBlur(): boolean {
  return Platform.OS === 'android' && Number(Platform.Version) >= MIN_API_FOR_RENDER_EFFECT;
}

/** Preferred: blur by role — largest TextureView = remote, smallest = local pip. */
export function setCallVideoHoldBlurForRole(
  role: 'remote' | 'local',
  enabled: boolean
): void {
  if (!supportsCallVideoHoldBlur()) return;
  try {
    NativeModules.LiviAppModule?.setCallVideoHoldBlurForRole?.(role, !!enabled);
  } catch {
    // Native hook optional; hold UI still shows frozen frame + label.
  }
}

/** Optional: blur TextureViews under a specific RN host. */
export function setCallVideoHoldBlur(host: View | null | undefined, enabled: boolean): void {
  if (!supportsCallVideoHoldBlur()) return;
  if (!host) return;
  const tag = findNodeHandle(host);
  if (tag == null) return;
  try {
    NativeModules.LiviAppModule?.setCallVideoHoldBlur?.(tag, !!enabled);
  } catch {
    // Native hook optional; hold UI still shows frozen frame + label.
  }
}
