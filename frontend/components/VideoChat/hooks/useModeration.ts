import { RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import * as FileSystem from 'expo-file-system';
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

  const active = useMemo(() => enabled && chatType === 'random' && shouldCheck, [enabled, chatType, shouldCheck]);

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
    lastCheckAtRef.current = now;

    const target = targetRef.current;
    if (!target) return;

    isCheckingRef.current = true;
    setIsChecking(true);

    try {
      const tmpUri = await captureRef(target, {
        format: 'jpg',
        quality: 0.3,
        width: 150,
        height: 200,
        result: 'tmpfile',
      });

      const base64 = await FileSystem.readAsStringAsync(tmpUri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      void FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});

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

