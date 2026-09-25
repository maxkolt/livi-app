import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ANDROID_IME_LIFT_CACHE_KEY } from './chatStorageKeys';

/**
 * Синхронный in-memory cache высоты IME (dp) + AsyncStorage.
 * Нужен, чтобы к фокусу в инпут target уже был 363, а не 0
 * (иначе первый open в сессии догоняет клавиатуру с p≈0.9).
 */

let memoryDp = 0;
let loadPromise: Promise<number> | null = null;
const listeners = new Set<(valueDp: number) => void>();

export function getAndroidImeLiftCacheDp(): number {
  return memoryDp;
}

export function setAndroidImeLiftCacheDp(heightDp: number): void {
  const next = Math.max(0, Math.round(Number(heightDp) || 0));
  if (next < 1) return;
  const changed = Math.abs(memoryDp - next) > 0.5;
  memoryDp = next;
  AsyncStorage.setItem(ANDROID_IME_LIFT_CACHE_KEY, String(next)).catch(() => {});
  if (changed) {
    listeners.forEach((listener) => {
      try {
        listener(next);
      } catch {
        // ignore
      }
    });
  }
}

export function subscribeAndroidImeLiftCache(
  listener: (valueDp: number) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function preloadAndroidImeLiftCache(): Promise<number> {
  if (Platform.OS !== 'android') return Promise.resolve(0);
  if (memoryDp > 0) return Promise.resolve(memoryDp);
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(ANDROID_IME_LIFT_CACHE_KEY);
      const cached = Math.max(0, Math.round(Number(raw) || 0));
      if (cached > 0 && memoryDp < 1) {
        memoryDp = cached;
        listeners.forEach((listener) => {
          try {
            listener(cached);
          } catch {
            // ignore
          }
        });
      }
    } catch {
      // ignore
    }
    return memoryDp;
  })();
  return loadPromise;
}

if (Platform.OS === 'android') {
  preloadAndroidImeLiftCache();
}
