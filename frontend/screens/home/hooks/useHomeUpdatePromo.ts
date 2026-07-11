import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, AppState, Easing } from 'react-native';
import {
  isUpdateAvailable,
  isUpdateReminderCooldownActive,
  shouldShowUpdateBadge,
  clearUpdateCheckCache,
  clearUpdatePromotionWhenUpToDate,
} from '../../../utils/updateCheck';
import type { HomeMenuTab } from './useHomeMenu';

const UPDATE_CHECK_RESUME_DEBOUNCE_MS = 60 * 1000;

export function useHomeUpdatePromo(tab: HomeMenuTab) {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [showUpdateBadge, setShowUpdateBadgeState] = useState(false);
  const updateBadgeShownRef = useRef(false);
  const suppressUpdateBadgeUntilRef = useRef(0);
  /** Результат последней isUpdateAvailable() в check() — для shouldShowUpdateBadge без повторного запроса */
  const serverSaysUpdateRef = useRef(false);
  const updateSpinAnim = useRef(new Animated.Value(0)).current;
  const lastUpdateCheckAtRef = useRef(0);

  const suppressUpdateBadgeForCallNotice = useCallback((durationMs = 4000) => {
    suppressUpdateBadgeUntilRef.current = Math.max(
      suppressUpdateBadgeUntilRef.current,
      Date.now() + durationMs
    );
    setShowUpdateBadgeState(false);
  }, []);

  // Проверка доступности обновления (при старте и при возврате в приложение)
  useEffect(() => {
    let cancelled = false;
    clearUpdateCheckCache();
    const check = async () => {
      try {
        lastUpdateCheckAtRef.current = Date.now();
        const serverSaysUpdate = await isUpdateAvailable();
        serverSaysUpdateRef.current = serverSaysUpdate;
        const cooldown = await isUpdateReminderCooldownActive();
        if (!cancelled) {
          const showPromotion = __DEV__ ? true : !!(serverSaysUpdate && !cooldown);
          setUpdateAvailable(showPromotion);
          if (!__DEV__ && !serverSaysUpdate) {
            setShowUpdateBadgeState(false);
            await clearUpdatePromotionWhenUpToDate();
          }
        }
      } catch {}
    };
    check();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        const now = Date.now();
        if (now - lastUpdateCheckAtRef.current < UPDATE_CHECK_RESUME_DEBOUNCE_MS) return;
        clearUpdateCheckCache();
        check();
      }
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  useEffect(() => {
    if (!updateAvailable) return;
    let cancelled = false;
    (async () => {
      try {
        const should = await shouldShowUpdateBadge(__DEV__ ? undefined : serverSaysUpdateRef.current);
        if (!cancelled && should && Date.now() >= suppressUpdateBadgeUntilRef.current) {
          if (__DEV__) updateBadgeShownRef.current = true;
          setShowUpdateBadgeState(true);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [updateAvailable]);

  useEffect(() => {
    if (!updateAvailable || tab !== 'more') return;
    const loop = Animated.loop(
      Animated.timing(updateSpinAnim, {
        toValue: 1,
        duration: 1500,
        useNativeDriver: true,
        easing: Easing.linear,
      })
    );
    updateSpinAnim.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [updateAvailable, updateSpinAnim, tab]);

  return {
    updateAvailable,
    setUpdateAvailable,
    showUpdateBadge,
    setShowUpdateBadgeState,
    updateBadgeShownRef,
    updateSpinAnim,
    suppressUpdateBadgeForCallNotice,
  };
}
