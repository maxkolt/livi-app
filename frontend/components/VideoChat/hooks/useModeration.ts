import { RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { InteractionManager, PixelRatio, Platform, View } from 'react-native';
import { captureRef, captureScreen } from 'react-native-view-shot';
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { API_BASE } from '../../../sockets/socket';
import { logger } from '../../../utils/logger';

type ModerationResponse = {
  ok?: boolean;
  violation?: boolean;
};

type UseModerationOptions = {
  enabled: boolean;
  chatType: 'random' | 'private' | string;
  targetRef: RefObject<View | null>;
  shouldCheck: boolean;
  cooldownMs?: number;
  badFramesThreshold?: number;
  onWarning: (message: string) => void;
  onMute: (seconds: number, message: string) => void;
  onBan: (seconds: number, message: string) => void;
};

const WARNING_TEXT = 'Пожалуйста, соблюдайте правила. Обнаружен нежелательный контент.';
const MUTE_TEXT = 'Вы временно ограничены за нарушение правил.';
const BAN_TEXT = 'Вы заблокированы на 1 час за повторные нарушения.';

/** Задержка после подключения перед началом захвата — избегаем race с обновлением view hierarchy (IndexOutOfBoundsException в gatherTransparentRegion) */
const STABLE_DELAY_MS = 3000;

export function useModeration({
  enabled,
  chatType,
  targetRef,
  shouldCheck,
  cooldownMs = 1300,
  badFramesThreshold = 3,
  onWarning,
  onMute,
  onBan,
}: UseModerationOptions) {
  const [isChecking, setIsChecking] = useState(false);
  const [strikes, setStrikes] = useState(0);

  const isCheckingRef = useRef(false);
  const lastCheckAtRef = useRef(0);
  const consecutiveBadFramesRef = useRef(0);
  const strikesRef = useRef(0);
  const activeSinceRef = useRef<number | null>(null);

  const active = useMemo(() => enabled && chatType === 'random' && shouldCheck, [enabled, chatType, shouldCheck]);

  // Отслеживаем момент, когда модерация стала активной (после подключения к комнате)
  useEffect(() => {
    if (active) {
      if (activeSinceRef.current === null) activeSinceRef.current = Date.now();
    } else {
      activeSinceRef.current = null;
    }
  }, [active]);

  const applyStrike = () => {
    const next = Math.min(3, strikesRef.current + 1);
    strikesRef.current = next;
    setStrikes(next);

    if (next === 1) {
      onWarning(WARNING_TEXT);
      return;
    }

    if (next === 2) {
      onMute(30, MUTE_TEXT);
      return;
    }

    onBan(3600, BAN_TEXT);
  };

  const runCheck = async () => {
    if (!active) return;
    if (isCheckingRef.current) return;

    const now = Date.now();
    if (now - lastCheckAtRef.current < cooldownMs) return;

    // Не захватываем экран в первые N секунд после подключения — view hierarchy ещё стабилизируется
    const activeSince = activeSinceRef.current;
    if (activeSince === null || now - activeSince < STABLE_DELAY_MS) return;
    lastCheckAtRef.current = now;

    const target = targetRef.current;
    if (!target) return;

    isCheckingRef.current = true;
    setIsChecking(true);

    try {
      // Даём UI отрисоваться перед обходом view tree (снижает риск IndexOutOfBoundsException)
      await new Promise<void>((r) => InteractionManager.runAfterInteractions(() => r()));

      let base64: string | undefined;

      // 1) Пробуем captureRef с handleGLSurfaceViewOnAndroid (Android: SurfaceView/TextureView)
      const captureRefOpts = {
        format: 'jpg' as const,
        quality: 0.3,
        width: 150,
        height: 200,
        result: 'tmpfile' as const,
        ...(Platform.OS === 'android' ? { handleGLSurfaceViewOnAndroid: true } : {}),
      };

      try {
        const tmpUri = await captureRef(target, captureRefOpts);
        const raw = await FileSystem.readAsStringAsync(tmpUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        void FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
        base64 = raw;
      } catch (_refErr) {
        // 2) Fallback: captureScreen + crop (RTCView часто не поддерживает captureRef)
        const bounds = await new Promise<{ x: number; y: number; width: number; height: number } | null>(
          (resolve) => {
            (target as any).measureInWindow?.((x: number, y: number, w: number, h: number) => {
              if (w >= 50 && h >= 50) resolve({ x, y, width: w, height: h });
              else resolve(null);
            });
          }
        );
        if (!bounds) return;

        const tmpUri = await captureScreen({
          format: 'jpg',
          quality: 0.5,
          result: 'tmpfile',
          ...(Platform.OS === 'android' ? { handleGLSurfaceViewOnAndroid: true } : {}),
        });

        const pixelRatio = PixelRatio.get();
        const crop = {
          originX: Math.max(0, Math.floor(bounds.x * pixelRatio)),
          originY: Math.max(0, Math.floor(bounds.y * pixelRatio)),
          width: Math.floor(bounds.width * pixelRatio),
          height: Math.floor(bounds.height * pixelRatio),
        };
        if (crop.width < 50 || crop.height < 50) return;

        const cropped = await ImageManipulator.manipulateAsync(
          tmpUri,
          [{ crop }, { resize: { width: 150, height: 200 } }],
          { compress: 0.3, format: ImageManipulator.SaveFormat.JPEG, base64: true }
        );

        void FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
        if (cropped.uri !== tmpUri) {
          void FileSystem.deleteAsync(cropped.uri, { idempotent: true }).catch(() => {});
        }
        base64 = cropped.base64;
      }

      if (!base64) return;

      const response = await fetch(`${API_BASE}/api/moderate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 }),
      });

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as ModerationResponse;
      if (!data?.ok) return;

      if (data.violation) {
        consecutiveBadFramesRef.current += 1;
        if (consecutiveBadFramesRef.current >= badFramesThreshold) {
          consecutiveBadFramesRef.current = 0;
          applyStrike();
        }
        return;
      }

      consecutiveBadFramesRef.current = 0;
      logger.info('[Moderation] frame checked OK');
    } catch (e) {
      logger.warn('[Moderation] frame check failed', { error: (e as any)?.message || String(e) });
    } finally {
      isCheckingRef.current = false;
      setIsChecking(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      void runCheck();
    }, cooldownMs);
    return () => clearInterval(interval);
  }, [active, cooldownMs]);

  return {
    isChecking,
    strikes,
  };
}

