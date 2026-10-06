/**
 * Наклон телефона для параллакса радара «Поиска»: x и y в [-1, 1].
 *
 * Датчик — тот же акселерометр expo-sensors, что у обоев чата (знаки осей уже проверены
 * там). JS только задаёт цель несколько раз в секунду, сглаживание (withSpring) идёт на
 * UI-потоке Reanimated. Датчик включён, только пока enabled: радар на экране и анимируется.
 */
import { useEffect } from 'react';
import { useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';
import { Accelerometer } from 'expo-sensors';

export type DeviceTilt = { x: SharedValue<number>; y: SharedValue<number> };

/** Наклон (в g), при котором слой доходит до полного сдвига. */
const TILT_RANGE = 0.6;
/**
 * Ноль медленно подстраивается под позу (≈3 с): держишь телефон под любым углом —
 * слой возвращается в центр, а откликается на сами движения.
 */
const RECENTER = 0.02;
const UPDATE_MS = 60;
const SPRING = { damping: 18, stiffness: 120, mass: 0.7 } as const;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function useDeviceTilt(enabled: boolean): DeviceTilt {
  const x = useSharedValue(0);
  const y = useSharedValue(0);

  useEffect(() => {
    if (!enabled) {
      x.value = withSpring(0, SPRING);
      y.value = withSpring(0, SPRING);
      return;
    }

    let sub: { remove: () => void } | null = null;
    let origin: { x: number; z: number } | null = null;
    let cancelled = false;

    void (async () => {
      try {
        if (!(await Accelerometer.isAvailableAsync()) || cancelled) return;
        Accelerometer.setUpdateInterval(UPDATE_MS);
        sub = Accelerometer.addListener(({ x: ax, z: az }) => {
          const sx = Number(ax) || 0;
          const sz = Number(az) || 0;
          if (!origin) origin = { x: sx, z: sz };
          origin.x += (sx - origin.x) * RECENTER;
          origin.z += (sz - origin.z) * RECENTER;
          // Те же знаки, что у ChatParallaxWallpaper.
          x.value = withSpring(clamp(-(sx - origin.x) / TILT_RANGE, -1, 1), SPRING);
          y.value = withSpring(clamp((sz - origin.z) / TILT_RANGE, -1, 1), SPRING);
        });
      } catch {
        // Нет датчика — радар просто без параллакса.
      }
    })();

    return () => {
      cancelled = true;
      sub?.remove();
      sub = null;
      x.value = withSpring(0, SPRING);
      y.value = withSpring(0, SPRING);
    };
  }, [enabled, x, y]);

  return { x, y };
}
