import { RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Dimensions, InteractionManager, PixelRatio, Platform, View } from 'react-native';
import { captureRef, captureScreen } from 'react-native-view-shot';
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { API_BASE } from '../../../sockets/socket';
import { logger } from '../../../utils/logger';
import { t, type Lang } from '../../../utils/i18n';

type ModerationResponse = {
  ok?: boolean;
  violation?: boolean;
};

type UseModerationOptions = {
  enabled: boolean;
  chatType: 'random' | 'private' | string;
  targetRef: RefObject<View | null>;
  /** Ключ стабильности target view: при изменении временно пропускаем захват, чтобы переждать churn RTCView/layout. */
  stabilityKey?: string | number | null;
  /** 'remote' = проверяем собеседника, при нарушении блокируем его. 'local' = проверяем себя. */
  moderationTarget: 'local' | 'remote';
  /** Только для moderationTarget='remote': userId партнёра для репорта */
  partnerUserId?: string | null;
  shouldCheck: boolean;
  cooldownMs?: number;
  badFramesThreshold?: number;
  stabilityDelayMs?: number;
  onWarning: (message: string) => void;
  onBan: (seconds: number, message: string) => void;
  /** Первое нарушение: предупреждение партнёру (он видит в своём блоке «Вы») */
  onRemoteWarning?: (partnerUserId: string) => void;
  /** Второе нарушение: бан партнёра, зрителю — «Собеседник забанен на час» */
  onRemoteViolation?: (partnerUserId: string) => void;
  lang: Lang;
};

/** Задержка после подключения перед началом захвата — избегаем race с обновлением view hierarchy (IndexOutOfBoundsException в gatherTransparentRegion) */
const STABLE_DELAY_MS = 3000;
const STABILITY_KEY_DELAY_MS = 1800;

export function useModeration({
  enabled,
  chatType,
  targetRef,
  stabilityKey,
  moderationTarget,
  partnerUserId,
  shouldCheck,
  cooldownMs = 1300,
  badFramesThreshold = 3,
  stabilityDelayMs = STABILITY_KEY_DELAY_MS,
  onWarning,
  onBan,
  onRemoteWarning,
  onRemoteViolation,
  lang,
}: UseModerationOptions) {
  const WARNING_TO_BAN_DELAY_MS = 10_000;
  const [isChecking, setIsChecking] = useState(false);
  const [strikes, setStrikes] = useState(0);

  const isCheckingRef = useRef(false);
  const lastCheckAtRef = useRef(0);
  const consecutiveBadFramesRef = useRef(0);
  const strikesRef = useRef(0);
  const firstWarningAtRef = useRef(0);
  const activeSinceRef = useRef<number | null>(null);
  const suspendCaptureUntilRef = useRef(0);
  const lastStabilityKeyRef = useRef<string | number | null | undefined>(undefined);
  /** Для remote: счётчик нарушений текущего партнёра (1=warning, 2+=ban) */
  const partnerStrikesRef = useRef(0);
  const partnerFirstWarningAtRef = useRef(0);
  const lastPartnerUserIdRef = useRef<string | null>(null);

  const active = useMemo(() => enabled && chatType === 'random' && shouldCheck, [enabled, chatType, shouldCheck]);

  // Отслеживаем момент, когда модерация стала активной (после подключения к комнате)
  useEffect(() => {
    if (active) {
      if (activeSinceRef.current === null) activeSinceRef.current = Date.now();
    } else {
      activeSinceRef.current = null;
      suspendCaptureUntilRef.current = 0;
      lastStabilityKeyRef.current = undefined;
      consecutiveBadFramesRef.current = 0;
      strikesRef.current = 0;
      firstWarningAtRef.current = 0;
      partnerStrikesRef.current = 0;
      partnerFirstWarningAtRef.current = 0;
      lastPartnerUserIdRef.current = null;
      setStrikes(0);
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    if (lastStabilityKeyRef.current === undefined) {
      lastStabilityKeyRef.current = stabilityKey;
      return;
    }
    if (lastStabilityKeyRef.current === stabilityKey) return;
    lastStabilityKeyRef.current = stabilityKey;
    suspendCaptureUntilRef.current = Date.now() + stabilityDelayMs;
    logger.info('[Moderation] pause capture due to unstable target', {
      target: moderationTarget,
      stabilityKey,
      stabilityDelayMs,
    });
  }, [active, moderationTarget, stabilityDelayMs, stabilityKey]);

  const measureTargetBounds = async (target: View) => {
    const current = targetRef.current;
    if (!current || current !== target) return null;
    return await new Promise<{ x: number; y: number; width: number; height: number } | null>(
      (resolve) => {
        try {
          (target as any).measureInWindow?.((x: number, y: number, w: number, h: number) => {
            if (targetRef.current !== target) {
              resolve(null);
              return;
            }
            if (w >= 50 && h >= 50) resolve({ x, y, width: w, height: h });
            else resolve(null);
          });
        } catch {
          resolve(null);
        }
      }
    );
  };

  const applyStrike = (now: number) => {
    if (strikesRef.current === 0) {
      strikesRef.current = 1;
      firstWarningAtRef.current = now;
      setStrikes(1);
      onWarning(t('moderationContentWarning', lang));
      return;
    }

    if (now - firstWarningAtRef.current < WARNING_TO_BAN_DELAY_MS) {
      return;
    }

    strikesRef.current = 2;
    setStrikes(2);
    onBan(3600, t('moderationBannedSelf', lang));
  };

  const runCheck = async () => {
    if (!active) return;
    if (isCheckingRef.current) return;

    const now = Date.now();
    if (now - lastCheckAtRef.current < cooldownMs) return;

    // Не захватываем экран в первые N секунд после подключения — view hierarchy ещё стабилизируется
    const activeSince = activeSinceRef.current;
    if (activeSince === null || now - activeSince < STABLE_DELAY_MS) return;
    if (now < suspendCaptureUntilRef.current) return;
    lastCheckAtRef.current = now;

    const target = targetRef.current;
    if (!target) return;

    isCheckingRef.current = true;
    setIsChecking(true);

    try {
      // Даём UI отрисоваться перед обходом view tree (снижает риск IndexOutOfBoundsException)
      await new Promise<void>((r) => InteractionManager.runAfterInteractions(() => r()));
      await new Promise((r) => setTimeout(r, 120));

      if (!active || targetRef.current !== target) return;

      const bounds = await measureTargetBounds(target);
      if (!bounds) {
        logger.warn('[Moderation] skip capture: target bounds unavailable', { target: moderationTarget });
        return;
      }

      // Санити-чек: для remote (Собеседник) bounds.y обычно в верхней половине; для local (Вы) — в нижней.
      const screenH = Dimensions.get('window').height;
      if (moderationTarget === 'remote' && bounds.y > screenH * 0.6) {
        logger.warn('[Moderation] skip: remote card expected in upper half', { boundsY: bounds.y, screenH });
        return;
      }
      if (moderationTarget === 'local' && bounds.y < screenH * 0.25) {
        logger.warn('[Moderation] skip: local card expected in lower half', { boundsY: bounds.y, screenH });
        return;
      }

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
        if (targetRef.current !== target) return;
        const tmpUri = await captureRef(target, captureRefOpts);
        const raw = await FileSystem.readAsStringAsync(tmpUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        void FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
        base64 = raw;
      } catch (refErr) {
        if (Platform.OS === 'android') {
          // Android PixelCopy/captureScreen can crash natively while RTCView is detaching during next/disconnect.
          // Prefer skipping this moderation frame over risking an app crash.
          logger.warn('[Moderation] skip frame: captureRef failed and Android captureScreen fallback disabled', {
            target: moderationTarget,
            error: (refErr as any)?.message || String(refErr),
          });
          return;
        }

        // 2) iOS fallback: captureScreen + crop (RTCView often doesn't support captureRef)
        if (targetRef.current !== target) return;
        logger.info('[Moderation] captureScreen+crop bounds OK', { target: moderationTarget, y: bounds.y, screenH });

        // Небольшая пауза перед captureScreen — снижает риск IndexOutOfBoundsException при обходе view tree
        await new Promise((r) => setTimeout(r, 100));
        if (targetRef.current !== target) return;

        const tmpUri = await captureScreen({
          format: 'jpg',
          quality: 0.5,
          result: 'tmpfile',
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
          const violationDetectedAt = Date.now();
          consecutiveBadFramesRef.current = 0;
          if (moderationTarget === 'remote') {
            if (partnerUserId) {
              if (lastPartnerUserIdRef.current !== partnerUserId) {
                partnerStrikesRef.current = 0;
                partnerFirstWarningAtRef.current = 0;
                lastPartnerUserIdRef.current = partnerUserId;
              }

              if (partnerStrikesRef.current === 0) {
                partnerStrikesRef.current = 1;
                partnerFirstWarningAtRef.current = violationDetectedAt;
                onRemoteWarning?.(partnerUserId);
              } else if (
                partnerStrikesRef.current >= 1 &&
                violationDetectedAt - partnerFirstWarningAtRef.current >= WARNING_TO_BAN_DELAY_MS &&
                onRemoteViolation
              ) {
                partnerStrikesRef.current = 2;
                onRemoteViolation(partnerUserId);
              }
            } else {
              // КРИТИЧНО: partnerUserId ещё не установлен — не наказываем зрителя (applyStrike)
              logger.warn('[Moderation] remote violation but partnerUserId is null, skipping strike');
            }
          } else {
            applyStrike(violationDetectedAt);
          }
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
  }, [active, cooldownMs, moderationTarget, partnerUserId, stabilityKey, stabilityDelayMs]);

  return {
    isChecking,
    strikes,
  };
}

