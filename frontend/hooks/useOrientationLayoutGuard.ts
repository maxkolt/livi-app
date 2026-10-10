import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DeviceEventEmitter,
  Dimensions,
  NativeModules,
  Platform,
  type LayoutChangeEvent,
} from 'react-native';

function longShort(a: number, b: number): { long: number; short: number } {
  return { long: Math.max(a, b), short: Math.min(a, b) };
}

function edgesFromWindow(): { long: number; short: number } {
  const win = Dimensions.get('window');
  const screen = Dimensions.get('screen');
  const long = Math.max(win.width, win.height, screen.width, screen.height);
  const short = Math.min(
    win.width || long,
    win.height || long,
    screen.width || long,
    screen.height || long,
  );
  if (!(long > 0 && short > 0)) return { long: 0, short: 0 };
  return { long, short };
}

function sizeForOrientation(
  long: number,
  short: number,
  landscape: boolean,
): { width: number; height: number } {
  return landscape
    ? { width: long, height: short }
    : { width: short, height: long };
}

function isLandscapeSize(width: number, height: number) {
  return width > 0 && height > 0 && width / height > 1.05;
}

function windowIsLandscape(): boolean | null {
  const win = Dimensions.get('window');
  if (!(win.width > 0 && win.height > 0)) return null;
  return isLandscapeSize(win.width, win.height);
}

export type OrientationLayoutGuardOptions = {
  /** Минимум сплошного фона с момента первого события поворота (мс). */
  minCoverMs?: number;
  /** Пауза после matching onLayout поверх minCover (мс). */
  afterLayoutMs?: number;
  /** Запас, если layout так и не совпал (мс). */
  fallbackMs?: number;
  /**
   * Жёсткая длительность шторки: снять ровно через N мс после старта поворота,
   * не опираясь на ранний onLayout (карусели Legendary / RTCView).
   */
  fixedCoverMs?: number;
};

/**
 * Коммитит геометрию новой ориентации сразу (до onLayout).
 * `covering` — непрозрачный оверлей. Native WillChange и Dimensions.change
 * приходят парой — второй вызов с тем же land не сбрасывает таймеры снятия.
 */
export function useOrientationLayoutGuard(
  fallback: { width: number; height: number },
  options?: OrientationLayoutGuardOptions,
) {
  const minCoverMs = options?.minCoverMs ?? 900;
  const afterLayoutMs = options?.afterLayoutMs ?? 420;
  const fallbackMs = options?.fallbackMs ?? 2000;
  const fixedCoverMs = options?.fixedCoverMs;

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [covering, setCovering] = useState(false);
  const expectedLandscapeRef = useRef<boolean | null>(null);
  const coverStartedAtRef = useRef(0);
  const layoutMatchedRef = useRef(false);
  const coveringRef = useRef(false);
  const pendingLandRef = useRef<boolean | null>(null);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coverFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optsRef = useRef({ minCoverMs, afterLayoutMs, fallbackMs, fixedCoverMs });
  optsRef.current = { minCoverMs, afterLayoutMs, fallbackMs, fixedCoverMs };

  const clearReadyTimer = useCallback(() => {
    if (readyTimerRef.current) {
      clearTimeout(readyTimerRef.current);
      readyTimerRef.current = null;
    }
  }, []);

  const reveal = useCallback(() => {
    clearReadyTimer();
    if (coverFallbackRef.current) {
      clearTimeout(coverFallbackRef.current);
      coverFallbackRef.current = null;
    }
    layoutMatchedRef.current = false;
    expectedLandscapeRef.current = null;
    pendingLandRef.current = null;
    coveringRef.current = false;
    setCovering(false);
    try {
      NativeModules.LiviAppModule?.orientationLayoutReady?.();
    } catch {}
  }, [clearReadyTimer]);

  const tryScheduleReveal = useCallback(() => {
    if (!layoutMatchedRef.current || !coveringRef.current) return;
    clearReadyTimer();
    const { minCoverMs: minMs, afterLayoutMs: afterMs } = optsRef.current;
    const elapsed = Date.now() - coverStartedAtRef.current;
    // Не раньше minCover от старта поворота и не раньше afterMs после layout.
    const wait = Math.max(afterMs, minMs - elapsed, 0);
    readyTimerRef.current = setTimeout(() => {
      readyTimerRef.current = null;
      reveal();
    }, wait);
  }, [clearReadyTimer, reveal]);

  const commitSize = useCallback((next: { width: number; height: number }) => {
    setSize((prev) =>
      Math.abs(next.width - prev.width) < 1 && Math.abs(next.height - prev.height) < 1
        ? prev
        : next,
    );
  }, []);

  const applyOrientation = useCallback(
    (landscape: boolean) => {
      // Пара native+Dimensions с тем же land: не трогаем таймеры — иначе старый
      // scheduleReveal / новый minCover дают мигание фона.
      if (coveringRef.current && pendingLandRef.current === landscape) {
        return;
      }
      // Во время анимации поворота Dimensions иногда мигает opposite land и
      // сбрасывал fixedCoverMs → шторка снималась слишком рано.
      if (coveringRef.current) {
        const age = Date.now() - coverStartedAtRef.current;
        if (age < 700) return;
      }
      clearReadyTimer();
      pendingLandRef.current = landscape;
      expectedLandscapeRef.current = landscape;
      layoutMatchedRef.current = false;
      coverStartedAtRef.current = Date.now();
      coveringRef.current = true;
      setCovering(true);
      const edges = edgesFromWindow();
      let long = edges.long;
      let short = edges.short;
      if (!(long > 0 && short > 0)) {
        const fb = fallbackRef.current;
        const fromFb = longShort(fb.width, fb.height);
        long = fromFb.long;
        short = fromFb.short;
      }
      if (!(long > 0 && short > 0)) return;
      commitSize(sizeForOrientation(long, short, landscape));
      if (coverFallbackRef.current) clearTimeout(coverFallbackRef.current);
      const fixed = optsRef.current.fixedCoverMs;
      if (fixed != null && fixed > 0) {
        // Только таймер: onLayout каруселей/видео слишком ранний и снимал шторку.
        layoutMatchedRef.current = true;
        readyTimerRef.current = setTimeout(() => {
          readyTimerRef.current = null;
          reveal();
        }, fixed);
        return;
      }
      coverFallbackRef.current = setTimeout(() => {
        coverFallbackRef.current = null;
        reveal();
      }, optsRef.current.fallbackMs);
    },
    [clearReadyTimer, commitSize, reveal],
  );

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      if (!(width > 0 && height > 0)) return;
      const laidLandscape = isLandscapeSize(width, height);
      const winLandscape = windowIsLandscape();
      const expected = expectedLandscapeRef.current;

      if (expected != null && laidLandscape !== expected) return;
      if (winLandscape != null && laidLandscape !== winLandscape) return;

      commitSize({ width, height });
      if (expected != null && laidLandscape === expected) {
        expectedLandscapeRef.current = null;
        layoutMatchedRef.current = true;
        // fixedCoverMs сам снимет шторку — onLayout не трогаем.
        if (optsRef.current.fixedCoverMs == null) {
          tryScheduleReveal();
        }
      }
    },
    [commitSize, tryScheduleReveal],
  );

  useEffect(() => {
    const dimSub = Dimensions.addEventListener('change', ({ window }) => {
      if (window.width > 0 && window.height > 0) {
        applyOrientation(isLandscapeSize(window.width, window.height));
      }
    });
    const nativeSub =
      Platform.OS === 'android'
        ? DeviceEventEmitter.addListener('LiviOrientationWillChange', (land) => {
            applyOrientation(!!land);
          })
        : null;
    return () => {
      dimSub.remove();
      nativeSub?.remove();
      clearReadyTimer();
      if (coverFallbackRef.current) clearTimeout(coverFallbackRef.current);
    };
  }, [applyOrientation, clearReadyTimer]);

  return { size, covering, onLayout };
}
