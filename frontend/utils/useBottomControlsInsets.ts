import { Platform } from 'react-native';
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import { bottomControlsInset } from './bottomControlsInset';

/** UI spacing only. IME and native window calculations must keep real insets. */
export function useBottomControlsInsets() {
  const insets = useSafeAreaInsets();
  const frame = useSafeAreaFrame();
  const bottom = bottomControlsInset(insets.bottom, Platform.OS, frame.width > frame.height);
  return bottom === insets.bottom ? insets : { ...insets, bottom };
}
