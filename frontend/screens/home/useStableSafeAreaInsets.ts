import { Platform } from 'react-native';
import {
  useSafeAreaFrame,
  useSafeAreaInsets,
  type EdgeInsets,
} from 'react-native-safe-area-context';

type Orientation = 'portrait' | 'landscape';

/** Последние настоящие отступы на каждую ориентацию — переживают перемонтирование. */
const lastStable: Record<Orientation, { top: number; bottom: number }> = {
  portrait: { top: 0, bottom: 0 },
  landscape: { top: 0, bottom: 0 },
};

/** Как resolveStableAndroidNavInset в чате, но без округления: значения те же, что у соседей. */
function stable(previous: number, next: number): number {
  return previous > 1 && next <= 1 ? previous : next;
}

/**
 * Safe-area для главной без рывков после сна. При пробуждении Android пересоздаёт окно,
 * и SafeAreaProvider на кадр-другой публикует bottom (и иногда top) = 0: навбар и всё,
 * что считается от отступов, съезжало и возвращалось. Держим последний настоящий отступ;
 * по ориентациям раздельно — в landscape системная навигация сбоку и bottom = 0 законно.
 */
export function useStableSafeAreaInsets(): EdgeInsets {
  const insets = useSafeAreaInsets();
  const frame = useSafeAreaFrame();
  if (Platform.OS !== 'android') return insets;
  const key: Orientation = frame.width > frame.height ? 'landscape' : 'portrait';
  const prev = lastStable[key];
  const top = stable(prev.top, insets.top);
  const bottom = stable(prev.bottom, insets.bottom);
  lastStable[key] = { top, bottom };
  return top === insets.top && bottom === insets.bottom ? insets : { ...insets, top, bottom };
}
