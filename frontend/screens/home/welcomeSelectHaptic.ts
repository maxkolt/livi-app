import { Platform, Vibration } from 'react-native';
import * as Haptics from 'expo-haptics';

/** Лёгкий виброотклик при long-press → режим выбора. */
export function welcomeSelectHaptic() {
  try {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    try {
      Vibration.vibrate(Platform.OS === 'ios' ? 5 : 8);
    } catch {
      // ignore
    }
  }
}
