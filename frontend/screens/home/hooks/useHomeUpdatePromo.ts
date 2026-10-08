import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getCurrentAppVersion,
  isUpdateAvailable,
  isUpdateReminderCooldownActive,
  shouldShowUpdateBadge,
  clearUpdateCheckCache,
  clearUpdatePromotionWhenUpToDate,
} from '../../../utils/updateCheck';
import { presentAppUpdateShadeNotificationIfNeeded } from '../../../utils/productShadeNotifications';

const UPDATE_CHECK_RESUME_DEBOUNCE_MS = 60 * 1000;

/**
 * Последнее решение «показывать точку обновления» для этой версии приложения.
 * Читается с диска до ухода заставки: иначе точка на «Профиле» появлялась через
 * долю секунды после показа экрана, когда отвечал сервер.
 */
const PROMO_CACHE_KEY = 'update_promo_last_v1';
let promoMem: boolean | null = null;

function promoCacheValue(show: boolean): string {
  return `${getCurrentAppVersion()}|${show ? 1 : 0}`;
}

export function useHomeUpdatePromo() {
  const [updateAvailable, setUpdateAvailable] = useState(() => promoMem === true);
  /** Решение известно (с диска или с сервера) — экран можно показывать. */
  const [updatePromoHydrated, setUpdatePromoHydrated] = useState(promoMem !== null);
  const serverAnsweredRef = useRef(false);
  /** Ответ сервера пришёл: бейдж «О приложении» решаем по нему, а не по кэшу точки. */
  const [serverCheckSeq, setServerCheckSeq] = useState(0);
  const [showUpdateBadge, setShowUpdateBadgeState] = useState(false);
  const updateBadgeShownRef = useRef(false);
  const suppressUpdateBadgeUntilRef = useRef(0);
  /** Результат последней isUpdateAvailable() в check() — для shouldShowUpdateBadge без повторного запроса */
  const serverSaysUpdateRef = useRef(false);
  const lastUpdateCheckAtRef = useRef(0);
  const updateShadePresentedRef = useRef(false);

  const suppressUpdateBadgeForCallNotice = useCallback((durationMs = 4000) => {
    suppressUpdateBadgeUntilRef.current = Math.max(
      suppressUpdateBadgeUntilRef.current,
      Date.now() + durationMs
    );
    setShowUpdateBadgeState(false);
  }, []);

  useEffect(() => {
    if (promoMem !== null) return;
    let cancelled = false;
    AsyncStorage.getItem(PROMO_CACHE_KEY)
      .then((raw) => {
        if (cancelled || serverAnsweredRef.current) return;
        const [ver, flag] = String(raw || '').split('|');
        // Другая версия (обновились) — старое решение не годится, ждём сервер без точки.
        if (ver === getCurrentAppVersion()) setUpdateAvailable(flag === '1');
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setUpdatePromoHydrated(true);
      });
    return () => {
      cancelled = true;
    };
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
          serverAnsweredRef.current = true;
          promoMem = showPromotion;
          setUpdateAvailable(showPromotion);
          setUpdatePromoHydrated(true);
          setServerCheckSeq((n) => n + 1);
          AsyncStorage.setItem(PROMO_CACHE_KEY, promoCacheValue(showPromotion)).catch(() => {});
          if (!__DEV__ && !serverSaysUpdate) {
            setShowUpdateBadgeState(false);
            await clearUpdatePromotionWhenUpToDate();
          }
          if (!cancelled && showPromotion && !updateShadePresentedRef.current) {
            updateShadePresentedRef.current = true;
            presentAppUpdateShadeNotificationIfNeeded().catch(() => {});
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
    if (!updateAvailable || !serverCheckSeq) return;
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
  }, [updateAvailable, serverCheckSeq]);

  return {
    updateAvailable,
    updatePromoHydrated,
    setUpdateAvailable,
    showUpdateBadge,
    setShowUpdateBadgeState,
    updateBadgeShownRef,
    suppressUpdateBadgeForCallNotice,
  };
}
